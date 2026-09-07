/**
 * 笔记存储端口（依赖倒置）——翻译记忆库（TM）不再直接依赖 Obsidian 的 Vault/TFile。
 *
 * TM 需要把 approved 条目以 vault 笔记形式单条落盘（可被用户手编、可被「打开文件夹」定位）。
 * 这里把它抽象成「路径归一化 + 存在判断 + 建目录 + 读写删 + 列出 .md + 取 mtime」八个最小能力，
 * 由 app 层在装配期用 Obsidian Vault 适配器注入，单测可用内存实现。
 *
 * 双后端：
 * - vault 内路径（用户在设置里自定义的 vault 相对路径）：走 Vault 高层 API，笔记进文件树/可被检索；
 * - `.obsidian/` 路径（默认落点）：走底层 `adapter`，不进 vault 文件树、不被其他插件检索、不污染 vault。
 * 两个后端对上列八个能力的语义一致，由 app 层按路径前缀自动择一（见 obsidian-adapters.ts）。
 */
export interface NoteStoragePort {
	/** 路径归一化（对齐 Obsidian normalizePath 语义） */
	normalizePath(path: string): string;
	/** 该路径是否已存在（文件或文件夹） */
	exists(path: string): boolean | Promise<boolean>;
	/** 创建文件夹（已存在时应静默容错，供并发写入竞态使用） */
	createFolder(path: string): Promise<void>;
	/** 写入或覆盖笔记 */
	writeNote(path: string, content: string): Promise<void>;
	/** 删除笔记（不存在时静默返回） */
	deleteNote(path: string): Promise<void>;
	/** 列出某目录下全部 .md 文件路径（含子目录，返回 vault 相对路径数组） */
	listMarkdown(folder: string): Promise<string[]>;
	/** 读取单条笔记原始内容（用于解析 frontmatter） */
	readNote(path: string): Promise<string>;
	/** 取文件 mtime（毫秒），用于快照增量核对；取不到返回 0 */
	statMtime(path: string): Promise<number>;
}

/** 内存实现（单测用；也可作为无 vault 环境的兜底） */
export class MemoryNoteStorage implements NoteStoragePort {
	readonly notes = new Map<string, string>();
	readonly folders = new Set<string>();

	normalizePath(path: string): string {
		return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
	}
	exists(path: string): boolean {
		return this.notes.has(path) || this.folders.has(path);
	}
	async createFolder(path: string): Promise<void> {
		this.folders.add(this.normalizePath(path));
	}
	async writeNote(path: string, content: string): Promise<void> {
		this.notes.set(this.normalizePath(path), content);
	}
	async deleteNote(path: string): Promise<void> {
		this.notes.delete(this.normalizePath(path));
	}
	async listMarkdown(folder: string): Promise<string[]> {
		const base = this.normalizePath(folder);
		const out: string[] = [];
		for (const p of this.notes.keys()) {
			if (p.startsWith(base + "/") && p.endsWith(".md")) out.push(p);
		}
		return out;
	}
	async readNote(path: string): Promise<string> {
		return this.notes.get(this.normalizePath(path)) ?? "";
	}
	async statMtime(path: string): Promise<number> {
		return this.exists(path) ? 1 : 0;
	}
}
