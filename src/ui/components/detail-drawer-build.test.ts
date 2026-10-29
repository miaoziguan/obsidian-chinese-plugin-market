import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PluginDetailDrawer, type DrawerOptions } from "./detail-drawer";
import type { PluginInfo } from "@domain/catalog/translator";

/**
 * buildContent：详情抽屉的渲染主体（547 行）。
 *
 * 这一轮只打「同步渲染分支」——也就是不依赖网络拉取 README 的路径：
 * 头部 / 元数据 / 操作按钮 / 依赖区 / 相似推荐 / README 通道按钮。
 * 这些分支的错误模式都是「某种状态下按钮渲染错」或「某区块漏渲染」，
 * 不抛错只让用户看到不对的界面。
 *
 * 关键约束：info 一律不带 repo，让 loadReadme 走同步的 noRepo 分支，
 * 避免触发 requestUrl 的网络副作用（README 真实拉取留待后续）。
 */
// obsidian 真实环境把 createEl/createDiv/createSpan 挂到 HTMLElement.prototype，
// 但 test/setup.ts 只挂成了全局函数（g.createEl）。这里本地补齐原型方法，
// 不动共享 setup，避免影响其他测试。
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

// 真实 i18n 的某些 key 翻译值含非法 HTML 空格字符，会在 pickLang 里抛
// "token contains HTML space" 错误（这是产品侧的翻译数据 bug，不在本轮范围）。
// 与 compare-view 的策略一致：mock 让 t 直接回传 key，断言用 key/class，
// 既解耦翻译文件，也避免被该 bug 卡住。
vi.mock("@shared/i18n", () => ({
	makeT: () => (k: string) => String(k),
}));

// obsidian mock 可能未提供 setCssProps；buildContent 末尾的 syncHeadH 会用到，补一个安全实现
if (!(HTMLElement.prototype as unknown as { setCssProps?: unknown }).setCssProps) {
	(HTMLElement.prototype as unknown as { setCssProps: (p: Record<string, string>) => void }).setCssProps =
		function (props: Record<string, string>) {
			for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
		};
}

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
	// settings 需深合并：覆盖单个字段时不能丢掉 favorites 等默认字段，
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

function makeApp(plugins?: { manifests?: Record<string, { version: string }>; enabledPlugins?: Set<string> }) {
	return {
		plugins: {
			manifests: plugins?.manifests ?? {},
			enabledPlugins: plugins?.enabledPlugins ?? new Set<string>(),
		},
	} as never;
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

beforeEach(() => {
	idleMock.tasks = [];
	confirmMock.last = null;
	document.body.innerHTML = "";
	vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"] });
	(window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
		observe() {}
		disconnect() {}
		unobserve() {}
	};
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText: vi.fn(async () => {}) },
		configurable: true,
	});
});

afterEach(() => {
	vi.useRealTimers();
});

const run = (drawer: PluginDetailDrawer) => {
	call(drawer, "buildContent");
};

describe("头部与元数据", () => {
	it("渲染标题与关闭按钮", () => {
		const { drawer, drawerEl } = makeDrawer();
		run(drawer);
		expect(drawerEl.querySelector(".pt-drawer-title")?.textContent).toBe("插件一");
		expect(drawerEl.querySelector(".pt-drawer-close")).not.toBeNull();
	});

	it("有译文名时副标题显示原名", () => {
		const { drawer, drawerEl } = makeDrawer({ result: { translatedName: "插件壹" } as never });
		run(drawer);
		expect(drawerEl.querySelector(".pt-drawer-subtitle")?.textContent).toBe("插件一");
	});

	it("元数据区渲染作者与 ID（无下载/更新则不渲染多余行）", () => {
		const { drawer, drawerEl } = makeDrawer();
		run(drawer);
		const meta = drawerEl.querySelector(".pt-detail-meta");
		expect(meta).not.toBeNull();
		// 标签用 i18n key，值直接来自 info
		expect(meta!.querySelectorAll(".pt-detail-meta-row").length).toBe(2);
		const values = Array.from(meta!.querySelectorAll(".pt-detail-meta-value")).map((v) => v.textContent);
		expect(values).toContain("作者");
		expect(values).toContain("p1");
	});

	it("下载量有则渲染下载量行", () => {
		const { drawer, drawerEl } = makeDrawer({ info: info({ downloads: 1234 }) });
		run(drawer);
		const meta = drawerEl.querySelector(".pt-detail-meta")!;
		const values = Array.from(meta.querySelectorAll(".pt-detail-meta-value")).map((v) => v.textContent);
		// formatDownloads(1234) → "1.2k"
		expect(values).toContain("1.2k");
	});
});

