import { describe, it, expect, vi, beforeEach } from "vitest";
import { Platform, requestUrl, requireApiVersion } from "obsidian";
import { buildManifestUrl } from "@domain/compare/plugin-insight";
import {
	tagVariants,
	fetchWithReleaseFallback,
	updatePluginCore,
} from "./plugin-updater";

vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		requestUrl: vi.fn(),
		requireApiVersion: vi.fn(() => true),
	};
});
vi.mock("@domain/compare/plugin-insight", () => ({ buildManifestUrl: vi.fn(() => "https://manifest.url") }));
vi.mock("@domain/catalog/mirror", () => ({ resolveUrl: vi.fn((u: string) => u) }));
vi.mock("@app/direct-install", () => ({
	githubReleaseAssetUrls: vi.fn((_gh: { owner: string; repo: string }, file: string, version?: string) => [
		`https://release/${file}/${version ?? "HEAD"}`,
	]),
}));
vi.mock("@data/platform/obsidian-internals", () => ({ asAppInternals: vi.fn((app: unknown) => app) }));

const reqUrl = vi.mocked(requestUrl) as unknown as { mockImplementation: (fn: (o: any) => unknown) => void; mockResolvedValue: (v: unknown) => void; mockRejectedValue: (v: unknown) => void };
const reqApi = vi.mocked(requireApiVersion);
const buildMan = vi.mocked(buildManifestUrl);

const ok = (text = "") => ({ status: 200, text, json: null, headers: {}, arrayBuffer: new ArrayBuffer(0) });
const nf = () => ({ status: 404, text: "", json: null, headers: {}, arrayBuffer: new ArrayBuffer(0) });
const srv = (s: number) => ({ status: s, text: "", json: null, headers: {}, arrayBuffer: new ArrayBuffer(0) });

const mkPlugins = (over: Record<string, unknown> = {}) => ({
	loadManifests: vi.fn(() => Promise.resolve()),
	disablePlugin: vi.fn(() => Promise.resolve()),
	enablePluginAndSave: vi.fn(() => Promise.resolve()),
	enablePlugin: vi.fn(() => Promise.resolve()),
	manifests: {},
	enabledPlugins: { has: vi.fn(() => true) },
	...over,
});
const mkApp = (plugins: unknown, adapterOver: Record<string, unknown> = {}) => ({
	vault: {
		adapter: {
			exists: vi.fn(() => Promise.resolve(false)),
			mkdir: vi.fn(() => Promise.resolve()),
			write: vi.fn(() => Promise.resolve()),
			remove: vi.fn(() => Promise.resolve()),
			...adapterOver,
		},
		configDir: ".obsidian",
	},
	plugins,
}) as unknown as import("obsidian").App;

beforeEach(() => {
	vi.clearAllMocks();
	(Platform as unknown as { isMobile: boolean }).isMobile = false;
	reqApi.mockReturnValue(true);
	buildMan.mockReturnValue("https://manifest.url");
});

describe("tagVariants", () => {
	it("空 / 纯空白 → []（74-80）", () => {
		expect(tagVariants("")).toEqual([]);
		expect(tagVariants("   ")).toEqual([]);
	});
	it("无 v 前缀 → [原, v原]（74-80）", () => {
		expect(tagVariants("1.2.3")).toEqual(["1.2.3", "v1.2.3"]);
	});
	it("v 前缀 → [原, 去v]（74-80）", () => {
		expect(tagVariants("v1.2.3")).toEqual(["v1.2.3", "1.2.3"]);
	});
	it("大写 V 前缀也识别（74-80）", () => {
		expect(tagVariants("V1.2.3")).toEqual(["V1.2.3", "1.2.3"]);
	});
});

describe("updatePluginCore 前置守卫", () => {
	it("移动端 → 抛 mobileBlocked（152）", async () => {
		(Platform as unknown as { isMobile: boolean }).isMobile = true;
		await expect(updatePluginCore({} as never, "id", "a/b", {} as never)).rejects.toThrow();
	});
	it("无仓库 → 抛 noRepo（153）", async () => {
		await expect(updatePluginCore({} as never, "id", "", {} as never)).rejects.toThrow();
	});
});

