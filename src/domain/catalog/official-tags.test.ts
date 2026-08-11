import { describe, it, expect } from "vitest";
import { formatOfficialTag, OFFICIAL_TAG_ZH } from "./official-tags";

describe("formatOfficialTag（官方 tag 中英对照渲染）", () => {
	it("中文自造 tag 原样返回", () => {
		expect(formatOfficialTag("表格")).toBe("表格");
		expect(formatOfficialTag("任务与项目管理")).toBe("任务与项目管理");
	});

	it("英文官方 tag 命中映射 → 返回「中文(英文)」", () => {
		expect(formatOfficialTag("calendar")).toBe("日历(calendar)");
		expect(formatOfficialTag("kanban")).toBe("看板(kanban)");
		// 大小写不敏感
		expect(formatOfficialTag("Calendar")).toBe("日历(Calendar)");
	});

	it("英文官方 tag 未命中映射 → 返回原英文词", () => {
		expect(formatOfficialTag("visual-enhancement")).toBe("visual-enhancement");
		expect(formatOfficialTag("favicon")).toBe("favicon");
	});

	it("中英文同形（如 ai/api）不加括号，原样返回", () => {
		// OFFICIAL_TAG_ZH 中 ai→AI、api→API 等同形，不应显示「AI(ai)」
		if (OFFICIAL_TAG_ZH["ai"]) expect(formatOfficialTag("ai")).toBe("ai");
		if (OFFICIAL_TAG_ZH["api"]) expect(formatOfficialTag("api")).toBe("api");
	});

	it("空串安全", () => {
		expect(formatOfficialTag("")).toBe("");
	});
});
