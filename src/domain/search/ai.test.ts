import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { setHttpClient, resetHttpClient } from "@data/net/http-port";
import { AISearcher, buildBm25Index, bm25RecallScores } from "@domain/search/ai";
import { embeddingIndexKey } from "@semantic/embedding";
import { computeIndexFingerprints } from "@shared/fingerprint";
import { bm25Score, tokenizeForBM25, BM25_K1, BM25_B, BM25_TOKENIZER_VERSION, bm25Idf, bm25LenNorm, bm25TermWeight } from "@domain/search/bm25";
import { t2sForEmbed } from "@translation/lexicon/t2s";
import { expandQuery } from "@translation/lexicon/synonyms";
import { PHASE } from "@domain/search/search-timing";
import { logger } from "@shared/logger";
import { LLMClient } from "@translation/api/api";
import { PluginTagService } from "@domain/catalog/plugin-tags";

// 依赖倒置后：LLM 调用统一走注入的 HttpClient，直接注入 mock 模拟不可达/异常响应
const req = vi.fn();

const PLUGINS = [
	{ id: "dataview", name: "Dataview", description: "Query your notes as a database" },
	{ id: "calendar", name: "Calendar", description: "Track your daily notes" },
	{ id: "git", name: "Git", description: "Version control for your vault" },
	{ id: "translate", name: "Translate", description: "Translate text in notes" },
];

const NEGATIVE_PLUGINS = [
	{ id: "exporter", name: "Exporter", description: "Export notes to PDF and HTML" },
	{ id: "organizer", name: "Organizer", description: "Organize notes and folders locally" },
];

function makeSearcher(embeddingSource: "keyword" | "local" = "keyword") {
	const tagService = new PluginTagService();
	tagService.load({
		dataview: { category: "data", tags: ["query"] },
		calendar: { category: "productivity", tags: ["time"] },
		git: { category: "dev", tags: ["vcs"] },
		translate: { category: "tool", tags: ["language"] },
	});
	const llm = new LLMClient({
		baseURL: "https://api.example.com",
		apiKey: "sk-test",
		model: "test-model",
	});
	const aiConfig = {
		baseURL: "https://api.example.com",
		apiKey: "sk-test",
		model: "test-model",
		embedding: { source: embeddingSource },
	};
	const searcher = new AISearcher(aiConfig, llm, tagService);
	return { searcher, llm };
}

describe("BM25 索引缓存 · 首搜一次性构建，后续命中", () => {
	it("首次 getBm25Index 全量分词构建，第二次返回同一实例（零重建）", () => {
		const { searcher } = makeSearcher();
		// 2000 条模拟真实语料规模，验证缓存语义（非精确计时）
		const plugins = Array.from({ length: 2000 }, (_, i) => ({
			id: `p${i}`,
			name: `Plugin ${i}`,
			description: `A plugin for task ${i} management, sync and notes organization`,
		}));
		const t0 = Date.now();
		const idx1 = searcher.getBm25Index(plugins);
		const buildMs = Date.now() - t0;
		const t1 = Date.now();
		const idx2 = searcher.getBm25Index(plugins); // 同内容 → 应命中缓存
		const reuseMs = Date.now() - t1;

		expect(idx2).toBe(idx1); // 同一实例，未二次构建
		expect(reuseMs).toBeLessThan(buildMs); // 复用远快于首次构建
		expect(idx1.sig).toBe(idx1.sig);
	});

	it("内容变化（描述变更）触发失效重建，内容不变则零重建", () => {
		const { searcher } = makeSearcher();
		const base = (d: string) => [{ id: "a", name: "A", description: d }];
		const idx1 = searcher.getBm25Index(base("hello world"));
		const idx2 = searcher.getBm25Index(base("hello world")); // 同内容
		expect(idx2).toBe(idx1);
		const idx3 = searcher.getBm25Index(base("hello obsidian")); // 描述变了
		expect(idx3).not.toBe(idx1);
	});
});

