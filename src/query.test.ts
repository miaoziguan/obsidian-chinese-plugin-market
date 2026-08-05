import { describe, it, expect } from "vitest";
import {
	parseQuery,
	matchQueryAST,
	isAdvancedQuery,
	type QueryFields,
} from "./query";

/**
 * 高级搜索语法（产品改进 #3）单测。
 *
 * 语法约定：
 *  - 空格分词 = AND（全部 term 命中）
 *  - `|` 或 `OR` = OR（任一命中）
 *  - `-词` = 排除（命中则淘汰）
 *  - `author:xxx` / `name:xxx` / `id:xxx` = 字段限定
 *  - `"精确短语"` = 短语作为一个整体子串匹配
 */
describe("parseQuery", () => {
	it("空输入返回空 AST（无 term，非 advanced）", () => {
		const ast = parseQuery("");
		expect(ast.terms.length).toBe(0);
		expect(ast.orGroups.length).toBe(0);
		expect(ast.excludes.length).toBe(0);
		expect(ast.advanced).toBe(false);
	});

	it("纯子串（单个普通词）不算 advanced", () => {
		const ast = parseQuery("dataview");
		expect(ast.advanced).toBe(false);
		expect(ast.terms).toEqual([{ field: "any", value: "dataview" }]);
	});

	it("多个空格分词 = AND", () => {
		const ast = parseQuery("sync git");
		expect(ast.advanced).toBe(true);
		expect(ast.terms.map((t) => t.value)).toEqual(["sync", "git"]);
		expect(ast.terms.every((t) => t.field === "any")).toBe(true);
	});

	it("排除项 -legacy", () => {
		const ast = parseQuery("sync -legacy");
		expect(ast.advanced).toBe(true);
		expect(ast.terms.map((t) => t.value)).toEqual(["sync"]);
		expect(ast.excludes).toEqual([{ field: "any", value: "legacy" }]);
	});

	it("字段限定 author:xxx", () => {
		const ast = parseQuery("author:blacksmithgu");
		expect(ast.advanced).toBe(true);
		expect(ast.terms).toEqual([{ field: "author", value: "blacksmithgu" }]);
	});

	it("字段限定 name:/id: 与普通词混合", () => {
		const ast = parseQuery("name:calendar tag");
		expect(ast.advanced).toBe(true);
		expect(ast.terms).toEqual([
			{ field: "name", value: "calendar" },
			{ field: "any", value: "tag" },
		]);
	});

	it("精确短语 \"quoted phrase\" 作为一个 term", () => {
		const ast = parseQuery('"mind map"');
		expect(ast.advanced).toBe(true);
		expect(ast.terms).toEqual([{ field: "any", value: "mind map" }]);
	});

	it("字段 + 精确短语 name:\"foo bar\"", () => {
		const ast = parseQuery('name:"foo bar"');
		expect(ast.advanced).toBe(true);
		expect(ast.terms).toEqual([{ field: "name", value: "foo bar" }]);
	});

	it("OR 分组：a | b", () => {
		const ast = parseQuery("calendar | timeline");
		expect(ast.advanced).toBe(true);
		expect(ast.orGroups.length).toBe(1);
		expect(ast.orGroups[0].map((t) => t.value).sort()).toEqual([
			"calendar",
			"timeline",
		]);
	});

	it("OR 关键字（大小写不敏感）：a OR b", () => {
		const ast = parseQuery("calendar OR timeline");
		expect(ast.advanced).toBe(true);
		expect(ast.orGroups.length).toBe(1);
		expect(ast.orGroups[0].map((t) => t.value).sort()).toEqual([
			"calendar",
			"timeline",
		]);
	});

	it("排除的字段限定 -author:foo", () => {
		const ast = parseQuery("-author:foo");
		expect(ast.excludes).toEqual([{ field: "author", value: "foo" }]);
	});

	it("无空格 OR 写法 a|b 等价 a | b（回归 L1）", () => {
		const ast = parseQuery("calendar|timeline");
		expect(ast.orGroups.length).toBe(1);
		expect(ast.orGroups[0].map((t) => t.value).sort()).toEqual([
			"calendar",
			"timeline",
		]);
	});

	it("OR 组后跟排除项时组内已收集词不丢失（回归 L1：a | -b）", () => {
		const ast = parseQuery("calendar | -legacy");
		// 修复前 calendar 被整个丢弃；修复后归档为单成员 OR 组
		expect(ast.orGroups.length).toBe(1);
		expect(ast.orGroups[0].map((t) => t.value)).toEqual(["calendar"]);
		expect(ast.excludes).toEqual([{ field: "any", value: "legacy" }]);
	});
});

