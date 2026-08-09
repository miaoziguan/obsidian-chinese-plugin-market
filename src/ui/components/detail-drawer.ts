/**
 * 插件详情内联抽屉面板（Drawer，替代 Modal）。
 * 从 detail-modal.ts 架构迁移，不继承 Modal，而是作为视图内的绝对定位覆盖层。
 *
 * 特性：
 * - 右侧滑入动画（transform + opacity 过渡）
 * - Escape 关闭 + 点击遮罩关闭
 * - 与对比模式互斥（ Drawer 打开时禁止进入对比模式）
 * - 浏览历史栈（相似推荐跳转后可后退）
 * - 关闭后恢复焦点到触发卡片
 *
 * 数据获取全部通过回调委托给 main.ts（Drawer 不直接访问 plugins 列表）。
 */

import {
	App,
	Component,
	MarkdownRenderer,
	requestUrl,
	Notice,
} from "obsidian";
import { isMobileEnvironment, requestIdle } from "@shared/platform";
import type { PluginInfo, TranslateResult, Translator } from "@domain/catalog/translator";
import type { ChinesePluginMarketSettings } from "@ui/view/translator-view";
import { makeT, type I18nKey } from "@shared/i18n";
import { cleanChineseSpaces } from "@shared/utils";
import { formatDownloads, formatUpdated } from "@domain/catalog/stats";
import { buildReadmeUrl, classifyNetworkError } from "@domain/catalog/mirror";
import type { SimilarCandidate } from "@domain/recommend/similar";
import { asAppInternals } from "@data/platform/obsidian-internals";
import { openInsightModal } from "@ui/view/view-cards";
import { isMacOS, macosSystemTranslate, protectMarkdown, restoreMarkdown } from "@translation/platform/macos-shortcuts";
import { appendSVG, appendIconText, toHTMLElement } from "@ui/dom/dom";

/**
 * Drawer 宿主插件的最小端口（P2-2 收尾：切断对 plugin 完整形状的依赖）。
 * Drawer 实际只消费 settings（收藏/镜像源）与 translator（AI 能力/LLM）。
 */
export interface DrawerHostPlugin {
	settings: ChinesePluginMarketSettings;
	translator: Translator;
	/** 立即（带防抖）持久化 translator 数据（洞察缓存落盘） */
	saveTranslatorData: () => void;
	/**
	 * TM 回灌就绪信号：vault 翻译记忆笔记灌入 translator.tmApproved 后 resolve。
	 * 首屏 mergeOffline 前必须 await，否则命中不到已采纳译名。
	 */
	tmApprovedReady: Promise<void>;
	/** TM 回灌实时进度（阶段 + 当前/总数），供加载页展示动态。 */
	tmProgress: {
		phase: "resolving" | "scanning" | "indexing" | "merging" | "done";
		current: number;
		total: number;
	} | null;
}

export interface DrawerOptions {
	app: App;
	plugin: DrawerHostPlugin;
	info: PluginInfo;
	result: TranslateResult | undefined;
	similar: SimilarCandidate[];
	triggerCard: HTMLElement | null;
	/** 打开新插件的详情（由 main.ts 处理 Drawer 生命周期管理） */
	openDetail: (pluginId: string) => void;
	toggleFavorite: (pluginId: string) => boolean;
	/** 已安装插件 id 集合（用于推荐卡片显示安装状态） */
	installedIds?: Set<string>;
	/** Drawer 挂载的容器（视图 contentEl） */
	container: HTMLElement;
	/** Drawer 关闭回调（通知视图清理状态） */
	onClose: () => void;
	/**
	 * 渲染模式：
	 * - "overlay"（默认）：作为浮层滑入，带遮罩，宿主在主视图容器内；
	 * - "page"：作为独立工作区页面铺满宿主（leaf 的 contentEl），无遮罩、无滑入动画。
	 */
	mode?: "overlay" | "page";
	/**
	 * 相似推荐延迟回填（打开丝滑优化）：
	 * true 时首帧渲染骨架占位，宿主在绘制后调用 setSimilar 回填，
	 * 避免打开点击帧被上千候选的相似度打分阻塞。
	 */
	deferSimilar?: boolean;
}

export class PluginDetailDrawer {
	private container: HTMLElement;
	private app: App;
	private plugin: DrawerHostPlugin;
	private info: PluginInfo;
	private result: TranslateResult | undefined;
	private similar: SimilarCandidate[];
	private triggerCard: HTMLElement | null;
	private openDetail: (pluginId: string) => void;
	private toggleFavorite: (pluginId: string) => boolean;
	private installedIds: Set<string>;
	private onCloseCb: () => void;

