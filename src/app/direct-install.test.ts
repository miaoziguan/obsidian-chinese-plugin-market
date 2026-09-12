import { describe, it, expect } from "vitest";
import {
	resolveInstallRoot,
	parseGithubRepoFromRaw,
	githubReleaseAssetUrls,
} from "@app/direct-install";

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