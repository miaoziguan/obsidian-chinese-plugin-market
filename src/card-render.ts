/**
 * 插件卡片渲染器（阶段五：卡片渲染下沉）。
 * 从 main.ts 的 createPluginCard 抽出，视图仅负责把上下文 ctx 注入并挂载结果，
 * 卡片 DOM 的构建逻辑集中于此，便于维护与（未来基于 jsdom 的）测试。
 *
 * 依赖 Obsidian 对 HTMLElement 的全局 DOM 扩展（createEl/appendText 等），
 * 该扩展随项目内其它文件 import "obsidian" 而在整个程序内生效。
 */

import { Notice } from "obsidian";
import type { PluginInfo, TranslateResult, AISearchResult } from "./translator";
import type { I18nKey } from "./i18n";
import { cleanChineseSpaces } from "./utils";
import { appendSVG } from "./dom";
import { isMacOS, macosSystemTranslate } from "./translate/macos-shortcuts";
import { formatDownloads, formatUpdated } from "./stats";
import type { SignalId } from "./smart-signal";

/** 离线信号 → 中文标签（无需 AI Key 即可展示） */
const SIGNAL_LABELS: Record<SignalId, string> = {
	top1: "Top 1%",
	top5: "Top 5%",
	hot10: "热门",
	recentActive: "近期活跃",
	velocityRising: "增速飙升",
};

/** 卡片渲染上下文（由视图注入，避免渲染器依赖视图实例） */
export interface CardRenderContext {
	/** i18n 取词函数 */
	t: (key: I18nKey) => string;
	/** 已安装插件 id 集合 */
	installedIds: Set<string>;
	/** 已启用插件 id 集合 */
	enabledIds: Set<string>;
	/** AI 搜索结果（含排序理由，可选） */
	aiSearchResult: AISearchResult | null;
	/** 选品对比：当前已选中的插件 id 集合（用于卡片初始高亮态） */
	compareSet?: Set<string>;
	/** 官方推荐：是否展示金色「推荐」角标 */
	isRecommended?: boolean;
	/** 官方推荐 id 集合（用于 applyCardState 原地更新时判定，避免依赖一次性 isRecommended 字段） */
	recommendedIds?: Set<string>;
	/** 收藏：用户收藏插件 id 集合（用于卡片初始收藏高亮态） */
	favoritesSet?: Set<string>;
	/** 离线智能信号：插件 id → 信号列表（下载量分位 / 近期活跃等，无需 AI Key） */
	smartSignals?: Map<string, SignalId[]>;
	/** 描述展开/收起时的回调（用于虚拟滚动重测行高） */
	onDescToggle?: () => void;
	/** 「🍎 系统翻译」成功后落库回调（由视图注入，调用 translator.persistSystemTranslation） */
	onSysTranslatePersist?: (pluginId: string, translatedName: string, translatedDesc: string) => void;
}

