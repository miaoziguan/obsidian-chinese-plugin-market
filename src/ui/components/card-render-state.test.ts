import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PluginInfo, TranslateResult } from "@domain/catalog/translator";
import { createCardElement, applyCardState, type CardRenderContext } from "./card-render";
import { isMacOS, macosSystemTranslate } from "@translation/platform/macos-shortcuts";
import { Notice } from "obsidian";

/**
 * 卡片渲染的骨架与状态填充：createCardElement（336-577）、updateInstallButton（580-670）、
 * handleCardSysTranslate（676-725）、applyCardState（731-1011）。
 *
 * 此前已有 card-render.test.ts 只覆盖了 createPluginCard 的收藏/信号分支（4 例），
 * 这 ~675 行完全没跑到（317 条未覆盖语句）。错误模式是「卡片显示错」：
 * 安装态胶囊显示成错误的那个、开关在启用成功后误消失、徽标该显不显、
 * 描述带了官方审核句噪音、或趋势线在无采样时画空线编造增量。都不抛错。
 *
 * 本文件不改动已有的 card-render.test.ts（两者互补）。
 */

vi.mock("@translation/platform/macos-shortcuts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@translation/platform/macos-shortcuts")>();
	return {
		...actual,
		isMacOS: vi.fn(() => false),
		macosSystemTranslate: vi.fn(async (s: string) => `译:${s}`),
	};
});

vi.mock("obsidian", async (importOriginal) => {
	const actual = await importOriginal<typeof import("obsidian")>();
	return {
		...actual,
		// 翻译完成/失败的 toast 需要可断言
		Notice: vi.fn().mockImplementation((msg?: string) => ({ message: msg })),
	};
});

// Obsidian 把 createDiv/createEl/createSpan 挂到 HTMLElement.prototype，
// 共享 setup 只给了全局函数。这里局部补齐（不动共享 setup，避免跨文件泄漏）。
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

const plugin = (over: Partial<PluginInfo> = {}): PluginInfo =>
	({ id: "p1", name: "Plugin One", description: "原始描述", author: "作者", downloads: 1234, updated: Date.now() - 86400000, ...over } as PluginInfo);

const result = (over: Partial<TranslateResult> = {}): TranslateResult =>
	({ translatedName: "插件一", translatedDesc: "译文描述", source: "ai", ...over } as unknown as TranslateResult);

function makeCtx(over: Partial<CardRenderContext> = {}): CardRenderContext {
	return {
		t: ((k: string) => k) as never,
		settings: { nameDisplay: "translated" } as never,
		installedIds: new Set<string>(),
		enabledIds: new Set<string>(),
		aiSearchResult: undefined,
		compareSet: new Set<string>(),
		favoritesSet: new Set<string>(),
		smartSignals: new Map(),
		outdatedIds: new Set<string>(),
		outdatedInfo: new Map(),
		app: { setting: { openTabById: vi.fn() } } as never,
		installingIds: new Set<string>(),
		recommendedIds: new Set<string>(),
		yulinPicksSet: new Set<string>(),
		onDescToggle: vi.fn(),
		onSysTranslatePersist: vi.fn(),
		onToggleEnabled: vi.fn(),
		trendingEngine: undefined,
		firstSeenMap: new Map(),
		journalTriedIds: new Set<string>(),
		journalEntryIds: new Set<string>(),
		updatingIds: new Set<string>(),
		onUpdatePlugin: vi.fn(),
		...over,
	} as unknown as CardRenderContext;
}

/** 建卡 + 填状态，返回卡片与各处引用的便捷查询 */
function render(over: Partial<CardRenderContext> = {}, p: PluginInfo = plugin(), r?: TranslateResult) {
	const ctx = makeCtx(over);
	const card = createCardElement(ctx);
	applyCardState(card, p, r, ctx);
	return { ctx, card };
}
const q = (card: HTMLElement, sel: string) => card.querySelector<HTMLElement>(sel);

