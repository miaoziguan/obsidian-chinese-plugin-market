/**
 * Obsidian 适配器集合（依赖倒置的「装配点」）。
 *
 * 下层（data / domain / translation / semantic / shared）一律不 import "obsidian"，
 * 只面向端口接口编程；本文件是唯一把 Obsidian 具体 API 适配成端口实现的地方，
 * 由 app/plugin.ts 在 onload 最早期完成注入。
 */

import { Platform, TFile, TFolder, requestUrl, normalizePath, type App } from "obsidian";
import { type HttpClient, type HttpRequestOptions, type HttpResponse } from "@data/net/http-port";
import { type StoragePort } from "@data/storage/storage-port";
import { type NoteStoragePort } from "@translation/memory/note-port";
import { type PlatformCapability } from "@translation/platform/macos-shortcuts";

/** HttpClient 实现：走 Obsidian requestUrl（跟随系统代理/直连，不抛错由调用方判 status） */
export class ObsidianHttpClient implements HttpClient {
	async request(opts: HttpRequestOptions): Promise<HttpResponse> {
		const resp = await requestUrl({
			url: opts.url,
			method: opts.method ?? "GET",
			headers: opts.headers,
			body: opts.body,
			throw: false,
		});
		return { status: resp.status, json: resp.json, text: resp.text, headers: resp.headers };
	}
}

/** StoragePort 实现：走 vault DataAdapter（插件私有目录下的独立缓存文件） */
export class ObsidianStoragePort implements StoragePort {
	constructor(private app: App) {}

	exists(path: string): Promise<boolean> {
		return this.app.vault.adapter.exists(path);
	}
	read(path: string): Promise<string> {
		return this.app.vault.adapter.read(path);
	}
	write(path: string, data: string): Promise<void> {
		return this.app.vault.adapter.write(path, data);
	}
}

/**
 * NoteStoragePort 实现：按路径前缀在两种后端间择一。
 *
 * - **vault 内路径**（用户在设置里自定义的 vault 相对路径）：走 Vault 高层 API，
 *   笔记进 vault 文件树、可被用户检索/手编，行为与旧版一致。
 * - **`.obsidian/` 路径**（默认落点）：走底层 `vault.adapter`，绕过 vault 文件树 /
 *   create·delete 事件 / metadataCache——不被其他插件检索、不污染 vault、
 *   写入 .obsidian 私有目录（与 translator-cache / vector-index 同级）。
 *
 * 两条后端对 NoteStoragePort 八能力的语义一致，故 TM 业务逻辑（写/扫/迁/解析）
 * 无需感知后端差异。
 */
export class ObsidianNoteStorage implements NoteStoragePort {
	constructor(private app: App) {}

	/** 是否落在配置目录（默认 .obsidian，可被用户自定义到 vault.configDir）：走底层 adapter，绕过 vault 文件树/事件/metadataCache */
	private isAdapterPath(p: string): boolean {
		const cfg = normalizePath(this.app.vault.configDir);
		const np = normalizePath(p);
		return np === cfg || np.startsWith(cfg + "/");
	}

	normalizePath(path: string): string {
		return normalizePath(path);
	}

	exists(path: string): boolean | Promise<boolean> {
		const p = normalizePath(path);
		if (this.isAdapterPath(p)) return this.app.vault.adapter.exists(p);
		return this.app.vault.getAbstractFileByPath(p) != null;
	}

	/**
	 * 逐级确保 adapter 目录存在。
	 * adapter.mkdir 不递归（且已存在时会抛错），故逐级检查后创建；
	 * 每级失败静默容错，供并发写入竞态使用。
	 */
	private async ensureAdapterDir(dir: string): Promise<void> {
		const parts = normalizePath(dir).split("/").filter(Boolean);
		let cur = "";
		for (const part of parts) {
			cur = cur ? `${cur}/${part}` : part;
			if (!(await this.app.vault.adapter.exists(cur))) {
				await this.app.vault.adapter.mkdir(cur).catch(() => {});
			}
		}
	}

