/**
 * 分组领域的纯规则：默认值、规范化、增删改、删除后条目归位。
 *
 * 全部为不可变纯函数（返回新对象），不触碰 Obsidian 与 DOM，便于单测。
 */

import {
	GROUP_ALL,
	GROUP_OTHER,
	type ManageFilterPersist,
	type ManageSettings,
	type PluginMetaEntry,
} from "./types";

/** 内置分组的默认显示名（可被用户重命名） */
const BUILTIN_GROUP_NAMES: Record<string, string> = {
	[GROUP_ALL]: "全部",
	[GROUP_OTHER]: "其他",
};

/** 内置分组 key 集合（顺序即展示顺序：全部在前、其他在后） */
const BUILTIN_ORDER = [GROUP_ALL, GROUP_OTHER];

/** 新建默认管理设置（每次返回全新对象，避免共享 DEFAULT_SETTINGS 的引用） */
export function createDefaultManageSettings(): ManageSettings {
	return {
		enabled: true,
		pluginGroups: { ...BUILTIN_GROUP_NAMES },
		pluginGroupColors: {},
		pluginMeta: {},
		filterState: { keyword: "", group: GROUP_ALL, status: "all" },
		cssGroups: { ...BUILTIN_GROUP_NAMES },
		cssGroupColors: {},
		cssMeta: {},
		cssFilterState: { keyword: "", group: GROUP_ALL, status: "all" },
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 规范化一组（分组表 + 颜色 + 元数据），插件与 CSS 片段共用。
 * 补齐缺失字段、剔除脏数据，保证后续读写永远拿到完整形状。
 */
function normalizeSection(
	rawGroups: unknown,
	rawColors: unknown,
	rawMeta: unknown,
): {
	groups: Record<string, string>;
	colors: Record<string, string>;
	meta: Record<string, PluginMetaEntry>;
} {
	const groups: Record<string, string> = { ...BUILTIN_GROUP_NAMES };
	const rg = isRecord(rawGroups) ? rawGroups : {};
	for (const [key, value] of Object.entries(rg)) {
		if (typeof value === "string" && value.trim()) groups[key] = value;
	}
	for (const key of BUILTIN_ORDER) {
		if (!groups[key]) groups[key] = BUILTIN_GROUP_NAMES[key];
	}

	const colors: Record<string, string> = {};
	const rc = isRecord(rawColors) ? rawColors : {};
	for (const [key, value] of Object.entries(rc)) {
		if (typeof value === "string" && value.trim() && key in groups) colors[key] = value;
	}

	const meta: Record<string, PluginMetaEntry> = {};
	const rm = isRecord(rawMeta) ? rawMeta : {};
	for (const [id, entry] of Object.entries(rm)) {
		if (!isRecord(entry)) continue;
		const group =
			typeof entry.group === "string" && entry.group in groups ? entry.group : GROUP_OTHER;
		meta[id] = {
			group,
			remark: typeof entry.remark === "string" ? entry.remark : "",
		};
	}
	return { groups, colors, meta };
}

/** 规范化筛选状态（恢复现场） */
function normalizeFilter(raw: unknown, validGroups: Record<string, string>): ManageFilterPersist {
	const r = isRecord(raw) ? raw : {};
	return {
		keyword: typeof r.keyword === "string" ? r.keyword : "",
		group: typeof r.group === "string" && r.group in validGroups ? r.group : GROUP_ALL,
		status:
			r.status === "enabled" || r.status === "disabled" ? r.status : "all",
	};
}

/**
 * 规范化管理设置：补齐缺失字段、剔除脏数据。
 *
 * 老用户升级时 data.json 只有旧字段，Object.assign 浅合并会让 manage 直接
 * 引用 DEFAULT_SETTINGS 的对象（共享引用导致改动污染默认值）；且旧版数据的
 * 子字段可能缺失。插件与 CSS 片段各用一组 normalizeSection，保证两者独立且完整。
 */
export function normalizeManageSettings(raw: unknown): ManageSettings {
	const source = isRecord(raw) ? raw : {};

	const plugin = normalizeSection(
		source.pluginGroups,
		source.pluginGroupColors,
		source.pluginMeta,
	);
	const css = normalizeSection(source.cssGroups, source.cssGroupColors, source.cssMeta);

	return {
		enabled: typeof source.enabled === "boolean" ? source.enabled : true,
		pluginGroups: plugin.groups,
		pluginGroupColors: plugin.colors,
		pluginMeta: plugin.meta,
		filterState: normalizeFilter(source.filterState, plugin.groups),
		cssGroups: css.groups,
		cssGroupColors: css.colors,
		cssMeta: css.meta,
		cssFilterState: normalizeFilter(source.cssFilterState, css.groups),
	};
}

/**
 * 列出分组（全部 / 自定义 / 其他），供下拉与菜单按稳定顺序渲染。
 * 自定义分组按 key 数值升序（key 为递增序号，等价于创建顺序）。
 */
export function listGroups(
	groups: Record<string, string>,
): Array<{ key: string; name: string }> {
	const customKeys = Object.keys(groups)
		.filter((key) => !BUILTIN_ORDER.includes(key))
		.sort((a, b) => (Number(a) || 0) - (Number(b) || 0) || a.localeCompare(b));
	const ordered = [GROUP_ALL, ...customKeys, GROUP_OTHER];
	return ordered.filter((key) => key in groups).map((key) => ({ key, name: groups[key] }));
}

/** 生成下一个自定义分组 key（递增数字，避开已占用） */
export function nextGroupKey(groups: Record<string, string>): string {
	let max = 0;
	for (const key of Object.keys(groups)) {
		const n = Number(key);
		if (Number.isFinite(n) && n > max) max = n;
	}
	return String(max + 1);
}

/** 内置分组（全部 / 其他）：不可删除 */
export function isBuiltinGroup(key: string): boolean {
	return BUILTIN_ORDER.includes(key);
}

/** 新增分组；空名或重名返回 null（调用方提示用户） */
export function addGroup(
	groups: Record<string, string>,
	name: string,
): { key: string; groups: Record<string, string> } | null {
	const trimmed = name.trim();
	if (!trimmed) return null;
	if (Object.values(groups).some((existing) => existing === trimmed)) return null;
	const key = nextGroupKey(groups);
	return { key, groups: { ...groups, [key]: trimmed } };
}

/** 重命名分组（内置分组也允许改名）；空名或重名返回 null */
export function renameGroup(
	groups: Record<string, string>,
	key: string,
	name: string,
): Record<string, string> | null {
	const trimmed = name.trim();
	if (!(key in groups) || !trimmed) return null;
	if (groups[key] === trimmed) return groups;
	if (Object.values(groups).some((existing) => existing === trimmed)) return null;
	return { ...groups, [key]: trimmed };
}

/**
 * 删除分组（仅自定义分组可删，内置返回 null）。
 * 注意：只删除分组本身，成员归位由 reassignMetaGroup 单独处理——
 * 两者分离便于单测，也让调用方能先提示再落盘。
 */
export function removeGroup(
	groups: Record<string, string>,
	key: string,
): Record<string, string> | null {
	if (isBuiltinGroup(key) || !(key in groups)) return null;
	const next = { ...groups };
	delete next[key];
	return next;
}

/** 把某分组下的全部条目迁移到目标分组（删除分组时用） */
export function reassignMetaGroup(
	meta: Record<string, PluginMetaEntry>,
	fromKey: string,
	toKey: string,
): Record<string, PluginMetaEntry> {
	const next: Record<string, PluginMetaEntry> = {};
	let changed = false;
	for (const [id, entry] of Object.entries(meta)) {
		if (entry.group === fromKey) {
			next[id] = { ...entry, group: toKey };
			changed = true;
		} else {
			next[id] = entry;
		}
	}
	return changed ? next : meta;
}

/** 读取分组颜色；无自定义色则返回空串（由 UI 回落到 CSS 默认色） */
export function getGroupColor(
	colors: Record<string, string>,
	key: string,
): string {
	return colors[key] ?? "";
}

/**
 * 统计每个分组的成员数（基于插件元数据）。
 * GROUP_ALL 计总数；其余按 entry.group 累加。供设置面板分组列表展示「N 个插件」。
 * 删除分组时成员已归位「其他」，故不会出现指向已删分组的悬空计数。
 */
export function countMembersByGroup(
	meta: Record<string, PluginMetaEntry>,
): Record<string, number> {
	const counts: Record<string, number> = { [GROUP_ALL]: 0 };
	for (const entry of Object.values(meta)) {
		const key = entry.group || GROUP_OTHER;
		counts[key] = (counts[key] ?? 0) + 1;
		counts[GROUP_ALL] += 1;
	}
	return counts;
}