describe("isAdvancedQuery", () => {
	it("普通单词不是 advanced", () => {
		expect(isAdvancedQuery("dataview")).toBe(false);
	});
	it("含空格是 advanced", () => {
		expect(isAdvancedQuery("a b")).toBe(true);
	});
	it("含 - 前缀是 advanced", () => {
		expect(isAdvancedQuery("-x")).toBe(true);
	});
	it("含 field: 是 advanced", () => {
		expect(isAdvancedQuery("author:x")).toBe(true);
	});
	it("含引号是 advanced", () => {
		expect(isAdvancedQuery('"x"')).toBe(true);
	});
	it("含 | 是 advanced", () => {
		expect(isAdvancedQuery("a|b")).toBe(true);
	});
});

describe("matchQueryAST", () => {
	const fields: QueryFields = {
		name: "dataview",
		id: "dataview",
		description: "advanced query and views for your notes",
		author: "blacksmithgu",
		blob: "dataview dataview advanced query and views for your notes blacksmithgu",
	};

	const match = (input: string, f: QueryFields = fields) =>
		matchQueryAST(f, parseQuery(input));

	it("单个普通词命中 blob", () => {
		expect(match("query")).toBe(true);
		expect(match("nonexistent")).toBe(false);
	});

	it("AND：全部命中才为真", () => {
		expect(match("query views")).toBe(true);
		expect(match("query missing")).toBe(false);
	});

	it("排除项命中则淘汰", () => {
		expect(match("query -legacy")).toBe(true);
		expect(match("query -views")).toBe(false);
	});

	it("字段限定 author:", () => {
		expect(match("author:blacksmithgu")).toBe(true);
		expect(match("author:someoneelse")).toBe(false);
	});

	it("字段限定 name:（子串）", () => {
		expect(match("name:data")).toBe(true);
		expect(match("name:calendar")).toBe(false);
	});

	it("精确短语作为整体匹配", () => {
		expect(match('"advanced query"')).toBe(true);
		// 词序颠倒的短语不应命中
		expect(match('"query advanced"')).toBe(false);
	});

	it("OR 分组：任一命中即为真", () => {
		expect(match("calendar | query")).toBe(true);
		expect(match("calendar | timeline")).toBe(false);
	});

	it("OR 与 AND 混合：AND 全中 且 OR 组任一命中", () => {
		// views(AND) 命中 且 (calendar|query) 其一命中
		expect(match("views calendar | query")).toBe(true);
		// missing(AND) 不命中 → 整体 false
		expect(match("missing calendar | query")).toBe(false);
	});

	it("空 AST 视为匹配（无约束）", () => {
		expect(matchQueryAST(fields, parseQuery(""))).toBe(true);
	});

	it("字段限定大小写不敏感", () => {
		expect(match("author:BLACKSMITHGU")).toBe(true);
		expect(match("NAME:Data")).toBe(true);
	});

	it("词命中大小写不敏感：大写词也能命中小写 blob（固化 P2-b）", () => {
		// 关键词路径：view-data 先 lowercase 再进 matchesPlugin；
		// 高级路径：parseQuery 内部 lowercase term.value。
		// 两条路径对用户输入大小写都应透明。
		expect(match("QUERY")).toBe(true);
		expect(match("query")).toBe(true);
		expect(match("NOTAREALTOKEN")).toBe(false);
	});

	it("字段值大小写不敏感：大写字段值命中小写内容（固化 P2-b）", () => {
		expect(match("author:BLACKSMITHGU")).toBe(true);
		expect(match("description:ADVANCED")).toBe(true);
	});
});
