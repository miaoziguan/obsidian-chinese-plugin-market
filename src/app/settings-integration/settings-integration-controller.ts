/**
 * 设置页增强控制器：patch 设置面板生命周期 + MutationObserver 驱动重建。
 *
 * 为什么必须 patch 生命周期：Obsidian 的设置页会在切 Tab / 刷新 / 开关插件时
 * 整块重绘 DOM，仅靠一次性增强会在重绘后全部丢失。这里包裹 app.setting 的
 * 生命周期方法，配合观察容器变更，在每次重绘后重新增强。
 *
 * 三条关键纪律（参考实现教训）：
 * 1. 防自激：Observer 会监听到我们自己的注入，必须过滤掉 data-cpm-owned 内部
 *    的变更与 filtered-out class 变化，否则无限 reconcile。
 * 2. 精确恢复：记录每个方法 patch 前是否 own property，卸载时该删的删、
 *    该还原的还原，否则热重载后 wrapper 层层叠加。
 * 3. 全程容错：任何私有 API 取不到就静默放弃增强，绝不影响原生设置页。
 *
 * 同时增强两个原生页：
 * - 社区插件页（community-plugins）→ 插件分组 / 备注 / 筛选
 * - 外观页（appearance）→ CSS 片段分组 / 备注 / 筛选
 */

import type { App } from "obsidian";
import { asAppInternals } from "@data/platform/obsidian-internals";
import { PluginListEnhancer } from "@ui/settings/plugin-list-enhancer";
import { SnippetListEnhancer } from "@ui/settings/snippet-list-enhancer";
import type { ManageStorePort } from "@ui/settings/manage-store";
import type { CssStorePort } from "@ui/settings/snippet-manage-store";
import type { GroupManageType } from "@ui/settings/group-manage-store";
import { pruneOrphanedMeta } from "@domain/manage/plugin-meta";
import { logger } from "@shared/logger";

/** 原生「社区插件」设置页的 Tab id */
const COMMUNITY_PLUGINS_TAB_ID = "community-plugins";
/** 原生「外观」设置页的 Tab id（CSS 片段在此） */
const APPEARANCE_TAB_ID = "appearance";
/** 本插件注入元素的归属标记（防自激用） */
const OWNED_ELEMENT_SELECTOR = "[data-cpm-owned]";
/** 筛选隐藏用的 class（其变化不应触发重建） */
const FILTERED_OUT_CLASS = "cpm-filtered-out";

const LIFECYCLE_METHODS = [
	"onOpen",
	"onClose",
	"openTab",
	"openTabById",
	"closeActiveTab",
	"openPage",
	"closePage",
	"refreshCurrentPage",
] as const;

type LifecycleMethod = (typeof LIFECYCLE_METHODS)[number];

interface PatchedMethod {
	name: LifecycleMethod;
	hadOwnProperty: boolean;
	value: unknown;
	wrapper: (...args: unknown[]) => unknown;
}

export interface SettingsIntegrationHost {
	/** 打开本插件设置面板（兼容旧式落点） */
	openPluginSettings: () => void;
	/** 弹窗管理分组（插件 / CSS 片段，对齐参考插件的模态框交互） */
	openManageGroups: (type: GroupManageType) => void;
	/** 请求重命名 CSS 片段（由宿主弹窗并调用 store.renameSnippet） */
	requestRenameSnippet: (baseName: string) => void;
}

export class SettingsIntegrationController {
	private readonly enhancer: PluginListEnhancer;
	private readonly cssEnhancer: SnippetListEnhancer;
	private setting: ReturnType<typeof asAppInternals>["setting"] = undefined;
	private observer: MutationObserver | null = null;
	private frameId: number | null = null;
	private patchedMethods: PatchedMethod[] = [];
	private cleanupSignature = "";
	private cssCleanupSignature = "";
	/** 上次命中的 Tab id：用于识别「重新进入外观页」，触发片段名单重扫 */
	private lastTabId: string | null = null;
	/** 已对该外观页根元素扫过一次片段（防止 reconcile 自激无限重扫） */
	private scannedRootEl: HTMLElement | null = null;

