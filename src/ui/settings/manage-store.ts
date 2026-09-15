/**
 * 已装插件管理模块的数据端口。
 *
 * 定义在 ui 层、由 app 层实现并注入（依赖倒置），使 ui 无需反向依赖 app。
 * 落盘由实现方自行 fire-and-forget，接口保持同步，简化调用方。
 */

import type { ManageSettings, PluginMetaEntry } from "@domain/manage/types";

export interface ManageStorePort {
	/** 当前管理设置快照（只读） */
	readonly settings: ManageSettings;
	/** 保存分组表（名称 + 颜色） */
	saveGroups(
		groups: Record<string, string>,
		colors: Record<string, string>,
	): void;
	/** 更新单个插件的元数据（分组 / 备注） */
	saveMeta(id: string, patch: Partial<PluginMetaEntry>): void;
	/** 整体替换元数据（孤儿清理用） */
	replaceMeta(meta: Record<string, PluginMetaEntry>): void;
	/** 当前已安装插件 id 列表（孤儿清理用） */
	installedIds(): string[];
}
