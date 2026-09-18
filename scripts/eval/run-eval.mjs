/**
 * eval-search harness（路线图 ④）：排序改动的数字批准门。
 *
 * 跑法：
 *   node scripts/eval/build-bundle.mjs        # 打包生产原语（entry.ts → eval.bundle.cjs）
 *   node scripts/eval/run-eval.mjs            # 跑四方分词臂 + 基线对照
 *   node scripts/eval/run-eval.mjs --update-baseline   # 把当前跑分写为基线
 *
 * 管线 = 生产 localSearch 同构：向量路（eval-vec-cache.json 缓存分数，阈值 0.3/cap 300 同生产）
 * + BM25 双场（2.0×标题+正文，df/avgdl 分场）+ 标题模糊路 → RRF(1.0/1.0/0.5, k=60)
 * → ×质量因子（recency×popularity）→ top300。分词臂只换 tokenize 函数，其余与生产逐行同构
 * （buildIndex/recallScores 镜像 ai.ts；漂移由 parity 检查兜底：tri 臂 top20 必须与
 * AISearcher.localSearch 注入同向量分后的输出完全一致，否则 exit 2）。
 *
 * 指标：Recall@5 / Recall@10 / MRR，全量 + 分桶（short/oov/general/en）。
 * 基线门：eval-fusion-baseline.json 存在时，tri 臂（=现生产分词）整体 R@10/MRR
 * 回退 >0.02 即 exit 1——排序改动合入前的回归防线。
 *
 * 向量缓存缺失时先跑（约 7 分钟，e5 全池 embed 一次）：
 *   node .agents/state/tasks/semantic-zh-en/../.. 见 process.md；缓存=eval-vec-cache.json。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const TASK = path.join(REPO, ".agents/state/tasks/semantic-zh-en");
const VAULT = path.join(
	os.homedir(),
	"Library/Mobile Documents/iCloud~md~obsidian/Documents/Agent/.obsidian/plugins/chinese-plugin-market"
);

const require2 = createRequire(import.meta.url);
const B = require2("./eval.bundle.cjs");
const { fuzzyTitleScores, rrfFuse, topNFused, applyQualityFactors, bm25Score, t2sForEmbed, expandQuery, AISearcher, LLMClient, PluginTagService } = B;

const UPDATE = process.argv.includes("--update-baseline");
const BM25_TITLE_W = 2.0; // 镜像 ai.ts 常量（漂移由 parity 兜底）

// ───────── 数据 ─────────
const pool = JSON.parse(fs.readFileSync(path.join(TASK, "eval-pool.json"), "utf8"));
const evalSet = JSON.parse(fs.readFileSync(path.join(TASK, "eval-set.json"), "utf8"));
const vecCache = JSON.parse(fs.readFileSync(path.join(TASK, "eval-vec-cache.json"), "utf8"));
const zh = JSON.parse(fs.readFileSync(path.join(VAULT, "translator-cache.json"), "utf8")).cache ?? {};
const stats = JSON.parse(fs.readFileSync(path.join(VAULT, "stats-cache.json"), "utf8")).stats ?? {};

const plugins = pool.map((p) => {
	const z = zh[p.id];
	const hasTr = z && z.source !== "original";
	const st = stats[p.id];
	return {
		id: p.id,
		name: p.name,
		description: p.description,
		nameZh: hasTr ? z.translatedName : undefined,
		descZh: hasTr ? z.translatedDesc : undefined,
		downloads: st?.downloads,
		updated: st?.updated,
	};
});

// ───────── 分词臂 ─────────
// 已知正例断言：复制 CJK 字符类的历史坑（截断 range 静默丢字）靠它当场现形
const CJK_RE = /[\u3400-\u9FFF\uF900-\uFAFF]/; // = bm25.ts:14 两段 range 的转义写法（防字面复制截断）
const ASCII_RE = /[a-zA-Z0-9_-]/;
function runs(text) {
	const out = [];
	const n = text.length;
	let i = 0;
	while (i < n) {
		const ch = text[i];
		if (CJK_RE.test(ch)) {
			let e = i;
			while (e < n && CJK_RE.test(text[e])) e++;
			out.push(["cjk", text.slice(i, e)]);
			i = e;
		} else if (ASCII_RE.test(ch)) {
			let e = i;
			while (e < n && ASCII_RE.test(text[e])) e++;
			out.push(["asc", text.slice(i, e).toLowerCase()]);
			i = e;
		} else i++;
	}
	return out;
}
function ngramTok(grams) {
	return (text) => {
		if (!text) return [];
		const t = [];
		for (const [k, run] of runs(text)) {
			if (k === "asc") {
				t.push(run);
				continue;
			}
			if (run.length <= 3) {
				t.push(run);
				continue;
			}
			for (const g of grams) for (let s = 0; s <= run.length - g; s++) t.push(run.slice(s, s + g));
		}
		return t;
	};
}
const tokTri = (text) => B.tokenizeForBM25(text); // 生产分词
const tokBig = ngramTok([2, 3]);
const tokIntl = typeof Intl.Segmenter === "function"
	? (() => {
			const seg = new Intl.Segmenter("zh-Hans", { granularity: "word" });
			return (text) => {
				if (!text) return [];
				const words = [];
				for (const s of seg.segment(text)) if (s.isWordLike) words.push(s.segment.toLowerCase());
				return [...words, ...tokTri(text)];
			};
		})()
	: null;
let tokJieba = null;
try {
	const j = require2("jieba-wasm");
	const cut = j.cut_for_search;
	tokJieba = (text) => (text ? cut(text, true) : []);
} catch {
	/* jieba 未安装 → 该臂跳过 */
}
// 已知正例：字符类完整性 + 盲区行为
{
	const d = new Set(tokBig("门禁系统管理工具"));
	if (!d.has("门禁")) throw new Error("bigram 臂自证失败：字符类可能被截断");
	if (new Set(tokTri("迷你番茄钟")).has("番茄钟") !== true) throw new Error("trigram 臂自证失败");
	if (tokTri("门禁系统管理工具").join(",") !== ngramTok([2,3])("门禁系统管理工具").join(",")) throw new Error("harness runs() 与生产分词漂移：CJK_RE 不一致");
}