	constructor(
		private readonly app: App,
		private readonly store: ManageStorePort,
		private readonly cssStore: CssStorePort,
		private readonly host: SettingsIntegrationHost,
	) {
		this.enhancer = new PluginListEnhancer(store, {
			onManageGroups: () => this.host.openManageGroups("plugin"),
		});
		this.cssEnhancer = new SnippetListEnhancer(cssStore, {
			onManageGroups: () => this.host.openManageGroups("css"),
			requestRenameSnippet: (baseName) => this.host.requestRenameSnippet(baseName),
		});
	}

	start(): void {
		if (this.setting) return;
		const setting = asAppInternals(this.app).setting;
		if (!setting?.tabContentContainer) return;

		this.setting = setting;
		this.patchLifecycleMethods(setting);
		this.observe(setting);
		this.scheduleReconcile();
	}

	stop(): void {
		this.observer?.disconnect();
		this.observer = null;
		this.cancelScheduledReconcile();
		this.restoreLifecycleMethods();
		this.enhancer.cleanup();
		this.cssEnhancer.cleanup();
		this.cleanupSignature = "";
		this.cssCleanupSignature = "";
		this.setting = undefined;
	}

	/** 分组数据被外部修改后，请求重画（设置面板改分组时用） */
	requestRefresh(): void {
		this.enhancer.refreshRows();
		this.cssEnhancer.refreshRows();
	}

	// ── 重建 ──

	private reconcile(): void {
		const setting = this.setting;
		if (!setting || !setting.tabContentContainer?.isConnected) {
			this.enhancer.cleanup();
			this.cssEnhancer.cleanup();
			return;
		}

		if (!this.store.settings.enabled) {
			this.enhancer.cleanup();
			this.cssEnhancer.cleanup();
			return;
		}

		this.scheduleOrphanedCleanup();

		const activeTab = setting.activeTab;
		const rootEl = activeTab?.containerEl ?? setting.tabContentContainer;
		if (!rootEl) return;

		const tabId = activeTab?.id ?? null;
		if (tabId !== this.lastTabId) {
			this.lastTabId = tabId;
			// 切走再切回属于新的一次打开，允许重新扫描片段名单
			this.scannedRootEl = null;
		}

		if (tabId === COMMUNITY_PLUGINS_TAB_ID) {
			this.enhancer.enhance(rootEl);
			this.cssEnhancer.cleanup();
			return;
		}
		if (tabId === APPEARANCE_TAB_ID) {
			this.cssEnhancer.enhance(rootEl);
			this.enhancer.cleanup();
			this.ensureSnippetsScanned(rootEl);
			return;
		}
		this.enhancer.cleanup();
		this.cssEnhancer.cleanup();
	}

	/**
	 * 首次渲染外观页时异步重扫片段名单，扫完再排一次 reconcile。
	 *
	 * 片段文件在配置目录里，只能异步枚举；先渲染旧快照（可能为空）再刷新，
	 * 避免「原生显示 N 个、本插件显示 0 个」。每个 Tab 切换周期只扫一次，
	 * 防止 reconcile 自激。
	 */
	private ensureSnippetsScanned(rootEl: HTMLElement): void {
		if (this.scannedRootEl === rootEl) return;
		this.scannedRootEl = rootEl;
		void this.cssStore
			.refreshSnippets()
			.catch((error) => {
				this.scannedRootEl = null;
				logger.warn("[Chinese Plugin Market] 重扫 CSS 片段失败:", error);
			})
			.finally(() => this.scheduleReconcile());
	}

	private scheduleReconcile(): void {
		const setting = this.setting;
		if (!setting || this.frameId !== null) return;
		this.frameId = window.requestAnimationFrame(() => {
			this.frameId = null;
			this.reconcile();
		});
	}

	private cancelScheduledReconcile(): void {
		if (this.frameId === null) return;
		window.cancelAnimationFrame(this.frameId);
		this.frameId = null;
	}

	// ── 观察 ──

