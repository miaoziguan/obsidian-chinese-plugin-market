/**
 * 插件卡片渲染器（阶段五：卡片渲染下沉）。
 * 从 main.ts 的 createPluginCard 抽出，视图仅负责把上下文 ctx 注入并挂载结果，
 * 卡片 DOM 的构建逻辑集中于此，便于维护与（未来基于 jsdom 的）测试。
 *
 * 依赖 Obsidian 对 HTMLElement 的全局 DOM 扩展（createEl/appendText 等），
 * 该扩展随项目内其它文件 import "obsidian" 而在整个程序内生效。
 */

import { Notice } from "obsidian";
import type { PluginInfo, TranslateResult, AISearchResult } from "@domain/catalog/translator";
import type { ChinesePluginMarketSettings } from "@ui/view/translator-view";
import type { I18nKey } from "@shared/i18n";
import { cleanChineseSpaces } from "@shared/utils";
import { appendSVG } from "@ui/dom/dom";
import { isMacOS, macosSystemTranslate } from "@translation/platform/macos-shortcuts";
import { formatDownloads, formatRelativeTime } from "@domain/catalog/stats";
import type { SignalId } from "@domain/filter/smart-signal";
import type { TrendingEngine, TrendSnapshot } from "@domain/recommend/trending";
import { assessHealth } from "@domain/recommend/health";
import { isNewPlugin } from "@domain/recommend/newness";
import { asAppInternals } from "@data/platform/obsidian-internals";

/** 离线信号 → 中文标签（无需 AI Key 即可展示） */
const SIGNAL_LABELS: Record<SignalId, string> = {
	top1: "Top 1%",
	top5: "Top 5%",
	hot10: "热门",
	recentActive: "近期活跃",
	recentUpdate: "近期更新",
	velocityRising: "增速飙升",
};

/** 召回信号 → 中文徽标文案（排序可解释性用） */
const MATCH_SIGNAL_LABELS: Record<string, string> = {
	vector: "语义",
	keyword: "关键词",
	title: "标题",
	llm: "AI 精排",
};

const TREND_WINDOW_MS = 30 * 86400000;

/**
 * 取某插件近 30 天窗口内的绝对下载增量（latest - 最早窗口点）。
 * 无历史 / 窗口内样本不足 2 点时返回 null（诚实化：不编造增量、不画空线）。
 */
function trendDelta(engine: TrendingEngine | undefined, id: string): number | null {
	if (!engine) return null;
	const snaps = engine.getSnapshots(id);
	if (!snaps || snaps.length < 2) return null;
	const latest = snaps[snaps.length - 1];
	const cutoff = latest.timestamp - TREND_WINDOW_MS;
	const win = snaps.filter((s) => s.timestamp >= cutoff);
	if (win.length < 2) return null;
	return latest.downloads - win[0].downloads;
}

/**
 * 由快照序列生成 ~60×16 的折线 SVG path d（归一化到 viewBox）。
 * 样本不足 2 点时返回空串（调用方据此隐藏 sparkline）。
 * 纯字符串拼接，无 DOM 重建，虚拟滚动热路径可放心调用。
 */
function sparkPathD(snaps: TrendSnapshot[], w = 60, h = 16): string {
	if (snaps.length < 2) return "";
	const ds = snaps.map((s) => s.downloads);
	const min = Math.min(...ds);
	const max = Math.max(...ds);
	const span = max - min || 1;
	const stepX = w / (snaps.length - 1);
	return snaps
		.map((s, i) => {
			const x = (i * stepX).toFixed(1);
			const y = (h - ((s.downloads - min) / span) * h).toFixed(1);
			return `${i === 0 ? "M" : "L"}${x} ${y}`;
		})
		.join(" ");
}

/**
 * 在文本中高亮命中词（highlightTerms，小写），以 DOM 节点方式就地渲染，
 * 不触碰 innerHTML（规避 Obsidian 审核对 innerHTML/insertAdjacentHTML 的告警）：
 * 非命中片段用文本节点，命中片段用 <mark class="pt-hl"> 元素。
 *
 * 按长度降序排列 terms，避免短词先匹配把长词拆断；逐段切分后用 DocumentFragment 组装，
 * 最后 replaceChildren，避免逐字符 innerHTML 拼接带来的注入风险。
 */