const ARMS = [
	{ id: "tri", label: "trigram(现生产)", tok: tokTri },
	...(tokIntl ? [{ id: "intl", label: "intl∪trigram", tok: tokIntl }] : []),
	...(tokJieba ? [{ id: "jieba", label: "jieba-CS", tok: tokJieba }] : []),
];

// ───────── BM25 索引/召回（镜像 ai.ts buildBm25Index / bm25RecallScores） ─────────
function buildIndex(tok) {
	const docTokensById = new Map();
	const dfTitle = new Map();
	const dfBody = new Map();
	let tl = 0,
		bl = 0;
	for (const p of plugins) {
		const title = tok(t2sForEmbed(`${p.name} ${p.nameZh ?? ""}`));
		const body = tok(t2sForEmbed(`${p.description} ${p.descZh ?? ""}`));
		docTokensById.set(p.id, { title, body });
		tl += title.length;
		bl += body.length;
		for (const t of new Set(title)) dfTitle.set(t, (dfTitle.get(t) ?? 0) + 1);
		for (const t of new Set(body)) dfBody.set(t, (dfBody.get(t) ?? 0) + 1);
	}
	const N = plugins.length;
	let tokens = 0;
	for (const d of docTokensById.values()) tokens += d.title.length + d.body.length;
	return { docTokensById, dfTitle, dfBody, N, avgdlTitle: tl / N, avgdlBody: bl / N, tokens };
}
function recallScores(query, idx, tok) {
	const out = new Map();
	const qTokens = tok(t2sForEmbed(expandQuery(query.trim())));
	if (!qTokens.length) return out;
	const qtf = new Map();
	for (const t of qTokens) qtf.set(t, (qtf.get(t) ?? 0) + 1);
	for (const [id, doc] of idx.docTokensById) {
		const ts = bm25Score(qTokens, doc.title, idx.dfTitle, idx.N, idx.avgdlTitle, 1.5, 0.75, qtf);
		const bs = bm25Score(qTokens, doc.body, idx.dfBody, idx.N, idx.avgdlBody, 1.5, 0.75, qtf);
		const score = BM25_TITLE_W * ts + bs;
		if (score > 0) out.set(id, score);
	}
	return out;
}

// ───────── 单 query 融合排序（镜像 localSearch） ─────────
function rank(query, idx, tok) {
	const vectorScores = new Map(vecCache.perQuery[query] ?? []);
	const localScores = recallScores(query, idx, tok);
	const fuzzyScores = fuzzyTitleScores(query, plugins);
	const fused =
		vectorScores.size > 0
			? rrfFuse([vectorScores, localScores, fuzzyScores], [1.0, 1.0, 0.5])
			: rrfFuse([localScores, fuzzyScores], [1.0, 0.5]);
	return topNFused(applyQualityFactors(fused, plugins), 300).map((x) => x.id);
}

