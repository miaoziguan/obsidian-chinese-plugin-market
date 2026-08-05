import { formatDownloads } from "./stats";
import { compareTagsMulti, compareCommandsMulti } from "./compare";
import type { PluginInfo, TranslateResult, Translator } from "./translator";
import { App, MarkdownRenderer, Notice, Component } from "obsidian";
import { makeT, type TFunc } from "./i18n";
import { renderCompareMarkdown, type CompareExportItem } from "./compare-export";
import type { PluginViewModel } from "./plugin-vm";
import { buildPluginViewModels } from "./plugin-vm";
import { gatherInsightSources, fetchMainSignals } from "./plugin-insight";
import type { MirrorConfig } from "./mirror";
import { appendSVG } from "./dom";

/**
 * 对比模式页面渲染器（替代 Modal，使用视图内全宽布局）
 *
 * 架构：
 * 1. 顶部：返回按钮 + 插件选择区（可继续添加/移除）
 * 2. 中间：插件卡片网格（每个插件一个独立对比卡片，垂直布局）
 * 3. 下部：洞察摘要栏（结论先行）
 * 4. 底部：AI 深度对比（可选，需配置 AI Key）
 */
/**
 * 卸载对比页注册的生命周期资源（document 点击监听器 / in-flight AI 请求）。
 * 修复：退出对比模式只是隐藏容器，_ptComp 从未 unload，
 * document 级 click 监听器随每次进入对比持续累积泄漏。
 */
/** 在 DOM 容器上挂/取对比页 Component 的生命周期句柄（避免 any 逃逸） */
interface ComponentHolder extends HTMLElement {
	_ptComp?: Component;
}
function getCompHolder(el: HTMLElement): ComponentHolder {
	return el;
}

export function disposeComparePage(container: HTMLElement) {
	const holder = getCompHolder(container);
	const prev = holder._ptComp;
	if (prev) {
		prev.unload();
		holder._ptComp = undefined;
	}
}

