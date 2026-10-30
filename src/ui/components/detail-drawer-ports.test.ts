import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PluginDetailDrawer, type DrawerOptions } from "./detail-drawer";
import type { PluginInfo } from "@domain/catalog/translator";
import { openVersionPicker } from "@ui/components/version-picker-modal";
import { renderJournalEditor } from "@ui/components/journal-editor";

/**
 * 两个「可选宿主端口」：版本固定（versionControl，1020-1048）与评测编辑区
 * （journalEnabled，1311-1373）。
 *
 * 共同特征：都是「宿主没提供端口就整段不渲染」的能力，所以从没被任何测试跑到；
 * 而一旦渲染条件判断写错，用户表现为「明明装了却看不到版本按钮」或
 * 「评测区永远不出现」，且完全不报错——典型的静默退化。
 *
 * 版本固定：条件为「已安装 && 有仓库 && 宿主提供 versionControl 端口」三者缺一不可，
 * 按钮点击后 openVersionPicker 的参数必须正确透传 app/仓库/已固定版本/已安装版本，
 * 并且 listVersions / onPick 必须委托回宿主端口（onPick 后还要触发重建）。
 * 评测编辑区：journalEnabled 为真才建 slot，editor 由 loadJournalEntry 读盘（异步）
 * 完成后注入——异步窗口期抽屉可能已关闭，必须靠二次守卫丢弃这次注入。
 *
 * 脚手架沿用 detail-drawer-build.test.ts：本地补 HTMLElement 原型方法、
 * ResizeObserver / scrollIntoView stub、fake timers（含 rAF）、i18n 回传 key。
 */

// obsidian 真实环境把 createEl/createDiv/createSpan 挂到 HTMLElement.prototype，
// 共享 setup.ts 只挂成了全局函数。这里本地补齐（放在共享 setup 会跨文件泄漏）。
type ElInfo = { cls?: string | string[]; text?: string; attr?: Record<string, string> } | string | undefined;
function applyElInfo(el: HTMLElement, o: ElInfo) {
	if (!o) return;
	if (typeof o === "string") {
		el.textContent = o;
		return;
	}
	if (o.cls) {
		const cls = Array.isArray(o.cls) ? o.cls : String(o.cls).split(/\s+/);
		cls.filter(Boolean).forEach((c) => el.classList.add(c));
	}
	if (o.text != null) el.textContent = o.text;
	if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, String(v));
}
if (!(HTMLElement.prototype as unknown as { createDiv?: unknown }).createDiv) {
	const proto = HTMLElement.prototype as unknown as {
		createDiv: (o?: ElInfo) => HTMLElement;
		createEl: (tag: string, o?: ElInfo) => HTMLElement;
		createSpan: (o?: ElInfo) => HTMLElement;
	};
	proto.createDiv = function (o) {
		const el = document.createElement("div");
		applyElInfo(el, o);
		this.appendChild(el);
		return el;
	};
	proto.createEl = function (tag, o) {
		const el = document.createElement(tag);
		applyElInfo(el, o);
		this.appendChild(el);
		return el;
	};
	proto.createSpan = function (o) {
		const el = document.createElement("span");
		applyElInfo(el, o);
		this.appendChild(el);
		return el;
	};
}
// jsdom 未实现 scrollIntoView，toggleJournalArea 展开时会调用到
if (!(Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView) {
	(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = vi.fn();
}

const idleMock = vi.hoisted(() => ({ tasks: [] as Array<() => void> }));
const confirmMock = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));

vi.mock("@shared/platform", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@shared/platform")>();
	return { ...actual, requestIdle: (fn: () => void) => { idleMock.tasks.push(fn); return 0; } };
});

vi.mock("@translation/platform/macos-shortcuts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@translation/platform/macos-shortcuts")>();
	return { ...actual, isMacOS: () => false, macosSystemTranslate: vi.fn(async () => ""), splitMarkdownForTranslate: vi.fn(() => []) };
});

vi.mock("@ui/modals/confirm-modal", () => ({
	ConfirmModal: class {
		constructor(opts: Record<string, unknown>) {
			confirmMock.last = opts;
		}
		open() {}
	},
}));

vi.mock("@shared/i18n", () => ({
	makeT: () => (k: string) => String(k),
}));