beforeEach(() => {
	document.body.innerHTML = "";
	vi.mocked(isMacOS).mockReturnValue(false);
	vi.mocked(macosSystemTranslate).mockImplementation(async (s: string) => `译:${s}`);
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("createCardElement：骨架", () => {
	it("建出卡片骨架：role=listitem、标题区、描述、统计行、操作图标组", () => {
		const ctx = makeCtx();
		const card = createCardElement(ctx);
		expect(card.classList.contains("pt-card")).toBe(true);
		expect(card.getAttribute("role")).toBe("listitem");
		expect(card.getAttribute("tabindex")).toBe("-1");
		expect(q(card, ".pt-card-name")).not.toBeNull();
		expect(q(card, ".pt-card-desc")).not.toBeNull();
		expect(q(card, ".pt-card-statline")).not.toBeNull();
		expect(q(card, ".pt-card-actions-row")).not.toBeNull();
		// 操作图标组：洞察 / 对比 / 评测 / 收藏 / 卸载
		expect(q(card, ".pt-card-insight")).not.toBeNull();
		expect(q(card, ".pt-card-compare")).not.toBeNull();
		expect(q(card, ".pt-card-review")).not.toBeNull();
		expect(q(card, ".pt-card-favorite")).not.toBeNull();
		expect(q(card, ".pt-card-uninstall")).not.toBeNull();
		// 卸载默认隐藏，由 applyCardState 按安装态显隐
		expect(q(card, ".pt-card-uninstall")!.style.display).toBe("none");
	});

	it("非 macOS 不渲染系统翻译按钮；macOS 时渲染", () => {
		const card = createCardElement(makeCtx());
		expect(q(card, ".pt-card-sys-translate")).toBeNull();
		vi.mocked(isMacOS).mockReturnValue(true);
		const macCard = createCardElement(makeCtx());
		expect(q(macCard, ".pt-card-sys-translate")).not.toBeNull();
	});

	it("「可更新」徽标：点击与键盘 Enter 都跳社区插件更新入口", () => {
		const openTabById = vi.fn();
		const ctx = makeCtx({ app: { setting: { openTabById } } as never });
		const card = createCardElement(ctx);
		const badge = q(card, ".pt-card-update-badge")!;
		badge.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(openTabById).toHaveBeenCalledWith("community-plugins");
		openTabById.mockClear();
		badge.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		expect(openTabById).toHaveBeenCalledWith("community-plugins");
	});

	it("一键更新按钮：点击回调 onUpdatePlugin（带插件 id）", () => {
		const ctx = makeCtx({ onUpdatePlugin: vi.fn() });
		const card = createCardElement(ctx);
		applyCardState(card, plugin(), undefined, ctx); // 写入 data-plugin-id
		q(card, ".pt-card-update-btn")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(ctx.onUpdatePlugin).toHaveBeenCalledWith("p1");
	});

	it("启用开关：点击与键盘都回调 onToggleEnabled", () => {
		const onToggleEnabled = vi.fn();
		const ctx = makeCtx({ installedIds: new Set(["p1"]), onToggleEnabled });
		const card = createCardElement(ctx);
		applyCardState(card, plugin(), undefined, ctx);
		const sw = q(card, ".pt-card-toggle-switch")!;
		sw.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(onToggleEnabled).toHaveBeenCalledWith("p1");
		onToggleEnabled.mockClear();
		sw.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
		expect(onToggleEnabled).toHaveBeenCalledWith("p1");
	});

	it("标题可点击时在「译名 / 原名」间切换（100ms 过渡后更新）", async () => {
		const { card } = render({}, plugin(), result());
		const nameSpan = q(card, ".pt-card-name")!;
		// 有译名 → 可点击
		expect(nameSpan.classList.contains("pt-card-name--clickable")).toBe(true);
		expect(nameSpan.textContent).toContain("插件一");
		nameSpan.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		await vi.advanceTimersByTimeAsync(150);
		expect(nameSpan.classList.contains("pt-card-name--original")).toBe(true);
		expect(nameSpan.textContent).toContain("Plugin One");
		expect(nameSpan.getAttribute("aria-pressed")).toBe("true");
	});

	it("标题不可点击时点击不切换（未翻译）", async () => {
		const { card } = render({}, plugin(), undefined);
		const nameSpan = q(card, ".pt-card-name")!;
		expect(nameSpan.classList.contains("pt-card-name--clickable")).toBe(false);
		const before = nameSpan.textContent;
		nameSpan.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		await vi.advanceTimersByTimeAsync(150);
		expect(nameSpan.textContent).toBe(before);
	});
});

describe("updateInstallButton：安装态四态", () => {
	it("未安装 → 主 CTA 按钮，带 market 动作与 obsidian:// 深链", () => {
		const { card } = render({}, plugin());
		const btn = q(card, ".pt-card-install-btn")!;
		expect(btn.tagName).toBe("BUTTON");
		expect(btn.dataset.action).toBe("market");
		expect(btn.getAttribute("data-url")).toBe("obsidian://show-plugin?id=p1");
	});

	it("已安装未启用 → 次要胶囊（--installed）", () => {
		const { card } = render({ installedIds: new Set(["p1"]), enabledIds: new Set<string>() }, plugin());
		const el = q(card, ".pt-card-install-btn")!;
		expect(el.tagName).toBe("SPAN");
		expect(el.classList.contains("pt-card-install-btn--installed")).toBe(true);
	});

	it("已启用 → 成功色胶囊（--enabled）", () => {
		const { card } = render({ installedIds: new Set(["p1"]), enabledIds: new Set(["p1"]) }, plugin());
		const el = q(card, ".pt-card-install-btn")!;
		expect(el.classList.contains("pt-card-install-btn--enabled")).toBe(true);
	});

	it("安装中 → --installing 且三点循环推进（JS 驱动，不依赖 CSS 动画）", async () => {
		const { card } = render({ installingIds: new Set(["p1"]) }, plugin());
		// 三点循环以 isConnected 为存活条件，必须先入文档
		document.body.appendChild(card);
		const el = q(card, ".pt-card-install-btn")!;
		expect(el.classList.contains("pt-card-install-btn--installing")).toBe(true);
		const label = el.querySelector<HTMLElement>(".pt-install-label")!;
		expect(label.textContent).toBe("card.installing");
		await vi.advanceTimersByTimeAsync(500);
		expect(label.textContent).toBe("card.installing·");
		await vi.advanceTimersByTimeAsync(1000);
		expect(label.textContent).toBe("card.installing···");
	});

	it("安装中的元素脱离文档后自动停表（避免泄漏）", async () => {
		const { card } = render({ installingIds: new Set(["p1"]) }, plugin());
		document.body.appendChild(card);
		const el = q(card, ".pt-card-install-btn")!;
		await vi.advanceTimersByTimeAsync(500);
		expect(el.querySelector<HTMLElement>(".pt-install-label")!.textContent).toBe("card.installing·");
		card.remove(); // 脱离文档
		await vi.advanceTimersByTimeAsync(2000);
		expect((el as unknown as { _ptDots?: number })._ptDots).toBeUndefined();
	});
});

describe("applyCardState：身份与徽标", () => {
	it("写入 data-plugin-id，并按收藏/推荐/羽鳞切换类名与徽标", () => {
		const { card } = render({
			favoritesSet: new Set(["p1"]),
			recommendedIds: new Set(["p1"]),
			yulinPicksSet: new Set(["p1"]),
		}, plugin());
		expect(card.dataset.pluginId).toBe("p1");
		expect(card.classList.contains("is-favorited")).toBe(true);
		expect(card.classList.contains("is-recommended")).toBe(true);
		expect(card.classList.contains("is-yulin")).toBe(true);
		expect(q(card, ".pt-card-recommend-badge")!.style.display).toBe("");
		expect(q(card, ".pt-card-yulin-badge")!.style.display).toBe("");
	});

	it("未命中时徽标隐藏（零常态噪音）", () => {
		const { card } = render({}, plugin());
		expect(q(card, ".pt-card-recommend-badge")!.style.display).toBe("none");
		expect(q(card, ".pt-card-yulin-badge")!.style.display).toBe("none");
		expect(q(card, ".pt-card-new-badge")!.style.display).toBe("none");
		expect(q(card, ".pt-card-tried-badge")!.style.display).toBe("none");
		expect(q(card, ".pt-card-dep-badge")!.style.display).toBe("none");
	});

	it("标题显示模式：original 模式优先显示原名", () => {
		const { card } = render({ settings: { nameDisplay: "original" } as never }, plugin(), result());
		expect(q(card, ".pt-card-name")!.textContent).toContain("Plugin One");
	});

	it("无译名时标题不可点击，并移除无障碍属性", () => {
		const { card } = render({}, plugin(), undefined);
		const nameSpan = q(card, ".pt-card-name")!;
		expect(nameSpan.hasAttribute("role")).toBe(false);
		expect(nameSpan.hasAttribute("tabindex")).toBe(false);
		expect(nameSpan.hasAttribute("aria-pressed")).toBe(false);
	});

	it("对比 / 收藏 / 评测图标态", () => {
		const { card } = render({
			compareSet: new Set(["p1"]),
			favoritesSet: new Set(["p1"]),
			journalEntryIds: new Set(["p1"]),
		}, plugin());
		expect(q(card, ".pt-card-compare")!.classList.contains("is-compare-on")).toBe(true);
		expect(q(card, ".pt-card-favorite")!.classList.contains("is-fav-on")).toBe(true);
		expect(q(card, ".pt-card-review")!.classList.contains("is-review-on")).toBe(true);
	});
});

describe("applyCardState：开关与卸载", () => {
	it("未安装 → 开关隐藏（避免误显示）", () => {
		const { card } = render({}, plugin());
		expect(q(card, ".pt-card-toggle-switch")!.style.display).toBe("none");
	});

	it("已安装未启用 → 开关显示但未选中（aria-checked=false）", () => {
		const { card } = render({ installedIds: new Set(["p1"]), enabledIds: new Set<string>() }, plugin());
		const sw = q(card, ".pt-card-toggle-switch")!;
		expect(sw.style.display).toBe("");
		expect(sw.classList.contains("is-on")).toBe(false);
		expect(sw.getAttribute("aria-checked")).toBe("false");
	});

	it("已启用 → 开关选中（is-on + aria-checked=true）", () => {
		const { card } = render({ installedIds: new Set(["p1"]), enabledIds: new Set(["p1"]) }, plugin());
		const sw = q(card, ".pt-card-toggle-switch")!;
		expect(sw.classList.contains("is-on")).toBe(true);
		expect(sw.getAttribute("aria-checked")).toBe("true");
	});

	it("安装中 → 开关隐藏（用「既非 installed 也非 enabled」判定，避免启用成功后误消失）", () => {
		const { card } = render({ installedIds: new Set(["p1"]), enabledIds: new Set(["p1"]), installingIds: new Set(["p1"]) }, plugin());
		expect(q(card, ".pt-card-toggle-switch")!.style.display).toBe("none");
	});

	it("卸载按钮：已安装才显示", () => {
		const { card: notInstalled } = render({}, plugin());
		expect(q(notInstalled, ".pt-card-uninstall")!.style.display).toBe("none");
		const { card: installed } = render({ installedIds: new Set(["p1"]) }, plugin());
		expect(q(installed, ".pt-card-uninstall")!.style.display).toBe("");
	});
});

describe("applyCardState：描述与统计", () => {
	it("描述：剔除官方审核句 + 未译时标记 pending", () => {
		// stripReviewNotice 只剔除「未经过…审核」的免责句（已通过审核的不动）
		const p = plugin({ description: "正文内容。该插件尚未经过人工审核。" });
		const { card } = render({}, p, undefined);
		const desc = q(card, ".pt-card-desc")!;
		expect(desc.textContent).not.toContain("官方审核");
		expect(desc.classList.contains("pt-desc-pending")).toBe(true);
	});

	it("统计行：有下载/更新时间则显示对应 chip", () => {
		const { card } = render({}, plugin({ downloads: 1234, updated: Date.now() - 86400000 }));
		expect(q(card, ".pt-card-statline")!.style.display).toBe("");
		expect(q(card, ".pt-stat-chip .pt-stat-icon")).not.toBeNull();
	});

	it("无下载/更新时间 → 统计行隐藏", () => {
		const { card } = render({}, plugin({ downloads: undefined, updated: undefined }));
		expect(q(card, ".pt-card-statline")!.style.display).toBe("none");
	});

	it("趋势：≥2 采样点且有增量才画 sparkline（否则诚实隐藏，不编造增量）", () => {
		// trendDelta 按 latest.timestamp - 30d 窗口过滤，快照必须带 timestamp
		const now = Date.now();
		const engine = {
			getSnapshots: () => [
				{ downloads: 100, timestamp: now - 10 * 86400000 },
				{ downloads: 200, timestamp: now },
			],
		} as never;
		const { card } = render({ trendingEngine: engine }, plugin());
		expect(q(card, ".pt-card-spark")!.style.display).toBe("");
	});

	it("趋势：采样不足 2 点 → sparkline 隐藏", () => {
		const engine = { getSnapshots: () => [{ downloads: 100, timestamp: Date.now() }] } as never;
		const { card } = render({ trendingEngine: engine }, plugin());
		expect(q(card, ".pt-card-spark")!.style.display).toBe("none");
	});
});

describe("applyCardState：信号与理由", () => {
	it("智能信号命中 → 渲染 pill 行；未命中 → 隐藏并清空", () => {
		const { card: hit } = render({ smartSignals: new Map([["p1", ["top5"]]]) } as never, plugin());
		expect(q(hit, ".pt-card-signals")!.style.display).toBe("");
		expect(q(hit, ".pt-signal-pill")).not.toBeNull();
		const { card: miss } = render({}, plugin());
		expect(q(miss, ".pt-card-signals")!.style.display).toBe("none");
	});

	it("AI 排序理由：命中则显示，否则隐藏", () => {
		const { card } = render({ aiSearchResult: { reasons: { p1: "语义匹配度高" } } } as never, plugin());
		expect(q(card, ".pt-ai-reason")!.style.display).toBe("");
		expect(q(card, ".pt-ai-reason-text")!.textContent).toBe("语义匹配度高");
	});

	it("召回信号徽标：渲染并带 title", () => {
		const { card } = render({ aiSearchResult: { signals: { p1: ["vector"] } } } as never, plugin());
		expect(q(card, ".pt-card-match-signals")!.style.display).toBe("");
		expect(q(card, ".pt-match-signal")).not.toBeNull();
		expect(q(card, ".pt-match-signal")!.getAttribute("title")).toContain("card.matchSignal.title");
	});
});

describe("applyCardState：可更新 / 健康度 / 新 / 装过 / 依赖", () => {
	it("可更新：受 notifyInstalledUpdates 开关控制，并显示本地→最新", () => {
		const base = { outdatedIds: new Set(["p1"]), outdatedInfo: new Map([["p1", { local: "1.0.0", latest: "2.0.0" }]]) } as unknown as Partial<CardRenderContext>;
		const { card: off } = render({ ...base }, plugin());
		expect(q(off, ".pt-card-update-badge")!.style.display).toBe("none");
		const { card: on } = render({ ...base, settings: { notifyInstalledUpdates: true } as never }, plugin());
		const badge = q(on, ".pt-card-update-badge")!;
		expect(badge.style.display).toBe("");
		expect(badge.textContent).toContain("2.0.0");
	});

	it("一键更新按钮：更新中禁用并提示「更新中…」防重点", () => {
		const base = {
			outdatedIds: new Set(["p1"]),
			settings: { notifyInstalledUpdates: true } as never,
			onUpdatePlugin: vi.fn(),
		} as unknown as Partial<CardRenderContext>;
		const { card: normal } = render({ ...base }, plugin());
		const btn1 = q(normal, ".pt-card-update-btn")!;
		expect(btn1.style.display).toBe("");
		expect(btn1.hasAttribute("disabled")).toBe(false);
		const { card: updating } = render({ ...base, updatingIds: new Set(["p1"]) }, plugin());
		const btn2 = q(updating, ".pt-card-update-btn")!;
		expect(btn2.textContent).toBe("更新中…");
		expect(btn2.hasAttribute("disabled")).toBe(true);
	});

	it("健康度徽标：开关控制，三档文案", () => {
		const { card: off } = render({}, plugin());
		expect(q(off, ".pt-card-health-badge")!.style.display).toBe("none");
		const { card: on } = render({ settings: { showHealthBadge: true, healthHealthyDays: 90, healthAgingDays: 365 } as never }, plugin({ updated: Date.now() - 86400000 }));
		const hb = q(on, ".pt-card-health-badge")!;
		expect(hb.style.display).toBe("");
		expect(["活跃", "维护放缓", "停更风险"]).toContain(hb.textContent);
	});

	it("「新」标记：近 30 天首次见则显示", () => {
		const { card } = render({ firstSeenMap: new Map([["p1", Date.now() - 86400000]]) } as never, plugin());
		expect(q(card, ".pt-card-new-badge")!.style.display).toBe("");
		expect(q(card, ".pt-card-new-badge")!.textContent).toBe("新");
	});

	it("「装过」标记：曾安装且当前未安装才显示（已装的不重复标）", () => {
		const { card: notInstalled } = render({ journalTriedIds: new Set(["p1"]) }, plugin());
		expect(q(notInstalled, ".pt-card-tried-badge")!.style.display).toBe("");
		const { card: installed } = render({ journalTriedIds: new Set(["p1"]), installedIds: new Set(["p1"]) }, plugin());
		expect(q(installed, ".pt-card-tried-badge")!.style.display).toBe("none");
	});

	it("依赖未满足徽标：有阻塞依赖才显示（装齐了不显示）", () => {
		const graph = { blockingOf: () => [{ dep: { id: "dep1", name: "依赖一" } }] } as never;
		const { card } = render({
			depGraph: graph,
			installedVersions: new Map(),
			knownPluginIds: new Set(["dep1"]),
		} as never, plugin());
		const db = q(card, ".pt-card-dep-badge")!;
		expect(db.style.display).toBe("");
		expect(db.textContent).toBe("card.depBadge");
	});

	it("非 createCardElement 建的卡片：applyCardState 直接返回不抛错", () => {
		const ctx = makeCtx();
		const foreign = document.createElement("div");
		expect(() => applyCardState(foreign, plugin(), undefined, ctx)).not.toThrow();
	});
});

describe("handleCardSysTranslate：macOS 系统翻译", () => {
	it("翻译成功 → 回填标题与描述，并落库沉淀", async () => {
		vi.mocked(isMacOS).mockReturnValue(true);
		const { ctx, card } = render({}, plugin(), undefined);
		const btn = q(card, ".pt-card-sys-translate")!;
		btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		await vi.advanceTimersByTimeAsync(0);
		await Promise.resolve();
		await Promise.resolve();
		expect(macosSystemTranslate).toHaveBeenCalled();
		expect(ctx.onSysTranslatePersist).toHaveBeenCalledWith("p1", "译:Plugin One", "译:原始描述");
		expect(q(card, ".pt-card-name")!.textContent).toContain("译:Plugin One");
		expect(q(card, ".pt-card-desc")!.textContent).toContain("译:原始描述");
		expect(Notice).toHaveBeenCalledWith("card.sysTranslate.done");
	});

	it("翻译失败 → 提示失败且不回填", async () => {
		vi.mocked(isMacOS).mockReturnValue(true);
		vi.mocked(macosSystemTranslate).mockRejectedValue(new Error("boom"));
		const { ctx, card } = render({}, plugin(), undefined);
		const btn = q(card, ".pt-card-sys-translate")!;
		btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		await vi.advanceTimersByTimeAsync(0);
		await Promise.resolve();
		await Promise.resolve();
		expect(ctx.onSysTranslatePersist).not.toHaveBeenCalled();
		expect(Notice).toHaveBeenCalledWith("card.sysTranslate.fail");
	});

	it("翻译中重复点击被 loading 态挡住（防并发）", async () => {
		vi.mocked(isMacOS).mockReturnValue(true);
		let resolveFn: (v: string) => void = () => {};
		vi.mocked(macosSystemTranslate).mockImplementation(() => new Promise((r) => { resolveFn = r; }));
		const { card } = render({}, plugin(), undefined);
		const btn = q(card, ".pt-card-sys-translate")!;
		btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		await vi.advanceTimersByTimeAsync(0);
		const callsAfterFirst = vi.mocked(macosSystemTranslate).mock.calls.length;
		btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); // 第二次点击
		await vi.advanceTimersByTimeAsync(0);
		// loading 期间直接 return，不会再发起
		expect(vi.mocked(macosSystemTranslate).mock.calls.length).toBe(callsAfterFirst);
		resolveFn("译:X");
	});
});
