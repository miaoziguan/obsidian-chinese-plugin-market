import { describe, it, expect } from "vitest";
import { computeSimilar } from "./similar";
import { PluginTagService, type PluginTag } from "../plugin-tags";

describe("computeSimilar", () => {
	const all = [
		{ id: "a", name: "Kanban", description: "markdown kanban board" },
		{ id: "b", name: "Todoist Sync", description: "sync with todoist" },
		{ id: "c", name: "Task Board", description: "visual kanban task management" },
		{ id: "d", name: "Theme Switcher", description: "switch themes quickly" },
		{ id: "e", name: "Calendar", description: "daily calendar view" },
		{ id: "f", name: "Day Planner", description: "plan and track daily tasks in kanban style" },
	];

	const tags: Record<string, PluginTag> = {
		a: { category: "任务与项目", tags: ["看板", "任务"] },
		b: { category: "同步与备份", tags: ["同步", "TODO"] },
		c: { category: "任务与项目", tags: ["看板", "任务管理"] },
		d: { category: "外观与主题", tags: ["主题"] },
		e: { category: "日历与提醒", tags: ["日历"] },
		f: { category: "任务与项目", tags: ["任务", "看板", "规划"] },
	};

	const ts = new PluginTagService();
	ts.load(tags);

	const translated: Record<string, string> = {
		a: "看板",
		c: "任务板",
		f: "日程规划",
	};

	it("同分类 + 标签命中排在前面", () => {
		const sim = computeSimilar("a", all[0].description, all, ts, translated, 5);
		// a 是 Kanban，同分类+看板标签：c (描述重叠少) 和 f (描述重叠多+多一个共享标签"任务")
		expect(sim.length).toBeGreaterThanOrEqual(1);
		// f 得分 = 4(分类) + 2(看板标签) + 2(任务标签) + Jaccard*2(kanban desc) ≈ 8.25
		// c 得分 = 4(分类) + 2(看板标签) + Jaccard*2(kanban desc) ≈ 6.33
		// f > c：f 多一个"任务"标签，描述重叠更低但标签信号更强，排名仍第一
		expect(sim[0].id).toBe("f");
	});

	it("排除源插件自身", () => {
		const sim = computeSimilar("a", all[0].description, all, ts, translated, 5);
		expect(sim.map((s) => s.id)).not.toContain("a");
	});

	it("无分类/标签交集时按描述得分推荐", () => {
		// d (Theme Switcher) 的标签与其它插件无交集，但描述中"quickly"等词可能
		// 与 f 的 "plan" 等在多插件场景中产生微弱得分。
		// 一个更干净的验证：构建两个只有各自的插件
		const plugins = [
			{ id: "x", name: "X", description: "abc xyz" },
			{ id: "y", name: "Y", description: "abc lmn" },
			{ id: "z", name: "Z", description: "def ghi" },
		];
		const tagsXy: Record<string, PluginTag> = {};
		const ts2 = new PluginTagService();
		ts2.load(tagsXy);
		const sim = computeSimilar("x", plugins[0].description, plugins, ts2, {}, 5);
		expect(sim.length).toBeGreaterThanOrEqual(1);
		expect(sim[0].id).toBe("y"); // 共享 "abc" 得分
	});

	it("topN 截断生效", () => {
		// 构造 8 个同类插件使结果数 > topN
		const many = Array.from({ length: 8 }, (_, i) => ({
			id: String(i),
			name: `P${i}`,
			description: "kanban task management",
		}));
		const tagsAll: Record<string, PluginTag> = {};
		const tsMany = new PluginTagService();
		tsMany.load(tagsAll);
		const sim = computeSimilar("0", many[0].description, many, tsMany, {}, 3);
		expect(sim.length).toBeLessThanOrEqual(3);
	});

	it("reason 包含分类与标签信息", () => {
		const sim = computeSimilar("a", all[0].description, all, ts, translated, 5);
		for (const s of sim) {
			expect(typeof s.reason).toBe("string");
			expect(s.reason.length).toBeGreaterThan(0);
		}
	});

	it("translatedName 优先使用翻译结果", () => {
		const sim = computeSimilar("a", all[0].description, all, ts, translated, 5);
		const c = sim.find((s) => s.id === "c");
		expect(c?.translatedName).toBe("任务板");
	});

	it("无翻译结果时 fallback 到原名", () => {
		// c 在 similar 结果中但 translated 为空，应 fallback 到 c.name
		const sim = computeSimilar("a", all[0].description, all, ts, {}, 5);
		const c = sim.find((s) => s.id === "c");
		expect(c?.translatedName).toBe("Task Board");
	});

	it("无翻译结果时 fallback 到原名", () => {
		// c 在 similar 结果中但没有 translatedNames，应 fallback 到 c.name
		const sim = computeSimilar("a", all[0].description, all, ts, {}, 5);
		const c = sim.find((s) => s.id === "c");
		expect(c?.translatedName).toBe("Task Board"); // c.name 原名
	});

	it("标签重叠多者得分更高", () => {
		const sim = computeSimilar("a", all[0].description, all, ts, translated, 5);
		// f (3 共享标签 + kanban desc overlap) > c (1 共享标签 + kanban desc overlap)
		expect(sim[0].id).toBe("f");
		expect(sim.some((s) => s.id === "c")).toBe(true);
	});

	it("空插件列表不崩溃", () => {
		const sim = computeSimilar("a", all[0].description, [], ts, translated, 5);
		expect(sim).toEqual([]);
	});

	it("候选描述重复词不放大 Jaccard（回归 M5：描述分上界 2）", () => {
		// 无标签场景：得分只来自描述重叠 = jaccard * 2 ≤ 2。
		// 修复前交集含重复计数：候选重复 "kanban" 4 次 → jaccard = 4/2 = 2 → 得分 4。
		const plugins = [
			{ id: "s", name: "S", description: "kanban board" },
			{ id: "r", name: "R", description: "kanban kanban kanban kanban" },
		];
		const emptyTs = new PluginTagService();
		emptyTs.load({});
		const sim = computeSimilar("s", plugins[0].description, plugins, emptyTs, {}, 5);
		expect(sim.length).toBe(1);
		expect(sim[0].id).toBe("r");
		expect(sim[0].score).toBeLessThanOrEqual(2);
		// distinct 口径：交集 {kanban}=1，并集 {kanban,board}=2 → jaccard 0.5 → 得分 1
		expect(sim[0].score).toBeCloseTo(1, 5);
	});

	it("无分类标签数据的插件仍可用描述做相似", () => {
		const tags2: Record<string, PluginTag> = {
			a: { category: "笔记", tags: ["写作"] },
			g: { category: "笔记", tags: ["写作", "编辑器"] },
		};
		const ts2 = new PluginTagService();
		ts2.load(tags2);
		const all2 = [
			{ id: "a", name: "Notepad", description: "simple markdown notepad for quick notes" },
			{ id: "g", name: "Super Notepad", description: "advanced markdown notepad with rich editing features" },
		];
		const sim = computeSimilar("a", all2[0].description, all2, ts2, {}, 5);
		expect(sim[0].id).toBe("g");
		expect(sim[0].reason).toContain("笔记");
	});
});
