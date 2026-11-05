import { describe, it, expect, vi, beforeEach } from "vitest";
import * as obsidian from "obsidian";
import {
	resolveInstallRoot,
	parseSourceSpec,
	parseGithubRepoFromRaw,
	githubReleaseAssetUrls,
	pickExactNameMatch,
	rebuildUpdateSpec,
	isFloatingGithubRef,
	FetchMissingError,
	fetchFromUrls,
	fetchFileText,
	fetchLatestReleaseManifest,
	resolveRemoteManifest,
	installFromUrl,
	installThemeFromUrl,
	updateBetaPlugin,
	updateBetaTheme,
	type SourceSpec,
	type BetaPluginEntry,
} from "@app/direct-install";
// 覆盖 obsidian 默认「未 mock 即抛错」的 requestUrl 为可控 vi.fn()，以便驱动网络函数
// （vi.mock 在 import 之后声明；vitest 会将其 hoist 到顶部，运行时 obsidian 引用已被 mock）
vi.mock("obsidian", async (importOriginal) => {
	const actual = await importOriginal<typeof import("obsidian")>();
	return { ...actual, requestUrl: vi.fn() };
});

describe("parseSourceSpec — 钉选分支/标签/commit（P1）", () => {
	it("简写 owner/repo → raw HEAD，非 release", () => {
		const s = parseSourceSpec("owner/repo");
		expect(s.root.origin + s.root.pathname).toBe(
			"https://raw.githubusercontent.com/owner/repo/HEAD/",
		);
		expect(s.gh).toEqual({ owner: "owner", repo: "repo" });
		expect(s.release).toBe(false);
	});

	it("owner/repo@分支 → raw 该分支", () => {
		expect(parseSourceSpec("owner/repo@dev").root.pathname).toBe("/owner/repo/dev/");
	});

	it("owner/repo@标签（含点号）→ raw 该标签", () => {
		expect(parseSourceSpec("owner/repo@1.2.3").root.pathname).toBe("/owner/repo/1.2.3/");
	});

	it("owner/repo@commit（短 SHA）→ raw 该 commit", () => {
		expect(parseSourceSpec("owner/repo@abc1234").root.pathname).toBe("/owner/repo/abc1234/");
	});

	it("分支名含斜杠也支持", () => {
		expect(parseSourceSpec("owner/repo@feature/x").root.pathname).toBe(
			"/owner/repo/feature/x/",
		);
	});

	it("owner/repo@release → release 模式", () => {
		const s = parseSourceSpec("owner/repo@release");
		expect(s.release).toBe(true);
		expect(s.releaseTag).toBeUndefined();
	});

	it("owner/repo@latest → release 模式", () => {
		expect(parseSourceSpec("owner/repo@latest").release).toBe(true);
	});

	it("GitHub /releases/tag/<tag> → release 模式且钉住 tag", () => {
		const s = parseSourceSpec("https://github.com/owner/repo/releases/tag/1.2.3");
		expect(s.release).toBe(true);
		expect(s.releaseTag).toBe("1.2.3");
	});

	it("GitHub /releases → release 模式（latest）", () => {
		expect(parseSourceSpec("https://github.com/owner/repo/releases").release).toBe(true);
	});

	it("github.com/owner/repo（无 scheme）自动补 https", () => {
		expect(parseSourceSpec("github.com/owner/repo").root.pathname).toBe(
			"/owner/repo/HEAD/",
		);
	});

	it("raw.githubusercontent 直链 → 保留 root 并反解 gh", () => {
		const s = parseSourceSpec("https://raw.githubusercontent.com/owner/repo/HEAD/");
		expect(s.root.pathname).toBe("/owner/repo/HEAD/");
		expect(s.gh).toEqual({ owner: "owner", repo: "repo" });
	});

	it("非 GitHub 目录 → gh=null、非 release", () => {
		const s = parseSourceSpec("https://example.com/myplugin/");
		expect(s.gh).toBeNull();
		expect(s.release).toBe(false);
	});

	it("带 .git 的简写也能识别", () => {
		expect(parseSourceSpec("owner/repo.git").root.pathname).toBe("/owner/repo/HEAD/");
	});

	it("无 scheme 的普通网址不误判为仓库简写", () => {
		// example.com 含点，不匹配 owner 的 [\w-]+，应当报地址错误而非生成错误 raw 链接
		expect(() => parseSourceSpec("example.com/myplugin")).toThrow();
	});
});

