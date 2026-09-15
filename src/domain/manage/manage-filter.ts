/**
 * 筛选与匹配规则（纯函数）。
 *
 * 与页面 DOM 解耦：ui 层把每行抽成 ManageRow 后交给这里计算，
 * 使「搜索语法 / 状态过滤 / 分组计数」可脱离 Obsidian 单测。
 */

import { GROUP_ALL, type ManageFilterStatus, type ManageRow } from "./types";

/** 特殊搜索语法：查找所有未填备注的条目 */
export const NO_REMARK_QUERY = "???";

export interface ManageFilterState {
	keyword: string;
	group: string;
	status: ManageFilterStatus;
}

/** 关键词匹配：名称 / 作者 / 备注，大小写不敏感 */
export function matchesKeyword(row: ManageRow, keyword: string): boolean {
	const q = keyword.trim().toLowerCase();
	if (!q) return true;
	// 特殊语法：找未填备注的条目
	if (q === NO_REMARK_QUERY) return row.remark.trim() === "";
	return (
		row.name.toLowerCase().includes(q) ||
		row.author.toLowerCase().includes(q) ||
		row.remark.toLowerCase().includes(q)
	);
}

/** 单行是否满足当前筛选（关键词 + 分组 + 启用状态） */
export function matchesFilter(row: ManageRow, state: ManageFilterState): boolean {
	if (!matchesKeyword(row, state.keyword)) return false;
	if (state.group !== GROUP_ALL && row.group !== state.group) return false;
	if (state.status === "enabled" && !row.enabled) return false;
	if (state.status === "disabled" && row.enabled) return false;
	return true;
}

/** 状态筛选是否命中（分组计数时单独使用） */
export function matchesStatus(row: ManageRow, status: ManageFilterStatus): boolean {
	if (status === "enabled") return row.enabled;
	if (status === "disabled") return !row.enabled;
	return true;
}

/**
 * 在当前「关键词 + 状态」条件下统计各分组命中数。
 * 刻意忽略分组筛选本身——否则选中某分组后其它分组计数全归零，计数失去意义。
 */
export function countByGroup(
	rows: ManageRow[],
	state: ManageFilterState,
): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const row of rows) {
		if (!matchesKeyword(row, state.keyword)) continue;
		if (!matchesStatus(row, state.status)) continue;
		counts[GROUP_ALL] = (counts[GROUP_ALL] ?? 0) + 1;
		counts[row.group] = (counts[row.group] ?? 0) + 1;
	}
	return counts;
}