	/** 浏览历史栈（Drawer 内部就地跳转，无需关闭重建） */
	private _history: Array<{ info: PluginInfo; result: TranslateResult | undefined; similar: SimilarCandidate[] }> = [];

	/**
	 * 相似推荐是否仍在计算中（打开丝滑优化）：
	 * computeSimilar 对热门分类可能要对上千候选打分，同步跑会阻塞打开动画帧。
	 * 现在打开时先渲染骨架，宿主在首帧绘制后调用 setSimilar 回填。
	 */
	private _similarPending = false;
	/** 相似推荐区容器（setSimilar 回填用） */
	private similarWrapEl: HTMLElement | null = null;
	/** 详情页 README 原文 Markdown（供「系统翻译」按需翻译） */
	private readmeRaw: string | null = null;
	/** README 是否已替换为系统翻译 */
	private readmeTranslated = false;
	/** README 渲染容器（点击「返回原文」/「系统翻译」时就地重渲染） */
	private readmeBodyEl: HTMLElement | null = null;
	/** README 标题行内的系统翻译切换按钮（仅 macOS 渲染，常驻以便随时切回原文） */
	private readmeSysBtnEl: HTMLButtonElement | null = null;

	/** 内部组件（清理用） */
	private renderComp: Component | null = null;
	private drawerEl: HTMLElement | null = null;
	private backdropEl: HTMLElement | null = null;
	private mode: "overlay" | "page" = "overlay";

	/** DOM 事件清理 */
	private _boundKeydown: (e: KeyboardEvent) => void;
	private _boundBackdropClick: (e: MouseEvent) => void;
	private _cleanupFns: (() => void)[] = [];

	private readonly t: (key: I18nKey) => string = makeT();

	constructor(opts: DrawerOptions) {
		this.app = opts.app;
		this.plugin = opts.plugin;
		this.info = opts.info;
		this.result = opts.result;
		this.similar = opts.similar;
		this.triggerCard = opts.triggerCard;
		this.openDetail = opts.openDetail;
		this.toggleFavorite = opts.toggleFavorite;
		this.installedIds = opts.installedIds ?? new Set();
		this.container = opts.container;
		this.onCloseCb = opts.onClose;
		this.mode = opts.mode ?? "overlay";
		this._similarPending = opts.deferSimilar === true;

		this._boundKeydown = this.onKeydown.bind(this);
		this._boundBackdropClick = this.onBackdropClick.bind(this);
	}

	/** 当前展示的插件 id（宿主延迟回填相似推荐时校验用，防快速跳转错填） */
	get currentPluginId(): string {
		return this.info.id;
	}

	/** 打开 Drawer */
	open() {
		this.render();
	}

	/** 仅释放资源（监听器等），不触发 onCloseCb，供宿主视图卸载时调用 */
	dispose() {
		this.renderComp?.unload();
		this.renderComp = null;
		this._cleanupFns.forEach((fn) => fn());
		this._cleanupFns = [];
	}

	/** 关闭 Drawer 并清理 */
	close() {
		// ── 关闭丝滑优化 ──
		// README 渲染出的大 DOM 树（可达数千节点）同步 remove + unload 会阻塞关闭帧。
		// 先瞬时隐藏（display:none 极廉价，用户立即看到关闭），真正的卸载推迟到空闲帧。
		const drawerEl = this.drawerEl;
		const backdropEl = this.backdropEl;
		const renderComp = this.renderComp;
		this.renderComp = null;
		this.drawerEl = null;
		this.backdropEl = null;
		this.similarWrapEl = null;
		if (drawerEl) drawerEl.setCssStyles({ display: "none" });
		if (backdropEl) backdropEl.setCssStyles({ display: "none" });

		// 清理事件（必须同步，避免残留全局 keydown）
		this._cleanupFns.forEach((fn) => fn());
		this._cleanupFns = [];

		// 清空浏览历史
		this._history = [];

		// 恢复焦点（L3：抽屉打开期间列表可能重渲，原卡片或已回收离场；
		// 对已脱离文档的节点 focus 是无声空操作且留下悬挂焦点，故先校验仍在 DOM 中。
		// 卡片已被回收时，按插件 id 找回重渲后的新卡片作焦点兜底，键盘用户不掉回 body）
		if (this.triggerCard?.isConnected) {
			this.triggerCard.focus();
		} else if (this.triggerCard) {
			const pid = this.triggerCard.getAttribute("data-plugin-id");
			const fallback = pid
				? toHTMLElement(document.querySelector(`.pt-card[data-plugin-id="${pid}"]`))
				: null;
			fallback?.focus();
		}

		// 通知视图 Drawer 已关闭（列表恢复）
		this.onCloseCb?.();

		// 空闲帧再做真正的重活：组件卸载 + 大 DOM 移除
		const teardown = () => {
			renderComp?.unload();
			drawerEl?.remove();
			backdropEl?.remove();
		};
		requestIdle(teardown, 1000);
	}

