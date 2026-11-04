import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { App } from "obsidian";
import { SettingsIntegrationController } from "./settings-integration-controller";
import { PluginListEnhancer } from "@ui/settings/plugin-list-enhancer";
import { SnippetListEnhancer } from "@ui/settings/snippet-list-enhancer";
import { logger } from "@shared/logger";
import type { ManageStorePort } from "@ui/settings/manage-store";
import type { CssStorePort } from "@ui/settings/snippet-manage-store";
import type { SettingsIntegrationHost } from "./settings-integration-controller";

// 依赖替身（hoisted 以便在 vi.mock 工厂内引用）：两个 enhancer 只留 3 个方法、logger 只留 warn
const h = vi.hoisted(() => {
	class FakeObserver {
		static instances: FakeObserver[] = [];
		cb: (mutations: unknown[], observer: unknown) => void;
		observe = vi.fn();
		disconnect = vi.fn();
		constructor(cb: (mutations: unknown[], observer: unknown) => void) {
			this.cb = cb;
			FakeObserver.instances.push(this);
		}
		trigger(mutations: unknown[]): void {
			this.cb(mutations, this);
		}
	}
	return {
		plugin: { enhance: vi.fn(), cleanup: vi.fn(), refreshRows: vi.fn() },
		css: { enhance: vi.fn(), cleanup: vi.fn(), refreshRows: vi.fn() },
		warn: vi.fn(),
		FakeObserver,
	};
});

