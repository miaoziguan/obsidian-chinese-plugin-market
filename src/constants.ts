import type { SearchMode } from "./filter";
import type { I18nKey } from "./i18n";

/**
 * 全局常量集中处（审计 P2-4）。
 *
 * 此前 `VIEW_TYPE` / `LAYOUT` / `SEARCH_MODES` / `PLUGINS_URL` 定义在中枢模块
 * `translator-view.ts`，导致 view-* 模块跨文件引用 `translator-view` 的常量，
 * 形成不必要的耦合。现统一收敛到本文件作为唯一来源，view 模块改从 `./constants` 引入。
 */

export const VIEW_TYPE = "chinese-plugin-market-view";

/**
 * 布局 / 虚拟滚动 / 交互相关的可调常量集中处，
 * 避免魔法数字散落在渲染逻辑各处。
 */
export const LAYOUT = {
	/** 视口上下额外缓冲行数（预渲染，减少快速滚动白屏） */
	OVERSCAN: 6,
	/** 固定卡片行高（px），与 CSS `.pt-card { height: var(--pt-card-h, 200px) }` 对齐。
	 *  P0 滚动根治：卡片高度编译期确定 → 每行高恒定 → 虚拟滚动退化为固定网格。 */
	DEFAULT_ROW_H: 200,
	/** 卡片行间距默认值（px），运行时会被 CSS grid 实测值覆盖 */
	DEFAULT_ROW_GAP: 8,
	/** 单张卡片的最小宽度（px），用于计算列数。
	 *  取 280：在 ~580px 宽的侧栏里也能排 2 列，避免单列时每屏卡片过少、像「只加载了一部分」。 */
	MIN_CARD_W: 280,
	/** 网格左右内边距合计（px，= --pt-space-xs * 2） */
	GRID_PAD_X: 8,
	/** 搜索输入 debounce 间隔（ms） */
	SEARCH_DEBOUNCE_MS: 200,
	/** 社区插件列表本地快照有效期（ms）。超期后下次搜索静默重拉，保证能看到新上架插件。
	 * 官方 community-plugins.json 更新频率极低（仅新插件上架追加），故放宽到 7 天，
	 * 避免每次启动（或短间隔重开）都重拉 1 万条列表 + 重译可见窗口。 */
	LIST_TTL_MS: 7 * 24 * 60 * 60 * 1000,
	/** N4 优化：spacer「收缩」方向的写入容差（px）。仅在尚有未实测行（估算噪声大）时生效，
	 *  吸收 estH 估算反复抖动导致的每屏数百次 spacer 缩写强制 reflow。变高方向始终严格 1px，
	 *  全部行实测后收缩也回到 1px，保证末帧总高偏差收敛到 0。 */
	SPACER_SHRINK_TOL_PX: 8,
	/** 可见窗口预取余量（行）：上下各多渲染 N 行，滚动进入视口前提前就绪，消除白屏。 */
	PREFETCH_ROWS: 3,
	/** 搜索闪烁反馈（示例词/回车高亮）自动移除延时（ms）。 */
	SEARCH_FLASH_MS: 600,
	/** 打开视图后自动聚焦搜索框的延时（ms），等布局稳定再夺焦避免跳动。 */
	FOCUS_DELAY_MS: 80,
} as const;

/** 搜索模式定义（顺序即 Tab 顺序）。label/placeholder 用 i18n key，渲染时取 t()。 */
export const SEARCH_MODES: { id: SearchMode; label: I18nKey; placeholder: I18nKey }[] = [
	{ id: "keyword", label: "mode.keyword", placeholder: "placeholder.keyword" },
	{ id: "local", label: "mode.local", placeholder: "placeholder.local" },
	{ id: "ai", label: "mode.ai", placeholder: "placeholder.ai" },
];

export const PLUGINS_URL =
	"https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json";
