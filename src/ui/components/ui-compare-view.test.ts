import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderComparePage, disposeComparePage } from "@ui/components/compare-view";
import { compareTagsMulti, compareCommandsMulti } from "@domain/compare/compare";
import { fetchMainSignals, gatherInsightSources } from "@domain/compare/plugin-insight";
import { MarkdownRenderer, Notice, App } from "obsidian";
import type { Translator } from "@domain/catalog/translator";
import type { PluginInfo } from "@domain/catalog/translator";

/**
 * 补 ui/components/compare-view.ts（此前 70.2%，行 36-637 对比模式页面渲染器）。
 * 它用到大量 @domain/* 重逻辑（视图模型构建 / 标签与命令交集 / 洞察信号 / 异步拉取 main.js 命令 / AI 深度对比），
 * 全部换 mock；容器用实例级 helper 补齐 obsidian 在 jsdom 下缺失的 createDiv/createEl/setCssStyles/empty。
 * translator 由测试注入（hasAI/getCompareInsight/aiCompare/getPluginTag），不依赖插件实例。
 *
 * 错误模式「进入对比页 document 级 click 监听泄漏（每次进入累积）」「AI 区无 key 时按钮仍可点」
 * 「导出 Markdown 在无 clipboard 环境崩溃」「命令级信号在插件无 repo 时仍去拉取」「依赖齐的洞察区被渲染」。
 *
 * 本文件自包含，不依赖插件实例；本轮绝不碰已有测试文件。
 */

const h = vi.hoisted(() => ({ vms: [] as Array<Record<string, unknown>> }));

vi.mock("obsidian", () => {
	class ComponentMock {
		private cbs: Array<() => void> = [];
		register(cb: () => void) {
			this.cbs.push(cb);
		}
		unload() {
			this.cbs.forEach((f) => f());
		}
	}
	const Notice = vi.fn();
	const MarkdownRenderer = { render: vi.fn(async () => {}) };
	const App = class {};
	return { Component: ComponentMock, Notice, MarkdownRenderer, App };
});
vi.mock("@domain/catalog/plugin-vm", () => ({ buildPluginViewModels: vi.fn(() => h.vms.slice()) }));
vi.mock("@domain/compare/compare", () => ({
	compareTagsMulti: vi.fn(() => ({ common: [], only: [] })),
	compareCommandsMulti: vi.fn(() => ({ common: [], only: [] })),
}));
vi.mock("@domain/compare/plugin-insight", () => ({
	gatherInsightSources: vi.fn(async () => ({ readme: "" })),
	fetchMainSignals: vi.fn(async () => ({ mainSignals: { commands: [] }, manifest: { dependencies: {} }, readme: "" })),
}));
vi.mock("@domain/catalog/stats", () => ({ formatDownloads: (n: number) => String(n) }));
vi.mock("@domain/catalog/official-tags", () => ({ formatOfficialTag: (t: string) => t }));
vi.mock("@domain/compare/compare-export", () => ({ renderCompareMarkdown: vi.fn(() => "# md") }));
vi.mock("@ui/dom/dom", () => ({ appendSVG: vi.fn() }));

const mocked = {
	compareTagsMulti: vi.mocked(compareTagsMulti),
	compareCommandsMulti: vi.mocked(compareCommandsMulti),
	fetchMainSignals: vi.mocked(fetchMainSignals),
	gatherInsightSources: vi.mocked(gatherInsightSources),
	MarkdownRenderer: vi.mocked(MarkdownRenderer),
	Notice: vi.mocked(Notice),
};

