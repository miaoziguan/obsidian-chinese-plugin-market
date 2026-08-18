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

/**
 * 插件 manifest 的最小形状（对齐 Obsidian PluginManifest）。
 * enablePlugin / loadPlugin 官方签名接受该 manifest 对象而非纯 id。
 */
export interface PluginManifestLike {
	id: string;
	version?: string;
	[name: string]: unknown;
}

/** 已安装插件仓库（app.plugins）的最小可读形状 */
export interface AppPlugins {
	/** 已安装插件 manifest 映射（id → manifest） */
	manifests?: Record<string, PluginManifestLike>;
	enabledPlugins?: {
		has?: (pluginId: string) => boolean;
		forEach?: (cb: (id: string) => void) => void;
	};
	/** 重新扫描 plugins 目录并刷新 manifests（半官方 API，可选） */
	loadManifests?: () => Promise<void>;
	/**
	 * 加载单个插件。官方签名为 loadPlugin(plugin: PluginManifest)，
	 * 个别旧版可能接受 id 字符串；调用方应绑定 this=app.plugins。
	 */
	loadPlugin?: (arg: PluginManifestLike | string) => Promise<void>;
	/**
	 * 启用单个插件。官方签名为 enablePlugin(plugin: PluginManifest)，
	 * 内部会自行调用 loadPlugin；个别旧版可能接受 id 字符串。
	 * 调用方务必用 .bind(plugins) 绑定 this，否则内部 this.app 为 undefined。
	 */
	enablePlugin?: (arg: PluginManifestLike | string) => Promise<void>;
	/** 禁用单个插件（半官方 API，可选） */
	disablePlugin?: (arg: PluginManifestLike | string) => Promise<void>;
	/**
	 * 启用单个插件并落盘保存（半官方 API，chinabrat/BRAT 使用）。
	 * 与 enablePlugin 区别：会写 community-plugins.json，重启后仍生效。
	 */
	enablePluginAndSave?: (arg: PluginManifestLike | string) => Promise<void>;
	/**
	 * 禁用单个插件并落盘保存（半官方 API，plugin-manager 等使用）。
	 * 与 disablePlugin 区别：会从 community-plugins.json 移除，重启后保持禁用。
	 */
	disablePluginAndSave?: (arg: PluginManifestLike | string) => Promise<void>;
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
