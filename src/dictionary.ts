/**
 * 离线翻译词典
 *
 * 插件级精确翻译统一由「翻译记忆库」已采纳层（tmApproved，源于 vault 笔记）提供，
 * 原随插件分发的批量词典（obsidian-translator-full-dict.json，5617 条）已沉淀为 vault 笔记后弃用。
 */

export interface DictEntry {
	name: string;
	description?: string;
	author?: string;
}

export interface ParsedDictionary {
	/** 校验通过、name 非空的词条（已 trim） */
	dict: Record<string, DictEntry>;
	/** 被忽略的无效条目数（name 为空 / 非对象 / 空 id） */
	invalid: number;
}

/**
 * 解析词典 JSON 文本（产品改进 #13 复用，亦用于本地批量导入）。
 * 格式：{ "插件ID": { "name": "中文名", "description?": "…" } }。
 * - 顶层非法 JSON / 非对象 → 抛错（含中文可读信息）。
 * - 单条 name 为空、非对象、id 为空 → 忽略并计入 invalid（不阻断其余）。
 * - name / description 自动 trim；空 description 规范为 undefined。
 */
export function parseDictionaryText(text: string): ParsedDictionary {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("解析失败：不是合法的 JSON");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("格式错误：顶层应为对象 { 插件ID: { name, description } }");
	}

	const obj = parsed as Record<string, unknown>;
	const dict: Record<string, DictEntry> = {};
	let invalid = 0;
	for (const [pid, val] of Object.entries(obj)) {
		if (!pid || typeof val !== "object" || val === null) {
			invalid++;
			continue;
		}
		const entry = val as Record<string, unknown>;
		const name = typeof entry.name === "string" ? entry.name.trim() : "";
		if (!name) {
			invalid++;
			continue;
		}
		dict[pid] = {
			name,
			description:
				typeof entry.description === "string"
					? entry.description.trim() || undefined
					: undefined,
		};
	}
	return { dict, invalid };
}

/**
 * 词典覆盖率统计（产品迭代 #3）。
 *
 * 计算「当前已采纳译名（TM 已采纳层）能命中多少社区插件」，用于质量看板展示资产厚度。
 * 一个插件视为「已覆盖」当且仅当它的 id 存在于已采纳词典（approvedDict）中
 * 且对应 name 非空（即开箱即用的中文译名，原批量词典已沉淀为 vault 笔记），
 * 或已被翻译缓存命中（cache，用户/在线补译）。
 *
 * @param totalPluginIds 全量社区插件 id 集合（来自 community-plugins.json）
 * @param approvedDict   已采纳词典（id → DictEntry，源于 vault 沉淀的 TM approved）
 * @param cache          翻译缓存（id → TranslateResult，source 非 original 即视为已译）
 * @returns 覆盖率统计：总数 / 已覆盖数 / 覆盖率(0~1) / 已采纳命中数 / 缓存补译命中数
 */
export interface CoverageStat {
	total: number;
	covered: number;
	coverage: number; // 0~1
	bulkHits: number;
	cacheHits: number;
}

export function computeCoverage(
	totalPluginIds: Set<string>,
	approvedDict: Record<string, DictEntry>,
	cache: Record<string, { source: string }>
): CoverageStat {
	let bulkHits = 0;
	let cacheHits = 0;
	const coveredIds = new Set<string>();

	for (const id of totalPluginIds) {
		const entry = approvedDict[id];
		if (entry && entry.name && entry.name.trim()) {
			coveredIds.add(id);
			bulkHits++;
			continue;
		}
		const c = cache[id];
		if (c && c.source && c.source !== "original") {
			coveredIds.add(id);
			cacheHits++;
		}
	}

	const total = totalPluginIds.size;
	const covered = coveredIds.size;
	return {
		total,
		covered,
		coverage: total > 0 ? covered / total : 0,
		bulkHits,
		cacheHits,
	};
}
