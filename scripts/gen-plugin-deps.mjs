#!/usr/bin/env node
/**
 * 离线生成 plugin-deps.json（插件依赖基线）。可重跑、幂等。
 *
 * 数据策略：人工精修（A）打底 + 自动检测（B）补长尾。
 * - A：scripts/deps/curated.json（按「枢纽插件」组织「被谁依赖」），生成时展开成正向边，
 *      source=curated、confidence=1，覆盖最准、零误报。
 * - B：对每个插件调 detectDeps（manifest + main.js + README 三路证据）。强信号
 *      （confidence >= REQUIRED_MIN，即 manifest 0.9 / main.js 0.85 / README 强措辞 0.7）
 *      自动采纳为 required 进 plugin-deps.json；弱信号（0.4~0.7）**只进候选清单**
 *      docs/plugin-deps-candidates.md，不入库——误报代价高于漏报，弱信号留人工确认。
 *
 * 用法：
 *   node scripts/gen-plugin-deps.mjs                 # 全量
 *   node scripts/gen-plugin-deps.mjs --limit 200     # 先小样本验证
 *   node scripts/gen-plugin-deps.mjs --only-new      # 只处理现有结果里没有的 id
 *
 * 注意：PLUGINS_URL 写成字面量（与 src/shared/constants.ts 的 PLUGINS_URL 一致），
 * 因为脚本是纯 Node 环境，不能 import TS 常量文件。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { loadModule } from "./esbuild-load.mjs";

// 走代理（本机直连 github raw 被拒）。设了 HTTPS_PROXY/HTTP_PROXY 就接管全局 fetch。
const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (proxy) setGlobalDispatcher(new ProxyAgent(proxy));

const PLUGINS_URL =
	"https://cdn.jsdelivr.net/gh/obsidianmd/obsidian-releases/community-plugins.json";
const RAW = "https://raw.githubusercontent.com";
const CDN = "https://cdn.jsdelivr.net/gh";
const CONCURRENCY = 20;
const README_LIMIT = 5000;
const FETCH_TIMEOUT = 8000; // 经代理个别请求会挂死，必须超时释放并发槽

/** 抓取文本；失败/超时返回 null（单个插件失败不影响整体） */
async function fetchText(url) {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
		if (!res.ok) return null;
		return await res.text();
	} catch {
		return null;
	}
}

/**
 * 抓插件仓库内的文件：优先 jsDelivr CDN（不同主机，本机代理对 raw.githubusercontent
 * 的持续流有严重限速，jsDelivr 不受影响），失败再回退 raw.githubusercontent。
 */
async function fetchRepoFile(repo, path) {
	const cdn = await fetchText(`${CDN}/${repo}/${path}`);
	if (cdn) return cdn;
	return fetchText(`${RAW}/${repo}/HEAD/${path}`);
}

/** 依次尝试常见 README 文件名，取前 README_LIMIT 字符 */
async function fetchReadme(repo) {
	for (const name of ["README.md", "readme.md"]) {
		const text = await fetchRepoFile(repo, name);
		if (text) return text.slice(0, README_LIMIT);
	}
	return "";
}