export function renderComparePage(
	container: HTMLElement,
	plugins: PluginInfo[],
	translator: Translator,
	translatedResults: Record<string, TranslateResult>,
	installedIds: Set<string>,
	enabledIds: Set<string>,
	mirrorConfig: () => MirrorConfig,
	options: {
		app: App;
		onBack: () => void;
		onRemove: (pid: string) => void;
		onAdd: () => void;
	}
) {
	const t = makeT();
	const comp = new Component();
	container.empty();
	// 注册清理，防止多次调用时内存泄漏
	const holder = getCompHolder(container);
	const prev = holder._ptComp;
	if (prev) prev.unload();
	holder._ptComp = comp;

	// 构建统一视图模型（战略建议 ④：一次构建，多视图复用）
	const vms = buildPluginViewModels(plugins, translatedResults, (id) =>
		translator.getPluginTag(id) ?? null,
	);

	// -- 顶部导航栏 --
	const nav = container.createDiv({ cls: "pt-compare-nav" });
	const backBtn = nav.createEl("button", {
		cls: "pt-compare-back-btn",
		text: t("compare.nav.back"),
	});
	backBtn.addEventListener("click", options.onBack);
	nav.createSpan({
		cls: "pt-compare-nav-title",
		text: t("compare.title", { n: String(plugins.length) }),
	});
	const addBtn = nav.createEl("button", {
		cls: "pt-compare-add-btn",
		text: t("compare.nav.add"),
	});
	addBtn.addEventListener("click", options.onAdd);

	// 导出下拉按钮
	const exportGroup = nav.createDiv({ cls: "pt-compare-export" });
	const exportToggle = exportGroup.createEl("button", {
		cls: "pt-compare-export-toggle",
		attr: { "aria-label": t("compare.export.md"), "aria-expanded": "false" },
	});
	appendSVG(exportToggle, `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`);
	const exportMenu = exportGroup.createDiv({ cls: "pt-compare-export-menu" });
	exportMenu.setCssStyles({ display: "none" });
	const mdItem = exportMenu.createEl("button", {
		cls: "pt-compare-export-item",
		text: t("compare.export.md"),
	});
	mdItem.onclick = () => {
		exportMarkdown(vms, installedIds, enabledIds, t);
		exportMenu.setCssStyles({ display: "none" });
		exportToggle.setAttribute("aria-expanded", "false");
	};
	exportToggle.onclick = () => {
		const open = exportMenu.style.display === "none";
		exportMenu.setCssStyles({ display: open ? "" : "none" });
		exportToggle.setAttribute("aria-expanded", open ? "true" : "false");
	};
	const closeMenu = (ev: MouseEvent) => {
		if (!exportGroup.contains(ev.target as HTMLElement)) {
			exportMenu.setCssStyles({ display: "none" });
			exportToggle.setAttribute("aria-expanded", "false");
		}
	};
	document.addEventListener("click", closeMenu);
	comp.register(() => document.removeEventListener("click", closeMenu));

	// -- 插件卡片网格 --
	const grid = container.createDiv({ cls: "pt-compare-grid" });

	for (const vm of vms) {
		const card = grid.createDiv({ cls: "pt-compare-card" });

		// 卡片头部：名称 + 操作
		const head = card.createDiv({ cls: "pt-compare-card-head" });
		head.createSpan({ cls: "pt-compare-card-name", text: vm.name });
		const actions = head.createDiv({ cls: "pt-compare-card-actions" });
		// 仓库链接
		if (vm.info.repo) {
			actions.createEl("a", {
				cls: "pt-compare-card-link",
				text: "GitHub",
				attr: {
					href: `https://github.com/${vm.info.repo}`,
					target: "_blank",
					rel: "noopener noreferrer",
				},
			});
		}
		// 社区市场/安装
		const installed = installedIds.has(vm.id);
		const enabled = enabledIds.has(vm.id);
		if (installed) {
			actions.createSpan({
				cls: "pt-compare-card-status pt-compare-card-status--installed",
				text: enabled ? t("compare.installed.on") : t("compare.installed.off"),
			});
		} else {
			actions.createEl("a", {
				cls: "pt-compare-card-status pt-compare-card-status--install",
				text: t("compare.installed.no"),
				attr: { href: `obsidian://show-plugin?id=${vm.id}` },
			});
		}
		// 移出对比
		const removeBtn = actions.createEl("button", {
			cls: "pt-compare-card-remove",
			text: "\u2715",
			title: t("compare.remove"),
		});
		removeBtn.addEventListener("click", () => options.onRemove(vm.id));

		// 卡片内容区
		const body = card.createDiv({ cls: "pt-compare-card-body" });

		// 作者
		body.createDiv({ cls: "pt-compare-card-row" }).createSpan({
			cls: "pt-compare-card-label",
			text: `${t("detail.author")}: ${vm.info.author || t("compare.unknown")}`,
		});

		// 分类
		if (vm.tag) {
			body.createDiv({ cls: "pt-compare-card-row" }).createSpan({
				cls: "pt-compare-card-label",
				text: `${t("compare.category")}: ${vm.tag.category}`,
			});
		}

		// 下载量
		const dl = vm.info.downloads ?? 0;
		body.createDiv({ cls: "pt-compare-card-row" }).createSpan({
			cls: "pt-compare-card-label",
			text: `${t("compare.downloads")}: ${formatDownloads(dl)}`,
		});

		// 更新时间
		if (vm.info.updated) {
			const date = new Date(vm.info.updated);
			const daysSince = Math.floor((Date.now() - vm.info.updated) / 86400000);
			const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
			body.createDiv({ cls: "pt-compare-card-row" }).createSpan({
				cls: "pt-compare-card-label",
				text: `${t("compare.updated")}: ${dateStr}\uff08${t("compare.daysAgo", { n: String(daysSince) })}\uff09`,
			});
		}

		// 描述
		if (vm.desc) {
			body.createDiv({ cls: "pt-compare-card-desc", text: vm.desc });
		}

		// 功能标签
		const tags = vm.tag?.tags ?? [];
		if (tags.length > 0) {
			const tagsRow = body.createDiv({ cls: "pt-compare-card-tags" });
			for (const tag of tags) {
				tagsRow.createSpan({ cls: "pt-compare-card-tag", text: tag });
			}
		}
	}

	// -- 洞察摘要区（结论先行） --
	const allTags = vms.map((vm) => vm.tag?.tags ?? []);
	const { common, only: uniquePer } = compareTagsMulti(allTags);
	const signals: string[] = [];

	// 下载量差距
	const dlGap = downloadGapSignal(vms, t);
	if (dlGap) signals.push(dlGap);

	// 维护活跃度
	const freshGap = freshnessGapSignal(vms, t);
	if (freshGap) signals.push(freshGap);

	// 功能重叠度（含 3+ 插件）
	const overlapSig = overlapSignal(common, uniquePer, t);
	if (overlapSig) signals.push(overlapSig);

	// 安装状态
	const installedSig = installedSignal(vms, installedIds, enabledIds, t);
	if (installedSig) signals.push(installedSig);

	// 综合建议（与信号去重）
	const suggestion = synthesizeSuggestion(vms, common, uniquePer, t);
	const overlapDup = suggestion ? signals.some(s => s === suggestion) : false;

	if (signals.length > 0 || suggestion) {
		const insight = container.createDiv({ cls: "pt-compare-insight" });
		insight.createDiv({ cls: "pt-compare-insight-title", text: t("compare.insight.title") });

		for (const sig of signals) {
			insight.createDiv({ cls: "pt-compare-insight-signal", text: sig });
		}

		if (suggestion && !overlapDup) {
			const sugRow = insight.createDiv({ cls: "pt-compare-insight-suggest" });
			sugRow.createSpan({ cls: "pt-compare-insight-suggest-label", text: t("compare.insight.suggest") });
			sugRow.createSpan({ cls: "pt-compare-insight-suggest-text", text: suggestion });
		}

		// 更新时间风险提示
		const staleVms = vms.filter(vm => {
			if (!vm.info.updated) return true;
			return (Date.now() - vm.info.updated) / 86400000 > 730;
		});
		if (staleVms.length > 0) {
			const names = staleVms.map(vm => vm.name).join("\u3001");
			insight.createDiv({
				cls: "pt-compare-insight-warn",
				text: `\u26a0 ${t("compare.warn.stale", { names })}`,
			});
		}
	}

	// -- 命令级重叠信号（真实代码信号，异步拉取，比标签更准） --
	enrichCommandsSignal(container, vms, mirrorConfig, t, comp);

	// -- AI 深度对比区 --
	renderAIArea(container, vms, translator, mirrorConfig, options.app, t, comp);
}

