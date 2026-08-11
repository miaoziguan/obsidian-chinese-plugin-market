import { describe, it, expect } from "vitest";
import { snapshotInstalled } from "@ui/view/view-data";

/**
 * 回归测试：snapshotInstalled 必须把已装插件的 id / 版本 / 启用态写回 ctx。
 *
 * 根因（2.19.3 修复前）：ViewContext 的 installedIds / enabledIds / installedVersions
 * 仅有 getter 无 setter，严格模式下对访问器整体赋值（ctx.installedIds = next）
 * 会抛 TypeError 被外层 try/catch 吞掉，导致安装维度永远为空（所有卡片显示未安装、
 * "仅已安装"筛选恒空、可更新检测因 installedVersions 空而直接 return）。
 *
 * 此处直接复用真实 snapshotInstalled，构造带 setter 的最小 ctx 验证写入成功。
 */
describe("snapshotInstalled 写回已装状态", () => {
	it("把 manifests 的 id / version / enabledPlugins 正确快照到 ctx", () => {
		const app: any = {
			plugins: {
				manifests: {
					dataview: { version: "0.5.64" },
					tasks: { version: "7.8.0" },
					"not-enabled": { version: "1.0.0" },
				},
				enabledPlugins: new Set(["dataview", "tasks"]),
			},
		};

		// 模拟修复后的 ViewContext：installedIds/enabledIds/installedVersions 均带 setter
		const view = {
			installedIds: new Set<string>(),
			enabledIds: new Set<string>(),
			installedVersions: new Map<string, string>(),
		};
		const ctx: any = {
			app,
			installFilter: "all",
			filterCache: { reset() {} },
			get installedIds() {
				return view.installedIds;
			},
			set installedIds(v: Set<string>) {
				view.installedIds = v;
			},
			get enabledIds() {
				return view.enabledIds;
			},
			set enabledIds(v: Set<string>) {
				view.enabledIds = v;
			},
			get installedVersions() {
				return view.installedVersions;
			},
			set installedVersions(v: Map<string, string>) {
				view.installedVersions = v;
			},
		};

		snapshotInstalled(ctx);

		// 已装 id 集合
		expect(view.installedIds.has("dataview")).toBe(true);
		expect(view.installedIds.has("tasks")).toBe(true);
		expect(view.installedIds.has("not-enabled")).toBe(true);
		expect(view.installedIds.size).toBe(3);

		// 已装版本号
		expect(view.installedVersions.get("dataview")).toBe("0.5.64");
		expect(view.installedVersions.get("tasks")).toBe("7.8.0");

		// 启用态
		expect(view.enabledIds.has("dataview")).toBe(true);
		expect(view.enabledIds.has("tasks")).toBe(true);
		expect(view.enabledIds.has("not-enabled")).toBe(false);
	});

	it("manifests 为空时不抛错且保持空集合", () => {
		const app: any = { plugins: { manifests: {}, enabledPlugins: new Set() } };
		const view = {
			installedIds: new Set<string>(),
			enabledIds: new Set<string>(),
			installedVersions: new Map<string, string>(),
		};
		const ctx: any = {
			app,
			installFilter: "all",
			filterCache: { reset() {} },
			get installedIds() {
				return view.installedIds;
			},
			set installedIds(v: Set<string>) {
				view.installedIds = v;
			},
			get enabledIds() {
				return view.enabledIds;
			},
			set enabledIds(v: Set<string>) {
				view.enabledIds = v;
			},
			get installedVersions() {
				return view.installedVersions;
			},
			set installedVersions(v: Map<string, string>) {
				view.installedVersions = v;
			},
		};

		expect(() => snapshotInstalled(ctx)).not.toThrow();
		expect(view.installedIds.size).toBe(0);
		expect(view.enabledIds.size).toBe(0);
	});
});