async function main() {
	const args = process.argv.slice(2);
	const limitIdx = args.indexOf("--limit");
	const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;
	const onlyNew = args.includes("--only-new");

	const { detectDeps } = await loadModule("src/domain/deps/detect.ts");
	// 阈值常量在 rules.ts（detect.ts 只 import 不 re-export），单独加载拿
	const { REQUIRED_MIN, DROP_BELOW } = await loadModule("src/domain/deps/rules.ts");

	const curated = JSON.parse(readFileSync("scripts/deps/curated.json", "utf8"));
	console.log("· 拉取插件列表…");
	const list = (await (await fetch(PLUGINS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT) })).json()).slice(0, limit);
	console.log(`· 共 ${list.length} 个插件待处理`);

	const prev = onlyNew
		? JSON.parse(readFileSync("plugin-deps.json", "utf8")).edges ?? {}
		: {};
	// 旁路：记录已真正抓取过的 id，--only-new 时跳过，避免分块重跑时重复抓取无依赖的插件
	const processedPrev = onlyNew
		? new Set(JSON.parse(readFileSync("plugin-deps-processed.json", "utf8")))
		: new Set();
	const dict = list.map((p) => ({
		id: p.id,
		name: p.name,
		aliases: (curated[p.id] && curated[p.id].aliases) || [],
	}));

	const edges = { ...prev };
	const processed = new Set(processedPrev);
	const candidates = [];
	let cursor = 0;
	let doneCount = 0;

	async function worker() {
		while (cursor < list.length) {
			const p = list[cursor++];
			if (!p.repo || edges[p.id] || processed.has(p.id)) continue;
			processed.add(p.id);
			try {
				const manifest = await fetchRepoFile(p.repo, "manifest.json");
				// 主题 / 无 manifest 的跳过（本功能只覆盖插件→插件依赖）
				if (!manifest) continue;
				const parsed = JSON.parse(manifest);
				const readme = await fetchReadme(p.repo);
				const found = detectDeps({
					selfId: p.id,
					manifestDeps: parsed.dependencies,
					// 注意：本期只扫 manifest + README。main.js 调用特征命中率本就低，
					// 且每个插件再抓一次 main.js 会把请求量翻倍；需要更强覆盖时再加。
					mainJs: "",
					readme,
					dict,
				});
				for (const e of found) {
					if (e.confidence >= REQUIRED_MIN) {
						(edges[p.id] ??= []).push(e);
					} else if (e.confidence >= DROP_BELOW) {
						candidates.push({ id: p.id, name: p.name, depId: e.id, depName: e.name, kind: e.kind, confidence: e.confidence, source: e.source });
					}
				}
			} catch {
				/* 单插件失败不影响整体 */
			} finally {
				doneCount++;
				if (doneCount % 100 === 0) console.log(`…已处理 ${doneCount}/${list.length}`);
			}
		}
	}

	await Promise.all(Array.from({ length: CONCURRENCY }, worker));

	// 精修层覆盖检测结果（展开成 source=curated confidence=1）
	for (const [hubId, hub] of Object.entries(curated)) {
		if (hubId === "_comment") continue;
		for (const kind of ["required", "optional"]) {
			for (const dependentId of hub.dependents?.[kind] ?? []) {
				const arr = edges[dependentId] ??= [];
				const existing = arr.findIndex((e) => e.id === hubId);
				const edge = { id: hubId, name: hub.name, kind, source: "curated", confidence: 1 };
				if (existing >= 0) arr[existing] = edge;
				else arr.push(edge);
			}
		}
	}

	writeFileSync(
		"plugin-deps.json",
		`${JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), edges }, null, 2)}\n`,
	);
	writeFileSync(
		"docs/plugin-deps-candidates.md",
		[
			"# 依赖候选（弱信号，需人工抽查后并入 scripts/deps/curated.json）",
			"",
			"弱信号（README 弱措辞 / main.js 低置信）不自动入库：误报比漏报贵，一条错误的「必需」会劝退安装。",
			"确认成立的，把目标 hub 加进 scripts/deps/curated.json 的 dependents 即可下次生效。",
			"",
			"| 插件 | 插件名 | 依赖 | 依赖名 | 类型 | 置信度 | 来源 |",
			"| --- | --- | --- | --- | --- | --- | --- |",
			...candidates.map(
				(c) =>
					`| ${c.id} | ${c.name} | ${c.depId} | ${c.depName} | ${c.kind} | ${c.confidence} | ${c.source} |`,
			),
			"",
		].join("\n"),
	);
	writeFileSync("plugin-deps-processed.json", JSON.stringify([...processed], null, 2) + "\n");
	console.log(`✓ 写入 ${Object.keys(edges).length} 条插件记录，${candidates.length} 条弱信号候选`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
