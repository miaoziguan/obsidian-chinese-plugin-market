/**
 * 「直链」页签列表渲染器。
 *
 * 主视图顶部「直链」页签切到本视图时，调用 renderBetaList 在 ctx.betaListEl 中渲染
 * settings.betaPlugins（直链安装的插件与主题）跟踪表：
 * - 每行：名称（在官方列表里有记录时可点开详情）+ 类型 / 版本 / 来源 + 冻结标记；
 * - 行内操作：更新到来源最新版、冻结 / 取消冻结（冻结后不参与自动更新与「全部更新」）、
 *   取消跟踪（仅移除记录，不卸载插件本身）；
 * - 顶部「全部更新」= 逐条更新未冻结项（与设置页同一套逻辑）。
 *
 * 行样式刻意复用「更新」页签的 .pt-updates-* 类，保证两处列表观感一致；
 * 只有直链专属的元信息（类型 / 冻结 / 来源地址）用 .pt-beta-* 类。
 */

import { setIcon, Menu } from "obsidian";
import type { ViewContext } from "@ui/view/view-context";
import type { BetaPluginEntry } from "@app/direct-install";

/** 排序：插件在前、主题在后，组内按名称（中文按拼音不会错乱，用 zh 排序器） */
function compareEntry(a: BetaPluginEntry, b: BetaPluginEntry): number {
	const rank = (e: BetaPluginEntry) => ((e.kind ?? "plugin") === "theme" ? 1 : 0);
	return rank(a) - rank(b) || (a.name || a.id).localeCompare(b.name || b.id, "zh");
}

/** 来源地址压缩展示：去掉协议与末尾斜杠，只留仓库关键段，超长截断 */
/** 点击后弹出插件/主题选择菜单，再打开对应直链安装模态框 */
function openDirectInstallMenu(ctx: ViewContext, e: MouseEvent): void {
	const menu = new Menu();
	menu.addItem((item) =>
		item
			.setTitle(ctx.t("betaList.installPlugin"))
			.setIcon("package")
			.onClick(() => {
				ctx.openDirectInstall("plugin", (info) => {
					ctx.recordBetaInstall(info);
					ctx.renderBetaList();
				});
			}),
	);
	menu.addItem((item) =>
		item
			.setTitle(ctx.t("betaList.installTheme"))
			.setIcon("palette")
			.onClick(() => {
				ctx.openDirectInstall("theme", (info) => {
					ctx.recordBetaInstall(info);
					ctx.renderBetaList();
				});
			}),
	);
	menu.showAtMouseEvent(e);
}

