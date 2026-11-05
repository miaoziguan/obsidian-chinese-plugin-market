import { describe, it, expect, vi, beforeEach } from "vitest";
import { netRequest } from "@data/net/net";
import {
	isSafeInstallTarget,
	installCommunityPlugin,
	applyProfileByIds,
	applyEnabledProfile,
	uninstallCommunityPlugin,
	togglePluginEnabled,
} from "@data/platform/plugin-installer";
import type { PluginInfo } from "@domain/catalog/translator";
import { logger } from "@shared/logger";

// netRequest 是模块级单例，vi.mock 后替换为本文件可控的 vi.fn()
vi.mock("@data/net/net", () => ({ netRequest: vi.fn() }));
// 安装流程读取镜像配置与依赖提示，这里用无副作用的桩替代
vi.mock("@ui/view/view-data", () => ({ mirrorConfig: vi.fn(() => ({ source: "github" })) }));
vi.mock("@ui/view/deps-report", () => ({ reportMissingDeps: vi.fn() }));

const req = netRequest as unknown as ReturnType<typeof vi.fn>;

function makeCtx(opts: { enabledHas?: boolean } = {}) {
	const has = opts.enabledHas ?? true;
	const adapter = {
		mkdir: vi.fn().mockResolvedValue(undefined),
		write: vi.fn().mockResolvedValue(undefined),
		read: vi.fn().mockResolvedValue("[]"),
		rmdir: vi.fn().mockResolvedValue(undefined),
	};
	const enabledPlugins = {
		has: vi.fn().mockReturnValue(has),
		add: vi.fn(),
		delete: vi.fn(),
	};
	const plugins = {
		manifests: { x: { id: "x" } },
		enabledPlugins,
		loadManifests: vi.fn().mockResolvedValue(undefined),
		enablePluginAndSave: vi.fn().mockResolvedValue(undefined),
		disablePluginAndSave: vi.fn().mockResolvedValue(undefined),
		enablePlugin: vi.fn().mockResolvedValue(undefined),
		disablePlugin: vi.fn().mockResolvedValue(undefined),
	};
	const app: Record<string, unknown> = { vault: { adapter, configDir: ".obsidian" }, plugins };
	const ctx: Record<string, unknown> = {
		app,
		t: (k: string) => k,
		installedIds: new Set<string>(),
		enabledIds: new Set<string>(),
		snapshotInstalled: vi.fn(),
		refreshCardState: vi.fn(),
		scheduleRender: vi.fn(),
		invalidateAndRender: vi.fn(),
		plugin: { recordInstallDiff: vi.fn() },
	};
	return { ctx, adapter, plugins, enabledPlugins };
}

const plugin = (over: Partial<PluginInfo> = {}): PluginInfo =>
	({
		id: "x",
		name: "X",
		repo: "owner/repo",
		version: "1.0",
		author: "",
		description: "",
		...over,
	} as PluginInfo);

// 让 netRequest 按 url 返回：manifest.json 给 json、styles.css 给指定状态、其余（main.js 等）给 200 文本
function mockNetwork(stylesStatus = 404) {
	req.mockImplementation((o: { url: string }) => {
		const u = o.url;
		if (u.includes("manifest.json"))
			return Promise.resolve({ status: 200, json: { id: "x", name: "X", version: "1.0", main: "main.js" }, text: "" });
		if (u.endsWith("styles.css"))
			return Promise.resolve(stylesStatus === 404 ? { status: 404, text: "" } : { status: 200, text: "/* css */" });
		return Promise.resolve({ status: 200, text: "// main" });
	});
}

