/**
 * 评测台账「我的插件足迹」独立标签页视图（阶段 5，ItemView）。
 *
 * 数据来源：安装历史索引（全部装过的）左连接评测笔记（有评测的），按 id 关联。
 * 表格渲染委托 @ui/components/journal-table，本文件只负责视图生命周期与数据组装。
 */
import { ItemView, WorkspaceLeaf } from "obsidian";
import { renderJournalTable, composeBilingualName, type JournalRow } from "@ui/components/journal-table";
import type { JournalEntry } from "@domain/journal/journal-entry";
import type { InstallRecord } from "@domain/journal/install-history";
import type { I18nKey } from "@shared/i18n";

export const JOURNAL_VIEW_TYPE = "chinese-plugin-market-journal";

export interface JournalViewHost {
	/** 安装历史索引条目（id → 记录） */
	loadHistory: () => Promise<Record<string, InstallRecord>>;
	/** 全部评测笔记 */
	listEntries: () => Promise<JournalEntry[]>;
	/** 官方社区列表的 id → 英文原名（供「英文为主 + 括号中文」的双语插件名展示） */
	officialNames: () => Promise<Map<string, string>>;
	/** 点击表格某行：跳回主视图对应插件 */
	openPlugin: (id: string) => void;
	onRead?: (ids: string[]) => void;
	t: (k: I18nKey) => string;
}

export class JournalView extends ItemView {
	private host: JournalViewHost;

	constructor(leaf: WorkspaceLeaf, host: JournalViewHost) {
		super(leaf);
		this.host = host;
	}

	getViewType(): string {
		return JOURNAL_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.host.t("journal.footprint");
	}

	getIcon(): string {
		return "list-ordered";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("pt-journal-view");
		root.createDiv({ cls: "pt-journal-view-title", text: this.host.t("journal.footprint") });
		const body = root.createDiv({ cls: "pt-journal-view-body" });

		// 三个并发 IO 完成前正文区完全空白（评测笔记多 / vault 大时是明显白屏期），
		// 用户会以为视图坏了。先给加载指示，复用主列表的 .pt-empty / .pt-loading 样式。
		const loading = body.createDiv({ cls: "pt-empty pt-loading" });
		loading.createDiv({ cls: "pt-loading-spinner" });
		loading.createDiv({ cls: "pt-empty-title", text: this.host.t("app.loading") });

		// onOpen 此前无任何错误处理：任一 IO reject 会让页面永远停在「只有标题」，
		// 既不告知原因也不给重试入口，只能关掉重开。
		const result = await Promise.all([
			this.host.loadHistory(),
			this.host.listEntries(),
			this.host.officialNames(),
		]).catch((e: unknown) => {
			loading.remove();
			const err = body.createDiv({ cls: "pt-error" });
			err.createDiv({ cls: "pt-empty-title", text: this.host.t("error.title") });
			err.createDiv({ cls: "pt-empty-hint", text: e instanceof Error ? e.message : String(e) });
			return null;
		});
		if (!result) return;
		const [history, entries, official] = result;
		loading.remove();
		this.host.onRead?.(entries.map((e) => e.id));

		// 还没写过任何评测：展示引导（B），并附「装过」记录数供参考
		if (entries.length === 0) {
			const guide = body.createDiv({ cls: "pt-journal-guide" });
			guide.createDiv({ cls: "pt-journal-guide-title", text: this.host.t("journal.emptyHintTitle") });
			guide.createDiv({ cls: "pt-journal-guide-desc", text: this.host.t("journal.empty") });
			if (Object.keys(history).length > 0) {
				guide.createDiv({ cls: "pt-journal-guide-note", text: this.host.t("journal.guideInstalled") });
			}
			return;
		}

		// 有评测：以评测笔记为主构建行，安装历史仅补充事实列
		// （首次安装 / 最近动态 / 最后卸载 / 次数）
		// 插件名按用户反馈做双语展示：英文原名为主，括号里是中文译名；
		// 不在官方列表的（直链安装等）只有一个名字时原样展示
		const rows: JournalRow[] = entries.map((e) => {
			const h = history[e.id];
			return {
				id: e.id,
				name: composeBilingualName(official.get(e.id), e.name) || e.id,
				status: e.status,
				rating: e.rating,
				verdict: e.verdict,
				firstInstalled: h?.firstInstalled,
				lastActive: h?.uninstalled ?? h?.lastInstalled,
				uninstalled: h?.uninstalled,
				estimated: h?.estimated,
				installCount: h?.installCount,
				currentlyInstalled: h?.currentlyInstalled,
				note: e.note,
			};
		});
		renderJournalTable(body, rows, {
			onOpen: (id) => this.host.openPlugin(id),
			t: this.host.t,
		});
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}
}
