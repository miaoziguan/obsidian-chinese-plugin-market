import { describe, it, expect } from "vitest";
import { buildReadmeUrl } from "./mirror";

/**
 * 详情抽屉 README 拉取 URL 构造（产品改进 #8）。
 * 由 repo（owner/name）拼出 raw README 地址，并按镜像映射。
 */
describe("buildReadmeUrl", () => {
	it("github 原始：HEAD 分支的 README.md", () => {
		expect(buildReadmeUrl("blacksmithgu/obsidian-dataview", { source: "github" })).toBe(
			"https://raw.githubusercontent.com/blacksmithgu/obsidian-dataview/HEAD/README.md"
		);
	});

	it("jsdelivr 镜像映射", () => {
		expect(
			buildReadmeUrl("owner/repo", { source: "jsdelivr" })
		).toBe("https://cdn.jsdelivr.net/gh/owner/repo@HEAD/README.md");
	});

	it("ghproxy 前缀", () => {
		expect(buildReadmeUrl("owner/repo", { source: "ghproxy" })).toBe(
			"https://gh-proxy.com/https://raw.githubusercontent.com/owner/repo/HEAD/README.md"
		);
	});

	it("custom base 替换", () => {
		expect(
			buildReadmeUrl("owner/repo", {
				source: "custom",
				customBase: "https://my.mirror.com",
			})
		).toBe("https://my.mirror.com/owner/repo/HEAD/README.md");
	});

	it("空 repo 返回空串", () => {
		expect(buildReadmeUrl("", { source: "github" })).toBe("");
		expect(buildReadmeUrl(undefined, { source: "github" })).toBe("");
	});

	it("非法 repo（无斜杠）返回空串", () => {
		expect(buildReadmeUrl("justname", { source: "github" })).toBe("");
	});

	it("去除 repo 首尾多余斜杠", () => {
		expect(buildReadmeUrl("/owner/repo/", { source: "github" })).toBe(
			"https://raw.githubusercontent.com/owner/repo/HEAD/README.md"
		);
	});
});