// ── 操作图标（统一 lucide 描边风） ──
// 对比：并列双栏（选品对比入口）
const ICON_COMPARE = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4" width="7" height="16" rx="1.2"/><rect x="13.5" y="4" width="7" height="16" rx="1.2"/></svg>`;
// 收藏：星形（描边风，与并列双栏一致；选中态由 CSS 填充金色）
const ICON_FAVORITE = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
// 了解功能：灯泡
const ICON_INSIGHT = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V18h6v-1.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z"/></svg>`;
// 系统翻译（macOS 快捷指令，按需）：苹果标
const ICON_SYS_TRANSLATE = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20.9c-2.8.8-5.1-1.8-4.3-4.6.5-1.8 2.2-3 4.3-3s3.8 1.2 4.3 3c.8 2.8-1.5 5.4-4.3 4.6z"/><path d="M12 3.1c2.8-.8 5.1 1.8 4.3 4.6-.5 1.8-2.2 3-4.3 3s-3.8-1.2-4.3-3c-.8-2.8 1.5-5.4 4.3-4.6z"/><path d="M4.2 9.4 19.8 14.6"/><path d="M4.2 14.6 19.8 9.4"/></svg>`;
// 下载量：向下箭头（统计行 chip 图标，替代 emoji ⬇）
const ICON_DOWNLOAD = `<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
// 更新时间：时钟（统计行 chip 图标，替代 emoji 🕐）
const ICON_CLOCK = `<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
// 作者：线性人头图标（卡片作者标识）
const ICON_PERSON = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/></svg>`;

/**
 * 创建单个插件卡片（无逐卡事件绑定，由列表层事件委托处理交互）。
 * @param plugin 插件信息
 * @param result 翻译结果（可能为 undefined）
 * @param ctx 渲染上下文（t/installedIds/enabledIds/aiSearchResult）
 */
/**
 * 创建单个插件卡片（对外兼容 API：骨架 + 原地填充，供测试与一次性场景使用）。
 * 虚拟滚动热路径改走 createCardElement（建一次）+ applyCardState（原地更新），
 * 实现卡片元素池化复用，避免滚入时重复创建节点与 5 处 SVG 重解析。
 * @param plugin 插件信息
 * @param result 翻译结果（可能为 undefined）
 * @param ctx 渲染上下文
 */
export function createPluginCard(
	plugin: PluginInfo,
	result: TranslateResult | undefined,
	ctx: CardRenderContext
): HTMLElement {
	const el = createCardElement(ctx);
	applyCardState(el, plugin, result, ctx);
	return el;
}

/** 卡片可变子节点的稳定引用集合（构建一次后常驻，供 applyCardState 原地更新） */
interface CardRefs {
	nameSpan: HTMLElement;
	originalName: HTMLElement;
	installBtn: HTMLElement;
	compareBtn: HTMLElement;
	insightBtn: HTMLElement;
	favBtn: HTMLElement;
	macosBtn: HTMLElement | null;
	descEl: HTMLElement;
	statline: HTMLElement;
	dlChip: HTMLElement;
	dlText: HTMLElement;
	clkChip: HTMLElement;
	clkText: HTMLElement;
	signalsRow: HTMLElement;
	aiReason: HTMLElement;
	aiReasonText: HTMLElement;
	authorSpan: HTMLElement;
	authorName: HTMLElement;
	installedMeta: HTMLElement;
	recommendBadge: HTMLElement;
}

const cardRefsMap = new WeakMap<HTMLElement, CardRefs>();

/** 卡片 → 当前渲染上下文（池化复用时 applyCardState 更新，确保 descToggle click handler 读取最新 ctx） */
const cardCtxMap = new WeakMap<HTMLElement, CardRenderContext>();

/** 构建图标按钮（静态 SVG 由调用方写入 innerHTML，常驻不重解析） */
function makeIconBtn(cls: string, action: string, label: string, _ctx: CardRenderContext): HTMLButtonElement {
	const b = createEl("button");
	b.className = cls;
	b.setAttribute("data-action", action);
	b.setAttribute("aria-label", label);
	b.setAttribute("title", label);
	return b;
}

/**
 * 构建卡片骨架：只创建结构 + 静态 SVG 图标 + desc 折叠监听，所有可变段落以
 * 「常驻容器 + 隐藏」形式预建，refs 存入 WeakMap。元素可被虚拟滚动池化复用，
 * 滚入不同插件时仅调用 applyCardState 原地改内容，省掉节点创建与 SVG 重解析。
 */
export function createCardElement(ctx: CardRenderContext): HTMLElement {
	const card = createDiv();
	card.className = "pt-card pt-card--clickable";
	card.setAttribute("tabindex", "-1"); // 键盘导航：程序化聚焦，不进入 Tab 序
	card.setAttribute("role", "listitem"); // S6：配合 layer 的 role=list + aria-posinset

	// 官方推荐金色角标（左上角叠加，常驻隐藏，applyCardState 控制显隐）
	const recommendBadge = createSpan();
	recommendBadge.className = "pt-card-recommend-badge";
	recommendBadge.textContent = ctx.t("recommend.badge");
	recommendBadge.setAttribute("title", ctx.t("recommend.badge"));
	recommendBadge.setCssStyles({ display: "none" });
	card.appendChild(recommendBadge);

	// ── 头行：标题区 + 安装按钮 ──
	const headRow = card.createDiv({ cls: "pt-card-head-row" });
	const nameBlock = headRow.createDiv({ cls: "pt-card-name-block" });
	const nameSpan = nameBlock.createSpan({ cls: "pt-card-name" });
	const originalName = nameBlock.createSpan({ cls: "pt-card-original-name" });
	originalName.setCssStyles({ display: "none" });

	// 安装按钮占位（applyCardState 按状态重建并 replaceWith，保持 head Row 的 flex 顺序）
	const installBtn = createSpan();
	installBtn.className = "pt-card-install-btn pt-card-install-btn--enabled";
	installBtn.textContent = ctx.t("card.installed.on");
	headRow.appendChild(installBtn);

	// ── 底部脚注：元信息 chip 化（作者在前） ──
	const meta = card.createDiv({ cls: "pt-card-meta" });
	const metaInfo = meta.createDiv({ cls: "pt-card-meta-info" });
	const authorSpan = metaInfo.createSpan({
		cls: "pt-meta-chip pt-meta-chip--author",
		attr: { "data-action": "author" },
	});
	appendSVG(authorSpan.createSpan({ cls: "pt-author-icon" }), ICON_PERSON);
	const authorName = authorSpan.createSpan({ cls: "pt-author-name" });
	const installedMeta = metaInfo.createSpan({ cls: "pt-card-installed" });
	installedMeta.setCssStyles({ display: "none" });

	// ── 描述（固定行数截断，hover 浮层展示完整描述） ──
	const descEl = card.createDiv({ cls: "pt-card-desc pt-card-desc--clamped" });
	let descTooltip: HTMLElement | null = null;
	let descTooltipTimer: number | null = null;
	descEl.addEventListener("mouseenter", () => {
		const fullText = descEl.textContent || "";
		if (!fullText || descEl.scrollHeight <= descEl.clientHeight + 2) return; // 无截断则不弹
		// 延迟 150ms 显示，避免快速划过时闪烁
		descTooltipTimer = window.setTimeout(() => {
			descTooltipTimer = null;
			descTooltip = createDiv();
			descTooltip.className = "pt-desc-tooltip";
			descTooltip.textContent = fullText;
			const cardRect = card.getBoundingClientRect();
			const descRect = descEl.getBoundingClientRect();
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			const gap = 6;
			// 浮层宽度与卡片对齐，保底 200px
			const minW = 200;
			const ttW = Math.max(minW, Math.min(cardRect.width, 440));
			descTooltip.setCssStyles({ minWidth: `${minW}px`, maxWidth: `${ttW}px` });
			// 先挂载以测量实际高度
			descTooltip.setCssStyles({ visibility: "hidden" });
			document.body.appendChild(descTooltip);
			const actualW = Math.min(ttW, descTooltip.scrollWidth);
			const actualH = descTooltip.offsetHeight;
			// 左对齐卡片，溢出视口时内缩
			let left = cardRect.left;
			if (left + actualW > vw - 8) left = vw - 8 - actualW;
			if (left < 8) left = 8;
			descTooltip.setCssStyles({ left: `${left}px` });
			// 智能纵向定位
			const belowTop = descRect.bottom + gap;
			if (belowTop + actualH > vh - 8) {
				descTooltip.setCssStyles({ top: `${descRect.top - gap - actualH}px` });
				descTooltip.classList.add("pt-desc-tooltip--above");
			} else {
				descTooltip.setCssStyles({ top: `${belowTop}px` });
			}
			// 三角箭头水平对齐描述区
			const arrowLeft = Math.max(12, Math.min(descRect.left - left + 12, actualW - 24));
			descTooltip.setCssProps({ "--pt-tooltip-arrow-x": `${arrowLeft}px` });
			descTooltip.setCssStyles({ visibility: "" });
		}, 150);
	});
	descEl.addEventListener("mouseleave", () => {
		if (descTooltipTimer) { window.clearTimeout(descTooltipTimer); descTooltipTimer = null; }
		descTooltip?.remove();
		descTooltip = null;
	});

	// ── 标题点击切换中文/英文原名（方案 D） ──
	nameSpan.addEventListener("click", (e: MouseEvent) => {
		if (!nameSpan.classList.contains("pt-card-name--clickable")) return;
		e.stopPropagation(); // 避免冒泡到整卡，误触发打开详情
		const showOrig = nameSpan.classList.toggle("pt-card-name--original");
		const orig = nameSpan.dataset.originalName || "";
		const disp = nameSpan.dataset.displayName || "";
		nameSpan.setCssStyles({ opacity: "0" });
		window.setTimeout(() => {
			nameSpan.textContent = showOrig ? orig : disp;
			nameSpan.setAttribute("aria-pressed", String(showOrig));
			nameSpan.title = showOrig ? ctx.t("card.name.toggleBack") : ctx.t("card.name.toggleOriginal");
			nameSpan.setCssStyles({ opacity: "1" });
		}, 100);
	});
	nameSpan.addEventListener("keydown", (e: KeyboardEvent) => {
		if (e.key === "Enter" || e.key === " ") {
			if (!nameSpan.classList.contains("pt-card-name--clickable")) return;
			e.preventDefault();
			e.stopPropagation(); // 避免冒泡到卡片键盘处理器，误触发打开详情
			nameSpan.click();
		}
	});

	// ── 统计信息行（下载/更新 chip，SVG 常驻） ──
	const statline = card.createDiv({ cls: "pt-card-statline" });
	statline.setCssStyles({ display: "none" });
	const dlChip = statline.createSpan({ cls: "pt-stat-chip" });
	appendSVG(dlChip.createSpan({ cls: "pt-stat-icon" }), ICON_DOWNLOAD);
	const dlText = dlChip.createSpan();
	dlChip.setCssStyles({ display: "none" });
	const clkChip = statline.createSpan({ cls: "pt-stat-chip" });
	appendSVG(clkChip.createSpan({ cls: "pt-stat-icon" }), ICON_CLOCK);
	const clkText = clkChip.createSpan();
	clkChip.setCssStyles({ display: "none" });

	// ── 离线智能信号（pill 文本，无 SVG，按需填充） ──
	const signalsRow = card.createDiv({ cls: "pt-card-signals" });
	signalsRow.setCssStyles({ display: "none" });

	// ── AI 排序理由（可选） ──
	const aiReason = card.createDiv({ cls: "pt-ai-reason" });
	aiReason.setCssStyles({ display: "none" });
	aiReason.createSpan({ cls: "pt-ai-reason-icon", text: "AI" });
	const aiReasonText = aiReason.createSpan({ cls: "pt-ai-reason-text" });

	// ── 操作图标组（静态 SVG，常驻） ──
	const actionsRow = card.createDiv({ cls: "pt-card-actions-row" });
	const insightBtn = makeIconBtn("pt-icon-btn pt-card-insight", "insight", ctx.t("card.insight"), ctx);
	appendSVG(insightBtn, ICON_INSIGHT);
	const compareBtn = makeIconBtn("pt-icon-btn pt-card-compare", "compare", ctx.t("card.compare"), ctx);
	appendSVG(compareBtn, ICON_COMPARE);
	const favBtn = makeIconBtn("pt-icon-btn pt-card-favorite", "favorite", ctx.t("card.favorite"), ctx);
	appendSVG(favBtn, ICON_FAVORITE);
	actionsRow.append(insightBtn, compareBtn, favBtn);

	// macOS 系统翻译（按需按钮，仅 macOS 桌面端渲染）
	let macosBtn: HTMLElement | null = null;
	if (isMacOS()) {
		macosBtn = makeIconBtn("pt-icon-btn pt-card-sys-translate", "sys-translate", ctx.t("card.sysTranslate"), ctx);
		appendSVG(macosBtn, ICON_SYS_TRANSLATE);
		macosBtn.addEventListener("click", (e: MouseEvent) => {
			e.stopPropagation();
			void handleCardSysTranslate(card, ctx);
		});
		actionsRow.append(macosBtn);
	}

	cardRefsMap.set(card, {
		nameSpan, originalName, installBtn, insightBtn, compareBtn, favBtn, macosBtn,
		descEl, statline, dlChip, dlText, clkChip, clkText,
		signalsRow, aiReason, aiReasonText, authorSpan, authorName, installedMeta, recommendBadge,
	});
	cardCtxMap.set(card, ctx);
	return card;
}

/** 构建按安装状态变化的安装按钮（无 SVG，纯文本/属性，复用成本低） */
function buildInstallButton(plugin: PluginInfo, ctx: CardRenderContext): HTMLElement {
	const t = ctx.t;
	const isInstalled = ctx.installedIds.has(plugin.id);
	const isEnabled = ctx.enabledIds.has(plugin.id);
	if (isEnabled) {
		const el = createSpan();
		el.className = "pt-card-install-btn pt-card-install-btn--enabled";
		el.textContent = t("card.installed.on");
		return el;
	}
	const el = createEl("button");
	el.className = isInstalled ? "pt-card-install-btn pt-card-install-btn--installed" : "pt-card-install-btn";
	el.setAttribute("data-action", "market");
	el.setAttribute("data-url", `obsidian://show-plugin?id=${plugin.id}`);
	const label = isInstalled ? t("card.installed.off") : t("card.install");
	el.setAttribute("aria-label", `${label} ${plugin.name}`);
	el.setAttribute("title", isInstalled ? `${t("card.installed.off")} — ${t("card.enable")}` : t("card.install"));
	el.textContent = label;
	return el;
}

