import { TFile, normalizePath, type App } from "obsidian";

/**
 * 翻译记忆库（Translation Memory, TM）
 *
 * 行业最佳实践：每条译文带来源 (source) 与状态 (status)，
 * AI 产出默认 suggested（待人工审核），经 human-in-the-loop 晋升为 approved。
 * approved 条目以 vault 笔记形式单条 O(1) 落盘，可随 Sync 同步、可被用户手编，
 * 以此把「可信层」从插件私有目录迁移到 vault（用户内容层）。
 */

export type TMSource = "bulk" | "ai" | "human" | "online";
export type TMStatus = "approved" | "suggested";

export interface TMEntry {
	id: string;
	name: string;
	description: string;
	source: TMSource;
	status: TMStatus;
	confidence: number;
	created: number;
	/** 晋升为 approved 的时间戳（seed 的内置条目也有） */
	promoted?: number;
	/** 用户/反馈标记该译文有问题（条目仍保留，供后续校正） */
	flagged?: boolean;
}

/** vault 中存放 TM 笔记的文件夹 */
export const TM_FOLDER = "插件翻译记忆库";

/** 安全文件名：插件 id 可能含 / : 等非法字符，统一转义 */
export function tmNotePath(id: string): string {
	const safe = id.replace(/[\\/:#^|[\]]/g, "_");
	return normalizePath(`${TM_FOLDER}/${safe}.md`);
}

/** 渲染 vault 笔记：frontmatter 机器可读，正文人类可读 */
export function renderTMNote(e: TMEntry): string {
	const fm = [
		"---",
		`id: ${JSON.stringify(e.id)}`,
		`name: ${JSON.stringify(e.name)}`,
		`description: ${JSON.stringify(e.description)}`,
		`source: ${e.source}`,
		`status: ${e.status}`,
		`confidence: ${e.confidence}`,
		`created: ${e.created}`,
	];
	if (e.promoted) fm.push(`promoted: ${e.promoted}`);
	fm.push("---", "", `# ${e.name}`, "", e.description);
	return fm.join("\n");
}

/** 从笔记正文解析 TMEntry（容错：缺字段则回退默认值） */
export function parseTMNote(content: string): TMEntry | null {
	const m = content.match(/^---\n([\s\S]*?)\n---/);
	if (!m) return null;
	const kv: Record<string, string> = {};
	for (const line of m[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx < 0) continue;
		const k = line.slice(0, idx).trim();
		let v = line.slice(idx + 1).trim();
		if (
			(v.startsWith('"') && v.endsWith('"')) ||
			(v.startsWith("'") && v.endsWith("'"))
		) {
			try {
				v = JSON.parse(v);
			} catch {
				/* 保留原值 */
			}
		}
		kv[k] = v;
	}
	if (!kv.id || kv.name === undefined) return null;
	return {
		id: kv.id,
		name: kv.name,
		description: kv.description ?? "",
		source: (kv.source as TMSource) ?? "human",
		status: (kv.status as TMStatus) ?? "approved",
		confidence: Number(kv.confidence) || 0,
		created: Number(kv.created) || Date.now(),
		promoted: kv.promoted ? Number(kv.promoted) : undefined,
		flagged: kv.flagged === "true",
	};
}

/** 写入/更新单条 vault 笔记（Obsidian-native 单条 O(1) 写） */
export async function writeTMNote(app: App, e: TMEntry): Promise<void> {
	const folder = normalizePath(TM_FOLDER);
	if (!app.vault.getAbstractFileByPath(folder)) {
		// 并发写入时可能竞态触发「已存在」，容错吞掉
		await app.vault.createFolder(folder).catch(() => {});
	}
	const path = tmNotePath(e.id);
	const file = app.vault.getAbstractFileByPath(path);
	const content = renderTMNote(e);
	if (file instanceof TFile) {
		await app.vault.modify(file, content);
	} else {
		await app.vault.create(path, content);
	}
}

/** 删除单条 vault 笔记 */
export async function removeTMNote(app: App, id: string): Promise<void> {
	const file = app.vault.getAbstractFileByPath(tmNotePath(id));
	if (file instanceof TFile) await app.vault.delete(file);
}