function withHelpers(el: HTMLElement) {
	const n = el as unknown as Record<string, unknown>;
	const add = (child: HTMLElement) => withHelpers(child);
	n.empty = function (this: HTMLElement) {
		while (this.firstChild) this.removeChild(this.firstChild);
		return this;
	};
	n.addClass = function (this: HTMLElement, cls: string) {
		this.classList.add(cls);
		return this;
	};
	n.createDiv = function (this: HTMLElement, opts: { cls?: string; text?: string } = {}) {
		const e = document.createElement("div");
		if (opts.cls) e.className = opts.cls;
		if (opts.text) e.textContent = opts.text;
		this.appendChild(e);
		return add(e);
	};
	n.createSpan = function (this: HTMLElement, opts: { cls?: string; text?: string } = {}) {
		const e = document.createElement("span");
		if (opts.cls) e.className = opts.cls;
		if (opts.text) e.textContent = opts.text;
		this.appendChild(e);
		return add(e);
	};
	n.createEl = function (
		this: HTMLElement,
		tag: string,
		opts: { cls?: string; text?: string; attr?: Record<string, string> } = {}
	) {
		const e = document.createElement(tag);
		if (opts.cls) e.className = opts.cls;
		if (opts.text) e.textContent = opts.text;
		if (opts.attr) for (const k of Object.keys(opts.attr)) e.setAttribute(k, opts.attr[k]);
		this.appendChild(e);
		return add(e);
	};
	n.setCssStyles = function (this: HTMLElement, styles: Record<string, string>) {
		for (const k of Object.keys(styles)) this.style.setProperty(k, styles[k]);
		return this;
	};
	n.setText = function (this: HTMLElement, t: string) {
		this.textContent = t;
		return this;
	};
	return el;
}

function mkVm(id: string, name: string, over: Record<string, unknown> = {}) {
	return {
		id,
		name,
		nameEn: name + "EN",
		desc: `desc ${name}`,
		info: { repo: `owner/${id}`, author: "au", downloads: 100, updated: Date.now() },
		tag: { category: "cat", tags: ["t1", "t2"] },
		...over,
	};
}

function mkTranslator(over: Partial<Translator> = {}): Translator {
	return {
		hasAI: vi.fn(() => false),
		getCompareInsight: vi.fn(() => null),
		aiCompare: vi.fn(async () => "# ai"),
		getPluginTag: vi.fn(() => null),
		...over,
	} as unknown as Translator;
}

const flush = async () => {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await new Promise((r) => window.setTimeout(r, 0));
};

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

beforeEach(() => {
	vi.clearAllMocks();
	h.vms = [];
	mocked.compareTagsMulti.mockReturnValue({ common: [], only: [] });
	mocked.compareCommandsMulti.mockReturnValue({ common: [], only: [] });
	mocked.fetchMainSignals.mockResolvedValue({
		commands: [],
		manifest: { dependencies: {} },
		readme: "",
	} as never);
	mocked.gatherInsightSources.mockResolvedValue({
		readme: "",
		mainSignals: { commands: [] },
		manifest: { dependencies: {} },
	} as never);
});

function render(opts: {
	container: HTMLElement;
	vms: Array<Record<string, unknown>>;
	translator: Translator;
	installed?: Set<string>;
	enabled?: Set<string>;
	onBack?: () => void;
	onRemove?: (id: string) => void;
	onAdd?: () => void;
	mirrorConfig?: () => unknown;
}) {
	h.vms = opts.vms;
	const plugins = opts.vms.map((v) => ({ id: v.id })) as PluginInfo[];
	const container = opts.container;
	renderComparePage(
		container,
		plugins,
		opts.translator,
		{},
		opts.installed ?? new Set<string>(),
		opts.enabled ?? new Set<string>(),
		(opts.mirrorConfig ?? (() => ({}))) as never,
		{
			app: {} as unknown as App,
			onBack: opts.onBack ?? vi.fn(),
			onRemove: opts.onRemove ?? vi.fn(),
			onAdd: opts.onAdd ?? vi.fn(),
		}
	);
}