function downloadGapSignal(vms: PluginViewModel[], t: TFunc): string | null {
	const sorted = vms
		.map(vm => ({ name: vm.name, dl: vm.info.downloads ?? 0 }))
		.sort((a, b) => b.dl - a.dl);
	if (sorted.length < 2) return null;
	const top = sorted[0];
	const bottom = sorted[sorted.length - 1];
	const ratio = bottom.dl > 0 ? top.dl / bottom.dl : Infinity;
	if (sorted.length <= 2) {
		if (ratio >= 5) return t("compare.dl.gap2", { top: top.name, bottom: bottom.name, ratio: String(Math.round(ratio)) });
		if (ratio >= 2) return t("compare.dl.lead2", { top: top.name, topDl: formatDownloads(top.dl), bottomDl: formatDownloads(bottom.dl) });
		return null;
	}
	const ranking = sorted.map(s => `${s.name}(${formatDownloads(s.dl)})`).join(" > ");
	if (ratio >= 5) return t("compare.dl.gapMulti", { ranking });
	if (ratio >= 2) return t("compare.dl.rankingMulti", { ranking });
	return t("compare.dl.closeMulti", { ranking });
}

function synthesizeSuggestion(
	vms: PluginViewModel[],
	common: string[],
	uniquePer: string[][],
	t: TFunc,
): string | null {
	const N = vms.length;
	if (N < 2) return null;
	if (N === 2) {
		if (common.length === 0) return t("compare.suggest.noOverlap");
		const allUnique = uniquePer[0].concat(uniquePer[1]);
		if (allUnique.length === 0) {
			const dlA = vms[0].info.downloads ?? 0;
			const dlB = vms[1].info.downloads ?? 0;
			const ageA = vms[0].info.updated ? (Date.now() - vms[0].info.updated) / 86400000 : Infinity;
			const ageB = vms[1].info.updated ? (Date.now() - vms[1].info.updated) / 86400000 : Infinity;
			const name = dlA >= dlB && ageA <= ageB
			? vms[0].name
			: vms[1].name;
			return t("compare.suggest.totalOverlap", { name });
		}
		const parts: string[] = [];
		for (let i = 0; i < 2; i++) {
			if (uniquePer[i].length > 0) {
				parts.push(t("compare.suggest.need", { tags: uniquePer[i].join("\u3001"), name: vms[i].name }));
			}
		}
		if (parts.length) parts.push(t("compare.suggest.coexist"));
		return parts.join("\uff1b");
	}
	// 3+ 综合推荐
	if (common.length === 0) return t("compare.suggest.multiNoOverlap");
	const scored = vms.map(vm => ({
		name: vm.name,
		dl: vm.info.downloads ?? 0,
		fresh: vm.info.updated ? (Date.now() - vm.info.updated) / 86400000 : Infinity,
	})).sort((a, b) => {
		const sA = a.dl + (a.fresh <= 90 ? 5000 : a.fresh <= 365 ? 2000 : 0);
		const sB = b.dl + (b.fresh <= 90 ? 5000 : b.fresh <= 365 ? 2000 : 0);
		return sB - sA;
	});
	const top = scored[0];
	const parts: string[] = [t("compare.suggest.multiTop", { name: top.name })];
	for (let i = 0; i < N; i++) {
		if (uniquePer[i].length > 0) {
			parts.push(t("compare.suggest.need", { tags: uniquePer[i].join("\u3001"), name: vms[i].name }));
		}
	}
	parts.push(t("compare.suggest.coexistMulti"));
	return parts.join("\uff1b");
}

