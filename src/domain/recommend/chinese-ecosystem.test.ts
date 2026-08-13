import { describe, it, expect } from "vitest";
import { isChineseEcosystem, containsHan, isPinyinSurname } from "@domain/recommend/chinese-ecosystem";

const P = (author: string, name = "p", description = "en") => ({ author, name, description });

describe("containsHan", () => {
	it("含汉字返回 true", () => {
		expect(containsHan("张三")).toBe(true);
		expect(containsHan("ob中文idian")).toBe(true);
	});
	it("纯英文/数字返回 false", () => {
		expect(containsHan("John")).toBe(false);
		expect(containsHan("")).toBe(false);
	});
});

describe("isPinyinSurname", () => {
	it("常见中文姓氏拼音命中", () => {
		expect(isPinyinSurname("li-zixin")).toBe(true);
		expect(isPinyinSurname("wang")).toBe(true);
		expect(isPinyinSurname("zhang xiaoming")).toBe(true);
		expect(isPinyinSurname("chen_wei")).toBe(true);
	});
	it("非拼音名不命中", () => {
		expect(isPinyinSurname("John")).toBe(false);
		expect(isPinyinSurname("obsidian")).toBe(false);
	});
});

describe("isChineseEcosystem（先粗后精的粗层）", () => {
	it("author 含汉字 → 中文生态", () => {
		expect(isChineseEcosystem(P("张三"))).toBe(true);
	});
	it("name 含汉字 → 中文生态", () => {
		expect(isChineseEcosystem(P("John", "中文插件"))).toBe(true);
	});
	it("description 含中文 → 中文生态（中文 README/描述信号）", () => {
		expect(isChineseEcosystem(P("John", "p", "一款中文插件，用于增强 Obsidian"))).toBe(true);
	});
	it("author 命中中文姓氏拼音 → 中文生态", () => {
		expect(isChineseEcosystem(P("wang-zixuan"))).toBe(true);
	});
	it("纯英文作者/名/描述 → 非中文生态", () => {
		expect(isChineseEcosystem(P("John", "dataview", "A powerful plugin"))).toBe(false);
	});
});
