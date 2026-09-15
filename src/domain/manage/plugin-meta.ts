/**
 * 插件元数据（分组 / 备注）的读写与清理规则（纯函数，不可变）。
 */

import { GROUP_OTHER, type PluginMetaEntry } from "./types";

/** 读取元数据；未登记则返回「其他 + 空备注」 */
export function getMeta(
	meta: Record<string, PluginMetaEntry>,
	id: string,
): PluginMetaEntry {
	const entry = meta[id];
	if (!entry) return { group: GROUP_OTHER, remark: "" };
	return {
		group: entry.group || GROUP_OTHER,
		remark: typeof entry.remark === "string" ? entry.remark : "",
	};
}

/** 写入元数据（部分更新），返回新的 meta 对象 */
export function setMeta(
	meta: Record<string, PluginMetaEntry>,
	id: string,
	patch: Partial<PluginMetaEntry>,
): Record<string, PluginMetaEntry> {
	const current = getMeta(meta, id);
	return {
		...meta,
		[id]: {
			group: patch.group ?? current.group,
			remark: patch.remark ?? current.remark,
		},
	};
}

/**
 * 清理已卸载插件的元数据（避免 data.json 无限膨胀）。
 * 无变化时返回原引用，便于调用方跳过写盘。
 */
export function pruneOrphanedMeta(
	meta: Record<string, PluginMetaEntry>,
	validIds: Iterable<string>,
): Record<string, PluginMetaEntry> {
	const valid = validIds instanceof Set ? validIds : new Set(validIds);
	let changed = false;
	const next: Record<string, PluginMetaEntry> = {};
	for (const [id, entry] of Object.entries(meta)) {
		if (valid.has(id)) next[id] = entry;
		else changed = true;
	}
	return changed ? next : meta;
}