	/**
	 * #5: 移动端右滑关闭手势绑定。
	 * drawerEl 上监听 touchstart/move/end：记录起点与按下时刻，move 时按右移量跟手平移
	 * （左移忽略，保持原位），松手时若 deltaX > 100px 且平均速度 > 0.3px/ms（约 300px/s）
	 * 判定为「甩动关闭」调用 this.close()；否则回弹到原位。translate 用 transform 动画过渡，
	 * 跟手阶段临时关闭过渡以求跟手，松手判定阶段再开回过渡做动画。
	 */
	private bindSwipeClose(el: HTMLElement) {
		let startX = 0;
		let startY = 0;
		let startT = 0;
		let tracking = false;

		const onStart = (e: TouchEvent) => {
			if (e.touches.length !== 1) return;
			tracking = true;
			startX = e.touches[0].clientX;
			startY = e.touches[0].clientY;
			startT = performance.now();
			el.setCssStyles({ transition: "none" });
		};
		const onMove = (e: TouchEvent) => {
			if (!tracking || e.touches.length !== 1) return;
			const dx = e.touches[0].clientX - startX;
			const dy = e.touches[0].clientY - startY;
			// 纵向滑动优先（用户可能在滚详情内容）：纵向位移明显大于横向时不拦截
			if (Math.abs(dy) > Math.abs(dx) * 1.5) return;
			// 仅允许右移跟手；左移（往屏幕里推）保持原位
			const shift = Math.max(0, dx);
			el.setCssStyles({ transform: `translateX(${shift}px)` });
		};
		const finish = (e: TouchEvent) => {
			if (!tracking) return;
			tracking = false;
			const lastX = e.changedTouches[0].clientX;
			const lastT = performance.now();
			const dx = lastX - startX;
			const dt = Math.max(1, lastT - startT);
			const v = dx / dt; // px/ms
			el.setCssStyles({ transition: "" });
			if (dx > 100 && v > 0.3) {
				// 滑出动画后关闭
				el.setCssStyles({ transform: "translateX(100%)" });
				window.setTimeout(() => this.close(), 180);
			} else {
				// 回弹原位
				el.setCssStyles({ transform: "" });
			}
		};

		el.addEventListener("touchstart", onStart, { passive: true });
		el.addEventListener("touchmove", onMove, { passive: true });
		el.addEventListener("touchend", finish, { passive: true });
		this._cleanupFns.push(() => {
			el.removeEventListener("touchstart", onStart);
			el.removeEventListener("touchmove", onMove);
			el.removeEventListener("touchend", finish);
		});
	}

	/** 就地跳转到新插件（不关闭 Drawer，替换内容 + 压入历史栈） */
	navigate(_pluginId: string, newInfo: PluginInfo, newResult: TranslateResult | undefined, newSimilar: SimilarCandidate[]) {
		// 保存当前到历史栈
		this._history.push({ info: this.info, result: this.result, similar: this.similar });
		// 释放旧 README
		this.renderComp?.unload();
		this.renderComp = null;
		// 更新数据
		this.info = newInfo;
		this.result = newResult;
		this.similar = newSimilar;
		// 跳转时宿主同样延迟计算相似推荐（setSimilar 回填），先展示骨架
		this._similarPending = true;
		// 重建内容区
		this.buildContent();
	}

	/**
	 * 回填相似推荐（打开丝滑优化）。
	 * 宿主在首帧绘制后（rAF）才计算 computeSimilar，避免打开点击帧被
	 * 上千候选打分阻塞。若 Drawer 已关闭或内容已切换则安全忽略。
	 */
	setSimilar(similar: SimilarCandidate[]) {
		this.similar = similar;
		this._similarPending = false;
		const wrap = this.similarWrapEl;
		if (!wrap || !this.drawerEl) return;
		// 清掉骨架占位，保留区块标题
		wrap.querySelector(".pt-detail-similar-skeleton")?.remove();
		this.renderSimilarPanelInto(wrap);
	}

