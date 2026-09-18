import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setHttpClient, resetHttpClient } from "@data/net/http-port";
import {
	fetchPluginVersions,
	parseReleaseEntries,
	parseTagEntries,
	normalizeVersionLabel,
	clearPluginVersionsCache,
} from "@data/platform/plugin-versions";

const req = vi.fn();

function res(status: number, json: unknown) {
	return { status, json, text: JSON.stringify(json), headers: {} };
}

describe("版本字符串归一", () => {
	it("去掉 v / V 前缀，其余原样", () => {
		expect(normalizeVersionLabel("v1.2.3")).toBe("1.2.3");
		expect(normalizeVersionLabel("V2.0")).toBe("2.0");
		expect(normalizeVersionLabel(" 1.0.0 ")).toBe("1.0.0");
	});
});

describe("parseReleaseEntries", () => {
	it("保留 tag_name，跳过 draft，标记 prerelease", () => {
		const list = parseReleaseEntries([
			{ tag_name: "v2.0.0", draft: false, prerelease: false, published_at: "2026-01-02T00:00:00Z" },
			{ tag_name: "draft-1", draft: true },
			{ tag_name: "2.1.0-beta", prerelease: true },
			{ tag_name: "" },
		]);
		expect(list.map((v) => v.tag)).toEqual(["v2.0.0", "2.1.0-beta"]);
		expect(list[0].version).toBe("2.0.0");
		expect(list[0].publishedAt).toBe("2026-01-02T00:00:00Z");
		expect(list[1].prerelease).toBe(true);
	});

	it("非数组输入返回空数组", () => {
		expect(parseReleaseEntries(null)).toEqual([]);
		expect(parseReleaseEntries({ message: "rate limited" })).toEqual([]);
	});

	it("同 tag 去重", () => {
		const list = parseReleaseEntries([{ tag_name: "1.0.0" }, { tag_name: "1.0.0" }]);
		expect(list.length).toBe(1);
	});
});

describe("parseTagEntries", () => {
	it("从 name 取 tag", () => {
		expect(parseTagEntries([{ name: "v1.0.0" }, { name: "0.9.0" }])).toEqual([
			{ tag: "v1.0.0", version: "1.0.0" },
			{ tag: "0.9.0", version: "0.9.0" },
		]);
	});
});

describe("fetchPluginVersions", () => {
	beforeEach(() => {
		req.mockReset();
		setHttpClient({ request: req });
		clearPluginVersionsCache();
	});
	afterEach(() => {
		resetHttpClient();
	});

	const releasesUrl = "https://api.github.com/repos/o/r/releases?per_page=100";

	it("优先 releases，命中缓存不重复请求", async () => {
		req.mockResolvedValue(res(200, [{ tag_name: "v1.1.0" }]));

		const first = await fetchPluginVersions("o/r");
		expect(first.map((v) => v.tag)).toEqual(["v1.1.0"]);
		expect(req).toHaveBeenCalledTimes(1);

		const second = await fetchPluginVersions("o/r");
		expect(second.map((v) => v.tag)).toEqual(["v1.1.0"]);
		expect(req).toHaveBeenCalledTimes(1);
	});

	it("force=true 绕过缓存", async () => {
		req.mockResolvedValue(res(200, [{ tag_name: "1.0.0" }]));
		await fetchPluginVersions("o/r");
		await fetchPluginVersions("o/r", true);
		expect(req).toHaveBeenCalledTimes(2);
	});

	it("releases 为空时回退 tags", async () => {
		req.mockImplementation(({ url }: { url: string }) => {
			if (url === releasesUrl) return Promise.resolve(res(200, []));
			if (url.includes("/tags")) return Promise.resolve(res(200, [{ name: "0.5.0" }]));
			return Promise.resolve(res(404, null));
		});
		const list = await fetchPluginVersions("o/r");
		expect(list.map((v) => v.tag)).toEqual(["0.5.0"]);
	});

	it("releases 限流（403）时回退 tags", async () => {
		req.mockImplementation(({ url }: { url: string }) => {
			if (url === releasesUrl) return Promise.resolve(res(403, { message: "rate limited" }));
			if (url.includes("/tags")) return Promise.resolve(res(200, [{ name: "1.0.0" }]));
			return Promise.resolve(res(404, null));
		});
		const list = await fetchPluginVersions("o/r");
		expect(list.map((v) => v.tag)).toEqual(["1.0.0"]);
	});

	it("网络异常时返回空数组而不抛错", async () => {
		req.mockRejectedValue(new Error("network down"));
		await expect(fetchPluginVersions("o/r")).resolves.toEqual([]);
	});

	it("repo 非法直接返回空数组（不发请求）", async () => {
		await expect(fetchPluginVersions("")).resolves.toEqual([]);
		await expect(fetchPluginVersions("only-one")).resolves.toEqual([]);
		expect(req).not.toHaveBeenCalled();
	});
});
