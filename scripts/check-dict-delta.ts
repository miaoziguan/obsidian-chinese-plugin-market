/**
 * check-dict-delta.ts — CI 翻译词典增量检测与自动补译
 * ─────────────────────────────────────────────
 * 在 CI (GitHub Actions) 中按周运行：
 *   1. 拉取社区插件清单 community-plugins.json
 *   2. 读取当前离线词典 obsidian-translator-full-dict.json
 *   3. 计算新增插件（已入社区但词典未覆盖）
 *   4. 对新增插件调用 MyMemory 免费 API 自动翻译
 *   5. 输出：
 *      - 更新后的 dict 条目（可合并入主词典）
 *      - JSON 摘要报告（供 GitHub Actions 后续步骤消费）
 *
 * 用法：node scripts/check-dict-delta.mjs
 * 环境变量：
 *   - PLUGINS_URL  社区清单 URL（默认官方 raw URL）
 *   - DICT_PATH     词典文件路径（默认仓库根 obsidian-translator-full-dict.json）
 *   - REPORT_PATH   摘要输出路径（默认仓库根 dict-delta-report.json）
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── 类型定义 ──────────────────────────────────

interface CommunityPlugin {
	id: string;
	name: string;
	author: string;
	description: string;
	repo: string;
}

interface DictEntry {
	name: string;
	description: string;
}

type Dictionary = Record<string, DictEntry>;

interface DeltaReport {
	timestamp: string;
	totalCommunity: number;
	totalDict: number;
	newCount: number;
	translated: number;
	untranslated: number;
	/** 成功补译的新条目，可直接合并到词典 */
	newEntries: Dictionary;
	/** 补译失败（MyMemory 不可用或返回无效），需人工处理 */
	failed: string[];
}

// ── 配置 ──────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PLUGINS_URL =
	process.env.PLUGINS_URL ??
	"https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json";

const DICT_PATH = resolve(
	process.env.DICT_PATH ?? resolve(__dirname, "..", "obsidian-translator-full-dict.json")
);

const REPORT_PATH = resolve(
	process.env.REPORT_PATH ?? resolve(__dirname, "..", "dict-delta-report.json")
);

/** MyMemory 翻译 API 地址（en → zh-CN） */
const MYMEMORY_API = "https://api.mymemory.translated.net/get";

/** 批量请求并发数（MyMemory 免费额度 ~5000 字符/天，新插件数量有限，低并发即可） */
const CONCURRENCY = 2;

// ── 工具函数 ──────────────────────────────────

/**
 * 调用 MyMemory 免费翻译 API，en → zh-CN。
 * 与 translator.ts 中 callMyMemoryApi 逻辑一致，但无 Obsidian 依赖（纯 fetch）。
 */
async function myMemoryTranslate(text: string): Promise<string> {
	const truncated = text.length > 500 ? text.substring(0, 500) : text;
	const url = `${MYMEMORY_API}?q=${encodeURIComponent(truncated)}&langpair=en|zh-CN`;

	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`MyMemory HTTP ${res.status}`);
	}

	const json = (await res.json()) as {
		responseStatus: number;
		responseData?: { translatedText?: string };
		responseDetails?: string;
	};

	if (json.responseStatus === 200 && json.responseData?.translatedText) {
		const translated = json.responseData.translatedText;

		// 与 translator.ts 一致的"无效译文"检测
		const quotaHints = ["PLEASE SELECT", "QUOTA", "MYMEMORY WARNING", "TRY AGAIN"];
		const isQuotaHint = quotaHints.some((h) =>
			translated.toUpperCase().includes(h)
		);
		const isUnchanged =
			translated.trim().toLowerCase() === text.trim().toLowerCase();
		const isAllCaps =
			translated.toUpperCase() === translated && text.toUpperCase() !== text;

		if (isQuotaHint || isUnchanged || isAllCaps) {
			throw new Error("MyMemory 未返回有效译文（原文/配额提示/全大写）");
		}
		return translated;
	}

	throw new Error(
		`MyMemory API 错误: ${json.responseStatus} ${json.responseDetails ?? ""}`
	);
}

/** 带重试的 MyMemory 调用（最多 2 次，间隔 1s） */
async function myMemoryWithRetry(text: string, retries = 2): Promise<string> {
	let lastErr: unknown;
	for (let i = 0; i < retries; i++) {
		try {
			return await myMemoryTranslate(text);
		} catch (e) {
			lastErr = e;
			if (i < retries - 1) {
				await sleep(1000);
			}
		}
	}
	throw lastErr;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** 并发限流执行器 */
async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	worker: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let cursor = 0;
	const runner = async () => {
		while (cursor < items.length) {
			const idx = cursor++;
			results[idx] = await worker(items[idx], idx);
		}
	};
	await Promise.all(Array.from({ length: limit }, () => runner()));
	return results;
}

