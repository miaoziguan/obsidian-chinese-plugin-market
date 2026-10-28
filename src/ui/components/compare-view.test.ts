import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginInfo } from "@domain/catalog/translator";

/**
 * 对比页渲染器。
 *
 * 它把 N 个插件并排成卡片，并在下方「结论先行」地给出一组信号
 * （下载量差距 / 维护活跃度 / 功能重叠 / 安装状态 / 综合建议）。
 * 这些信号是用户做选择的主要依据，文案与判定条件最容易在重构中被改坏。
 *
 * 另外两个要点：
 *   · 导出菜单是 document 级点击监听——重复渲染必须卸载旧组件，否则监听器累积
 *   · navigator.clipboard 在非安全上下文可能不存在，必须走可读的失败提示
 */

// 命令级信号需要真实拉取 GitHub 仓库，这里隔离掉（另有专门测试）
vi.mock("@domain/compare/plugin-insight", () => ({
	gatherInsightSources: vi.fn(async () => null),
	fetchMainSignals: vi.fn(async () => ({ commands: [] })),
}));

// DOM 实例方法补齐（同 view-toolbar / view-data 测试的既有做法）
function ensureDomHelpers(): void {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	if (!proto.createEl) {
		proto.createEl = function (
			this: HTMLElement,
			tag: string,
			o?: { cls?: string; text?: string; attr?: Record<string, string>; title?: string } | string,
		): HTMLElement {
			const el = document.createElement(tag);
			if (typeof o === "string") el.textContent = o;
			else if (o) {
				if (o.cls) el.className = o.cls;
				if (o.text != null) el.textContent = o.text;
				if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, v);
			}
			this.appendChild(el);
			return el;
		};
	}
	if (!proto.createDiv) {
		proto.createDiv = function (this: HTMLElement, o?: unknown): HTMLElement {
			return (this as unknown as { createEl: (t: string, x?: unknown) => HTMLElement }).createEl("div", o);
		};
	}
	if (!proto.createSpan) {
		proto.createSpan = function (this: HTMLElement, o?: unknown): HTMLElement {
			return (this as unknown as { createEl: (t: string, x?: unknown) => HTMLElement }).createEl("span", o);
		};
	}
	if (!proto.setText) {
		proto.setText = function (this: HTMLElement, text: string): void {
			this.textContent = text;
		};
	}
}
ensureDomHelpers();

let compareModule: typeof import("./compare-view");

beforeEach(async () => {
	vi.clearAllMocks();
	compareModule = await import("./compare-view");
});

const DAY = 86_400_000;

const plugin = (id: string, over: Partial<PluginInfo> = {}): PluginInfo => ({
	id,
	name: `插件${id}`,
	description: `描述${id}`,
	author: "作者",
	...over,
});

const makeTranslator = () =>
	({
		getPluginTag: () => null,
		hasAI: () => false,
		aiCompare: vi.fn(async () => ({})),
		getCompareInsight: vi.fn(() => null),
	}) as never;

const mirror = () => ({ source: "auto", customBase: "" }) as never;

function render(plugins: PluginInfo[], opts: { installed?: string[]; enabled?: string[] } = {}) {
	const container = document.createElement("div");
	const options = { app: {} as never, onBack: vi.fn(), onRemove: vi.fn(), onAdd: vi.fn() };
	compareModule.renderComparePage(
		container,
		plugins,
		makeTranslator(),
		{},
		new Set(opts.installed ?? []),
		new Set(opts.enabled ?? []),
		mirror,
		options,
	);
	return { container, options };
}

describe("renderComparePage：页面骨架", () => {
	it("渲染导航、网格，并与插件数量一致地生成卡片", () => {
		const { container } = render([plugin("a"), plugin("b"), plugin("c")]);

		expect(container.querySelector(".pt-compare-nav")).not.toBeNull();
		expect(container.querySelector(".pt-compare-grid")).not.toBeNull();
		expect(container.querySelectorAll(".pt-compare-card").length).toBe(3);
	});

	it("标题带上参与对比的数量", () => {
		const { container } = render([plugin("a"), plugin("b")]);
		expect(String(container.querySelector(".pt-compare-nav-title")!.textContent)).toContain("2");
	});

	it("重复渲染会先清空容器（不叠加上一页）", () => {
		const { container } = render([plugin("a")]);
		compareModule.renderComparePage(
			container,
			[plugin("a"), plugin("b")],
			makeTranslator(),
			{},
			new Set(),
			new Set(),
			mirror,
			{ app: {} as never, onBack: vi.fn(), onRemove: vi.fn(), onAdd: vi.fn() },
		);

		expect(container.querySelectorAll(".pt-compare-card").length).toBe(2);
	});
});

describe("renderComparePage：导航动作", () => {
	it("返回按钮回调到 onBack", () => {
		const { container, options } = render([plugin("a")]);
		(container.querySelector(".pt-compare-back-btn") as HTMLElement).click();
		expect(options.onBack).toHaveBeenCalled();
	});

	it("添加按钮回调到 onAdd", () => {
		const { container, options } = render([plugin("a")]);
		(container.querySelector(".pt-compare-add-btn") as HTMLElement).click();
		expect(options.onAdd).toHaveBeenCalled();
	});

	it("卡片移除按钮带上对应插件 id", () => {
		const { container, options } = render([plugin("a"), plugin("b")]);
		const removeBtns = container.querySelectorAll(".pt-compare-card-remove");
		(removeBtns[1] as HTMLElement).click();
		expect(options.onRemove).toHaveBeenCalledWith("b");
	});
});