describe("renderComparePage（compare-view.ts 主体）", () => {
	it("渲染导航 + 每张插件一个卡片（60-166）", () => {
		const container = withHelpers(document.createElement("div"));
		const onBack = vi.fn();
		const onRemove = vi.fn();
		const onAdd = vi.fn();
		render({
			container,
			vms: [mkVm("a", "A"), mkVm("b", "B")],
			translator: mkTranslator(),
			onBack,
			onRemove,
			onAdd,
		});
		expect(container.querySelectorAll(".pt-compare-card").length).toBe(2);
		expect(container.querySelector(".pt-compare-back-btn")).toBeTruthy();
		// 导航按钮接线
		(container.querySelector(".pt-compare-back-btn") as HTMLButtonElement).click();
		(container.querySelector(".pt-compare-add-btn") as HTMLButtonElement).click();
		expect(onBack).toHaveBeenCalled();
		expect(onAdd).toHaveBeenCalled();
	});

	it("有 repo → GitHub 链接；移除按钮回调对应 id（134-166）", () => {
		const container = withHelpers(document.createElement("div"));
		const onRemove = vi.fn();
		const vms = [mkVm("a", "A", { info: { repo: "owner/a", author: "au", downloads: 1, updated: Date.now() } })];
		render({ container, vms, translator: mkTranslator(), onRemove });
		expect(container.querySelector(".pt-compare-card-link")?.getAttribute("href")).toContain("owner/a");
		(container.querySelector(".pt-compare-card-remove") as HTMLButtonElement).click();
		expect(onRemove).toHaveBeenCalledWith("a");
	});

	it("无 repo → 不渲染仓库链接（134-143）", () => {
		const container = withHelpers(document.createElement("div"));
		const vms = [mkVm("a", "A", { info: { author: "au", downloads: 1 } })];
		render({ container, vms, translator: mkTranslator() });
		expect(container.querySelector(".pt-compare-card-link")).toBeNull();
	});

	it("安装态：已装已启用/已装未启用/未装 三分支（146-159）", () => {
		const container = withHelpers(document.createElement("div"));
		const vms = [
			mkVm("on", "On"),
			mkVm("off", "Off"),
			mkVm("no", "No", { info: { repo: "o/no", author: "au", downloads: 1, updated: Date.now() } }),
		];
		const installed = new Set(["on", "off"]);
		const enabled = new Set(["on"]);
		render({ container, vms, translator: mkTranslator(), installed, enabled });
		// 已装已启用 → installed 状态；未装 → install 链接
		expect(container.querySelector(".pt-compare-card-status--installed")).toBeTruthy();
		expect(container.querySelector(".pt-compare-card-status--install")).toBeTruthy();
	});

	it("有 tag/desc/分类/更新时间/作者 → 对应行渲染（171-206）", () => {
		const container = withHelpers(document.createElement("div"));
		const vms = [mkVm("a", "A", {
			info: { repo: "o/a", author: "Bob", downloads: 5, updated: Date.now() - 86400000 },
			tag: { category: "社交", tags: ["x", "y"] },
			desc: "hello",
		})];
		render({ container, vms, translator: mkTranslator() });
		const text = container.querySelector(".pt-compare-card-body")?.textContent ?? "";
		expect(text).toContain("Bob");
		expect(text).toContain("社交");
		expect(text).toContain("5");
		expect(text).toContain("hello");
		expect(container.querySelector(".pt-compare-card-tags")?.textContent).toContain("x");
	});

	it("无 tag / 无 desc → 跳过对应行（178-206）", () => {
		const container = withHelpers(document.createElement("div"));
		const vms = [mkVm("a", "A", { tag: undefined, desc: undefined, info: { repo: "o/a", author: "au", downloads: 1, updated: Date.now() } })];
		render({ container, vms, translator: mkTranslator() });
		expect(container.querySelector(".pt-compare-card-tags")).toBeNull();
		expect(container.querySelector(".pt-compare-card-desc")).toBeNull();
	});

	it("导出菜单：toggle 展开、点 Markdown 项触发导出并收起（93-113）", () => {
		const container = withHelpers(document.createElement("div"));
		render({ container, vms: [mkVm("a", "A")], translator: mkTranslator() });
		const toggle = container.querySelector(".pt-compare-export-toggle") as HTMLButtonElement;
		const menu = container.querySelector(".pt-compare-export-menu") as HTMLElement;
		toggle.click();
		expect(menu.style.display).toBe(""); // 展开
		(container.querySelector(".pt-compare-export-item") as HTMLButtonElement).click();
		expect(menu.style.display).toBe("none"); // 收起
	});

	it("导出无 clipboard → 弹失败 Notice 不崩溃（629-631）", () => {
		const container = withHelpers(document.createElement("div"));
		render({ container, vms: [mkVm("a", "A")], translator: mkTranslator() });
		(container.querySelector(".pt-compare-export-item") as HTMLButtonElement).click();
		expect(mocked.Notice).toHaveBeenCalled();
	});

	it("导出成功：stub clipboard → 复制完成 Notice（633-636）", () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		const container = withHelpers(document.createElement("div"));
		render({ container, vms: [mkVm("a", "A")], translator: mkTranslator() });
		(container.querySelector(".pt-compare-export-item") as HTMLButtonElement).click();
		expect(writeText).toHaveBeenCalled();
	});

	it("无洞察信号且无建议 → 不渲染洞察区（243）", async () => {
		const container = withHelpers(document.createElement("div"));
		// common 非空但重叠占比 <30% → overlapSignal 返回 null；其余信号在单插件下均为 null
		mocked.compareTagsMulti.mockReturnValue({ common: ["x"], only: [["a", "b", "c"]] });
		render({ container, vms: [mkVm("a", "A")], translator: mkTranslator() });
		await flush();
		expect(container.querySelector(".pt-compare-insight")).toBeNull();
	});

	it("有标签交集信号 → 渲染洞察区（243-249）", () => {
		const container = withHelpers(document.createElement("div"));
		mocked.compareTagsMulti.mockReturnValue({ common: ["t1"], only: [["a"], ["b"]] });
		render({ container, vms: [mkVm("a", "A"), mkVm("b", "B")], translator: mkTranslator() });
		expect(container.querySelector(".pt-compare-insight")).toBeTruthy();
		expect(container.querySelector(".pt-compare-insight-signal")).toBeTruthy();
	});

	it("陈旧插件（更新 > 2 年）→ 渲染过期告警（258-268）", () => {
		const container = withHelpers(document.createElement("div"));
		const vms = [mkVm("a", "A", { info: { repo: "o/a", author: "au", downloads: 1, updated: Date.now() - 800 * 86400000 } })];
		render({ container, vms, translator: mkTranslator() });
		expect(container.querySelector(".pt-compare-insight-warn")?.textContent).toContain("A");
	});

	it("AI 区：无 key → 按钮禁用并带 badge（363-381）", () => {
		const container = withHelpers(document.createElement("div"));
		render({ container, vms: [mkVm("a", "A")], translator: mkTranslator({ hasAI: () => false }) });
		const btn = container.querySelector(".pt-compare-ai-btn") as HTMLButtonElement;
		expect(btn.disabled).toBe(true);
		expect(container.querySelector(".pt-compare-ai-label-badge")).toBeTruthy();
	});

	it("AI 区：有 key → 点击触发 AI 对比并渲染 Markdown（388-453）", async () => {
		const container = withHelpers(document.createElement("div"));
		const translator = mkTranslator({ hasAI: () => true, aiCompare: vi.fn(async () => "# 对比结果") });
		render({ container, vms: [mkVm("a", "A")], translator });
		const btn = container.querySelector(".pt-compare-ai-btn") as HTMLButtonElement;
		expect(btn.disabled).toBe(false);
		btn.click();
		await flush();
		expect(translator.aiCompare).toHaveBeenCalled();
		expect(mocked.MarkdownRenderer.render).toHaveBeenCalled();
	});

	it("AI 区：命中缓存 → 直接渲染、不拉网络（415-416）", async () => {
		const container = withHelpers(document.createElement("div"));
		const translator = mkTranslator({
			hasAI: () => true,
			getCompareInsight: vi.fn(() => "# cached"),
			aiCompare: vi.fn(async () => "# fresh"),
		});
		render({ container, vms: [mkVm("a", "A")], translator });
		(container.querySelector(".pt-compare-ai-btn") as HTMLButtonElement).click();
		await flush();
		expect(translator.aiCompare).not.toHaveBeenCalled();
		expect(mocked.MarkdownRenderer.render).toHaveBeenCalled();
	});

	it("AI 区：aiCompare 抛错 → 渲染错误框 + 重试按钮（454-469）", async () => {
		const container = withHelpers(document.createElement("div"));
		const translator = mkTranslator({
			hasAI: () => true,
			aiCompare: vi.fn(async () => {
				throw new Error("boom");
			}),
		});
		render({ container, vms: [mkVm("a", "A")], translator });
		(container.querySelector(".pt-compare-ai-btn") as HTMLButtonElement).click();
		await flush();
		expect(container.querySelector(".pt-compare-ai-error")).toBeTruthy();
		expect(container.querySelector(".pt-compare-ai-retry")).toBeTruthy();
	});

	it("AI 区：取消按钮 → 中止并提示已取消（407-446）", async () => {
		// fetch 立即完成、aiCompare 带延迟：取消命中第二个 aborted 检查，才渲染「已取消」
		mocked.gatherInsightSources.mockResolvedValue({
			readme: "",
			mainSignals: { commands: [] },
			manifest: { dependencies: {} },
		} as never);
		const container = withHelpers(document.createElement("div"));
		const translator = mkTranslator({
			hasAI: () => true,
			aiCompare: vi.fn(async () => {
				await sleep(5);
				return "# ai";
			}),
		});
		render({ container, vms: [mkVm("a", "A")], translator });
		const btn = container.querySelector(".pt-compare-ai-btn") as HTMLButtonElement;
		btn.click();
		await flush(); // 让 fetch 完成、runCompare 进入 aiCompare 等待
		(container.querySelector(".pt-compare-ai-cancel") as HTMLButtonElement)?.click();
		await sleep(20);
		expect(container.querySelector(".pt-compare-ai-cancelled")).toBeTruthy();
		expect(mocked.MarkdownRenderer.render).not.toHaveBeenCalled();
	});

	it("命令级信号：有 repo 且抽到命令 → 追加命令信号区（527-576）", async () => {
		const container = withHelpers(document.createElement("div"));
		mocked.fetchMainSignals.mockResolvedValue({
			commands: [{ name: "cmd1" }],
			manifest: { dependencies: {} },
			readme: "",
		} as never);
		mocked.compareCommandsMulti.mockReturnValue({ common: [], only: [["cmd1"], ["cmd1"]] });
		render({ container, vms: [mkVm("a", "A"), mkVm("b", "B")], translator: mkTranslator() });
		await flush();
		await sleep(10);
		expect(container.querySelector(".pt-compare-commands-signal")).toBeTruthy();
	});

	it("命令级信号：某插件无 repo → 跳过拉取（537）", async () => {
		const container = withHelpers(document.createElement("div"));
		const vms = [mkVm("a", "A", { info: { author: "au", downloads: 1, updated: Date.now() } }), mkVm("b", "B")];
		render({ container, vms, translator: mkTranslator() });
		await flush();
		expect(mocked.fetchMainSignals).not.toHaveBeenCalled();
		expect(container.querySelector(".pt-compare-commands-signal")).toBeNull();
	});

	it("disposeComparePage → 卸载 Component 生命周期资源（36-43）", () => {
		const container = withHelpers(document.createElement("div"));
		render({ container, vms: [mkVm("a", "A")], translator: mkTranslator() });
		expect(() => disposeComparePage(container)).not.toThrow();
		// 再次 dispose 安全（prev 已 undefined）
		expect(() => disposeComparePage(container)).not.toThrow();
	});
});
