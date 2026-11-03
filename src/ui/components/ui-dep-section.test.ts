import { describe, it, expect, vi } from "vitest";
import { renderDepSection, renderDependentsSection } from "./dep-section";
import type { DepEdge, DepStatus, DependentRef } from "@domain/deps/types";

// 局部补齐 Obsidian 对 HTMLElement 的 createEl/createDiv/createSpan/setText 增强（与 view-toolbar.test.ts 一致，
// 各测试文件各自局部补齐，避免全局 mock 覆盖既有局部实现导致冲突）。
type ElOpts =
	| string
	| { cls?: string; text?: string; attr?: Record<string, string> };
function ensureDomHelpers(): void {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	if (!proto.createEl) {
		proto.createEl = function (this: HTMLElement, tag: string, o?: ElOpts): HTMLElement {
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
		proto.createDiv = function (this: HTMLElement, o?: ElOpts): HTMLElement {
			return (this as unknown as { createEl: (t: string, o?: ElOpts) => HTMLElement }).createEl("div", o);
		};
	}
	if (!proto.createSpan) {
		proto.createSpan = function (this: HTMLElement, o?: ElOpts): HTMLElement {
			return (this as unknown as { createEl: (t: string, o?: ElOpts) => HTMLElement }).createEl("span", o);
		};
	}
	if (!proto.setText) {
		proto.setText = function (this: HTMLElement, t: string): HTMLElement {
			this.textContent = t;
			return this;
		};
	}
}
ensureDomHelpers();

function makeHost(statusMap: Record<string, DepStatus> = {}) {
	const t = vi.fn((k: string, vars?: Record<string, string>) => (vars ? `${k}:${JSON.stringify(vars)}` : k));
	const statusOf = vi.fn((dep: DepEdge) => statusMap[dep.id] ?? "ok");
	const canOpen = vi.fn(() => false);
	const nameOf = vi.fn((id: string) => "name:" + id);
	const onOpen = vi.fn();
	const onFix = vi.fn();
	return { t, statusOf, canOpen, nameOf, onOpen, onFix };
}

const rows = (parent: HTMLElement) => Array.from(parent.querySelectorAll<HTMLElement>(".pt-detail-dep-row"));

function dep(over: Partial<DepEdge>): DepEdge {
	return { id: "d1", kind: "optional", confidence: 1, ...over } as DepEdge;
}

describe("renderDepSection", () => {
	it("渲染依赖行：状态 class + 图标 + 名称 + 种类（52-70）", () => {
		const parent = document.createElement("div");
		const host = makeHost({ d1: "missing" });
		renderDepSection(parent, [dep({ name: "Dep One", kind: "required" })], host);
		const r = rows(parent);
		expect(r.length).toBe(1);
		expect(r[0].className).toContain("is-missing");
		expect(r[0].querySelector(".pt-detail-dep-name")?.textContent).toBe("Dep One");
		expect(r[0].querySelector(".pt-detail-dep-kind")?.textContent).toContain("required");
	});

	it("名称缺失时回退到 id（60）", () => {
		const parent = document.createElement("div");
		const host = makeHost({ d1: "ok" });
		renderDepSection(parent, [dep({})], host);
		expect(parent.querySelector(".pt-detail-dep-name")?.textContent).toBe("d1");
	});

	it("canOpen → 名称可点 + 点击触发 onOpen（61-65）", () => {
		const parent = document.createElement("div");
		const host = makeHost({ d1: "ok" });
		host.canOpen.mockReturnValue(true);
		renderDepSection(parent, [dep({})], host);
		const name = parent.querySelector<HTMLElement>(".pt-detail-dep-name")!;
		expect(name.className).toContain("is-link");
		expect(name.getAttribute("title")).toBe("dep.section");
		name.click();
		expect(host.onOpen).toHaveBeenCalledWith("d1");
	});

	it("canOpen 为 false → 名称不可点（61）", () => {
		const parent = document.createElement("div");
		const host = makeHost({ d1: "ok" });
		renderDepSection(parent, [dep({})], host);
		expect(parent.querySelector(".pt-detail-dep-name")?.className).not.toContain("is-link");
	});

	it("minVersion 存在 → 渲染版本 span（71-73）", () => {
		const parent = document.createElement("div");
		const host = makeHost({ d1: "ok" });
		renderDepSection(parent, [dep({ minVersion: "1.2.3" })], host);
		expect(parent.querySelector(".pt-detail-dep-ver")?.textContent).toContain("1.2.3");
	});

	it("confidence < 0.85 → 渲染「可能」标记（75-77）", () => {
		const parent = document.createElement("div");
		const host = makeHost({ d1: "ok" });
		renderDepSection(parent, [dep({ confidence: 0.5 })], host);
		expect(parent.querySelector(".pt-detail-dep-maybe")?.textContent).toBe("dep.maybe");
	});

	it("confidence ≥ 0.85 → 不渲染「可能」标记（75）", () => {
		const parent = document.createElement("div");
		const host = makeHost({ d1: "ok" });
		renderDepSection(parent, [dep({ confidence: 0.9 })], host);
		expect(parent.querySelector(".pt-detail-dep-maybe")).toBeNull();
	});

	it("状态→动作按钮：missing→安装（44-48、80-88）", () => {
		const parent = document.createElement("div");
		const host = makeHost({ d1: "missing" });
		renderDepSection(parent, [dep({})], host);
		const btn = parent.querySelector<HTMLElement>(".pt-detail-dep-fix")!;
		expect(btn.textContent).toBe("dep.action.install");
		btn.click();
		expect(host.onFix).toHaveBeenCalledWith("d1", "install");
	});

	it("状态→动作按钮：disabled→启用（44-48、80-88）", () => {
		const parent = document.createElement("div");
		const host = makeHost({ d1: "disabled" });
		renderDepSection(parent, [dep({})], host);
		const btn = parent.querySelector<HTMLElement>(".pt-detail-dep-fix")!;
		expect(btn.textContent).toBe("dep.action.enable");
		btn.click();
		expect(host.onFix).toHaveBeenCalledWith("d1", "enable");
	});

	it("状态→动作按钮：outdated→更新（44-48、80-88）", () => {
		const parent = document.createElement("div");
		const host = makeHost({ d1: "outdated" });
		renderDepSection(parent, [dep({})], host);
		const btn = parent.querySelector<HTMLElement>(".pt-detail-dep-fix")!;
		expect(btn.textContent).toBe("dep.action.update");
		btn.click();
		expect(host.onFix).toHaveBeenCalledWith("d1", "update");
	});

	it("ok / unknown 状态 → 无动作按钮（44-48、80）", () => {
		const parent = document.createElement("div");
		const host = makeHost({ d1: "ok" });
		renderDepSection(parent, [dep({})], host);
		expect(parent.querySelector(".pt-detail-dep-fix")).toBeNull();

		document.body.innerHTML = "";
		const parent2 = document.createElement("div");
		const host2 = makeHost({ d1: "unknown" });
		renderDepSection(parent2, [dep({})], host2);
		expect(parent2.querySelector(".pt-detail-dep-fix")).toBeNull();
	});
});

describe("renderDependentsSection", () => {
	it("折叠区 + 摘要 + 被依赖 chips（93-108）", () => {
		const parent = document.createElement("div");
		const host = makeHost();
		const deps: DependentRef[] = [
			{ id: "x1" } as DependentRef,
			{ id: "x2" } as DependentRef,
		];
		renderDependentsSection(parent, deps, host);
		const box = parent.querySelector<HTMLElement>(".pt-detail-dependents")!;
		expect(box).toBeTruthy();
		expect(box.tagName.toLowerCase()).toBe("details");
		expect(box.querySelector("summary")?.textContent).toContain("2");
		const chips = parent.querySelectorAll(".pt-detail-dependent-chip");
		expect(chips.length).toBe(2);
		expect(chips[0].textContent).toBe("name:x1");
	});

	it("canOpen → 被依赖 chip 可点 + 点击触发 onOpen（104-107）", () => {
		const parent = document.createElement("div");
		const host = makeHost();
		host.canOpen.mockReturnValue(true);
		renderDependentsSection(parent, [{ id: "x1" } as DependentRef], host);
		const chip = parent.querySelector<HTMLElement>(".pt-detail-dependent-chip")!;
		expect(chip.className).toContain("is-link");
		chip.click();
		expect(host.onOpen).toHaveBeenCalledWith("x1");
	});

	it("canOpen 为 false → 被依赖 chip 不可点（104）", () => {
		const parent = document.createElement("div");
		const host = makeHost();
		renderDependentsSection(parent, [{ id: "x1" } as DependentRef], host);
		expect(parent.querySelector(".pt-detail-dependent-chip")?.className).not.toContain("is-link");
	});
});
