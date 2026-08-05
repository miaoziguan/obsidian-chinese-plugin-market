/**
 * 插件对比功能。
 *
 * 多插件并排对比的洞察摘要与维度渲染（结论 → 理由的启发式规则，零 AI 依赖）。
 */

import { renderComparePage, disposeComparePage } from "./compare-view";
import { q } from "./dom";
import type { ViewContext } from "./view-context";

export function updateCompareTray(ctx: ViewContext) {

		const n = ctx.compareSet.size;
		if (n === 0) {
			ctx.removeCompareTray();
			ctx.refreshCompareHighlights();
			return;
		}
		if (!ctx.compareTrayEl) {
			ctx.compareTrayEl = ctx.contentEl.createDiv({ cls: "pt-compare-tray" });
		}
		const tray = ctx.compareTrayEl;
		tray.empty();
		tray.createSpan({
			cls: "pt-compare-tray-title",
			text: ctx.t("compare.tray.title", { n: String(n) }),
		});
		const openBtn = tray.createEl("button", {
			cls: "pt-compare-tray-open",
			text: ctx.t("compare.tray.open", { n: String(n) }),
		});
		if (n < 2) {
			openBtn.disabled = true;
			openBtn.title = ctx.t("compare.tray.min");
		}
		openBtn.onclick = () => ctx.openCompareModal();
		const clearBtn = tray.createEl("button", {
			cls: "pt-compare-tray-clear",
			text: ctx.t("compare.tray.clear"),
		});
		clearBtn.onclick = () => {
			ctx.compareSet.clear();
			// 同步落盘：否则仅清内存态，重启/重开视图时 onOpen 会从
			// settings.compare 把已清空的对比集完整复活
			ctx.settings.compare = [];
			void ctx.flushSaveSettings();
			ctx.removeCompareTray();
			ctx.refreshCompareHighlights();
		};
		// 托盘重建后同步所有同类卡片对比图标状态
		ctx.refreshCompareHighlights();
	
}

export function openCompareModal(ctx: ViewContext) {

		if (ctx.compareSet.size < 2) return;
		// 从完整插件列表收集选中项
		const plugins = ctx.plugins.filter(p => ctx.compareSet.has(p.id));
		if (plugins.length < 2) return;
		ctx.enterCompareMode();
	
}

export function enterCompareMode(ctx: ViewContext) {

		if (ctx.compareSet.size < 2) return;
		const plugins = ctx.plugins.filter(p => ctx.compareSet.has(p.id));
		if (plugins.length < 2) return;
		// 互斥：关闭详情 Drawer
		ctx.activeDrawer?.close();
		ctx.activeDrawer = null;
		ctx.compareMode = true;
		ctx.track("action:compare_open");

		// 隐藏官方推荐区域（对比模式下不展示推荐内容）
		const featuredEl = q(ctx.contentEl, ".pt-featured");
		if (featuredEl) {
			featuredEl.style.display = "none";
		}

		// 隐藏虚拟滚动层：display:none 彻底移出 flex 流，让对比容器独占全高。
		// 仅 visibility:hidden 仍占 flex 空间，会与 .pt-compare-container(flex:1) 各占一半，
		// 导致对比页可见区被压成半高、长内容看起来"被截断"。
		if (ctx.scrollViewport) ctx.scrollViewport.style.display = "none";

		// 创建或复用对比容器（使用 contentEl 确保在正确的 DOM 层级内）
		let compareContainer = q(ctx.contentEl, ".pt-compare-container");
		if (!compareContainer) {
			compareContainer = ctx.contentEl.createDiv({ cls: "pt-compare-container" });
			// 插入到 header 之后、虚拟滚动层之前
			const headerEl = q(ctx.contentEl, ".pt-header");
			if (headerEl) {
				headerEl.after(compareContainer);
			} else {
				ctx.contentEl.appendChild(compareContainer);
			}
		}
		compareContainer.style.display = "";
		// 触发 reflow 后淡入
		compareContainer.offsetHeight; // force reflow
		compareContainer.style.opacity = "1";
		compareContainer.style.visibility = "visible";

		// 隐藏对比托盘（进入对比模式后不再需要）
		ctx.removeCompareTray();

		// 渲染对比内容（进入时首次绘制；后续移除插件时由 renderCompareContent 增量重绘）
		renderCompareContent(ctx);

}