/**
 * 卡片「🍎 系统翻译」按钮点击：按需调用 macOS 快捷指令翻译当前插件的名称与描述，
 * 就地回填到卡片展示区（不与自动翻译链耦合，刷新/滚动复用后需重新点）。
 */
async function handleCardSysTranslate(card: HTMLElement, ctx: CardRenderContext): Promise<void> {
	const refs = cardRefsMap.get(card);
	if (!refs || !refs.macosBtn) return;
	const btn = refs.macosBtn;
	if (btn.classList.contains("pt-icon-btn--loading")) return;
	const nameSrc = refs.nameSpan.dataset.originalName || refs.nameSpan.textContent || "";
	const descSrc = refs.descEl.dataset.originalDesc || refs.descEl.textContent || "";
	// 发起翻译时的插件 id：await 期间虚拟滚动可能把这张卡片复用给另一个插件，
	// 必须以发起时的 id 为准落库，并在回填前校验卡片仍属于同一插件
	const reqPluginId = card.dataset.pluginId;

	btn.classList.add("pt-icon-btn--loading");
	btn.setAttribute("aria-busy", "true");
	try {
		const [nameR, descR] = await Promise.all([
			macosSystemTranslate(nameSrc),
			macosSystemTranslate(descSrc),
		]);
		// 落库沉淀：写入 cache + tmApproved，下次打开直接命中复用（用户主动翻译 = 认可）
		// 用 reqPluginId 而非重新读 dataset，避免把 A 的译文写到 B 的 id 下
		if (reqPluginId && nameR && ctx.onSysTranslatePersist) {
			ctx.onSysTranslatePersist(reqPluginId, nameR || nameSrc, descR || descSrc);
		}
		// 卡片已被复用给别的插件：只落库不回填 DOM，否则会显示错插件的译文
		if (card.dataset.pluginId !== reqPluginId) return;
		if (nameR) {
			refs.nameSpan.textContent = nameR;
			refs.nameSpan.classList.remove("pt-card-name--clickable", "pt-card-name--original");
			refs.nameSpan.setCssStyles({ opacity: "1" });
		}
		if (descR) {
			refs.descEl.textContent = descR;
			refs.descEl.classList.remove("pt-desc-pending");
		}
		new Notice(ctx.t("card.sysTranslate.done"));
	} catch {
		new Notice(ctx.t("card.sysTranslate.fail"));
	} finally {
		btn.classList.remove("pt-icon-btn--loading");
		btn.removeAttribute("aria-busy");
	}
}