	/**
	 * 详情页「🍎 系统翻译」按钮：按需调用 macOS 快捷指令把当前插件的 README 原文
	 * Markdown 整篇翻译成中文，就地替换 README 区渲染，并在区尾追加「返回原文」标识
	 * （不与自动翻译链耦合；再次点击可在译文/原文间切换）。
	 */
	private async sysTranslate(btn: HTMLElement): Promise<void> {
		if (!this.drawerEl || btn.classList.contains("pt-detail-btn--loading")) return;
		if (!this.readmeBodyEl) {
			new Notice(this.t("card.sysTranslate.fail"));
			return;
		}
		// 已翻译 → 切回原文；否则 → 翻译
		if (this.readmeTranslated && this.readmeRaw) {
			this.readmeTranslated = false;
			this.renderReadme(this.readmeBodyEl, this.readmeRaw, this.info.repo ?? "");
			this.updateSysTranslateBtn();
			return;
		}
		if (!this.readmeRaw) {
			new Notice(this.t("detail.readme.loading"));
			return;
		}
		const repo = this.info.repo ?? "";
		// 只改 label span 的文本，避免 textContent 赋值抹掉按钮内的图标等子元素
		const labelEl = btn.querySelector<HTMLElement>(".pt-detail-btn-label") ?? btn;
		// 记录发起翻译时的插件，await 期间抽屉可能已被关闭或切换到其它插件
		const reqPluginId = this.info.id;
		btn.classList.add("pt-detail-btn--loading");
		btn.setAttribute("aria-busy", "true");
		btn.setAttribute("disabled", "true"); // 翻译中禁用，防止重复点击导致更慢/更易失败
		const setProgress = (done: number, total: number) => {
			labelEl.textContent = `翻译中 ${done}/${total}…`;
		};
		let failed = 0;
		try {
			// 方案 A：先把代码块/URL/表格行等结构占位保护，翻译后还原，避免系统翻译破坏格式
			const { text: protectedMd, blocks } = protectMarkdown(this.readmeRaw);
			const translated = await macosSystemTranslate(protectedMd, setProgress, (f) => (failed = f));
			// 抽屉已关闭或已切到别的插件：丢弃这次结果，否则会把 A 的译文写进 B 的 README
			if (!this.drawerEl || this.info.id !== reqPluginId || !this.readmeBodyEl) return;
			if (!translated) {
				new Notice(this.t("card.sysTranslate.fail"));
				return;
			}
			const restored = restoreMarkdown(translated, blocks);
			this.readmeTranslated = true;
			this.renderReadme(this.readmeBodyEl, restored, repo);
			this.updateSysTranslateBtn();
			// 部分失败：明确告知用户已翻译/失败段数，而非笼统「失败」
			if (failed > 0) {
				new Notice(this.t("card.sysTranslate.partial").replace("{n}", String(failed)));
			} else {
				new Notice(this.t("card.sysTranslate.done"));
			}
		} catch {
			new Notice(this.t("card.sysTranslate.fail"));
		} finally {
			btn.classList.remove("pt-detail-btn--loading");
			btn.removeAttribute("aria-busy");
			btn.removeAttribute("disabled");
			// 恢复按钮文案为当前状态对应文案（已译→「返回原文」，未译→「系统翻译」）
			this.updateSysTranslateBtn();
		}
	}

	/** 根据 readmeTranslated 状态刷新 README 标题行的系统翻译按钮文案，状态自明 */
	private updateSysTranslateBtn() {
		const btn = this.readmeSysBtnEl;
		if (!btn) return;
		btn.textContent = this.readmeTranslated
			? this.t("detail.readme.backOriginal")
			: this.t("card.sysTranslate.readme");
	}

