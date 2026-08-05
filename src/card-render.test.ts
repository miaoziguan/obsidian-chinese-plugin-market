import { describe, it, expect, beforeAll } from "vitest";
import { createPluginCard } from "./card-render";
import type { CardRenderContext } from "./card-render";
import type { PluginInfo } from "./translator";
import type { SignalId } from "./smart-signal";

// Obsidian 运行时给 HTMLElement.prototype 注入 createEl/appendText，测试环境补齐最小实现
beforeAll(() => {
	if (!(HTMLElement.prototype as any).createEl) {
		(HTMLElement.prototype as any).createEl = function (tag: string, opts: any = {}) {
			const el = document.createElement(tag);
			if (opts.cls) el.className = opts.cls;
			if (opts.text != null) el.textContent = opts.text;
			if (opts.attr) for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, String(v));
			this.appendChild(el);
			return el;
		};
	}
	if (!(HTMLElement.prototype as any).appendText) {
		(HTMLElement.prototype as any).appendText = function (s: string) {
			this.append(document.createTextNode(s));
		};
	}
});

function mkCtx(over: Partial<CardRenderContext> = {}): CardRenderContext {
	return {
		t: (k) => k,
		installedIds: new Set(),
		enabledIds: new Set(),
		aiSearchResult: null,
		...over,
	};
}

const P: PluginInfo = { id: "foo", name: "Foo", description: "desc", author: "A", downloads: 10 };

describe("createPluginCard 收藏态", () => {
	it("favoritesSet 命中时：卡片带 is-favorited、收藏按钮带 is-fav-on", () => {
		const card = createPluginCard(P, undefined, mkCtx({ favoritesSet: new Set(["foo"]) }));
		const favBtn = card.querySelector('[data-action="favorite"]');
		expect(favBtn).not.toBeNull();
		expect(favBtn!.classList.contains("is-fav-on")).toBe(true);
		expect(card.classList.contains("is-favorited")).toBe(true);
	});

	it("favoritesSet 未命中时：卡片不带 is-favorited、收藏按钮不带 is-fav-on", () => {
		const card = createPluginCard(P, undefined, mkCtx({ favoritesSet: new Set() }));
		const favBtn = card.querySelector('[data-action="favorite"]');
		expect(favBtn).not.toBeNull();
		expect(favBtn!.classList.contains("is-fav-on")).toBe(false);
		expect(card.classList.contains("is-favorited")).toBe(false);
	});

	it("smartSignals 命中时渲染信号 pill（Top 5%）", () => {
		const sigs = new Map<string, SignalId[]>([["foo", ["top5"]]]);
		const card = createPluginCard(P, undefined, mkCtx({ smartSignals: sigs }));
		const pill = card.querySelector(".pt-signal-pill");
		expect(pill).not.toBeNull();
		expect(pill!.textContent).toBe("Top 5%");
	});

	it("smartSignals 未命中时不渲染信号行", () => {
		const card = createPluginCard(P, undefined, mkCtx());
		expect(card.querySelector(".pt-signal-pill")).toBeNull();
	});
});