vi.mock("@ui/settings/plugin-list-enhancer", () => ({
	PluginListEnhancer: vi.fn().mockImplementation(() => h.plugin),
}));
vi.mock("@ui/settings/snippet-list-enhancer", () => ({
	SnippetListEnhancer: vi.fn().mockImplementation(() => h.css),
}));
vi.mock("@shared/logger", () => ({
	logger: { warn: h.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;
let rafSpy: ReturnType<typeof vi.fn>;
let cafSpy: ReturnType<typeof vi.fn>;
const flushFrames = (): void => {
	const pending = [...frames.values()];
	frames.clear();
	for (const cb of pending) cb(0);
};

beforeEach(() => {
	vi.clearAllMocks();
	h.FakeObserver.instances.length = 0;
	frames.clear();
	nextFrameId = 1;
	rafSpy = vi.fn((cb: FrameRequestCallback) => {
		const id = nextFrameId++;
		frames.set(id, cb);
		return id;
	});
	cafSpy = vi.fn((id: number) => {
		frames.delete(id);
	});
	vi.stubGlobal("MutationObserver", h.FakeObserver);
	vi.stubGlobal("requestAnimationFrame", rafSpy);
	vi.stubGlobal("cancelAnimationFrame", cafSpy);
	(window as unknown as Record<string, unknown>).MutationObserver = h.FakeObserver;
	(window as unknown as Record<string, unknown>).requestAnimationFrame = rafSpy;
	(window as unknown as Record<string, unknown>).cancelAnimationFrame = cafSpy;
});
afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

type FakeSetting = Record<string, unknown> & { tabContentContainer: HTMLElement; activeTab?: unknown };

const makeSetting = (): FakeSetting => {
	const container = document.createElement("div");
	document.body.appendChild(container);
	return {
		tabContentContainer: container,
		activeTab: { id: "community-plugins", containerEl: container },
		onOpen: vi.fn(),
		onClose: vi.fn(),
		openTab: vi.fn(),
		openTabById: vi.fn(),
		closeActiveTab: vi.fn(),
		openPage: vi.fn(),
		closePage: vi.fn(),
		refreshCurrentPage: vi.fn(),
	};
};

const makeStore = () => ({
	settings: {
		enabled: true,
		pluginGroups: {},
		pluginGroupColors: {},
		pluginMeta: {} as Record<string, { group: string; remark: string }>,
		filterState: {},
		cssGroups: {},
		cssGroupColors: {},
		cssMeta: {} as Record<string, { group: string; remark: string }>,
		cssFilterState: {},
	},
	saveGroups: vi.fn(),
	saveMeta: vi.fn(),
	replaceMeta: vi.fn(),
	saveFilterState: vi.fn(),
	installedIds: vi.fn(() => ["a", "b"]),
});
const makeCssStore = () => ({
	listSnippets: vi.fn(() => [{ baseName: "s1" }]),
	replaceCssMeta: vi.fn(),
	refreshSnippets: vi.fn(() => Promise.resolve()),
	saveSnippetMeta: vi.fn(),
	renameSnippet: vi.fn(),
});
const makeHost = (): SettingsIntegrationHost => ({
	openPluginSettings: vi.fn(),
	openManageGroups: vi.fn(),
	requestRenameSnippet: vi.fn(),
});

type Ctx = {
	c: SettingsIntegrationController;
	setting: FakeSetting;
	store: ReturnType<typeof makeStore>;
	cssStore: ReturnType<typeof makeCssStore>;
	host: ReturnType<typeof makeHost>;
	container: HTMLElement;
};

const create = (over: { setting?: FakeSetting | null } = {}): Ctx => {
	const setting = over.setting === undefined ? makeSetting() : over.setting;
	const store = makeStore();
	const cssStore = makeCssStore();
	const host = makeHost();
	const app = { setting } as unknown as App;
	const c = new SettingsIntegrationController(
		app,
		store as unknown as ManageStorePort,
		cssStore as unknown as CssStorePort,
		host,
	);
	return { c, setting: setting ?? ({} as FakeSetting), store, cssStore, host, container: setting?.tabContentContainer ?? document.body };
};

// 直接调私有方法（bracket 访问绕过 private，仅测试用）
const priv = (c: SettingsIntegrationController, name: string, ...args: unknown[]): unknown =>
	(c as unknown as Record<string, (...a: unknown[]) => unknown>)[name](...args);

describe("start / stop 生命周期", () => {
	it("构造时把 host 回调按类型注入两个 enhancer", () => {
		const { host } = create();
		expect(PluginListEnhancer).toHaveBeenCalled();
		expect(SnippetListEnhancer).toHaveBeenCalled();
		const pOpts = vi.mocked(PluginListEnhancer).mock.calls[0][1] as { onManageGroups: () => void };
		const cOpts = vi.mocked(SnippetListEnhancer).mock.calls[0][1] as {
			onManageGroups: () => void;
			requestRenameSnippet: (b: string) => void;
		};
		pOpts.onManageGroups();
		expect(host.openManageGroups).toHaveBeenCalledWith("plugin");
		cOpts.onManageGroups();
		expect(host.openManageGroups).toHaveBeenCalledWith("css");
		cOpts.requestRenameSnippet("foo");
		expect(host.requestRenameSnippet).toHaveBeenCalledWith("foo");
	});

	it("setting 缺失 / 无 tabContentContainer → 静默放弃，不 patch 不观察", () => {
		const a = create({ setting: null });
		a.c.start();
		expect(rafSpy).not.toHaveBeenCalled();
		expect(h.FakeObserver.instances).toHaveLength(0);
		const b = create({ setting: {} as FakeSetting });
		b.c.start();
		expect(rafSpy).not.toHaveBeenCalled();
	});

	it("正常 start → patch 8 个方法 + 建 observer + 排一帧 reconcile", () => {
		const { c, setting, container } = create();
		const originalOnOpen = setting.onOpen;
		c.start();
		expect(setting.onOpen).not.toBe(originalOnOpen); // 被 wrapper 替换
		expect(h.FakeObserver.instances).toHaveLength(1);
		const obs = h.FakeObserver.instances[0];
		expect(obs.observe).toHaveBeenCalledWith(
			container,
			expect.objectContaining({ childList: true, subtree: true, attributes: true, attributeFilter: ["class"] }),
		);
		expect(rafSpy).toHaveBeenCalledTimes(1);
	});

	it("start 幂等：重复调用不再 patch / observe / 排帧", () => {
		const { c } = create();
		c.start();
		c.start();
		expect(h.FakeObserver.instances).toHaveLength(1);
		expect(rafSpy).toHaveBeenCalledTimes(1);
	});

	it("stop → disconnect / 取消帧 / 还原方法 / 两个 cleanup / 清状态", () => {
		const { c, setting } = create();
		const originalOnOpen = setting.onOpen;
		c.start();
		c.stop();
		expect(h.FakeObserver.instances[0].disconnect).toHaveBeenCalled();
		expect(cafSpy).toHaveBeenCalled();
		expect(setting.onOpen).toBe(originalOnOpen);
		expect(h.plugin.cleanup).toHaveBeenCalled();
		expect(h.css.cleanup).toHaveBeenCalled();
	});

	it("stop 后可再次 start（setting 已清空）", () => {
		const { c } = create();
		c.start();
		c.stop();
		c.start();
		expect(h.FakeObserver.instances).toHaveLength(2);
	});

	it("requestRefresh → 两个 enhancer 的 refreshRows", () => {
		const { c } = create();
		c.requestRefresh();
		expect(h.plugin.refreshRows).toHaveBeenCalled();
		expect(h.css.refreshRows).toHaveBeenCalled();
	});
});

describe("生命周期 patch / restore 精确恢复", () => {
	it("wrapper 调用原方法（正确 this）+ 触发 reconcile；非函数方法跳过", () => {
		const { c, setting } = create();
		const original = vi.fn();
		setting.onOpen = original;
		setting.onClose = "not-a-function"; // 跳过
		c.start();
		flushFrames(); // 消费 start 排的帧
		(setting.onOpen as () => unknown)();
		expect(original).toHaveBeenCalled();
		expect(rafSpy).toHaveBeenCalledTimes(2);
		expect(setting.onClose).toBe("not-a-function");
	});

	it("返回 Promise 的方法 → finally 后再排一次 reconcile", async () => {
		const { c, setting } = create();
		setting.onOpen = vi.fn(() => Promise.resolve("done"));
		c.start();
		flushFrames();
		const before = rafSpy.mock.calls.length;
		const result = (setting.onOpen as () => Promise<unknown>)();
		expect(result).toBeInstanceOf(Promise);
		flushFrames(); // 让同步排的帧执行掉，frameId 归零
		await vi.waitFor(() => expect(rafSpy.mock.calls.length).toBeGreaterThan(before + 1));
	});

	it("own property → restore 还原原值；原型链方法 → restore 删除自有属性", () => {
		const proto = { onOpen: vi.fn() };
		const setting = Object.create(proto) as FakeSetting;
		const container = document.createElement("div");
		document.body.appendChild(container);
		setting.tabContentContainer = container;
		setting.openTabById = vi.fn(); // 自有属性
		const { c } = create({ setting });
		const originalById = setting.openTabById;
		c.start();
		expect(Object.prototype.hasOwnProperty.call(setting, "onOpen")).toBe(true); // wrapper 挂上
		c.stop();
		expect(setting.openTabById).toBe(originalById);
		expect(Object.prototype.hasOwnProperty.call(setting, "onOpen")).toBe(false);
		expect(setting.onOpen).toBe(proto.onOpen);
	});

	it("外部又改写了方法 → restore 跳过该条（不覆盖外部值）", () => {
		const { c, setting } = create();
		c.start();
		const external = vi.fn();
		setting.onOpen = external;
		c.stop();
		expect(setting.onOpen).toBe(external);
	});

	it("setting 为空时 restore 直接返回", () => {
		const { c } = create();
		expect(() => priv(c, "restoreLifecycleMethods")).not.toThrow();
	});
});

describe("reconcile 分派", () => {
	it("无 setting / 容器已断开 → 两个 cleanup 并早退", () => {
		const { c, container } = create();
		priv(c, "reconcile");
		expect(h.plugin.cleanup).toHaveBeenCalled();
		expect(h.css.cleanup).toHaveBeenCalled();
		c.start(); // 仅排帧，未 flush → 不产生 cleanup
		container.remove();
		priv(c, "reconcile");
		expect(h.plugin.cleanup).toHaveBeenCalledTimes(2);
	});

	it("总开关关闭 → 只 cleanup，不增强", () => {
		const { c, store } = create();
		c.start();
		store.settings.enabled = false;
		priv(c, "reconcile");
		expect(h.plugin.cleanup).toHaveBeenCalled();
		expect(h.plugin.enhance).not.toHaveBeenCalled();
	});

	it("社区插件 Tab → plugin.enhance(root) + css.cleanup", () => {
		const { c, setting, container } = create();
		c.start();
		priv(c, "reconcile");
		expect(h.plugin.enhance).toHaveBeenCalledWith(setting.activeTab && container);
		expect(h.css.cleanup).toHaveBeenCalled();
		expect(h.css.enhance).not.toHaveBeenCalled();
	});

	it("外观 Tab → css.enhance(root) + plugin.cleanup + 异步重扫片段", () => {
		const { c, setting, container, cssStore } = create();
		setting.activeTab = { id: "appearance", containerEl: container };
		c.start();
		priv(c, "reconcile");
		expect(h.css.enhance).toHaveBeenCalledWith(container);
		expect(h.plugin.cleanup).toHaveBeenCalled();
		expect(cssStore.refreshSnippets).toHaveBeenCalledTimes(1);
	});

	it("其它 Tab → 两个 cleanup（不增强）", () => {
		const { c, setting, container } = create();
		setting.activeTab = { id: "editor", containerEl: container };
		c.start();
		priv(c, "reconcile");
		expect(h.plugin.cleanup).toHaveBeenCalled();
		expect(h.css.cleanup).toHaveBeenCalled();
		expect(h.plugin.enhance).not.toHaveBeenCalled();
		expect(h.css.enhance).not.toHaveBeenCalled();
	});

	it("无 activeTab → 回退 tabContentContainer 作 root，tabId 为 null", () => {
		const { c, setting, container } = create();
		setting.activeTab = null;
		c.start();
		priv(c, "reconcile");
		expect((c as unknown as { lastTabId: unknown }).lastTabId).toBeNull();
		expect(h.plugin.cleanup).toHaveBeenCalled();
		expect(container).toBeDefined();
	});

	it("Tab 切换 → 重置 scannedRootEl，允许外观页重新扫描", () => {
		const { c, setting, container, cssStore } = create();
		setting.activeTab = { id: "appearance", containerEl: container };
		c.start();
		priv(c, "reconcile");
		priv(c, "reconcile"); // 同 root 不重扫
		expect(cssStore.refreshSnippets).toHaveBeenCalledTimes(1);
		setting.activeTab = { id: "editor", containerEl: container };
		priv(c, "reconcile");
		setting.activeTab = { id: "appearance", containerEl: container };
		priv(c, "reconcile"); // 切走再切回 → 重新扫描
		expect(cssStore.refreshSnippets).toHaveBeenCalledTimes(2);
	});

	it("reconcile 抛错也必解锁 isReconciling（finally）", () => {
		const { c, store } = create();
		c.start();
		store.installedIds.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(() => priv(c, "reconcile")).not.toThrow(); // catch 吞掉
		expect((c as unknown as { isReconciling: boolean }).isReconciling).toBe(false);
	});
});

describe("孤儿元数据清理 scheduleOrphanedCleanup", () => {
	it("签名变化且含孤儿 → replaceMeta / replaceCssMeta", () => {
		const { c, store, cssStore } = create();
		store.settings.pluginMeta = { a: { group: "g", remark: "" }, ghost: { group: "g", remark: "" } };
		store.settings.cssMeta = { s1: { group: "g", remark: "" }, ghostCss: { group: "g", remark: "" } };
		priv(c, "scheduleOrphanedCleanup");
		expect(store.replaceMeta).toHaveBeenCalledWith({ a: { group: "g", remark: "" } });
		expect(cssStore.replaceCssMeta).toHaveBeenCalledWith({ s1: { group: "g", remark: "" } });
	});

	it("签名未变 → 不重复清理（跳过写盘）", () => {
		const { c, store, cssStore } = create();
		priv(c, "scheduleOrphanedCleanup");
		priv(c, "scheduleOrphanedCleanup");
		expect(store.replaceMeta).not.toHaveBeenCalled();
		expect(cssStore.replaceCssMeta).not.toHaveBeenCalled();
		expect(store.installedIds).toHaveBeenCalledTimes(2);
	});

	it("installedIds 抛错 → warn + 签名重置，仍能继续 CSS 侧", () => {
		const { c, store } = create();
		store.installedIds.mockImplementation(() => {
			throw new Error("x");
		});
		priv(c, "scheduleOrphanedCleanup");
		expect(h.warn).toHaveBeenCalled();
		expect((c as unknown as { cleanupSignature: string }).cleanupSignature).toBe("");
	});

	it("listSnippets 抛错 → warn + css 签名重置", () => {
		const { c, cssStore } = create();
		cssStore.listSnippets.mockImplementation(() => {
			throw new Error("x");
		});
		priv(c, "scheduleOrphanedCleanup");
		expect(h.warn).toHaveBeenCalled();
		expect((c as unknown as { cssCleanupSignature: string }).cssCleanupSignature).toBe("");
	});

	it("无孤儿（prune 返回原引用）→ 不写盘", () => {
		const { c, store } = create();
		store.settings.pluginMeta = { a: { group: "g", remark: "" } };
		priv(c, "scheduleOrphanedCleanup");
		expect(store.replaceMeta).not.toHaveBeenCalled();
	});
});

describe("异步片段扫描 ensureSnippetsScanned", () => {
	it("成功 → finally 排一次 reconcile 帧", async () => {
		const { c, container } = create();
		c.start();
		flushFrames();
		const before = rafSpy.mock.calls.length;
		priv(c, "ensureSnippetsScanned", container);
		await vi.waitFor(() => expect(rafSpy.mock.calls.length).toBe(before + 1));
	});

	it("失败 → warn + scannedRootEl 置空以便重试 + 仍排帧", async () => {
		const { c, container, cssStore } = create();
		cssStore.refreshSnippets.mockImplementation(() => Promise.reject(new Error("fail")));
		c.start();
		flushFrames();
		priv(c, "ensureSnippetsScanned", container);
		await vi.waitFor(() => expect(h.warn).toHaveBeenCalled());
		expect((c as unknown as { scannedRootEl: unknown }).scannedRootEl).toBeNull();
	});

	it("旧 generation 的回调被丢弃（不重置 scannedRootEl、不排帧）", async () => {
		let resolveScan: () => void = () => {};
		const { c, container, cssStore } = create();
		cssStore.refreshSnippets.mockImplementation(
			() => new Promise<void>((resolve) => { resolveScan = resolve; }),
		);
		c.start();
		flushFrames();
		priv(c, "ensureSnippetsScanned", container);
		(c as unknown as { scanGeneration: number }).scanGeneration += 1; // 模拟切页/stop
		const before = rafSpy.mock.calls.length;
		resolveScan();
		await Promise.resolve();
		await Promise.resolve();
		expect(rafSpy.mock.calls.length).toBe(before);
	});

	it("同一 rootEl 第二次调用直接返回（防自激重扫）", () => {
		const { c, container, cssStore } = create();
		c.start();
		priv(c, "ensureSnippetsScanned", container);
		priv(c, "ensureSnippetsScanned", container);
		expect(cssStore.refreshSnippets).toHaveBeenCalledTimes(1);
	});
});

describe("rAF 调度与 getView", () => {
	it("scheduleReconcile：无 setting → 不排帧", () => {
		const { c } = create();
		priv(c, "scheduleReconcile");
		expect(rafSpy).not.toHaveBeenCalled();
	});

	it("scheduleReconcile：已有 pending 帧 → 不重复排", () => {
		const { c } = create();
		c.start();
		priv(c, "scheduleReconcile");
		expect(rafSpy).toHaveBeenCalledTimes(1);
	});

	it("帧回调执行后 frameId 清零并触发 reconcile", () => {
		const { c } = create();
		c.start();
		flushFrames();
		expect((c as unknown as { frameId: number | null }).frameId).toBeNull();
		expect(h.plugin.enhance).toHaveBeenCalled();
	});

	it("cancelScheduledReconcile：无帧直接返回；有帧调用 window.cancelAnimationFrame", () => {
		const { c } = create();
		priv(c, "cancelScheduledReconcile");
		expect(cafSpy).not.toHaveBeenCalled();
		c.start();
		priv(c, "cancelScheduledReconcile");
		expect(cafSpy).toHaveBeenCalledTimes(1);
		expect((c as unknown as { frameId: number | null }).frameId).toBeNull();
	});

	it("getView：root 为空 / ownerDocument 无 defaultView → null；正常元素 → window", () => {
		const { c, container } = create();
		expect(priv(c, "getView", undefined)).toBeNull();
		const orphan = { ownerDocument: {} } as unknown as HTMLElement;
		expect(priv(c, "getView", orphan)).toBeNull();
		expect(priv(c, "getView", container)).toBe(window);
	});

	it("独立窗口 rAF：view 自带 rAF 时用它，否则回退 window", () => {
		const { c, container } = create();
		const customRaf = vi.fn((cb: FrameRequestCallback) => { cb(0); return 42; });
		Object.defineProperty(container, "ownerDocument", {
			value: { defaultView: { requestAnimationFrame: customRaf, cancelAnimationFrame: vi.fn() } },
			configurable: true,
		});
		c.start();
		expect(customRaf).toHaveBeenCalled();
	});
});

describe("MutationObserver 与自激过滤", () => {
	it("observe 回退到全局 MutationObserver（view.MutationObserver 缺失）", () => {
		const setting = makeSetting();
		Object.defineProperty(setting.tabContentContainer, "ownerDocument", {
			value: { defaultView: {} },
			configurable: true,
		});
		const { c } = create({ setting });
		c.start();
		expect(h.FakeObserver.instances).toHaveLength(1);
	});

	it("container 为空 → observe 直接返回", () => {
		const { c } = create();
		expect(() => priv(c, "observe", {})).not.toThrow();
		expect(h.FakeObserver.instances).toHaveLength(0);
	});

	it("observer 收到需重建的 mutation → 排一帧", () => {
		const { c } = create();
		c.start();
		flushFrames();
		const obs = h.FakeObserver.instances[0];
		obs.trigger([{ type: "childList", target: document.createElement("div"), addedNodes: [document.createElement("div")], removedNodes: [] }]);
		expect(rafSpy).toHaveBeenCalledTimes(2);
	});

	it("observer 收到被过滤的 mutation → 不排帧", () => {
		const { c } = create();
		c.start();
		flushFrames();
		const owned = document.createElement("div");
		owned.setAttribute("data-cpm-owned", "");
		const obs = h.FakeObserver.instances[0];
		obs.trigger([{ type: "childList", target: owned, addedNodes: [owned], removedNodes: [] }]);
		expect(rafSpy).toHaveBeenCalledTimes(1);
	});

	it("isReconciling 期间一律忽略", () => {
		const { c } = create();
		(c as unknown as { isReconciling: boolean }).isReconciling = true;
		expect(priv(c, "shouldReconcileMutation", { type: "childList", target: document.createElement("div"), addedNodes: [], removedNodes: [] })).toBe(false);
	});

	it("target 在 [data-cpm-owned] 内 → 忽略", () => {
		const { c } = create();
		const parent = document.createElement("div");
		parent.setAttribute("data-cpm-owned", "");
		const child = document.createElement("span");
		parent.appendChild(child);
		expect(priv(c, "shouldReconcileMutation", { type: "childList", target: child, addedNodes: [], removedNodes: [] })).toBe(false);
	});

	it("文本节点 target → 取 parentElement 判定", () => {
		const { c } = create();
		const parent = document.createElement("div");
		parent.setAttribute("data-cpm-owned", "");
		parent.appendChild(document.createTextNode("x"));
		expect(priv(c, "shouldReconcileMutation", { type: "characterData", target: parent.firstChild })).toBe(false);
	});

	it("attributes：仅 cpm-filtered-out class 变化 → 不重建", () => {
		const { c } = create();
		const el = document.createElement("div");
		el.className = "foo cpm-filtered-out";
		expect(priv(c, "shouldReconcileMutation", { type: "attributes", target: el, oldValue: "foo" })).toBe(false);
	});

	it("attributes：其它 class 变化 → 重建", () => {
		const { c } = create();
		const el = document.createElement("div");
		el.className = "foo bar";
		expect(priv(c, "shouldReconcileMutation", { type: "attributes", target: el, oldValue: "foo" })).toBe(true);
	});

	it("childList：removedNodes 含 owned 元素 → 立即重建", () => {
		const { c } = create();
		const owned = document.createElement("div");
		owned.setAttribute("data-cpm-owned", "");
		expect(priv(c, "shouldReconcileMutation", { type: "childList", target: document.createElement("div"), addedNodes: [], removedNodes: [owned] })).toBe(true);
	});

	it("childList：added 全部属于 owned → 忽略；混入非 owned → 重建", () => {
		const { c } = create();
		const owned = document.createElement("div");
		owned.setAttribute("data-cpm-owned", "");
		const plain = document.createElement("div");
		const target = document.createElement("div");
		expect(priv(c, "shouldReconcileMutation", { type: "childList", target, addedNodes: [owned], removedNodes: [] })).toBe(false);
		expect(priv(c, "shouldReconcileMutation", { type: "childList", target, addedNodes: [owned, plain], removedNodes: [] })).toBe(true);
	});

	it("childList：文本节点被过滤、无元素变更 → 仍重建", () => {
		const { c } = create();
		const target = document.createElement("div");
		expect(priv(c, "shouldReconcileMutation", { type: "childList", target, addedNodes: [document.createTextNode("x")], removedNodes: [] })).toBe(true);
	});

	it("其它 mutation 类型 → 重建", () => {
		const { c } = create();
		expect(priv(c, "shouldReconcileMutation", { type: "characterData", target: document.createElement("div") })).toBe(true);
	});

	it("onlyFilterVisibilityChanged：oldValue 为 null 时按空串比较", () => {
		const { c } = create();
		const el = document.createElement("div");
		expect(priv(c, "onlyFilterVisibilityChanged", el, null)).toBe(true);
		el.className = "foo";
		expect(priv(c, "onlyFilterVisibilityChanged", el, null)).toBe(false);
	});
});

describe("logger mock 生效", () => {
	it("warn 走注入的替身而非 console", () => {
		expect(logger.warn).toBe(h.warn);
	});
});
