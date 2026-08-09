/**
 * 笔记存储端口（依赖倒置）——翻译记忆库（TM）不再直接依赖 Obsidian 的 Vault/TFile。
 *
 * TM 需要把 approved 条目以 vault 笔记形式单条落盘（可被 Sync 同步、可被用户手编）。
 * 这里把它抽象成「路径归一化 + 存在判断 + 建目录 + 读写删」六个最小能力，
 * 由 app 层在装配期用 Obsidian Vault 适配后注入，单测可用内存实现。
 */
export interface NoteStoragePort {
	/** 路径归一化（对齐 Obsidian normalizePath 语义） */
	normalizePath(path: string): string;
	/** 该路径是否已存在（文件或文件夹） */
	exists(path: string): boolean;
	/** 创建文件夹（已存在时应静默容错，供并发写入竞态使用） */
	createFolder(path: string): Promise<void>;
	/** 写入或覆盖笔记 */
	writeNote(path: string, content: string): Promise<void>;
	/** 删除笔记（不存在时静默返回） */
	deleteNote(path: string): Promise<void>;
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
	createFolder(path: string): Promise<void> {
		this.folders.add(path);
		return Promise.resolve();
	}
	writeNote(path: string, content: string): Promise<void> {
		this.notes.set(path, content);
		return Promise.resolve();
	}
	deleteNote(path: string): Promise<void> {
		this.notes.delete(path);
		return Promise.resolve();
	}
}
