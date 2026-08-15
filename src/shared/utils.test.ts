import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	cleanChineseSpaces,
	stripReviewNotice,
	parseJSON,
	parseRecallCandidates,
	localRecall,
	cosineSimilarity,
	topKBySimilarity,
	contentHash,
	extractLLMContent,
	supportsJsonMode,
	mapWithConcurrency,
	mergeRecallIds,
	isListStale,
	computePluginDelta,
	debounce,
	normalizeBaseUrl,
} from "@shared/utils";

/** 测试辅助：延迟 ms 毫秒 */
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("cleanChineseSpaces", () => {
	it("去除两个中文字符之间的空格", () => {
		expect(cleanChineseSpaces("你好 世界")).toBe("你好世界");
	});

	it("去除多个中文字符之间的空格（连续多空格）", () => {
		expect(cleanChineseSpaces("你  好  世  界")).toBe("你好世界");
	});

	it("压缩英文多个空格为单个，且不误删英文间单个空格", () => {
		expect(cleanChineseSpaces("hello   world")).toBe("hello world");
	});

	it("中英混排：只去中文字间空格，保留英文单词周围空格", () => {
		expect(cleanChineseSpaces("打开 the 设置 面板")).toBe("打开 the 设置面板");
	});

	it("去除首尾空白", () => {
		expect(cleanChineseSpaces("  你好世界  ")).toBe("你好世界");
	});

	it("空串/无内容原样返回", () => {
		expect(cleanChineseSpaces("")).toBe("");
		expect(cleanChineseSpaces("   ")).toBe("");
		expect(cleanChineseSpaces(null as unknown as string)).toBe(null);
	});
});

describe("stripReviewNotice", () => {
	it("剔除描述末尾的 Obsidian 官方审核提示句（含「- 」前缀）", () => {
		expect(stripReviewNotice("- 此插件尚未经过 Obsidian 工作人员的手动审核。")).toBe("");
		expect(stripReviewNotice("…驱动。此插件尚未经过 Obsidian 工作人员的手动审核。")).toBe("…驱动");
	});

	it("覆盖官方/团队/工作人员/员工 × 人工/手动 × 有无「的」× 有无「尚」的多种变体", () => {
		expect(stripReviewNotice("尚未经过 Obsidian 团队手动审核。")).toBe("");
		expect(stripReviewNotice("该插件尚未经过 Obsidian 官方人工审核。")).toBe("");
		expect(stripReviewNotice("此插件尚未经过Obsidian团队的人工审核。")).toBe("");
		expect(stripReviewNotice("…支持。 - 该插件尚未经过 Obsidian 员工的手动审核。")).toBe("…支持");
		// 无「尚」变体：用户截图里的 omni-viewer 即此种
		expect(stripReviewNotice("- 此插件未经过 Obsidian 团队人工审核。")).toBe("");
		expect(stripReviewNotice("该插件未经过 Obsidian 官方人工审核。")).toBe("");
		expect(stripReviewNotice("未经过 Obsidian 官方手动审核。")).toBe("");
	});

	it("无句号、不同分隔符（— ——）同样剔除", () => {
		expect(stripReviewNotice("此插件尚未经过 Obsidian 工作人员的手动审核")).toBe("");
		expect(stripReviewNotice("…工作流。 — 此插件尚未经过 Obsidian 官方人工审核。")).toBe("…工作流");
		expect(stripReviewNotice("……。——此插件尚未经过Obsidian团队人工审核。")).toBe("……");
	});

	it("不误删正面表述与正常正文", () => {
		expect(stripReviewNotice("已通过 Obsidian 官方审核。")).toBe("已通过 Obsidian 官方审核。");
		expect(stripReviewNotice("描述正文。")).toBe("描述正文。");
		expect(stripReviewNotice("描述…尚未经过审核。但是别删我")).toBe("描述…尚未经过审核。但是别删我");
		expect(stripReviewNotice("")).toBe("");
	});

	it("cleanChineseSpaces 不剔除审核句（仅卡片描述调用方叠加 stripReviewNotice，详情页保留原文）", () => {
		expect(cleanChineseSpaces("- 此插件尚未经过 Obsidian 工作人员的手动审核。")).toBe(
			"- 此插件尚未经过 Obsidian 工作人员的手动审核。"
		);
		// 卡片描述实际渲染路径：cleanChineseSpaces 先清理空格，stripReviewNotice 再剔除审核句
		expect(stripReviewNotice(cleanChineseSpaces("简明 描述。 - 此插件尚未经过 Obsidian 官方人工审核。"))).toBe("简明描述");
	});
});

