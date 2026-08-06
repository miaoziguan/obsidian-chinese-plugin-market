/**
 * renderFacetChips 纯函数的 DOM 测试。
 * 覆盖：
 *   1. 渲染所有分类 chip 并设置 aria-pressed
 *   2. 点击 chip 触发 onToggle 回调
 *   3. 空分类跳过
 *   4. 容器先被清空再重建
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { renderFacetChips } from "@ui/components/facet-chips";

describe("renderFacetChips", () => {
	/** 在 jsdom 下创建一个轻量容器（原生 HTMLElement 已有 empty() 和 createEl()）。 */
	function makeContainer(): HTMLElement {
		const el = document.createElement("div");
		// 补齐 empty()：Obsidian 的 Component.empty() 等价于移除所有子节点
		(el as any).empty = function () {
			while (el.firstChild) el.removeChild(el.firstChild);
		};
		// 补齐 createEl()：Obsidian 的 createEl(tag, attrs) 等价于创建元素并设属性
		(el as any).createEl = function (tag: string, attrs?: Record<string, unknown>) {
			const child = document.createElement(tag);
			if (attrs) {
				for (const [k, v] of Object.entries(attrs)) {
					if (k === "cls") {
						child.className = String(v ?? "");
					} else if (k === "text") {
						child.textContent = String(v ?? "");
					} else {
						child.setAttribute(k, String(v ?? ""));
					}
				}
			}
			el.appendChild(child);
			return child;
		};
		// 补齐 createDiv/createSpan（源码已改用这些 Obsidian 助手）
		(el as any).createDiv = function (o?: Record<string, unknown>) { return (el as any).createEl("div", o); };
		(el as any).createSpan = function (o?: Record<string, unknown>) { return (el as any).createEl("span", o); };
		return el;
	}

	it("渲染所有分类为 button chip，并设置正确的 aria-pressed", () => {
		const container = makeContainer();
		const categories = ["同步与备份", "任务与项目", "笔记"];
		const selected = ["任务与项目"];

		renderFacetChips(container, categories, selected, () => {});

		const chips = container.querySelectorAll("button");
		expect(chips.length).toBe(3);

		expect(chips[0].textContent).toBe("同步与备份");
		expect(chips[0].getAttribute("aria-pressed")).toBe("false");

		expect(chips[1].textContent).toBe("任务与项目");
		expect(chips[1].getAttribute("aria-pressed")).toBe("true");

		expect(chips[2].textContent).toBe("笔记");
		expect(chips[2].getAttribute("aria-pressed")).toBe("false");
	});

	it("所有 chip 都有 pt-filter pt-facet-chip 类名", () => {
		const container = makeContainer();
		renderFacetChips(container, ["同步与备份"], [], () => {});
		const chip = container.querySelector("button")!;
		expect(chip.className).toBe("pt-filter pt-facet-chip");
	});

	it("点击 chip 触发 onToggle 并传入正确的分类名", () => {
		const container = makeContainer();
		const onToggle = vi.fn();
		renderFacetChips(container, ["同步与备份", "笔记"], [], onToggle);

		const chips = container.querySelectorAll("button");
		(chips[0] as HTMLButtonElement).click();
		expect(onToggle).toHaveBeenCalledTimes(1);
		expect(onToggle).toHaveBeenCalledWith("同步与备份");

		(chips[1] as HTMLButtonElement).click();
		expect(onToggle).toHaveBeenCalledTimes(2);
		expect(onToggle).toHaveBeenCalledWith("笔记");
	});

	it("空字符串分类被跳过", () => {
		const container = makeContainer();
		renderFacetChips(container, ["同步与备份", "", "笔记"], [], () => {});
		const chips = container.querySelectorAll("button");
		expect(chips.length).toBe(2);
		expect(chips[0].textContent).toBe("同步与备份");
		expect(chips[1].textContent).toBe("笔记");
	});

	it("多次调用先清空再重建（不累积）", () => {
		const container = makeContainer();
		renderFacetChips(container, ["同步与备份"], [], () => {});
		expect(container.querySelectorAll("button").length).toBe(1);

		renderFacetChips(container, ["笔记", "任务与项目"], [], () => {});
		const chips = container.querySelectorAll("button");
		expect(chips.length).toBe(2);
		expect(chips[0].textContent).toBe("笔记");
		expect(chips[1].textContent).toBe("任务与项目");
	});

	it("空分类列表不创建任何 chip", () => {
		const container = makeContainer();
		renderFacetChips(container, [], [], () => {});
		expect(container.querySelectorAll("button").length).toBe(0);
	});

	it("selectedCategories 为空时所有 chip 均为 aria-pressed=false", () => {
		const container = makeContainer();
		renderFacetChips(container, ["同步与备份", "笔记"], [], () => {});
		const chips = Array.from(container.querySelectorAll("button"));
		for (const chip of chips) {
			expect(chip.getAttribute("aria-pressed")).toBe("false");
		}
	});
});
