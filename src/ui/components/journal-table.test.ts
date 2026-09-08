import { describe, it, expect } from "vitest";
import {
	filterJournalRows,
	sortJournalRows,
	journalRowsToMarkdown,
	type JournalRow,
} from "@ui/components/journal-table";

const rows: JournalRow[] = [
	{ id: "a", name: "Calendar", status: "abandoned", rating: 2, firstInstalled: 100, lastActive: 200, verdict: ["冲突"], note: "note-x" },
	{ id: "b", name: "Dataview", status: "using", rating: 5, firstInstalled: 50, lastActive: 300, note: "note-y" },
	{ id: "c", name: "Temp", status: undefined, firstInstalled: 10, lastActive: 400, note: "note-z" },
];

describe("filterJournalRows", () => {
	it("all 返回全部", () => {
		expect(filterJournalRows(rows, { search: "", status: "all", verdict: null })).toHaveLength(3);
	});
	it("按状态筛选（含 tried = 仅装过/无评测）", () => {
		expect(filterJournalRows(rows, { search: "", status: "using", verdict: null })).toHaveLength(1);
		expect(filterJournalRows(rows, { search: "", status: "tried", verdict: null })).toHaveLength(1);
	});
	it("按弃用原因筛选", () => {
		expect(filterJournalRows(rows, { search: "", status: "all", verdict: "冲突" })).toHaveLength(1);
	});
	it("关键词命中备注/名/ID", () => {
		expect(filterJournalRows(rows, { search: "note-y", status: "all", verdict: null })).toHaveLength(1);
		expect(filterJournalRows(rows, { search: "data", status: "all", verdict: null })).toHaveLength(1);
	});
});

describe("sortJournalRows", () => {
	it("评分降序", () => {
		expect(sortJournalRows(rows, "rating", false)[0].id).toBe("b");
	});
	it("名称升序", () => {
		expect(sortJournalRows(rows, "name", true)[0].id).toBe("a");
	});
	it("最近动态降序", () => {
		expect(sortJournalRows(rows, "lastActive", false)[0].id).toBe("c");
	});
});

describe("journalRowsToMarkdown", () => {
	it("表头 + 分隔 + 数据行", () => {
		const md = journalRowsToMarkdown(rows, (k) => k as string);
		const lines = md.split("\n");
		expect(lines.length).toBe(5);
		expect(lines[0]).toContain("journal.col.name");
	});
});