function shortSource(rootUrl: string): string {
	if (!rootUrl) return "";
	let s = rootUrl.replace(/^https?:\/\//, "");
	s = s.replace(/\/+$/, "");
	// raw.githubusercontent.com/<owner>/<repo>/<ref> → owner/repo@ref
	const raw = /^raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/(.*)$/.exec(s);
	if (raw) {
		const ref = raw[3] || "HEAD";
		return `${raw[1]}/${raw[2]}@${ref}`;
	}
	if (s.length > 46) s = `${s.slice(0, 43)}…`;
	return s;
}

export function renderBetaList(ctx: ViewContext): void {
	const el = ctx.betaListEl;
	if (!el) return;
	const t = ctx.t;
	el.empty();

	const entries = (ctx.betaPlugins ?? []).slice().sort(compareEntry);

	// ── 顶部工具条 ──
	const bar = el.createDiv({ cls: "pt-updates-bar" });
	bar.createSpan({ cls: "pt-updates-count", text: t("betaList.count", { n: String(entries.length) }) });

	// 始终显示「从直链安装」入口，方便用户在当前页直接安装（无需命令面板 / 左侧菜单）
	const installBtn = bar.createEl("button", {
		cls: "pt-beta-install",
		text: t("betaList.install"),
		attr: { "aria-label": t("betaList.install"), title: t("betaList.install"), type: "button" },
	});
	installBtn.addEventListener("click", (e) => openDirectInstallMenu(ctx, e));

	if (entries.length > 0) {
		const updateAll = bar.createEl("button", { cls: "pt-updates-update-all", text: t("beta.updateAll") });
		updateAll.addEventListener("click", () => {
			if (updateAll.disabled) return;
			updateAll.disabled = true;
			updateAll.setText(t("beta.updating"));
			void ctx
				.updateAllBetaPlugins()
				.catch(() => undefined)
				.finally(() => ctx.renderBetaList());
		});
	}

	// ── 说明（这个列表是什么、能干什么）──
	el.createDiv({ cls: "pt-beta-hint", text: t("betaList.hint") });

	// ── 卡片网格（视觉级复用浏览页 .pt-card 资产；操作整体替换为直链语义）──
	const cards = el.createDiv({ cls: "pt-beta-cards" });
	for (const e of entries) {
		cards.appendChild(createBetaCard(ctx, e));
	}
}

/**
 * 直链卡片：视觉级复用浏览页卡片资产（.pt-card 结构 / .pt-card-* 类 / .pt-meta-chip /
 * .pt-icon-btn），操作按钮整体替换为直链语义（更新到来源 / 冻结 / 取消跟踪）。
 * 不在官方列表的直链条目用来源仓库作为来源 chip 占位，悬停看完整地址。
 */
function createBetaCard(ctx: ViewContext, e: BetaPluginEntry): HTMLElement {
	const t = ctx.t;
	const info = ctx.allPlugins.find((p) => p.id === e.id);
	const isKnown = Boolean(info);
	const displayName = info?.name ?? e.name ?? e.id;
	const desc = info?.description ?? "";
	const shortSrc = shortSource(e.rootUrl);
	const frozen = e.frozen === true;

	const card = createDiv({ cls: "pt-card pt-card--clickable" });
	card.setAttribute("data-plugin-id", e.id);

	// 头行：名称 + 类型标签（复用「已安装」按钮外观，直链项必然已装）
	const headRow = card.createDiv({ cls: "pt-card-head-row" });
	const nameBlock = headRow.createDiv({ cls: "pt-card-name-block" });
	nameBlock.createSpan({ cls: "pt-card-name", text: displayName });
	headRow.createSpan({
		cls: "pt-card-install-btn pt-card-install-btn--enabled",
		text: (e.kind ?? "plugin") === "theme" ? t("beta.kind.theme") : t("beta.kind.plugin"),
	});

	// 元信息：版本 / 冻结 / 来源
	const meta = card.createDiv({ cls: "pt-card-meta" });
	const metaInfo = meta.createDiv({ cls: "pt-card-meta-info" });
	if (e.installedVersion) metaInfo.createSpan({ cls: "pt-meta-chip", text: `v${e.installedVersion}` });
	if (frozen) metaInfo.createSpan({ cls: "pt-meta-chip pt-beta-frozen", text: t("beta.frozen") });
	const srcChip = metaInfo.createSpan({ cls: "pt-meta-chip pt-beta-source", text: shortSrc });
	if (e.rootUrl) srcChip.setAttribute("title", e.rootUrl);

	// 描述（无官方描述时为空，由来源 chip 提供上下文）
	card.createDiv({ cls: "pt-card-desc pt-card-desc--clamped", text: desc });

	// 操作行：更新到来源 / 冻结 / 取消跟踪（视觉复用 .pt-icon-btn）
	const actionsRow = card.createDiv({ cls: "pt-card-actions-row" });

	const updBtn = actionsRow.createEl("button", {
		cls: "pt-icon-btn pt-beta-action",
		attr: { "aria-label": t("beta.update"), title: t("beta.update"), type: "button", "data-action": "update" },
	});
	setIcon(updBtn, "arrow-down-to-line");
	updBtn.addEventListener("click", (ev) => {
		ev.stopPropagation();
		if (updBtn.hasClass("pt-spin")) return;
		updBtn.addClass("pt-spin");
		void ctx.updateBetaPluginById(e.id).catch(() => undefined).finally(() => ctx.renderBetaList());
	});

	const freezeBtn = actionsRow.createEl("button", {
		cls: "pt-icon-btn pt-beta-action",
		attr: {
			"aria-label": frozen ? t("beta.unfreeze") : t("beta.freeze"),
			title: frozen ? t("beta.unfreeze") : t("beta.freeze"),
			type: "button",
			"data-action": "freeze",
		},
	});
	setIcon(freezeBtn, "snowflake");
	if (frozen) freezeBtn.classList.add("is-on");
	freezeBtn.addEventListener("click", (ev) => {
		ev.stopPropagation();
		ctx.setBetaFrozen(e.id, !frozen);
		ctx.renderBetaList();
	});

	const rmBtn = actionsRow.createEl("button", {
		cls: "pt-icon-btn pt-beta-action pt-beta-untrack",
		attr: { "aria-label": t("beta.remove"), title: t("beta.remove"), type: "button", "data-action": "untrack" },
	});
	setIcon(rmBtn, "x");
	rmBtn.addEventListener("click", (ev) => {
		ev.stopPropagation();
		ctx.removeBetaPlugin(e.id);
		ctx.renderBetaList();
	});

	// 整卡点击：官方有记录时打开详情（操作按钮已 stopPropagation 拦截）
	if (isKnown) card.addEventListener("click", () => ctx.openDetailDrawer(e.id));
	return card;
}
