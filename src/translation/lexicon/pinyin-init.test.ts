import { describe, it, expect } from "vitest";
import { groupAuthorsByName, getFirstLetter } from "@translation/lexicon/pinyin-init";

describe("getFirstLetter", () => {
	it("拉丁字母名取首字符大写", () => {
		expect(getFirstLetter("obsidian")).toBe("O");
		expect(getFirstLetter("Liam")).toBe("L");
	});

	it("中文姓氏按拼音首字母归类", () => {
		expect(getFirstLetter("张三")).toBe("Z");
		expect(getFirstLetter("李四")).toBe("L");
	});

	it("未知/非字母开头归入 #", () => {
		expect(getFirstLetter("123abc")).toBe("#");
		expect(getFirstLetter("")).toBe("#");
		expect(getFirstLetter("🍎")).toBe("#");
	});
});

describe("groupAuthorsByName", () => {
	it("每个字母（含 #）最多一个分组，且 # 置底", () => {
		const authors = [
			{ name: "Zhang", count: 1 },
			{ name: "123user", count: 1 },
			{ name: "赵六", count: 1 },
			{ name: "Zoe", count: 1 },
			{ name: "_anon", count: 1 },
			{ name: "周七", count: 1 },
		];
		const groups = groupAuthorsByName(authors);
		const letters = groups.map((g) => g.letter);
		// 无重复字母
		expect(new Set(letters).size).toBe(letters.length);
		// # 在末尾（且只有一个）
		expect(letters.filter((l) => l === "#")).toEqual(["#"]);
		expect(letters[letters.length - 1]).toBe("#");
	});

	it("修复：排序后 # 与字母穿插不再产生重复 #", () => {
		// 构造一组会让 collator 把非字母作者穿插在拼音作者之间的数据
		const authors = [
			{ name: "Alice", count: 1 },
			{ name: "1hook", count: 1 },
			{ name: "Bob", count: 1 },
			{ name: "_dev", count: 1 },
			{ name: "张三", count: 1 },
		];
		const groups = groupAuthorsByName(authors);
		const hashes = groups.filter((g) => g.letter === "#");
		expect(hashes.length).toBe(1);
		// 组内作者完整（1hook、_dev 都进了同一个 # 组）
		expect(hashes[0].authors.sort()).toEqual(["1hook", "_dev"].sort());
	});
});
