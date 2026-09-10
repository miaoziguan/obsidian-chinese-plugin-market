import { describe, it, expect } from "vitest";
import { resolveInstallRoot } from "@app/direct-install";

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