import { describe, it, expect, vi, beforeEach } from "vitest";
import { requestUrl } from "obsidian";
import { fetchWithReleaseFallback } from "@app/plugin-updater";

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