// ───────── parity：tri 臂 top20 ≡ 生产 AISearcher.localSearch（注入同向量分） ─────────
async function parityCheck(triRankedByQuery) {
	const searcher = new AISearcher(
		{ baseURL: "https://x", apiKey: "k", model: "m", embedding: { source: "api" } },
		new LLMClient({ baseURL: "https://x", apiKey: "k", model: "m" }),
		new PluginTagService()
	);
	let bad = 0;
	for (const { q } of evalSet.queries.slice(0, 5)) {
		searcher.vectorRecallScores = async () => new Map(vecCache.perQuery[q] ?? []);
		const r = await searcher.localSearch(q, plugins);
		const a = r.rankedIds.slice(0, 20).join(",");
		const b = triRankedByQuery[q].slice(0, 20).join(",");
		if (a !== b) {
			bad++;
			console.error(`[parity] MISMATCH q="${q}"\n  生产: ${a}\n  harness: ${b}`);
		}
	}
	return bad;
}

// ───────── 指标 ─────────
function metrics(ranked, gold) {
	const g = new Set(gold);
	const top5 = ranked.slice(0, 5).filter((id) => g.has(id)).length;
	const top10 = ranked.slice(0, 10).filter((id) => g.has(id)).length;
	const first = ranked.findIndex((id) => g.has(id));
	return { r5: top5 / gold.length, r10: top10 / gold.length, mrr: first >= 0 ? 1 / (first + 1) : 0 };
}
const agg = (rows, k) => rows.reduce((s, r) => s + r[k], 0) / rows.length;

// ───────── 主流程 ─────────
const results = {};
for (const arm of ARMS) {
	const t0 = Date.now();
	const idx = buildIndex(arm.tok);
	const buildMs = Date.now() - t0;
	const perQ = {};
	const rows = [];
	for (const { q, gold, bucket } of evalSet.queries) {
		const ranked = rank(q, idx, arm.tok);
		perQ[q] = ranked;
		rows.push({ bucket, ...metrics(ranked, gold) });
	}
	const buckets = [...new Set(rows.map((r) => r.bucket))];
	results[arm.id] = {
		label: arm.label,
		buildMs,
		tokens: idx.tokens,
		r5: agg(rows, "r5"),
		r10: agg(rows, "r10"),
		mrr: agg(rows, "mrr"),
		bucketR10: Object.fromEntries(buckets.map((b) => [b, agg(rows.filter((r) => r.bucket === b), "r10")])),
		perQ,
	};
	console.log(
		`${arm.label.padEnd(18)} R@5=${results[arm.id].r5.toFixed(3)} R@10=${results[arm.id].r10.toFixed(3)} MRR=${results[arm.id].mrr.toFixed(3)}` +
			` | 桶 ${buckets.map((b) => `${b}:${results[arm.id].bucketR10[b].toFixed(2)}`).join(" ")}` +
			` | 索引 ${idx.tokens} tok / ${buildMs}ms`
	);
}

const bad = await parityCheck(results.tri.perQ);
if (bad > 0) {
	console.error(`[parity] ${bad} 条 query 与生产 localSearch 不一致 → harness 与生产漂移，exit 2`);
	process.exit(2);
}
console.log("[parity] tri 臂 top20 ≡ 生产 localSearch ✓");

// ───────── 基线门 ─────────
const BASE = path.join(TASK, "eval-fusion-baseline.json");
const snapshot = {
	savedAt: new Date().toISOString(),
	evalSetVersion: evalSet.version,
	arms: Object.fromEntries(ARMS.map((a) => [a.id, { label: results[a.id].label, r5: results[a.id].r5, r10: results[a.id].r10, mrr: results[a.id].mrr, bucketR10: results[a.id].bucketR10, tokens: results[a.id].tokens }])),
};
if (UPDATE || !fs.existsSync(BASE)) {
	fs.writeFileSync(BASE, JSON.stringify(snapshot, null, 1));
	console.log(`[baseline] 已写入 ${path.basename(BASE)}（--update-baseline 或首跑）`);
} else {
	const base = JSON.parse(fs.readFileSync(BASE, "utf8"));
	const bt = base.arms?.tri;
	const ct = results.tri;
	if (bt && (bt.r10 - ct.r10 > 0.02 || bt.mrr - ct.mrr > 0.02)) {
		console.error(`[gate] FAIL 现生产分词臂回退超阈：R@10 ${bt.r10.toFixed(3)}→${ct.r10.toFixed(3)} · MRR ${bt.mrr.toFixed(3)}→${ct.mrr.toFixed(3)}（阈 0.02）`);
		process.exit(1);
	}
	console.log(`[gate] PASS tri 臂对基线无回退（基线 R@10=${bt?.r10?.toFixed(3)} MRR=${bt?.mrr?.toFixed(3)}）`);
}
