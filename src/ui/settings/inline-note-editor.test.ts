import { describe, it, expect, afterEach } from "vitest";
import { renderInlineNoteEditor } from "./inline-note-editor";

function mount(value = ""): { host: HTMLElement; saved: string[] } {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const saved: string[] = [];
	renderInlineNoteEditor(host, {
		value,
		placeholder: "输入备注",
		emptyText: "点击添加备注",
		onSave: (v) => saved.push(v),
	});
	return { host, saved };
}

function enterEdit(host: HTMLElement): HTMLTextAreaElement {
	host.click();
	const input = host.querySelector("textarea");
	if (!input) throw new Error("未进入编辑态");
	return input;
}

afterEach(() => {
	document.body.innerHTML = "";
});

describe("renderInlineNoteEditor", () => {
	it("空值展示空态文案，有值展示备注", () => {
		expect(mount().host.querySelector(".cpm-note-empty")?.textContent).toBe("点击添加备注");
		expect(mount("常用").host.querySelector(".cpm-note-text")?.textContent).toBe("常用");
	});

	it("点击进入编辑态", () => {
		const { host } = mount();
		expect(() => enterEdit(host)).not.toThrow();
	});

	it("普通 Enter 提交并退出编辑", () => {
		const { host, saved } = mount();
		const input = enterEdit(host);
		input.value = "写作工具";
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		expect(saved).toEqual(["写作工具"]);
		expect(host.querySelector("textarea")).toBeNull();
	});

	it("输入法组合态（中文选词）按 Enter 不提交、不退出", () => {
		const { host, saved } = mount();
		const input = enterEdit(host);
		input.value = "写作工具";
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true }));
		expect(saved).toEqual([]);
		expect(host.querySelector("textarea")).not.toBeNull();
	});

	it("Shift+Enter 视为换行，不提交", () => {
		const { host, saved } = mount();
		const input = enterEdit(host);
		input.value = "a";
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true }));
		expect(saved).toEqual([]);
		expect(host.querySelector("textarea")).not.toBeNull();
	});

	it("Esc 取消编辑且丢弃改动", () => {
		const { host, saved } = mount("原始");
		const input = enterEdit(host);
		input.value = "改了";
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expect(saved).toEqual([]);
		expect(host.querySelector(".cpm-note-text")?.textContent).toBe("原始");
	});
});