/** AI 深度对比区域（从 Modal 迁移，支持 LLM 结构化分析） */
function renderAIArea(
	container: HTMLElement,
	vms: PluginViewModel[],
	translator: Translator,
	mirrorConfig: () => MirrorConfig,
	app: App,
	t: TFunc,
	comp: Component,
) {
	const sec = container.createDiv({ cls: "pt-compare-sec pt-compare-ai" });
	// 区域标签（弱化 section label，不再用大 h4，避免与按钮文案重复）
	const label = sec.createDiv({ cls: "pt-compare-ai-label" });
	label.createSpan({ cls: "pt-compare-ai-label-text", text: t("compare.ai.title") });
	if (!translator.hasAI()) {
		label.createSpan({ cls: "pt-compare-ai-label-badge", text: t("compare.ai.noKey") });
	}

	// 主体卡片：说明（左）+ 主按钮（右）横向排布，说明作为模块 intro 不再孤立即
	const card = sec.createDiv({ cls: "pt-compare-ai-card" });
	const intro = card.createDiv({ cls: "pt-compare-ai-intro" });
	intro.createDiv({ cls: "pt-compare-ai-intro-text", text: t("compare.ai.hint") });

	const btn = card.createEl("button", {
		cls: "pt-compare-ai-btn",
		text: t("compare.ai.start"),
	});
	const out = sec.createDiv({ cls: "pt-compare-ai-out" });

	if (!translator.hasAI()) {
		btn.disabled = true;
		btn.title = t("compare.ai.noKey");
	}

	let abortCtrl: AbortController | null = null;
	let loading = false;
	let lastError: string | null = null;

	// 抽成具名函数：重试按钮直接调用，避免 disabled 按钮上 .click() 不派发事件导致的卡死
	const runCompare = async () => {
		// 防止重复点击
		if (loading) return;
		loading = true;
		lastError = null;

		// 取消已有请求，防止幽灵 DOM
		if (abortCtrl) abortCtrl.abort();
		abortCtrl = new AbortController();
		const { signal } = abortCtrl;

		btn.disabled = true;
		out.empty();
		const loadingText = out.createDiv({ cls: "pt-compare-ai-loading-row" });
		loadingText.createSpan({ text: t("compare.ai.loading") });
		const cancelBtn = loadingText.createEl("button", {
			cls: "pt-compare-ai-cancel",
			text: t("compare.ai.cancel"),
		});
		cancelBtn.addEventListener("click", () => {
			if (abortCtrl) abortCtrl.abort();
		});
		try {
			// 命中缓存直接出（不拉网络）；否则先并行拉各插件仓库真实信号
			const cacheKey = vms.map((vm) => vm.id);
			const cached = translator.getCompareInsight(cacheKey);
			let md: string | null;
			if (cached) {
				md = cached;
			} else {
				// 拉取提示（覆盖默认「AI 分析中」）
				loadingText.querySelector("span")?.setText(t("compare.ai.fetching"));
				const mirror = mirrorConfig();
				const sources = await Promise.all(
					vms.map((vm) => gatherInsightSources(vm.info.repo, mirror, 2500))
				);
				if (signal.aborted) {
					btn.textContent = t("compare.ai.start");
					loading = false;
					return;
				}
				const items = vms.map((vm, i) => ({
					id: vm.id,
					name: vm.name,
					description: vm.desc,
					tags: vm.tag?.tags ?? [],
					commands: sources[i].mainSignals.commands.map((c) => c.name),
					dependencies: Object.keys(sources[i].manifest.dependencies ?? {}),
					readme: sources[i].readme || undefined,
				}));
				md = await translator.aiCompare(items);
			}
			if (signal.aborted) {
				// 用户取消：恢复按钮状态，显示取消提示
				out.empty();
				out.createDiv({ cls: "pt-compare-ai-cancelled", text: t("compare.ai.cancelled") });
				btn.textContent = t("compare.ai.retry");
				loading = false;
				return;
			}
			if (md === null) {
				throw new Error(t("compare.ai.noKey"));
			}
			out.empty();
			await MarkdownRenderer.render(app, md, out, "", comp);
			btn.textContent = t("compare.ai.start");
		} catch (e) {
			if (signal.aborted) return;
			lastError = (e as Error).message || "";
			out.empty();
			const errorBox = out.createDiv({ cls: "pt-compare-ai-error" });
			errorBox.createDiv({ cls: "pt-compare-ai-error-text", text: `${t("compare.ai.fail")}：${lastError}` });
			const retryBtn = errorBox.createEl("button", {
				cls: "pt-compare-ai-retry",
				text: t("compare.ai.retry"),
			});
			retryBtn.addEventListener("click", () => void runCompare());
		} finally {
			// 无条件复位按钮，避免「取消 + 异常」组合下按钮卡死在禁用态
			btn.disabled = false;
			loading = false;
		}
	};

	btn.addEventListener("click", () => void runCompare());

	comp.register(() => {
		if (abortCtrl) abortCtrl.abort();
		abortCtrl = null;
	});
}