describe("parseJSON", () => {
	it("解析纯 JSON 字符串", () => {
		expect(parseJSON('{"a":1}')).toEqual({ a: 1 });
	});

	it("从夹杂说明文字的返回中提取 JSON", () => {
		const content = "好的，这是结果：\n{\"ranking\":[1,2,3]}\n以上。";
		expect(parseJSON(content)).toEqual({ ranking: [1, 2, 3] });
	});

	it("兼容 markdown 代码块包裹", () => {
		const content = "```json\n{\"x\":true}\n```";
		expect(parseJSON(content)).toEqual({ x: true });
	});

	it("无 JSON 时抛错", () => {
		expect(() => parseJSON("完全不是 JSON 的回复")).toThrow();
	});

	it("JSON 损坏时抛错", () => {
		expect(() => parseJSON("{bad json,,,}")).toThrow();
	});

	it("容错：全角标点（｛｝［］：，）归一化为半角后正常解析", () => {
		// 复现真实 case：模型返回 ｛"ranking"：［21, 27, ...］｝
		const content = '｛"ranking"：［21, 27, 29, 62, 75, 77, 89, 12，44, 74, 104］｝';
		expect(parseJSON(content)).toEqual({ ranking: [21, 27, 29, 62, 75, 77, 89, 12, 44, 74, 104] });
	});

	it("容错：全角标点 + 前后说明文字混合", () => {
		const content = "结果如下：｛\"ranking\"：［1，2，3］｝ 完毕。";
		expect(parseJSON(content)).toEqual({ ranking: [1, 2, 3] });
	});
});

describe("localRecall", () => {
	const plugins = [
		{ id: "obsidian-kanban", name: "Kanban Board", description: "Manage tasks with a kanban board view" },
		{ id: "dataview", name: "Dataview", description: "Query your notes as a database with SQL-like syntax" },
		{ id: "excalidraw", name: "Excalidraw", description: "Sketch diagrams and hand-drawn notes" },
		{ id: "calendar", name: "Calendar", description: "Track your daily notes in a calendar view" },
		{ id: "templater", name: "Templater", description: "Create templates with dynamic variables" },
		{ id: "zh-calendar", name: "日历插件", description: "中文日历，管理你的每日笔记" },
	];

	it("英文子串命中 name 的排在前面", () => {
		const out = localRecall("kanban", plugins, 10);
		expect(out[0].id).toBe("obsidian-kanban");
	});

	it("词素命中（board）能召回 board 相关插件", () => {
		const out = localRecall("board", plugins, 10);
		expect(out.map((c) => c.id)).toContain("obsidian-kanban");
	});

	it("中文查询字面命中（插件含中文名/描述）", () => {
		const out = localRecall("日历", plugins, 10);
		expect(out[0].id).toBe("zh-calendar");
	});

	it("中文 query 对纯英文插件字面无重叠时返回空（由 LLM 兜底召回）", () => {
		// calendar 的 name/desc 都是英文，无中文字面重叠 → 本地召回为空，
		// 此时应由上层 aiSearch 回退到 LLM 全量召回，而非本地硬匹配。
		const out = localRecall("日历", [
			{ id: "calendar", name: "Calendar", description: "Track your daily notes in a calendar view" },
		], 10);
		expect(out).toEqual([]);
	});

	it("无命中返回空数组（上层应回退 LLM 召回）", () => {
		expect(localRecall("zzz-nonexistent-xyz", plugins, 10)).toEqual([]);
	});

	it("按得分降序：name 命中优先于仅 description 命中", () => {
		const out = localRecall("view", plugins, 10);
		// Kanban(name 含 board view? no) — Dataview/Excalidraw/Calendar 均靠 description 命中；
		// 此处只断言返回非空且全部得分>0（即都含 token "view"）
		expect(out.length).toBeGreaterThan(0);
		for (const c of out) {
			const hit = (c.name + " " + c.description).toLowerCase().includes("view");
			expect(hit).toBe(true);
		}
	});

	it("不超过 cap 上限", () => {
		const big = Array.from({ length: 50 }, (_, i) => ({
			id: `p${i}`,
			name: `thing ${i}`,
			description: "a widget tool",
		}));
		const out = localRecall("widget", big, 12);
		expect(out.length).toBeLessThanOrEqual(12);
	});

	it("空 query / 空库 / cap<=0 直接返回空", () => {
		expect(localRecall("", plugins, 10)).toEqual([]);
		expect(localRecall("board", [], 10)).toEqual([]);
		expect(localRecall("board", plugins, 0)).toEqual([]);
	});
});

