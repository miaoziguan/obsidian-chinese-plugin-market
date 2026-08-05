import { describe, it, expect } from "vitest";
import { updateStats } from "./view-chrome";
import type { PluginInfo } from "./translator";
import { makeMockContext } from "./test-utils";

describe("updateStats 计数口径", () => {
	it("仅展示插件总数", () => {
		const captured: string[] = [];
		const stats = {
			style: {} as CSSStyleDeclaration,
			empty() {},
			createEl: (_tag: string, o: { text?: string }) => {
				captured.push(o?.text ?? "");
				return {} as HTMLElement;
			},
		};
		const containerEl = { querySelector: () => stats } as unknown as HTMLElement;
		const ctx = makeMockContext({
			containerEl,
			plugins: ([{ id: "a" }, { id: "b" }, { id: "c" }] as unknown) as PluginInfo[],
		});

		updateStats(ctx);

		expect(captured).toEqual(["共 3"]);
	});
});
