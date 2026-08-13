import { describe, it, expect } from "vitest";
import { buildReadmeUrl, rewriteReadmeUrls } from "@domain/catalog/mirror";

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

describe("rewriteReadmeUrls（相对路径重写，对齐 better-store readme.ts）", () => {
	const REPO = "owner/repo";
	it("Markdown 图片相对路径 → raw.githubusercontent.com", () => {
		expect(rewriteReadmeUrls("![demo](images/demo.png)", REPO)).toBe(
			"![demo](https://raw.githubusercontent.com/owner/repo/HEAD/images/demo.png)"
		);
	});
	it("Markdown 链接相对路径 → github blob 视图", () => {
		expect(rewriteReadmeUrls("[doc](docs/guide.md)", REPO)).toBe(
			"[doc](https://github.com/owner/repo/blob/HEAD/docs/guide.md)"
		);
	});
	it("HTML img 相对路径 → raw.githubusercontent.com", () => {
		expect(rewriteReadmeUrls('<img src="assets/a.png" alt="a">', REPO)).toBe(
			'<img src="https://raw.githubusercontent.com/owner/repo/HEAD/assets/a.png" alt="a">'
		);
	});
	it("绝对 URL 原样保留（http / https / 协议相对 / 锚点 / mailto / data / obsidian）", () => {
		expect(rewriteReadmeUrls("![x](https://a.com/b.png)", REPO)).toBe("![x](https://a.com/b.png)");
		expect(rewriteReadmeUrls("![x](//cdn.com/b.png)", REPO)).toBe("![x](//cdn.com/b.png)");
		expect(rewriteReadmeUrls("[x](#section)", REPO)).toBe("[x](#section)");
		expect(rewriteReadmeUrls("[x](mailto:a@b.com)", REPO)).toBe("[x](mailto:a@b.com)");
		expect(rewriteReadmeUrls("[x](obsidian://open)", REPO)).toBe("[x](obsidian://open)");
	});
	it("前导 ./ 归一化（./ 去除；.b.png 隐藏文件不剥点）", () => {
		expect(rewriteReadmeUrls("![x](./a.png) ![y](.b.png)", REPO)).toBe(
			"![x](https://raw.githubusercontent.com/owner/repo/HEAD/a.png) ![y](https://raw.githubusercontent.com/owner/repo/HEAD/.b.png)"
		);
	});
	it("链接后的图片（负向后视）不被当图片重写为 raw", () => {
		// [text](url) 形式且非 ! 开头 → 走 blob；这里验证负向后视不误伤链接
		expect(rewriteReadmeUrls("[a](b.md) ![c](d.png)", REPO)).toBe(
			"[a](https://github.com/owner/repo/blob/HEAD/b.md) ![c](https://raw.githubusercontent.com/owner/repo/HEAD/d.png)"
		);
	});
});
