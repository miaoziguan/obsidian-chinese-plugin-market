import { describe, it, expect, vi, beforeEach } from "vitest";
import { ensureDepsFor } from "@ui/view/deps-lazy";
import { requestUrl } from "obsidian";
import { fetchManifest } from "@domain/compare/plugin-insight";
import { detectDeps } from "@domain/deps/detect";
import { logger } from "@shared/logger";

/**
 * 补 ui/view/deps-lazy.ts（此前 40.3%，行 28-67 一个按需检测依赖的异步函数）。基线没有某插件依赖时，
 * 现拉 manifest + README 用 detectDeps 现算，结果只写进 DepGraph 内存层（不落盘）。网络失败静默。
 * 依赖注入：requestUrl（obsidian）/fetchManifest（plugin-insight）/detectDeps（domain/deps/detect）/
 * logger 全部换 mock，故本文件不触网、不依赖插件实例。
 *
 * 错误模式「详情页打开没依赖的插件时静默什么都不做（正确）」「检测失败抛到界面」「重复打开同插件反复打网络」
 * 「README 取不到时仍用能取到的那份」「依赖为空时误写图」。
 *
 * 本文件自包含，不依赖插件实例；本轮绝不碰已有测试文件。
 */

vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));
vi.mock("@domain/compare/plugin-insight", () => ({ fetchManifest: vi.fn() }));
vi.mock("@domain/deps/detect", () => ({ detectDeps: vi.fn() }));
vi.mock("@shared/logger", () => ({ logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const mocked = {
	requestUrl: vi.mocked(requestUrl),
	fetchManifest: vi.mocked(fetchManifest),
	detectDeps: vi.mocked(detectDeps),
	logger,
};

function makeCtx(over: Record<string, unknown> = {}) {
	const graph = {
		edgesOf: vi.fn(() => [] as unknown[]),
		merge: vi.fn(),
	};
	const ctx: Record<string, unknown> = {
		pluginDeps: graph,
		mirrorConfig: vi.fn(() => ({})),
		allPlugins: [{ id: "x", name: "X" }],
		...over,
	};
	// edgesOf/merge 是 graph 的方法，覆盖需落到 graph 上（函数读 graph.edgesOf）
	if (over.edgesOf) graph.edgesOf = over.edgesOf as never;
	if (over.merge) graph.merge = over.merge as never;
	if (!("pluginDeps" in over)) ctx.pluginDeps = graph;
	return { ctx: ctx as never, graph };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("ensureDepsFor（deps-lazy.ts 整方法）", () => {
	it("无 DepGraph → 直接返回、不触网（33-35）", async () => {
		const { ctx } = makeCtx({ pluginDeps: null });
		await ensureDepsFor(ctx, "g1", "owner/repo");
		expect(mocked.fetchManifest).not.toHaveBeenCalled();
	});

	it("无 repo → 直接返回、不触网（33-35）", async () => {
		const { ctx } = makeCtx();
		await ensureDepsFor(ctx, "r1", undefined);
		expect(mocked.fetchManifest).not.toHaveBeenCalled();
	});

	it("图里已有边 → 标记 done 并返回、不触网（36-39）", async () => {
		const { ctx } = makeCtx({ edgesOf: vi.fn(() => [{ to: "b" }]) });
		await ensureDepsFor(ctx, "e1", "owner/repo");
		expect(mocked.fetchManifest).not.toHaveBeenCalled();
	});

	it("已 done → 第二次调用不重复请求（35-35 + finally 标记）", async () => {
		const { ctx } = makeCtx({ edgesOf: vi.fn(() => []) });
		await ensureDepsFor(ctx, "done1", "owner/repo");
		expect(mocked.fetchManifest).toHaveBeenCalledTimes(1);
		await ensureDepsFor(ctx, "done1", "owner/repo"); // 命中 done，跳过
		expect(mocked.fetchManifest).toHaveBeenCalledTimes(1);
	});

	it("并发进入 → 仅一次请求（pending 守卫，35-35）", async () => {
		const { ctx } = makeCtx({ edgesOf: vi.fn(() => []) });
		mocked.fetchManifest.mockImplementation(() => new Promise((res) => window.setTimeout(() => res({ dependencies: {} }), 0)));
		await Promise.all([ensureDepsFor(ctx, "pend1", "owner/repo"), ensureDepsFor(ctx, "pend1", "owner/repo")]);
		expect(mocked.fetchManifest).toHaveBeenCalledTimes(1);
	});

	it("正常：拉 manifest+README → detectDeps → merge + 调试日志（40-60）", async () => {
		const { ctx, graph } = makeCtx({ edgesOf: vi.fn(() => []) });
		mocked.fetchManifest.mockResolvedValue({ dependencies: { "dep-a": "1.0.0" } } as never);
		mocked.requestUrl.mockResolvedValue({ status: 200, text: "# install\nDepends on foo" } as never);
		mocked.detectDeps.mockReturnValue([{ to: "foo" }] as never);
		await ensureDepsFor(ctx, "h1", "owner/repo");
		expect(mocked.detectDeps).toHaveBeenCalledWith(
			expect.objectContaining({ selfId: "h1", manifestDeps: { "dep-a": "1.0.0" }, readme: "# install\nDepends on foo" })
		);
		expect(graph.merge).toHaveBeenCalledWith("h1", [{ to: "foo" }]);
		expect(mocked.logger.debug).toHaveBeenCalled();
	});

	it("README.md 404 → 回退 readme.md 取内容（44-54）", async () => {
		const { ctx } = makeCtx({ edgesOf: vi.fn(() => []) });
		mocked.fetchManifest.mockResolvedValue({ dependencies: {} } as never);
		mocked.requestUrl
			.mockResolvedValueOnce({ status: 404, text: "" } as never)
			.mockResolvedValueOnce({ status: 200, text: "fallback content" } as never);
		mocked.detectDeps.mockReturnValue([] as never);
		await ensureDepsFor(ctx, "fb1", "owner/repo");
		expect(mocked.detectDeps).toHaveBeenCalledWith(expect.objectContaining({ readme: "fallback content" }));
	});

	it("两份 README 都失败 → readme 为空串（44-54）", async () => {
		const { ctx } = makeCtx({ edgesOf: vi.fn(() => []) });
		mocked.fetchManifest.mockResolvedValue({ dependencies: {} } as never);
		mocked.requestUrl.mockResolvedValue({ status: 500, text: "" } as never);
		mocked.detectDeps.mockReturnValue([] as never);
		await ensureDepsFor(ctx, "bf1", "owner/repo");
		expect(mocked.detectDeps).toHaveBeenCalledWith(expect.objectContaining({ readme: "" }));
	});

	it("README 超长 → 截断到 5000（51-52）", async () => {
		const { ctx } = makeCtx({ edgesOf: vi.fn(() => []) });
		const long = "x".repeat(10000);
		mocked.fetchManifest.mockResolvedValue({ dependencies: {} } as never);
		mocked.requestUrl.mockResolvedValue({ status: 200, text: long } as never);
		mocked.detectDeps.mockReturnValue([] as never);
		await ensureDepsFor(ctx, "tr1", "owner/repo");
		expect(mocked.detectDeps).toHaveBeenCalledWith(expect.objectContaining({ readme: long.slice(0, 5000) }));
	});

	it("detectDeps 返回空 → 不写图（57-60）", async () => {
		const { ctx, graph } = makeCtx({ edgesOf: vi.fn(() => []) });
		mocked.fetchManifest.mockResolvedValue({ dependencies: {} } as never);
		mocked.requestUrl.mockResolvedValue({ status: 200, text: "x" } as never);
		mocked.detectDeps.mockReturnValue([] as never);
		await ensureDepsFor(ctx, "em1", "owner/repo");
		expect(graph.merge).not.toHaveBeenCalled();
	});

	it("fetchManifest 抛错 → 静默、不写图、done 标记仍落（61-66）", async () => {
		const { ctx, graph } = makeCtx({ edgesOf: vi.fn(() => []) });
		mocked.fetchManifest.mockRejectedValue(new Error("net down"));
		await expect(ensureDepsFor(ctx, "th1", "owner/repo")).resolves.toBeUndefined();
		expect(graph.merge).not.toHaveBeenCalled();
	});
});
