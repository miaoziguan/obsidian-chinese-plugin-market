import { describe, it, expect } from "vitest";
import {
	protectMarkdown,
	restoreMarkdown,
	splitBatches,
	splitBatchesDetailed,
	joinBatches,
} from "./macos-shortcuts";

describe("macos-shortcuts · Markdown 占位保护（方案 A）", () => {
	it("保护围栏代码块并还原", () => {
		const md = "标题\n\n```js\nconst a = 1;\n```\n\n结束";
		const { text, blocks } = protectMarkdown(md);
		// 代码块被替换成占位 token
		expect(text).not.toContain("const a = 1;");
		expect(text).toContain("ZZCMPLACE");
		expect(blocks.length).toBe(1);
		// 模拟系统翻译（此处原样返回，token 不变）
		const translated = text;
		expect(restoreMarkdown(translated, blocks)).toBe(md);
	});

	it("保护行内代码", () => {
		const md = "使用 `npm install` 安装。";
		const { text, blocks } = protectMarkdown(md);
		expect(text).not.toContain("npm install");
		expect(text).toContain("ZZCMPLACE");
		expect(restoreMarkdown(text, blocks)).toBe(md);
	});

	it("保护表格分隔行", () => {
		const md = "| A | B |\n|---|---|\n| 1 | 2 |";
		const { text, blocks } = protectMarkdown(md);
		expect(blocks.some((b) => b.includes("---"))).toBe(true);
		// 分隔行被占位，不随翻译变化
		expect(restoreMarkdown(text, blocks)).toBe(md);
	});

	it("保护链接整体（text 与 URL 均不被翻译破坏）", () => {
		const md = "看 [文档](https://example.com/docs)";
		const { text, blocks } = protectMarkdown(md);
		// 整个 [text](url) 被替换为占位符，避免 URL 被翻译破坏
		expect(text).not.toContain("[文档]");
		expect(text).not.toContain("https://example.com");
		expect(blocks.some((b) => b.includes("https://example.com"))).toBe(true);
		expect(restoreMarkdown(text, blocks)).toBe(md);
	});

	it("图片保护后还原为友好「[图片]」占位，不残留坏链", () => {
		const md = "截图：![demo](https://example.com/demo.png) 说明";
		const { text, blocks } = protectMarkdown(md);
		expect(text).not.toContain("example.com");
		// 图片块在 blocks 中存为 [图片]，还原后为「[图片]」而非原文坏链
		expect(restoreMarkdown(text, blocks)).toContain("[图片]");
	});

	it("保护 HTML 标签", () => {
		const md = "<img src=\"/logo.png\" alt=\"logo\"> 与 <!-- 注释 -->";
		const { text, blocks } = protectMarkdown(md);
		expect(text).not.toContain("<img");
		expect(restoreMarkdown(text, blocks)).toBe(md);
	});

	it("token 原样保留时能正确还原（系统翻译对全大写乱串通常原样保留）", () => {
		const md = "代码 `x` 结束";
		const { text, blocks } = protectMarkdown(md);
		// 模拟系统翻译原样保留了 token（其余正文被翻译）
		const translated = text.replace("使用", "译").replace("安装", "装");
		expect(restoreMarkdown(translated, blocks)).toBe(md);
	});

	it("token 完全不可识别的改写不会崩溃", () => {
		const md = "代码 `x` 结束";
		const { text, blocks } = protectMarkdown(md);
		const broken = text.replace(/ZZCMPLACE\d+ZZ/g, "xxx");
		const restored = restoreMarkdown(broken, blocks);
		// 无法识别时保留改写后的文本（不崩溃、不抛错即可）
		expect(typeof restored).toBe("string");
	});

	it("无受保护结构时原样通过", () => {
		const md = "纯文本段落，没有特殊结构。";
		const { text, blocks } = protectMarkdown(md);
		expect(text).toBe(md);
		expect(blocks.length).toBe(0);
	});

	it("嵌套占位：链接内含行内代码时能完整还原（不残留 token）", () => {
		const md = "点击 [看 `config.json` 文件](https://example.com/docs) 了解";
		const { text, blocks } = protectMarkdown(md);
		const restored = restoreMarkdown(text, blocks);
		expect(restored).not.toContain("ZZCMPLACE");
		expect(restored).toBe(md);
	});

	it("嵌套占位：图片 alt 内含行内代码时不丢失内容", () => {
		const md = "图 ![见 `x` 示例](https://example.com/a.png) 结束";
		const { text, blocks } = protectMarkdown(md);
		const restored = restoreMarkdown(text, blocks);
		expect(restored).not.toContain("ZZCMPLACE");
		expect(restored).toContain("[图片]");
	});

	it("嵌套占位：HTML 标签内含行内代码", () => {
		const md = "<span title=\"`a`\">文本</span>";
		const { text, blocks } = protectMarkdown(md);
		const restored = restoreMarkdown(text, blocks);
		expect(restored).not.toContain("ZZCMPLACE");
		expect(restored).toBe(md);
	});
});