describe("安装三态的操作按钮", () => {
	it("未安装 → 渲染「安装」主按钮（mod-cta）", () => {
		const { drawer, drawerEl } = makeDrawer();
		run(drawer);
		expect(drawerEl.querySelector(".pt-detail-btn.mod-cta")).not.toBeNull();
		expect(drawerEl.querySelector(".pt-detail-btn--enabled")).toBeNull();
		expect(drawerEl.querySelector(".pt-detail-btn--danger")).toBeNull();
	});

	it("已安装未启用 → 渲染「启用」按钮与卸载按钮，无已启用徽标", () => {
		const { drawer, drawerEl } = makeDrawer({ app: makeApp({ manifests: { p1: { version: "1.0" } } }) });
		run(drawer);
		expect(drawerEl.querySelector(".pt-detail-btn--enabled")).toBeNull();
		expect(drawerEl.querySelector(".pt-detail-btn.mod-cta")).toBeNull();
		expect(drawerEl.querySelector(".pt-detail-btn--danger")).not.toBeNull();
	});

	it("已启用 → 渲染纯展示「已启用」徽标 + 设置入口", () => {
		const { drawer, drawerEl } = makeDrawer({
			app: makeApp({ manifests: { p1: { version: "1.0" } }, enabledPlugins: new Set(["p1"]) }),
		});
		run(drawer);
		expect(drawerEl.querySelector(".pt-detail-btn--enabled")).not.toBeNull();
		expect(drawerEl.querySelector(".pt-detail-btn--danger")).not.toBeNull();
		expect(drawerEl.querySelector(".pt-detail-btn.mod-cta")).toBeNull();
	});
});

describe("操作按钮交互", () => {
	it("收藏按钮点击切换收藏", () => {
		const { drawer } = makeDrawer();
		run(drawer);
		const favBtn = (drawer as unknown as Record<string, HTMLElement>).drawerEl.querySelector<HTMLElement>(".pt-detail-btn--review")!;
		// 收藏按钮是 actions 区里最后一个无专属 class 的按钮；改用 aria 定位：favorite 图标文案
		const fav = Array.from((drawer as unknown as { drawerEl: HTMLElement }).drawerEl.querySelectorAll(".pt-detail-actions .pt-detail-btn"))
			.find((b) => b.textContent?.includes("card.favorite")) as HTMLElement;
		const toggle = (drawer as unknown as { toggleFavorite: (id: string) => boolean }).toggleFavorite;
		fav.click();
		expect(toggle).toHaveBeenCalledWith("p1");
		expect(favBtn).toBeTruthy();
	});

	it("复制 ID 写入剪贴板", () => {
		const { drawer } = makeDrawer();
		run(drawer);
		const copy = Array.from((drawer as unknown as { drawerEl: HTMLElement }).drawerEl.querySelectorAll(".pt-detail-actions .pt-detail-btn"))
			.find((b) => b.textContent?.includes("card.copy")) as HTMLElement;
		copy.click();
		expect(navigator.clipboard.writeText).toHaveBeenCalledWith("p1");
	});

	it("复制 ID 后按钮临时变为「已复制」，1200ms 后还原", async () => {
		const { drawer } = makeDrawer();
		run(drawer);
		const copy = Array.from((drawer as unknown as { drawerEl: HTMLElement }).drawerEl.querySelectorAll(".pt-detail-actions .pt-detail-btn"))
			.find((b) => b.textContent?.includes("card.copy")) as HTMLElement;
		copy.click();
		// 真实文案经 i18n，这里断言 key（mock 后 t 回传 key）
		expect(copy.textContent).toContain("card.copy.done");
		await vi.advanceTimersByTimeAsync(1200);
		expect(copy.textContent).toContain("card.copy");
	});

	it("已安装时卸载按钮弹出二次确认", () => {
		const { drawer } = makeDrawer({ app: makeApp({ manifests: { p1: { version: "1.0" } } }) });
		run(drawer);
		const uninstall = (drawer as unknown as { drawerEl: HTMLElement }).drawerEl.querySelector<HTMLElement>(".pt-detail-btn--danger")!;
		uninstall.click();
		expect(confirmMock.last).not.toBeNull();
		expect(confirmMock.last!.danger).toBe(true);
	});

	it("评测按钮点击展开/折叠评测编辑区", () => {
		const { drawer } = makeDrawer();
		run(drawer);
		const review = (drawer as unknown as { drawerEl: HTMLElement }).drawerEl.querySelector<HTMLElement>(".pt-detail-btn--review")!;
		const toggle = vi.spyOn(drawer as unknown as { toggleJournalArea: () => void }, "toggleJournalArea");
		review.click();
		expect(toggle).toHaveBeenCalled();
	});
});

