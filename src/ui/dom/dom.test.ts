import { describe, it, expect } from "vitest";
import { q, createStrong } from "@ui/dom/dom";

describe("dom · q（类型安全 DOM 查询，审计 P1-2）", () => {
	it("命中返回带类型的元素", () => {
		document.body.innerHTML = `<div id="x" class="pt-foo">hi</div>`;
		const el = q<HTMLDivElement>(document.body, ".pt-foo");
		expect(el).not.toBeNull();
		expect(el!.id).toBe("x");
	});

	it("未命中返回 null", () => {
		expect(q(document.body, ".nope")).toBeNull();
	});

	it("createStrong 生成 <strong> 并设文本", () => {
		const s = createStrong("12");
		expect(s.tagName).toBe("STRONG");
		expect(s.textContent).toBe("12");
	});
});
