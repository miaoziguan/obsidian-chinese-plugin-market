/**
 * 插件评测台账（Plugin Journal）——评测笔记的数据模型与 frontmatter 编解码。
 *
 * 与翻译记忆库（TM）笔记同属「用户内容层」，但字段与用途不同：
 * TM 记的是「译名对照」（机器产出、插件消费），评测笔记记的是
 * 「我用这个插件的体验」（人产出、人消费）。因此不复用 TM 的
 * parseTMNote / renderTMNote（它们与 TMEntry 字段强耦合），在此独立实现。
 *
 * 设计原则：
 * - 事实字段（安装/卸载时间、启用态、重装次数）由插件自动维护；
 * - 主观字段（状态 status、评分 rating、弃用原因 verdict、正文备注）由用户维护；
 * - 解析必须容错：用户在 vault 里手编过的笔记可能缺字段或格式异常，
 *   单条坏笔记不得影响启动与其它功能。
 */

export type JournalStatus = "using" | "abandoned" | "watching";

/** 弃用原因预设（用于面板筛选统计；允许手写额外值，不做强校验） */
export const VERDICT_PRESETS = [
	"不好用",
	"有 bug",
	"有替代",
	"太重",
	"收费",
	"不更新",
	"冲突",
	"用不上",
] as const;

export interface JournalEntry {
	id: string;
	name: string;
	/** 主观状态（用户填，可不填） */
	status?: JournalStatus;
	/** 1–5 星（用户填，可不填） */
	rating?: number;
	/** 弃用原因（用户填，可不填） */
	verdict?: string[];
	/** 以下为插件自动维护的事实字段 */
	firstInstalled?: number;
	lastInstalled?: number;
	uninstalled?: number | null;
	installCount?: number;
	enabled?: boolean;
	updated?: number;
	/** 正文备注（frontmatter 之后的全部内容） */
	note: string;
}

const STATUSES: readonly string[] = ["using", "abandoned", "watching"];

/**
 * 解析 frontmatter 段。
 * 返回 null 表示「不是合法的 frontmatter 笔记」（无 --- 包裹或缺少 id）。
 */
function parseFrontmatter(
	raw: string,
): { kv: Record<string, string>; body: string } | null {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
	if (!m) return null;
	const kv: Record<string, string> = {};
	for (const line of m[1].split(/\r?\n/)) {
		const i = line.indexOf(":");
		if (i <= 0) continue;
		kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}
	return { kv, body: m[2].replace(/^\r?\n/, "") };
}

/** 解析形如 `[a, b]` 的数组；空数组返回 undefined（避免写入空字段） */
function parseArray(v: string | undefined): string[] | undefined {
	if (!v) return undefined;
	const inner = v.replace(/^\[|\]$/g, "").trim();
	if (!inner) return undefined;
	return inner
		.split(",")
		.map((s) => s.trim().replace(/^["']|["']$/g, ""))
		.filter(Boolean);
}

function num(v: string | undefined): number | undefined {
	if (v === undefined || v === "") return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
}

/** 从笔记原文解析评测条目；不是合法笔记时返回 null */
export function parseJournalNote(raw: string): JournalEntry | null {
	try {
		const parsed = parseFrontmatter(raw);
		if (!parsed) return null;
		const { kv, body } = parsed;
		if (!kv.id) return null;
		const status = STATUSES.includes(kv.status)
			? (kv.status as JournalStatus)
			: undefined;
		const rating = num(kv.rating);
		return {
			id: kv.id,
			name: kv.name ?? kv.id,
			status,
			// 评分只接受 1–5，越界当作未填（用户在 vault 里手写 10 星不算数）
			rating:
				rating !== undefined && rating >= 1 && rating <= 5
					? rating
					: undefined,
			verdict: parseArray(kv.verdict),
			firstInstalled: num(kv.firstInstalled),
			lastInstalled: num(kv.lastInstalled),
			// 无该字段 = 从未卸载（undefined）；有字段但解析不出数字则记 null，
			// 保证「渲染 → 解析」严格往返等价（否则会凭空多出 uninstalled: null）
			uninstalled:
				kv.uninstalled === undefined
					? undefined
					: num(kv.uninstalled) ?? null,
			installCount: num(kv.installCount),
			enabled: kv.enabled === undefined ? undefined : kv.enabled === "true",
			updated: num(kv.updated),
			note: body.trim(),
		};
	} catch {
		return null;
	}
}

/** 渲染为笔记全文（frontmatter + 空行 + 正文） */
export function renderJournalNote(e: JournalEntry): string {
	const lines: string[] = ["---", `id: ${e.id}`, `name: ${e.name}`];
	if (e.status) lines.push(`status: ${e.status}`);
	if (e.rating) lines.push(`rating: ${e.rating}`);
	if (e.verdict?.length) lines.push(`verdict: [${e.verdict.join(", ")}]`);
	if (e.firstInstalled) lines.push(`firstInstalled: ${e.firstInstalled}`);
	if (e.lastInstalled) lines.push(`lastInstalled: ${e.lastInstalled}`);
	if (e.uninstalled) lines.push(`uninstalled: ${e.uninstalled}`);
	if (e.installCount) lines.push(`installCount: ${e.installCount}`);
	if (e.enabled !== undefined) lines.push(`enabled: ${e.enabled}`);
	lines.push(`updated: ${e.updated ?? Date.now()}`, "---", "");
	return lines.join("\n") + (e.note ? `\n${e.note}\n` : "\n");
}