describe("plugin-installer", () => {
	beforeEach(() => {
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		vi.spyOn(logger, "debug").mockImplementation(() => {});
		// fallbackToMarket 在失败分支调 window.open 打开社区市场，jsdom 未实现会抛错（已被源码 try/catch 吞掉）
		vi.spyOn(window, "open").mockImplementation(() => null);
		req.mockReset();
	});

	describe("isSafeInstallTarget（纯函数：路径穿越防护）", () => {
		it("合法 id + null manifest → true", () => {
			expect(isSafeInstallTarget("abc.1-x", null)).toBe(true);
		});
		it("id 含 .. → false", () => {
			expect(isSafeInstallTarget("a..b", null)).toBe(false);
		});
		it("id 含路径分隔符 / → false", () => {
			expect(isSafeInstallTarget("a/b", null)).toBe(false);
		});
		it("id 以 . 开头 → false", () => {
			expect(isSafeInstallTarget(".hidden", null)).toBe(false);
		});
		it("非字符串 id → false", () => {
			expect(isSafeInstallTarget(123, null)).toBe(false);
		});
		it("manifest.id 与 pluginId 不匹配 → false", () => {
			expect(isSafeInstallTarget("x", { id: "y", main: "main.js" })).toBe(false);
		});
		it("manifest.main 含路径穿越 → false", () => {
			expect(isSafeInstallTarget("x", { id: "x", main: "../evil.js" })).toBe(false);
		});
		it("manifest.main 空串 → 走默认 main.js → true", () => {
			expect(isSafeInstallTarget("x", { id: "x", main: "" })).toBe(true);
		});
		it("无 manifest → true", () => {
			expect(isSafeInstallTarget("x")).toBe(true);
		});
	});

	describe("installCommunityPlugin（安装全链路）", () => {
		it("无 repo → 回退社区市场跳转", async () => {
			const { ctx } = makeCtx();
			const r = await installCommunityPlugin(ctx as never, { ...plugin(), repo: "" });
			expect(r.ok).toBe(false);
			expect(r.fallback).toBe(true);
		});
		it("非法 id（含 ..）→ 拒绝安装", async () => {
			const { ctx } = makeCtx();
			const r = await installCommunityPlugin(ctx as never, { ...plugin(), id: "x..y" });
			expect(r.ok).toBe(false);
		});
		it("已安装 → 直接返回（不重复安装）", async () => {
			const { ctx } = makeCtx();
			(ctx.installedIds as Set<string>).add("x");
			const r = await installCommunityPlugin(ctx as never, plugin());
			expect(r.ok).toBe(false);
		});
		it("plugins 内部 API 缺失 → 回退", async () => {
			const { ctx } = makeCtx();
			(ctx.app as unknown as { plugins?: unknown }).plugins = undefined;
			const r = await installCommunityPlugin(ctx as never, plugin());
			expect(r.ok).toBe(false);
		});
		it("manifest 下载失败 → 回退", async () => {
			const { ctx } = makeCtx();
			req.mockResolvedValue({ status: 404, json: null, text: "" });
			const r = await installCommunityPlugin(ctx as never, plugin());
			expect(r.ok).toBe(false);
		});
		it("adapter 无 mkdir → 回退", async () => {
			const { ctx, adapter } = makeCtx();
			(adapter as unknown as { mkdir?: unknown }).mkdir = undefined;
			req.mockResolvedValue({ status: 200, json: { id: "x", name: "X", version: "1.0", main: "main.js" }, text: "" });
			const r = await installCommunityPlugin(ctx as never, plugin());
			expect(r.ok).toBe(false);
		});
		it("完整成功（recognized + enabled）→ ok:true 且写盘 community-plugins.json / app.json", async () => {
			const { ctx, adapter } = makeCtx();
			mockNetwork(404);
			const r = await installCommunityPlugin(ctx as never, plugin());
			expect(r.ok).toBe(true);
			expect(adapter.write).toHaveBeenCalled();
			expect((ctx.plugin as { recordInstallDiff: ReturnType<typeof vi.fn> }).recordInstallDiff).toHaveBeenCalled();
		});
		it("styles.css 存在（200）→ 一并写盘", async () => {
			const { ctx, adapter } = makeCtx();
			mockNetwork(200);
			const r = await installCommunityPlugin(ctx as never, plugin());
			expect(r.ok).toBe(true);
			const written = (adapter.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
			expect(written.some((p) => p.endsWith("styles.css"))).toBe(true);
		});
		it("recognized + enabledPlugins 不可写 → manualEnable 路径仍 ok:true", async () => {
			const { ctx, plugins } = makeCtx();
			(plugins as unknown as { enabledPlugins?: unknown }).enabledPlugins = {}; // 无 has/add/delete
			(plugins as unknown as { manifests: Record<string, unknown> }).manifests = { x: {} };
			mockNetwork(404);
			const r = await installCommunityPlugin(ctx as never, plugin());
			expect(r.ok).toBe(true);
		});
		it("未识别（manifests 无此 id）→ needReload 回退 ok:false（fileWritten）", async () => {
			const { ctx, plugins } = makeCtx();
			(plugins as unknown as { manifests: Record<string, unknown> }).manifests = {};
			mockNetwork(404);
			const r = await installCommunityPlugin(ctx as never, plugin());
			expect(r.ok).toBe(false);
			expect(r.fallback).toBe(false);
		});
		it("main.js 下载失败 → 回退", async () => {
			const { ctx } = makeCtx();
			req.mockImplementation((o: { url: string }) => {
				const u = o.url;
				if (u.includes("manifest.json"))
					return Promise.resolve({ status: 200, json: { id: "x", name: "X", version: "1.0", main: "main.js" }, text: "" });
				if (u.includes("main.js")) return Promise.resolve({ status: 404, text: "" });
				return Promise.resolve({ status: 404, text: "" });
			});
			const r = await installCommunityPlugin(ctx as never, plugin());
			expect(r.ok).toBe(false);
		});
	});

	describe("uninstallCommunityPlugin", () => {
		it("成功卸载：rmdir + 同步清单 + loadManifests + 记足迹", async () => {
			const { ctx, adapter } = makeCtx();
			const r = await uninstallCommunityPlugin(ctx as never, plugin());
			expect(r).toBe(true);
			expect(adapter.rmdir).toHaveBeenCalled();
			expect((ctx.plugin as { recordInstallDiff: ReturnType<typeof vi.fn> }).recordInstallDiff).toHaveBeenCalled();
			expect((ctx.app as Record<string, { loadManifests: ReturnType<typeof vi.fn> }>).plugins.loadManifests).toHaveBeenCalled();
		});
		it("adapter 无 rmdir → false", async () => {
			const { ctx, adapter } = makeCtx();
			(adapter as unknown as { rmdir?: unknown }).rmdir = undefined;
			const r = await uninstallCommunityPlugin(ctx as never, plugin());
			expect(r).toBe(false);
		});
		it("非法 id → false", async () => {
			const { ctx } = makeCtx();
			const r = await uninstallCommunityPlugin(ctx as never, { ...plugin(), id: "x/../y" });
			expect(r).toBe(false);
		});
		it("未启用则跳过 disable 分支", async () => {
			const { ctx, plugins } = makeCtx({ enabledHas: false });
			const r = await uninstallCommunityPlugin(ctx as never, plugin());
			expect(r).toBe(true);
			expect(plugins.disablePlugin).not.toHaveBeenCalled();
		});
	});

	describe("togglePluginEnabled", () => {
		it("plugins 缺失 → 返回 enabledIds 判断", async () => {
			const { ctx } = makeCtx();
			(ctx.app as unknown as { plugins?: unknown }).plugins = undefined;
			(ctx.enabledIds as Set<string>).add("x");
			const r = await togglePluginEnabled(ctx as never, plugin());
			expect(r).toBe(true);
		});
		it("当前启用 → 禁用路径 → false（双写清单 + enabledPlugins.delete）", async () => {
			const { ctx, plugins } = makeCtx();
			const r = await togglePluginEnabled(ctx as never, plugin());
			expect(r).toBe(false);
			expect(plugins.disablePluginAndSave).toHaveBeenCalledWith("x");
			expect(plugins.enabledPlugins.delete).toHaveBeenCalledWith("x");
		});
		it("当前禁用 → tryEnable → 启用 → true", async () => {
			const { ctx, plugins } = makeCtx({ enabledHas: false });
			(plugins as unknown as { manifests: Record<string, unknown> }).manifests = { x: {} };
			const r = await togglePluginEnabled(ctx as never, plugin());
			expect(r).toBe(true);
			expect(plugins.enablePluginAndSave).toHaveBeenCalledWith("x");
		});
	});

	describe("applyProfileByIds / applyEnabledProfile", () => {
		it("applyProfileByIds：enable 新 + disable 旧（排除 selfId）", async () => {
			const { plugins } = makeCtx();
			(plugins as unknown as { manifests: Record<string, unknown> }).manifests = { a: {} };
			const app = {
				plugins,
				vault: { adapter: { read: vi.fn().mockResolvedValue("[]"), write: vi.fn() } },
			};
			const r = await applyProfileByIds(app as never, new Set(["b"]), new Set(["a"]), "self");
			expect(r.enabled).toBe(1);
			expect(r.disabled).toBe(1);
		});
		it("applyProfileByIds：plugins 缺失 → 0/0", async () => {
			const r = await applyProfileByIds({} as never, new Set(), new Set(), "self");
			expect(r).toEqual({ enabled: 0, disabled: 0 });
		});
		it("applyEnabledProfile：委托 applyProfileByIds + 刷新卡片", async () => {
			const { ctx, plugins } = makeCtx();
			(ctx.enabledIds as Set<string>).add("b");
			(plugins as unknown as { manifests: Record<string, unknown> }).manifests = { a: {} };
			const r = await applyEnabledProfile(ctx as never, new Set(["a"]), "self");
			expect(r.enabled).toBe(1);
			expect((ctx.snapshotInstalled as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
			expect((ctx.invalidateAndRender as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
		});
	});

	describe("plugin-installer · 分支补全（写盘失败 / 网络异常 / enabledPlugins 形态）", () => {
		it("installCommunityPlugin：mkdir 抛错 → 回退", async () => {
			const { ctx, adapter } = makeCtx();
			(adapter as unknown as { mkdir?: unknown }).mkdir = vi.fn().mockRejectedValue(new Error("e"));
			req.mockResolvedValue({ status: 200, json: { id: "x", name: "X", version: "1.0", main: "main.js" }, text: "" });
			const r = await installCommunityPlugin(ctx as never, plugin());
			expect(r.ok).toBe(false);
		});
		it("installCommunityPlugin：写 manifest.json 抛错 → 回退", async () => {
			const { ctx, adapter } = makeCtx();
			(adapter as unknown as { write?: unknown }).write = vi.fn().mockRejectedValueOnce(new Error("e"));
			mockNetwork(404);
			const r = await installCommunityPlugin(ctx as never, plugin());
			expect(r.ok).toBe(false);
		});
		it("installCommunityPlugin：写 main.js 抛错 → 回退", async () => {
			const { ctx } = makeCtx();
			const writes = (ctx.app as unknown as { vault: { adapter: { write: ReturnType<typeof vi.fn> } } }).vault.adapter.write as ReturnType<typeof vi.fn>;
			writes.mockImplementation((p: string) =>
				p.endsWith("manifest.json") ? Promise.resolve(undefined) : Promise.reject(new Error("e")),
			);
			mockNetwork(404);
			const r = await installCommunityPlugin(ctx as never, plugin());
			expect(r.ok).toBe(false);
		});
		it("installCommunityPlugin：netRequest 抛错（downloadFullManifest 异常分支）→ 回退", async () => {
			const { ctx } = makeCtx();
			req.mockRejectedValue(new Error("net"));
			const r = await installCommunityPlugin(ctx as never, plugin());
			expect(r.ok).toBe(false);
		});
		it("applyProfileByIds：enabledPlugins 为 array 形态（push/splice 分支）→ enable+disable 各计 1", async () => {
			const { plugins } = makeCtx();
			(plugins as unknown as { manifests: Record<string, unknown> }).manifests = { a: {} };
			(plugins as unknown as { enabledPlugins: string[] }).enabledPlugins = ["b"]; // array 形态：含 b，触发 splice；不含 a，触发 push
			const app = {
				plugins,
				vault: { adapter: { read: vi.fn().mockResolvedValue("[]"), write: vi.fn() } },
			};
			const r = await applyProfileByIds(app as never, new Set(["b"]), new Set(["a"]), "self");
			expect(r.enabled).toBe(1);
			expect(r.disabled).toBe(1);
		});
	});
});