/**
 * 原地更新卡片内容（虚拟滚动复用核心）：只改文本 / 类名 / 显隐，不重建节点，
 * SVG 图标与 desc 折叠监听保持常驻。复用时重置 desc 为折叠态（与首次建卡一致）。
 */
export function applyCardState(
	cardEl: HTMLElement,
	plugin: PluginInfo,
	result: TranslateResult | undefined,
	ctx: CardRenderContext
): void {
	const refs = cardRefsMap.get(cardEl);
	if (!refs) return;
	// 池化复用：更新 ctx 引用，确保 descToggle click handler 捕获正确的 onDescToggle
	cardCtxMap.set(cardEl, ctx);
	const t = ctx.t;
	const isFav = ctx.favoritesSet?.has(plugin.id) ?? false;
	const isCompared = ctx.compareSet?.has(plugin.id) ?? false;
	const rec = ctx.recommendedIds?.has(plugin.id) ?? ctx.isRecommended ?? false;

	// 身份标识
	cardEl.setAttribute("data-plugin-id", plugin.id);
	// 不再设置 aria-label：Obsidian 的 tooltip 系统会读取 aria-label 并渲染悬浮气泡，
	// 与「标题/作者/安装状态」三段拼成的 tooltip 重叠且信息冗余（卡片内本身已可视）。
	// 卡片内可见文字已覆盖这三条信息，对屏幕阅读器无实质损失。
	const rawName = result?.translatedName || plugin.name;

	// 收藏 / 推荐态
	cardEl.classList.toggle("is-favorited", isFav);
	cardEl.classList.toggle("is-recommended", rec);
	refs.recommendBadge.setCssStyles({ display: rec ? "" : "none" });

	// 名称 + 原名（点击标题切换中/英）/ 未翻译说明
	const displayName = cleanChineseSpaces(rawName);
	refs.nameSpan.dataset.originalName = plugin.name;
	refs.nameSpan.dataset.displayName = displayName;
	refs.originalName.setCssStyles({ display: "none" }); // 始终隐藏，点击标题切换取而代之
	const isTranslated = displayName !== plugin.name && result?.source !== "original";
	if (!isTranslated) {
		// 无翻译 / 未翻译：标题即原名或中文，无切换
		refs.nameSpan.classList.remove("pt-card-name--clickable", "pt-card-name--original");
		refs.nameSpan.textContent = displayName;
		refs.nameSpan.setCssStyles({ opacity: "1" });
		refs.nameSpan.title = result?.source === "original" ? t("card.original.hint") : "";
		refs.nameSpan.removeAttribute("role");
		refs.nameSpan.removeAttribute("tabindex");
		refs.nameSpan.removeAttribute("aria-pressed");
	} else {
		// 已翻译：标题可点击切换中/英文
		refs.nameSpan.classList.add("pt-card-name--clickable");
		const showOrig = refs.nameSpan.classList.contains("pt-card-name--original");
		refs.nameSpan.textContent = showOrig ? plugin.name : displayName;
		refs.nameSpan.setCssStyles({ opacity: "1" });
		refs.nameSpan.title = showOrig ? t("card.name.toggleBack") : t("card.name.toggleOriginal");
		refs.nameSpan.setAttribute("role", "button");
		refs.nameSpan.setAttribute("tabindex", "0");
		refs.nameSpan.setAttribute("aria-pressed", String(showOrig));
	}

	// 安装按钮（按状态重建并替换，保持 head Row 顺序）
	const newInstall = buildInstallButton(plugin, ctx);
	refs.installBtn.replaceWith(newInstall);
	refs.installBtn = newInstall;

	// 对比 / 收藏图标态
	refs.compareBtn.classList.toggle("is-compare-on", isCompared);
	refs.favBtn.classList.toggle("is-fav-on", isFav);

	// 描述
	const descText = cleanChineseSpaces(result?.translatedDesc || plugin.description);
	refs.descEl.textContent = (descText);
	refs.descEl.dataset.originalDesc = plugin.description;
	refs.descEl.classList.toggle("pt-desc-pending", !result);
	refs.descEl.classList.add("pt-card-desc--clamped"); // 固定截断态（与首次建卡一致）

	// 统计行
	const dl = plugin.downloads;
	const showDl = dl != null;
	refs.dlChip.setCssStyles({ display: showDl ? "" : "none" });
	if (showDl) refs.dlText.textContent = (formatDownloads(dl));
	const u = plugin.updated != null ? formatUpdated(plugin.updated) : "";
	const showClk = !!u;
	refs.clkChip.setCssStyles({ display: showClk ? "" : "none" });
	if (showClk) refs.clkText.textContent = (`更新于 ${u}`);
	refs.statline.setCssStyles({ display: showDl || showClk ? "" : "none" });

	// 离线智能信号
	const signals = ctx.smartSignals?.get(plugin.id);
	if (signals && signals.length > 0) {
		refs.signalsRow.setCssStyles({ display: "" });
		refs.signalsRow.replaceChildren();
		for (const sig of signals) {
			refs.signalsRow.createSpan({ cls: "pt-signal-pill", text: SIGNAL_LABELS[sig] });
		}
	} else {
		refs.signalsRow.setCssStyles({ display: "none" });
		refs.signalsRow.replaceChildren();
	}

	// AI 排序理由
	const reason = ctx.aiSearchResult?.reasons?.[plugin.id];
	if (reason) {
		refs.aiReason.setCssStyles({ display: "" });
		refs.aiReasonText.textContent = (reason);
	} else {
		refs.aiReason.setCssStyles({ display: "none" });
	}

	// 元信息：作者 + ID + 安装状态
	refs.authorName.textContent = (plugin.author);
	refs.authorSpan.setAttribute("title", t("card.author.tip").replace("{author}", plugin.author));
	if (ctx.installedIds.has(plugin.id)) {
		const enabled = ctx.enabledIds.has(plugin.id);
		refs.installedMeta.setCssStyles({ display: "" });
		const txt = t(enabled ? "card.installed.on" : "card.installed.off");
		refs.installedMeta.textContent = (txt);
		refs.installedMeta.className = enabled ? "pt-card-installed pt-installed-on" : "pt-card-installed pt-installed-off";
		refs.installedMeta.setAttribute("title", txt);
	} else {
		refs.installedMeta.setCssStyles({ display: "none" });
	}
}