/** 维护活跃度对比信号 */
function freshnessGapSignal(
	vms: PluginViewModel[],
	t: TFunc,
): string | null {
	const items = vms.map((vm) => ({
		name: vm.name,
		updated: vm.info.updated,
	}));
	const fresh = items.filter((it) => it.updated != null && (Date.now() - it.updated) / 86400000 <= 90);
	const stale = items.filter((it) => it.updated != null && (Date.now() - it.updated) / 86400000 > 730);

	if (fresh.length > 0 && stale.length > 0) {
		const fNames = fresh.map((it) => it.name).join("\u3001");
		const sNames = stale.map((it) => it.name).join("\u3001");
		const oldDays = stale.map((it) => Math.floor((Date.now() - it.updated!) / 86400000)).join("/");
		return t("compare.fresh.gap", { fresh: fNames, stale: sNames, days: oldDays });
	} else if (fresh.length > 0 && fresh.length < items.length) {
		const fNames = fresh.map((it) => it.name).join("\u3001");
		return t("compare.fresh.active", { fresh: fNames });
	} else if (stale.length > 0) {
		const sNames = stale.map((it) => it.name).join("\u3001");
		return t("compare.fresh.stale", { stale: sNames });
	}
	return null;
}

/** 功能重叠信号（支持 2+ 插件） */
function overlapSignal(common: string[], uniquePer: string[][], t: TFunc): string | null {
	if (!common.length) {
		return t("compare.overlap.none");
	}
	const total = [...common, ...uniquePer.flat()];
	const pct = total.length > 0 ? Math.round((common.length / total.length) * 100) : 0;
	if (pct >= 60) {
		return t("compare.overlap.high", { pct: String(pct) });
	} else if (pct >= 30) {
		return t("compare.overlap.mid", { pct: String(pct) });
	}
	return null;
}

