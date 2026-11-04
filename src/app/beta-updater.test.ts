import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Platform } from "obsidian";
import { updateBetaPlugin, updateBetaTheme } from "@app/direct-install";
import {
	buildBetaEntry,
	updateBetaEntry,
	updateAllBetaPlugins,
} from "./beta-updater";

vi.mock("@app/direct-install", () => ({
	updateBetaPlugin: vi.fn(),
	updateBetaTheme: vi.fn(),
}));

const updP = vi.mocked(updateBetaPlugin);
const updT = vi.mocked(updateBetaTheme);

beforeEach(() => {
	vi.clearAllMocks();
	(updP as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
		updated: true,
		manifest: { version: "2.0.0" },
		release: false,
	});
	(updT as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
		updated: true,
		manifest: { version: "2.0.0" },
		release: false,
	});
	(Platform as unknown as { isMobile: boolean }).isMobile = false;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("buildBetaEntry", () => {
	it("默认值：kind=plugin / release=false / name 回退到 id（23-32）", () => {
		const e = buildBetaEntry("pid", "", "1.0", "https://x/");
		expect(e).toEqual({
			id: "pid",
			name: "pid",
			rootUrl: "https://x/",
			installedVersion: "1.0",
			frozen: false,
			kind: "plugin",
			release: false,
		});
	});

	it("显式 kind/release/name（23-32）", () => {
		const e = buildBetaEntry("t1", "主题A", "3.1", "https://y/", "theme", true);
		expect(e.kind).toBe("theme");
		expect(e.release).toBe(true);
		expect(e.name).toBe("主题A");
	});
});

describe("updateBetaEntry", () => {
	it("kind=plugin → 走 updateBetaPlugin 原样返回（35-44）", async () => {
		const entry = buildBetaEntry("p", "P", "1", "u");
		const r = await updateBetaEntry({} as never, entry);
		expect(updP).toHaveBeenCalledWith({}, entry);
		expect(r.updated).toBe(true);
	});

	it("kind=theme → 走 updateBetaTheme 并回写 release 布尔（35-44）", async () => {
		const entry = buildBetaEntry("t", "T", "1", "u", "theme", true);
		const r = await updateBetaEntry({} as never, entry);
		expect(updT).toHaveBeenCalledWith({}, entry);
		expect(r.release).toBe(true);
	});
});

describe("updateAllBetaPlugins", () => {
	const entry = (over: { id?: string; name?: string; frozen?: boolean; kind?: "plugin" | "theme"; release?: boolean } = {}) =>
		buildBetaEntry(over.id ?? "p1", over.name ?? "P1", "1.0", "https://u/", over.kind ?? "plugin", over.release ?? false);

	it("移动端（非静默）→ 弹移动端提示并空返回（86-89）", async () => {
		(Platform as unknown as { isMobile: boolean }).isMobile = true;
		const res = await updateAllBetaPlugins({} as never, [entry()]);
		expect(res).toEqual({ total: 1, updated: 0, skipped: 0, failed: 0, results: [] });
	});

	it("移动端（静默）→ 空返回（86-89 的 !silent 分支跳过）", async () => {
		(Platform as unknown as { isMobile: boolean }).isMobile = true;
		const res = await updateAllBetaPlugins({} as never, [entry()], { silent: true });
		expect(res).toEqual({ total: 1, updated: 0, skipped: 0, failed: 0, results: [] });
	});

	it("冻结项直接跳过（90-95）", async () => {
		const frozen = entry({ id: "f1", name: "F1" });
		frozen.frozen = true;
		const res = await updateAllBetaPlugins({} as never, [frozen]);
		expect(res.skipped).toBe(1);
		expect(res.results[0]).toEqual({ id: "f1", name: "F1", updated: false });
		expect(updP).not.toHaveBeenCalled();
	});

	it("更新成功 → updated++ 且结果带 version/release（96-109）", async () => {
		(updP as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
			updated: true,
			manifest: { version: "9.9" },
			release: true,
		});
		const res = await updateAllBetaPlugins({} as never, [entry()]);
		expect(res.updated).toBe(1);
		expect(res.results[0]).toEqual({ id: "p1", name: "P1", updated: true, version: "9.9", release: true });
	});

	it("已是最新（updated=false）→ 计为 skipped（110-113）", async () => {
		(updP as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ updated: false, manifest: { version: "1.0" }, release: false });
		const res = await updateAllBetaPlugins({} as never, [entry()]);
		expect(res.skipped).toBe(1);
		expect(res.updated).toBe(0);
	});

	it("单条失败被隔离：failed++ 且记录 error，不影响其余（114-119）", async () => {
		(updP as unknown as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({ updated: true, manifest: { version: "2.0" }, release: false })
			.mockRejectedValueOnce(new Error("boom"));
		const res = await updateAllBetaPlugins({} as never, [entry({ id: "a" }), entry({ id: "b" })]);
		expect(res.updated).toBe(1);
		expect(res.failed).toBe(1);
		expect(res.results[1].error).toBe("boom");
		expect(res.results[1].updated).toBe(false);
	});

	it("非静默成功 → 走逐条提示 + 汇总提示分支（107-109, 121-123）", async () => {
		const res = await updateAllBetaPlugins({} as never, [entry()]);
		expect(res.updated).toBe(1);
	});

	it("静默模式 → 跳过全部 !silent 提示分支（107-109, 121-123）", async () => {
		const res = await updateAllBetaPlugins({} as never, [entry()], { silent: true });
		expect(res.updated).toBe(1);
		expect(res.results[0].updated).toBe(true);
	});

	it("空列表（total=0）→ 不弹汇总提示（79-85, 121-123 的 total>0 分支跳过）", async () => {
		const res = await updateAllBetaPlugins({} as never, []);
		expect(res.total).toBe(0);
		expect(res.results).toEqual([]);
	});
});