describe("macos-shortcuts · splitBatches 分段", () => {
	it("短文本不分段", () => {
		expect(splitBatches("hello", 900)).toEqual(["hello"]);
	});

	it("按段落边界拆分，且每段不超过上限", () => {
		const para = "a".repeat(300);
		const text = `${para}\n\n${para}\n\n${para}\n\n${para}`; // 4 段，每段 300 字
		const batches = splitBatches(text, 900);
		expect(batches.length).toBe(2); // 每批最多装 2 段（300*2=600 ≤900）
		for (const b of batches) expect(b.length).toBeLessThanOrEqual(900);
		// 拼接回原文（含段间空行）
		expect(batches.join("\n\n")).toBe(text);
	});

	it("单段超限时按字符硬切，完整覆盖不丢失", () => {
		const text = "x".repeat(2000);
		const batches = splitBatches(text, 900);
		expect(batches.every((b) => b.length <= 900)).toBe(true);
		expect(batches.join("")).toBe(text); // 不丢失任何字符
	});
});

describe("macos-shortcuts · joinBatches 还原分隔符", () => {
	it("硬切的长段落拼回后不插入空行", () => {
		const text = "A".repeat(950) + " END";
		const { batches, separators } = splitBatchesDetailed(text, 900);
		expect(batches.length).toBeGreaterThan(1);
		expect(joinBatches(batches, batches, separators)).toBe(text);
	});

	it("跨批次时保留原始段落分隔符（三个换行不被归一化）", () => {
		const text = "x".repeat(800) + "\n\n\n" + "y".repeat(800);
		const { batches, separators } = splitBatchesDetailed(text, 900);
		expect(batches.length).toBe(2);
		expect(joinBatches(batches, batches, separators)).toBe(text);
	});

	it("普通段落分隔符保持 \\n\\n", () => {
		const para = "a".repeat(300);
		const text = `${para}\n\n${para}\n\n${para}\n\n${para}`;
		const { batches, separators } = splitBatchesDetailed(text, 900);
		expect(joinBatches(batches, batches, separators)).toBe(text);
	});

	it("译文长度不同也按原分隔符拼接", () => {
		const text = "x".repeat(800) + "\n\n\n" + "y".repeat(800);
		const { batches, separators } = splitBatchesDetailed(text, 900);
		expect(joinBatches(["译1", "译2"], batches, separators)).toBe("译1\n\n\n译2");
	});

	it("splitBatchesDetailed 的批次+分隔符可无损还原原文", () => {
		const cases = [
			"A".repeat(950) + " END",
			"x".repeat(800) + "\n\n\n" + "y".repeat(800),
			"p1\n\np2\n\n" + "z".repeat(1500) + "\n\ntail",
			"a".repeat(2000),
		];
		for (const text of cases) {
			const { batches, separators } = splitBatchesDetailed(text, 900);
			expect(separators.length).toBe(batches.length - 1);
			expect(joinBatches(batches, batches, separators)).toBe(text);
		}
	});

	it("边界：段落长度恰为 limit 整数倍时仍无损", () => {
		const cases: Array<[string, number]> = [
			["A".repeat(100) + "\n\n\n" + "B".repeat(30), 50], // 整数倍 + 后续段落
			["A".repeat(100), 50], // 整数倍且结尾
			["A".repeat(50) + "\n\n" + "B".repeat(60), 50], // 单段恰等于 limit
			["A".repeat(60) + "\n\n", 50], // 末尾带分隔符
			["x".repeat(120) + "\n\n" + "y".repeat(10) + "\n\n\n" + "z".repeat(200), 50],
		];
		for (const [text, limit] of cases) {
			const { batches, separators } = splitBatchesDetailed(text, limit);
			expect(separators.length).toBe(batches.length - 1);
			expect(joinBatches(batches, batches, separators)).toBe(text);
		}
	});

	it("批次均不超过上限（硬切保底生效）", () => {
		const text = "x".repeat(120) + "\n\n" + "y".repeat(10) + "\n\n\n" + "z".repeat(200);
		const { batches } = splitBatchesDetailed(text, 50);
		for (const b of batches) expect(b.length).toBeLessThanOrEqual(50);
	});
});