describe("依赖区", () => {
	const depHost = (edges: unknown[], dependents: unknown[]) => ({
		edgesOf: vi.fn(() => edges),
		dependentsOf: vi.fn(() => dependents),
		statusOf: vi.fn(),
		canOpen: vi.fn(() => true),
		nameOf: vi.fn((id: string) => id),
		onOpen: vi.fn(),
		onFix: vi.fn(),
		ensure: undefined,
	} as never);

	it("有依赖时渲染依赖区", () => {
		const { drawer, drawerEl } = makeDrawer({ deps: depHost([{ id: "x" }], []) });
		run(drawer);
		expect(drawerEl.querySelector(".pt-detail-deps")).not.toBeNull();
	});

	it("有被依赖时渲染依赖区（dependents）", () => {
		const { drawer, drawerEl } = makeDrawer({ deps: depHost([], [{ id: "y" }]) });
		run(drawer);
		expect(drawerEl.querySelector(".pt-detail-deps")).not.toBeNull();
	});

	it("无依赖且无被依赖时不渲染依赖区", () => {
		const { drawer, drawerEl } = makeDrawer({ deps: depHost([], []) });
		run(drawer);
		expect(drawerEl.querySelector(".pt-detail-deps")).toBeNull();
	});
});

describe("README 翻译通道按钮", () => {
	it("无任何可用通道时禁用系统翻译按钮", () => {
		const { drawer, drawerEl } = makeDrawer();
		run(drawer);
		const sysBtn = drawerEl.querySelector<HTMLButtonElement>(".pt-detail-btn--sys-translate");
		expect(sysBtn).not.toBeNull();
		expect(sysBtn!.disabled).toBe(true);
	});

	it("开启腾讯免费通道时按钮可用", () => {
		const { drawer, drawerEl } = makeDrawer({ plugin: makeHost({ settings: { useTransmart: true } }) });
		run(drawer);
		const sysBtn = drawerEl.querySelector<HTMLButtonElement>(".pt-detail-btn--sys-translate");
		expect(sysBtn!.disabled).toBe(false);
	});
});

describe("相似推荐", () => {
	it("计算未完成时渲染骨架占位", () => {
		const { drawer, drawerEl } = makeDrawer({ deferSimilar: true } as Partial<DrawerOptions>);
		run(drawer);
		expect(drawerEl.querySelectorAll(".pt-detail-similar-skeleton-card").length).toBe(3);
	});

	it("有相似项时渲染卡片，点击跳转详情", () => {
		const similar = [{ id: "p2", name: "插件二", translatedName: "插件贰", description: "d" }] as never;
		const { drawer, drawerEl, opts } = makeDrawer({ similar });
		run(drawer);
		const card = drawerEl.querySelector<HTMLElement>(".pt-detail-similar-card");
		expect(card).not.toBeNull();
		card!.click();
		expect(opts.openDetail).toHaveBeenCalledWith("p2");
	});

	it("无相似项且已完成时显示空提示", () => {
		const { drawer, drawerEl } = makeDrawer({ similar: [] as never });
		run(drawer);
		expect(drawerEl.querySelector(".pt-detail-similar-empty")).not.toBeNull();
	});
});

describe("历史后退", () => {
	it("历史栈非空时渲染后退按钮", () => {
		const { drawer, drawerEl } = makeDrawer();
		(drawer as unknown as { _history: Array<unknown> })._history = [
			{ info: info({ id: "p0" }), result: undefined, similar: [] },
		];
		run(drawer);
		expect(drawerEl.querySelector(".pt-drawer-back")).not.toBeNull();
	});

	it("历史栈为空时不渲染后退按钮", () => {
		const { drawer, drawerEl } = makeDrawer();
		run(drawer);
		expect(drawerEl.querySelector(".pt-drawer-back")).toBeNull();
	});
});

describe("无 repo 时的 README 正文", () => {
	it("不给 repo → README 区显示「无仓库」占位，不触发网络", () => {
		const { drawer, drawerEl } = makeDrawer();
		run(drawer);
		// loadReadme 同步走 noRepo 分支
		expect(drawerEl.querySelector(".pt-detail-readme-empty")).not.toBeNull();
	});
});
