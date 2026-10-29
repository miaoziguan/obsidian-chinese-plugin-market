import { describe, it, expect } from "vitest";
import { buildRawFileUrl, resolveUrl, classifyNetworkError, type MirrorConfig, type MirrorSource } from "@domain/catalog/mirror";
import { buildManifestUrl, buildMainJsUrl } from "@domain/compare/plugin-insight";

const RAW = "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json";

describe("仓库文件 URL 共用构造", () => {
	it.each<MirrorConfig>([
		{ source: "github" },
		{ source: "jsdelivr" },
		{ source: "ghproxy" },
		{ source: "custom", customBase: "https://mirror.example.com/" },
		{ source: "custom" },
	])("manifest、入口文件与指定 ref 使用相同的镜像规则：%j", (mirror) => {
		const base = "https://raw.githubusercontent.com/owner/repo";
		expect(buildManifestUrl("/owner/repo/", mirror)).toBe(resolveUrl(`${base}/HEAD/manifest.json`, mirror));
		expect(buildMainJsUrl("owner/repo", " dist/plugin.js ", mirror)).toBe(resolveUrl(`${base}/HEAD/dist/plugin.js`, mirror));
		expect(buildMainJsUrl("owner/repo", "   ", mirror)).toBe(resolveUrl(`${base}/HEAD/main.js`, mirror));
		expect(buildRawFileUrl("owner/repo", "styles.css", mirror, "v1.2.3")).toBe(resolveUrl(`${base}/v1.2.3/styles.css`, mirror));
	});

	it.each([undefined, "", "owner", "owner//repo", "owner/repo/extra", "///"])("非法仓库不生成下载 URL：%s", (repo) => {
		expect(buildRawFileUrl(repo, "main.js", { source: "github" })).toBe("");
		expect(buildManifestUrl(repo, { source: "github" })).toBe("");
	});
});

describe("resolveUrl", () => {
	it("github 源原样返回", () => {
		expect(resolveUrl(RAW, { source: "github" })).toBe(RAW);
	});

	it("jsdelivr 映射到 cdn.jsdelivr.net/gh 并保留 @ref", () => {
		const out = resolveUrl(RAW, { source: "jsdelivr" });
		expect(out).toBe(
			"https://cdn.jsdelivr.net/gh/obsidianmd/obsidian-releases@master/community-plugins.json"
		);
	});

	it("jsdelivr 保留非 master 分支", () => {
		const url =
			"https://raw.githubusercontent.com/foo/bar/main/path/to/file.json";
		expect(resolveUrl(url, { source: "jsdelivr" })).toBe(
			"https://cdn.jsdelivr.net/gh/foo/bar@main/path/to/file.json"
		);
	});

	it("ghproxy 在原始 url 前拼代理前缀", () => {
		expect(resolveUrl(RAW, { source: "ghproxy" })).toBe(
			"https://gh-proxy.com/https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json"
		);
	});

	it("custom 用 customBase 替换 raw.githubusercontent.com 部分", () => {
		expect(
			resolveUrl(RAW, { source: "custom", customBase: "https://mirror.example.com" })
		).toBe(
			"https://mirror.example.com/obsidianmd/obsidian-releases/master/community-plugins.json"
		);
	});

	it("custom 缺 base 时回退到原样", () => {
		expect(resolveUrl(RAW, { source: "custom" })).toBe(RAW);
	});

	it("未知 source 回退到原样（默认不破坏）", () => {
		expect(resolveUrl(RAW, { source: "github" as MirrorSource })).toBe(RAW);
	});
});

describe("classifyNetworkError", () => {
	it("超时 → timeout", () => {
		expect(classifyNetworkError(new Error("request timeout")).kind).toBe("timeout");
		expect(classifyNetworkError(new Error("ETIMEDOUT")).kind).toBe("timeout");
	});

	it("DNS 失败 → dns", () => {
		expect(classifyNetworkError(new Error("getaddrinfo ENOTFOUND")).kind).toBe("dns");
		expect(classifyNetworkError(new Error("EAI_AGAIN")).kind).toBe("dns");
	});

	it("被墙/403 → blocked 且建议切镜像", () => {
		const r = classifyNetworkError(new Error("403 Forbidden raw.githubusercontent.com"));
		expect(r.kind).toBe("blocked");
		expect(r.suggestMirror).toBe(true);
	});

	it("JSON 解析失败 → json", () => {
		expect(classifyNetworkError(new Error("Unexpected token in JSON")).kind).toBe("json");
	});

	it("HTTP 状态码 → http", () => {
		expect(classifyNetworkError(new Error("HTTP 500")).kind).toBe("http");
	});

	it("其余 → unknown", () => {
		expect(classifyNetworkError(new Error("boom")).kind).toBe("unknown");
	});

	it("字符串输入也能分类", () => {
		expect(classifyNetworkError("ETIMEDOUT").kind).toBe("timeout");
	});

	it("非 Error 非 string → unknown", () => {
		expect(classifyNetworkError(null).kind).toBe("unknown");
		expect(classifyNetworkError(42).kind).toBe("unknown");
	});
});
