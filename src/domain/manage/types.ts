/**
 * 已装插件管理（分组 / 备注 / 筛选）的领域类型与内置常量。
 *
 * 纯类型与常量，零 Obsidian 依赖，供 domain / ui / app 三层共用。
 * 放在 domain 层是为了让「分组规则 / 筛选规则」脱离 DOM 独立单测——
 * 本模块最大的风险（Obsidian 私有 DOM 结构）只应集中在 ui 层。
 */

/** 内置分组「全部」：不做分组过滤 */
export const GROUP_ALL = "all";
/** 内置分组「其他」：未分配到任何自定义分组的条目默认归属 */
export const GROUP_OTHER = "other";

/** 单个插件的管理元数据 */
export interface PluginMetaEntry {
	/** 分组 key（内置 all/other 或自定义 key） */
	group: string;
	/** 用户备注（可为空串） */
	remark: string;
}

/** 已装插件管理的持久化设置（挂在 ChinesePluginMarketSettings.manage 下） */
export interface ManageSettings {
	/** 总开关：关闭后不再增强原生设置页 */
	enabled: boolean;
	/** 分组 key → 显示名（含内置 all/other） */
	pluginGroups: Record<string, string>;
	/** 分组 key → 自定义颜色（CSS 颜色串）；缺失则用默认色 */
	pluginGroupColors: Record<string, string>;
	/** 插件 id → 管理元数据 */
	pluginMeta: Record<string, PluginMetaEntry>;
}

/** 启用状态筛选 */
export type ManageFilterStatus = "all" | "enabled" | "disabled";

/** 列表中的一行：由 ui 层从 DOM 抽取后交给 domain 计算 */
export interface ManageRow {
	id: string;
	name: string;
	author: string;
	remark: string;
	group: string;
	enabled: boolean;
}
