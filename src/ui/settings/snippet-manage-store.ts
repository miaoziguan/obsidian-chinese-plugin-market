/**
 * CSS 片段管理模块的数据端口。
 *
 * 与插件管理对称（参考 PluginListEnhancer 的 ManageStorePort），但数据源是
 * `.obsidian/snippets/*.css` + app.customCss。落盘由实现方 fire-and-forget。
 */

import type {
	ManageFilterPersist,
	ManageSettings,
	PluginMetaEntry,
} from "@domain/manage/types";
import type { SnippetInfo } from "@data/platform/snippet";

/** 打开 CSS 分组设置面板的宿主能力（由 app 层注入） */
export interface CssEnhancerHost {
	onManageGroups: () => void;
}

export interface CssStorePort {
	/** 当前管理设置快照（只读） */
	readonly settings: ManageSettings;
	/** 保存 CSS 分组表（名称 + 颜色） */
	saveCssGroups(
		groups: Record<string, string>,
		colors: Record<string, string>,
	): void;
	/** 更新单个片段的元数据（分组 / 备注） */
	saveCssMeta(id: string, patch: Partial<PluginMetaEntry>): void;
	/** 保存 CSS 筛选状态（恢复现场） */
	saveCssFilterState(state: ManageFilterPersist): void;
	/** 列出全部 CSS 片段（含启用状态），用于精确识别外观页行 */
	listSnippets(): SnippetInfo[];
	/** 切换片段启用状态 */
	setSnippetEnabled(baseName: string, enabled: boolean): Promise<void>;
	/** 重命名片段文件（同步启用状态与元数据 key） */
	renameSnippet(oldBase: string, newBase: string): Promise<void>;
	/** 用系统默认应用打开片段源文件 */
	openSnippet(path: string): void;
	/** 整体替换 CSS 元数据（孤儿清理用） */
	replaceCssMeta(meta: Record<string, PluginMetaEntry>): void;
}
