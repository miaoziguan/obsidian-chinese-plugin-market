import { describe, it, expect } from "vitest";
import {
	parseJournalNote,
	renderJournalNote,
	VERDICT_PRESETS,
	type JournalEntry,
} from "@domain/journal/journal-entry";

describe("评测笔记 frontmatter 往返", () => {
	it("解析完整字段", () => {
		const raw = [
			"---",
			"id: obsidian-calendar",
			"name: Calendar",
			"status: abandoned",
			"rating: 2",
			"verdict: [冲突, 不更新]",
			"firstInstalled: 1740000000000",
			"installCount: 2",
			"enabled: false",
			"updated: 1747000000000",
			"---",
			"",
			"和 Daily Note 冲突。",
		].join("\n");
		const e = parseJournalNote(raw)!;
		expect(e.id).toBe("obsidian-calendar");
		expect(e.status).toBe("abandoned");
		expect(e.rating).toBe(2);
		expect(e.verdict).toEqual(["冲突", "不更新"]);
		expect(e.installCount).toBe(2);
		expect(e.enabled).toBe(false);
		expect(e.note).toBe("和 Daily Note 冲突。");
	});

	it("渲染后再解析应等价", () => {
		const e: JournalEntry = {
			id: "a",
			name: "A",
			status: "using",
			rating: 5,
			verdict: ["不好用"],
			note: "备注\n第二行",
			updated: 1,
		};
		expect(parseJournalNote(renderJournalNote(e))).toEqual(e);
	});

	it("缺字段 / 坏内容不抛错", () => {
		expect(parseJournalNote("没有 frontmatter 的纯文本")).toBeNull();
		expect(parseJournalNote("---\nid: x\n---\n")).toMatchObject({ id: "x" });
		expect(parseJournalNote("---\nno-id: 1\n---\n")).toBeNull();
	});

	it("评分越界视为未填，状态非法视为未填", () => {
		const e = parseJournalNote("---\nid: x\nrating: 9\nstatus: 乱写\n---\n")!;
		expect(e.rating).toBeUndefined();
		expect(e.status).toBeUndefined();
	});

	it("弃用原因预设可被解析（预设值本身合法）", () => {
		const e: JournalEntry = {
			id: "y",
			name: "Y",
			verdict: [...VERDICT_PRESETS],
			note: "",
		};
		expect(parseJournalNote(renderJournalNote(e))?.verdict).toEqual([
			...VERDICT_PRESETS,
		]);
	});
});