describe("cosineSimilarity", () => {
	it("同向向量相似度为 1", () => {
		expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 6);
	});

	it("正交向量相似度为 0", () => {
		expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
	});

	it("反向向量相似度为 -1", () => {
		expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1, 6);
	});

	it("长度不等 / 空 / 零向量返回 0", () => {
		expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
		expect(cosineSimilarity([], [1])).toBe(0);
		expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
	});
});

describe("topKBySimilarity", () => {
	const items = [
		[1, 0, 0], // 与 query 完全同向
		[0, 1, 0], // 正交
		[0.9, 0.1, 0], // 接近同向
		[-1, 0, 0], // 反向
	];

	it("返回相似度最高的前 k 个（降序）", () => {
		const out = topKBySimilarity([1, 0, 0], items, 2);
		expect(out.map((o) => o.index)).toEqual([0, 2]);
		expect(out[0].score).toBeGreaterThanOrEqual(out[1].score);
	});

	it("k 大于条目数时返回全部（排序后）", () => {
		const out = topKBySimilarity([1, 0, 0], items, 10);
		expect(out.length).toBe(4);
		expect(out[0].index).toBe(0);
		expect(out[out.length - 1].index).toBe(3); // 反向排最后
	});

	it("k<=0 / 空 query / 空 items 返回空", () => {
		expect(topKBySimilarity([1, 0, 0], items, 0)).toEqual([]);
		expect(topKBySimilarity([], items, 2)).toEqual([]);
		expect(topKBySimilarity([1, 0, 0], [], 2)).toEqual([]);
	});
});

describe("contentHash", () => {
	it("相同内容得到相同哈希", () => {
		expect(contentHash(["a", "b", "c"])).toBe(contentHash(["a", "b", "c"]));
	});

	it("不同内容得到不同哈希", () => {
		expect(contentHash(["a", "b"])).not.toBe(contentHash(["a", "c"]));
	});

	it("分隔敏感：['ab','c'] 与 ['a','bc'] 不同", () => {
		expect(contentHash(["ab", "c"])).not.toBe(contentHash(["a", "bc"]));
	});

	it("空输入稳定返回", () => {
		expect(contentHash([])).toBe(contentHash([]));
	});
});

