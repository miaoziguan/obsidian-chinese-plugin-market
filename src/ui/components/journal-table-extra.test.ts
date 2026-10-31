import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import {
	renderJournalTable,
	sortJournalRows,
	type JournalRow,
	type JournalTableHost,
} from "@ui/components/journal-table";
import type { I18nKey } from "@shared/i18n";

/**
 * 专门补 journal-table.ts 里 renderJournalTable（167-352，约 185 行）的缺口。
 *
 * 既有 journal-table.test.ts 只测了纯函数（filterJournalRows / sortJournalRows /
 * journalRowsToMarkdown / composeBilingualName），DOM 渲染与全部交互（搜索、状态胶囊、
 * 原因下拉、复制 markdown、表头排序、点名跳详情、点行展开详情、估算时间标记、rerender）
 * 一行都没跑到；sortJournalRows 也漏了 status / firstInstalled 两个 case。
 *
 * 错误模式是「表格看着对但点了没反应 / 筛选组合失灵 / 复制静默失败」，而非崩溃。
 */

// createMenuSelect 会依赖原生 Menu 的表现，这里换成桩以便直接触发 onPick 回调
const menuSelectStub = vi.hoisted(() => ({
	last: null as null | {
		getOptions: () => { value: string; label: string }[];
		getValue: () => string;
		onPick: (v: string) => void;
	},
}));
vi.mock("@ui/components/menu-select", () => ({
	createMenuSelect: (_ctrl: unknown, opts: unknown) => {
		menuSelectStub.last = opts as typeof menuSelectStub.last;
		return { destroy: () => {} };
	},
}));

beforeAll(() => {
	// 沿用既有测试的补齐方式：Obsidian 在 HTMLElement.prototype 注入的方法，
	// 测试环境只有全局函数（createEl/createDiv/createSpan），实例方法需在此补上。
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	if (!proto.createEl) {
		proto.createEl = function (this: HTMLElement, tag: string, o: Record<string, unknown> = {}) {
			const el = document.createElement(tag);
			if (o.cls) el.className = String(o.cls);
			if (o.text != null) el.textContent = String(o.text);
			if (o.href) el.setAttribute("href", String(o.href));
			if (o.attr) {
				for (const [k, v] of Object.entries(o.attr as Record<string, unknown>)) {
					el.setAttribute(k, String(v));
				}
			}
			this.appendChild(el);
			return el;
		};
	}
	if (!proto.createDiv) {
		proto.createDiv = function (this: HTMLElement, o?: Record<string, unknown>) {
			return (this as unknown as { createEl: (t: string, o?: Record<string, unknown>) => HTMLElement }).createEl("div", o);
		};
	}
	if (!proto.createSpan) {
		proto.createSpan = function (this: HTMLElement, o?: Record<string, unknown>) {
			return (this as unknown as { createEl: (t: string, o?: Record<string, unknown>) => HTMLElement }).createEl("span", o);
		};
	}
	// Obsidian 的 setText（复制按钮改文案用它），jsdom 原生没有
	if (!proto.setText) {
		proto.setText = function (this: HTMLElement, s: string) {
			this.textContent = s;
			return this;
		};
	}
});

// i18n：key 原样返回，断言直接写 key
const keepKey = ((k: I18nKey) => k as string) as unknown as (k: I18nKey) => string;

function mkHost(over: Partial<JournalTableHost> = {}): JournalTableHost {
	return { t: keepKey, onOpen: vi.fn(), ...over } as JournalTableHost;
}

const row = (id: string, over: Partial<JournalRow> = {}): JournalRow => ({
	id,
	name: `插件${id}`,
	status: "using",
	rating: 4,
	firstInstalled: Date.UTC(2024, 0, Number(id.slice(-1)) || 1),
	lastActive: Date.UTC(2024, 5, Number(id.slice(-1)) || 1),
	note: `备注${id}`,
	...over,
});

function render(rows: JournalRow[], over: Partial<JournalTableHost> = {}) {
	const parent = document.createElement("div");
	document.body.appendChild(parent);
	const host = mkHost(over);
	const api = renderJournalTable(parent, rows, host);
	const wrap = parent.querySelector<HTMLElement>(".pt-journal-table-wrap")!;
	const q = <T extends Element = HTMLElement>(sel: string) => wrap.querySelector<T>(sel);
	const qa = (sel: string) => Array.from(wrap.querySelectorAll(sel));
	return { parent, host, api, wrap, q, qa };
}

/** 取第 i 行的数据单元格（行内顺序：名/状态/评分/首装/最近/卸载/原因/备注） */
const cells = (tr: Element): HTMLElement[] => Array.from(tr.querySelectorAll("td"));
const dataRows = (wrap: HTMLElement) => Array.from(wrap.querySelectorAll(".pt-journal-tr"));

beforeEach(() => {
	vi.useFakeTimers();
	if (!(navigator as unknown as { clipboard?: unknown }).clipboard) {
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText: vi.fn().mockResolvedValue(undefined) },
			configurable: true,
			writable: true,
		});
	}
});

afterEach(() => {
	vi.useRealTimers();
	document.body.innerHTML = "";
});

