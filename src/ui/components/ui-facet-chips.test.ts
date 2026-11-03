import { describe, it, expect, vi } from "vitest";
import { renderFacetChips } from "./facet-chips";

// 自包含容器：仅实现函数所需的 empty()/createEl()，其余用真实 DOM
function makeContainer() {
	const root = document.createElement("div");
	return {
		root,
		empty: () => {
			root.innerHTML = "";
		},
		createEl: (tag: string, attrs?: Record<string, unknown>) => {
			const el = document.createElement(tag);
			if (attrs?.cls) el.className = attrs.cls as string;
			if (attrs?.text) el.textContent = attrs.text as string;
			if (attrs?.attr) for (const [k, v] of Object.entries(attrs.attr as Record<string, unknown>)) el.setAttribute(k, String(v));
			root.appendChild(el);
			return el;
		},
	};
}

const chips = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>(".pt-facet-chip"));
const moreBtn = (root: HTMLElement) => root.querySelector<HTMLElement>(".pt-facet-more");

describe("renderFacetChips", () => {
	it("渲染分类 chips + 选中态 aria-pressed（27-46）", () => {
		const c = makeContainer();
		const onToggle = vi.fn();
		renderFacetChips(c, ["A", "B", "C"], ["B"], onToggle);
		const cs = chips(c.root);
		expect(cs.length).toBe(3);
		expect(cs.map((e) => e.textContent)).toEqual(["A", "B", "C"]);
		expect(cs[0].getAttribute("aria-pressed")).toBe("false");
		expect(cs[1].getAttribute("aria-pressed")).toBe("true");
		expect(cs[1].getAttribute("data-cat")).toBe("B");
	});

	it("空字符串分类被跳过（36）", () => {
		const c = makeContainer();
		renderFacetChips(c, ["A", "", "C"], [], vi.fn());
		const cs = chips(c.root);
		expect(cs.length).toBe(2);
		expect(cs.map((e) => e.textContent)).toEqual(["A", "C"]);
	});

	it("点击 chip → onToggle(分类)（43-45）", () => {
		const c = makeContainer();
		const onToggle = vi.fn();
		renderFacetChips(c, ["A", "B"], [], onToggle);
		chips(c.root)[1].click();
		expect(onToggle).toHaveBeenCalledWith("B");
	});

	it("分类数 > maxVisible 且未展开 → 显示「更多 ▾」+ aria-expanded=false（49-58）", () => {
		const c = makeContainer();
		const onExpand = vi.fn();
		renderFacetChips(c, ["A", "B", "C", "D"], [], vi.fn(), { maxVisible: 2, expanded: false, onToggleExpand: onExpand });
		expect(chips(c.root).length).toBe(2);
		const more = moreBtn(c.root)!;
		expect(more.textContent).toContain("更多");
		expect(more.getAttribute("aria-expanded")).toBe("false");
		more.click();
		expect(onExpand).toHaveBeenCalled();
	});

	it("已展开 → 渲染全部分类 + 显示「收起 ▴」（33、49-54）", () => {
		const c = makeContainer();
		const onExpand = vi.fn();
		renderFacetChips(c, ["A", "B", "C", "D"], [], vi.fn(), { maxVisible: 2, expanded: true, onToggleExpand: onExpand });
		expect(chips(c.root).length).toBe(4);
		const more = moreBtn(c.root)!;
		expect(more.textContent).toContain("收起");
		expect(more.getAttribute("aria-expanded")).toBe("true");
		more.click();
		expect(onExpand).toHaveBeenCalled();
	});

	it("无 onToggleExpand 时点击更多不抛错（55-57）", () => {
		const c = makeContainer();
		renderFacetChips(c, ["A", "B", "C", "D"], [], vi.fn(), { maxVisible: 2, expanded: false });
		expect(() => moreBtn(c.root)!.click()).not.toThrow();
	});

	it("分类数 ≤ maxVisible → 不显示「更多」按钮（49）", () => {
		const c = makeContainer();
		renderFacetChips(c, ["A", "B", "C"], [], vi.fn(), { maxVisible: 12 });
		expect(chips(c.root).length).toBe(3);
		expect(moreBtn(c.root)).toBeNull();
	});

	it("默认 maxVisible 为 12（28）", () => {
		const c = makeContainer();
		const cats = Array.from({ length: 14 }, (_, i) => "c" + i);
		renderFacetChips(c, cats, [], vi.fn());
		expect(chips(c.root).length).toBe(12);
		expect(moreBtn(c.root)).not.toBeNull();
	});
});
