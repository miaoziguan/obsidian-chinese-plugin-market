import { describe, it, expect } from "vitest";
import { mergeInstallDiff, type InstallRecord } from "@domain/journal/install-history";

const NOW = 1_700_000_000_000;
const base = (): Record<string, InstallRecord> => ({});

describe("安装历史 diff 合并", () => {
	it("首次安装写入 firstInstalled 与计数", () => {
		const out = mergeInstallDiff(base(), {
			added: new Set(["a"]),
			removed: new Set(),
			installedIds: new Set(["a"]),
			enabledIds: new Set(["a"]),
			nameOf: () => "A",
			now: NOW,
		});
		expect(out.a).toMatchObject({
			firstInstalled: NOW,
			lastInstalled: NOW,
			installCount: 1,
			currentlyInstalled: true,
			currentlyEnabled: true,
		});
		expect(out.a.uninstalled).toBeNull();
	});

	it("卸载写入 uninstalled，且保留首次安装历史", () => {
		const cur = base();
		cur.a = {
			name: "A",
			firstInstalled: 1,
			lastInstalled: 1,
			uninstalled: null,
			installCount: 1,
			currentlyInstalled: true,
			currentlyEnabled: true,
		};
		const out = mergeInstallDiff(cur, {
			added: new Set(),
			removed: new Set(["a"]),
			installedIds: new Set(),
			enabledIds: new Set(),
			nameOf: () => "A",
			now: NOW,
		});
		expect(out.a.uninstalled).toBe(NOW);
		expect(out.a.currentlyInstalled).toBe(false);
		expect(out.a.currentlyEnabled).toBe(false);
		expect(out.a.firstInstalled).toBe(1);
	});

	it("重装递增 installCount 并清空 uninstalled", () => {
		const cur = base();
		cur.a = {
			name: "A",
			firstInstalled: 1,
			lastInstalled: 1,
			uninstalled: 100,
			installCount: 1,
			currentlyInstalled: false,
			currentlyEnabled: false,
		};
		const out = mergeInstallDiff(cur, {
			added: new Set(["a"]),
			removed: new Set(),
			installedIds: new Set(["a"]),
			enabledIds: new Set(),
			nameOf: () => "A",
			now: NOW,
		});
		expect(out.a.installCount).toBe(2);
		expect(out.a.uninstalled).toBeNull();
		expect(out.a.lastInstalled).toBe(NOW);
		expect(out.a.firstInstalled).toBe(1);
	});

	it("未变化的插件仅同步启用态，不动安装历史", () => {
		const cur = base();
		cur.a = {
			name: "A",
			firstInstalled: 1,
			lastInstalled: 1,
			uninstalled: null,
			installCount: 1,
			currentlyInstalled: true,
			currentlyEnabled: false,
		};
		const out = mergeInstallDiff(cur, {
			added: new Set(),
			removed: new Set(),
			installedIds: new Set(["a"]),
			enabledIds: new Set(["a"]), // 刚被启用
			nameOf: () => "A",
			now: NOW,
		});
		expect(out.a.currentlyEnabled).toBe(true);
		expect(out.a.installCount).toBe(1); // 启用不算重装
		expect(out.a.lastInstalled).toBe(1);
	});

	it("不修改入参", () => {
		const cur = base();
		cur.a = {
			name: "A",
			firstInstalled: 1,
			lastInstalled: 1,
			uninstalled: null,
			installCount: 1,
			currentlyInstalled: true,
			currentlyEnabled: true,
		};
		const snapshot = { ...cur.a };
		mergeInstallDiff(cur, {
			added: new Set(),
			removed: new Set(["a"]),
			installedIds: new Set(),
			enabledIds: new Set(),
			nameOf: () => "A",
			now: NOW,
		});
		expect(cur.a).toEqual(snapshot);
	});
});
