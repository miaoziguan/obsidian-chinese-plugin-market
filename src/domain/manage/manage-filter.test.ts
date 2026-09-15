import { describe, it, expect } from "vitest";
import {
	countByGroup,
	matchesFilter,
	matchesKeyword,
	NO_REMARK_QUERY,
} from "./manage-filter";
import { GROUP_ALL, GROUP_OTHER, type ManageRow } from "./types";

function row(overrides: Partial<ManageRow> = {}): ManageRow {
	return {
		id: "a",
		name: "Templater",
		author: "SilentVoid",
		remark: "",
		group: GROUP_OTHER,
		enabled: true,
		...overrides,
	};
}

describe("matchesKeyword", () => {
	it("空关键词全部命中", () => {
		expect(matchesKeyword(row(), "")).toBe(true);
	});

	it("匹配名称 / 描述 / 备注，忽略大小写", () => {
		expect(matchesKeyword(row(), "templater")).toBe(true);
		expect(matchesKeyword(row(), "silent")).toBe(true);
		expect(matchesKeyword(row({ remark: "常用" }), "常用")).toBe(true);
	});

	it("特殊语法 ??? 只匹配无备注的条目", () => {
		expect(matchesKeyword(row(), NO_REMARK_QUERY)).toBe(true);
		expect(matchesKeyword(row({ remark: "x" }), NO_REMARK_QUERY)).toBe(false);
	});

	it("全不匹配时返回 false", () => {
		expect(matchesKeyword(row(), "nonexistent")).toBe(false);
	});
});

describe("matchesFilter", () => {
	it("分组筛选：全部不过滤，指定分组需相等", () => {
		const r = row({ group: "1" });
		expect(matchesFilter(r, { keyword: "", group: GROUP_ALL, status: "all" })).toBe(true);
		expect(matchesFilter(r, { keyword: "", group: "1", status: "all" })).toBe(true);
		expect(matchesFilter(r, { keyword: "", group: "2", status: "all" })).toBe(false);
	});

	it("状态筛选：启用 / 未启用", () => {
		const enabled = row({ enabled: true });
		expect(matchesFilter(enabled, { keyword: "", group: GROUP_ALL, status: "enabled" })).toBe(true);
		expect(matchesFilter(enabled, { keyword: "", group: GROUP_ALL, status: "disabled" })).toBe(false);
	});
});

describe("countByGroup", () => {
	it("按分组统计命中数，并给出总数", () => {
		const rows = [
			row({ id: "a", group: "1" }),
			row({ id: "b", group: "1", enabled: false }),
			row({ id: "c", group: "2" }),
		];
		const counts = countByGroup(rows, { keyword: "", group: GROUP_ALL, status: "all" });
		expect(counts[GROUP_ALL]).toBe(3);
		expect(counts["1"]).toBe(2);
		expect(counts["2"]).toBe(1);
	});

	it("统计忽略分组筛选本身（选中某组时其它组仍有数）", () => {
		const rows = [row({ id: "a", group: "1" }), row({ id: "c", group: "2" })];
		const counts = countByGroup(rows, { keyword: "", group: "1", status: "all" });
		expect(counts["2"]).toBe(1);
	});

	it("状态筛选影响计数", () => {
		const rows = [row({ id: "a", enabled: true }), row({ id: "b", enabled: false })];
		const counts = countByGroup(rows, { keyword: "", group: GROUP_ALL, status: "enabled" });
		expect(counts[GROUP_ALL]).toBe(1);
	});
});
