import { describe, it, expect } from "vitest";
import { expandQuery, PLUGIN_SYNONYMS } from "@translation/lexicon/synonyms";

describe("expandQuery 同义词扩展", () => {
	it("命中中文词时追加英文别名", () => {
		const out = expandQuery("思维导图");
		expect(out).toContain("mind map");
		expect(out).toContain("markmap");
	});
	it("未命中的 query 原样返回", () => {
		expect(expandQuery("Notion")).toBe("Notion");
	});
	it("多个同义词命中都追加", () => {
		const out = expandQuery("笔记 同步");
		expect(out).toContain("note");
		expect(out).toContain("sync");
	});
	it("补充中文口语别名时追加对应英文领域词", () => {
		expect(expandQuery("脑图")).toContain("mind map");
		expect(expandQuery("导图")).toContain("mind map");
		expect(expandQuery("稍后读")).toContain("read later");
		expect(expandQuery("阅读清单")).toContain("reading list");
		expect(expandQuery("图片托管")).toContain("image hosting");
	});
	it("覆盖高频领域术语的中文变体", () => {
		expect(expandQuery("文献引用")).toContain("bibliography");
		expect(expandQuery("白板")).toContain("excalidraw");
		expect(expandQuery("截止日期")).toContain("deadline");
		expect(expandQuery("时间追踪")).toContain("time tracking");
		expect(expandQuery("收件箱")).toContain("quick capture");
		expect(expandQuery("语音转文字")).toContain("transcription");
		expect(expandQuery("代码块")).toContain("code block");
		expect(expandQuery("幻灯片")).toContain("presentation");
		expect(expandQuery("任务管理")).toContain("task management");
		expect(expandQuery("知识图谱")).toContain("knowledge graph");
		expect(expandQuery("格式化")).toContain("formatter");
		expect(expandQuery("挖空")).toContain("cloze deletion");
	});
	it("同义词表非空且格式正确", () => {
		expect(Object.keys(PLUGIN_SYNONYMS).length).toBeGreaterThan(20);
		for (const [cn, aliases] of Object.entries(PLUGIN_SYNONYMS)) {
			expect(cn.length).toBeGreaterThan(0);
			expect(aliases.length).toBeGreaterThan(0);
		}
	});
});