	private render() {
		const overlay = this.mode === "overlay";

		// 遮罩层（仅浮层模式）
		if (overlay) {
			this.backdropEl = this.container.createDiv({ cls: "pt-drawer-backdrop" });
		}

		// Drawer 主体
		this.drawerEl = this.container.createDiv({ cls: "pt-drawer" });
		this.drawerEl.setAttribute("role", "dialog");
		this.drawerEl.setAttribute("aria-modal", "true");
		this.drawerEl.setAttribute("aria-label", this.info.name);

		// 事件绑定
		document.addEventListener("keydown", this._boundKeydown);
		this._cleanupFns.push(() => document.removeEventListener("keydown", this._boundKeydown));

		if (overlay) {
			this.backdropEl?.addEventListener("click", this._boundBackdropClick);
			this._cleanupFns.push(() => this.backdropEl?.removeEventListener("click", this._boundBackdropClick));
		}

		// #5: 移动端右滑关闭手势（仅浮层模式 + 移动端）。
		// 监听 drawerEl 的 touch 系列事件：记录起点，move 时实时跟手平移，
		// 松手时若右移超过 100px 且速度够快则关闭（参考 Obsidian 原生抽屉交互）。
		if (overlay && isMobileEnvironment() && this.drawerEl) {
			this.bindSwipeClose(this.drawerEl);
		}

		// 构建内容
		this.buildContent();

		// 触发 reflow 后添加打开动画（仅浮层模式；页面模式由 CSS 直接铺满）
		if (overlay) {
			void this.backdropEl?.offsetHeight;
			this.backdropEl?.classList.add("pt-drawer-backdrop--open");
			this.drawerEl?.classList.add("pt-drawer--open");
		}

		// 聚焦到关闭按钮
		window.requestAnimationFrame(() => {
			const closeBtn = this.drawerEl?.querySelector(".pt-drawer-close");
			if (closeBtn) (closeBtn as HTMLElement).focus();
		});
	}

