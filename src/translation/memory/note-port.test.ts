import { describe, it, expect, vi } from "vitest";

import { MemoryNoteStorage, type NoteStoragePort } from "@translation/memory/note-port";
import {
	writeTMNote,
	removeTMNote,
	parseTMNote,
	tmNotePath,
	normalizeTMPath,
	TM_FOLDER,
	type TMEntry,
} from "@translation/memory/translation-memory";

/**
 * 平台解耦验收：translation-memory 不再依赖 Obsidian 的 Vault/TFile/normalizePath，
 * 用 mock NoteStoragePort 即可覆盖建目录 / 写 / 覆写 / 删 全链路。
 */
function entry(over: Partial<TMEntry> = {}): TMEntry {
	return {
		id: "git",
		name: "Git 同步",
		description: "用 Git 同步你的笔记",
		source: "ai",
		status: "approved",
		confidence: 0.8,
		created: 1700000000000,
		...over,
	};
}

describe("translation-memory · NoteStoragePort 端口注入", () => {
	it("首次写入会先建 TM 文件夹，再落单条笔记", async () => {
		const notes = new MemoryNoteStorage();
		const spy = vi.spyOn(notes, "createFolder");
		await writeTMNote(notes, entry());

		expect(spy).toHaveBeenCalledWith(TM_FOLDER);
		const content = notes.notes.get(`${TM_FOLDER}/git.md`);
		expect(content).toBeDefined();
		expect(parseTMNote(content!)?.name).toBe("Git 同步");
	});

	it("文件夹已存在时不重复创建（避免并发竞态噪声）", async () => {
		const notes = new MemoryNoteStorage();
		await notes.createFolder(TM_FOLDER);
		const spy = vi.spyOn(notes, "createFolder");
		await writeTMNote(notes, entry());
		expect(spy).not.toHaveBeenCalled();
	});

	it("createFolder 抛错被吞掉，不阻断写入（并发已存在容错）", async () => {
		const notes: NoteStoragePort = {
			normalizePath: (p) => p,
			exists: () => false,
			createFolder: () => Promise.reject(new Error("already exists")),
			writeNote: vi.fn(() => Promise.resolve()),
			deleteNote: () => Promise.resolve(),
		};
		await expect(writeTMNote(notes, entry())).resolves.toBeUndefined();
		expect(notes.writeNote).toHaveBeenCalledOnce();
	});

	it("同 id 二次写入为覆写而非新增", async () => {
		const notes = new MemoryNoteStorage();
		await writeTMNote(notes, entry());
		await writeTMNote(notes, entry({ name: "Git 版本控制" }));
		expect(notes.notes.size).toBe(1);
		expect(parseTMNote(notes.notes.get(`${TM_FOLDER}/git.md`)!)?.name).toBe("Git 版本控制");
	});

	it("removeTMNote 走端口删除；不存在时静默", async () => {
		const notes = new MemoryNoteStorage();
		await writeTMNote(notes, entry());
		await removeTMNote(notes, "git");
		expect(notes.notes.has(`${TM_FOLDER}/git.md`)).toBe(false);
		await expect(removeTMNote(notes, "not-exist")).resolves.toBeUndefined();
	});

	it("含非法字符的插件 id 被转义为安全文件名", () => {
		expect(tmNotePath("a/b:c#d")).toBe(`${TM_FOLDER}/a_b_c_d.md`);
	});

	it("normalizeTMPath 对齐 Obsidian 语义：反斜杠/重复斜杠/首尾斜杠归一", () => {
		expect(normalizeTMPath("a\\b//c/")).toBe("a/b/c");
		expect(normalizeTMPath("/x/y")).toBe("x/y");
	});
});
