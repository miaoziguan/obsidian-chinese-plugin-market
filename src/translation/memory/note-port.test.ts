import { describe, it, expect } from "vitest";
import { MemoryNoteStorage } from "./note-port";

describe("MemoryNoteStorage.normalizePath", () => {
	it("反斜杠 → 斜杠、连续斜杠折叠、首尾斜杠去除", async () => {
		const s = new MemoryNoteStorage();
		expect(s.normalizePath("a\\b\\c")).toBe("a/b/c");
		expect(s.normalizePath("a//b///c")).toBe("a/b/c");
		expect(s.normalizePath("/a/b/")).toBe("a/b");
		expect(s.normalizePath("")).toBe("");
		expect(s.normalizePath("plain.md")).toBe("plain.md");
		// 归一化后的路径被其余方法共用
		await s.writeNote("\\a//b.md\\", "x");
		expect(s.notes.has("a/b.md")).toBe(true);
	});
});

describe("MemoryNoteStorage 八个能力", () => {
	it("exists：笔记或文件夹命中", async () => {
		const s = new MemoryNoteStorage();
		expect(s.exists("a")).toBe(false);
		await s.writeNote("a.md", "x");
		expect(s.exists("a.md")).toBe(true);
		await s.createFolder("dir");
		expect(s.exists("dir")).toBe(true);
	});

	it("createFolder 归一化后入集合，重复创建幂等", async () => {
		const s = new MemoryNoteStorage();
		await s.createFolder("/a//b/");
		await s.createFolder("a/b");
		expect([...s.folders]).toEqual(["a/b"]);
	});

	it("writeNote 写入/覆盖；deleteNote 删除与不存在静默", async () => {
		const s = new MemoryNoteStorage();
		await s.writeNote("/a.md", "v1");
		await s.writeNote("a.md", "v2");
		expect(s.notes.get("a.md")).toBe("v2");
		await s.deleteNote("/a.md");
		expect(s.exists("a.md")).toBe(false);
		await expect(s.deleteNote("missing.md")).resolves.toBeUndefined();
	});

	it("listMarkdown：仅目录前缀 + 子目录下 .md，排除非 md 与目录外文件", async () => {
		const s = new MemoryNoteStorage();
		await s.writeNote("tm/a.md", "1");
		await s.writeNote("tm/sub/b.md", "2");
		await s.writeNote("tm/c.txt", "3");
		await s.writeNote("tm.md", "4"); // 目录同名前缀但不是子路径
		await s.writeNote("other/d.md", "5");
		const out = await s.listMarkdown("/tm/");
		expect(out.sort()).toEqual(["tm/a.md", "tm/sub/b.md"]);
	});

	it("listMarkdown 空目录 → 空数组", async () => {
		expect(await new MemoryNoteStorage().listMarkdown("none")).toEqual([]);
	});

	it("readNote：命中返回原文，缺失返回空串", async () => {
		const s = new MemoryNoteStorage();
		await s.writeNote("a.md", "content");
		expect(await s.readNote("/a.md")).toBe("content");
		expect(await s.readNote("missing.md")).toBe("");
	});

	it("statMtime：存在返回 1，缺失返回 0（笔记与文件夹都算存在）", async () => {
		const s = new MemoryNoteStorage();
		expect(await s.statMtime("none")).toBe(0);
		await s.writeNote("a.md", "x");
		expect(await s.statMtime("a.md")).toBe(1);
		await s.createFolder("dir");
		expect(await s.statMtime("dir")).toBe(1);
	});
});