describe("resolveInstallRoot", () => {
	it("GitHub 仓库 URL（无尾斜杠）→ raw HEAD", () => {
		const r = resolveInstallRoot("https://github.com/MarcBolo/Inflow");
		expect(r.origin + r.pathname).toBe(
			"https://raw.githubusercontent.com/MarcBolo/Inflow/HEAD/"
		);
	});
	it("GitHub 仓库 URL（带尾斜杠）", () => {
		const r = resolveInstallRoot("https://github.com/owner/repo/");
		expect(r.origin + r.pathname).toBe(
			"https://raw.githubusercontent.com/owner/repo/HEAD/"
		);
	});
	it("GitHub .git 后缀", () => {
		const r = resolveInstallRoot("https://github.com/owner/repo.git");
		expect(r.origin + r.pathname).toBe(
			"https://raw.githubusercontent.com/owner/repo/HEAD/"
		);
	});
	it("GitHub /tree/<branch>", () => {
		const r = resolveInstallRoot("https://github.com/owner/repo/tree/dev");
		expect(r.origin + r.pathname).toBe(
			"https://raw.githubusercontent.com/owner/repo/dev/"
		);
	});
	it("GitHub /tree/<branch> 带斜杠分支", () => {
		const r = resolveInstallRoot("https://github.com/owner/repo/tree/feature/x");
		expect(r.origin + r.pathname).toBe(
			"https://raw.githubusercontent.com/owner/repo/feature/x/"
		);
	});
	it("GitHub /blob/<branch>/manifest.json", () => {
		const r = resolveInstallRoot(
			"https://github.com/owner/repo/blob/main/manifest.json"
		);
		expect(r.origin + r.pathname).toBe(
			"https://raw.githubusercontent.com/owner/repo/main/"
		);
	});
	it("GitHub URL 保留 query", () => {
		const r = resolveInstallRoot("https://github.com/owner/repo?ref=abc");
		expect(r.pathname).toBe("/owner/repo/HEAD/");
		expect(r.search).toBe("?ref=abc");
	});
	it("GitHub 仅 owner（无 repo）→ badUrl", () => {
		expect(() => resolveInstallRoot("https://github.com/owner")).toThrow(/地址/);
	});
	it("非 GitHub 目录 URL → 原样标准化", () => {
		const r = resolveInstallRoot("https://example.com/myplugin/");
		expect(r.origin + r.pathname).toBe("https://example.com/myplugin/");
	});
	it("非 GitHub manifest.json 链接 → 取父目录", () => {
		const r = resolveInstallRoot("https://example.com/myplugin/manifest.json");
		expect(r.origin + r.pathname).toBe("https://example.com/myplugin/");
	});
	it("http://localhost 放行（dev）", () => {
		const r = resolveInstallRoot(
			"http://localhost:3000/myplugin/manifest.json"
		);
		expect(r.origin + r.pathname).toBe("http://localhost:3000/myplugin/");
	});
	it("http 非 localhost → needHttps", () => {
		expect(() => resolveInstallRoot("http://example.com/myplugin/")).toThrow(
			/https/
		);
	});
	it("无效 URL → badUrl", () => {
		expect(() => resolveInstallRoot("not a url")).toThrow();
	});
	it("去掉 fragment", () => {
		const r = resolveInstallRoot("https://example.com/p/#frag");
		expect(r.hash).toBe("");
	});
});

describe("parseGithubRepoFromRaw", () => {
	it("raw 根 URL 反解 owner/repo", () => {
		const u = new URL("https://raw.githubusercontent.com/owner/repo/HEAD/");
		expect(parseGithubRepoFromRaw(u)).toEqual({ owner: "owner", repo: "repo" });
	});
	it("非 raw 域名返回 null", () => {
		expect(parseGithubRepoFromRaw(new URL("https://example.com/o/r/"))).toBeNull();
	});
	it("owner/repo 含非法字符返回 null", () => {
		expect(parseGithubRepoFromRaw(new URL("https://raw.githubusercontent.com/o a/r/"))).toBeNull();
	});
});

