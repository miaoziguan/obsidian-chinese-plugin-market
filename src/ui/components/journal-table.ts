/**
 * 评测台账「我的插件足迹」表格组件（阶段 5）。
 *
 * 纯逻辑（filterJournalRows / sortJournalRows / journalRowsToMarkdown）与 DOM 渲染解耦，
 * 便于单测；renderJournalTable 负责排序/状态筛选/原因筛选/关键词搜索/行跳转/复制 markdown。
 */
import { VERDICT_PRESETS, type JournalStatus } from "@domain/journal/journal-entry";
import type { I18nKey } from "@shared/i18n";

export interface JournalRow {
	id: string;
	name: string;
	status?: JournalStatus;
	rating?: number;
	verdict?: string[];
	firstInstalled?: number;
	/** 最近动态：卸载时间优先，否则最近安装时间（用于「最近动态」列与排序） */
	lastActive?: number | null;
	installCount?: number;
	currentlyInstalled?: boolean;
	note?: string;
}

export type JournalSortKey = "name" | "status" | "rating" | "firstInstalled" | "lastActive";

export type JournalStatusFilter = "all" | JournalStatus | "tried";

export interface JournalTableFilter {
	search: string;
	status: JournalStatusFilter;
	verdict: string | null;
}

const STATUS_RANK: Record<string, number> = { using: 0, abandoned: 1, watching: 2, "": 3 };

/** 按关键词 / 状态 / 原因筛选（纯函数） */
export function filterJournalRows(rows: JournalRow[], f: JournalTableFilter): JournalRow[] {
	const q = f.search.trim().toLowerCase();
	return rows.filter((r) => {
		if (f.status === "tried" && r.status) return false;
		if (f.status !== "all" && f.status !== "tried" && r.status !== f.status) return false;
		if (f.verdict && !(r.verdict ?? []).includes(f.verdict)) return false;
		if (q) {
			const hay = `${r.name} ${r.id} ${r.note ?? ""}`.toLowerCase();
			if (!hay.includes(q)) return false;
		}
		return true;
	});
}

/** 排序（纯函数）；同值回退按名称，保证稳定 */
export function sortJournalRows(rows: JournalRow[], key: JournalSortKey, asc: boolean): JournalRow[] {
	const dir = asc ? 1 : -1;
	return [...rows].sort((a, b) => {
		let cmp = 0;
		switch (key) {
			case "name":
				cmp = (a.name || a.id).localeCompare(b.name || b.id, "zh");
				break;
			case "status":
				cmp = STATUS_RANK[a.status ?? ""] - STATUS_RANK[b.status ?? ""];
				break;
			case "rating":
				cmp = (a.rating ?? 0) - (b.rating ?? 0);
				break;
			case "firstInstalled":
				cmp = (a.firstInstalled ?? 0) - (b.firstInstalled ?? 0);
				break;
			case "lastActive":
				cmp = (a.lastActive ?? 0) - (b.lastActive ?? 0);
				break;
		}
		if (cmp === 0) cmp = (a.name || a.id).localeCompare(b.name || b.id, "zh");
		return cmp * dir;
	});
}

function statusLabel(r: JournalRow, t: (k: I18nKey) => string): string {
	if (r.status === "using") return t("journal.status.using");
	if (r.status === "abandoned") return t("journal.status.abandoned");
	if (r.status === "watching") return t("journal.status.watching");
	return t("journal.status.tried");
}

function fmtDate(ms?: number | null): string {
	if (!ms) return "—";
	try {
		return new Date(ms).toLocaleDateString();
	} catch {
		return "—";
	}
}

/** 整表导出为 Markdown（纯函数，供「复制为 Markdown」） */
export function journalRowsToMarkdown(rows: JournalRow[], t: (k: I18nKey) => string): string {
	const head = [
		t("journal.col.name"),
		t("journal.col.status"),
		t("journal.col.rating"),
		t("journal.col.verdict"),
		t("journal.col.first"),
		t("journal.col.active"),
		t("journal.col.note"),
	];
	const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
	const lines: string[] = [head.join(" | "), head.map(() => "---").join(" | ")];
	for (const r of rows) {
		lines.push(
			[
				esc(r.name || r.id),
				statusLabel(r, t),
				r.rating ? "★".repeat(r.rating) : "—",
				(r.verdict ?? []).join("、") || "—",
				fmtDate(r.firstInstalled),
				fmtDate(r.lastActive),
				esc((r.note ?? "").slice(0, 60)) || "—",
			].join(" | "),
		);
	}
	return lines.join("\n");
}

export interface JournalTableHost {
	onOpen: (id: string) => void;
	t: (k: I18nKey) => string;
}