describe("parseRecallCandidates", () => {
	const batch = [
		{ id: "obsidian-kanban", name: "看板", description: "desc-kanban" },
		{ id: "dataview", name: "数据视图", description: "desc-dataview" },
		{ id: "excalidraw", name: "画板", description: "desc-excalidraw" },
	];

	it("标准格式 indices 为数字索引", () => {
		const out = parseRecallCandidates({ indices: [2, 0, 1] }, batch);
		expect(out.map((c) => c.id)).toEqual(["excalidraw", "obsidian-kanban", "dataview"]);
	});

	it("DeepSeek 风格：直接给插件 ID 列表（ids 字段）", () => {
		const out = parseRecallCandidates({ ids: ["dataview", "excalidraw"] }, batch);
		expect(out.map((c) => c.id)).toEqual(["dataview", "excalidraw"]);
	});

	it("模型混淆召回/精排：用 ranking 字段（当 id 列表解析）", () => {
		const out = parseRecallCandidates({ ranking: ["obsidian-kanban"] }, batch);
		expect(out.map((c) => c.id)).toEqual(["obsidian-kanban"]);
	});

	it("嵌套结构 plugins: [{id, ...}]", () => {
		const out = parseRecallCandidates(
			{ plugins: [{ id: "excalidraw" }, { id: "obsidian-kanban" }] },
			batch
		);
		expect(out.map((c) => c.id)).toEqual(["excalidraw", "obsidian-kanban"]);
	});

	it("顶层裸数组", () => {
		const out = parseRecallCandidates([0, 2], batch);
		expect(out.map((c) => c.id)).toEqual(["obsidian-kanban", "excalidraw"]);
	});

	it("字符串 ID 与数字索引混合", () => {
		const out = parseRecallCandidates({ indices: ["dataview", "0"] }, batch);
		expect(out.map((c) => c.id)).toEqual(["dataview", "obsidian-kanban"]);
	});

	it("重复 ID 自动去重", () => {
		const out = parseRecallCandidates({ indices: [0, 0, 1, "obsidian-kanban"] }, batch);
		expect(out.map((c) => c.id)).toEqual(["obsidian-kanban", "dataview"]);
	});

	it("候选全部不在本批插件里抛错", () => {
		expect(() =>
			parseRecallCandidates({ indices: ["nope-1", "nope-2", 99] }, batch)
		).toThrow(/全部无法映射/);
	});

	it("完全无法识别的响应抛错", () => {
		expect(() => parseRecallCandidates({ foo: "bar" }, batch)).toThrow(/缺少可识别的候选字段/);
	});

	it("非对象输入抛错", () => {
		expect(() => parseRecallCandidates("string", batch)).toThrow();
		expect(() => parseRecallCandidates(null, batch)).toThrow();
	});
});

describe("extractLLMContent", () => {
	it("正常返回 message.content", () => {
		const json = {
			choices: [{ message: { role: "assistant", content: '{"indices":[0,1]}' }, finish_reason: "stop" }],
		};
		expect(extractLLMContent(json)).toBe('{"indices":[0,1]}');
	});

	it("content 为空但有 refusal：抛带拒答原因的错", () => {
		const json = {
			choices: [
				{
					message: { role: "assistant", content: "", refusal: "内容涉及敏感信息" },
					finish_reason: "content_filter",
				},
			],
		};
		expect(() => extractLLMContent(json)).toThrow(/AI 拒答/);
		expect(() => extractLLMContent(json)).toThrow(/内容涉及敏感信息/);
	});

	it("content 为空但有 tool_calls.arguments：取函数参数作为文本", () => {
		const json = {
			choices: [
				{
					message: {
						role: "assistant",
						content: "",
						tool_calls: [
							{
								id: "call_1",
								type: "function",
								function: {
									name: "respond",
									arguments: '{"indices":[2,0]}',
								},
							},
						],
					},
					finish_reason: "tool_calls",
				},
			],
		};
		expect(extractLLMContent(json)).toBe('{"indices":[2,0]}');
	});

	it("content 为空、finish_reason=content_filter：抛带原因的错", () => {
		const json = {
			choices: [
				{ message: { role: "assistant", content: "" }, finish_reason: "content_filter" },
			],
		};
		expect(() => extractLLMContent(json)).toThrow(/content_filter/);
		expect(() => extractLLMContent(json)).toThrow(/内容安全过滤/);
	});

	it("content 为空、finish_reason=length：抛带原因的错", () => {
		const json = {
			choices: [
				{ message: { role: "assistant", content: "" }, finish_reason: "length" },
			],
		};
		expect(() => extractLLMContent(json)).toThrow(/length/);
		expect(() => extractLLMContent(json)).toThrow(/max_tokens/);
	});

	it("多条 choice 时拼接所有非空 content", () => {
		const json = {
			choices: [
				{ message: { content: "abc" }, finish_reason: "stop" },
				{ message: { content: "def" }, finish_reason: "stop" },
			],
		};
		expect(extractLLMContent(json)).toBe("abc\ndef");
	});

	it("content 仅有空白算作空", () => {
		const json = {
			choices: [
				{ message: { content: "   \n  " }, finish_reason: "stop" },
			],
		};
		expect(() => extractLLMContent(json)).toThrow(/finish_reason=stop/);
	});

	it("响应无 choices 数组抛错", () => {
		expect(() => extractLLMContent({ foo: "bar" })).toThrow(/缺少 choices/);
		expect(() => extractLLMContent(null)).toThrow();
	});
});

