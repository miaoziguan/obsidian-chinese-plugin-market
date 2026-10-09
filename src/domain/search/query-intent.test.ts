import { describe, expect, it } from "vitest";

import {
	negativeMatchesForCandidate,
	parseQueryIntent,
	pureNegativeCandidateIds,
	rerankSearchCandidates,
	type SearchCandidateText,
} from "@domain/search/query-intent";

describe("parseQueryIntent", () => {
	it("把自然语言否定从召回 query 中移除并记录否定词", () => {
		const intent = parseQueryIntent("图片插件，不要导出");

		expect(intent.recallQuery).toContain("图片插件");
		expect(intent.recallQuery).not.toContain("不要");
		expect(intent.recallQuery).not.toContain("导出");
		expect(intent.negativeTerms).toEqual(["导出"]);
	});

	it("支持显式 -term 和英文否定", () => {
		expect(parseQueryIntent("preview -export").negativeTerms).toEqual(["export"]);
		expect(parseQueryIntent("preview without export").negativeTerms).toEqual(["export"]);
	});

	it("英文意图触发使用词边界，避免 digital 误触发 git", () => {
		expect(parseQueryIntent("把 Markdown 知识库发布成 digital garden").activeProfiles).toEqual([]);
		expect(parseQueryIntent("sync and back up my vault with Git").activeProfiles.map((profile) => profile.key)).toContain(
			"backup-version-control",
		);
	});

	it("纯否定 query 不会把否定片段当成召回词", () => {
		const intent = parseQueryIntent("不要导出");

		expect(intent.recallQuery).toBe("");
		expect(intent.positiveTerms).toEqual([]);
		expect(intent.isPureNegative).toBe(true);
	});

	it("识别三个高价值功能意图", () => {
		const intent = parseQueryIntent("实时转换并支持即时预览、直接粘贴");

		expect(intent.activeProfiles.map((profile) => profile.key)).toEqual([
			"realtime-conversion",
			"instant-preview",
			"direct-paste",
		]);
		expect(intent.phrases).toEqual(expect.arrayContaining(["实时转换", "即时预览", "直接粘贴"]));
	});

	it("也识别常见的工作流型意图", () => {
		const intent = parseQueryIntent("离线使用、跨设备同步、批量处理、快速记录、快捷键和隐私保护");

		expect(intent.activeProfiles.map((profile) => profile.key)).toEqual([
			"offline-local",
			"cross-device-sync",
			"batch-processing",
			"quick-capture",
			"keyboard-command",
			"privacy-first",
		]);
	});

	it("覆盖社区插件目录里常见的内容、生产力和发布场景", () => {
		const intent = parseQueryIntent("任务管理、日历视图、发布到网站、文献管理、AI助手、移动端、画布、全文搜索");

		expect(intent.activeProfiles.map((profile) => profile.key)).toEqual([
			"task-project",
			"calendar-schedule",
			"publish-web",
			"research-citation",
			"ai-assistant",
			"mobile-first",
			"canvas-visual",
			"search-navigation",
		]);
	});
});

describe("rerankSearchCandidates", () => {
	const plugins: SearchCandidateText[] = [
		{ id: "generic", name: "Generic", description: "图片工具，支持导出" },
		{ id: "target", name: "Target", description: "图片实时转换，支持即时预览和直接粘贴" },
	];

	it("短语/意图命中会轻量上调并留下诊断", () => {
		const intent = parseQueryIntent("图片实时转换，不要导出");
		const result = rerankSearchCandidates({
			intent,
			ids: ["generic", "target"],
			plugins,
			fusedScores: new Map([
				["generic", 0.02],
				["target", 0.019],
			]),
			keywordScores: new Map([
				["generic", 2],
				["target", 1],
			]),
			vectorScores: null,
			titleScores: new Map(),
		});

		expect(result.ids[0]).toBe("target");
		expect(result.diagnostics.target.keywordRank).toBe(2);
		expect(result.diagnostics.target.phraseMatches).toContain("实时转换");
		expect(result.diagnostics.target.intentMatches).toContain("实时转换");
		expect(result.diagnostics.generic.negativeMatches).toContain("导出");
	});

	it("未命中召回路时用 null 表示名次，避免和第一名混淆", () => {
		const result = rerankSearchCandidates({
			intent: parseQueryIntent("preview"),
			ids: ["generic"],
			plugins,
			fusedScores: new Map([["generic", 0.01]]),
			keywordScores: new Map(),
			vectorScores: null,
			titleScores: new Map(),
		});

		expect(result.diagnostics.generic.keywordRank).toBeNull();
		expect(result.diagnostics.generic.vectorRank).toBeNull();
		expect(result.diagnostics.generic.titleRank).toBeNull();
	});

	it("只重排指定的前 N 条候选", () => {
		const ids = Array.from({ length: 301 }, (_, index) => `p${index}`);
		const plugins = ids.map((id) => ({ id, name: id, description: "" }));
		const fusedScores = new Map(ids.map((id, index) => [id, 1 / (index + 1)]));
		const result = rerankSearchCandidates({
			intent: parseQueryIntent("普通查询"),
			ids,
			plugins,
			fusedScores,
			keywordScores: new Map(),
			vectorScores: null,
			titleScores: new Map(),
			limit: 300,
		});

		expect(result.ids).toHaveLength(300);
		expect(result.diagnostics.p300).toBeUndefined();
	});

	it("纯否定候选池硬排除命中的能力", () => {
		const intent = parseQueryIntent("不要导出");
		const ids = pureNegativeCandidateIds(intent, plugins, 10);

		expect(ids).toEqual(["target"]);
	});

	it("短英文否定词使用词边界，避免 daily 被误判为 AI", () => {
		const intent = parseQueryIntent("without AI");

		expect(
			negativeMatchesForCandidate({ id: "daily", name: "Daily notes", description: "Daily journal" }, intent)
		).toEqual([]);
		expect(
			negativeMatchesForCandidate({ id: "assistant", name: "AI Assistant", description: "Chat with an AI" }, intent)
		).toContain("ai");
	});
});
