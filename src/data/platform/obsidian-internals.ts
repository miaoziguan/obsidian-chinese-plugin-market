/**
 * Obsidian 内部 API 最小类型声明（I1：替代裸 `as any` 访问半官方接口）。
 *
 * Obsidian 的 `app.plugins` / `app.setting` 属于半官方运行时 API，
 * 官方 `obsidian` 包未导出类型。此前各处以 `(app as any)` 绕过，导致内部 API
 * 变更时编译期无法发现断裂。此处集中声明其最小形状，调用点改用
 * `(app as AppInternals)`，既保留容错（字段 optional + 调用方 try/catch），
 * 又获得最小类型保护。
 *
 * 若 Obsidian 未来调整这些内部字段，只需在此一处更新形状。
 */

/** 已安装插件仓库（app.plugins）的最小可读形状 */
export interface AppPlugins {
	manifests?: Record<string, unknown>;
	enabledPlugins?: {
		has?: (pluginId: string) => boolean;
		forEach?: (cb: (id: string) => void) => void;
	};
}

/** 设置面板（app.setting）的最小可读形状 */
export interface AppSetting {
	openTabById?: (pluginId: string) => unknown;
	open?: () => unknown;
}

/** App 的内部扩展形状（叠加在官方 App 之上） */
export interface AppInternals {
	plugins?: AppPlugins;
	setting?: AppSetting;
}

/** 将官方 App 断言为带内部字段的形状（替代 `as any`） */
export function asAppInternals(app: unknown): AppInternals {
	return app as AppInternals;
}
