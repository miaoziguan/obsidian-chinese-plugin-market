/**
 * 顶部工具栏构建（P2-1 God file 拆分：从 view-chrome.ts 的 loadAndRender 抽出）。
 *
 * 负责搜索框 / 模式选择 / 排序菜单 / 来源·分类·作者·安装筛选 / 可折叠高级区
 * 的 DOM 构建与事件绑定。返回 { searchInput } 供 loadAndRender 后续（自动聚焦、"/" 快捷键）使用。
 */

import { setIcon, Menu, Notice } from "obsidian";
import { isMobileEnvironment } from "@shared/platform";
import { type I18nKey } from "@shared/i18n";
import { type SearchMode, type InstallFilter, type FavoriteFilter } from "@domain/filter/filter";
import { renderFacetChips } from "@ui/components/facet-chips";
import { setListState } from "@ui/dom/list-state";
import { isAIMode, isKeywordMode, isLocalMode } from "@domain/search/search-mode";
import { q } from "@ui/dom/dom";
import { LAYOUT, SEARCH_MODES } from "@shared/constants";
import { type SortBy } from "@domain/filter/sort";
import type { ViewContext } from "@ui/view/view-context";
import { asAppInternals } from "@data/platform/obsidian-internals";
import { refreshOutdated } from "@ui/view/view-data";

/**
 * 跨工具栏构建块与 loadAndRender 尾部共享的可变状态。
 * 高级面板展开/收起动画期间用 suppressResizeMeasure 抑制虚拟滚动重测，
 * advancedAnimTimer 是其收尾补测定时器句柄；二者需由尾部 ResizeObserver 读取，
 * 故通过参数穿透闭包边界（否则只能挂在 ctx 上）。
 */
export interface ToolbarState {
	suppressResizeMeasure: boolean;
	advancedAnimTimer: number;
}

/**
 * 兜底：测量所有 facet 标签（来源/分类/作者/安装）的实测渲染宽度并取最大值，
 * 统一设 minWidth，保证各行标签左缘像素级对齐。
 */
export function alignFacetLabels(scope: HTMLElement) {
	const labels = scope.querySelectorAll<HTMLElement>(".pt-facet-row > .pt-facet-label");
	if (labels.length === 0) return;
	let max = 0;
	labels.forEach((l) => {
		max = Math.max(max, l.offsetWidth);
	});
	if (max === 0) max = 64;
	const flexVal = `0 0 ${max}px`;
	labels.forEach((l) => {
		l.setCssStyles({ flex: flexVal });
	});
}