// 有 repo 时 buildContent 会触发 loadReadme（网络）。obsidian mock 的 requestUrl
// 默认抛错，这里覆盖为可控 mock，避免「网络错误降级」污染本轮的端口断言。
vi.mock("obsidian", async (importOriginal) => {
	const actual = await importOriginal<typeof import("obsidian")>();
	return {
		...actual,
		requestUrl: vi.fn(async () => ({ status: 200, text: "# Hi" })) as unknown as typeof actual.requestUrl,
	};
});

vi.mock("@domain/catalog/mirror", () => ({
	buildReadmeUrl: vi.fn((repo: string, _opts?: unknown, fileName?: string) => `https://raw.test/${repo}/${fileName ?? "README.md"}`),
	rewriteReadmeUrls: vi.fn((md: string) => md),
	classifyNetworkError: vi.fn(() => ({ kind: "blocked", message: "网络错误", suggestMirror: true })),
}));

vi.mock("@ui/components/version-picker-modal", () => ({
	openVersionPicker: vi.fn(),
}));

// 评测编辑器：注入一个 .pt-journal-editor 元素（源码靠它做折叠判断），
// 并返回 dispose 供抽屉清理时释放。
vi.mock("@ui/components/journal-editor", () => ({
	renderJournalEditor: vi.fn((box: HTMLElement) => {
		const el = document.createElement("div");
		el.className = "pt-journal-editor";
		box.appendChild(el);
		return { dispose: vi.fn() };
	}),
}));

const info = (over: Partial<PluginInfo> = {}): PluginInfo =>
	({ id: "p1", name: "插件一", description: "描述", author: "作者", ...over } as PluginInfo);

const baseSettings = {
	favorites: [] as string[],
	useTransmart: false,
	secretId: "",
	secretKey: "",
	baiduAppId: "",
	baiduKey: "",
	mirrorSource: "github" as const,
	mirrorCustomBase: "",
};

function makeHost(over: Record<string, unknown> = {}) {
	// settings 深合并：覆盖单个字段不能丢掉 favorites 等默认字段，
	// 否则 buildContent 里 settings.favorites.includes 会报 undefined.includes
	const { settings: overSettings, ...rest } = over;
	return {
		settings: { ...baseSettings, ...(overSettings as Record<string, unknown> | undefined) },
		translator: { translateTextSegment: vi.fn(async (s: string) => `译:${s}`), getPluginTag: () => null },
		saveTranslatorData: vi.fn(),
		scheduleIndexRefresh: vi.fn(),
		tmApprovedReady: Promise.resolve(),
		tmProgress: null,
		localModelState: { status: "idle", loaded: 0, total: 0 },
		recordInstallDiff: vi.fn(async () => {}),
		journalEnabled: () => false,
		loadJournalEntry: vi.fn(async () => null),
		saveJournalEntry: vi.fn(async () => {}),
		getInstallFacts: () => undefined,
		journalTriedIds: new Set<string>(),
		journalEntryIds: new Set<string>(),
		openJournalView: vi.fn(),
		...rest,
	} as never;
}

function makeApp(manifests: Record<string, { version: string }> = {}, enabled: string[] = []) {
	return {
		plugins: { manifests, enabledPlugins: new Set(enabled) },
	} as never;
}

function makeVC(pins: Record<string, string> = {}) {
	return {
		pins,
		listVersions: vi.fn(async () => [] as never[]),
		pin: vi.fn(async () => {}),
	};
}

function makeDrawer(over: Partial<DrawerOptions> = {}) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const opts = {
		app: makeApp(),
		plugin: makeHost(),
		info: info(),
		result: undefined,
		similar: [] as never[],
		triggerCard: null,
		openDetail: vi.fn(),
		toggleFavorite: vi.fn(() => true),
		container,
		onClose: vi.fn(),
		...over,
	} as unknown as DrawerOptions;
	const drawer = new PluginDetailDrawer(opts);
	const drawerEl = document.createElement("div");
	(drawer as unknown as Record<string, unknown>).drawerEl = drawerEl;
	(drawer as unknown as Record<string, unknown>).backdropEl = document.createElement("div");
	return { drawer, drawerEl, opts, container };
}

const call = <T = unknown>(drawer: PluginDetailDrawer, method: string, ...args: unknown[]): T =>
	(drawer as unknown as Record<string, (...a: unknown[]) => T>)[method](...args);

/** 让 loadJournalEntry 的 .then 回调与已排队的微任务跑完 */
const flush = async () => {
	await vi.advanceTimersByTimeAsync(0);
	await Promise.resolve();
};