describe("renderComparePage：安装态与链接", () => {
	it("已安装且启用 → 已启用文案", () => {
		const { container } = render([plugin("a")], { installed: ["a"], enabled: ["a"] });
		expect(String(container.querySelector(".pt-compare-card-status")!.textContent)).toContain(
			"已启用",
		);
	});

	it("已安装未启用 → 已安装未启用文案", () => {
		const { container } = render([plugin("a")], { installed: ["a"] });
		expect(String(container.querySelector(".pt-compare-card-status")!.textContent)).toContain(
			"已安装",
		);
	});

	it("未安装 → 给出 obsidian:// 安装深链", () => {
		const { container } = render([plugin("a")]);
		const link = container.querySelector(".pt-compare-card-status--install") as HTMLElement;
		expect(link).not.toBeNull();
		expect(link.getAttribute("href")).toBe("obsidian://show-plugin?id=a");
	});

	it("有 repo 时给出 GitHub 链接，无 repo 时不渲染", () => {
		const withRepo = render([plugin("a", { repo: "owner/repo" })]);
		const link = withRepo.container.querySelector(".pt-compare-card-link") as HTMLElement;
		expect(link.getAttribute("href")).toBe("https://github.com/owner/repo");

		const withoutRepo = render([plugin("b")]);
		expect(withoutRepo.container.querySelector(".pt-compare-card-link")).toBeNull();
	});

	it("更新时间渲染为日期 + 距今天数", () => {
		const { container } = render([plugin("a", { updated: Date.now() - 3 * DAY })]);
		const text = container.textContent ?? "";
		expect(text).toContain("更新时间");
		expect(text).toContain("天前");
	});

	it("下载量经格式化后展示", () => {
		const { container } = render([plugin("a", { downloads: 12345 })]);
		expect(container.textContent).toContain("下载量");
	});
});

describe("renderComparePage：洞察信号", () => {
	it("存在可比较信息时渲染洞察区（结论先行）", () => {
		const { container } = render([
			plugin("a", { downloads: 1000, updated: Date.now() - 2 * DAY }),
			plugin("b", { downloads: 900000, updated: Date.now() - 5 * DAY }),
		]);

		expect(container.querySelector(".pt-compare-insight")).not.toBeNull();
		expect(container.querySelectorAll(".pt-compare-insight-signal").length).toBeGreaterThan(0);
	});

	it("超过 730 天未更新时给出陈旧警告", () => {
		const { container } = render([
			plugin("a", { updated: Date.now() - 800 * DAY }),
			plugin("b", { updated: Date.now() - 2 * DAY }),
		]);

		const warn = container.querySelector(".pt-compare-insight-warn");
		expect(warn).not.toBeNull();
		expect(String(warn!.textContent)).toContain("插件a");
	});

	it("已启用插件会出现在安装状态信号里", () => {
		const { container } = render(
			[plugin("a"), plugin("b", { downloads: 500000 })],
			{ installed: ["a"], enabled: ["a"] },
		);
		expect(container.textContent).toContain("已安装启用在这台设备上");
	});
});

describe("renderComparePage：导出菜单", () => {
	it("点击切换展开/收起，并同步 aria-expanded", () => {
		const { container } = render([plugin("a")]);
		const toggle = container.querySelector(".pt-compare-export-toggle") as HTMLElement;
		const menu = container.querySelector(".pt-compare-export-menu") as HTMLElement;

		toggle.click();
		expect(menu.style.display).toBe("");
		expect(toggle.getAttribute("aria-expanded")).toBe("true");

		toggle.click();
		expect(menu.style.display).toBe("none");
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
	});

	it("点击菜单外部会关闭菜单", () => {
		const { container } = render([plugin("a")]);
		const toggle = container.querySelector(".pt-compare-export-toggle") as HTMLElement;
		const menu = container.querySelector(".pt-compare-export-menu") as HTMLElement;
		toggle.click();

		document.dispatchEvent(new MouseEvent("click", { bubbles: true }));

		expect(menu.style.display).toBe("none");
	});

	it("导出时把 Markdown 写入剪贴板", async () => {
		const writeText = vi.fn(async (_text: string) => {});
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

		const { container } = render([plugin("a"), plugin("b")]);
		const item = container.querySelector(".pt-compare-export-item") as HTMLElement;
		item.click();

		await Promise.resolve();
		expect(writeText).toHaveBeenCalled();
		expect(String(writeText.mock.calls[0][0])).toContain("插件a");
	});

	it("剪贴板不可用时不抛错（走可读的失败提示）", () => {
		Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });

		const { container } = render([plugin("a")]);
		const item = container.querySelector(".pt-compare-export-item") as HTMLElement;

		expect(() => item.click()).not.toThrow();
	});
});

describe("组件生命周期：重复渲染不累积监听器", () => {
	it("disposeComparePage 会卸载组件并执行登记过的清理", () => {
		const { container } = render([plugin("a")]);
		const holder = container as unknown as { _ptComp?: { unload: () => void } };
		const unload = vi.spyOn(holder._ptComp!, "unload");

		compareModule.disposeComparePage(container);

		expect(unload).toHaveBeenCalled();
		expect(holder._ptComp).toBeUndefined();
	});

	it("重复渲染时旧组件被卸载（否则 document 点击监听器持续泄漏）", () => {
		const { container } = render([plugin("a")]);
		const holder = container as unknown as { _ptComp?: { unload: () => void } };
		const first = holder._ptComp!;
		const unload = vi.spyOn(first, "unload");

		render([plugin("a")]); // 新容器，不触发旧的

		compareModule.renderComparePage(
			container,
			[plugin("b")],
			makeTranslator(),
			{},
			new Set(),
			new Set(),
			mirror,
			{ app: {} as never, onBack: vi.fn(), onRemove: vi.fn(), onAdd: vi.fn() },
		);

		expect(unload).toHaveBeenCalled();
	});
});
