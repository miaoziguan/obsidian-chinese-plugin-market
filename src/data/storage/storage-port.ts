/**
 * 文件存储端口（依赖倒置）——下层不再直接依赖 Obsidian 的 `App.vault.adapter`。
 *
 * 只暴露缓存读写真正需要的三个能力（exists / read / write），
 * 由 app 层在装配期用 Obsidian DataAdapter 适配后注入。
 * 单测可用内存 Map 实现，无需 mock 整个 App。
 */
export interface StoragePort {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
}

/** 内存实现（单测/降级用；也可作为无适配器环境的兜底） */
export class MemoryStoragePort implements StoragePort {
	private files = new Map<string, string>();

	exists(path: string): Promise<boolean> {
		return Promise.resolve(this.files.has(path));
	}
	read(path: string): Promise<string> {
		const v = this.files.get(path);
		if (v === undefined) return Promise.reject(new Error(`ENOENT: ${path}`));
		return Promise.resolve(v);
	}
	write(path: string, data: string): Promise<void> {
		this.files.set(path, data);
		return Promise.resolve();
	}
}