beforeEach(() => {
	idleMock.tasks = [];
	confirmMock.last = null;
	// 这两个是模块级 vi.fn，调用记录会跨测试累积：
	// 不清会让 mock.calls[0] 取到上一个测试的调用（连带闭包里的旧 vc / 旧 host）。
	// 用 mockClear 只清记录、保留 vi.mock 工厂里给的实现。
	vi.mocked(openVersionPicker).mockClear();
	vi.mocked(renderJournalEditor).mockClear();
	document.body.innerHTML = "";
	vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"] });
	(window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
		observe() {}
		disconnect() {}
		unobserve() {}
	};
});

afterEach(() => {
	vi.useRealTimers();
});

const run = (drawer: PluginDetailDrawer) => {
	call(drawer, "buildContent");
};

/** 取最近一次 openVersionPicker 的入参 */
const lastPickerOpts = () =>
	vi.mocked(openVersionPicker).mock.calls[0][0] as unknown as {
		repo: string;
		pinned: string | null;
		pluginName: string;
		installedVersion: string | undefined;
		listVersions: (repo: string, force?: boolean) => Promise<unknown>;
		onPick: (version: string | null) => Promise<void>;
	};

describe("版本固定端口（versionControl）", () => {
	it("已安装 + 有仓库 + 提供端口 → 渲染版本按钮（未固定文案）并带仓库打开选择器", () => {
		const vc = makeVC();
		const { drawer, drawerEl } = makeDrawer({
			app: makeApp({ p1: { version: "1.0.0" } }),
			info: info({ repo: "u/p" }),
			versionControl: vc as never,
		});
		run(drawer);
		const btn = drawerEl.querySelector<HTMLElement>(".pt-detail-btn--version");
		expect(btn).not.toBeNull();
		// 未固定 → 文案为「固定版本」（mock t 回传 key）
		expect(btn!.querySelector("span")!.textContent).toBe("updates.pin");
		btn!.click();
		expect(openVersionPicker).toHaveBeenCalledTimes(1);
		const o = lastPickerOpts();
		expect(o.repo).toBe("u/p");
		expect(o.pinned).toBeNull();
		expect(o.pluginName).toBe("插件一");
		expect(o.installedVersion).toBe("1.0.0");
	});

	it("已固定版本 → 按钮文案为 version.pinned，选择器带当前固定版本", () => {
		const vc = makeVC({ p1: "0.9.0" });
		const { drawer, drawerEl } = makeDrawer({
			app: makeApp({ p1: { version: "1.0.0" } }),
			info: info({ repo: "u/p" }),
			versionControl: vc as never,
		});
		run(drawer);
		const btn = drawerEl.querySelector<HTMLElement>(".pt-detail-btn--version")!;
		expect(btn.querySelector("span")!.textContent).toBe("version.pinned");
		btn.click();
		expect(lastPickerOpts().pinned).toBe("0.9.0");
	});

	it("listVersions / onPick 委托到宿主端口，onPick 后触发重建", async () => {
		const vc = makeVC();
		const { drawer, drawerEl } = makeDrawer({
			app: makeApp({ p1: { version: "1.0.0" } }),
			info: info({ repo: "u/p" }),
			versionControl: vc as never,
		});
		const refresh = vi.fn();
		(drawer as unknown as Record<string, unknown>).refreshContent = refresh;
		run(drawer);
		drawerEl.querySelector<HTMLElement>(".pt-detail-btn--version")!.click();
		const o = lastPickerOpts();
		await o.listVersions("u/p", true);
		expect(vc.listVersions).toHaveBeenCalledWith("u/p", true);
		await o.onPick("2.0.0");
		expect(vc.pin).toHaveBeenCalledWith("p1", "2.0.0");
		expect(refresh).toHaveBeenCalled();
	});

	it("未提供端口 → 不渲染版本按钮", () => {
		const { drawer, drawerEl } = makeDrawer({
			app: makeApp({ p1: { version: "1.0.0" } }),
			info: info({ repo: "u/p" }),
		});
		run(drawer);
		expect(drawerEl.querySelector(".pt-detail-btn--version")).toBeNull();
	});

	it("未安装 → 不渲染版本按钮", () => {
		const vc = makeVC();
		const { drawer, drawerEl } = makeDrawer({
			app: makeApp(), // manifests 为空 → 未安装
			info: info({ repo: "u/p" }),
			versionControl: vc as never,
		});
		run(drawer);
		expect(drawerEl.querySelector(".pt-detail-btn--version")).toBeNull();
	});

	it("无仓库 → 不渲染版本按钮", () => {
		const vc = makeVC();
		const { drawer, drawerEl } = makeDrawer({
			app: makeApp({ p1: { version: "1.0.0" } }),
			info: info(), // 无 repo
			versionControl: vc as never,
		});
		run(drawer);
		expect(drawerEl.querySelector(".pt-detail-btn--version")).toBeNull();
	});
});