describe("updatePluginCore 跟随最新成功路径", () => {
	const manText = JSON.stringify({ id: "pid", version: "2.0", main: "main.js", minAppVersion: "1.4.0" });

	it("完整成功：manifest→main(raw)→css(可选404)→写盘重载（145-176）", async () => {
		const plugins = mkPlugins({ manifests: { pid: {} }, enabledPlugins: { has: vi.fn(() => true) } });
		const app = mkApp(plugins);
		reqUrl.mockImplementation((o: any) => {
			if (o.url === "https://manifest.url") return Promise.resolve(ok(manText));
			if (o.url.includes("styles.css")) return Promise.resolve(nf());
			return Promise.resolve(ok("MAIN"));
		});
		const man = await updatePluginCore(app, "pid", "a/b", {} as never);
		expect(man.id).toBe("pid");
		expect((app.vault.adapter.write as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
			".obsidian/plugins/pid/main.js",
			"MAIN",
		);
		expect((app.vault.adapter.write as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
			".obsidian/plugins/pid/manifest.json",
			manText,
		);
		// css 可选且 404 → 不写 styles.css，但目录已有则不删（exists 默认 false → 不删）
		expect(plugins.enablePluginAndSave).toHaveBeenCalledWith("pid");
		expect(reqApi).toHaveBeenCalledWith("1.4.0");
	});

	it("manifest 抓取非 2xx → 抛 fetchFail（160-163）", async () => {
		reqUrl.mockResolvedValue(srv(503));
		await expect(updatePluginCore({} as never, "pid", "a/b", {} as never)).rejects.toThrow();
	});

	it("buildManifestUrl 返回空 → 抛 noRepo（158-159）", async () => {
		buildMan.mockReturnValue("");
		await expect(updatePluginCore({} as never, "pid", "a/b", {} as never)).rejects.toThrow();
	});

	it("manifest.id 不符 → 抛 badManifest（179-185）", async () => {
		const bad = JSON.stringify({ id: "other" });
		reqUrl.mockImplementation((o: any) =>
			o.url === "https://manifest.url" ? Promise.resolve(ok(bad)) : Promise.resolve(ok("x")),
		);
		await expect(updatePluginCore({} as never, "pid", "a/b", {} as never)).rejects.toThrow();
	});

	it("minAppVersion 不满足 → 抛 minApp（179-185）", async () => {
		reqApi.mockReturnValue(false);
		reqUrl.mockImplementation((o: any) =>
			o.url === "https://manifest.url" ? Promise.resolve(ok(manText)) : Promise.resolve(ok("x")),
		);
		await expect(updatePluginCore({} as never, "pid", "a/b", {} as never)).rejects.toThrow();
	});

	it("main 文本为空 → 抛 emptyMain（171）", async () => {
		reqUrl.mockImplementation((o: any) => {
			if (o.url === "https://manifest.url") return Promise.resolve(ok(manText));
			return Promise.resolve(ok("   "));
		});
		await expect(updatePluginCore({} as never, "pid", "a/b", {} as never)).rejects.toThrow();
	});

	it("目录不存在 → 先 mkdir 再写（196-202）", async () => {
		const plugins = mkPlugins();
		const app = mkApp(plugins);
		reqUrl.mockImplementation((o: any) => {
			if (o.url === "https://manifest.url") return Promise.resolve(ok(manText));
			if (o.url.includes("styles.css")) return Promise.resolve(nf());
			return Promise.resolve(ok("MAIN"));
		});
		await updatePluginCore(app, "pid", "a/b", {} as never);
		expect(app.vault.adapter.mkdir).toHaveBeenCalledWith(".obsidian/plugins/pid");
	});
});

describe("写盘重载分支（writeAndReload 经 updatePluginCore 触发）", () => {
	const manText = JSON.stringify({ id: "pid", version: "2.0", main: "main.js" });

	const baseImpl = (o: any) => {
		if (o.url === "https://manifest.url") return Promise.resolve(ok(manText));
		if (o.url.includes("styles.css")) return Promise.resolve(nf());
		return Promise.resolve(ok("MAIN"));
	};

	it("css 存在且新版无 css → 删除旧 styles.css（201-202）", async () => {
		const plugins = mkPlugins();
		const app = mkApp(plugins, {
			exists: vi.fn((p: string) => p === ".obsidian/plugins/pid" || p === ".obsidian/plugins/pid/styles.css"),
		});
		reqUrl.mockImplementation(baseImpl);
		await updatePluginCore(app, "pid", "a/b", {} as never);
		expect(app.vault.adapter.remove).toHaveBeenCalledWith(".obsidian/plugins/pid/styles.css");
		expect(app.vault.adapter.write).not.toHaveBeenCalledWith(
			".obsidian/plugins/pid/styles.css",
			expect.anything(),
		);
	});

	it("css 不存在 → 不删除（201-202）", async () => {
		const plugins = mkPlugins();
		const app = mkApp(plugins, { exists: vi.fn((p: string) => p === ".obsidian/plugins/pid") });
		reqUrl.mockImplementation(baseImpl);
		await updatePluginCore(app, "pid", "a/b", {} as never);
		expect(app.vault.adapter.remove).not.toHaveBeenCalled();
	});

	it("plugins 为 null → 抛 noPluginsApi（205-206）", async () => {
		const app = mkApp(null);
		reqUrl.mockImplementation(baseImpl);
		await expect(updatePluginCore(app, "pid", "a/b", {} as never)).rejects.toThrow();
	});

	it("已启用插件 → 先 disable 再 enable（207-211）", async () => {
		const plugins = mkPlugins({ enabledPlugins: { has: vi.fn(() => true) } });
		const app = mkApp(plugins);
		reqUrl.mockImplementation(baseImpl);
		await updatePluginCore(app, "pid", "a/b", {} as never);
		expect(plugins.disablePlugin).toHaveBeenCalledWith("pid");
		expect(plugins.enablePluginAndSave).toHaveBeenCalledWith("pid");
	});

	it("缺 enablePluginAndSave → 回退 enablePlugin（211-212）", async () => {
		const plugins = mkPlugins({ enablePluginAndSave: undefined, enablePlugin: vi.fn(() => Promise.resolve()) });
		const app = mkApp(plugins);
		reqUrl.mockImplementation(baseImpl);
		await updatePluginCore(app, "pid", "a/b", {} as never);
		expect(plugins.enablePlugin).toHaveBeenCalledWith("pid");
	});

	it("重载后仍未启用 → 抛 enableFailed（214-215）", async () => {
		const plugins = mkPlugins({ enabledPlugins: { has: vi.fn(() => false) }, manifests: {} });
		const app = mkApp(plugins);
		reqUrl.mockImplementation(baseImpl);
		await expect(updatePluginCore(app, "pid", "a/b", {} as never)).rejects.toThrow();
	});
});

describe("固定版本安装 installPinnedVersion（经 version 入参触发）", () => {
	const manText = JSON.stringify({ id: "pid", version: "1.2.3", main: "main.js" });

	it("version 非空 → 走严格 tag 路径（155, 225-263）", async () => {
		const plugins = mkPlugins();
		const app = mkApp(plugins);
		// raw(404) → release(200) 触发 fetchFirstUrl 的 404 续试分支；按文件返回对应文本
		reqUrl.mockImplementation((o: any) =>
			o.url.includes("releases/download")
				? Promise.resolve(ok(o.url.includes("manifest.json") ? manText : o.url.includes("main.js") ? "REL" : "CSS"))
				: Promise.resolve(nf()),
		);
		const man = await updatePluginCore(app, "pid", "a/b", {} as never, "1.2.3");
		expect(man.version).toBe("1.2.3");
		expect((app.vault.adapter.write as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
			".obsidian/plugins/pid/main.js",
			"REL",
		);
	});

	it("仓库非法 → 抛 noRepo（232-233）", async () => {
		await expect(updatePluginCore({} as never, "pid", "bad", {} as never, "1.2.3")).rejects.toThrow();
	});

	it("version 为空/空白 → 抛 noRepo（234-235）", async () => {
		await expect(updatePluginCore({} as never, "pid", "a/b", {} as never, "   ")).rejects.toThrow();
	});

	it("manifest 候选全部 404 → 抛 fetchFail（243, 100-102）", async () => {
		reqUrl.mockResolvedValue(nf());
		await expect(updatePluginCore({} as never, "pid", "a/b", {} as never, "1.2.3")).rejects.toThrow();
	});

	it("main 全部 404 → 抛 fetchFail（257, 100-102 非 optional 分支）", async () => {
		// manifest 命中一次即可让流程推进到 main；这里让 main 全 404
		let calls = 0;
		reqUrl.mockImplementation(() => {
			calls++;
			// 第一次（manifest）返回成功，后续（main）全 404
			return calls === 1 ? Promise.resolve(ok(manText)) : Promise.resolve(nf());
		});
		await expect(updatePluginCore({} as never, "pid", "a/b", {} as never, "1.2.3")).rejects.toThrow();
	});
});

describe("fetchWithReleaseFallback（经最新路径间接覆盖 + 直接调用）", () => {
	it("raw 200 → 直接返回，不试 release（108-132）", async () => {
		reqUrl.mockResolvedValue(ok("RAW"));
		const r = await fetchWithReleaseFallback("a/b", "main.js", "", {} as never);
		expect(r).toBe("RAW");
	});

	it("raw 404 → release 200 回退（108-132）", async () => {
		reqUrl.mockImplementation((o: any) =>
			o.url.includes("release/") ? Promise.resolve(ok("REL")) : Promise.resolve(nf()),
		);
		const r = await fetchWithReleaseFallback("a/b", "main.js", "", {} as never);
		expect(r).toBe("REL");
	});

	it("raw 与 release 均 404 且 optional → null（130-131）", async () => {
		reqUrl.mockResolvedValue(nf());
		const r = await fetchWithReleaseFallback(
			"a/b",
			"styles.css",
			"",
			{} as never,
			true,
		);
		expect(r).toBeNull();
	});

	it("raw 与 release 均 404 且非 optional → 抛 fetchFail（130-131）", async () => {
		reqUrl.mockResolvedValue(nf());
		await expect(
			fetchWithReleaseFallback("a/b", "main.js", "", {} as never),
		).rejects.toThrow();
	});

	it("服务端错误（500）→ 直接抛 fetchFail（125-127）", async () => {
		reqUrl.mockResolvedValue(srv(500));
		await expect(
			fetchWithReleaseFallback("a/b", "main.js", "", {} as never),
		).rejects.toThrow();
	});

	it("仓库非法 → raw 空且 gh 为空 → 抛 fetchFail（115-119）", async () => {
		await expect(
			fetchWithReleaseFallback("bad", "main.js", "", {} as never),
		).rejects.toThrow();
	});
});