/**
 * 仅重绘对比内容（回填离线词典 + 渲染对比页）。
 * 与 enterCompareMode 区别：不重复隐藏/创建容器、不重置滚动层与埋点，
 * 因此「移除一个插件」时直接调用，避免整页重建闪烁（N-2）。
 */
function renderCompareContent(ctx: ViewContext) {

		const plugins = ctx.plugins.filter(p => ctx.compareSet.has(p.id));
	// 对比前回填已采纳译名：确保热加载完成前进入对比的插件也能拿到中文名
	// （mergeOffline 只在首次加载时执行一次；对比模式下 missed 条目不会回查 tmApproved）
	for (const p of plugins) {
		const existing = ctx.translatedResults[p.id];
		if (existing && existing.source !== "original") continue;
		const hit = ctx.translator.lookupTMApproved(p.id, p.name, p.description);
		if (hit) {
			ctx.translatedResults[p.id] = hit;
		}
		}

		const compareContainer = q(ctx.contentEl, ".pt-compare-container");
		if (!compareContainer) return;

		renderComparePage(
			compareContainer,
			plugins,
			ctx.translator,
			ctx.translatedResults,
			ctx.installedIds,
			ctx.enabledIds,
			ctx.mirrorConfig,
			{
				app: ctx.app,
				onBack: () => ctx.exitCompareMode(),
				onRemove: (pid: string) => {
					ctx.compareSet.delete(pid);
					ctx.settings.compare = Array.from(ctx.compareSet);
					void ctx.flushSaveSettings();
					if (ctx.compareSet.size < 2) {
						ctx.exitCompareMode();
					} else {
						// 仅重绘对比内容，避免整页重建（N-2）
						renderCompareContent(ctx);
					}
				},
				onAdd: () => {
					ctx.exitCompareMode();
					// 返回列表让用户继续添加
				},
			}
		);

}

export function exitCompareMode(ctx: ViewContext) {

		ctx.compareMode = false;

		// 恢复官方推荐区域
		const featuredEl = q(ctx.contentEl, ".pt-featured");
		if (featuredEl) {
			featuredEl.style.display = "";
		}

		// 淡出对比容器，恢复虚拟滚动层；同时卸载对比页生命周期资源
		// （document click 监听器 / in-flight AI 请求），否则每次进出对比都累积泄漏
		const compareContainer = q(ctx.contentEl, ".pt-compare-container");
		if (compareContainer) {
			disposeComparePage(compareContainer);
			compareContainer.style.opacity = "0";
			compareContainer.style.visibility = "hidden";
		}

		// 恢复虚拟滚动层：display 复位后从 opacity:0 起播过渡淡入。
		// display:none→空 不会触发表层过渡，需在 display 复位后强制 reflow
		// 再设 opacity:1，使 CSS transition 能捕获起始帧。
		if (ctx.scrollViewport) {
			ctx.scrollViewport.style.display = "";
			ctx.scrollViewport.style.visibility = "visible";
			ctx.scrollViewport.style.opacity = "0";
			void ctx.scrollViewport.offsetHeight; // force reflow，捕获 opacity:0 为起始帧
			ctx.scrollViewport.style.opacity = "1";
		}

		// 恢复对比托盘
		ctx.updateCompareTray();

		// 刷新对比高亮
		ctx.refreshCompareHighlights();

		// 恢复列表渲染
		ctx.renderPluginList(true);
	
}