describe("评测编辑区端口（journalEnabled）", () => {
	it("未启用 → 不创建 slot、不注入编辑器", async () => {
		const { drawer, drawerEl } = makeDrawer();
		run(drawer);
		await flush();
		expect(drawerEl.querySelector(".pt-detail-journal")).toBeNull();
		expect(renderJournalEditor).not.toHaveBeenCalled();
	});

	it("启用 → 创建 slot，并在读盘（异步）完成后注入编辑器", async () => {
		const host = makeHost({ journalEnabled: () => true });
		const { drawer, drawerEl } = makeDrawer({ plugin: host });
		run(drawer);
		// 编辑器要等 loadJournalEntry 完成，同步阶段尚未注入
		expect(renderJournalEditor).not.toHaveBeenCalled();
		await flush();
		expect(renderJournalEditor).toHaveBeenCalledTimes(1);
		const args = vi.mocked(renderJournalEditor).mock.calls[0];
		expect(args[1]).toBe("p1");
		expect(args[2]).toBe("插件一"); // displayName = result.translatedName || p.name
		expect(drawerEl.querySelector(".pt-detail-journal")).not.toBeNull();
	});

	it("未写过评测 → 注入后默认折叠", async () => {
		const host = makeHost({ journalEnabled: () => true, journalEntryIds: new Set<string>() });
		const { drawer, drawerEl } = makeDrawer({ plugin: host });
		run(drawer);
		await flush();
		const j = drawerEl.querySelector<HTMLElement>(".pt-journal-editor")!;
		expect(j.classList.contains("is-collapsed")).toBe(true);
	});

	it("已写过评测 → 默认展开（不折叠）", async () => {
		const host = makeHost({ journalEnabled: () => true, journalEntryIds: new Set(["p1"]) });
		const { drawer, drawerEl } = makeDrawer({ plugin: host });
		run(drawer);
		await flush();
		const j = drawerEl.querySelector<HTMLElement>(".pt-journal-editor")!;
		expect(j.classList.contains("is-collapsed")).toBe(false);
	});

	it("读盘期间抽屉已关闭 → 丢弃注入（二次守卫）", async () => {
		const host = makeHost({ journalEnabled: () => true });
		const { drawer, drawerEl } = makeDrawer({ plugin: host });
		run(drawer);
		// 模拟读盘完成前抽屉被关闭：.then 回调必须自己退出，不能挂到旧 DOM
		(drawer as unknown as Record<string, unknown>).drawerEl = null;
		await flush();
		expect(renderJournalEditor).not.toHaveBeenCalled();
		expect(drawerEl.querySelector(".pt-journal-editor")).toBeNull();
	});

	it("save 回调委托到宿主 saveJournalEntry", async () => {
		const host = makeHost({ journalEnabled: () => true }) as unknown as {
			saveJournalEntry: ReturnType<typeof vi.fn>;
		};
		const { drawer } = makeDrawer({ plugin: host as never });
		run(drawer);
		await flush();
		const optsObj = vi.mocked(renderJournalEditor).mock.calls[0][4] as unknown as {
			save: (e: unknown) => void;
			t: unknown;
		};
		const entry = { id: "p1", note: "好用" };
		optsObj.save(entry);
		expect(host.saveJournalEntry).toHaveBeenCalledWith(entry);
	});

	it("focusJournal → 注入后强制展开（并加高亮闪烁）", async () => {
		const host = makeHost({ journalEnabled: () => true, journalEntryIds: new Set<string>() });
		const { drawer, drawerEl } = makeDrawer({ plugin: host, focusJournal: true });
		run(drawer);
		await flush();
		// focusJournal 走 requestAnimationFrame 触发 toggleJournalArea(true)
		await vi.advanceTimersByTimeAsync(20);
		const j = drawerEl.querySelector<HTMLElement>(".pt-journal-editor")!;
		expect(j.classList.contains("is-collapsed")).toBe(false);
		expect(j.classList.contains("pt-journal-flash")).toBe(true);
	});
});