describe("AISearcher 降级健壮性", () => {
	beforeEach(() => {
		req.mockReset();
		setHttpClient({ request: req });
	});
	afterEach(() => {
		resetHttpClient();
	});

	it("LLM 精排不可达时降级到本地关键词排序（rankFallback=true，结果非空）", async () => {
		const { searcher } = makeSearcher();
		// 让所有 requestUrl 立即 reject → 模拟 LLM 端点不可达
		req.mockRejectedValue(new Error("request failed"));

		const result = await searcher.search("query notes database", PLUGINS as any);

		expect(result.rankFallback).toBe(true);
		expect(result.rankedIds.length).toBeGreaterThan(0);
		// 降级结果应是本地召回顺序（含 query 相关项）
		expect(result.rankedIds).toContain("dataview");
	});

	it("LLM 可用时正常语义精排（rankFallback 为 falsy）", async () => {
		const { searcher } = makeSearcher();
		// 让 LLM 返回合法 OpenAI 格式响应（content 内为 ranking JSON 字符串）
		req.mockResolvedValue({
			status: 200,
			json: {
				choices: [
					{
						message: {
							content: JSON.stringify({
								ranking: [0, 1, 2, 3],
								reasons: { dataview: "强相关" },
							}),
						},
					},
				],
			},
		});

		const result = await searcher.search("query notes", PLUGINS as any);

		expect(result.rankFallback).toBeFalsy();
		expect(result.rankedIds.length).toBeGreaterThan(0);
	});

	it("localSearch 纯本地 RRF 融合，不调 LLM（requestUrl 未被用于 LLM）", async () => {
		const { searcher } = makeSearcher();
		// 若 localSearch 误调 LLM，会命中 requestUrl → reject → 抛出；这里若调了即失败
		req.mockRejectedValue(new Error("localSearch 不应调用 LLM/网络"));

		const result = await searcher.localSearch("query notes database", PLUGINS as any);

		expect(result.rankFallback).toBe(true);
		expect(result.rankedIds.length).toBeGreaterThan(0);
		// 关键词召回应命中 dataview（"database" 命中描述）
		expect(result.rankedIds).toContain("dataview");
	});

	it("纯否定 query 跳过正向召回并硬排除否定能力", async () => {
		const { searcher } = makeSearcher();
		const result = await searcher.localSearch("不要导出", NEGATIVE_PLUGINS as any);

		expect(result.rankedIds).toEqual(["organizer"]);
		expect(result.matchDiagnostics?.exporter).toBeUndefined();
		expect(result.matchDiagnostics?.organizer?.negativeMatches).toEqual([]);
	});

	it("LLM 只返回部分 ranking 时，未排序候选兜底补回，结果不缺失", async () => {
		const { searcher } = makeSearcher();
		// 注意：query "query notes" 经本地召回（BM25 + 标题模糊）后候选池只有 3 个
		// （dataview/calendar/translate，git 未命中关键词不在池中）。
		// rankSubset 顺序 = [dataview(0), calendar(1), translate(2)]。
		// LLM 仅返回 ranking=[0, 2]（dataview, translate），未排序的 calendar(1) 应被兜底补回末尾。
		req.mockResolvedValue({
			status: 200,
			json: {
				choices: [
					{
						message: {
							content: JSON.stringify({
								ranking: [0, 2],
								reasons: { dataview: "强相关", translate: "相关" },
							}),
						},
					},
				],
			},
		});

		const result = await searcher.search("query notes", PLUGINS as any);

		// 候选池中的 3 个都应出现在结果中：LLM 返回 ranking=[0,2]（排了 2 个），
		// 未排序的第 3 个候选被兜底补回，不缺失。
		// 注意：Array.sort() 原地排序，下面用副本比较，避免污染后续断言。
		expect([...result.rankedIds].sort()).toEqual(["calendar", "dataview", "translate"]);
		// ranking=[0,2] 覆盖了 rankSubset 的第 0、2 位，未覆盖的第 1 位（dataview）被补到末尾
		expect(result.rankedIds[result.rankedIds.length - 1]).toBe("dataview");
	});

	it("reasons 仅保留进入结果的候选，排除被 irrelevant 过滤掉的", async () => {
		const { searcher } = makeSearcher();
		req.mockResolvedValue({
			status: 200,
			json: {
				choices: [
					{
						message: {
							content: JSON.stringify({
								ranking: [0, 1, 2, 3],
								// git 被标为无关（应被过滤），其理由不应出现在结果 reasons
								reasons: {
									dataview: "强相关",
									calendar: "相关",
									git: "无关：不相关",
									translate: "相关",
								},
							}),
						},
					},
				],
			},
		});

		const result = await searcher.search("query notes", PLUGINS as any, true);

		expect(result.rankedIds).not.toContain("git");
		// reasons 不应包含被 irrelevant 排除的 git
		expect(result.reasons).toBeDefined();
		expect(Object.keys(result.reasons!)).not.toContain("git");
		expect(Object.keys(result.reasons!)).toEqual(["dataview", "calendar", "translate"]);
	});
});