const click = (el: Element) => {
	el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
};

describe("sortJournalRows：补 status / firstInstalled 两个缺失分支", () => {
	it("按状态排序：using > abandoned > watching > 无状态", () => {
		const rows = [
			row("a", { status: undefined }),
			row("b", { status: "watching" }),
			row("c", { status: "abandoned" }),
			row("d", { status: "using" }),
		];
		expect(sortJournalRows(rows, "status", true).map((r) => r.id)).toEqual(["d", "c", "b", "a"]);
		expect(sortJournalRows(rows, "status", false).map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
	});

	it("按首次安装时间排序，且缺失值按 0 参与比较（不会因为 undefined 抖动）", () => {
		const rows = [
			row("a", { firstInstalled: Date.UTC(2024, 2, 1) }),
			row("b", { firstInstalled: undefined }),
			row("c", { firstInstalled: Date.UTC(2023, 2, 1) }),
		];
		expect(sortJournalRows(rows, "firstInstalled", true).map((r) => r.id)).toEqual(["b", "c", "a"]);
		expect(sortJournalRows(rows, "firstInstalled", false).map((r) => r.id)).toEqual(["a", "c", "b"]);
	});
});

describe("renderJournalTable：骨架与筛选交互", () => {
	it("初次渲染：控制条 + 8 列表头 + 数据行", () => {
		const { wrap, q, qa } = render([row("a"), row("b")]);
		expect(wrap).toBeTruthy();
		expect(q(".pt-journal-ctrl")).toBeTruthy();
		expect(q<HTMLInputElement>(".pt-journal-search")!.placeholder).toBe("journal.search");
		expect(qa(".pt-journal-status").length).toBe(5); // all/using/abandoned/watching/tried
		expect(q(".pt-journal-copy")).toBeTruthy();
		// 6 个可排序列 + 原因 + 备注
		expect(qa("th").length).toBe(8);
		expect(dataRows(wrap).length).toBe(2);
	});

	it("空数据 → 显示空提示且不建表格（避免空表头误导）", () => {
		const { q } = render([]);
		expect(q(".pt-empty-hint")!.textContent).toBe("journal.emptyFilter");
		expect(q(".pt-journal-table")).toBeNull();
	});

	it("搜索：输入即时过滤，命中名称/ID/备注", () => {
		const { wrap, q } = render([row("a"), row("b")]);
		const input = q<HTMLInputElement>(".pt-journal-search")!;
		input.value = "备注b";
		input.dispatchEvent(new Event("input"));
		expect(dataRows(wrap).length).toBe(1);
		expect(cells(dataRows(wrap)[0])[0].textContent).toBe("插件b");
	});

	it("搜索无命中 → 回落空提示", () => {
		const { wrap, q } = render([row("a")]);
		const input = q<HTMLInputElement>(".pt-journal-search")!;
		input.value = "不存在的关键词";
		input.dispatchEvent(new Event("input"));
		expect(dataRows(wrap).length).toBe(0);
		expect(wrap.querySelector(".pt-empty-hint")).toBeTruthy();
	});

	it("状态胶囊：点击后 aria-pressed 更新 + 按状态过滤", () => {
		const rows = [row("a", { status: "using" }), row("b", { status: "abandoned" })];
		const { wrap, qa } = render(rows);
		const chips = qa(".pt-journal-status") as HTMLElement[];
		expect(chips.map((c) => c.getAttribute("aria-pressed"))).toEqual(["true", "false", "false", "false", "false"]);
		click(chips[2]); // abandoned
		const left = dataRows(wrap);
		expect(left.length).toBe(1);
		expect(cells(left[0])[1].textContent).toBe("journal.status.abandoned");
		// 重绘后胶囊自身的选中态同步
		expect((qa(".pt-journal-status") as HTMLElement[])[2].getAttribute("aria-pressed")).toBe("true");
	});

	it("原因下拉：getOptions/getValue/onPick 生效，且清空选择恢复全部", () => {
		const rows = [
			row("a", { verdict: ["卡顿"] }),
			row("b", { verdict: ["广告"] }),
			row("c", { verdict: undefined }),
		];
		const { wrap } = render(rows);
		expect(menuSelectStub.last).not.toBeNull();
		const opts = menuSelectStub.last!.getOptions();
		expect(opts[0]).toEqual({ value: "", label: "journal.verdictAll" });
		expect(menuSelectStub.last!.getValue()).toBe("");

		menuSelectStub.last!.onPick("卡顿");
		expect(menuSelectStub.last!.getValue()).toBe("卡顿");
		expect(dataRows(wrap).map((r) => cells(r)[0].textContent)).toEqual(["插件a"]);

		menuSelectStub.last!.onPick("");
		expect(menuSelectStub.last!.getValue()).toBe("");
		expect(dataRows(wrap).length).toBe(3);
	});
});

describe("renderJournalTable：复制为 Markdown", () => {
	it("复制成功 → 写剪贴板 + 文案变 copyDone，1.5s 后自动复原", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true, writable: true });
		const { wrap, q } = render([row("a")]);
		const btn = q(".pt-journal-copy")!;
		click(btn);
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(writeText).toHaveBeenCalledTimes(1);
		expect(writeText.mock.calls[0][0]).toContain("|");
		expect(btn.textContent).toBe("journal.copyDone");
		vi.advanceTimersByTime(1600);
		expect(btn.textContent).toBe("journal.copy");
		expect(wrap).toBeTruthy();
	});

	it("复制失败 → 文案变 copyFail（不静默吞掉），1.5s 后复原", async () => {
		const writeText = vi.fn().mockRejectedValue(new Error("denied"));
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true, writable: true });
		const { q } = render([row("a")]);
		const btn = q(".pt-journal-copy")!;
		click(btn);
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(btn.textContent).toBe("journal.copyFail");
		vi.advanceTimersByTime(1600);
		expect(btn.textContent).toBe("journal.copy");
	});
});