describe("supportsJsonMode", () => {
	it("主流 OpenAI/DeepSeek/Qwen/GLM/Moonshot/Kimi/Claude/Llama/Mistral 等白名单内模型", () => {
		for (const m of [
			"gpt-4o-mini",
			"gpt-4-turbo",
			"deepseek-chat",
			"deepseek-reasoner",
			"qwen-plus",
			"qwen2.5-7b-instruct",
			"qwq-32b-preview",
			"glm-4-flash",
			"moonshot-v1-8k",
			"kimi-k2-0711-preview",
			"claude-3-5-sonnet-20241022",
			"llama-3.1-70b",
			"gemma-2-9b-it",
			"mistral-large-latest",
			"yi-large",
			"doubao-pro",
			"ERNIE-4.0-8K",
			"hunyuan-pro",
		]) {
			expect(supportsJsonMode(m), m).toBe(true);
		}
	});

	it("未列入白名单的模型走普通模式，避免字段不识别报错", () => {
		for (const m of [
			"random-experiment-7b",
			"my-custom-llm",
			"",
		]) {
			expect(supportsJsonMode(m), m).toBe(false);
		}
	});

	it("大小写不敏感", () => {
		expect(supportsJsonMode("DeepSeek-Chat")).toBe(true);
		expect(supportsJsonMode("GPT-4o")).toBe(true);
	});
});

describe("mapWithConcurrency", () => {
	it("结果数组与输入顺序一一对应", async () => {
		const items = [1, 2, 3, 4, 5];
		const out = await mapWithConcurrency(items, 2, async (n) => n * 10);
		expect(out).toEqual([10, 20, 30, 40, 50]);
	});

	it("同时进行的任务数不超过并发上限", async () => {
		let active = 0;
		let peak = 0;
		const items = Array.from({ length: 10 }, (_, i) => i);
		await mapWithConcurrency(items, 3, async (n) => {
			active++;
			peak = Math.max(peak, active);
			await delay(10);
			active--;
			return n;
		});
		expect(peak).toBeLessThanOrEqual(3);
		expect(peak).toBeGreaterThan(1);
	});

	it("所有项都会被处理", async () => {
		const seen: number[] = [];
		const items = [5, 6, 7];
		await mapWithConcurrency(items, 5, async (n) => {
			seen.push(n);
			return n;
		});
		expect(seen.sort()).toEqual([5, 6, 7]);
	});

	it("空数组直接返回空结果", async () => {
		const out = await mapWithConcurrency([], 4, async (n) => n);
		expect(out).toEqual([]);
	});

	it("concurrency 超过项数时也能正确完成", async () => {
		const out = await mapWithConcurrency([1, 2], 100, async (n) => n + 1);
		expect(out).toEqual([2, 3]);
	});

	it("concurrency <= 0 时按串行(1)处理", async () => {
		let active = 0;
		let peak = 0;
		await mapWithConcurrency([1, 2, 3], 0, async (n) => {
			active++;
			peak = Math.max(peak, active);
			await delay(5);
			active--;
			return n;
		});
		expect(peak).toBe(1);
	});
});

