import { describe, it, expect } from "vitest";
import { buildBetaEntry, updateAllBetaPlugins } from "@app/beta-updater";
import type { BetaPluginEntry } from "@app/direct-install";

describe("buildBetaEntry", () => {
	it("构造未冻结的跟踪项（rootUrl 透传）", () => {
		const e = buildBetaEntry("x", "X Plugin", "1.0.0", "https://raw.githubusercontent.com/o/x/HEAD/");
		expect(e).toEqual({
			id: "x",
			name: "X Plugin",
			rootUrl: "https://raw.githubusercontent.com/o/x/HEAD/",
			installedVersion: "1.0.0",
			frozen: false,
		});
	});

	it("name 缺省时回退到 id", () => {
		expect(buildBetaEntry("x", "", "1.0.0", "u").name).toBe("x");
	});
});

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