describe("githubReleaseAssetUrls", () => {
	it("带 version：精确 tag → v 前缀 tag → latest", () => {
		const urls = githubReleaseAssetUrls({ owner: "o", repo: "r" }, "main.js", "1.2.3");
		expect(urls).toEqual([
			"https://github.com/o/r/releases/download/1.2.3/main.js",
			"https://github.com/o/r/releases/download/v1.2.3/main.js",
			"https://github.com/o/r/releases/latest/download/main.js",
		]);
	});
	it("不带 version：仅 latest（manifest 回退用）", () => {
		expect(githubReleaseAssetUrls({ owner: "o", repo: "r" }, "manifest.json")).toEqual([
			"https://github.com/o/r/releases/latest/download/manifest.json",
		]);
	});
});

describe("rebuildUpdateSpec — 更新来源重建（releaseTag 丢失 bug 回归）", () => {
	it("release 条目还原钉选 tag → 更新走该 tag 而非 latest", () => {
		const spec = rebuildUpdateSpec({
			id: "x",
			name: "X",
			rootUrl: "https://raw.githubusercontent.com/o/x/1.2.3/",
			installedVersion: "1.0.0",
			frozen: false,
			kind: "plugin",
			release: true,
			releaseTag: "1.2.3",
		});
		expect(spec.release).toBe(true);
		expect(spec.releaseTag).toBe("1.2.3");
		// 关键断言：资产 URL 锁定到 1.2.3，而不是 latest
		expect(githubReleaseAssetUrls(spec.gh!, "main.js", spec.releaseTag)).toEqual([
			"https://github.com/o/x/releases/download/1.2.3/main.js",
			"https://github.com/o/x/releases/download/v1.2.3/main.js",
			"https://github.com/o/x/releases/latest/download/main.js",
		]);
	});

	it("无 releaseTag 的 release 条目（@release/@latest）退化为 latest", () => {
		const spec = rebuildUpdateSpec({
			id: "x",
			name: "X",
			rootUrl: "https://raw.githubusercontent.com/o/x/HEAD/",
			installedVersion: "1",
			frozen: false,
			kind: "plugin",
			release: true,
		});
		expect(spec.release).toBe(true);
		expect(spec.releaseTag).toBeUndefined();
		expect(githubReleaseAssetUrls(spec.gh!, "main.js", spec.releaseTag)).toEqual([
			"https://github.com/o/x/releases/latest/download/main.js",
		]);
	});

	it("普通分支条目：release 关、tag 不相关，走源码树", () => {
		const spec = rebuildUpdateSpec({
			id: "x",
			name: "X",
			rootUrl: "https://raw.githubusercontent.com/o/x/dev/",
			installedVersion: "1",
			frozen: false,
			kind: "plugin",
		});
		expect(spec.release).toBe(false);
		expect(spec.releaseTag).toBeUndefined();
		expect(spec.root.pathname).toBe("/o/x/dev/");
	});
});

