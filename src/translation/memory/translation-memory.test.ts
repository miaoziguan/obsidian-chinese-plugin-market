import { describe, it, expect } from "vitest";
import { Translator } from "@domain/catalog/translator";
import { MemoryNoteStorage } from "@translation/memory/note-port";
import {
	renderTMNote,
	parseTMNote,
	tmNotePath,
	writeTMNote,
	type TMEntry,
} from "@translation/memory/translation-memory";

describe("TM 笔记序列化", () => {
	it("render -> parse 往返保持全部字段（含换行与特殊字符 id）", () => {
		const e: TMEntry = {
			id: "foo/bar:baz#qux",
			name: "测试名",
			description: "这是一段描述\n含换行与“引号”",
			source: "ai",
			status: "suggested",
			confidence: 0.82,
			created: 1700000000000,
			promoted: 1700000001000,
		};
		const back = parseTMNote(renderTMNote(e));
		expect(back).not.toBeNull();
		expect(back!.id).toBe(e.id);
		expect(back!.name).toBe(e.name);
		expect(back!.description).toBe(e.description);
		expect(back!.source).toBe("ai");
		expect(back!.status).toBe("suggested");
		expect(back!.confidence).toBeCloseTo(0.82);
		expect(back!.created).toBe(e.created);
		expect(back!.promoted).toBe(e.promoted);
	});

	it("tmNotePath 转义非法文件名字符", () => {
		expect(tmNotePath("a/b:c")).toBe("插件翻译记忆库/a_b_c.md");
	});

	it("L1: renderTMNote 对含 # / : 的 id 用 JSON 引号包裹（避免 YAML 注释截断），且往返一致", () => {
		const e: TMEntry = {
			id: "a#b:c",
			name: "在线译名",
			description: "在线译描",
			source: "online",
			status: "suggested",
			confidence: 0.6,
			created: 1700000000000,
		};
		const note = renderTMNote(e);
		expect(note).toContain('id: "a#b:c"');
		expect(parseTMNote(note)!.id).toBe("a#b:c");
	});
});

	it("writeTMNote 支持自定义 folder（记忆库可自定义路径）", async () => {
		const notes = new MemoryNoteStorage();
		const e: TMEntry = {
			id: "a/b:c",
			name: "测试名",
			description: "描",
			source: "human",
			status: "approved",
			confidence: 1,
			created: 1700000000000,
		};
		await writeTMNote(notes, e, "我的记忆/TM");
		expect(notes.notes.has("我的记忆/TM/a_b_c.md")).toBe(true);
		// 自定义路径优先：默认文件夹不应被写入
		expect(notes.notes.has("插件翻译记忆库/a_b_c.md")).toBe(false);
	});

	it("T1: source=online 的 TM 条目往返序列化保持来源", () => {
		const e: TMEntry = {
			id: "online-plugin",
			name: "在线译名",
			description: "在线译描",
			source: "online",
			status: "approved",
			confidence: 0.6,
			created: 1700000000000,
		};
		const back = parseTMNote(renderTMNote(e));
		expect(back!.source).toBe("online");
	});

	it("T2(#2): markTMDirty/peekTMDirty/clearTMDirty 支持「写成功后才清除」语义", () => {
		const tr = new Translator();
		tr.markTMDirty("p1");
		expect(tr.peekTMDirty()).toContain("p1");
		// 写成功后清除
		tr.clearTMDirty("p1");
		expect(tr.peekTMDirty()).not.toContain("p1");
		// 失败时（不清）可重新标记，下次 flush 重试
		tr.markTMDirty("p2");
		expect(tr.peekTMDirty()).toContain("p2");
	});
