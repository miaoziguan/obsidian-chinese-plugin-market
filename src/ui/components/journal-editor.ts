/**
 * 详情抽屉里的「我的评测」编辑区块（评测台账 P3）。
 *
 * 这是项目里第一个自由文本输入（textarea）。设计要点：
 * - 状态（在用/弃用/观望）三选一、评分 1–5 星、弃用原因 8 选多——都是纯主观字段
 * - 备注可自由输入；输入经 500ms 防抖后自动落盘（无保存按钮，沿用 saveTranslatorData 的防抖思路）
 * - 事实区（首次安装/卸载/重装次数）只读，由插件自动维护，明确标「自动记录」，
 *   不替用户做主观推断（例如不把「已卸载」自动标记「弃用」）
 * - textarea 的 keydown 阻止冒泡：抽屉内有全局 keydown 快捷键，输入时不应触发
 */
import { type I18nKey } from "@shared/i18n";
import { VERDICT_PRESETS, type JournalEntry, type JournalStatus } from "@domain/journal/journal-entry";

export interface JournalEditorHost {
	t: (key: I18nKey) => string;
	/** 保存（内部自行防抖，fire-and-forget） */
	save: (entry: JournalEntry) => void;
	/** 自动记录的事实（只读展示） */
	facts?: {
		firstInstalled?: number;
		lastInstalled?: number;
		uninstalled?: number | null;
		installCount?: number;
	};
}

const STATUS_KEYS: { v: JournalStatus; label: string }[] = [
	{ v: "using", label: "在用" },
	{ v: "abandoned", label: "弃用" },
	{ v: "watching", label: "观望" },
];

function fmtDate(ms?: number | null): string {
	if (!ms) return "—";
	return new Date(ms).toLocaleDateString();
}

/**
 * 在 parent 内渲染评测编辑区块，返回 dispose（抽屉关闭时调用，立即落盘一次防抖窗口内的编辑）。
 */
export function renderJournalEditor(
	parent: HTMLElement,
	pluginId: string,
	pluginName: string,
	initial: JournalEntry | null,
	host: JournalEditorHost,
): { dispose: () => void } {
	const t = host.t;
	const wrap = parent.createDiv({ cls: "pt-journal-editor" });
	wrap.createDiv({ cls: "pt-journal-title", text: t("journal.title") });

	const state: JournalEntry = initial ?? { id: pluginId, name: pluginName, note: "" };

	// 状态三选一
	const statusRow = wrap.createDiv({ cls: "pt-journal-row" });
	statusRow.createSpan({ cls: "pt-journal-label", text: t("journal.status") });
	const statusBtns = STATUS_KEYS.map(({ v, label }) => {
		const b = statusRow.createEl("button", { cls: "pt-journal-chip", text: label });
		b.setAttribute("aria-pressed", state.status === v ? "true" : "false");
		b.addEventListener("click", () => {
			state.status = state.status === v ? undefined : v;
			statusBtns.forEach((el, i) =>
				el.setAttribute("aria-pressed", state.status === STATUS_KEYS[i].v ? "true" : "false"),
			);
			commit();
		});
		return b;
	});

	// 评分 1-5
	const rateRow = wrap.createDiv({ cls: "pt-journal-row" });
	rateRow.createSpan({ cls: "pt-journal-label", text: t("journal.rating") });
	const starBtns: HTMLElement[] = [];
	for (let i = 1; i <= 5; i++) {
		const b = rateRow.createEl("button", { cls: "pt-journal-star", text: "★" });
		b.setAttribute("aria-label", `${i}`);
		if ((state.rating ?? 0) >= i) b.addClass("is-on");
		b.addEventListener("click", () => {
			state.rating = state.rating === i ? undefined : i;
			starBtns.forEach((el, idx) => el.toggleClass("is-on", (state.rating ?? 0) > idx));
			commit();
		});
		starBtns.push(b);
	}

	// 弃用原因多选
	const verdictRow = wrap.createDiv({ cls: "pt-journal-row" });
	verdictRow.createSpan({ cls: "pt-journal-label", text: t("journal.verdict") });
	const picked = new Set(state.verdict ?? []);
	for (const v of VERDICT_PRESETS) {
		const b = verdictRow.createEl("button", { cls: "pt-journal-chip", text: v });
		b.setAttribute("aria-pressed", picked.has(v) ? "true" : "false");
		b.addEventListener("click", () => {
			if (picked.has(v)) picked.delete(v);
			else picked.add(v);
			b.setAttribute("aria-pressed", picked.has(v) ? "true" : "false");
			state.verdict = [...picked];
			commit();
		});
	}

	// 备注（项目首个自由文本输入）
	const noteArea = wrap.createEl("textarea", {
		cls: "pt-journal-note",
		attr: { rows: "4", placeholder: t("journal.notePlaceholder") },
	});
	noteArea.value = state.note;
	// 阻止冒泡：抽屉内有全局 keydown，输入时不应触发抽屉快捷键
	noteArea.addEventListener("keydown", (e: KeyboardEvent) => e.stopPropagation());

	// 事实区（只读）
	if (host.facts) {
		const facts = wrap.createDiv({ cls: "pt-journal-facts" });
		facts.createSpan({
			text: `${t("journal.autoFacts")}：${fmtDate(host.facts.firstInstalled)} / ${fmtDate(host.facts.lastInstalled)}`,
		});
		if (host.facts.uninstalled) {
			facts.createSpan({
				text: ` · ${t("journal.uninstalledAt")} ${fmtDate(host.facts.uninstalled)}`,
			});
		}
		if (host.facts.installCount) {
			facts.createSpan({
				text: ` · ${t("journal.installCount")} ${host.facts.installCount}`,
			});
		}
	}

	// 防抖保存
	let timer: number | undefined;
	const commit = () => {
		if (timer) window.clearTimeout(timer);
		timer = window.setTimeout(() => {
			state.updated = Date.now();
			host.save(state);
		}, 500);
	};
	noteArea.addEventListener("input", () => {
		state.note = noteArea.value;
		commit();
	});

	return {
		dispose: () => {
			if (timer) window.clearTimeout(timer);
			// 关闭时立即落盘一次，防抖窗口内的编辑不丢
			state.note = noteArea.value;
			state.updated = Date.now();
			host.save(state);
		},
	};
}
