import { describe, it, expect } from "vitest";
import {
	mergeInstallDiff,
	estimateInstallTimes,
	emptyInstallHistory,
	type InstallRecord,
} from "@domain/journal/install-history";

const NOW = 1_700_000_000_000;
const base = (): Record<string, InstallRecord> => ({});
const rec = (over: Partial<InstallRecord> = {}): InstallRecord => ({
	name: "A",
	firstInstalled: 1,
	lastInstalled: 1,
	uninstalled: null,
	installCount: 1,
	currentlyInstalled: true,
	currentlyEnabled: true,
	...over,
});

describe("安装历史 diff 合并", () => {
	it("空历史 + 空 diff 返回空", () => {
		expect(mergeInstallDiff(base(), {
			added: new Set(), removed: new Set(),
			installedIds: new Set(), enabledIds: new Set(),
			nameOf: () => "A", now: NOW,
		})).toEqual({});
		expect(emptyInstallHistory()).toEqual({ version: 1, entries: {} });
	});

	it("首次安装写入 firstInstalled 与计数", () => {
		const out = mergeInstallDiff(base(), {
			added: new Set(["a"]), removed: new Set(),
			installedIds: new Set(["a"]), enabledIds: new Set(["a"]),
			nameOf: () => "A", now: NOW,
		});
		expect(out.a).toMatchObject({
			name: "A",
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
		cur.a = rec({ firstInstalled: 1, lastInstalled: 1 });
		const out = mergeInstallDiff(cur, {
			added: new Set(), removed: new Set(["a"]),
			installedIds: new Set(), enabledIds: new Set(),
			nameOf: () => "A", now: NOW,
		});
		expect(out.a.uninstalled).toBe(NOW);
		expect(out.a.currentlyInstalled).toBe(false);
		expect(out.a.currentlyEnabled).toBe(false);
		expect(out.a.firstInstalled).toBe(1);
	});

	it("重装递增 installCount 并清空 uninstalled，且保留首次名与首次时间", () => {
		const cur = base();
		cur.a = rec({ name: "原名", firstInstalled: 1, uninstalled: 100, currentlyInstalled: false, currentlyEnabled: false });
		const out = mergeInstallDiff(cur, {
			added: new Set(["a"]), removed: new Set(),
			installedIds: new Set(["a"]), enabledIds: new Set(),
			nameOf: () => "新名", now: NOW,
		});
		expect(out.a.installCount).toBe(2);
		expect(out.a.uninstalled).toBeNull();
		expect(out.a.lastInstalled).toBe(NOW);
		expect(out.a.firstInstalled).toBe(1);
		expect(out.a.name).toBe("原名"); // 重装不覆盖首次记录的名字
	});

	it("未变化的插件仅同步启用态，不动安装历史", () => {
		const cur = base();
		cur.a = rec({ currentlyEnabled: false });
		const out = mergeInstallDiff(cur, {
			added: new Set(), removed: new Set(),
			installedIds: new Set(["a"]), enabledIds: new Set(["a"]),
			nameOf: () => "A", now: NOW,
		});
		expect(out.a.currentlyEnabled).toBe(true);
		expect(out.a.installCount).toBe(1); // 启用不算重装
		expect(out.a.lastInstalled).toBe(1);
	});

	it("跨会话卸载：当前快照已无该 id 时补写 uninstalled（不留矛盾记录）", () => {
		const cur = base();
		cur.a = rec({ currentlyInstalled: true, uninstalled: null });
		const out = mergeInstallDiff(cur, {
			added: new Set(), removed: new Set(),
			installedIds: new Set(), // 已不在安装列表（Obsidian 关闭期间被删）
			enabledIds: new Set(),
			nameOf: () => "A", now: NOW,
		});
		expect(out.a.currentlyInstalled).toBe(false);
		expect(out.a.uninstalled).toBe(NOW); // 关键：不留 null
		expect(out.a.firstInstalled).toBe(1);
	});

	it("removed 里含历史中不存在的 id 时跳过，不凭空建记录", () => {
		const out = mergeInstallDiff(base(), {
			added: new Set(), removed: new Set(["ghost"]),
			installedIds: new Set(), enabledIds: new Set(),
			nameOf: () => "G", now: NOW,
		});
		expect(out.ghost).toBeUndefined();
	});

	it("不修改入参，且返回新对象", () => {
		const cur = base();
		cur.a = rec();
		const snapshot = { ...cur.a };
		const out = mergeInstallDiff(cur, {
			added: new Set(), removed: new Set(["a"]),
			installedIds: new Set(), enabledIds: new Set(),
			nameOf: () => "A", now: NOW,
		});
		expect(cur.a).toEqual(snapshot);
		expect(out).not.toBe(cur);
		expect(Object.keys(out)).toEqual(Object.keys(cur));
	});
});

/**
 * 回填场景：本台账开始记录之前就已装上的插件（尤其是直链安装、或装了本插件之前就存在的），
 * 只能从文件系统时间推断安装时间，必须打 estimated 标记，不能被当成精确时间展示。
 */
describe("安装时间估算与回填标记", () => {
	it("时间戳来源可用时：首装取目录 ctime、最近安装取两者较晚者", () => {
		expect(estimateInstallTimes(1000, 2000, NOW)).toEqual({
			firstInstalled: 1000,
			lastInstalled: 2000,
		});
		// manifest 比目录还早（异常数据）时，最近安装不会早于首装
		expect(estimateInstallTimes(2000, 1000, NOW)).toEqual({
			firstInstalled: 2000,
			lastInstalled: 2000,
		});
	});

	it("只有一侧可用时退化使用；都不可用返回空对象", () => {
		expect(estimateInstallTimes(undefined, 2000, NOW)).toEqual({
			firstInstalled: 2000,
			lastInstalled: 2000,
		});
		expect(estimateInstallTimes(1000, undefined, NOW)).toEqual({
			firstInstalled: 1000,
			lastInstalled: 1000,
		});
		expect(estimateInstallTimes(0, undefined, NOW)).toEqual({});
		expect(estimateInstallTimes(Number.NaN, undefined, NOW)).toEqual({});
		// 未来时间视为脏数据（时钟偏差容忍 60s）
		expect(estimateInstallTimes(NOW + 600_000, undefined, NOW)).toEqual({});
		expect(estimateInstallTimes(NOW + 1000, undefined, NOW)).toEqual({
			firstInstalled: NOW + 1000,
			lastInstalled: NOW + 1000,
		});
	});

	it("带 stamps 的新增记录打上 estimated 并采用推断时间", () => {
		const out = mergeInstallDiff(base(), {
			added: new Set(["a"]), removed: new Set(),
			installedIds: new Set(["a"]), enabledIds: new Set(["a"]),
			nameOf: () => "A", now: NOW,
			stamps: { a: { firstInstalled: 111, lastInstalled: 222 } },
		});
		expect(out.a.estimated).toBe(true);
		expect(out.a.firstInstalled).toBe(111);
		expect(out.a.lastInstalled).toBe(222);
	});

	it("stamps 里给了空对象 = 推断不出来：仍标估算，时间退化为 now", () => {
		const out = mergeInstallDiff(base(), {
			added: new Set(["a"]), removed: new Set(),
			installedIds: new Set(["a"]), enabledIds: new Set(),
			nameOf: () => "A", now: NOW,
			stamps: { a: {} },
		});
		expect(out.a.estimated).toBe(true);
		expect(out.a.firstInstalled).toBe(NOW);
		expect(out.a.lastInstalled).toBe(NOW);
	});

	it("未提供 stamps = 真实安装事件：不标估算，且保留更早的首装时间", () => {
		const out = mergeInstallDiff(base(), {
			added: new Set(["a"]), removed: new Set(),
			installedIds: new Set(["a"]), enabledIds: new Set(),
			nameOf: () => "A", now: NOW,
		});
		expect(out.a.estimated).toBeUndefined();

		// 估算记录被真实安装事件覆盖后，标记应被清除
		const cur = base();
		cur.a = rec({ estimated: true, firstInstalled: 111, lastInstalled: 111 });
		const again = mergeInstallDiff(cur, {
			added: new Set(["a"]), removed: new Set(),
			installedIds: new Set(["a"]), enabledIds: new Set(),
			nameOf: () => "A", now: NOW,
		});
		expect(again.a.estimated).toBeUndefined();
		expect(again.a.firstInstalled).toBe(111); // 首装时间不被推后
		expect(again.a.lastInstalled).toBe(NOW);
		expect(again.a.installCount).toBe(2);
	});
});
