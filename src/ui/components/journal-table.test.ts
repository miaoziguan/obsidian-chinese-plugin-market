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
		expect(lines[0]).toContain("journal.col.uninstalled");
	});
});

describe("最后卸载列", () => {
	const data: JournalRow[] = [
		{ id: "a", name: "A", firstInstalled: 100, lastActive: 200, uninstalled: 150, estimated: true },
		{ id: "b", name: "B", firstInstalled: 300, lastActive: 400 },
	];

	it("导出 Markdown：卸载时间独立成列，未卸载为「—」", () => {
		const lines = journalRowsToMarkdown(data, (k) => k as string).split("\n");
		const cellsA = lines[2].split(" | ");
		const cellsB = lines[3].split(" | ");
		// 列序：插件 | 状态 | 评分 | 原因 | 首次安装 | 最近动态 | 最后卸载 | 备注
		expect(cellsA[6]).not.toBe("—");
		expect(cellsB[6]).toBe("—");
	});

	it("估算时间加「≈」前缀，避免把推断值当精确时间", () => {
		const lines = journalRowsToMarkdown(data, (k) => k as string).split("\n");
		expect(lines[2]).toContain("≈");
		expect(lines[3]).not.toContain("≈");
	});

	it("可按最后卸载排序（无卸载时间的排在最前/最后）", () => {
		expect(sortJournalRows(data, "uninstalled", false)[0].id).toBe("a");
		expect(sortJournalRows(data, "uninstalled", true)[0].id).toBe("b");
	});
});
