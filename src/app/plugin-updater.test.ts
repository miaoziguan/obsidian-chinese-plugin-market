import { describe, it, expect, vi, beforeEach } from "vitest";
import { requestUrl } from "obsidian";
import { fetchWithReleaseFallback, tagVariants, updatePluginCore } from "@app/plugin-updater";

vi.mock("obsidian", async () => {
	const actual = await vi.importActual<typeof import("obsidian")>("obsidian");
	return { ...actual, requestUrl: vi.fn() };
});

const mirror = { source: "github" as const };

function mockResponses(responses: Record<string, { status: number; text: string }>) {
	(requestUrl as ReturnType<typeof vi.fn>).mockImplementation(({ url }: { url: string }) => {
		const r = responses[url];
		if (r) return Promise.resolve({ status: r.status, text: r.text });
		return Promise.resolve({ status: 404, text: "" });
	});
}

describe("fetchWithReleaseFallback — 官方插件更新 Release 回退", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("源码树 200 直接返回，不触 Release", async () => {
		mockResponses({
			"https://raw.githubusercontent.com/o/r/HEAD/main.js": { status: 200, text: "raw-main" },
		});
		const text = await fetchWithReleaseFallback("o/r", "main.js", "1.0.0", mirror);
		expect(text).toBe("raw-main");
		expect(requestUrl).toHaveBeenCalledTimes(1);
	});

	it("源码树 404 后 Release 200 返回 Release 内容（Git 插件场景）", async () => {
		mockResponses({
			"https://raw.githubusercontent.com/o/r/HEAD/main.js": { status: 404, text: "" },
			"https://github.com/o/r/releases/download/1.0.0/main.js": { status: 200, text: "release-main" },
		});
		const text = await fetchWithReleaseFallback("o/r", "main.js", "1.0.0", mirror);
		expect(text).toBe("release-main");
		expect(requestUrl).toHaveBeenCalledTimes(2);
	});

	it("Release tag 同时兼容无 v 前缀与 v 前缀", async () => {
		mockResponses({
			"https://raw.githubusercontent.com/o/r/HEAD/main.js": { status: 404, text: "" },
			"https://github.com/o/r/releases/download/1.0.0/main.js": { status: 404, text: "" },
			"https://github.com/o/r/releases/download/v1.0.0/main.js": { status: 200, text: "release-v" },
		});
		const text = await fetchWithReleaseFallback("o/r", "main.js", "1.0.0", mirror);
		expect(text).toBe("release-v");
	});

	it("全部 404 且 optional=false 抛错", async () => {
		mockResponses({
			"https://raw.githubusercontent.com/o/r/HEAD/main.js": { status: 404, text: "" },
		});
		await expect(fetchWithReleaseFallback("o/r", "main.js", "1.0.0", mirror)).rejects.toThrow(
			/main\.js.*404/,
		);
	});

	it("全部 404 且 optional=true 返回 null", async () => {
		mockResponses({
			"https://raw.githubusercontent.com/o/r/HEAD/styles.css": { status: 404, text: "" },
		});
		const text = await fetchWithReleaseFallback("o/r", "styles.css", "1.0.0", mirror, true);
		expect(text).toBeNull();
	});

	it("源码树 500 直接抛错，不继续试 Release", async () => {
		mockResponses({
			"https://raw.githubusercontent.com/o/r/HEAD/main.js": { status: 500, text: "" },
		});
		await expect(fetchWithReleaseFallback("o/r", "main.js", "1.0.0", mirror)).rejects.toThrow("500");
		expect(requestUrl).toHaveBeenCalledTimes(1);
	});
});

describe("tagVariants — 版本 tag 形态兼容", () => {
	it("无 v 前缀：原样优先，v 前缀兜底", () => {
		expect(tagVariants("1.2.3")).toEqual(["1.2.3", "v1.2.3"]);
	});
	it("有 v 前缀：原样优先，去前缀兜底", () => {
		expect(tagVariants("v1.2.3")).toEqual(["v1.2.3", "1.2.3"]);
	});
	it("空串返回空数组", () => {
		expect(tagVariants("   ")).toEqual([]);
	});
});

describe("updatePluginCore — 固定版本安装（严格 tag，不回落 latest）", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	function makeApp() {
		const adapter = {
			exists: vi.fn(async () => true),
			mkdir: vi.fn(async () => undefined),
			write: vi.fn(async () => undefined),
			remove: vi.fn(async () => undefined),
		};
		const app = {
			vault: { adapter, configDir: ".obsidian" },
			plugins: {
				manifests: { r: { id: "r", version: "1.0.0" } },
				enabledPlugins: new Set(["r"]),
				loadManifests: vi.fn(async () => undefined),
				disablePlugin: vi.fn(async () => undefined),
				enablePluginAndSave: vi.fn(async () => undefined),
			},
		};
		return { app, adapter };
	}

	it("manifest 取该 tag 的源码树；main.js 源码树 404 后回退同 tag 的 Release 资产", async () => {
		mockResponses({
			"https://raw.githubusercontent.com/o/r/1.2.3/manifest.json": {
				status: 200,
				text: JSON.stringify({ id: "r", version: "1.2.3", main: "main.js" }),
			},
			"https://raw.githubusercontent.com/o/r/1.2.3/main.js": { status: 404, text: "" },
			"https://github.com/o/r/releases/download/1.2.3/main.js": { status: 200, text: "PINNED-MAIN" },
		});
		const { app, adapter } = makeApp();
		const man = await updatePluginCore(app as never, "r", "o/r", mirror, "1.2.3");

		expect(man.version).toBe("1.2.3");
		expect(adapter.write).toHaveBeenCalledWith(".obsidian/plugins/r/main.js", "PINNED-MAIN");
		// 关键不变量：固定版本绝不回落 latest（否则用户选了 v1.2.3 却装成最新版）
		const urls = (requestUrl as ReturnType<typeof vi.fn>).mock.calls.map(
			(c) => (c[0] as { url: string }).url,
		);
		expect(urls.some((u) => u.includes("/latest/"))).toBe(false);
		expect(urls.some((u) => u.includes("/HEAD/"))).toBe(false);
	});

	it("manifest 缺失时按 v 前缀变体兜底", async () => {
		mockResponses({
			"https://raw.githubusercontent.com/o/r/v2.0.0/manifest.json": {
				status: 200,
				text: JSON.stringify({ id: "r", version: "2.0.0", main: "main.js" }),
			},
			"https://raw.githubusercontent.com/o/r/v2.0.0/main.js": { status: 200, text: "V-MAIN" },
		});
		const { app, adapter } = makeApp();
		const man = await updatePluginCore(app as never, "r", "o/r", mirror, "2.0.0");
		expect(man.version).toBe("2.0.0");
		expect(adapter.write).toHaveBeenCalledWith(".obsidian/plugins/r/main.js", "V-MAIN");
	});

	it("所有来源都取不到 main.js 时抛错（不静默装成别的版本）", async () => {
		mockResponses({
			"https://raw.githubusercontent.com/o/r/1.2.3/manifest.json": {
				status: 200,
				text: JSON.stringify({ id: "r", version: "1.2.3", main: "main.js" }),
			},
		});
		const { app } = makeApp();
		await expect(updatePluginCore(app as never, "r", "o/r", mirror, "1.2.3")).rejects.toThrow();
	});
});