/**
 * 命令级重叠信号（真实代码信号，比功能标签更诚实）。
 * 异步拉取各插件 main.js 注册的命令，算交集/差集，回到同步 insight 区后追加一行信号。
 * 与标签 overlapSignal 互补：标签像但命令不同 → 这里能抓出"本质不同类"。
 */
function enrichCommandsSignal(
	container: HTMLElement,
	vms: PluginViewModel[],
	mirrorConfig: () => MirrorConfig,
	t: TFunc,
	comp: Component,
) {
	if (vms.length < 2) return;
	const mirror = mirrorConfig();
	// 任一插件无 repo 则跳过（无法拉取真实信号）
	if (vms.some((vm) => !vm.info.repo)) return;

	const job = Promise.all(
		vms.map((vm) => fetchMainSignals(vm.info.repo, undefined, mirror))
	);
	// 组件卸载时取消，避免幽灵 DOM
	let aborted = false;
	comp.register(() => {
		aborted = true;
	});

	void job.then((signals) => {
		if (aborted) return;
		const commandsPer = signals.map((s) => s.commands.map((c) => c.name));
		const { common, only } = compareCommandsMulti(commandsPer);
		const hasAny = commandsPer.some((c) => c.length > 0);
		if (!hasAny) return; // 都抽不到命令，信号无意义

		let signalText: string | null = null;
		if (common.length > 0) {
			signalText = t("compare.cmds.overlap");
		} else if (only.every((u) => u.length > 0)) {
			signalText = t("compare.cmds.unique");
		}
		if (!signalText) return;

		const block = container.createDiv({ cls: "pt-compare-commands-signal" });
		block.createDiv({ cls: "pt-compare-insight-signal", text: signalText });
		// 展开命令明细（可折叠，默认收起）
		const detail = block.createEl("details", { cls: "pt-compare-commands-detail" });
		detail.createEl("summary", { text: t("compare.commands.detail") });
		vms.forEach((vm, i) => {
			const row = detail.createDiv({ cls: "pt-compare-commands-row" });
			row.createSpan({ cls: "pt-compare-commands-name", text: vm.name });
			row.createSpan({
				cls: "pt-compare-commands-list",
				text: commandsPer[i].join("、") || t("compare.commands.none"),
			});
		});
	});
}

/** 安装状态信号 */
function installedSignal(
	vms: PluginViewModel[],
	installedIds: Set<string>,
	enabledIds: Set<string>,
	t: TFunc,
): string | null {
	const on = vms.filter((vm) => enabledIds.has(vm.id));
	const off = vms.filter((vm) => installedIds.has(vm.id) && !enabledIds.has(vm.id));
	if (on.length > 0) {
		const names = on.map((vm) => vm.name).join("\u3001");
		return t("compare.installed.onDevice", { names });
	} else if (off.length > 0) {
		const names = off.map((vm) => vm.name).join("\u3001");
		return t("compare.installed.notEnabled", { names });
	}
	return null;
}

/** 构建导出数据结构 */
function buildExportItems(
	vms: PluginViewModel[],
	installedIds: Set<string>,
	enabledIds: Set<string>,
): CompareExportItem[] {
	return vms.map((vm) => ({
		id: vm.id,
		name: vm.name,
		originalName: vm.nameEn,
		description: vm.desc,
		downloads: vm.info.downloads,
		updated: vm.info.updated,
		installed: (installedIds.has(vm.id)
			? enabledIds.has(vm.id) ? "on" : "off"
			: "none") as CompareExportItem["installed"],
		tags: vm.tag,
	}));
}

/** 导出 Markdown 到剪贴板 */
function exportMarkdown(
	vms: PluginViewModel[],
	installedIds: Set<string>,
	enabledIds: Set<string>,
	t: TFunc,
) {
	const items = buildExportItems(vms, installedIds, enabledIds);
	const title = t("compare.title", { n: String(items.length) });
	const md = renderCompareMarkdown(items, title);
	// navigator.clipboard 在部分环境（非安全上下文/旧内核）为 undefined，直接调用会抛 TypeError
	if (!navigator.clipboard?.writeText) {
		new Notice(t("compare.export.copyFail"));
		return;
	}
	navigator.clipboard.writeText(md).then(
		() => new Notice(t("compare.export.md.done2")),
		() => new Notice(t("compare.export.copyFail")),
	);
}
