import { describe, it, expect } from "vitest";
import { detectDeps } from "@domain/deps/detect";
import { DROP_BELOW, REQUIRED_MIN } from "@domain/deps/rules";

const dict = [
	{ id: "dataview", name: "Dataview", aliases: ["DataviewJS"] },
	{ id: "templater-obsidian", name: "Templater", aliases: [] },
];

describe("detectDeps", () => {
	it("README 强措辞 → required 0.7", () => {
		const out = detectDeps({ selfId: "x", readme: "This plugin requires Dataview.", dict });
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			id: "dataview",
			kind: "required",
			source: "readme",
			confidence: 0.7,
		});
	});

	it("README 弱措辞 → optional 0.35（不阻塞安装）", () => {
		const out = detectDeps({ selfId: "x", readme: "Works with Templater!", dict });
		expect(out[0]).toMatchObject({ id: "templater-obsidian", kind: "optional", confidence: 0.35 });
	});

	it("manifest 声明优先（0.9）并覆盖 README 的弱命中", () => {
		const out = detectDeps({
			selfId: "x",
			manifestDeps: { dataview: ">=0.5.0" },
			readme: "Works with Dataview",
			dict,
		});
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			source: "manifest",
			confidence: 0.9,
			kind: "required",
			minVersion: "0.5.0",
		});
	});

	it("manifest 声明支持数组写法并归一化版本号", () => {
		const out = detectDeps({ selfId: "x", manifestDeps: ["dataview"], dict });
		expect(out[0]).toMatchObject({ id: "dataview", source: "manifest", confidence: 0.9 });
	});

	it("main.js 调用特征 0.85", () => {
		const out = detectDeps({
			selfId: "x",
			mainJs: "const dv = app.plugins.plugins['dataview'];",
			dict,
		});
		expect(out[0]).toMatchObject({ id: "dataview", source: "mainjs", confidence: 0.85 });
	});

	it("自依赖与未知目标被丢弃", () => {
		expect(detectDeps({ selfId: "dataview", readme: "requires Dataview", dict })).toHaveLength(0);
		expect(detectDeps({ selfId: "x", readme: "requires SomeUnknownThing", dict })).toHaveLength(0);
	});

	it("别名命中（DataviewJS → dataview）", () => {
		const out = detectDeps({ selfId: "x", readme: "Needs DataviewJS to render.", dict });
		expect(out[0].id).toBe("dataview");
	});

	it("低于阈值的证据不会进入结果（误报比漏报贵）", () => {
		// 无任何措辞命中 → 空
		expect(detectDeps({ selfId: "x", readme: "A nice plugin.", dict })).toHaveLength(0);
		// 弱措辞虽保留为 optional，但 kind 绝不会是 required
		for (const e of detectDeps({ selfId: "x", readme: "compatible with Dataview", dict })) {
			expect(e.kind).toBe("optional");
			expect(e.confidence).toBeGreaterThanOrEqual(DROP_BELOW);
			expect(e.confidence).toBeLessThan(REQUIRED_MIN);
		}
	});
});
