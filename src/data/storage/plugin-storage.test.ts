import { describe, it, expect } from "vitest";
import { PluginStorage } from "@data/storage/plugin-storage";
import { MemoryStoragePort } from "@data/storage/storage-port";
import { emptyInstallHistory, type InstallRecord } from "@domain/journal/install-history";

const mkRec = (over: Partial<InstallRecord> = {}): InstallRecord => ({
	name: "A",
	firstInstalled: 1,
	lastInstalled: 1,
	uninstalled: null,
	installCount: 1,
	currentlyInstalled: true,
	currentlyEnabled: true,
	...over,
});

describe("PluginStorage 安装历史索引", () => {
	it("保存后读取得到相同 entries（往返一致）", async () => {
		const s = new PluginStorage(new MemoryStoragePort(), "test-plugin");
		const file = { version: 1 as const, entries: { a: mkRec() } };
		await s.saveInstallHistory(file);
		const back = await s.loadInstallHistory();
		expect(back.entries.a).toEqual(mkRec());
	});

	it("缺失时返回空索引（不抛错，不阻断首屏）", async () => {
		const s = new PluginStorage(new MemoryStoragePort(), "test-plugin");
		expect(await s.loadInstallHistory()).toEqual(emptyInstallHistory());
	});

	it("损坏 json 返回空索引（容错，单条坏文件不影响启动）", async () => {
		const mem = new MemoryStoragePort();
		const s = new PluginStorage(mem, "test-plugin");
		await mem.write(".obsidian/plugins/test-plugin/install-history.json", "{坏");
		expect(await s.loadInstallHistory()).toEqual(emptyInstallHistory());
	});
});