	private observe(setting: NonNullable<typeof this.setting>): void {
		const container = setting.tabContentContainer;
		if (!container) return;
		this.observer = new MutationObserver((mutations) => {
			if (mutations.some((mutation) => this.shouldReconcileMutation(mutation))) {
				this.scheduleReconcile();
			}
		});
		this.observer.observe(container, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["class"],
			attributeOldValue: true,
		});
	}

	private shouldReconcileMutation(mutation: MutationRecord): boolean {
		const targetEl =
			mutation.target.nodeType === Node.ELEMENT_NODE
				? (mutation.target as Element)
				: mutation.target.parentElement;
		if (targetEl?.closest(OWNED_ELEMENT_SELECTOR)) return false;

		if (mutation.type === "attributes" && targetEl) {
			return !this.onlyFilterVisibilityChanged(targetEl, mutation.oldValue);
		}

		if (mutation.type === "childList") {
			const removed = Array.from(mutation.removedNodes).filter(
				(node) => node.nodeType === Node.ELEMENT_NODE,
			) as Element[];
			if (removed.some((el) => el.matches(OWNED_ELEMENT_SELECTOR))) return true;

			const added = Array.from(mutation.addedNodes).filter(
				(node) => node.nodeType === Node.ELEMENT_NODE,
			) as Element[];
			if (added.length > 0 && added.every((el) => el.closest(OWNED_ELEMENT_SELECTOR))) {
				return false;
			}
		}

		return true;
	}

	private onlyFilterVisibilityChanged(targetEl: Element, oldValue: string | null): boolean {
		const oldClasses = (oldValue ?? "")
			.split(/\s+/)
			.filter((cls) => cls && cls !== FILTERED_OUT_CLASS)
			.sort();
		const currentClasses = Array.from(targetEl.classList)
			.filter((cls) => cls !== FILTERED_OUT_CLASS)
			.sort();
		return oldClasses.join(" ") === currentClasses.join(" ");
	}

	// ── 生命周期 patch ──

	private patchLifecycleMethods(setting: NonNullable<typeof this.setting>): void {
		const target = setting as unknown as Record<string, unknown>;
		for (const name of LIFECYCLE_METHODS) {
			const original = target[name];
			if (typeof original !== "function") continue;

			const wrapper = (...args: unknown[]): unknown => {
				const result = original.apply(setting, args) as unknown;
				this.scheduleReconcile();
				if (result && typeof (result as PromiseLike<unknown>).then === "function") {
					void Promise.resolve(result).finally(() => this.scheduleReconcile());
				}
				return result;
			};

			this.patchedMethods.push({
				name,
				hadOwnProperty: Object.prototype.hasOwnProperty.call(target, name),
				value: target[name],
				wrapper,
			});
			target[name] = wrapper;
		}
	}

	private restoreLifecycleMethods(): void {
		const setting = this.setting;
		if (!setting) return;
		const target = setting as unknown as Record<string, unknown>;
		for (const patched of this.patchedMethods) {
			if (target[patched.name] !== patched.wrapper) continue;
			if (patched.hadOwnProperty) target[patched.name] = patched.value;
			else delete target[patched.name];
		}
		this.patchedMethods = [];
	}

	// ── 孤儿元数据清理 ──

	/** 已安装插件 / CSS 片段集合变化时才清理，避免每次重建都写盘 */
	private scheduleOrphanedCleanup(): void {
		// 插件元数据
		try {
			const ids = this.store.installedIds();
			const signature = [...ids].sort().join("|");
			if (signature !== this.cleanupSignature) {
				this.cleanupSignature = signature;
				const next = pruneOrphanedMeta(this.store.settings.pluginMeta, ids);
				if (next !== this.store.settings.pluginMeta) this.store.replaceMeta(next);
			}
		} catch (error) {
			this.cleanupSignature = "";
			logger.warn("[Chinese Plugin Market] 清理失效的插件管理元数据失败:", error);
		}

		// CSS 片段元数据
		try {
			const cssIds = this.cssStore.listSnippets().map((s) => s.baseName);
			const cssSignature = [...cssIds].sort().join("|");
			if (cssSignature !== this.cssCleanupSignature) {
				this.cssCleanupSignature = cssSignature;
				const next = pruneOrphanedMeta(this.store.settings.cssMeta, cssIds);
				if (next !== this.store.settings.cssMeta) this.cssStore.replaceCssMeta(next);
			}
		} catch (error) {
			this.cssCleanupSignature = "";
			logger.warn("[Chinese Plugin Market] 清理失效的 CSS 片段元数据失败:", error);
		}
	}
}
