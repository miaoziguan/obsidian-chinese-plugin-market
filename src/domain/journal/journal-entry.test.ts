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
		expect(e.name).toBe("Calendar");
		expect(e.status).toBe("abandoned");
		expect(e.rating).toBe(2);
		expect(e.verdict).toEqual(["冲突", "不更新"]);
		expect(e.firstInstalled).toBe(1740000000000);
		expect(e.installCount).toBe(2);
		expect(e.enabled).toBe(false);
		expect(e.updated).toBe(1747000000000);
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
		expect(parseJournalNote("")).toBeNull();
	});

	it("评分越界 / 小数 / 非数字视为未填，状态非法视为未填", () => {
		const over = parseJournalNote("---\nid: x\nrating: 9\n---\n")!;
		expect(over.rating).toBeUndefined();
		const frac = parseJournalNote("---\nid: x\nrating: 3.5\n---\n")!;
		expect(frac.rating).toBeUndefined();
		const bad = parseJournalNote("---\nid: x\nrating: abc\n---\n")!;
		expect(bad.rating).toBeUndefined();
		const st = parseJournalNote("---\nid: x\nstatus: 乱写\n---\n")!;
		expect(st.status).toBeUndefined();
	});

	it("弃用原因预设必须恰好是这 8 个（硬编码锁定）", () => {
		// 不能用 VERDICT_PRESETS 自己断言自己——那样改错/漏项也会全绿
		expect([...VERDICT_PRESETS]).toEqual([
			"不好用",
			"有 bug",
			"有替代",
			"太重",
			"收费",
			"不更新",
			"冲突",
			"用不上",
		]);
		expect(VERDICT_PRESETS).toHaveLength(8);
	});

	it("全部预设值可完整往返", () => {
		const e: JournalEntry = { id: "y", name: "Y", verdict: [...VERDICT_PRESETS], note: "" };
		expect(parseJournalNote(renderJournalNote(e))?.verdict).toEqual([
			...VERDICT_PRESETS,
		]);
	});

	it("CRLF 换行可正常解析", () => {
		const raw = "---\r\nid: a\r\nname: A\r\nstatus: using\r\n---\r\n\r\n备注\r\n";
		const e = parseJournalNote(raw)!;
		expect(e.id).toBe("a");
		expect(e.status).toBe("using");
		expect(e.note).toBe("备注");
	});

	it("BOM 与前导空行不导致解析失败（避免已写笔记被静默当作不存在）", () => {
		expect(parseJournalNote("\uFEFF---\nid: a\nname: A\n---\n\n备注")?.id).toBe("a");
		expect(parseJournalNote("\n\n---\nid: b\nname: B\n---\n\n备注")?.id).toBe("b");
	});

	it("id / name 含 # 或 : 时不被 YAML 截断", () => {
		const e: JournalEntry = { id: "my#plugin", name: "名: 称", note: "" };
		const parsed = parseJournalNote(renderJournalNote(e))!;
		expect(parsed.id).toBe("my#plugin");
		expect(parsed.name).toBe("名: 称");
	});
});
