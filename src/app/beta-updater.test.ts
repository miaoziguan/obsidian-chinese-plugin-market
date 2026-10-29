import { describe, it, expect } from "vitest";
import { updateAllBetaPlugins } from "@app/beta-updater";
import type { BetaPluginEntry } from "@app/direct-install";

describe("updateAllBetaPlugins", () => {
	it("空列表：total=0，不触网", async () => {
		const res = await updateAllBetaPlugins({} as never, []);
		expect(res).toMatchObject({ total: 0, updated: 0, skipped: 0, failed: 0 });
	});

	it("全部冻结：跳过、不触网、不报错", async () => {
		const entries: BetaPluginEntry[] = [
			{
				id: "a",
				name: "A",
				rootUrl: "https://raw.githubusercontent.com/o/a/HEAD/",
				installedVersion: "1",
				frozen: true,
			},
		];
		const res = await updateAllBetaPlugins({} as never, entries);
		expect(res.total).toBe(1);
		expect(res.updated).toBe(0);
		expect(res.skipped).toBe(1);
		expect(res.failed).toBe(0);
		expect(res.results[0]).toMatchObject({ id: "a", updated: false });
	});
});
