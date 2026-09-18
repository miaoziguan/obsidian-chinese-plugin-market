import { describe, it, expect } from "vitest";
import { DepGraph } from "@domain/deps/graph";
import type { DepEdge, DepStatusInput } from "@domain/deps/types";

const file = JSON.stringify({
	version: 1,
	generatedAt: "2026-09-19T00:00:00.000Z",
	edges: {
		banners: [
			{ id: "dataview", name: "Dataview", kind: "required", source: "curated", confidence: 1 },
			{ id: "templater", name: "Templater", kind: "optional", source: "readme", confidence: 0.7 },
		],
		"old-thing": [
			{
				id: "dataview",
				name: "Dataview",
				kind: "required",
				minVersion: "0.5.0",
				source: "curated",
				confidence: 1,
			},
		],
	},
});

const input = (over: Partial<DepStatusInput> = {}): DepStatusInput => ({
	installedIds: new Set(["dataview"]),
	enabledIds: new Set(["dataview"]),
	installedVersions: new Map([["dataview", "0.5.6"]]),
	knownIds: new Set(["dataview", "templater"]),
	...over,
});

describe("DepGraph.parse", () => {
	it("正常解析并构建反向索引", () => {
		const g = DepGraph.parse(file)!;
		expect(g.edgesOf("banners")).toHaveLength(2);
		const deps = g.dependentsOf("dataview").map((d) => d.id);
		expect(deps).toContain("banners");
		expect(deps).toContain("old-thing");
	});

	it("坏 JSON / schema 不匹配 / 缺字段 → 返回 null（静默降级，不影响其它功能）", () => {
		expect(DepGraph.parse("{ 坏")).toBeNull();
		expect(DepGraph.parse(JSON.stringify({ version: 2, edges: {} }))).toBeNull();
		expect(DepGraph.parse(JSON.stringify({ version: 1 }))).toBeNull();
	});

	it("丢弃形状不合法的边（缺 id / 非法 kind）", () => {
		const g = DepGraph.parse(
			JSON.stringify({
				version: 1,
				generatedAt: "",
				edges: {
					a: [
						{ id: "x", name: "X", kind: "bogus", source: "curated", confidence: 1 },
						{ name: "无 id" },
					],
				},
			}),
		)!;
		expect(g.edgesOf("a")).toHaveLength(0);
	});
});

describe("DepGraph.statusOf", () => {
	const g = DepGraph.parse(file)!;
	const edge = (over: Partial<DepEdge> = {}): DepEdge => ({
		id: "dataview",
		name: "Dataview",
		kind: "required",
		source: "curated",
		confidence: 1,
		...over,
	});

	it("未安装 → missing", () => {
		expect(g.statusOf(edge(), input({ installedIds: new Set() }))).toBe("missing");
	});
	it("已装未启用 → disabled（社区里最常见的坑）", () => {
		expect(g.statusOf(edge(), input({ enabledIds: new Set() }))).toBe("disabled");
	});
	it("已启用但版本低于 minVersion → outdated", () => {
		expect(g.statusOf(edge({ minVersion: "0.6.0" }), input())).toBe("outdated");
	});
	it("已启用且版本满足 → ok", () => {
		expect(g.statusOf(edge({ minVersion: "0.5.0" }), input())).toBe("ok");
	});
	it("目标不在官方列表 → unknown，优先于 missing（可能是直链装的）", () => {
		expect(g.statusOf(edge({ id: "beta-thing" }), input({ installedIds: new Set() }))).toBe("unknown");
	});
});

describe("DepGraph.blockingOf", () => {
	it("依赖都到位时返回空（卡片不显示徽标）", () => {
		const g = DepGraph.parse(file)!;
		expect(g.blockingOf("banners", input())).toHaveLength(0);
	});
	it("只返回 required 且未满足的项，optional 不阻塞", () => {
		const g = DepGraph.parse(file)!;
		// templater（optional）未安装也不算阻塞
		const blocking = g.blockingOf("banners", input({ enabledIds: new Set() }));
		expect(blocking).toHaveLength(1);
		expect(blocking[0].dep.id).toBe("dataview");
		expect(blocking[0].status).toBe("disabled");
	});
});

describe("DepGraph.merge（运行时按需兜底）", () => {
	it("运行时记录覆盖基线，且不影响其它插件", () => {
		const g = DepGraph.parse(file)!;
		g.merge("banners", [{ id: "dataview", name: "Dataview", kind: "optional", source: "readme", confidence: 0.7 }]);
		expect(g.edgesOf("banners")).toHaveLength(1);
		expect(g.blockingOf("banners", input({ installedIds: new Set() }))).toHaveLength(0); // 降级成 optional 后不再阻塞
		expect(g.edgesOf("old-thing")).toHaveLength(1); // 基线其它条目不受影响
	});
});