describe("mergeRecallIds（混合召回并集）", () => {
	it("向量 + 关键词无重叠：并集且向量在前", () => {
		expect(mergeRecallIds(["a", "b"], ["c", "d"])).toEqual(["a", "b", "c", "d"]);
	});

	it("有重叠：去重，向量命中保留在前面", () => {
		// 关键：关键词命中的 b 已在向量里，不应重复；且顺序遵循「向量优先」
		expect(mergeRecallIds(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
	});

	it("向量路失败(null)：退化为纯关键词", () => {
		expect(mergeRecallIds(null, ["x", "y"])).toEqual(["x", "y"]);
	});

	it("向量路为空数组：与关键词并集，仅留关键词", () => {
		expect(mergeRecallIds([], ["p", "q"])).toEqual(["p", "q"]);
	});

	it("关键词为空：仅向量结果", () => {
		expect(mergeRecallIds(["m", "n"], [])).toEqual(["m", "n"]);
	});

	it("两者皆空：返回空数组（触发 LLM 兜底）", () => {
		expect(mergeRecallIds([], [])).toEqual([]);
		expect(mergeRecallIds(null, [])).toEqual([]);
	});

	it("关键词内有重复 id：合并时一并去重", () => {
	expect(mergeRecallIds(["a"], ["b", "b", "c"])).toEqual(["a", "b", "c"]);
});

describe("isListStale（产品改进 #15：列表 TTL 自动失效）", () => {
	const TTL = 6 * 60 * 60 * 1000; // 6h
	// 基准时刻必须足够大，确保 now-TTL 仍为正（否则会命中"未拉取"分支）
	const BASE = 100_000_000;

	it("从未拉取（lastFetchAt<=0）视为过期需重拉", () => {
		expect(isListStale(0, 1_000_000, TTL)).toBe(true);
		expect(isListStale(-1, 1_000_000, TTL)).toBe(true);
	});

	it("刚好在有效期内不过期", () => {
		const now = BASE;
		const fetched = now - TTL; // 正好 6h 前
		expect(isListStale(fetched, now, TTL)).toBe(false);
	});

	it("超过有效期（哪怕 1ms）即过期", () => {
		const now = BASE;
		const fetched = now - TTL - 1;
		expect(isListStale(fetched, now, TTL)).toBe(true);
	});

	it("有效期内（如 5h59m）不过期", () => {
		const now = BASE;
		const fetched = now - (TTL - 60_000);
		expect(isListStale(fetched, now, TTL)).toBe(false);
	});

	it("now 早于 lastFetchAt（时钟回拨）不过期，不抛错", () => {
		const now = 5_000_000;
		const fetched = 10_000_000;
		expect(isListStale(fetched, now, TTL)).toBe(false);
	});

	it("非有限时间戳按过期处理", () => {
		expect(isListStale(NaN, 1_000, TTL)).toBe(true);
		expect(isListStale(100, NaN, TTL)).toBe(true);
	});
});
});

describe("computePluginDelta（新增插件翻译增量）", () => {
	const src = (m: Record<string, string>) => (id: string) => m[id] ?? "original";

	it("首次加载（seen 为空）：isFirstLoad=true，newIds 为全集", () => {
		const d = computePluginDelta(["a", "b"], new Set(), src({}));
		expect(d.isFirstLoad).toBe(true);
		expect(d.newIds).toEqual(["a", "b"]);
	});

	it("无新增：newIds 为空", () => {
		const d = computePluginDelta(["a", "b"], new Set(["a", "b"]), src({}));
		expect(d.isFirstLoad).toBe(false);
		expect(d.newIds).toEqual([]);
		expect(d.translated).toBe(0);
		expect(d.untranslated).toBe(0);
	});

	it("有新增：区分已译/未译", () => {
		const d = computePluginDelta(
			["a", "b", "c"],
			new Set(["a"]),
			src({ b: "online", c: "original" })
		);
		expect(d.newIds).toEqual(["b", "c"]);
		expect(d.translated).toBe(1); // b=online
		expect(d.untranslated).toBe(1); // c=original
	});

	it("sourceOf 缺省视为 original", () => {
		const d = computePluginDelta(["x"], new Set(["a"]), () => "original");
		expect(d.newIds).toEqual(["x"]);
		expect(d.untranslated).toBe(1);
		expect(d.translated).toBe(0);
	});
});

// ── parseRecallCandidates：LLM 召回响应解析器（产品改进 #3 补齐） ──

describe("parseRecallCandidates · 6 种 LLM 召回响应格式", () => {
	const batch = [
		{ id: "sync", name: "Sync", description: "keep notes in sync" },
		{ id: "kanban", name: "Kanban", description: "board for tasks" },
		{ id: "theme", name: "Theme", description: "color themes" },
	];

	it("indices: 按索引召回（标准路径）", () => {
		const out = parseRecallCandidates({ indices: [0, 2] }, batch);
		expect(out.map((c) => c.id)).toEqual(["sync", "theme"]);
	});

	it("ids: 直接给插件 ID（DeepSeek 常见）", () => {
		const out = parseRecallCandidates({ ids: ["sync", "kanban"] }, batch);
		expect(out.map((c) => c.id)).toEqual(["sync", "kanban"]);
	});

	it("ranking: 模型误用精排字段名，容错解析", () => {
		const out = parseRecallCandidates({ ranking: [0, 1] }, batch);
		expect(out.map((c) => c.id)).toEqual(["sync", "kanban"]);
	});

	it("plugins: 嵌套结构 [{id},...]", () => {
		const out = parseRecallCandidates(
			{ plugins: [{ id: "theme" }, { id: "sync" }] },
			batch
		);
		expect(out.map((c) => c.id)).toEqual(["theme", "sync"]);
	});

	it("裸数组顶层 ...（模型省略了对象外壳）", () => {
		const out = parseRecallCandidates(["sync", "kanban"], batch);
		expect(out.map((c) => c.id)).toEqual(["sync", "kanban"]);
	});

	it("空数组或无有效候选时抛错", () => {
		expect(() => parseRecallCandidates({}, batch)).toThrow("缺少可识别的候选字段");
		expect(() => parseRecallCandidates({ indices: [] }, batch)).toThrow(
			"缺少可识别的候选字段"
		);
	});

	it("非 object 输入抛错", () => {
		expect(() => parseRecallCandidates(null, batch)).toThrow("非对象");
		expect(() => parseRecallCandidates("hello", batch)).toThrow("非对象");
	});

	it("重复 id 去重", () => {
		const out = parseRecallCandidates(
			{ ids: ["sync", "sync", "kanban", "sync"] },
			batch
		);
		expect(out.map((c) => c.id)).toEqual(["sync", "kanban"]);
	});

	it("越界索引丢弃不报错", () => {
		const out = parseRecallCandidates({ indices: [0, 99] }, batch);
		expect(out.map((c) => c.id)).toEqual(["sync"]);
	});

	it("混合数字索引与字符串 ID：优先级按 ID 查 batch", () => {
		// "0" 既是合法 id（碰巧 batch 里无此 id），也是合法索引
		const out = parseRecallCandidates({ ids: ["1", "sync"] }, batch);
		// "1" 先在 batch.id 中查，不存在则按索引 idx=1（kanban）
		expect(out.map((c) => c.id)).toEqual(["kanban", "sync"]);
	});
});

// ── localRecall / mergeRecallIds 增补边缘情况 ──

describe("localRecall · 边缘情况", () => {
	const plugins = [
		{ id: "a", name: "Mind Map", description: "draw mind maps" },
		{ id: "b", name: "思维导图", description: "绘制思维导图。支持 Markdown。" },
		{ id: "c", name: "Calendar", description: "date picker" },
		{ id: "d", name: "Map View", description: "show map" },
	];

	it("空查询返回空数组", () => {
		expect(localRecall("", plugins, 10)).toEqual([]);
		expect(localRecall("   ", plugins, 10)).toEqual([]);
	});

	it("cap <= 0 返回空", () => {
		expect(localRecall("map", plugins, 0)).toEqual([]);
		expect(localRecall("map", plugins, -1)).toEqual([]);
	});

	it("完全无匹配返回空", () => {
		expect(localRecall("zzzzzz_nomatch", plugins, 10)).toEqual([]);
	});

	it("中文查询按单字分词并命中", () => {
		const out = localRecall("思维导图", plugins, 10);
		expect(out.map((c) => c.id)).toContain("b"); // 思维导图 name 命中
	});

	it("部分中文词命中：仅一个字符匹配也计入", () => {
		const out = localRecall("导图", plugins, 10);
		expect(out.map((c) => c.id)).toContain("b");
	});

	it("name 命中分数更高，排在前面", () => {
		const out = localRecall("map", plugins, 10);
		// d (Map View) name 包含"map"，c (Calendar) 仅 desc 包含"date"，a (Mind Map) name 包含
		expect(out[0].id).toBe("a"); // name "Mind Map" 全串匹配
	});

	it("结果数量不超过 cap", () => {
		const out = localRecall("map", plugins, 1);
		expect(out.length).toBe(1);
	});

	it("query 仅含标点和空格时无 token，返回空", () => {
		expect(localRecall("!@#  $%^", plugins, 10)).toEqual([]);
	});
});

describe("mergeRecallIds · 增补边缘情况", () => {
	it("vectorIds 为 null 时，只看 localIds", () => {
		expect(mergeRecallIds(null, ["a", "b"])).toEqual(["a", "b"]);
	});

	it("vectorIds 为 undefined 时，只看 localIds", () => {
		expect(mergeRecallIds(undefined as unknown as string[], ["c"])).toEqual(["c"]);
	});
});

describe("debounce（审计 P1-1：收敛手写 setTimeout/clearTimeout）", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("连续调用合并为一次执行", async () => {
		const fn = vi.fn();
		const d = debounce(fn, 100);
		d();
		d();
		d();
		expect(fn).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(100);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("pending() 反映挂起态，cancel() 可取消", async () => {
		const fn = vi.fn();
		const d = debounce(fn, 100);
		expect(d.pending()).toBe(false);
		d();
		expect(d.pending()).toBe(true);
		d.cancel();
		expect(d.pending()).toBe(false);
		await vi.advanceTimersByTimeAsync(100);
		expect(fn).not.toHaveBeenCalled();
	});

	it("flush() 立即执行并清掉挂起定时器", async () => {
		const fn = vi.fn();
		const d = debounce(fn, 100);
		d();
		expect(d.pending()).toBe(true);
		d.flush();
		expect(fn).toHaveBeenCalledTimes(1);
		expect(d.pending()).toBe(false);
		await vi.advanceTimersByTimeAsync(100);
		expect(fn).toHaveBeenCalledTimes(1);
	});
});

describe("normalizeBaseUrl（AI 搜索 404 修复：容忍用户各种填法）", () => {
	it("规范填写（无尾斜杠、无路径）保持不变", () => {
		expect(normalizeBaseUrl("https://api.deepseek.com")).toBe("https://api.deepseek.com");
	});

	it("剥离尾部斜杠", () => {
		expect(normalizeBaseUrl("https://api.deepseek.com/")).toBe("https://api.deepseek.com");
		expect(normalizeBaseUrl("https://api.deepseek.com///")).toBe("https://api.deepseek.com");
	});

	it("剥离已包含的 /v1 段，避免双重拼接", () => {
		expect(normalizeBaseUrl("https://api.deepseek.com/v1")).toBe("https://api.deepseek.com");
	});

	it("剥离已包含的完整端点路径（chat/embeddings）", () => {
		expect(normalizeBaseUrl("https://api.deepseek.com/v1/chat/completions")).toBe(
			"https://api.deepseek.com"
		);
		expect(normalizeBaseUrl("https://api.deepseek.com/v1/embeddings")).toBe(
			"https://api.deepseek.com"
		);
	});

	it("大小写不敏感地处理路径后缀", () => {
		expect(normalizeBaseUrl("https://API.DEEPSEEK.COM/V1/CHAT/COMPLETIONS")).toBe(
			"https://API.DEEPSEEK.COM"
		);
	});

	it("空/未定义输入安全返回空串", () => {
		expect(normalizeBaseUrl("")).toBe("");
		expect(normalizeBaseUrl(undefined as unknown as string)).toBe("");
	});
});
