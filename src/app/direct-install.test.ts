import { describe, it, expect } from "vitest";
import {
	resolveInstallRoot,
	parseSourceSpec,
	parseGithubRepoFromRaw,
	githubReleaseAssetUrls,
	pickExactNameMatch,
	rebuildUpdateSpec,
} from "@app/direct-install";

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