export function buildToolbar(ctx: ViewContext, state: ToolbarState): { searchInput: HTMLInputElement } {
	const container = ctx.contentEl;
		const header = container.createDiv({ cls: "pt-header" });

		// ── 单行头部：搜索框(flex:1) + 模式下拉 + ⚙折叠 + ↻刷新 ──
		let facetContainer: HTMLElement | null = null;
		const headerRow = header.createDiv({ cls: "pt-header-row" });

		// 搜索框容器：组合输入（segmented）——左段=搜索模式选择器，右段=内容输入区，
		// 二者共享一个外框并以竖分隔线连体，让用户一眼看出「选模式 + 输入内容」而非误认作排序标签。
		const searchBar = headerRow.createDiv({ cls: "pt-search" });

	// ── 左段：搜索模式选择器（内嵌于搜索框，替代原孤立的右侧下拉，强化可发现性）──
	// 用 .pt-mode-wrap 包裹 select + 真实 caret 节点：<select> 在 WebKit 下不渲染
	// ::after 伪元素（mask SVG 与 "▾" 文字均不显示），箭头必须是真实 DOM 节点。
	const modeWrap = searchBar.createDiv({ cls: "pt-mode-wrap" });
	const modeSelect = modeWrap.createEl("select", { cls: "pt-mode-select pt-search-mode" });
	modeSelect.setAttribute("aria-label", "搜索模式");
	modeSelect.setAttribute("title", "切换搜索模式：关键词 / AI 语义");
	for (const mode of SEARCH_MODES) {
		const opt = modeSelect.createEl("option", { text: ctx.t(mode.label) });
		opt.value = mode.id;
	}
	modeSelect.value = ctx.searchMode;
	// 真实 DOM 箭头元素（绝不用伪元素，WebKit 不渲染 <select> 伪元素）；
	// span 不放文本，箭头由 CSS border 画（一致、清晰、可控大小）。
	modeWrap.createSpan({ cls: "pt-mode-caret" });

		// ── 右段：内容输入区（放大镜 + 输入框 + 清除 + AI 徽章，独立定位上下文）──
		const searchField = searchBar.createDiv({ cls: "pt-search-field" });
		const searchInput = searchField.createEl("input", {
			type: "text",
			placeholder: ctx.t(SEARCH_MODES[0].placeholder),
			cls: "pt-search-input",
		});
		
		// 一键清除按钮
		const clearBtn = searchField.createEl("button", {
			cls: "pt-search-clear",
			attr: { "aria-label": "清除搜索", title: "清除", type: "button" },
		});
		setIcon(clearBtn, "x");
		clearBtn.setCssStyles({ display: "none" });
		
		// AI 搜索状态徽章（仅语义模式显示）：展示「按 Enter 触发」契约 + 未配置 Key 引导。
		// 关键词模式隐藏；语义模式下文案直接告知用户需按 Enter，避免「输入即搜」习惯导致以为搜索失效。
		const aiBadge = searchField.createSpan({ cls: "pt-ai-badge pt-ai-off" });
		const updateModeBadge = () => {
			if (!isAIMode(ctx) && !isLocalMode(ctx)) {
				aiBadge.setCssStyles({ display: "none" });
				clearBtn.setCssStyles({ right: "" }); // keyword 模式：恢复 CSS 默认 right
				return;
			}
			aiBadge.setCssStyles({ display: "" });
			const hasKey = ctx.settings.aiSearchEnabled && ctx.settings.aiSearchApiKey;
			if (ctx.searchMode === "ai") {
				if (hasKey) {
					aiBadge.className = "pt-ai-badge pt-ai-ready";
					aiBadge.setText("AI · Enter 触发");
					aiBadge.setAttribute("title", "AI 语义搜索：输入需求后按 Enter 触发");
				} else {
					// 无 Key 时仍可点击引导配置：感知门槛从「灰掉不可用」→「点我试试」
					aiBadge.className = "pt-ai-badge pt-ai-off";
					aiBadge.setText("配置 AI · Enter");
					aiBadge.setAttribute("title", "点击配置 AI 搜索，用自然语言描述需求，按 Enter 触发");
				}
				// 清除按钮在 badge 左侧动态让位，避免不同文案长度导致重叠
				// 用 requestAnimationFrame 等一次布局，确保 offsetWidth 已包含新文案
				window.requestAnimationFrame(() => {
					const w = aiBadge.offsetWidth;
					clearBtn.style.right = w > 0 ? `${w + 10}px` : "";
				});
			} else {
				// 本地语义：无需 Key、无需联网；且 badge 与左侧下拉标签重复，本地模式直接隐藏
				aiBadge.setCssStyles({ display: "none" });
				aiBadge.setAttribute("title", "");
				clearBtn.setCssStyles({ right: "" }); // 本地语义 badge 已隐藏，清除按钮用默认 right
			}
		};
		// 无 Key 的 AI 模式点击徽章跳设置；本地模式不显示 badge
		aiBadge.addEventListener("click", () => {
			if (ctx.searchMode === "ai" && !(ctx.settings.aiSearchEnabled && ctx.settings.aiSearchApiKey)) {
				asAppInternals(ctx.app).setting?.openTabById?.(ctx.manifest.id);
			}
		});
		updateModeBadge();
		searchBar.toggleClass("pt-search-ai", isAIMode(ctx));
		searchBar.toggleClass("pt-search-local", isLocalMode(ctx));
		
		// 模式切换处理（下拉已内嵌于搜索框左段，见上方 searchBar 构建）
		modeSelect.addEventListener("change", () => {
			const newMode = modeSelect.value as SearchMode;
			if (ctx.searchMode === newMode) return;
			ctx.searchMode = newMode;
			// H1 双保险：模式切换即失效前缀缓存（filter.ts 的 lastFilterMode 判定为第一道防线）
			ctx.filterCache.reset();
			ctx.track(`search:${newMode}`);
			ctx.announceStatus(`已切换到${ctx.t(`mode.${newMode}` as I18nKey)}模式`);
			// 切换模式时重置跨模式状态（避免残留导致用户困惑）
			ctx.sortFavoritesFirst = false;
			ctx.authorFilter = null;
			ctx.installFilter = "all";
			ctx.favoriteFilter = "all";
			// 同步对应 UI 控件视觉态，避免「按钮仍按下但筛选已失效」的困惑（#30）
			// 「已安装/已启动/已安装未启动」按钮：aria-pressed 与文案复位
			q(ctx.contentEl, ".pt-toggle-uninstalled")?.setAttribute("aria-pressed", "false");
			q(ctx.contentEl, ".pt-toggle-uninstalled")?.setText("已安装");
			q(ctx.contentEl, ".pt-toggle-enabled")?.setAttribute("aria-pressed", "false");
			q(ctx.contentEl, ".pt-toggle-enabled")?.setText("已启动");
			q(ctx.contentEl, ".pt-toggle-installed-off")?.setAttribute("aria-pressed", "false");
			q(ctx.contentEl, ".pt-toggle-installed-off")?.setText("已安装未启动");
			// 「已收藏/未收藏」按钮：aria-pressed 与文案复位
			q(ctx.contentEl, ".pt-toggle-favorites")?.setAttribute("aria-pressed", "false");
			q(ctx.contentEl, ".pt-toggle-favorites")?.setText("已收藏");
			q(ctx.contentEl, ".pt-toggle-unfavorites")?.setAttribute("aria-pressed", "false");
			q(ctx.contentEl, ".pt-toggle-unfavorites")?.setText("未收藏");
			// 排序菜单「收藏优先」项 active 态复位
			const favItemEl = q(ctx.contentEl, ".pt-sort-menu-item--fav");
			if (favItemEl) favItemEl.classList.remove("pt-sort-menu-item--active");
			// 作者筛选：下方会调用 ctx.renderAuthorFacet() 按 authorFilter=null 重建 chips，清空高亮
			const modeDef = SEARCH_MODES.find((m) => m.id === newMode)!;
			searchInput.setAttribute("placeholder", ctx.t(modeDef.placeholder));
			if (newMode === "keyword") {
				ctx.aiSearchResult = null;
				ctx.aiSearchQueryCache = "";
				ctx.selectedCategories = [];
			const aiBtn = q(ctx.contentEl, '.pt-filter[data-value="ai"]');
			if (aiBtn) aiBtn.setCssStyles({ display: "" });
				facetContainer?.querySelectorAll(".pt-filter").forEach((el) => {
					el.setAttribute("aria-pressed", "false");
				});
				// 重新同步来源筛选高亮（上方循环会误伤来源筛选按钮）
				ctx.contentEl.querySelectorAll(".pt-source-filters .pt-filter").forEach((el) => {
					el.setAttribute("aria-pressed", (el as HTMLElement).dataset.value === ctx.sourceFilter ? "true" : "false");
				});
			} else {
			if (newMode === "local") {
				// 进入本地语义模式：清空上次 AI/语义结果（本地搜索是全新的一次 RRF 融合）
				ctx.aiSearchResult = null;
				ctx.aiSearchQueryCache = "";
				ctx.selectedCategories = [];
			} else {
				// 3a: 切回 AI 模式时，若当前 query 与最近一次 AI 搜索相同，复用缓存结果（无需重新 Enter）
				const qry = ctx.searchQuery.trim();
				const catsUnchanged = ctx.selectedCategories.length === 0;
				if (qry && qry === ctx.lastAiSearchQuery && ctx.lastAiSearchResult && catsUnchanged) {
						ctx.aiSearchResult = ctx.lastAiSearchResult;
						ctx.aiSearchQueryCache = ctx.lastAiSearchQuery;
					}
				}
			}
			updateModeBadge();
			searchBar.toggleClass("pt-search-ai", newMode === "ai");
			searchBar.toggleClass("pt-search-local", newMode === "local");
			if (facetContainer) {
				ctx.updateFacetVisibility();
				// 分类行 AI/keyword 模式均可见，切换模式后重建 chips 保证选中态与数据一致
				renderChips();
				// keyword/ai 模式下重渲染作者 chips（数据可能已加载，列表已就绪）
				ctx.renderAuthorFacet();
			}
			ctx.updateGuidance();
			ctx.scheduleRender();
			searchInput.focus();
		});
		
		// 根据搜索框内容同步清除按钮可见性
		const syncClearBtn = () => {
			clearBtn.setCssStyles({ display: searchInput.value.length > 0 ? "" : "none" });
		};

		// 清除按钮：清空输入 → 立即重新过滤 → 重新聚焦搜索框
		clearBtn.addEventListener("click", () => {
			searchInput.value = "";
			ctx.searchQuery = "";
			// AI 结果随查询清空一并失效
			ctx.aiSearchResult = null;
			ctx.aiSearchQueryCache = "";
			// 仅清空搜索文本，不重置筛选状态（避免破坏用户已设置的筛选条件）
			syncClearBtn();
			searchInput.focus();
			// 清空搜索 → 回到全量列表（不再回引导态）；rAF 延迟渲染，清除按钮点击不阻塞
			ctx.scheduleRender();
		});

		// ── 结果计数（margin-left:auto 推到右侧，与排序/筛选组成搜索行右侧簇） ──
		const resultCountText = headerRow.createSpan({ cls: "pt-result-count" });
		ctx.resultCountEl = resultCountText;
		// 挂载后立即按当前 listState 同步可见性（仅 list 态显示）
		setListState(ctx, ctx.listState);

		// ── 排序按钮（仅图标，点击展开排序菜单） ──
		const sortWrap = headerRow.createDiv({ cls: "pt-sort-wrap" });

		// ── 组合下拉（场景切换，非筛选：点击弹 Menu 列出 profile 一键应用） ──
		const profileBtn = headerRow.createEl("button", {
			cls: "pt-profile-dropdown",
			attr: { "aria-label": "切换启用组合", type: "button" },
		});
		// 图标用「图层 layers」而非「切换 switch」：组合表达的是「一组启用方案/场景预设」，
		// 叠层意象比箭头交换更精准（箭头更像切换排序方向等）。
		setIcon(profileBtn, "layers");
		const buildProfileMenu = (): Menu | null => {
			if (ctx.profiles.length === 0) {
				new Notice("暂无组合预设，可在设置 → 插件启用组合中保存当前启用集");
				return null;
			}
			const menu = new Menu();
			for (const p of ctx.profiles) {
				menu.addItem((item) =>
					item
						.setTitle(`${p.name}（${p.enabled.length}）`)
						.onClick(() => {
							// 应用组合 + 切到「已安装」视角，立即看到启用集变化
							ctx.installFilter = "installed";
							updateInstallToggles();
							ctx.updateFacetVisibility();
							ctx.track("profile:apply");
							void ctx.applyProfile(p).then(() => ctx.scheduleRender(true));
						})
				);
			}
			return menu;
		};
		profileBtn.addEventListener("click", (ev: MouseEvent) => {
			const menu = buildProfileMenu();
			if (menu) menu.showAtMouseEvent(ev);
		});
		profileBtn.addEventListener("keydown", (ev: KeyboardEvent) => {
			if (ev.key === "Enter" || ev.key === " ") {
				ev.preventDefault();
				// 键盘触发 Menu：用按钮位置定位（无鼠标事件可用）
				const menu = buildProfileMenu();
				if (menu) {
					const rect = profileBtn.getBoundingClientRect();
					menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
				}
			}
		});

		// AI 一键翻译（纯图标按钮，置于排序↕与刷新↻之间；无待翻译项时自动隐藏）
		ctx.aiTranslateBtnEl = headerRow.createEl("button", {
			cls: "pt-ai-icon-btn",
			attr: { "aria-label": ctx.t("action.aiTranslate"), type: "button" },
		});
		setIcon(ctx.aiTranslateBtnEl, "sparkles");
		ctx.aiProgressEl = headerRow.createSpan({ cls: "pt-ai-progress" });
		ctx.aiProgressEl.setCssStyles({ display: "none" });
		// 抽取为命名处理器：移动端溢出菜单与图标按钮共用同一动作
		const onAiTranslate = () => {
			if (ctx.aiTranslateRunning) return;
			ctx.track("action:ai_translate");
			// 无论当前是否已在「未翻译」筛选，点击都应立即反应：
			// 若未切到 original 筛选，先切过去（让用户看到待翻译项），并**同时**触发翻译，
			// 避免「第一次点击只是切筛选、要再点一次才翻译」的「没反应」体验。
			if (ctx.sourceFilter !== "original") {
				ctx.sourceFilter = "original";
				ctx.settings.sourceFilter = "original";
				void ctx.saveSettings();
				ctx.contentEl.querySelectorAll(".pt-source-filters .pt-filter").forEach((el) => {
					el.setAttribute("aria-pressed", el.getAttribute("data-value") === "original" ? "true" : "false");
				});
				ctx.scheduleRender();
			}
			ctx.updateFacetVisibility();
			void ctx.aiTranslateAllPending();
		};
		ctx.aiTranslateBtnEl.addEventListener("click", onAiTranslate);
		ctx.updateAiTranslateButton();

		// 手动刷新按钮（↻）：全局动作，与排序同组置于搜索行右上角
		const refreshBtn = headerRow.createEl("button", {
			cls: "pt-refresh",
			attr: { "aria-label": ctx.t("action.refresh"), title: ctx.t("action.refresh"), type: "button" },
		});
		setIcon(refreshBtn, "refresh-cw");
		ctx.refreshBtn = refreshBtn;
		ctx.updateRefreshTooltip();
		const onRefresh = () => { ctx.track("action:refresh"); void ctx.refreshData(); };
		refreshBtn.addEventListener("click", onRefresh);

		// 一键检查已安装插件更新（独立于「刷新列表」：只检测已装插件是否有新版，不拉市场数据）
		const checkUpdateBtn = headerRow.createEl("button", {
			cls: "pt-check-update",
			attr: { "aria-label": ctx.t("action.checkUpdate"), title: ctx.t("action.checkUpdate"), type: "button" },
		});
		setIcon(checkUpdateBtn, "download-cloud");
		const onCheckUpdate = () => {
			ctx.track("action:checkUpdate");
			checkUpdateBtn.addClass("pt-spin");
			void refreshOutdated(ctx)
				.then(() => {
					const n = ctx.outdatedIds?.size ?? 0;
					if (n <= 0) new Notice(ctx.t("action.checkUpdate.upToDate"));
					else new Notice(ctx.t("action.checkUpdate.available", { n: String(n) }));
				})
				.catch(() => new Notice(ctx.t("action.checkUpdate.failed")))
				.finally(() => checkUpdateBtn.removeClass("pt-spin"));
		};
		checkUpdateBtn.addEventListener("click", onCheckUpdate);

		// 折叠开关（筛选总入口，点 ▾ 展开来源 / 分类 / 作者 / 安装）— 置于搜索行最右
		const toggleBtn = headerRow.createEl("button", {
			cls: "pt-toggle-filters pt-toggle-filters--text",
			attr: { "aria-label": "展开高级筛选", "aria-expanded": "false" },
		});
		const filterIcon = toggleBtn.createSpan({ cls: "pt-toggle-filters-icon" });
		setIcon(filterIcon, "filter");
		toggleBtn.createSpan({ cls: "pt-toggle-filters-label", text: "筛选" });
		const filterCaret = toggleBtn.createSpan({ cls: "pt-toggle-filters-caret", text: "▾" });

		// 一键直达本插件设置页（齿轮，置于搜索行最右端）：低频操作，从前端面板直接进设置，
		// 免去找 Obsidian 设置面板的层级。先 open 再 openTabById（设置未弹出时后者不生效）。
		const settingsBtn = headerRow.createEl("button", {
			cls: "pt-icon-btn pt-open-settings",
			attr: { "aria-label": ctx.t("card.openSettings"), title: ctx.t("card.openSettings"), type: "button" },
		});
		setIcon(settingsBtn, "gear");
		settingsBtn.addEventListener("click", (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			const setting = asAppInternals(ctx.app).setting;
			setting?.open?.();
			setting?.openTabById?.(ctx.manifest.id);
		});

		// #7: 移动端工具栏折叠。窄屏下「刷新 / AI 翻译」等次要按钮收进右上角 ⋮ 溢出菜单，
		// 避免与搜索框/排序/筛选挤在同一行导致换行或溢出。保留排序↕与筛选▾（核心、图标紧凑）。
		if (isMobileEnvironment()) {
			refreshBtn.setCssStyles({ display: "none" });
			checkUpdateBtn.setCssStyles({ display: "none" });
			ctx.aiTranslateBtnEl.setCssStyles({ display: "none" });
			const overflowBtn = headerRow.createEl("button", {
				cls: "pt-overflow-btn",
				attr: { "aria-label": "更多操作", "aria-haspopup": "menu", type: "button" },
			});
			setIcon(overflowBtn, "more-vertical");
			overflowBtn.addEventListener("click", (e: MouseEvent) => {
				const menu = new Menu();
				menu.addItem((item) =>
					item
						.setTitle(ctx.t("action.refresh"))
						.setIcon("refresh-cw")
						.onClick(() => onRefresh())
				);
				menu.addItem((item) =>
					item
						.setTitle(ctx.t("action.checkUpdate"))
						.setIcon("download-cloud")
						.onClick(() => onCheckUpdate())
				);
				menu.addItem((item) =>
					item
						.setTitle(ctx.t("action.aiTranslate"))
						.setIcon("sparkles")
						.onClick(() => onAiTranslate())
				);
				menu.showAtMouseEvent(e);
			});
		}

		const sortBtn = sortWrap.createEl("button", {
			cls: "pt-sort-btn",
			attr: { "aria-label": "排序方式", type: "button" },
		});
		setIcon(sortBtn, "arrow-up-down");

		const sortMenu = sortWrap.createDiv({ cls: "pt-sort-menu" });

		const sortDefs: [SortBy, string][] = [
			["relevance", "按相关度"],
			["recommended", "智能推荐"],
			["trending", "近期热门"],
			["downloads", "按下载量"],
			["updated", "按更新时间"],
			["published", "按发布时间"],
			["popular", "按决策价值"],
			["name", "按名称排序"],
		];

		for (const [value, label] of sortDefs) {
			const item = sortMenu.createEl("button", {
				cls: "pt-sort-menu-item",
				text: label,
				attr: { type: "button" },
			});
			item.setAttribute("data-sort", value);
			if (value === ctx.sortBy) item.classList.add("pt-sort-menu-item--active");
			item.addEventListener("click", () => {
				ctx.sortBy = value;
				ctx.sortFavoritesFirst = false; // 选普通排序时关闭「收藏优先」叠层
				ctx.settings.sortBy = ctx.sortBy;
				ctx.track(`sort:${ctx.sortBy}`);
				void ctx.saveSettings();
				sortMenu.querySelectorAll(".pt-sort-menu-item").forEach((el) =>
					el.classList.remove("pt-sort-menu-item--active")
				);
				item.classList.add("pt-sort-menu-item--active");
				sortWrap.classList.remove("pt-sort-wrap--open");
				ctx.scheduleRender();
			});
		}

		// 「收藏优先」：把收藏项置顶的叠层排序（非独立 sortBy，故单列一项，顶到分隔线之后）
		const favSortItem = sortMenu.createEl("button", {
			cls: "pt-sort-menu-item pt-sort-menu-item--fav",
			text: "★ 收藏优先",
			attr: { type: "button" },
		});
		favSortItem.setAttribute("data-sort", "favorites");
		if (ctx.sortFavoritesFirst) favSortItem.classList.add("pt-sort-menu-item--active");
		favSortItem.addEventListener("click", () => {
			const on = !ctx.sortFavoritesFirst;
			ctx.sortFavoritesFirst = on;
			ctx.track(on ? "sort:favorites_on" : "sort:favorites_off");
			sortMenu.querySelectorAll(".pt-sort-menu-item").forEach((el) =>
				el.classList.remove("pt-sort-menu-item--active")
			);
			if (on) {
				favSortItem.classList.add("pt-sort-menu-item--active");
			} else {
				const cur = q(
					sortMenu,
					`.pt-sort-menu-item[data-sort="${ctx.sortBy}"]`
				);
				cur?.classList.add("pt-sort-menu-item--active");
			}
			sortWrap.classList.remove("pt-sort-wrap--open");
			ctx.scheduleRender();
		});

		sortBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			sortWrap.classList.toggle("pt-sort-wrap--open");
		});
		// 点击外部关闭菜单（stopPropagation 阻止按钮点击冒泡到 document）
		const closeSortMenu = () => sortWrap.classList.remove("pt-sort-wrap--open");
		document.addEventListener("click", closeSortMenu);
		ctx.register(() => document.removeEventListener("click", closeSortMenu));

	



		// 搜索：debounce + 输入法友好（composition 期间不触发）
		ctx.debounceTimer = undefined;
		let composing = false;
		searchInput.addEventListener("compositionstart", () => {
			composing = true;
		});
		searchInput.addEventListener("compositionend", () => {
			composing = false;
			// 输入法结束后立即触发一次
			ctx.applySearchInput();
		});
		const onSearchInput = () => {
			if (composing) return;
			ctx.applySearchInput();
			ctx.updateGuidance();
		};
		searchInput.addEventListener("input", () => {
			// 清除按钮可见性即时同步（不等 debounce）
			syncClearBtn();
			window.clearTimeout(ctx.debounceTimer);
			// 空字符串即时响应（不等 debounce），立即显示引导页/全量列表
			const val = searchInput.value.trim();
			if (val === "" && ctx.searchQuery !== "") {
				ctx.searchQuery = "";
				ctx.aiSearchResult = null;
				ctx.aiSearchQueryCache = "";
				syncClearBtn();
				// 状态即时清空；渲染移到下一帧（scheduleRender 用 rAF 合并），避免全量过滤+渲染阻塞输入帧
				ctx.scheduleRender();
				return;
			}
			ctx.debounceTimer = window.setTimeout(onSearchInput, LAYOUT.SEARCH_DEBOUNCE_MS);
		});

		// Enter 键：AI 模式下触发 AI 搜索；其余模式立即刷新本地过滤
		// （若数据尚未加载，先懒加载再渲染，避免首次直接 Enter 出现空结果）
		searchInput.addEventListener("keydown", (e) => {
			void (async () => {
				// Esc 清空搜索框（符合输入控件直觉）
				if (e.key === "Escape") {
					if (searchInput.value) {
						searchInput.value = "";
						ctx.searchQuery = "";
						ctx.aiSearchResult = null;
						ctx.aiSearchQueryCache = "";
						// Esc 仅清搜索，不重置筛选
					syncClearBtn();
					searchInput.focus();
					ctx.scheduleRender();
				} else if (ctx.authorFilter) {
					// 搜索框为空但处于作者筛选态：Esc 退出作者筛选
					ctx.authorFilter = null;
					ctx.renderAuthorFacet();
					ctx.updateFacetVisibility();
					ctx.scheduleRender();
					} else {
						searchInput.blur();
					}
					return;
				}
				if (e.key !== "Enter") return;
				e.preventDefault();
				if (isAIMode(ctx) || isLocalMode(ctx)) {
					// 语义模式（AI / 本地）由 Enter 触发检索：AI 走 LLM 精排，本地走 RRF 融合排序
					await ctx.runAISearch(searchInput, aiBadge);
				} else {
					if (!ctx.dataLoaded && ctx.plugins.length === 0) {
						const ok = await ctx.ensureDataLoaded();
						if (!ok) return;
					}
					ctx.scheduleRender();
				}
			})();
		});


		// 可折叠高级区：来源 + 统计 + 分类 + 作者 + 安装 统一收进「筛选 ▾」面板（默认收起，点 ▾ 展开）
		const advanced = header.createDiv({ cls: "pt-advanced" });
		const advancedInner = advanced.createDiv({ cls: "pt-advanced-inner" });

		// 面板内区分标题，让折叠时用户知道里面有什么
		const advancedHeading = advancedInner.createDiv({
			cls: "pt-advanced-heading",
		});
		// 左：标题 + 统计（贴在一起）；右：重置按钮
		const titleGroup = advancedHeading.createSpan({ cls: "pt-advanced-title-group" });
		titleGroup.createSpan({ text: "筛选与统计" });
		titleGroup.createSpan({ cls: "pt-stat-sep", text: "·" });
		const stats = titleGroup.createSpan({ cls: "pt-stats" });
		stats.createSpan({ cls: "pt-stat", text: ctx.t("app.loading") + "..." });

		// ── 来源筛选胶囊（随高级区收起，点「筛选 ▾」展开） ──
		const sourceRow = advancedInner.createDiv({ cls: "pt-facet-row" });
		sourceRow.createSpan({ cls: "pt-facet-label", text: "翻译" });
		const sourceFilters = sourceRow.createDiv({ cls: "pt-source-filters" });
		const filterDefs: [string, string][] = [
			["all", "全部"],
			["translated", "已翻译"],
			["original", "未翻译"],
		];
		for (const [value, label] of filterDefs) {
			const btn = sourceFilters.createEl("button", {
				cls: "pt-filter",
				text: label,
			});
			btn.setAttribute("data-value", value);
			btn.setAttribute("aria-pressed", value === ctx.sourceFilter ? "true" : "false");
			// AI 语义模式下，「由AI译」来源筛选无意义（结果集非逐个 AI 翻译），隐藏该选项
			if (value === "ai" && isAIMode(ctx)) {
				btn.setCssStyles({ display: "none" });
			}
			btn.addEventListener("click", () => {
				ctx.sourceFilter = value as typeof ctx.sourceFilter;
				sourceFilters.querySelectorAll(".pt-filter").forEach((el) => {
					el.setAttribute(
						"aria-pressed",
						(el as HTMLElement) === btn ? "true" : "false"
					);
				});
			ctx.settings.sourceFilter = ctx.sourceFilter;
			ctx.track(`filter:source_${ctx.sourceFilter}`);
			ctx.saveSettings();
			// rAF 延迟渲染：点击立即响应（aria-pressed 已更新），全量过滤+渲染移出点击帧，避免筛选卡顿
			ctx.scheduleRender(true);
		});
		}


	// 用法 B：分类 facet 筛选器（多选分类，支持 AI/关键字模式全局发现维度）
	// AI/keyword 模式均可见；分类数据可能晚于初始渲染（懒加载），切换模式时按最新 pluginTags 重建 chips。
	facetContainer = advancedInner.createDiv({
		cls: "pt-ai-facets",
	});
	facetContainer.setCssStyles({ display: isAIMode(ctx) ? "" : "none" });
	ctx.facetContainerEl = facetContainer;
	// 分类行：AI/keyword 模式可见（标签离线预生成覆盖全量，作为全局发现维度）
	const catRow = facetContainer.createDiv({ cls: "pt-facet-row" });
	ctx.catRowEl = catRow;
	catRow.createSpan({ cls: "pt-facet-label", text: ctx.t("facet.category") });
		const catChips = catRow.createDiv({ cls: "pt-facet-chips" });
		let catExpanded = false;
		const renderChips = () => {
			const tagService = ctx.translator.tagService;
			const categories = tagService ? tagService.getAllCategories() : [];
			if (categories.length === 0) {
				catChips.empty();
				catChips.createSpan({
					cls: "pt-facet-empty-hint",
					text: ctx.t("facet.noData"),
				});
				return;
			}
			renderFacetChips(
				catChips,
				categories,
				ctx.selectedCategories,
				(cat) => {
					const idx = ctx.selectedCategories.indexOf(cat);
					if (idx >= 0) {
						ctx.selectedCategories.splice(idx, 1);
					} else {
						ctx.selectedCategories.push(cat);
					}
					// 重建 chips，保证 aria-pressed 视觉状态与 selectedCategories 同步
					renderChips();
					// keyword 模式下即时过滤，AI 模式由 Enter 统一触发；rAF 延迟列表渲染，点击不阻塞
					if (isKeywordMode(ctx)) ctx.scheduleRender(true);
				},
				{
					maxVisible: 6,
					expanded: catExpanded,
					onToggleExpand: () => {
						catExpanded = !catExpanded;
						renderChips();
					},
				}
			);
		};
		renderChips();
		// T4(#7): 暴露给插件回调，标签后台加载完成后触发重渲染
		ctx.refreshFacets = renderChips;
		// 作者行：多插件作者（作品数≥2）作为快捷筛选；keyword/ai 模式均可见，长尾单插件作者不进 facet。
		// 卡片作者名钻取与作者 facet 共用 authorFilter 状态。
		const authorRow = facetContainer.createDiv({ cls: "pt-facet-row" });
		ctx.authorRowEl = authorRow;
		authorRow.createSpan({ cls: "pt-facet-label", text: ctx.t("facet.author") });
		const authorChips = authorRow.createDiv({ cls: "pt-facet-chips" });
		ctx.authorFacetEl = authorChips;
		ctx.renderAuthorFacet();
		ctx.updateFacetVisibility();
		ctx.updateGuidance(); // 初始渲染模式引导（无查询时显示）

		// ── 安装筛选（已安装 / 已启动 / 已安装未启动），收进面板统一筛选入口 ──
		const installRow = advancedInner.createDiv({ cls: "pt-facet-row" });
		installRow.createSpan({ cls: "pt-facet-label", text: "安装" });
		const installChips = installRow.createDiv({ cls: "pt-facet-chips" });

		const installToggleDefs: { cls: string; on: InstallFilter; label: string; track: string }[] = [
			{ cls: "pt-toggle-uninstalled", on: "installed", label: "已安装", track: "filter:installed" },
			{ cls: "pt-toggle-enabled", on: "enabled", label: "已启动", track: "filter:enabled" },
			{ cls: "pt-toggle-installed-off", on: "installedNotEnabled", label: "已安装未启动", track: "filter:installedNotEnabled" },
		];
		const installToggles = installToggleDefs.map((def) =>
			installChips.createEl("button", { cls: `pt-filter ${def.cls}`, text: def.label })
		);

		const updateInstallToggles = () => {
			installToggles.forEach((el, i) => {
				const def = installToggleDefs[i];
				const active = ctx.installFilter === def.on;
				el.setAttribute("aria-pressed", active ? "true" : "false");
				el.textContent = active ? "显示全部" : def.label;
			});
		};
		updateInstallToggles();

		installToggles.forEach((el, i) => {
			const def = installToggleDefs[i];
			el.addEventListener("click", () => {
				ctx.installFilter = ctx.installFilter === def.on ? "all" : def.on;
				updateInstallToggles();
				ctx.updateFacetVisibility();
				ctx.track(ctx.installFilter === def.on ? def.track : `${def.track}_off`);
				ctx.scheduleRender(true);
			});
		});

		// ── 收藏筛选（已收藏 / 未收藏），与安装筛选同组 ──
		const favRow = advancedInner.createDiv({ cls: "pt-facet-row" });
		favRow.createSpan({ cls: "pt-facet-label", text: "收藏" });
		const favChips = favRow.createDiv({ cls: "pt-facet-chips" });

		const favToggleDefs: { cls: string; on: FavoriteFilter; label: string; track: string }[] = [
			{ cls: "pt-toggle-favorites", on: "favorited", label: "已收藏", track: "filter:favorites" },
			{ cls: "pt-toggle-unfavorites", on: "unfavorited", label: "未收藏", track: "filter:unfavorites" },
		];
		const favToggles = favToggleDefs.map((def) =>
			favChips.createEl("button", { cls: `pt-filter ${def.cls}`, text: def.label })
		);

		const updateFavToggles = () => {
			favToggles.forEach((el, i) => {
				const def = favToggleDefs[i];
				const active = ctx.favoriteFilter === def.on;
				el.setAttribute("aria-pressed", active ? "true" : "false");
				el.textContent = active ? "显示全部" : def.label;
			});
		};
		updateFavToggles();

		favToggles.forEach((el, i) => {
		const def = favToggleDefs[i];
		el.addEventListener("click", () => {
			ctx.favoriteFilter = ctx.favoriteFilter === def.on ? "all" : def.on;
			updateFavToggles();
			// 收藏筛选为会话级（不持久化）：每次打开插件重置为「全部」，
			// 避免用户误以为默认筛选到「已收藏」（收藏集 favorites 仍持久化）
			ctx.track(ctx.favoriteFilter === def.on ? def.track : `${def.track}_off`);
			ctx.scheduleRender(true);
		});
	});

	// ── 生态筛选（当前实现 = 中文生态；维度可扩展为其它生态） ──
	// 标题用通用词「生态」（维度标签），激活按钮用具体语义「中文生态」（用户看到的是「我在筛什么」）。
	const ecoRow = advancedInner.createDiv({ cls: "pt-facet-row" });
	ecoRow.createSpan({ cls: "pt-facet-label", text: "生态" });
	const ecoChips = ecoRow.createDiv({ cls: "pt-facet-chips" });
	const ecoToggle = ecoChips.createEl("button", { cls: "pt-filter pt-toggle-eco", text: "中文生态" });
	const updateEcoToggle = () => {
		const active = ctx.chineseEcoFilter === "eco";
		ecoToggle.setAttribute("aria-pressed", active ? "true" : "false");
		// 文案始终「中文生态」：激活态靠 aria-pressed 样式区分（点此按钮在「激活/取消」间切换，
		// 无意义变「全部」）。真正的「全部」由工具栏「重置」按钮一键处理，避免按钮身份切换带来的认知负担。
		ecoToggle.textContent = "中文生态";
	};
	updateEcoToggle();
	ecoToggle.addEventListener("click", () => {
		ctx.chineseEcoFilter = ctx.chineseEcoFilter === "eco" ? "all" : "eco";
		updateEcoToggle();
		ctx.track(ctx.chineseEcoFilter === "eco" ? "filter:eco" : "filter:eco_off");
		ctx.scheduleRender(true);
	});

	// ── 系列筛选（开发者自维护系列，如「竹林中国系列」；toggle 全部↔系列） ──
	const seriesRow = advancedInner.createDiv({ cls: "pt-facet-row" });
	seriesRow.createSpan({ cls: "pt-facet-label", text: "系列" });
	const seriesChips = seriesRow.createDiv({ cls: "pt-facet-chips" });
	const seriesToggle = seriesChips.createEl("button", { cls: "pt-filter pt-toggle-series", text: "竹林中国系列" });
	const updateSeriesToggle = () => {
		const active = ctx.seriesFilter === "bamboo";
		seriesToggle.setAttribute("aria-pressed", active ? "true" : "false");
		seriesToggle.textContent = "竹林中国系列";
	};
	updateSeriesToggle();
	seriesToggle.addEventListener("click", () => {
		ctx.seriesFilter = ctx.seriesFilter === "bamboo" ? "all" : "bamboo";
		updateSeriesToggle();
		ctx.track(ctx.seriesFilter === "bamboo" ? "filter:series_bamboo" : "filter:series_bamboo_off");
		ctx.scheduleRender(true);
	});

	// ── 新上线筛选（近 N 天首次见；null = 不过滤） ──
	const newRow = advancedInner.createDiv({ cls: "pt-facet-row" });
	newRow.createSpan({ cls: "pt-facet-label", text: "上线" });
	const newChip = newRow.createDiv({ cls: "pt-facet-chips" });
	// 「上线」过滤：无 "全部" 选项，默认不过滤；点窗口胶囊激活，再点同一胶囊取消
	const NEW_WINDOWS = [1, 3, 7, 30, 90, 365];
	const NEW_LABELS = ["24h", "3天", "7天", "30天", "90天", "1年"];
	const newToggles = NEW_WINDOWS.map((_, i) =>
		newChip.createEl("button", { cls: "pt-filter", text: NEW_LABELS[i] })
	);
	const updateNewToggle = () => {
		newToggles.forEach((el, i) => {
			el.setAttribute("aria-pressed", ctx.newWithinDays === NEW_WINDOWS[i] ? "true" : "false");
		});
	};
	updateNewToggle();
	newToggles.forEach((el, i) => {
		el.addEventListener("click", () => {
			const val = NEW_WINDOWS[i];
			ctx.newWithinDays = ctx.newWithinDays === val ? null : val;
			ctx.settings.newWithinDays = ctx.newWithinDays;
			ctx.saveSettings();
			updateNewToggle();
			ctx.scheduleRender(true);
		});
	});

	// ── 近期更新筛选（近 N 天有版本更新；null = 不过滤） ──
	const updRow = advancedInner.createDiv({ cls: "pt-facet-row" });
	updRow.createSpan({ cls: "pt-facet-label", text: "更新" });
	const updChip = updRow.createDiv({ cls: "pt-facet-chips" });
	// 「更新」过滤：无 "全部" 选项，默认不过滤；点窗口胶囊激活，再点同一胶囊取消
	const UPD_WINDOWS = [1, 3, 7, 30, 90, 365];
	const UPD_LABELS = ["24h", "3天", "7天", "30天", "90天", "1年"];
	const updToggles = UPD_WINDOWS.map((_, i) =>
		updChip.createEl("button", { cls: "pt-filter", text: UPD_LABELS[i] })
	);
	const updateUpdToggle = () => {
		updToggles.forEach((el, i) => {
			el.setAttribute("aria-pressed", ctx.updatedWithinDays === UPD_WINDOWS[i] ? "true" : "false");
		});
	};
	updateUpdToggle();
	updToggles.forEach((el, i) => {
		el.addEventListener("click", () => {
			const val = UPD_WINDOWS[i];
			ctx.updatedWithinDays = ctx.updatedWithinDays === val ? null : val;
			ctx.settings.updatedWithinDays = ctx.updatedWithinDays;
			ctx.saveSettings();
			updateUpdToggle();
			ctx.scheduleRender(true);
		});
	});



		// 重置筛选：移至标题行右侧（与「筛选与统计」同行右端对齐）
		const resetBtn = advancedHeading.createEl("button", {
			cls: "pt-toolbar-reset pt-toolbar-reset--inline",
			text: ctx.t("filter.reset"),
			attr: { "aria-label": "重置所有筛选条件", title: "重置筛选" },
		});
		resetBtn.addEventListener("click", () => {
			ctx.sourceFilter = "all";
			ctx.settings.sourceFilter = "all";
			void ctx.saveSettings();
			sourceFilters.querySelectorAll(".pt-filter").forEach((el) => {
				el.setAttribute("aria-pressed",
					el.getAttribute("data-value") === "all" ? "true" : "false"
				);
			});
			ctx.selectedCategories = [];
			renderChips();
			ctx.authorFilter = null;
			ctx.installFilter = "all";
			updateInstallToggles();
			ctx.favoriteFilter = "all";
			updateFavToggles();
			// 重置中文生态筛选
			ctx.chineseEcoFilter = "all";
			updateEcoToggle();
			// 重置系列筛选
			ctx.seriesFilter = "all";
			updateSeriesToggle();
			// 重置新上线 + 近期更新筛选
			ctx.newWithinDays = null;
			ctx.settings.newWithinDays = null;
			ctx.updatedWithinDays = null;
			ctx.settings.updatedWithinDays = null;
			updateNewToggle();
			updateUpdToggle();
			ctx.renderAuthorFacet();
			// 同步顶部「筛选中」chips 与重置按钮高亮态（仅 scheduleRender 不会触发）
			ctx.updateFacetVisibility();
			ctx.scheduleRender();
		});

		// 折叠交互
		toggleBtn.addEventListener("click", () => {
			const open = advanced.classList.toggle("pt-open");
			filterCaret.textContent = open ? "▴" : "▾";
			toggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
			toggleBtn.setAttribute(
				"aria-label",
				open ? "收起筛选与统计" : "展开筛选与统计"
			);
			// 丝滑优化：展开/收起时面板高度在 180ms 内连续变化，若下方列表视口的
			// ResizeObserver 每帧重测虚拟滚动（measureLayout+fillVisibleWindow）会卡顿。
			// 动画期间抑制重测，结束后补一次即可。
			advanced.classList.add("pt-animating");
			state.suppressResizeMeasure = true;
			window.clearTimeout(state.advancedAnimTimer);
			state.advancedAnimTimer = window.setTimeout(() => {
				state.suppressResizeMeasure = false;
				advanced.classList.remove("pt-animating");
				ctx.measureLayout();
				ctx.fillVisibleWindow();
				// 展开后强制重新对齐标签列（面板折叠时 offsetWidth 可能为 0，展开后才有真实宽度）
				if (open) window.requestAnimationFrame(() => alignFacetLabels(ctx.contentEl));
			}, 200); // 略大于 --pt-duration-normal(180ms)，确保动画收尾后再测
		});
	return { searchInput };
}
