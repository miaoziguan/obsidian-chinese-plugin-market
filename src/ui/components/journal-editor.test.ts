import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { renderJournalEditor } from "@ui/components/journal-editor";
import { VERDICT_PRESETS } from "@domain/journal/journal-entry";

// 测试环境补齐 Obsidian 对 HTMLElement 的扩展（createEl / 类操作 / 样式）。
// 幂等：若全局 setup 已注入则跳过。
beforeAll(() => {
	const proto = HTMLElement.prototype as any;
	if (!proto.createEl) {
		proto.createEl = function (tag: string, opts: any = {}) {
			const el = document.createElement(tag);
			if (opts.cls) el.className = opts.cls;
			if (opts.text != null) el.textContent = opts.text;
			if (opts.attr) for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, String(v));
			this.appendChild(el);
			return el;
		};
	}
	if (!proto.createDiv) proto.createDiv = function (o?: any) { return this.createEl("div", o); };
	if (!proto.createSpan) proto.createSpan = function (o?: any) { return this.createEl("span", o); };
	if (!proto.createFragment) proto.createFragment = function () { return document.createDocumentFragment(); };
	if (!proto.addClass) proto.addClass = function (c: string) { this.classList.add(c); };
	if (!proto.removeClass) proto.removeClass = function (c: string) { this.classList.remove(c); };
	if (!proto.toggleClass) proto.toggleClass = function (c: string, on?: boolean) {
		if (on === undefined) this.classList.toggle(c);
		else if (on) this.classList.add(c); else this.classList.remove(c);
	};
	if (!proto.setCssStyles) proto.setCssStyles = function (s: Record<string, string>) {
		for (const [k, v] of Object.entries(s)) (this.style as any)[k] = v;
	};
});

const t = (k: string) => k;

describe("renderJournalEditor（评测台账编辑区）", () => {
	let container: HTMLElement;
	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
	});
	afterEach(() => {
		container.remove();
		vi.useRealTimers();
	});

	it("渲染标题、状态/评分/弃用原因控件与备注框", () => {
		const { dispose } = renderJournalEditor(container, "p1", "插件1", null, {
			t,
			load: async () => null,
			save: () => {},
		});
		expect(container.querySelector(".pt-journal-title")?.textContent).toBe("journal.title");
		// 3 个状态按钮 + 8 个弃用原因预设
		expect(container.querySelectorAll(".pt-journal-chip").length).toBe(3 + VERDICT_PRESETS.length);
		expect(container.querySelectorAll(".pt-journal-star").length).toBe(5);
		expect(container.querySelector("textarea.pt-journal-note")).not.toBeNull();
		dispose();
	});

	it("点击状态按钮 → 防抖后保存（status=using）", () => {
		vi.useFakeTimers();
		const save = vi.fn();
		const { dispose } = renderJournalEditor(container, "p1", "插件1", null, {
			t,
			load: async () => null,
			save,
		});
		const usingBtn = [...container.querySelectorAll<HTMLElement>(".pt-journal-chip")].find(
			(b) => b.textContent === "在用",
		)!;
		usingBtn.click();
		expect(save).not.toHaveBeenCalled(); // 防抖未到
		vi.advanceTimersByTime(500);
		expect(save).toHaveBeenCalledTimes(1);
		expect((save.mock.calls[0][0] as { status?: string }).status).toBe("using");
		dispose();
	});

	it("弃用原因可多选并保存", () => {
		vi.useFakeTimers();
		const save = vi.fn();
		const { dispose } = renderJournalEditor(container, "p1", "插件1", null, {
			t,
			load: async () => null,
			save,
		});
		const chips = [...container.querySelectorAll<HTMLElement>(".pt-journal-chip")];
		const bug = chips.find((b) => b.textContent === "有 bug")!;
		const heavy = chips.find((b) => b.textContent === "太重")!;
		bug.click();
		heavy.click();
		vi.advanceTimersByTime(500);
		const verdict = (save.mock.calls[0][0] as { verdict?: string[] }).verdict;
		expect(verdict).toEqual(expect.arrayContaining(["有 bug", "太重"]));
		dispose();
	});

	it("备注输入防抖保存", () => {
		vi.useFakeTimers();
		const save = vi.fn();
		const { dispose } = renderJournalEditor(container, "p1", "插件1", null, {
			t,
			load: async () => null,
			save,
		});
		const ta = container.querySelector<HTMLTextAreaElement>("textarea.pt-journal-note")!;
		ta.value = "踩坑记录";
		ta.dispatchEvent(new Event("input"));
		vi.advanceTimersByTime(500);
		expect((save.mock.calls[0][0] as { note?: string }).note).toBe("踩坑记录");
		dispose();
	});

	it("事实区按 host.facts 渲染首次安装/卸载/重装", () => {
		const { dispose } = renderJournalEditor(container, "p1", "插件1", null, {
			t,
			load: async () => null,
			save: () => {},
			facts: { firstInstalled: 1000, lastInstalled: 2000, uninstalled: 3000, installCount: 3 },
		});
		const facts = container.querySelector(".pt-journal-facts")?.textContent ?? "";
		expect(facts).toContain("journal.autoFacts");
		expect(facts).toContain("journal.uninstalledAt");
		expect(facts).toContain("journal.installCount");
		dispose();
	});

	it("无评测时控件为空态（状态未按下、星标全灭、备注空）", () => {
		const { dispose } = renderJournalEditor(container, "p1", "插件1", null, {
			t,
			load: async () => null,
			save: () => {},
			facts: {},
		});
		const pressed = [...container.querySelectorAll<HTMLElement>(".pt-journal-chip")].filter(
			(b) => b.getAttribute("aria-pressed") === "true",
		);
		expect(pressed.length).toBe(0);
		expect(container.querySelectorAll(".pt-journal-star.is-on").length).toBe(0);
		expect((container.querySelector("textarea.pt-journal-note") as HTMLTextAreaElement).value).toBe("");
		dispose();
	});
});