/** 渲染台账表格，返回 rerender 供外部数据变化时重绘 */
export function renderJournalTable(
	parent: HTMLElement,
	rows: JournalRow[],
	host: JournalTableHost,
): { rerender: (next: JournalRow[]) => void } {
	let current = rows;
	let filter: JournalTableFilter = { search: "", status: "all", verdict: null };
	let sortKey: JournalSortKey = "lastActive";
	let sortAsc = false;

	const t = host.t;
	const wrap = parent.createDiv({ cls: "pt-journal-table-wrap" });

	const cols: [JournalSortKey, I18nKey][] = [
		["name", "journal.col.name"],
		["status", "journal.col.status"],
		["rating", "journal.col.rating"],
		["firstInstalled", "journal.col.first"],
		["lastActive", "journal.col.active"],
	];

	const draw = () => {
		wrap.empty();

		// ── 控制条：搜索 + 状态筛选 + 原因筛选 + 复制 ──
		const ctrl = wrap.createDiv({ cls: "pt-journal-ctrl" });

		const search = ctrl.createEl("input", {
			cls: "pt-journal-search",
			attr: { type: "text", placeholder: t("journal.search") },
		});
		search.value = filter.search;
		search.addEventListener("input", () => {
			filter.search = search.value;
			drawBody();
		});

		const statusChips = ctrl.createDiv({ cls: "pt-journal-status-chips" });
		const statusDefs: [JournalStatusFilter, I18nKey][] = [
			["all", "journal.filterAll"],
			["using", "journal.status.using"],
			["abandoned", "journal.status.abandoned"],
			["watching", "journal.status.watching"],
			["tried", "journal.filterTried"],
		];
		const paintStatus = () => {
			statusChips.empty();
			statusDefs.forEach(([v, key]) => {
				const b = statusChips.createEl("button", {
					cls: "pt-filter pt-journal-status" + (filter.status === v ? " is-active" : ""),
					text: t(key),
				});
				b.addEventListener("click", () => {
					filter.status = v;
					paintStatus();
					drawBody();
				});
			});
		};
		paintStatus();

		const verdictSel = ctrl.createEl("select", { cls: "pt-journal-verdict" });
		const optAll = verdictSel.createEl("option", { text: t("journal.verdictAll") });
		optAll.value = "";
		for (const v of VERDICT_PRESETS) {
			const o = verdictSel.createEl("option", { text: v });
			o.value = v;
		}
		verdictSel.value = filter.verdict ?? "";
		verdictSel.addEventListener("change", () => {
			filter.verdict = verdictSel.value || null;
			drawBody();
		});

		const copyBtn = ctrl.createEl("button", { cls: "pt-journal-copy", text: t("journal.copy") });
		copyBtn.addEventListener("click", async () => {
			const md = journalRowsToMarkdown(filteredSorted(), t);
			try {
				await navigator.clipboard.writeText(md);
				copyBtn.setText(t("journal.copyDone"));
				window.setTimeout(() => copyBtn.setText(t("journal.copy")), 1500);
			} catch {
				copyBtn.setText(t("journal.copyFail"));
				window.setTimeout(() => copyBtn.setText(t("journal.copy")), 1500);
			}
		});

		const body = wrap.createDiv({ cls: "pt-journal-body" });
		const filteredSorted = (): JournalRow[] =>
			sortJournalRows(filterJournalRows(current, filter), sortKey, sortAsc);

		const drawBody = () => {
			body.empty();
			const data = filteredSorted();
			if (data.length === 0) {
				body.createDiv({ cls: "pt-empty-hint", text: t("journal.emptyFilter") });
				return;
			}
			const table = body.createEl("table", { cls: "pt-journal-table" });
			const head = table.createEl("tr", { cls: "pt-journal-tr-head" });
			for (const [key, labelKey] of cols) {
				const th = head.createEl("th", {
					cls: "pt-journal-th",
					text: sortKey === key ? `${t(labelKey)}${sortAsc ? "↑" : "↓"}` : t(labelKey),
				});
				th.addEventListener("click", () => {
					if (sortKey === key) sortAsc = !sortAsc;
					else {
						sortKey = key;
						sortAsc = key === "name";
					}
					drawBody();
				});
			}
			head.createEl("th", { cls: "pt-journal-th", text: t("journal.col.verdict") });
			head.createEl("th", { cls: "pt-journal-th", text: t("journal.col.note") });

			for (const r of data) {
				const tr = table.createEl("tr", { cls: "pt-journal-tr" });
				const nameTd = tr.createEl("td", { cls: "pt-journal-name", text: r.name || r.id });
				nameTd.addEventListener("click", () => host.onOpen(r.id));
				tr.createEl("td", { text: statusLabel(r, t) });
				tr.createEl("td", { text: r.rating ? "★".repeat(r.rating) : "—" });
				tr.createEl("td", { text: fmtDate(r.firstInstalled) });
				tr.createEl("td", { text: fmtDate(r.lastActive) });
				tr.createEl("td", { text: (r.verdict ?? []).join("、") || "—" });
				tr.createEl("td", { cls: "pt-journal-note-cell", text: (r.note ?? "").slice(0, 60) || "—" });
			}
		};

		drawBody();
	};

	draw();
	return {
		rerender: (next: JournalRow[]) => {
			current = next;
			draw();
		},
	};
}