function highlightInto(el: HTMLElement, text: string, terms: string[] | undefined): void {
	el.replaceChildren(); // 清空旧内容（含真实 DOM 节点，无 innerHTML）
	if (!terms || terms.length === 0 || !text) {
		el.append(document.createTextNode(text));
		return;
	}
	// 按长度降序，避免短词先匹配把长词拆断
	const sorted = [...terms].sort((a, b) => b.length - a.length);
	const pattern = sorted.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
	const re = new RegExp(`(${pattern})`, "gi");
	let last = 0;
	let m: RegExpExecArray | null;
	// 用全局正则逐段匹配（lastIndex 推进），未命中段为文本节点、命中段为 mark 元素
	while ((m = re.exec(text)) !== null) {
		if (m.index > last) el.append(document.createTextNode(text.slice(last, m.index)));
		const mark = createSpan({ cls: "pt-hl" });
		mark.textContent = m[0];
		el.append(mark);
		last = m.index + m[0].length;
		if (m[0].length === 0) re.lastIndex++; // 防御零宽匹配死循环
	}
	if (last < text.length) el.append(document.createTextNode(text.slice(last)));
}

/** 卡片渲染上下文（由视图注入，避免渲染器依赖视图实例） */
export interface CardRenderContext {
	/** i18n 取词函数 */
	t: (key: I18nKey) => string;
	/** 插件设置（健康度徽标 / 更新提醒等偏好，供卡片就地读取） */
	settings: ChinesePluginMarketSettings;
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
	/** 「可更新」检测：官方版本领先本地的插件 id 集合（仅已装插件） */
	outdatedIds?: Set<string>;
	/** 「可更新」详情：插件 id → {local, latest}，供徽标 tooltip 展示版本差 */
	outdatedInfo?: Map<string, { local: string; latest: string }>;
	/** Obsidian App 引用（用于「可更新」徽标点击跳社区插件更新入口） */
	app?: import("obsidian").App;
	/** 正在一键安装中的插件 id 集合（用于按钮显示「安装中…」并防重点） */
	installingIds?: Set<string>;
	/** 描述展开/收起时的回调（用于虚拟滚动重测行高） */
	onDescToggle?: () => void;
	/** 「🍎 系统翻译」成功后落库回调（由视图注入，调用 translator.persistSystemTranslation） */
	onSysTranslatePersist?: (pluginId: string, translatedName: string, translatedDesc: string) => void;
	/** 卡片左下角电源按钮：切换已安装插件启用/禁用（由视图注入，避免 card-render 依赖 installer） */
	onToggleEnabled?: (pluginId: string) => void;
	/** 趋势评分引擎（可选）：用于卡片下载行绘制近 30 天增量 chip + 增速 sparkline。未注入则静默隐藏 */
	trendingEngine?: TrendingEngine;
	/** 首次见时间戳映射（可选）：id → 首次见 ms；>0 且近 30 天内标「新」。未注入则静默隐藏 */
	firstSeenMap?: Map<string, number>;
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
const ICON_TRASH = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;

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
	toggleSwitch: HTMLElement;
	uninstallBtn: HTMLElement;
	descEl: HTMLElement;
	statline: HTMLElement;
	/** 趋势 sparkline 容器（常驻隐藏，applyCardState 在有窗口历史时显示） */
	spark: HTMLElement;
	/** sparkline 内 <path> 元素引用（避免每次重绘 querySelector） */
	sparkPath: SVGPathElement;
	dlChip: HTMLElement;
	dlText: HTMLElement;
	clkChip: HTMLElement;
	clkText: HTMLElement;
	signalsRow: HTMLElement;
	aiReason: HTMLElement;
	aiReasonText: HTMLElement;
	authorSpan: HTMLElement;
	authorName: HTMLElement;