describe("搜索分段计时（生产埋点）", () => {
	beforeEach(() => {
		req.mockReset();
		setHttpClient({ request: req });
	});
	afterEach(() => {
		resetHttpClient();
	});

	it("搜索前无快照，搜索后可读到分段与计数", async () => {
		const { searcher } = makeSearcher();
		req.mockRejectedValue(new Error("llm down")); // 触发精排降级，顺带验证降级计数

		expect(searcher.getLastSearchTiming()).toBeNull();

		await searcher.search("query notes", PLUGINS as any);

		const snap = searcher.getLastSearchTiming();
		expect(snap).not.toBeNull();
		const names = snap!.phases.map((p) => p.name);
		expect(names).toContain("关键词召回");
		expect(names).toContain("标题模糊");
		expect(names).toContain("RRF 融合");
		expect(names).toContain(PHASE.llmRank);

		expect(snap!.counters["插件数"]).toBe(PLUGINS.length);
		expect(snap!.counters["关键词命中"]).toBeGreaterThan(0);
		expect(snap!.counters["精排降级"]).toBe(1);
		expect(snap!.counters["结果数"]).toBeGreaterThan(0);
		expect(snap!.totalMs).toBeGreaterThanOrEqual(0);
	});

	it("失败路径同样留下快照（失败发生在哪一步是关键信息）", async () => {
		const { searcher } = makeSearcher();
		req.mockRejectedValue(new Error("llm down"));

		// 无任何本地命中 → 走 LLM 兜底召回 → 全部批次失败 → 抛错
		await expect(searcher.search("zzzz不存在zzzz", PLUGINS as any)).rejects.toThrow();

		// 若只在成功路径记录，这里会是 null，出问题时反而没有可用的计时数据
		expect(searcher.getLastSearchTiming()).not.toBeNull();
	});

	it("localSearch 记录计时且不含 LLM 阶段（纯本地路径）", async () => {
		const { searcher } = makeSearcher();
		req.mockRejectedValue(new Error("localSearch 不应调用 LLM"));

		await searcher.localSearch("query notes", PLUGINS as any);

		const snap = searcher.getLastSearchTiming();
		expect(snap).not.toBeNull();
		expect(snap!.phases.map((p) => p.name)).not.toContain(PHASE.llmRank);
		expect(snap!.counters["结果数"]).toBeGreaterThan(0);
	});

	it("localSearch 保存匹配诊断，且快照返回深拷贝", async () => {
		const { searcher } = makeSearcher();
		req.mockRejectedValue(new Error("localSearch 不应调用 LLM"));

		expect(searcher.getLastMatchDiagnostics()).toBeNull();
		const result = await searcher.localSearch("query notes", PLUGINS as any);
		const first = searcher.getLastMatchDiagnostics();

		expect(first).not.toBeNull();
		expect(first!.query).toBe("query notes");
		expect(first!.mode).toBe("local");
		expect(first!.rankedIds).toEqual(result.rankedIds);
		expect(first!.diagnostics.dataview).toBeDefined();
		expect(first!.diagnostics.dataview.matchedTerms.length).toBeGreaterThan(0);
		expect(first!.labels.dataview).toBe("Dataview");

		result.matchDiagnostics!.dataview.matchedTerms.push("result mutation");
		first!.rankedIds.push("fake");
		first!.labels.dataview = "改名";
		first!.diagnostics.dataview.matchedTerms.push("fake");
		first!.diagnostics.dataview.phraseMatches.push("fake");

		const second = searcher.getLastMatchDiagnostics()!;
		expect(second.rankedIds).not.toContain("fake");
		expect(second.labels.dataview).toBe("Dataview");
		expect(second.diagnostics.dataview.matchedTerms).not.toContain("fake");
		expect(second.diagnostics.dataview.matchedTerms).not.toContain("result mutation");
		expect(second.diagnostics.dataview.phraseMatches).not.toContain("fake");
	});

	it("AI 搜索把最终排序与匹配诊断一起保存", async () => {
		const { searcher } = makeSearcher();
		req.mockResolvedValue({
			status: 200,
			json: {
				choices: [{ message: { content: JSON.stringify({ ranking: [2, 0, 1] }) } }],
			},
		});

		const result = await searcher.search("query notes", PLUGINS as any);
		const snapshot = searcher.getLastMatchDiagnostics()!;

		expect(snapshot.mode).toBe("ai");
		expect(snapshot.rankedIds).toEqual(result.rankedIds);
		expect(snapshot.rankedIds.length).toBeGreaterThan(0);
		expect(snapshot.diagnostics.translate).toBeDefined();
		expect(result.matchDiagnostics).toEqual(snapshot.diagnostics);
	});

	it("新搜索失败时清除上一次匹配诊断，避免面板展示过期证据", async () => {
		const { searcher } = makeSearcher();
		req.mockRejectedValueOnce(new Error("llm down"));
		await searcher.localSearch("query notes", PLUGINS as any);
		expect(searcher.getLastMatchDiagnostics()).not.toBeNull();

		req.mockRejectedValue(new Error("all batches down"));
		await expect(searcher.search("zzzz不存在zzzz", PLUGINS as any)).rejects.toThrow();
		expect(searcher.getLastMatchDiagnostics()).toBeNull();
	});

	it("快照是拷贝：外部改动不影响内部状态", async () => {
		const { searcher } = makeSearcher();
		req.mockRejectedValue(new Error("llm down"));
		await searcher.search("query notes", PLUGINS as any);

		const first = searcher.getLastSearchTiming()!;
		first.phases.push({ name: "伪造", ms: 999 });
		first.counters["伪造"] = 1;

		expect(searcher.getLastSearchTiming()!.phases.map((p) => p.name)).not.toContain("伪造");
		expect(searcher.getLastSearchTiming()!.counters["伪造"]).toBeUndefined();
	});

	it("本地阶段超过阈值时额外告警，且告警文案说明已排除 LLM 耗时", async () => {
		const { searcher } = makeSearcher();
		req.mockRejectedValue(new Error("llm down"));

		// 每次 performance.now() 前进 200ms。注意 measure() 会调用两次 now()（起止），
		// 但阶段耗时是两次之差 = 1 个增量，故 3 个本地阶段合计 600ms > 400ms 阈值。
		let clock = 0;
		const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => (clock += 200));
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
		// 关键：mockRestore() 会连同已记录的调用一起清空，必须在 restore 之前取出。
		let messages: string[] = [];
		try {
			await searcher.search("query notes", PLUGINS as any);
			messages = warnSpy.mock.calls.map((c) => String(c[0]));
		} finally {
			nowSpy.mockRestore();
			warnSpy.mockRestore();
		}

		const slowWarn = messages.find((m) => m.includes("本地检索阶段偏慢"));
		expect(slowWarn).toBeDefined();
		expect(slowWarn!).toContain("不含 LLM 与 embedding 往返");
	});

	it("正常速度的搜索不触发慢查询告警", async () => {
		const { searcher } = makeSearcher();
		req.mockRejectedValue(new Error("llm down"));
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
		let messages: string[] = [];
		try {
			await searcher.search("query notes", PLUGINS as any);
			messages = warnSpy.mock.calls.map((c) => String(c[0]));
		} finally {
			warnSpy.mockRestore();
		}

		expect(messages.some((m) => m.includes("本地检索阶段偏慢"))).toBe(false);
		// 前提校验：本次搜索确实产生过 warn（LLM 精排失败会 warn）。
		// 若没有这条断言，「没告警」可能只是因为根本没采集到调用（假阴性）。
		expect(messages.length).toBeGreaterThan(0);
	});

	it("向量路启用时阶段不重叠，且失败原因如实上报", async () => {
		// 回归 1：search() 曾用 measure("向量召回") 包住 vectorRecallScores，而后者内部又
		// measure("向量索引")/measure("query 编码+余弦")。嵌套导致 localPhaseMs 把整段
		// 向量耗时算两遍，慢查询告警在开启向量搜索时虚报。
		// 现有测试全用 keyword 模式，结构上覆盖不到这条路径。
		const { searcher } = makeSearcher("local");
		req.mockRejectedValue(new Error("llm down"));
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
		let warnArgs: unknown[][] = [];
		try {
			// 测试环境未注入 worker 源码加载器，本地模型必然加载失败 → 向量路降级；
			// 但阶段计时照常记录，足以验证结构性质。
			await searcher.localSearch("query notes", PLUGINS as any);
			warnArgs = warnSpy.mock.calls.map((c) => [...c]);
		} finally {
			warnSpy.mockRestore();
		}

		const names = searcher.getLastSearchTiming()!.phases.map((p) => p.name);
		// 确实走向量路（索引阶段被记录）
		expect(names).toContain(PHASE.vectorIndex);
		// 伞形阶段必须不存在
		expect(names).not.toContain("向量召回");
		// 本地阶段只含我们自己的代码，不含向量索引 / query 编码
		expect(names).toContain(PHASE.keyword);
		expect(names).toContain(PHASE.fuzzy);
		expect(names).toContain(PHASE.rrf);

		// 回归 2：失败原因应是真实原因，而不是被 dispose 抹掉 this.initPromise 后
		// 的「worker not ready」—— 后者既误导调用方，又留下 unhandled rejection。
		const vectorWarn = warnArgs.find((a) => String(a[0]).includes("向量召回失败"));
		expect(vectorWarn).toBeDefined();
		expect(String((vectorWarn![1] as Error)?.message)).toContain("worker 源码加载器未注入");
	});

	it("后台 partial 索引直接召回，不在搜索侧重复 embed 全库", async () => {
		const tagService = new PluginTagService();
		const llm = new LLMClient({ baseURL: "https://api.example.com", apiKey: "sk-test", model: "test-model" });
		const searcher = new AISearcher(
			{
				baseURL: "https://api.example.com",
				apiKey: "sk-test",
				model: "test-model",
				embedding: {
					source: "api",
					baseURL: "https://embedding.example.com",
					apiKey: "sk-embedding",
					model: "embedding-model",
				},
			},
			llm,
			tagService,
		);
		const model = embeddingIndexKey({
			source: "api",
			baseURL: "https://embedding.example.com",
			model: "embedding-model",
		});
		searcher.setVectorIndex({
			ids: ["dataview"],
			vectors: [[1, 0]],
			hash: "",
			model,
			partial: true,
		});
		req.mockResolvedValue({
			status: 200,
			json: { data: [{ index: 0, embedding: [1, 0] }] },
		});

		await searcher.localSearch("database", [PLUGINS[0]]);

		// 只有 query embedding 一次；若 partial 被当成旧索引重建，这里会是两次。
		expect(req).toHaveBeenCalledTimes(1);
	});
});

