/**
 * 版本选择弹窗（BRAT 式版本固定）。
 *
 * 交互：
 * - 首行「保持最新（自动更新）」——解除固定，跟随仓库最新版本；
 * - 其后为该仓库的 Release/Tag 列表（新 → 旧），当前已固定项高亮；
 * - 点任意一行即写入固定表并按该 tag 重装（调用方 onPick 负责落盘 + 安装）。
 *
 * 版本列表通过 listVersions 注入（走 data/platform/plugin-versions，带 10 分钟缓存），
 * 弹窗本身只负责渲染与交互，便于复用与测试。
 */

import { Modal, Notice, setIcon, type App } from "obsidian";
import { pickLang } from "@shared/i18n";
import { logger } from "@shared/logger";
import type { PluginVersion } from "@data/platform/plugin-versions";

export interface VersionPickerOptions {
	app: App;
	/** 插件显示名（弹窗标题） */
	pluginName: string;
	/** 插件仓库 owner/name */
	repo: string;
	/** 当前已固定版本（null = 保持最新） */
	pinned: string | null;
	/** 当前已安装版本（用于「当前」标记） */
	installedVersion?: string;
	/** 拉取版本列表（新 → 旧） */
	listVersions: (repo: string, force?: boolean) => Promise<PluginVersion[]>;
	/** 选定后回调：version=null 表示「保持最新」 */
	onPick: (version: string | null) => Promise<void>;
}

/** 日期 ISO → YYYY-MM-DD（无日期返回空串） */
function formatDate(iso?: string): string {
	if (!iso) return "";
	const d = iso.slice(0, 10);
	return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : "";
}

export class VersionPickerModal extends Modal {
	private listEl: HTMLElement | null = null;
	private busy = false;

	constructor(
		app: App,
		private readonly opts: VersionPickerOptions,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("pt-version-modal");

		const head = contentEl.createDiv({ cls: "pt-version-head" });
		head.createEl("h3", {
			cls: "pt-version-title",
			text: pickLang("version.title", { name: this.opts.pluginName }),
		});
		const refreshBtn = head.createEl("button", {
			cls: "pt-version-refresh clickable-icon",
			attr: { type: "button", "aria-label": pickLang("version.refresh"), title: pickLang("version.refresh") },
		});
		setIcon(refreshBtn, "refresh-cw");
		refreshBtn.addEventListener("click", () => {
			void this.load(true);
		});

		this.listEl = contentEl.createDiv({ cls: "pt-version-list" });
		void this.load(false);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private renderLoading(): void {
		const el = this.listEl;
		if (!el) return;
		el.empty();
		el.createDiv({ cls: "pt-version-loading", text: pickLang("version.loading") });
	}

	private renderError(msg: string): void {
		const el = this.listEl;
		if (!el) return;
		el.empty();
		el.createDiv({ cls: "pt-version-error", text: pickLang("version.fail", { msg }) });
	}

	private renderEmpty(): void {
		const el = this.listEl;
		if (!el) return;
		el.empty();
		const empty = el.createDiv({ cls: "pt-version-empty" });
		empty.createDiv({ cls: "pt-version-empty-title", text: pickLang("version.empty") });
		empty.createDiv({ cls: "pt-version-empty-hint", text: pickLang("version.empty.hint") });
	}

	private async load(force: boolean): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.renderLoading();
		try {
			const versions = await this.opts.listVersions(this.opts.repo, force);
			if (versions.length === 0) {
				this.renderEmpty();
				return;
			}
			this.renderList(versions);
		} catch (e: unknown) {
			logger.warn("[Chinese Plugin Market] 版本列表加载失败：", e);
			this.renderError(e instanceof Error ? e.message : String(e));
		} finally {
			this.busy = false;
		}
	}

	private renderList(versions: PluginVersion[]): void {
		const el = this.listEl;
		if (!el) return;
		el.empty();
		const pinned = this.opts.pinned;

		// 「保持最新」行
		this.renderRow(el, {
			label: pickLang("version.latest"),
			hint: pickLang("version.latest.hint"),
			active: !pinned,
			meta: "",
			onClick: () => this.pick(null),
		});

		for (const v of versions) {
			const date = formatDate(v.publishedAt);
			const metaParts: string[] = [];
			if (date) metaParts.push(date);
			if (v.prerelease) metaParts.push("pre-release");
			if (this.opts.installedVersion && v.version === this.opts.installedVersion) {
				metaParts.push(pickLang("version.current"));
			}
			this.renderRow(el, {
				label: `v${v.version}`,
				hint: "",
				meta: metaParts.join(" · "),
				active: pinned === v.tag || pinned === v.version,
				onClick: () => this.pick(v.tag),
			});
		}
	}

	private renderRow(
		parent: HTMLElement,
		row: { label: string; hint: string; meta: string; active: boolean; onClick: () => void },
	): void {
		const btn = parent.createEl("button", {
			cls: "pt-version-row" + (row.active ? " is-active" : ""),
			attr: { type: "button" },
		});
		const dot = btn.createSpan({ cls: "pt-version-dot" });
		setIcon(dot, row.active ? "check" : "circle");
		const text = btn.createDiv({ cls: "pt-version-row-text" });
		text.createDiv({ cls: "pt-version-row-label", text: row.label });
		if (row.hint) text.createDiv({ cls: "pt-version-row-hint", text: row.hint });
		if (row.meta) btn.createSpan({ cls: "pt-version-row-meta", text: row.meta });
		btn.addEventListener("click", row.onClick);
	}

	private pick(version: string | null): void {
		if (this.busy) return;
		this.busy = true;
		void this.opts
			.onPick(version)
			.catch((e: unknown) => {
				new Notice(e instanceof Error ? e.message : String(e));
			})
			.finally(() => {
				this.busy = false;
				this.close();
			});
	}
}

/** 打开版本选择弹窗 */
export function openVersionPicker(opts: VersionPickerOptions): void {
	new VersionPickerModal(opts.app, opts).open();
}