	private buildContent() {
		if (!this.drawerEl) return;
		this.drawerEl.empty();

		const p = this.info;
		const displayName = cleanChineseSpaces(this.result?.translatedName || p.name);

		// ── 滚动容器（承载 max-width 内容） ──
		const scroll = this.drawerEl.createDiv({ cls: "pt-detail-page-scroll" });
		const inner = scroll.createDiv({ cls: "pt-detail-page-inner" });

		// ── 头部：关闭按钮 + 标题 + back ──
		const head = inner.createDiv({ cls: "pt-drawer-head" });
		const headLeft = head.createDiv({ cls: "pt-drawer-head-left" });

		// 后退按钮（从相似推荐跳转后可用）
		if (this._history.length > 0) {
			const backBtn = headLeft.createEl("button", {
				cls: "pt-drawer-back",
				text: `← ${this.t("detail.back")}`,
			});
			backBtn.addEventListener("click", () => {
				const prev = this._history.pop();
				if (!prev) return;
				this.renderComp?.unload();
				this.renderComp = null;
				this.info = prev.info;
				this.result = prev.result;
				this.similar = prev.similar;
				// 历史栈里的 similar 是已算好的快照，直接渲染无需骨架
				this._similarPending = false;
				this.buildContent();
			});
		}

		const titleBlock = headLeft.createDiv({ cls: "pt-drawer-title-block" });
		titleBlock.createDiv({ cls: "pt-drawer-title", text: displayName });
		if (displayName !== p.name) {
			titleBlock.createDiv({ cls: "pt-drawer-subtitle", text: p.name });
		}

		const closeBtn = head.createEl("button", {
			cls: "pt-drawer-close",
			attr: { "aria-label": this.t("detail.drawer.close"), type: "button" },
		});
		appendSVG(closeBtn, `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`);
		closeBtn.addEventListener("click", () => this.close());

		// ── 正文主栏（元数据/描述/操作/README）：窄屏单栏，宽屏与右栏并排 ──
		const main = inner.createDiv({ cls: "pt-detail-main" });

		// ── 元数据区（图标 + 标签 + 值） ──
		const meta = main.createDiv({ cls: "pt-detail-meta" });
		const iconAuthor = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
		const iconId = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
		const iconDownload = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
		const iconClock = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
		const iconStatus = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
		const iconStatusOff = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`;

		const addMeta = (labelKey: I18nKey, value: string, icon: string) => {
			if (!value) return;
			const row = meta.createDiv({ cls: "pt-detail-meta-row" });
			appendSVG(row.createSpan({ cls: "pt-detail-meta-icon" }), icon);
			row.createSpan({ cls: "pt-detail-meta-label", text: this.t(labelKey) });
			row.createSpan({ cls: "pt-detail-meta-value", text: value });
		};
		addMeta("detail.author", p.author, iconAuthor);
		addMeta("detail.id", p.id, iconId);
		if (p.downloads != null) addMeta("detail.downloads", formatDownloads(p.downloads), iconDownload);
		if (p.updated != null) {
			const u = formatUpdated(p.updated);
			if (u) addMeta("detail.updated", u, iconClock);
		}
		if (this.plugin.settings && p.id) {
			try {
				const plugins = asAppInternals(this.app).plugins;
				if (plugins?.manifests?.[p.id]) {
					const enabled = plugins.enabledPlugins?.has?.(p.id);
					addMeta("detail.status", enabled ? this.t("card.installed.on") : this.t("card.installed.off"),
						enabled ? iconStatus : iconStatusOff);
				}
			} catch { /* 半官方 API，容错忽略 */ }
		}

		// ── 描述（含来源信息 chip） ──
		const descSection = main.createDiv({ cls: "pt-detail-desc-section" });
		const desc = cleanChineseSpaces(this.result?.translatedDesc || p.description);
		if (desc) {
			descSection.createDiv({ cls: "pt-detail-desc", text: desc });
		}

		// ── 操作按钮 ──
		const actions = main.createDiv({ cls: "pt-detail-actions" });

		// 安装状态：区分未安装 / 已安装(未启用) / 已启用
		let isInstalled = false;
		let isEnabled = false;
		try {
			const plugins = asAppInternals(this.app).plugins;
			if (plugins?.manifests?.[p.id]) {
				isInstalled = true;
				isEnabled = plugins.enabledPlugins?.has?.(p.id) ?? false;
			}
		} catch { /* 半官方 API，容错忽略 */ }

		if (isEnabled) {
			actions.createSpan({
				cls: "pt-detail-btn pt-detail-btn--enabled",
				text: `✓ ${this.t("card.installed.on")}`,
			});
		} else if (isInstalled) {
			const enableBtn = actions.createEl("a", {
				cls: "pt-detail-btn",
				text: this.t("card.installed.off"),
				attr: {
					href: `obsidian://show-plugin?id=${p.id}`,
					rel: "noopener noreferrer",
					title: this.t("card.enable"),
				},
			});
			enableBtn.addEventListener("click", () => {
				new Notice(this.t("notice.market.opened"));
			});
		} else {
			const installBtn = actions.createEl("a", {
				cls: "pt-detail-btn mod-cta",
				text: this.t("card.install"),
				attr: { href: `obsidian://show-plugin?id=${p.id}`, rel: "noopener noreferrer" },
			});
			installBtn.addEventListener("click", () => {
				new Notice(this.t("notice.market.opened"));
			});
		}

		// 仓库
		if (p.repo) {
			const repoSvg = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg>`;
			const repoBtn = actions.createEl("a", {
				cls: "pt-detail-btn",
				attr: {
					href: `https://github.com/${p.repo}`,
					target: "_blank",
					rel: "noopener noreferrer",
				},
			});
			appendIconText(repoBtn, repoSvg, this.t("card.repo"));
		}

		// 收藏切换
		const favBtn = actions.createEl("button", { cls: "pt-detail-btn" });
		const updateFavIcon = (isOn: boolean) => {
			favBtn.empty();
			appendIconText(favBtn, isOn
				? `<svg viewBox="0 0 24 24" width="14" height="14" fill="#d99a1c" stroke="#d99a1c" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`
				: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`, this.t("card.favorite"));
		};
		updateFavIcon(this.plugin.settings.favorites.includes(p.id));
		favBtn.addEventListener("click", () => {
			const isFav = this.toggleFavorite(p.id);
			updateFavIcon(isFav);
		});

		// 复制 ID
		const copyBtn = actions.createEl("button", {
			cls: "pt-detail-btn",
		});
		appendIconText(copyBtn, `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`, this.t("card.copy"));
		const copyBtnEl = copyBtn as HTMLElement & { _restoreTimer?: number };
		copyBtn.addEventListener("click", () => {
			navigator.clipboard?.writeText(p.id).catch(() => {
				new Notice(this.t("card.copy.fail"));
			});
			copyBtn.empty();
			appendIconText(copyBtn, `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="var(--pt-color-success)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`, this.t("card.copy.done"));
			const prevTimer = copyBtnEl._restoreTimer;
			if (prevTimer) window.clearTimeout(prevTimer);
			copyBtnEl._restoreTimer = window.setTimeout(() => {
				updateCopyBtnContent();
				copyBtnEl._restoreTimer = undefined;
			}, 1200);
			// 抽屉关闭/重建内容时清理定时器，避免对已 detach 按钮闭包执行写入（#30 B：资源/状态泄漏）
			this._cleanupFns.push(() => {
				if (copyBtnEl._restoreTimer !== undefined) {
					window.clearTimeout(copyBtnEl._restoreTimer);
					copyBtnEl._restoreTimer = undefined;
				}
			});
		});
		const updateCopyBtnContent = () => {
			copyBtn.empty();
			appendIconText(copyBtn, `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`, this.t("card.copy"));
		};

		// ── README 区（懒加载） ──
		const readmeWrap = main.createDiv({ cls: "pt-detail-readme" });
		const readmeHeader = readmeWrap.createDiv({ cls: "pt-detail-section-head" });
		readmeHeader.createSpan({ cls: "pt-detail-section-dot" });
		readmeHeader.createSpan({
			cls: "pt-detail-readme-title",
			text: this.t("detail.readme"),
		});

		// 「了解功能」按钮（替代「翻译 README」：基于仓库 manifest 元数据让 AI 概述，不读 README）
		const insightBtn = readmeHeader.createEl("button", {
			cls: "pt-detail-btn pt-detail-btn--insight",
			text: this.t("detail.insight"),
		});
		insightBtn.addEventListener("click", () => {
			const hostPlugin = this.plugin;
			openInsightModal(
				{
					app: this.app,
					translator: hostPlugin.translator,
					t: this.t,
					mirrorConfig: () => ({
						source: hostPlugin.settings.mirrorSource,
						customBase: hostPlugin.settings.mirrorCustomBase,
					}),
					saveTranslatorData: () => hostPlugin.saveTranslatorData(),
				},
				this.info
			);
		});

		// 「系统翻译 README」切换按钮（仅 macOS 桌面端，且与「了解功能」并排常驻于 README 标题行，
		// 控制的是下方 README 区，空间邻近；状态自明：未译显示「🍎 翻译」、已译显示「↩ 返回原文」）
		if (isMacOS()) {
			const sysBtn = readmeHeader.createEl("button", {
				cls: "pt-detail-btn pt-detail-btn--sys-translate",
			});
			this.readmeSysBtnEl = sysBtn;
			sysBtn.textContent = this.t("card.sysTranslate.readme");
			this.updateSysTranslateBtn();
			sysBtn.addEventListener("click", () => {
				void this.sysTranslate(sysBtn);
			});
		}

		const readmeBody = readmeWrap.createDiv({ cls: "pt-detail-readme-body" });
		this.readmeBodyEl = readmeBody;
		void this.loadReadme(readmeBody);

		// ── 相似推荐面板（宽屏右侧栏 / 窄屏底部区块） ──
		const similarWrap = inner.createDiv({ cls: "pt-detail-similar pt-detail-similar-rail" });
		this.similarWrapEl = similarWrap;
		const similarHeader = similarWrap.createDiv({ cls: "pt-detail-section-head" });
		similarHeader.createSpan({ cls: "pt-detail-section-dot" });
		similarHeader.createSpan({
			cls: "pt-detail-similar-title",
			text: this.t("detail.similar"),
		});
		if (this._similarPending) {
			// 计算尚未完成：渲染轻量骨架占位，宿主稍后 setSimilar 回填
			const sk = similarWrap.createDiv({ cls: "pt-detail-similar-skeleton" });
			for (let i = 0; i < 3; i++) sk.createDiv({ cls: "pt-detail-similar-skeleton-card" });
		} else {
			this.renderSimilarPanelInto(similarWrap);
		}
	}

	private renderSimilarPanelInto(parent: HTMLElement) {
		const t = this.t;

		if (this.similar.length === 0) {
			parent.createDiv({
				cls: "pt-detail-similar-empty",
				text: t("detail.similar.none"),
			});
			return;
		}

		// 面板级引导语：降低用户信任门槛
		parent.createDiv({
			cls: "pt-detail-similar-hint",
			text: t("detail.similar.hint"),
		});

		for (const sim of this.similar) {
			const card = parent.createDiv({
				cls: "pt-detail-similar-card",
				attr: { tabindex: "0", role: "button", "aria-label": sim.translatedName },
			});

		// 行1：译名（+ 已安装 tag）
		const row = card.createDiv({ cls: "pt-detail-similar-card-row" });
		row.createSpan({ cls: "pt-detail-similar-name", text: sim.translatedName });

			// 已安装标签（绿色小 tag，紧跟译名后）
			if (this.installedIds.has(sim.id)) {
				row.createSpan({
					cls: "pt-detail-similar-installed-tag",
					text: t("detail.similar.installed"),
				});
			}

			// 行2：原名
			if (sim.translatedName !== sim.name) {
				card.createDiv({ cls: "pt-detail-similar-original", text: sim.name });
			}

			// 行3：推荐理由
			if (sim.reason) {
				card.createDiv({ cls: "pt-detail-similar-reason", text: sim.reason });
			}

			// 行4：下载量
			if (sim.downloads != null) {
				const dl = card.createDiv({ cls: "pt-detail-similar-meta" });
				dl.textContent = `↓ ${formatDownloads(sim.downloads)}`;
			}

			// 键盘可点击
			const openDetail = () => this.openDetail(sim.id);
			card.addEventListener("click", openDetail);
			card.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					openDetail();
				}
			});
		}
	}

	private async loadReadme(container: HTMLElement) {
		if (!this.drawerEl) return; // 抽屉已关闭，不再渲染避免 Component 泄漏
		const p = this.info;
		this.readmeRaw = null;
		this.readmeTranslated = false;
		if (!p.repo) {
			container.createDiv({
				cls: "pt-detail-readme-empty",
				text: this.t("detail.readme.noRepo"),
			});
			return;
		}
		const url = buildReadmeUrl(p.repo, {
			source: this.plugin.settings.mirrorSource,
			customBase: this.plugin.settings.mirrorCustomBase,
		});
		if (!url) {
			container.createDiv({
				cls: "pt-detail-readme-empty",
				text: this.t("detail.readme.noUrl"),
			});
			return;
		}

		const loading = container.createDiv({
			cls: "pt-detail-readme-loading",
			text: this.t("detail.readme.loading"),
		});
		try {
			const resp = await requestUrl({ url, method: "GET" });
			// 抽屉已关闭或已切到别的插件：丢弃这次响应，否则会污染当前插件的 README 与后续「系统翻译」源文本
			if (!this.drawerEl || this.info.id !== p.id) return;
			const md = resp.text || "";
			loading.remove();
			if (!md.trim()) {
				container.createDiv({
					cls: "pt-detail-readme-empty",
					text: this.t("detail.readme.empty"),
				});
				return;
			}
			// 完整 README 不截断：整篇交给「系统翻译」分段翻译（macosSystemTranslate 内部拆批）
			this.readmeRaw = md;
			this.readmeTranslated = false;
			this.renderReadme(container, md, p.repo);
		} catch (e: unknown) {
			if (!this.drawerEl) return; // 已关闭，跳过错误渲染
			loading.remove();
			const info = classifyNetworkError(e);
			const box = container.createDiv({ cls: "pt-detail-readme-error" });
			// 被墙/访问受限时明确提示切换镜像源（国内用户最常见场景）
			const hint = info.suggestMirror
				? `${this.t("error.title")} README：${info.message}（当前直连 GitHub 受限，可在设置中切换镜像源后重试）`
				: `${this.t("error.title")} README：${info.message}`;
			box.createDiv({
				cls: "pt-detail-readme-empty",
				text: hint,
			});
			// 操作区：重试 +（受限时）跳转设置切换镜像源，避免用户面对错误无路可走
			const actions = box.createDiv({ cls: "pt-detail-readme-error-actions" });
			const retryBtn = actions.createEl("button", {
				cls: "pt-detail-btn",
				text: this.t("error.retry"),
			});
			retryBtn.addEventListener("click", () => {
				box.remove();
				void this.loadReadme(container);
			});
			if (p.repo) {
				actions.createEl("a", {
					cls: "pt-detail-btn",
					text: this.t("card.repo"),
					attr: {
						href: `https://github.com/${p.repo}`,
						target: "_blank",
						rel: "noopener noreferrer",
					},
				});
			}
			const mirrorBtn = actions.createEl("button", {
				cls: "pt-detail-btn",
				text: this.t("error.mirror"),
			});
			mirrorBtn.addEventListener("click", () => {
				const setting = asAppInternals(this.app).setting;
				setting?.open?.();
			});
		}
	}

	/**
	 * 把 README 的 Markdown 渲染进容器（复用统一的 MarkdownRenderer + 链接前缀）。
	 * 翻译态下在区尾追加「返回原文」标识，点击切回英文原文。
	 */
	private renderReadme(container: HTMLElement, md: string, repo: string) {
		container.empty();
		this.renderComp?.unload();
		this.renderComp = new Component();
		void MarkdownRenderer.render(
			this.app,
			md,
			container,
			`https://github.com/${repo}/blob/HEAD/`,
			this.renderComp
		);
	}

	/** 切换回原文 / 翻译 */
	private onKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") {
			this.close();
			return;
		}
		// Tab trap：将焦点限制在 Drawer 内循环（WAI-ARIA dialog 规范）
		if (e.key === "Tab" && this.drawerEl) {
			const focusable = this.drawerEl.querySelectorAll<HTMLElement>(
				'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
			);
			if (focusable.length === 0) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (e.shiftKey) {
				if (document.activeElement === first) {
					e.preventDefault();
					last.focus();
				}
			} else {
				if (document.activeElement === last) {
					e.preventDefault();
					first.focus();
				}
			}
		}
	}

	private onBackdropClick(e: MouseEvent) {
		if (e.target === this.backdropEl) {
			this.close();
		}
	}
}