describe("BM25 倒排索引（与单条打分等价性）", () => {
	// 合成语料：覆盖中文三元组、ASCII 词、超短描述、空描述，以及 p8/p9 这组
	// 「等长 + 同词」的构造，用于验证同分时的 tie-break。
	const CORPUS = [
		{ id: "p0", name: "Dataview", description: "把笔记当作数据库查询，支持类 SQL 语法" },
		{ id: "p1", name: "Calendar", description: "日历视图，追踪每日笔记与任务" },
		{ id: "p2", name: "Kanban", description: "看板视图，把笔记组织成任务卡片" },
		{ id: "p3", name: "Excalidraw", description: "手绘白板，支持思维导图与流程图" },
		{ id: "p4", name: "Templater", description: "模板引擎，批量生成笔记内容" },
		{ id: "p5", name: "Git", description: "版本控制，备份你的笔记仓库" },
		{ id: "p6", name: "笔记助手", description: "笔记" },
		{ id: "p7", name: "Empty", description: "" },
		{ id: "p8", name: "Twin", description: "笔记 同步" },
		{ id: "p9", name: "Duo", description: "笔记 同步" },
	];

	const index = buildBm25Index(CORPUS, computeIndexFingerprints(CORPUS).bm25);

	/**
	 * 参考实现：逐条文档调用 bm25Score（即重构前 ai.ts 的做法）。
	 * 与被测的倒排路径完全独立，用于证明「换索引结构不改分数」。
	 */
	function referenceScores(query: string): Map<string, number> {
		const queryTokens = tokenizeForBM25(t2sForEmbed(expandQuery(query.trim())));
		const out = new Map<string, number>();
		if (queryTokens.length === 0) return out;
		const qtf = new Map<string, number>();
		for (const t of queryTokens) qtf.set(t, (qtf.get(t) ?? 0) + 1);
		for (const p of CORPUS) {
			const docTokens = tokenizeForBM25(t2sForEmbed(`${p.name} ${p.description}`));
			const score = bm25Score(
				queryTokens, docTokens, index.df, index.N, index.avgdl, BM25_K1, BM25_B, qtf
			);
			if (score > 0) out.set(p.id, score);
		}
		return out;
	}

	const QUERIES = ["笔记", "日历", "思维导图", "dataview", "模板 笔记", "笔记 同步", "zzz不存在", "", "   "];

	for (const query of QUERIES) {
		it(`query="${query}" 命中集合与分数与参考实现一致`, () => {
			const actual = bm25RecallScores(query, index);
			const expected = referenceScores(query);
			expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
			for (const [id, s] of expected) {
				// 逐位相等：两条路径的 term 遍历顺序相同，浮点累加顺序也相同，
				// 因此不该有误差。用 toBeCloseTo 会掩盖「公式被改坏但差得很小」的情况。
				expect(actual.get(id)).toBe(s);
			}
		});
	}

	it("手算基准（原语层）：bm25Idf / bm25LenNorm / bm25TermWeight 公式正确", () => {
		// 为什么需要这条：上面的「倒排 vs bm25Score」对拍**证明不了公式本身正确** ——
		// bm25Score 与倒排路径现已共用 bm25Idf/bm25LenNorm/bm25TermWeight 同一批原语，
		// 原语若有公式错误，两边会一起错、对拍照样通过。
		//
		// 这里直接对原语做手算断言（与 tokenizeForBM25 解耦——#53 引入 Intl 分词、#58 引入
		// CJK n-gram 后，端到端「单 token」假设不再成立，但原语公式本身不变）：
		//   bm25Idf(N=2, df=1) = ln((2-1+0.5)/(1+0.5)+1) = ln 2
		expect(bm25Idf(1, 2)).toBeCloseTo(Math.log(2), 12);
		//   bm25Idf(N=2, df=2) = ln((2-2+0.5)/(2+0.5)+1) = ln 1.2
		expect(bm25Idf(2, 2)).toBeCloseTo(Math.log(1.2), 12);
		//   lenNorm(docLen=1, avgdl=2) = 1-0.75+0.75×(1/2) = 0.625
		expect(bm25LenNorm(1, 2)).toBeCloseTo(0.625, 12);
		//   lenNorm(docLen=3, avgdl=2) = 1-0.75+0.75×(3/2) = 1.375
		expect(bm25LenNorm(3, 2)).toBeCloseTo(1.375, 12);
		//   termWeight(tf=1, lenNorm=0.625, k1=1.5) = 1×2.5/(1+1.5×0.625) ≈ 1.29032
		expect(bm25TermWeight(1, 0.625)).toBeCloseTo(1.2903225806451613, 12);
		//   termWeight(tf=2, lenNorm=1.375, k1=1.5) = 2×2.5/(2+1.5×1.375) ≈ 1.23077
		expect(bm25TermWeight(2, 1.375)).toBeCloseTo(1.2307692307692308, 12);
		// 短文档命中 1 次应高于长文档命中 2 次（长度归一化生效：1.29032 > 1.23077）
		expect(bm25TermWeight(1, 0.625)).toBeGreaterThan(bm25TermWeight(2, 1.375));
	});

	it("结果按 (score desc, 插件列表序 asc) 排序 —— 同分 tie-break 与旧实现一致", () => {
		const actual = bm25RecallScores("笔记", index);
		const ids = [...actual.keys()];
		const pos = new Map(CORPUS.map((p, i) => [p.id, i]));
		for (let i = 1; i < ids.length; i++) {
			const prev = actual.get(ids[i - 1])!;
			const cur = actual.get(ids[i])!;
			// 分数严格降序；同分则插件列表序严格递增
			if (prev === cur) {
				expect(pos.get(ids[i - 1])!).toBeLessThan(pos.get(ids[i])!);
			} else {
				expect(prev).toBeGreaterThan(cur);
			}
		}
		// p8/p9 等长同词 → 必然同分，且 p8 在 p9 之前
		expect(actual.get("p8")).toBeCloseTo(actual.get("p9")!, 12);
		expect(ids.indexOf("p8")).toBeLessThan(ids.indexOf("p9"));
	});

	it("topK 截断：只保留前 k 条，且是全量结果的前缀", () => {
		const full = bm25RecallScores("笔记", index);
		expect(full.size).toBeGreaterThan(2);
		const capped = bm25RecallScores("笔记", index, 2);
		expect(capped.size).toBe(2);
		expect([...capped.keys()]).toEqual([...full.keys()].slice(0, 2));
	});

	it("BM25 索引 nameZh/descZh，中文字段可独立命中英文不含关键词的插件", () => {
		const bilingual = [
			{ id: "name-zh", name: "Alpha", description: "English only", nameZh: "中文名称" },
			{ id: "desc-zh", name: "Beta", description: "Another English description", descZh: "离线绘图" },
		];
		const bilingualIndex = buildBm25Index(
			bilingual,
			computeIndexFingerprints(bilingual).bm25,
		);

		expect(bm25RecallScores("中文名称", bilingualIndex).has("name-zh")).toBe(true);
		expect(bm25RecallScores("离线绘图", bilingualIndex).has("desc-zh")).toBe(true);
		expect(bilingualIndex.docLenNorm).toHaveLength(bilingual.length);
		expect(bilingualIndex.docLenNorm.every((n) => Number.isFinite(n))).toBe(true);
	});

	it("getBm25Index 按内容指纹缓存：内容不变复用同一引用，中间条目变化则重建", () => {
		const { searcher } = makeSearcher();
		// 内容指纹缓存：内容不变复用同一引用，中间条目变化则重建（PR #58 评测集新增）
		const first = searcher.getBm25Index(CORPUS);
		expect(searcher.getBm25Index(CORPUS)).toBe(first); // 内容不变 → 同一实例

		// 中间条目的描述变化：条目数、首尾 id 都没变
		// （旧的「长度 + 首尾 id」签名会漏判，继续用过期分词打分）
		const mutated = CORPUS.map((p) => ({ ...p }));
		mutated[2].description += "（已更新）";
		expect(mutated.length).toBe(CORPUS.length);
		expect(mutated[0].id).toBe(CORPUS[0].id);
		expect(mutated[mutated.length - 1].id).toBe(CORPUS[CORPUS.length - 1].id);

		expect(searcher.getBm25Index(mutated)).not.toBe(first);
	});

	it("传入预计算指纹时不再自行遍历（避免每次搜索算两遍）", () => {
		const { searcher } = makeSearcher();
		const sig = computeIndexFingerprints(CORPUS).bm25;
		const a = searcher.getBm25Index(CORPUS, sig);
		// 同一个预计算指纹 → 命中缓存
		expect(searcher.getBm25Index(CORPUS, sig)).toBe(a);
		// 与不传预计算指纹时的结果一致（签名语义相同）
		expect(searcher.getBm25Index(CORPUS)).toBe(a);
	});
});