	recommendBadge: HTMLElement;
	/** 排序可解释性：召回信号徽标行（向量/关键词/标题/AI 精排） */
	matchSignals: HTMLElement;
	/** 可更新徽标：官方版本领先本地（仅已装插件），点击跳社区插件更新入口 */
	updateBadge?: HTMLElement;
	/** 维护健康度徽标（基于 updated 三档：活跃/放缓/风险），常驻隐藏，applyCardState 填充 */
	healthBadge: HTMLElement;
	/** 「新」标记（近 30 天首次见），纯文字融入作者行，常驻隐藏，applyCardState 填充 */
	newBadge: HTMLElement;
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

	// 「可更新」徽标：官方版本领先本地（仅已装插件），点击跳社区插件更新入口；初始隐藏
	// a11y：role=button + tabindex 让键盘可达；Enter/Space 触发与点击一致
	const updateBadge = metaInfo.createSpan({ cls: "pt-card-update-badge" });
	updateBadge.setAttribute("role", "button");
	updateBadge.setAttribute("tabindex", "0");
	updateBadge.setCssStyles({ display: "none" });
	const goToUpdates = (e: Event) => {
		e.stopPropagation();
		asAppInternals(ctx.app).setting?.openTabById?.("community-plugins");
	};
	updateBadge.addEventListener("click", goToUpdates);
	updateBadge.addEventListener("keydown", (e: KeyboardEvent) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			e.stopPropagation();
			goToUpdates(e);
		}
	});

	// 维护健康度徽标（基于 updated 三档），常驻隐藏，applyCardState 填充
	const healthBadge = metaInfo.createSpan({ cls: "pt-card-health-badge" });
	// 状态徽标文本已随卡片可见，对屏幕阅读器隐藏避免重复朗读
	healthBadge.setAttribute("aria-hidden", "true");
	healthBadge.setCssStyles({ display: "none" });

	// 「新」标记（近 30 天首次见），纯文字融入作者行，常驻隐藏，applyCardState 填充
	const newBadge = metaInfo.createSpan({ cls: "pt-card-new-badge" });
	newBadge.setAttribute("aria-hidden", "true");
	newBadge.setCssStyles({ display: "none" });

	// ── 描述（固定行数截断展示，点击穿透到整卡委托打开详情页） ──
	// 不再把描述区当成独立可点击元素：原方案 C 点描述 toggle 展开会占用大块可操作区、
	// 并用 stopPropagation 拦截冒泡，导致「点描述进详情」极难触发（用户痛点）。
	// 现描述区为纯文本（非 button / 无 data-action），点击冒泡到 onCardClick 委托后
	// 命中 !actionEl 分支直接打开详情页；卡片高度由 CSS 锁定，展开不改变行高，
	// 故无需展开交互（想看全文进详情页即可）。
	const descEl = card.createDiv({ cls: "pt-card-desc pt-card-desc--clamped" });

	// ── 标题点击切换中文/英文原名（方案 D） ──
	nameSpan.addEventListener("click", (e: MouseEvent) => {
		if (!nameSpan.classList.contains("pt-card-name--clickable")) return;
		e.stopPropagation(); // 避免冒泡到整卡，误触发打开详情
		const showOrig = nameSpan.classList.toggle("pt-card-name--original");
		const disp = nameSpan.dataset.displayName || "";
		const alt = nameSpan.dataset.altName || nameSpan.dataset.originalName || "";
		nameSpan.setCssStyles({ opacity: "0" });
		window.setTimeout(() => {
			const hl = cardCtxMap.get(card)?.aiSearchResult?.highlightTerms;
			highlightInto(nameSpan, showOrig ? alt : disp, hl);
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

	// ── 趋势 sparkline（常驻隐藏，applyCardState 在有窗口历史时显示） ──
	const spark = statline.createSpan({ cls: "pt-card-spark" });
	// 纯装饰性图表：对屏幕阅读器隐藏，避免 SVG 路径被逐段朗读
	spark.setAttribute("aria-hidden", "true");
	appendSVG(spark, `<path d=""></path>`);
	const sparkPath = spark.querySelector("path") as SVGPathElement;
	spark.setCssStyles({ display: "none" });

	// ── 离线智能信号（pill 文本，无 SVG，按需填充） ──
	const signalsRow = card.createDiv({ cls: "pt-card-signals" });
	signalsRow.setCssStyles({ display: "none" });

	// ── AI 排序理由（可选） ──
	const aiReason = card.createDiv({ cls: "pt-ai-reason" });
	aiReason.setCssStyles({ display: "none" });
	aiReason.createSpan({ cls: "pt-ai-reason-icon", text: "AI" });
	const aiReasonText = aiReason.createSpan({ cls: "pt-ai-reason-text" });

	// 排序可解释性：召回信号徽标行（向量/关键词/标题/AI 精排），常驻隐藏，applyCardState 控制显隐
	const matchSignals = card.createDiv({ cls: "pt-card-match-signals" });
	matchSignals.setCssStyles({ display: "none" });

	// ── 操作图标组（静态 SVG，常驻） ──
	const actionsRow = card.createDiv({ cls: "pt-card-actions-row" });
	const insightBtn = makeIconBtn("pt-icon-btn pt-card-insight", "insight", ctx.t("card.insight"), ctx);
	appendSVG(insightBtn, ICON_INSIGHT);
	const compareBtn = makeIconBtn("pt-icon-btn pt-card-compare", "compare", ctx.t("card.compare"), ctx);
	appendSVG(compareBtn, ICON_COMPARE);
	const favBtn = makeIconBtn("pt-icon-btn pt-card-favorite", "favorite", ctx.t("card.favorite"), ctx);
	appendSVG(favBtn, ICON_FAVORITE);
	// 卸载按钮（仅已安装插件显示，默认隐藏，由 applyCardState 按安装态显隐）
	const uninstallBtn = makeIconBtn("pt-icon-btn pt-card-uninstall", "uninstall", ctx.t("card.uninstall"), ctx);
	appendSVG(uninstallBtn, ICON_TRASH);
	uninstallBtn.setCssStyles({ display: "none" });
	actionsRow.append(insightBtn, compareBtn, favBtn, uninstallBtn);

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

	// 启用/禁用切换（子弹开关，放在卡片右下角，仅已安装插件显示）。
	// 直接绑 click + stopPropagation：开关是自定义 DOM（非 SVG），closest 在最外层
	// 容器上稳定命中；stopPropagation 阻止冒泡到卡片层（避免误开详情页）。
	const toggleSwitch = actionsRow.createDiv({ cls: "pt-card-toggle-switch", attr: { "data-action": "toggle-enabled", role: "switch", tabindex: "0", "aria-label": ctx.t("card.enable") } });
	toggleSwitch.setCssStyles({ display: "none" });
	const toggleTrack = toggleSwitch.createDiv({ cls: "pt-card-toggle-track" });
	toggleTrack.createDiv({ cls: "pt-card-toggle-knob" });
	toggleSwitch.addEventListener("click", (e: MouseEvent) => {
		e.stopPropagation();
		e.preventDefault();
		const pid = card.dataset.pluginId;
		const liveCtx = cardCtxMap.get(card) ?? ctx;
		if (pid && liveCtx.onToggleEnabled) liveCtx.onToggleEnabled(pid);
	});
	toggleSwitch.addEventListener("keydown", (e: KeyboardEvent) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			e.stopPropagation();
			const pid = card.dataset.pluginId;
			const liveCtx = cardCtxMap.get(card) ?? ctx;
			if (pid && liveCtx.onToggleEnabled) liveCtx.onToggleEnabled(pid);
		}
	});

	cardRefsMap.set(card, {
		nameSpan, originalName, installBtn, insightBtn, compareBtn, favBtn, macosBtn, toggleSwitch, uninstallBtn,
		descEl, statline, spark, sparkPath, dlChip, dlText, clkChip, clkText,
		signalsRow, aiReason, aiReasonText, 		authorSpan, authorName, recommendBadge, matchSignals,
		updateBadge, healthBadge, newBadge,
	});
	cardCtxMap.set(card, ctx);
	return card;
}

/** 构建按安装状态变化的安装状态胶囊（右上角，纯展示/入口，不复用启用切换逻辑）。 */
function updateInstallButton(
	existing: HTMLElement,
	plugin: PluginInfo,
	ctx: CardRenderContext
): HTMLElement {
	const t = ctx.t;
	const isInstalled = ctx.installedIds.has(plugin.id);
	const isEnabled = ctx.enabledIds.has(plugin.id);
	const isInstalling = !!ctx.installingIds?.has(plugin.id);

	// 纯展示状态（安装中 / 已启用 / 已安装）点击不冒泡到卡片层 → 不打开详情页。
	// 用 onclick 覆盖式赋值（不会累积监听器），启用/禁用由左下角电源图标负责。
	const stopBubble = (e: MouseEvent) => e.stopPropagation();

	// 安装中：统一显示为 span（不可点击，防重点）。
	// 用 JS 驱动的三点省略号循环（安装中 → 安装中· → 安装中·· → 安装中···）提示"进行中"，
	// 不依赖任何 CSS animation（规避系统/主题 reduce-motion 禁用动画导致完全不可见）。
	if (isInstalling) {
		const ensureInstalling = (el: HTMLElement) => {
			el.className = "pt-card-install-btn pt-card-install-btn--installing";
			el.setAttribute("aria-label", `${t("card.installing")} ${plugin.name}`);
			el.onclick = stopBubble;
			let label = el.querySelector<HTMLElement>(".pt-install-label");
			if (!label) {
				el.textContent = "";
				label = createSpan({ cls: "pt-install-label", text: t("card.installing") });
				el.appendChild(label);
			}
			// 启动/复用三点循环定时器（元素脱离文档则自动停，避免泄漏）
			if (!(el as unknown as { _ptDots?: number })._ptDots) {
				let n = 0;
				const tick = () => {
					if (!el.isConnected) {
						window.clearInterval((el as unknown as { _ptDots?: number })._ptDots);
						(el as unknown as { _ptDots?: number })._ptDots = undefined;
						return;
					}
					n = (n + 1) % 4;
					label.textContent = t("card.installing") + "·".repeat(n);
				};
				(el as unknown as { _ptDots?: number })._ptDots = window.setInterval(tick, 500);
			}
		};
		if (existing.tagName === "SPAN" && existing.classList.contains("pt-card-install-btn--installing")) {
			ensureInstalling(existing);
			return existing;
		}
		const el = createSpan();
		ensureInstalling(el);
		existing.replaceWith(el);
		return el;
	}

	// 已启用：实心成功色胶囊（纯展示，启用/禁用由左下角电源图标负责）
	if (isEnabled) {
		const el = existing.tagName === "SPAN" && existing.classList.contains("pt-card-install-btn--enabled")
			? existing
			: createSpan();
		if (el !== existing) existing.replaceWith(el);
		el.className = "pt-card-install-btn pt-card-install-btn--enabled";
		el.setAttribute("aria-label", `${t("card.installed.on")} ${plugin.name}`);
		el.textContent = t("card.installed.on");
		el.onclick = stopBubble;
		return el;
	}
	// 已安装但未启用：次要胶囊（纯展示）
	if (isInstalled) {
		const el = existing.tagName === "SPAN" && existing.classList.contains("pt-card-install-btn--installed")
			? existing
			: createSpan();
		if (el !== existing) existing.replaceWith(el);
		el.className = "pt-card-install-btn pt-card-install-btn--installed";
		el.setAttribute("aria-label", `${t("card.installed.off")} ${plugin.name}`);
		el.textContent = t("card.installed.off");
		el.onclick = stopBubble;
		return el;
	}
	// 未安装：主 CTA 安装按钮，data-action=market（走卡片层事件委托，不拦冒泡）
	const btn = existing.tagName === "BUTTON" && existing.dataset.action === "market"
		? existing
		: createEl("button");
	if (btn !== existing) existing.replaceWith(btn);
	btn.className = "pt-card-install-btn";
	btn.setAttribute("data-action", "market");
	btn.setAttribute("data-url", `obsidian://show-plugin?id=${plugin.id}`);
	btn.setAttribute("aria-label", `${t("card.install")} ${plugin.name}`);
	btn.setAttribute("title", t("card.install"));
	btn.textContent = t("card.install");
	btn.onclick = null;
	return btn;
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
	// CSS 进度线驱动：从 0→0.5（name 完成）→1（desc 完成）两段递进。
	// 仅设"完成时"刻度，未完成时保持 ready（=0），避免误以为已经开始了。
	btn.setCssProps({ "--pt-progress": "0" });
	const pName = macosSystemTranslate(nameSrc).then((r) => {
		btn.setCssProps({ "--pt-progress": "0.5" });
		return r;
	});
	const pDesc = macosSystemTranslate(descSrc).then((r) => {
		btn.setCssProps({ "--pt-progress": "1" });
		return r;
	});
	try {
		const [nameR, descR] = await Promise.all([pName, pDesc]);
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
	// 池化复用：更新 ctx 引用，确保后续交互（标题切换、委托打开详情等）捕获正确 ctx
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
	// 标题显示模式（设置项 nameDisplay）：translated=中文译名优先；original=原标题优先。
	// 两种模式下只要存在可用译名，标题都可点击在「译名 / 原名」间临时切换。
	const translatedName = cleanChineseSpaces(result?.translatedName || plugin.name);
	const origName = plugin.name;
	const hasTranslation = !!result?.translatedName && result?.source !== "original";
	// 默认显示语言：按模式选；切换目标语言（altName）= 另一种语言。
	// 防御式读取：e2e harness 等构造的 ctx 未必带完整 settings，缺省回退到 translated（原行为）。
	// 局部 settings 兜底：下方 updateBadge / healthBadge 等多处直接读设置项，统一用 ?? {} 避免整段崩溃。
	const settings = ctx.settings ?? {};
	const nameDisplay = settings.nameDisplay ?? "translated";
	const displayName = nameDisplay === "original" ? origName : translatedName;
	const altName = displayName === origName ? translatedName : origName;
	const isTranslated = hasTranslation;

	// 收藏 / 推荐态
	cardEl.classList.toggle("is-favorited", isFav);
	cardEl.classList.toggle("is-recommended", rec);
	refs.recommendBadge.setCssStyles({ display: rec ? "" : "none" });

	// 名称 + 原名（点击标题切换中/英）/ 未翻译说明
	refs.nameSpan.dataset.originalName = plugin.name;
	refs.nameSpan.dataset.displayName = displayName;
	// altName：点标题切换到的「另一语言」（translated 模式=原名；original 模式=译名）
	refs.nameSpan.dataset.altName = altName;
	refs.originalName.setCssStyles({ display: "none" }); // 始终隐藏，点击标题切换取而代之
	// AI/本地语义搜索命中词高亮（highlightTerms 由 ctx.aiSearchResult 携带）
	const hl = ctx.aiSearchResult?.highlightTerms;
	if (!isTranslated) {
		// 无翻译 / 未翻译：标题即原名或中文，无切换
		refs.nameSpan.classList.remove("pt-card-name--clickable", "pt-card-name--original");
		highlightInto(refs.nameSpan, displayName, hl);
		refs.nameSpan.setCssStyles({ opacity: "1" });
		refs.nameSpan.title = result?.source === "original" ? t("card.original.hint") : "";
		refs.nameSpan.removeAttribute("role");
		refs.nameSpan.removeAttribute("tabindex");
		refs.nameSpan.removeAttribute("aria-pressed");
	} else {
		// 已翻译：标题可点击切换中/英文
		refs.nameSpan.classList.add("pt-card-name--clickable");
		const showOrig = refs.nameSpan.classList.contains("pt-card-name--original");
		highlightInto(refs.nameSpan, showOrig ? altName : displayName, hl);
		refs.nameSpan.setCssStyles({ opacity: "1" });
		refs.nameSpan.title = showOrig ? t("card.name.toggleBack") : t("card.name.toggleOriginal");
		refs.nameSpan.setAttribute("role", "button");
		refs.nameSpan.setAttribute("tabindex", "0");
		refs.nameSpan.setAttribute("aria-pressed", String(showOrig));
	}

	// 安装按钮：install/installed 状态原地更新（右上角纯状态胶囊）
	refs.installBtn = updateInstallButton(refs.installBtn, plugin, ctx);

	// 启用/禁用切换（右下角子弹开关，仅已安装插件显示）
	const isInstalled = ctx.installedIds.has(plugin.id);
	const isEnabled = ctx.enabledIds.has(plugin.id);
	const isInstalling = !!ctx.installingIds?.has(plugin.id);
	// 仅在「安装中」或「确实未安装」时隐藏开关。
	// 注意：启用插件后 Obsidian 内部 manifests 重载存在竞态，installedIds 快照可能瞬时
	// 漏掉该 id；enabledIds 通常更可靠，故用「既非 installed 也非 enabled」才隐藏，
	// 避免开关在开启成功后误消失。
	if (isInstalling || (!isInstalled && !isEnabled)) {
		refs.toggleSwitch.setCssStyles({ display: "none" });
		refs.toggleSwitch.classList.remove("is-on");
		refs.toggleSwitch.setAttribute("aria-checked", "false");
	} else if (isEnabled) {
		refs.toggleSwitch.setCssStyles({ display: "" });
		refs.toggleSwitch.classList.add("is-on");
		refs.toggleSwitch.setAttribute("aria-checked", "true");
		refs.toggleSwitch.setAttribute("aria-label", `${plugin.name} ${t("card.installed.on")} — ${t("card.disable")}`);
		refs.toggleSwitch.setAttribute("title", t("card.disable"));
	} else {
		refs.toggleSwitch.setCssStyles({ display: "" });
		refs.toggleSwitch.classList.remove("is-on");
		refs.toggleSwitch.setAttribute("aria-checked", "false");
		refs.toggleSwitch.setAttribute("aria-label", `${plugin.name} ${t("card.installed.off")} — ${t("card.enable")}`);
		refs.toggleSwitch.setAttribute("title", t("card.enable"));
	}

	// 卸载按钮：仅已安装（含已启用）插件显示
	if (isInstalled || isEnabled) {
		refs.uninstallBtn.setCssStyles({ display: "" });
		refs.uninstallBtn.setAttribute("aria-label", t("card.uninstall"));
		refs.uninstallBtn.setAttribute("title", t("card.uninstall"));
	} else {
		refs.uninstallBtn.setCssStyles({ display: "none" });
	}

	// 对比 / 收藏图标态
	refs.compareBtn.classList.toggle("is-compare-on", isCompared);
	refs.favBtn.classList.toggle("is-fav-on", isFav);

	// 描述
	const descText = cleanChineseSpaces(result?.translatedDesc || plugin.description);
	highlightInto(refs.descEl, descText, hl);
	refs.descEl.dataset.originalDesc = plugin.description;
	refs.descEl.classList.toggle("pt-desc-pending", !result);
	refs.descEl.classList.add("pt-card-desc--clamped"); // 固定截断态（与首次建卡一致）

	// 统计行
	const dl = plugin.downloads;
	const showDl = dl != null;
	refs.dlChip.setCssStyles({ display: showDl ? "" : "none" });
	if (showDl) refs.dlText.textContent = (formatDownloads(dl));
	const u = plugin.updated != null ? formatRelativeTime(plugin.updated) : "";
	const showClk = !!u;
	refs.clkChip.setCssStyles({ display: showClk ? "" : "none" });
	if (showClk) refs.clkText.textContent = (`更新于 ${u}`);

	// 趋势 sparkline + 增量 chip：有窗口历史才显示，否则诚实隐藏（不画空线、不编造增量）
	const snaps = ctx.trendingEngine?.getSnapshots(plugin.id);
	const delta = trendDelta(ctx.trendingEngine, plugin.id);
	if (snaps && snaps.length >= 2 && delta != null) {
		refs.sparkPath.setAttribute("d", sparkPathD(snaps));
		refs.spark.setCssStyles({ display: "" });
		// 增速方向：正向上翘用强调色，平/负用中性灰
		refs.spark.classList.toggle("pt-card-spark--flat", delta <= 0);
		if (showDl) refs.dlText.textContent = `${formatDownloads(dl)} · +${formatDownloads(delta)}/30d`;
	} else {
		refs.spark.setCssStyles({ display: "none" });
		refs.spark.classList.remove("pt-card-spark--flat");
		// 已有 1 个采样点但不足 2 点时不显示趋势标签，仅保留下载量数字
	}
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

	// 排序可解释性：召回信号徽标（向量/关键词/标题/AI 精排）
	// signals 仅在 AI / 本地语义搜索时由 translator 填充，故存在即可显示，无需再判搜索模式
	const matchSigs = ctx.aiSearchResult?.signals?.[plugin.id];
	if (matchSigs && matchSigs.length > 0) {
		refs.matchSignals.setCssStyles({ display: "" });
		refs.matchSignals.replaceChildren();
		for (const sig of matchSigs) {
			const label = MATCH_SIGNAL_LABELS[sig] ?? sig;
			const chip = refs.matchSignals.createSpan({ cls: `pt-match-signal pt-match-signal--${sig}`, text: label });
			chip.setAttribute("title", t("card.matchSignal.title").replace("{sig}", label));
		}
	} else {
		refs.matchSignals.setCssStyles({ display: "none" });
		refs.matchSignals.replaceChildren();
	}

	// 元信息：作者
	refs.authorName.textContent = (plugin.author);
	refs.authorSpan.setAttribute("title", t("card.author.tip").replace("{author}", plugin.author));

	// 可更新徽标：官方版本领先本地（仅已装插件），点击跳 Obsidian 社区插件更新入口
	// 受设置 notifyInstalledUpdates 开关控制（轻量更新提醒，无后台推送）
	const ub = refs.updateBadge;
	const outdated = !!settings.notifyInstalledUpdates && !!ctx.outdatedIds?.has(plugin.id);
	if (outdated && ub) {
		const info = ctx.outdatedInfo?.get(plugin.id);
		const label = info ? `可更新 ${info.local} → ${info.latest}` : "可更新";
		ub.textContent = ("↑ " + (info ? `可更新 ${info.latest}` : "可更新"));
		ub.setAttribute("title", label);
		ub.setCssStyles({ display: "" });
	} else if (ub) {
		ub.setCssStyles({ display: "none" });
	}

	// 维护健康度：纯文字表达，融入作者行（与竞品 health.ts 同数据，去掉彩色胶囊样式）
	// 受设置 showHealthBadge 开关控制；阈值由 healthHealthyDays / healthAgingDays 自定义
	const hb = refs.healthBadge;
	if (settings.showHealthBadge) {
		const health = assessHealth(
			plugin.updated,
			Date.now(),
			settings.healthHealthyDays,
			settings.healthAgingDays,
		);
		const healthLabel = health.level === "healthy" ? "活跃" : health.level === "aging" ? "维护放缓" : "停更风险";
		hb.textContent = healthLabel;
		hb.setAttribute("title", `维护状态：${health.reason}`);
		hb.className = "pt-card-health-badge";
		hb.setCssStyles({ display: "" });
	} else {
		hb.setCssStyles({ display: "none" });
	}

	// 「新」标记：近 30 天首次见的插件，纯文字融入作者行（newness.ts 窗口判定，可配置）
	const nb = refs.newBadge;
	if (isNewPlugin(ctx.firstSeenMap?.get(plugin.id))) {
		nb.textContent = "新";
		nb.setCssStyles({ display: "" });
	} else {
		nb.setCssStyles({ display: "none" });
	}
}