describe("renderJournalTable：排序与行交互", () => {
	it("表头点击切换排序：换列重置方向（名称默认升序）、同列再点取反，并用 ↑↓ 标注", () => {
		const { wrap } = render([row("a"), row("b")]);
		const ths = () => Array.from(wrap.querySelectorAll("th")) as HTMLElement[];
		// 默认 lastActive 降序
		expect(ths()[4].textContent).toBe("journal.col.active↓");
		// 点评分列 → sortKey=rating，非名称列默认降序
		click(ths()[2]);
		expect(ths()[2].textContent).toBe("journal.col.rating↓");
		// 同列再点 → 取反为升序
		click(Array.from(wrap.querySelectorAll("th"))[2]);
		expect(ths()[2].textContent).toBe("journal.col.rating↑");
		// 点名称列 → 默认升序
		click(Array.from(wrap.querySelectorAll("th"))[0]);
		expect(ths()[0].textContent).toBe("journal.col.name↑");
	});

	it("点名字 → 触发 host.onOpen 跳详情，且不顺带展开行", () => {
		const { wrap, host } = render([row("a")]);
		const nameTd = cells(dataRows(wrap)[0])[0];
		expect(nameTd.classList.contains("pt-journal-name")).toBe(true);
		click(nameTd);
		expect(host.onOpen as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("a");
		// 名字单元格被 early return，不应展开
		expect(wrap.querySelector(".pt-journal-detail-row")).toBeNull();
	});

	it("点非名字单元格 → 原地展开/收起 inline 详情（点名字走 onOpen，不冲突）", () => {
		const { wrap } = render([row("a", { verdict: ["卡顿"], note: "备注a" })]);
		const statusTd = cells(dataRows(wrap)[0])[1];
		click(statusTd);
		const detail = wrap.querySelector<HTMLElement>(".pt-journal-detail-row");
		expect(detail).toBeTruthy();
		expect(detail!.querySelector(".pt-journal-detail-verdict")!.textContent).toContain("卡顿");
		expect(detail!.querySelector(".pt-journal-detail-rating")!.textContent).toContain("★★★★");
		expect(detail!.querySelector(".pt-journal-detail-note")!.textContent).toBe("备注a");
		// 再点一次同一格 → 收起
		click(cells(dataRows(wrap)[0])[1]);
		expect(wrap.querySelector(".pt-journal-detail-row")).toBeNull();
	});

	it("估算时间：加「≈」前缀并用原生 tooltip 说明来源（避免把推断值当精确时间）", () => {
		const { wrap } = render([row("a", { estimated: true })]);
		const rowCells = cells(dataRows(wrap)[0]);
		expect(rowCells[3].textContent!.startsWith("≈")).toBe(true);
		expect(rowCells[3].getAttribute("title")).toBe("journal.estimated");
		expect(rowCells[4].textContent!.startsWith("≈")).toBe(true);
		expect(rowCells[4].getAttribute("title")).toBe("journal.estimated");
	});

	it("缺失值统一显示占位：无评分/无备注/无原因/未卸载都为「—」，估算位除外", () => {
		const { wrap } = render([row("a", { rating: undefined, note: undefined, verdict: undefined, uninstalled: null })]);
		const c = cells(dataRows(wrap)[0]);
		expect(c[2].textContent).toBe("—");
		expect(c[5].textContent).toBe("—");
		expect(c[6].textContent).toBe("—");
		expect(c[7].textContent).toBe("—");
	});

	it("备注单元格带原生 title（CSS 单行省略时 hover 可看全文）", () => {
		const { wrap } = render([row("a", { note: "很长的备注".repeat(5) })]);
		const noteTd = cells(dataRows(wrap)[0])[7];
		expect(noteTd.getAttribute("title")).toBe("很长的备注".repeat(5));
	});

	it("rerender：用新数据整体重绘（换 tab / 外部数据刷新场景）", () => {
		const { wrap, api } = render([row("a")]);
		expect(dataRows(wrap).length).toBe(1);
		api.rerender([row("a"), row("b"), row("c")]);
		expect(dataRows(wrap).length).toBe(3);
		api.rerender([]);
		expect(dataRows(wrap).length).toBe(0);
		expect(wrap.querySelector(".pt-empty-hint")).toBeTruthy();
	});
});