	async createFolder(path: string): Promise<void> {
		const p = normalizePath(path);
		if (this.isAdapterPath(p)) {
			await this.ensureAdapterDir(p);
			return;
		}
		await this.app.vault.createFolder(p);
	}

	async writeNote(path: string, content: string): Promise<void> {
		const p = normalizePath(path);
		if (this.isAdapterPath(p)) {
			// 关键：adapter.write 不会自动创建父目录（桌面端 NodeFsAdapter 直接抛
			// ENOENT），必须显式逐级建目录。首次把笔记写进 .obsidian/.../tm/ 时
			// 该目录尚不存在，缺这一步会让整条延迟初始化中断（曾导致首屏干等
			// 15s 安全阀：scanVaultTM 未执行 → tmApprovedReady 不 resolve）。
			const idx = p.lastIndexOf("/");
			if (idx > 0) await this.ensureAdapterDir(p.slice(0, idx));
			await this.app.vault.adapter.write(p, content);
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(p);
		if (file instanceof TFile) {
			await this.app.vault.modify(file, content);
		} else {
			await this.app.vault.create(p, content);
		}
	}

	async deleteNote(path: string): Promise<void> {
		const p = normalizePath(path);
		if (this.isAdapterPath(p)) {
			if (await this.app.vault.adapter.exists(p)) {
				await this.app.vault.adapter.remove(p);
			}
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(p);
		if (file instanceof TFile) await this.app.fileManager.trashFile(file);
	}

	async listMarkdown(folder: string): Promise<string[]> {
		const base = normalizePath(folder);
		if (this.isAdapterPath(base)) {
			// 目录尚不存在时部分 adapter 实现会抛 ENOENT（首次使用 / 迁移前）。
			// 统一视为「没有笔记」而非错误，避免中断 scanVaultTM 链路。
			const listing = await this.app.vault.adapter.list(base).catch(() => null);
			if (!listing) return [];
			return listing.files.filter(
				(f) => f.startsWith(base + "/") && f.endsWith(".md"),
			);
		}
		const af = this.app.vault.getAbstractFileByPath(base);
		if (af instanceof TFolder) {
			const out: string[] = [];
			const walk = (fo: TFolder) => {
				for (const child of fo.children) {
					if (child instanceof TFile) {
						if (child.path.endsWith(".md")) out.push(child.path);
					} else if (child instanceof TFolder) {
						walk(child);
					}
				}
			};
			walk(af);
			return out;
		}
		return [];
	}

	async readNote(path: string): Promise<string> {
		const p = normalizePath(path);
		if (this.isAdapterPath(p)) return this.app.vault.adapter.read(p);
		// vault 路径：优先 cachedRead（命中 metadataCache），失败回退 adapter 直读
		try {
			const file = this.app.vault.getAbstractFileByPath(p);
			if (!(file instanceof TFile)) throw new Error("not a file");
			return await this.app.vault.cachedRead(file);
		} catch {
			return this.app.vault.adapter.read(p);
		}
	}

	async statMtime(path: string): Promise<number> {
		const p = normalizePath(path);
		if (this.isAdapterPath(p)) {
			try {
				const s = await this.app.vault.adapter.stat(p);
				return s?.mtime ?? 0;
			} catch {
				return 0;
			}
		}
		const file = this.app.vault.getAbstractFileByPath(p);
		return file instanceof TFile ? file.stat?.mtime ?? 0 : 0;
	}
}

/** 平台能力快照（Obsidian Platform 在运行期是常量，取一次即可） */
export function obsidianPlatformCapability(): PlatformCapability {
	// 测试 / 非 Obsidian 环境可能无 Platform，做防御性判断
	return {
		isDesktopApp: Boolean(Platform?.isDesktopApp),
		isMacOS: Boolean(Platform?.isMacOS),
	};
}
