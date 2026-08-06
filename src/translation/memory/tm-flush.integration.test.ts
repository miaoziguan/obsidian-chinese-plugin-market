import { describe, it, expect, vi } from "vitest";

// 在真实 obsidian 基础上补全 TFile/TFolder（vitest 环境下 real obsidian 的 TFolder/TFile 未定义，
// 导致 scanVaultTM 内 instanceof 失败）。其余（Plugin/PluginSettingTab/normalizePath）保持真实实现。
vi.mock("obsidian", async (importOriginal) => {
	const real: any = await importOriginal();
	class TFile {
		path: string;
		constructor(path: string) { this.path = path; }
	}
	class TFolder {
		path: string;
		children: any[] = [];
		constructor(path: string) { this.path = path; }
	}
	return { ...real, TFile, TFolder };
});

// 最小内存 vault 模拟，验证 TM 笔记落盘链路
class FakeTFile {
	constructor(public path: string, public content: string) {}
}
class FakeTFolder {
	children: Array<FakeTFile | FakeTFolder> = [];
	constructor(public path: string) {}
}
class FakeVault {
	files = new Map<string, FakeTFile>();
	folders = new Map<string, FakeTFolder>();

	adapter = {
		exists: async (p: string) => this.files.has(p),
		read: async (p: string) => {
			const f = this.files.get(p);
			if (!f) throw new Error("not found: " + p);
			return f.content;
		},
		write: async (p: string, content: string) => {
			if (this.files.has(p)) {
				this.files.get(p)!.content = content;
			} else {
				this.files.set(p, new FakeTFile(p, content));
			}
		},
		remove: async (p: string) => {
			this.files.delete(p);
		},
	};

	getAbstractFileByPath(p: string): FakeTFile | FakeTFolder | null {
		p = p.replace(/\/$/, "");
		if (this.files.has(p)) return this.files.get(p)!;
		if (this.folders.has(p)) return this.folders.get(p)!;
		return null;
	}
	async createFolder(p: string) {
		p = p.replace(/\/$/, "");
		if (!this.folders.has(p)) this.folders.set(p, new FakeTFolder(p));
	}
	async create(p: string, content: string) {
		this.files.set(p, new FakeTFile(p, content));
		const folder = p.split("/").slice(0, -1).join("/");
		const f = this.folders.get(folder);
		if (f) f.children.push(this.files.get(p)!);
	}
	async modify(file: FakeTFile, content: string) {
		file.content = content;
	}
	async delete(file: FakeTFile) {
		this.files.delete(file.path);
	}
	async cachedRead(file: FakeTFile) {
		return file.content;
	}
	getMarkdownFiles(): FakeTFile[] {
		return [...this.files.values()].filter((f) => f.path.endsWith(".md"));
	}
}

import { writeTMNote, parseTMNote, TM_FOLDER } from "@translation/memory/translation-memory";
import { Translator } from "@domain/catalog/translator";
import ChinesePluginMarketPlugin from "@app/plugin";

describe("TM 笔记落盘（集成）", () => {
	it("已采纳条目（直接落库）标记脏，flushTMVault 写出笔记，且可被 scanVaultTM 回灌", async () => {
		const vault = new FakeVault() as any;
		const app = { vault } as any;
		const t = new Translator();
		// 直接落库为 approved（无审核队列）
		t.tmApproved["git"] = {
			id: "git",
			name: "Git 同步",
			description: "用 Git 同步你的笔记",
			source: "ai",
			status: "approved",
			confidence: 0.8,
			created: Date.now(),
			promoted: Date.now(),
		};
		t.markTMDirty("git");
		expect(t.peekTMDirty()).toContain("git");

		// 复刻 flushTMVault：写入脏标记对应的 tmApproved 条目
		for (const id of t.peekTMDirty()) {
			const e = t.tmApproved[id];
			await writeTMNote(app, e!);
			t.clearTMDirty(id);
		}

		const expectedPath = `${TM_FOLDER}/git.md`;
		expect(vault.files.has(expectedPath)).toBe(true);
		const note = parseTMNote(vault.files.get(expectedPath)!.content);
		expect(note?.status).toBe("approved");
		expect(note?.source).toBe("ai");
	});

	it("scanVaultTM 能从 vault 笔记重建 tmApproved 索引（重启后不丢）", async () => {
		const { TFolder, TFile } = await import("obsidian");
		const vault = new FakeVault() as any;
		const folder = new (TFolder as any)(TM_FOLDER);
		vault.folders.set(TM_FOLDER, folder);
		// 预置一个已采纳笔记
		const note = `---\nid: "calendar"\nname: "日历"\ndescription: "追踪每日笔记"\nsource: human\nstatus: approved\nconfidence: 1\n---\n\n# 日历\n\n追踪每日笔记`;
		const f = new (TFile as any)(`${TM_FOLDER}/calendar.md`);
		(f as any).path = `${TM_FOLDER}/calendar.md`;
		(f as any).content = note;
		vault.files.set(`${TM_FOLDER}/calendar.md`, f);
		folder.children.push(f);

		const app = {
			vault,
			metadataCache: { getFileCache: () => null, resolved: true },
		} as any;
		const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
		Object.assign(plugin, {
			manifest: { id: "test-plugin" },
			app,
			translator: new Translator(),
			_data: {} as Record<string, unknown>,
			loadData: vi.fn(async () => ({})),
		});
		// 绕过 waitMetadataResolved 的 2000ms 等待
		(plugin as any).waitMetadataResolved = async () => {};

		await (plugin as any).scanVaultTM();
		expect(plugin.translator.isTMApproved("calendar")).toBe(true);
		expect(plugin.translator.tmApproved["calendar"].name).toBe("日历");
	});
});

