import { describe, it, expect } from "vitest";
import { updateStats } from "./view-chrome";
import type { PluginInfo } from "./translator";
import { makeMockContext } from "./test-utils";

describe("updateStats 计数口径", () => {
	it("仅展示插件总数", () => {
		const captured: string[] = [];
		const stats = document.createElement("div");
		stats.empty = () => {};
		stats.createEl = ((_tag: string, o: { text?: string }) => {
			captured.push(o?.text ?? "");
			return document.createElement("span");
		}) as typeof stats.createEl;
		// 补齐 createDiv/createSpan（源码已改用 Obsidian 助手；createDiv 在此等同 createEl）
		const proto = HTMLElement.prototype as any;
		if (!proto.createDiv) proto.createDiv = function (o?: any) { return this.createEl("div", o); };
		if (!proto.createSpan) proto.createSpan = function (o?: any) { return this.createEl("span", o); };
		const containerEl = { querySelector: () => stats } as unknown as HTMLElement;
		const ctx = makeMockContext({
			containerEl,
			plugins: ([{ id: "a" }, { id: "b" }, { id: "c" }] as unknown) as PluginInfo[],
		});

		updateStats(ctx);

		expect(captured).toEqual(["共 3"]);
	});
});
