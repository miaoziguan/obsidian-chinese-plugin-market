/**
 * Obsidian 适配器集合（依赖倒置的「装配点」）。
 *
 * 下层（data / domain / translation / semantic / shared）一律不 import "obsidian"，
 * 只面向端口接口编程；本文件是唯一把 Obsidian 具体 API 适配成端口实现的地方，
 * 由 app/plugin.ts 在 onload 最早期完成注入。
 */

import { Platform, TFile, requestUrl, normalizePath, type App } from "obsidian";
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

/** NoteStoragePort 实现：走 Vault 的笔记 CRUD（TM 条目以用户可见笔记落盘） */
export class ObsidianNoteStorage implements NoteStoragePort {
	constructor(private app: App) {}

	normalizePath(path: string): string {
		return normalizePath(path);
	}
	exists(path: string): boolean {
		return this.app.vault.getAbstractFileByPath(path) != null;
	}
	async createFolder(path: string): Promise<void> {
		await this.app.vault.createFolder(path);
	}
	async writeNote(path: string, content: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			await this.app.vault.modify(file, content);
		} else {
			await this.app.vault.create(path, content);
		}
	}
	async deleteNote(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) await this.app.fileManager.trashFile(file);
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