describe("pickExactNameMatch", () => {
	it("仓库名完全一致 → 返回 full_name（真实案例）", () => {
		const items = [
			{ full_name: "viniciussoaresbr/sticky-colorful-notes", name: "sticky-colorful-notes" },
			{ full_name: "PandaNocturne/Obsidian-colorful-sticky-notes", name: "Obsidian-colorful-sticky-notes" },
		];
		expect(pickExactNameMatch(items, "Obsidian-colorful-sticky-notes")).toBe(
			"PandaNocturne/Obsidian-colorful-sticky-notes"
		);
	});
	it("大小写不同也匹配", () => {
		expect(pickExactNameMatch([{ full_name: "o/R", name: "R" }], "r")).toBe("o/R");
	});
	it("没有完全同名 → null（宁缺毋滥，避免误导安装）", () => {
		expect(pickExactNameMatch([{ full_name: "o/x", name: "x" }], "y")).toBeNull();
	});
	it("字段缺失或类型不对 → null", () => {
		expect(pickExactNameMatch([{}], "y")).toBeNull();
		expect(pickExactNameMatch([{ full_name: 1, name: "y" }], "y")).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────
// 追加用例：补齐此前未覆盖的网络核心函数与纯函数（isFloatingGithubRef / FetchMissingError /
// fetchFromUrls / fetchFileText / fetchLatestReleaseManifest / resolveRemoteManifest）。
// 用 vi.mock 后的可控 requestUrl 驱动，覆盖候选链切换、404/410 换源、非 404/410 直接报错、
// optional 缺失返回 null、FetchMissingError 抛出、Release 版本对照（floating+更高→改道 release）
// 等分支。保留原全部用例。
// ─────────────────────────────────────────────────────────────

const req = obsidian.requestUrl as unknown as ReturnType<typeof vi.fn>;

describe("direct-install · 网络/纯函数补齐", () => {
	beforeEach(() => {
		req.mockReset();
	});

	it("isFloatingGithubRef：raw + HEAD → true；非 raw / 钉选 ref → false", () => {
		expect(isFloatingGithubRef(new URL("https://raw.githubusercontent.com/o/r/HEAD/"))).toBe(true);
		expect(isFloatingGithubRef(new URL("https://raw.githubusercontent.com/o/r/main/"))).toBe(false);
		expect(isFloatingGithubRef(new URL("https://github.com/o/r/"))).toBe(false);
	});

	it("FetchMissingError：携带 file/status 且 instanceof Error", () => {
		const e = new FetchMissingError("manifest.json", 404);
		expect(e).toBeInstanceOf(Error);
		expect(e.file).toBe("manifest.json");
		expect(e.status).toBe(404);
	});

	it("fetchFromUrls：200 直接返回文本", async () => {
		req.mockResolvedValue({ status: 200, text: "hello" });
		expect(await fetchFromUrls(["u1"], "f")).toBe("hello");
	});

	it("fetchFromUrls：404→200 换源；全 404 且 optional→null，否则抛 FetchMissingError", async () => {
		req.mockResolvedValueOnce({ status: 404, text: "" })
			.mockResolvedValueOnce({ status: 200, text: "ok" });
		expect(await fetchFromUrls(["u1", "u2"], "f")).toBe("ok");
		req.mockResolvedValue({ status: 404, text: "" });
		expect(await fetchFromUrls(["u1"], "f", true)).toBeNull();
		await expect(fetchFromUrls(["u1"], "f")).rejects.toBeInstanceOf(FetchMissingError);
	});

	it("fetchFromUrls：非 404/410 状态码立即抛普通错误", async () => {
		req.mockResolvedValue({ status: 500, text: "" });
		await expect(fetchFromUrls(["u1"], "f")).rejects.toThrow();
	});

	it("fetchFileText：拼接 root+name 取文本；optional 缺失 → null", async () => {
		req.mockResolvedValue({ status: 200, text: "body" });
		expect(await fetchFileText(new URL("https://x.com/a/"), "m.json")).toBe("body");
		req.mockResolvedValue({ status: 404, text: "" });
		expect(await fetchFileText(new URL("https://x.com/a/"), "styles.css", [], true)).toBeNull();
	});

	it("fetchLatestReleaseManifest：版本化 manifest→返回；非版本/异常/缺失→null", async () => {
		req.mockResolvedValue({ status: 200, text: JSON.stringify({ id: "x", version: "1.0" }) });
		expect((await fetchLatestReleaseManifest({ owner: "o", repo: "r" }))?.version).toBe("1.0");
		req.mockResolvedValue({ status: 200, text: JSON.stringify({ id: "x" }) });
		expect(await fetchLatestReleaseManifest({ owner: "o", repo: "r" })).toBeNull();
		req.mockRejectedValue(new Error("net"));
		expect(await fetchLatestReleaseManifest({ owner: "o", repo: "r" })).toBeNull();
		req.mockResolvedValue({ status: 404, text: "" });
		expect(await fetchLatestReleaseManifest({ owner: "o", repo: "r" })).toBeNull();
	});

	it("resolveRemoteManifest：无 gh → 源码树 manifest、release=false", async () => {
		req.mockResolvedValue({ status: 200, text: JSON.stringify({ id: "x", version: "1.0" }) });
		const r = await resolveRemoteManifest({ root: new URL("https://x.com/a/"), gh: undefined, release: false } as unknown as SourceSpec);
		expect(r.release).toBe(false);
		expect(r.man.version).toBe("1.0");
	});

	it("resolveRemoteManifest：gh + 钉选 ref（非 floating）→ release=false", async () => {
		req.mockResolvedValue({ status: 200, text: JSON.stringify({ id: "x", version: "1.0" }) });
		const spec = { root: new URL("https://raw.githubusercontent.com/o/r/v1/"), gh: { owner: "o", repo: "r" }, release: false } as unknown as SourceSpec;
		const r = await resolveRemoteManifest(spec);
		expect(r.release).toBe(false);
	});

	it("resolveRemoteManifest：gh + floating + Release 更高 → release=true", async () => {
		// 源码树（raw HEAD）给 1.0，Release 资产（/releases/）给更高的 2.0
		req.mockImplementation((opts: { url: string }) =>
			Promise.resolve({
				status: 200,
				text: JSON.stringify({ id: "x", version: opts.url.includes("/releases/") ? "2.0" : "1.0" }),
			}),
		);
		const spec = { root: new URL("https://raw.githubusercontent.com/o/r/HEAD/"), gh: { owner: "o", repo: "r" }, release: false } as unknown as SourceSpec;
		const r = await resolveRemoteManifest(spec);
		expect(r.release).toBe(true);
		expect(r.man.version).toBe("2.0");
	});

	it("resolveRemoteManifest：release 模式 → 直接 fetchManifest、release=true", async () => {
		req.mockResolvedValue({ status: 200, text: JSON.stringify({ id: "x", version: "1.0" }) });
		const spec = { root: "https://raw.githubusercontent.com/o/r/HEAD/", gh: { owner: "o", repo: "r" }, release: true } as unknown as SourceSpec;
		const r = await resolveRemoteManifest(spec);
		expect(r.release).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────
// 追加用例：补齐安装/更新函数（installFiles 插件+主题双路径、writeThemeFiles、
// updateBetaPlugin/Theme 各分支、rebuildUpdateSpec）。用 fake app（vault.adapter + plugins +
// customCss）驱动，requestUrl 按文件后缀返回对应产物。保留原全部用例。
// ─────────────────────────────────────────────────────────────

type FakeApp = {
	vault: { adapter: Record<string, ReturnType<typeof vi.fn>>; configDir: string };
	plugins: Record<string, unknown>;
	customCss: Record<string, ReturnType<typeof vi.fn>>;
};

function makeApp(existsDefault = false): { app: FakeApp; adapter: Record<string, ReturnType<typeof vi.fn>> } {
	const adapter = {
		exists: vi.fn().mockResolvedValue(existsDefault),
		mkdir: vi.fn().mockResolvedValue(undefined),
		write: vi.fn().mockResolvedValue(undefined),
		remove: vi.fn().mockResolvedValue(undefined),
	};
	const plugins = {
		manifests: {} as Record<string, unknown>,
		enabledPlugins: { has: vi.fn().mockReturnValue(true) },
		loadManifests: vi.fn().mockResolvedValue(undefined),
		disablePlugin: vi.fn().mockResolvedValue(undefined),
		enablePluginAndSave: vi.fn().mockResolvedValue(undefined),
	};
	const customCss = { setTheme: vi.fn() };
	return { app: { vault: { adapter, configDir: ".obsidian" }, plugins, customCss } as unknown as FakeApp, adapter };
}

describe("direct-install · 安装/更新函数补齐", () => {
	beforeEach(() => {
		req.mockImplementation((opts: { url: string }) => {
			const u = opts.url;
			if (u.endsWith("manifest.json"))
				return Promise.resolve({ status: 200, text: JSON.stringify({ id: "x", name: "X", version: "1.0" }) });
			if (u.endsWith("main.js")) return Promise.resolve({ status: 200, text: "/* main */" });
			if (u.endsWith("styles.css")) return Promise.resolve({ status: 404, text: "" });
			if (u.endsWith("theme.css")) return Promise.resolve({ status: 200, text: "/* theme */" });
			return Promise.resolve({ status: 200, text: "" });
		});
	});

	it("installFromUrl：三件套写盘 + 重载启用（目录不存在→mkdir 分支）", async () => {
		const { app, adapter } = makeApp(false);
		const man = await installFromUrl(app as never, "owner/repo@v1.0");
		expect(man.id).toBe("x");
		expect(adapter.mkdir).toHaveBeenCalled();
		expect(adapter.write).toHaveBeenCalled();
		expect((app.plugins as Record<string, ReturnType<typeof vi.fn>>).enablePluginAndSave).toHaveBeenCalledWith("x");
	});

	it("installFromUrl：目录已存在且 styles 缺失 → 走 remove 分支", async () => {
		const { app, adapter } = makeApp(true);
		await installFromUrl(app as never, "owner/repo@v1.0");
		expect(adapter.mkdir).not.toHaveBeenCalled();
		expect(adapter.remove).toHaveBeenCalled();
	});

	it("installThemeFromUrl：无 manifest 的主题 → 用仓库名作目录名、版本留空", async () => {
		// 主题 manifest 缺失（optional），目录名回退到仓库名
		req.mockImplementation((opts: { url: string }) => {
			const u = opts.url;
			if (u.endsWith("manifest.json")) return Promise.resolve({ status: 404, text: "" });
			if (u.endsWith("theme.css")) return Promise.resolve({ status: 200, text: "/* theme */" });
			return Promise.resolve({ status: 404, text: "" });
		});
		const { app } = makeApp(false);
		const info = await installThemeFromUrl(app as never, "owner/theme-repo");
		expect(info.id).toBe("theme-repo");
		expect(info.version).toBe("");
		expect((app.customCss as Record<string, ReturnType<typeof vi.fn>>).setTheme).toHaveBeenCalledWith("theme-repo");
	});

	it("updateBetaPlugin：版本相同 → updated=false（不写盘）", async () => {
		const { app, adapter } = makeApp(false);
		const entry: BetaPluginEntry = {
			id: "x", name: "X", installedVersion: "1.0", rootUrl: "https://raw.githubusercontent.com/o/r/v1.0/", frozen: false, kind: "plugin",
		};
		const r = await updateBetaPlugin(app as never, entry);
		expect(r.updated).toBe(false);
		expect(adapter.write).not.toHaveBeenCalled();
	});

	it("updateBetaPlugin：版本不同 → 重新拉取写盘、updated=true", async () => {
		const { app } = makeApp(false);
		const entry: BetaPluginEntry = {
			id: "x", name: "X", installedVersion: "0.9", rootUrl: "https://raw.githubusercontent.com/o/r/v1.0/", frozen: false, kind: "plugin",
		};
		const r = await updateBetaPlugin(app as never, entry);
		expect(r.updated).toBe(true);
		expect(r.manifest.version).toBe("1.0");
	});

	it("updateBetaPlugin：远程 id 与记录不一致 → 抛 idMismatch", async () => {
		req.mockResolvedValue({ status: 200, text: JSON.stringify({ id: "y", name: "Y", version: "1.0" }) });
		const { app } = makeApp(false);
		const entry: BetaPluginEntry = {
			id: "x", name: "X", installedVersion: "1.0", rootUrl: "https://raw.githubusercontent.com/o/r/v1.0/", frozen: false, kind: "plugin",
		};
		await expect(updateBetaPlugin(app as never, entry)).rejects.toThrow();
	});

	it("updateBetaTheme：无 manifest 且版本无法判断 → 重拉 theme.css、updated=true", async () => {
		const { app } = makeApp(false);
		const entry: BetaPluginEntry = {
			id: "theme-repo", name: "Theme", installedVersion: "", rootUrl: "https://raw.githubusercontent.com/o/r/HEAD/", frozen: false, kind: "theme",
		};
		const r = await updateBetaTheme(app as never, entry);
		expect(r.updated).toBe(true);
		expect((app.customCss as Record<string, ReturnType<typeof vi.fn>>).setTheme).toHaveBeenCalledWith("theme-repo");
	});

	it("rebuildUpdateSpec：还原 release 开关与钉选 tag", () => {
		const entry: BetaPluginEntry = {
			id: "x", name: "X", installedVersion: "1.0", rootUrl: "https://raw.githubusercontent.com/o/r/v1.0/", frozen: false, kind: "plugin", release: true, releaseTag: "v2.0",
		};
		const spec = rebuildUpdateSpec(entry);
		expect(spec.release).toBe(true);
		expect(spec.releaseTag).toBe("v2.0");
	});
});