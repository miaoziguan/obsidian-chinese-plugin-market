/**
 * 分组管理（插件 / CSS 片段）的统一数据端口。
 *
 * 原生设置页筛选栏的「管理分组」按钮、以及本插件设置页的分组入口，
 * 都通过它打开同一个 GroupManagementModal，从而对齐参考插件的模态框交互。
 */

import type { PluginMetaEntry } from "@domain/manage/types";

/** 分组管理的作用域：插件分组 / CSS 片段分组 */
export type GroupManageType = "plugin" | "css";

/** 供模态框读写的统一分组数据端口（插件与 CSS 复用同一套 UI） */
export interface GroupManageStore {
	readonly type: GroupManageType;
	/** 当前分组表（key → 显示名） */
	getGroups(): Record<string, string>;
	/** 当前分组颜色表（key → 颜色值，无自定义色则缺省） */
	getGroupColors(): Record<string, string>;
	/** 当前元数据（id → { group, remark }） */
	getMeta(): Record<string, PluginMetaEntry>;
	/** 保存分组表与颜色（落盘 + 刷新增强页） */
	saveGroups(groups: Record<string, string>, colors: Record<string, string>): void;
	/** 更新单个条目元数据（分组 / 备注） */
	saveMeta(id: string, patch: Partial<PluginMetaEntry>): void;
	/** 整体替换元数据（删除分组后成员归位用） */
	replaceMeta(meta: Record<string, PluginMetaEntry>): void;
}