// ── 核心逻辑 ──────────────────────────────────

async function main() {
	console.log("🔍 翻译词典增量检测开始...\n");

	// 1. 拉取社区插件清单
	console.log(`📥 拉取社区清单: ${PLUGINS_URL}`);
	const pluginsRes = await fetch(PLUGINS_URL);
	if (!pluginsRes.ok) {
		throw new Error(`下载社区清单失败: HTTP ${pluginsRes.status}`);
	}
	const community: CommunityPlugin[] = (await pluginsRes.json()) as CommunityPlugin[];
	console.log(`   ✅ 获取到 ${community.length} 个社区插件`);

	// 2. 读取当前词典
	let dict: Dictionary = {};
	if (existsSync(DICT_PATH)) {
		const raw = readFileSync(DICT_PATH, "utf8");
		dict = JSON.parse(raw) as Dictionary;
	}
	const dictIds = new Set(Object.keys(dict));
	console.log(`   📖 当前词典覆盖 ${dictIds.size} 个插件`);

	// 3. 计算增量
	const newPlugins = community.filter((p) => !dictIds.has(p.id));
	console.log(`   🆕 发现 ${newPlugins.length} 个新插件需要翻译\n`);

	if (newPlugins.length === 0) {
		const report: DeltaReport = {
			timestamp: new Date().toISOString(),
			totalCommunity: community.length,
			totalDict: dictIds.size,
			newCount: 0,
			translated: 0,
			untranslated: 0,
			newEntries: {},
			failed: [],
		};
		writeFileSync(REPORT_PATH, JSON.stringify(report, null, "\t") + "\n", "utf8");
		console.log("✅ 词典已是最新，无新增插件。");
		return;
	}

	// 4. 对新增插件调用 MyMemory 翻译
	console.log("🌐 开始 MyMemory 自动翻译...");
	let translatedCount = 0;
	let failedCount = 0;
	const newEntries: Dictionary = {};
	const failed: string[] = [];

	await mapWithConcurrency(newPlugins, CONCURRENCY, async (plugin) => {
		const label = `[${plugin.id}]`;

		try {
			const [zhName, zhDesc] = await Promise.all([
				myMemoryWithRetry(plugin.name),
				myMemoryWithRetry(plugin.description),
			]);

			// 再次校验译文有效性
			if (
				zhName.trim().toLowerCase() === plugin.name.trim().toLowerCase() ||
				zhDesc.trim().toLowerCase() === plugin.description.trim().toLowerCase()
			) {
				throw new Error("译文与原文相同");
			}

			newEntries[plugin.id] = {
				name: zhName,
				description: zhDesc,
			};
			translatedCount++;
			console.log(`   ✅ ${label} ${plugin.name} → ${zhName}`);
		} catch (e) {
			failedCount++;
			const reason = e instanceof Error ? e.message : String(e);
			failed.push(plugin.id);
			console.warn(`   ❌ ${label} 翻译失败: ${reason}`);
		}
	});

	console.log(
		`\n   📊 翻译结果: 成功 ${translatedCount} / 失败 ${failedCount}`
	);

	// 5. 生成合并后的词典（用于 PR）
	if (Object.keys(newEntries).length > 0) {
		const merged = { ...dict, ...newEntries };
		// 按 key 排序输出，便于 diff 对比
		const sorted: Dictionary = {};
		for (const key of Object.keys(merged).sort()) {
			sorted[key] = merged[key];
		}
		writeFileSync(DICT_PATH, JSON.stringify(sorted, null, "\t") + "\n", "utf8");
		console.log(`   💾 词典已更新（新增 ${Object.keys(newEntries).length} 条）`);
	}

	// 6. 输出摘要报告
	const report: DeltaReport = {
		timestamp: new Date().toISOString(),
		totalCommunity: community.length,
		totalDict: dictIds.size,
		newCount: newPlugins.length,
		translated: translatedCount,
		untranslated: failedCount,
		newEntries,
		failed,
	};

	writeFileSync(REPORT_PATH, JSON.stringify(report, null, "\t") + "\n", "utf8");

	// 7. 覆盖率统计
	const coverage = ((dictIds.size + translatedCount) / community.length * 100).toFixed(2);
	console.log(`\n📈 覆盖率: ${coverage}%（${dictIds.size + translatedCount}/${community.length}）`);

	if (failed.length > 0) {
		console.log(`\n⚠️  以下 ${failed.length} 个插件未能自动翻译，需人工处理：`);
		for (const id of failed) {
			const p = community.find((x) => x.id === id);
			console.log(`   - ${id} (${p?.name ?? "?"})`);
		}
	}

	console.log("\n✅ 词典增量检测完成。");
}

main().catch((e) => {
	console.error("❌ 词典增量检测失败:", e);
	process.exit(1);
});
