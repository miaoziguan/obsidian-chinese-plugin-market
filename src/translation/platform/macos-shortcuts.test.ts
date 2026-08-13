import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import {
	protectMarkdown,
	restoreMarkdown,
	splitMarkdownForTranslate,
	splitBatches,
	splitBatchesDetailed,
	joinBatches,
	isMacOS,
	setPlatformCapability,
	macosSystemTranslate,
} from "@translation/platform/macos-shortcuts";

/**
 * 平台解耦验收：不再依赖 Obsidian 的 Platform，
 * 平台能力由装配期注入，单测可自由构造四种组合。
 */
describe("macos-shortcuts · PlatformCapability 端口注入", () => {
	afterEach(() => {
		setPlatformCapability({ isDesktopApp: false, isMacOS: false });
	});

	it("未注入（默认）时视为非 macOS 桌面端，按钮不渲染", () => {
		expect(isMacOS()).toBe(false);
	});

	it("仅 desktop + macOS 同时成立才为 true", () => {
		setPlatformCapability({ isDesktopApp: true, isMacOS: true });
		expect(isMacOS()).toBe(true);

		setPlatformCapability({ isDesktopApp: true, isMacOS: false });
		expect(isMacOS()).toBe(false);

		setPlatformCapability({ isDesktopApp: false, isMacOS: true });
		expect(isMacOS()).toBe(false);
	});

	it("非 macOS 时 macosSystemTranslate 直接抛错，不进子进程分支", async () => {
		setPlatformCapability({ isDesktopApp: false, isMacOS: false });
		await expect(macosSystemTranslate("hello")).rejects.toThrow(/仅 macOS 桌面端/);
	});

	it("macOS 下空文本短路返回空串（不调用快捷指令）", async () => {
		setPlatformCapability({ isDesktopApp: true, isMacOS: true });
		await expect(macosSystemTranslate("   ")).resolves.toBe("");
	});
});

describe("macos-shortcuts · 多段全部失败返回空串（上层走失败提示，而非把原文当译文）", () => {
	let origRequire: unknown;

	beforeEach(() => {
		setPlatformCapability({ isDesktopApp: true, isMacOS: true });
		// 存档并替换 window.require：spawn 出的快捷指令子进程立即 error，其余模块给最小桩
		origRequire = (window as unknown as { require?: unknown }).require;
		(window as unknown as { require?: unknown }).require = ((id: string) => {
			if (id === "child_process") {
				return {
					spawn: () => ({
						stderr: { on: () => {} },
						stdout: { on: () => {} },
						on: (ev: string, cb: (err: Error) => void) => {
							if (ev === "error") cb(new Error("spawn ENOENT"));
						},
					}),
				};
			}
			if (id === "fs") return { writeFileSync: () => {}, unlinkSync: () => {}, readFileSync: () => "" };
			if (id === "path") return { join: (...p: string[]) => p.join("/") };
			if (id === "os") return { tmpdir: () => "/tmp" };
			throw new Error(`unexpected require: ${id}`);
		}) as NodeJS.Require;
	});

	afterEach(() => {
		(window as unknown as { require?: unknown }).require = origRequire;
		setPlatformCapability({ isDesktopApp: false, isMacOS: false });
		vi.useRealTimers();
	});

	it("多段全部失败（重试耗尽后）返回空串而非原文", async () => {
		// 两个 >900 字的段落 → 必然拆成多批，且每批子进程都在 error 时立即失败
		const para = "长文本".repeat(167); // 501 字
		const text = `段落一${para}\n\n段落二${para}`;
		vi.useFakeTimers();
		const p = macosSystemTranslate(text);
		// 每批 3 次重试（退避 400+800ms 等），推进假计时器让重试与子进程回调完成
		await vi.advanceTimersByTimeAsync(60_000);
		await expect(p).resolves.toBe("");
	});

	it("部分失败时仍 best-effort 拼回（失败段用原文占位）", async () => {
		// 桩：第一次调用成功（写出可读译文），其余失败
		(window as unknown as { require?: unknown }).require = (() => {
			let call = 0;
			return (id: string) => {
				if (id === "child_process") {
					return {
						spawn: () => {
							call++;
							return {
								stderr: { on: () => {} },
								stdout: { on: () => {} },
								on: (ev: string, cb: (code: number | Error) => void) => {
									// 第一次 spawn 成功：不触发 error，close 时 code 0（已有可读译文）
									if (call === 1) {
										if (ev === "close") cb(0);
										return;
									}
									// 其余重试触发 error 或非 0 close → 该批失败
									if (ev === "error" || ev === "close") {
										cb(ev === "close" ? 1 : new Error("spawn ENOENT"));
									}
								},
							};
						},
					};
				}
				if (id === "fs") {
					return { writeFileSync: () => {}, unlinkSync: () => {}, readFileSync: () => "译文" };
				}
				if (id === "path") return { join: (...p: string[]) => p.join("/") };
				if (id === "os") return { tmpdir: () => "/tmp" };
				throw new Error(`unexpected require: ${id}`);
			};
		})() as NodeJS.Require;

		const para = "长文本".repeat(167); // 501 字
		const text = `段落一${para}\n\n段落二${para}`;
		vi.useFakeTimers();
		const p = macosSystemTranslate(text);
		await vi.advanceTimersByTimeAsync(120_000);
		// 至少第一段译文「译文」被拼进结果，非空串
		await expect(p).resolves.toContain("译文");
	});
});

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

	it("图片保护后原样还原（URL 不被翻译、渲染不失效）", () => {
		const md = "截图：![demo](https://example.com/demo.png) 说明";
		const { text, blocks } = protectMarkdown(md);
		// 图片整体占位，URL 不进翻译文本
		expect(text).not.toContain("example.com");
		// 原样保存原始图片语法，还原后图片仍可见
		expect(restoreMarkdown(text, blocks)).toBe(md);
	});

	it("保护引用式图片与引用定义行（URL 不被翻译改写）", () => {
		const md = "![logo][1]\n\n[1]: https://example.com/logo.png";
		const { text, blocks } = protectMarkdown(md);
		expect(text).not.toContain("example.com");
		expect(text).not.toContain("[1]");
		expect(restoreMarkdown(text, blocks)).toBe(md);
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

	it("嵌套占位：图片 alt 内含行内代码时完整还原图片", () => {
		const md = "图 ![见 `x` 示例](https://example.com/a.png) 结束";
		const { text, blocks } = protectMarkdown(md);
		const restored = restoreMarkdown(text, blocks);
		expect(restored).not.toContain("ZZCMPLACE");
		expect(restored).toBe(md);
	});

	it("嵌套占位：HTML 标签内含行内代码", () => {
		const md = "<span title=\"`a`\">文本</span>";
		const { text, blocks } = protectMarkdown(md);
		const restored = restoreMarkdown(text, blocks);
		expect(restored).not.toContain("ZZCMPLACE");
		expect(restored).toBe(md);
	});
});