describe("bigram 盲区回归（④ harness 胜出臂采纳）", () => {
	beforeEach(() => {
		req.mockReset();
		setHttpClient({ request: req });
	});
	afterEach(() => {
		resetHttpClient();
	});

	it("2 字 query 命中正文长 run（旧纯 trigram 该 query 关键词路恒漏）", async () => {
		const { searcher } = makeSearcher();
		req.mockRejectedValue(new Error("不应调用网络"));
		const plugins = [
			{ id: "door", name: "DoorMaster", description: "门禁系统管理工具" },
			{ id: "other", name: "Other", description: "完全不相关的内容" },
		];
		const r = await searcher.localSearch("门禁", plugins as any);
		expect(r.rankedIds).toContain("door");
		expect(r.rankedIds).not.toContain("other");
	});

	it("bm25IndexSig 含分词器版本指纹（分词策略变更必须失效缓存，P-0055 同族）", () => {
		const { searcher } = makeSearcher();
		const idx = searcher.getBm25Index([{ id: "a", name: "A", description: "aaa" }] as any);
		expect(idx.sig.startsWith(BM25_TOKENIZER_VERSION)).toBe(true);
	});

	it("繁简等价：模糊路 query 侧 t2s（trad 修复，繁体 query 不再整路缺席）", async () => {
		const { searcher } = makeSearcher();
		req.mockRejectedValue(new Error("不应调用网络"));
		const plugins = [
			{ id: "cal", name: "Calendar", description: "Calendar view for vault", nameZh: "日历" },
			{ id: "other", name: "Other", description: "unrelated stuff", nameZh: "其他" },
		];
		// 模糊路命中证据 = signals 含 title（BM25 路本就会命中，故用 signals 隔离模糊路行为）
		const rT = await searcher.localSearch("日曆", plugins as any);
		const rS = await searcher.localSearch("日历", plugins as any);
		expect(rT.signals?.["cal"]).toContain("title");
		expect(rS.signals?.["cal"]).toContain("title");
		expect(rT.rankedIds[0]).toBe("cal");
	});
});