describe("macos-shortcuts · Markdown 拆解翻译（方案 B，结构不进翻译引擎）", () => {
	it("图片与行内代码拆为不译块，正文留文本块", () => {
		const md = "Default binding shortcut key `Ctrl+1`\n\n![](https://example.com/x.png)";
		const blocks = splitMarkdownForTranslate(md);
		const textBlocks = blocks.filter((b) => !b.isKeep).map((b) => b.value);
		const keeps = blocks.filter((b) => b.isKeep).map((b) => b.value);
		// URL 与行内代码从不进入文本块
		expect(textBlocks.join("")).not.toContain("https://example.com");
		expect(textBlocks.join("")).not.toContain("Ctrl+1");
		expect(keeps.some((k) => k.includes("https://example.com"))).toBe(true);
		// 拼回等于原 md（拆解无损）
		expect(blocks.map((b) => b.value).join("")).toBe(md);
	});

	it("链接拆为不译块（text 与 URL 均不送翻译引擎）", () => {
		const md = "看 [文档](https://example.com/docs) 说明";
		const blocks = splitMarkdownForTranslate(md);
		const textBlocks = blocks.filter((b) => !b.isKeep).map((b) => b.value);
		expect(textBlocks.join("")).not.toContain("example.com");
		expect(textBlocks.join("")).not.toContain("文档");
		expect(blocks.map((b) => b.value).join("")).toBe(md);
	});

	it("代码块整段拆为不译块", () => {
		const md = "```js\nconst a = 1;\n```\n\n之后正文";
		const blocks = splitMarkdownForTranslate(md);
		const textBlocks = blocks.filter((b) => !b.isKeep).map((b) => b.value);
		const keeps = blocks.filter((b) => b.isKeep).map((b) => b.value);
		expect(textBlocks.join("")).not.toContain("const a = 1;");
		expect(keeps.some((k) => k.includes("const a = 1;"))).toBe(true);
		expect(blocks.map((b) => b.value).join("")).toBe(md);
	});

	it("引用式图片与定义行拆为不译块（URL 不进翻译引擎）", () => {
		const md = "![logo][1]\n\n[1]: https://example.com/logo.png\n\n说明文字";
		const blocks = splitMarkdownForTranslate(md);
		const textBlocks = blocks.filter((b) => !b.isKeep).map((b) => b.value);
		expect(textBlocks.join("")).not.toContain("example.com");
		expect(textBlocks.join("")).not.toContain("[1]");
		expect(blocks.map((b) => b.value).join("")).toBe(md);
	});

	it("用户实地故障样例：图片 URL 不再出现在可译文本中", () => {
		// cumany 的 README 原样：行内代码 + 4 空格缩进图片行
		const md =
			"Default binding shortcut key `Ctrl+1,ctrl+2,...Ctrl+6`\n" +
			"       ![](https://raw.githubusercontent.com/cumany/cumany/main//pic/202209071707695.png)";
		const blocks = splitMarkdownForTranslate(md);
		const textBlocks = blocks.filter((b) => !b.isKeep).map((b) => b.value);
		const keeps = blocks.filter((b) => b.isKeep).map((b) => b.value);
		// 图片 URL 整体进入不译块
		expect(keeps.join("")).toContain("https://raw.githubusercontent.com/cumany/cumany");
		// 可译文本中绝无 URL 残留
		expect(textBlocks.join("")).not.toContain("raw.githubusercontent.com");
		// 拆解无损拼回
		expect(blocks.map((b) => b.value).join("")).toBe(md);
	});

	it("相邻不译块自动合并，拆解顺序与原文一致", () => {
		const md = "![a](u)[b](v) 正文";
		const blocks = splitMarkdownForTranslate(md);
		const keeps = blocks.filter((b) => b.isKeep).map((b) => b.value);
		const texts = blocks.filter((b) => !b.isKeep).map((b) => b.value);
		// 相邻图片+链接（无文本间隔）合并为一个不译块
		expect(keeps.length).toBe(1);
		expect(keeps[0]).toBe("![a](u)[b](v)");
		// 仅剩「 正文」作为文本块
		expect(texts.join("")).toBe(" 正文");
		expect(blocks.map((b) => b.value).join("")).toBe(md);
	});

	it("无结构时整篇为单个文本块", () => {
		const md = "纯文本段落，没有特殊结构。";
		const blocks = splitMarkdownForTranslate(md);
		expect(blocks.length).toBe(1);
		expect(blocks[0].isKeep).toBe(false);
		expect(blocks[0].value).toBe(md);
	});

	it("HTML 标签拆为不译块，正文留文本块", () => {
		const md = "<div>容器</div> 说明";
		const blocks = splitMarkdownForTranslate(md);
		const textBlocks = blocks.filter((b) => !b.isKeep).map((b) => b.value);
		const keeps = blocks.filter((b) => b.isKeep).map((b) => b.value);
		expect(textBlocks.join("")).not.toContain("<div>");
		expect(keeps.some((k) => k.includes("<div>"))).toBe(true);
		expect(blocks.map((b) => b.value).join("")).toBe(md);
	});

	it("标题标记拆为不译块：`# ` 前缀不进翻译引擎（防止译文变成 `##标题` 无法渲染）", () => {
		const md = "## 标题\n\n### 三级标题";
		const blocks = splitMarkdownForTranslate(md);
		const textBlocks = blocks.filter((b) => !b.isKeep).map((b) => b.value);
		const keeps = blocks.filter((b) => b.isKeep).map((b) => b.value);
		// 第二行标记前带换行（^ 匹配行首含 \n），keep 块仍完整保留 `### ` 样式
		expect(keeps.some((k) => k.includes("### "))).toBe(true);
		expect(keeps.some((k) => k.includes("## "))).toBe(true);
		expect(textBlocks.join("")).toContain("标题");
		expect(textBlocks.join("")).toContain("三级标题");
		expect(blocks.map((b) => b.value).join("")).toBe(md);
	});

	it("列表标记拆为不译块：`- ` / `1. ` 前缀保留，只翻内容", () => {
		const md = "- 列表项\n\n1. 有序项";
		const blocks = splitMarkdownForTranslate(md);
		const textBlocks = blocks.filter((b) => !b.isKeep).map((b) => b.value);
		const keeps = blocks.filter((b) => b.isKeep).map((b) => b.value);
		expect(keeps.some((k) => k.includes("1. "))).toBe(true);
		expect(keeps.some((k) => k.includes("- "))).toBe(true);
		expect(textBlocks.join("")).not.toContain("- ");
		expect(textBlocks.join("")).not.toContain("1. ");
		expect(textBlocks.join("")).toContain("列表项");
		expect(textBlocks.join("")).toContain("有序项");
		expect(blocks.map((b) => b.value).join("")).toBe(md);
	});

	it("引用标记拆为不译块：`> ` 前缀保留", () => {
		const md = "> 引用内容";
		const blocks = splitMarkdownForTranslate(md);
		const keeps = blocks.filter((b) => b.isKeep).map((b) => b.value);
		expect(keeps).toContain("> ");
		expect(blocks.map((b) => b.value).join("")).toBe(md);
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
