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

	// ── 空态 ──
	if (entries.length === 0) {
		const empty = el.createDiv({ cls: "pt-updates-empty" });
		empty.createDiv({ cls: "pt-updates-empty-title", text: t("betaList.empty") });
		empty.createDiv({
			cls: "pt-updates-empty-hint",
			text: t("betaList.empty.hint", { cmd: t("directInstall.menu") }),
		});
		const installEmpty = empty.createEl("button", {
			cls: "pt-beta-install-empty",
			text: t("betaList.install"),
			attr: { "aria-label": t("betaList.install"), title: t("betaList.install"), type: "button" },
		});
		installEmpty.addEventListener("click", (e) => openDirectInstallMenu(ctx, e));
		return;
	}

	// ── 行列表 ──
	const rows = el.createDiv({ cls: "pt-updates-rows" });
	for (const e of entries) {
		const id = e.id;
		const name = e.name || id;
		const row = rows.createDiv({ cls: "pt-updates-row pt-beta-row" });

		// 名称：在官方插件列表里有记录时可点开详情（直链插件往往并不在官方列表里）
		const nameEl = row.createDiv({ cls: "pt-updates-name pt-beta-name" });
		nameEl.setText(name);
		if (ctx.allPlugins.some((p) => p.id === id)) {
			nameEl.addClass("is-link");
			nameEl.setAttribute("title", t("betaList.open"));
			nameEl.addEventListener("click", () => ctx.openDetailDrawer(id));
		}

		// 元信息：类型 / 版本 / 钉选 tag / 冻结标记
		const meta = row.createDiv({ cls: "pt-updates-diff pt-beta-meta" });
		meta.createSpan({
			cls: "pt-beta-kind",
			text: (e.kind ?? "plugin") === "theme" ? t("beta.kind.theme") : t("beta.kind.plugin"),
		});
		if (e.installedVersion) meta.createSpan({ cls: "pt-beta-ver", text: `v${e.installedVersion}` });
		if (e.releaseTag) meta.createSpan({ cls: "pt-beta-tag", text: `#${e.releaseTag}` });
		else if (e.release) meta.createSpan({ cls: "pt-beta-tag", text: t("betaList.release") });
		if (e.frozen) meta.createSpan({ cls: "pt-beta-frozen", text: t("beta.frozen") });

		// 来源（rootUrl）：告诉用户它是从哪儿装的，悬停看完整地址
		const src = row.createDiv({ cls: "pt-beta-source", text: shortSource(e.rootUrl) });
		if (e.rootUrl) src.setAttribute("title", e.rootUrl);

		// 操作 1：更新到来源最新版
		const updBtn = row.createEl("button", {
			cls: "pt-updates-row-update pt-beta-action clickable-icon",
			attr: { "aria-label": t("beta.update"), title: t("beta.update"), type: "button" },
		});
		setIcon(updBtn, "arrow-down-to-line");
		updBtn.addEventListener("click", () => {
			if (updBtn.hasClass("pt-spin")) return;
			updBtn.addClass("pt-spin");
			void ctx
				.updateBetaPluginById(id)
				.catch(() => undefined)
				.finally(() => {
					updBtn.removeClass("pt-spin");
					ctx.renderBetaList();
				});
		});

		// 操作 2：冻结 / 取消冻结
		const frozen = e.frozen === true;
		const freezeBtn = row.createEl("button", {
			cls: "pt-updates-row-update pt-beta-action clickable-icon",
			attr: {
				"aria-label": frozen ? t("beta.unfreeze") : t("beta.freeze"),
				title: frozen ? t("beta.unfreeze") : t("beta.freeze"),
				type: "button",
			},
		});
		setIcon(freezeBtn, "snowflake");
		if (frozen) freezeBtn.addClass("is-on");
		freezeBtn.addEventListener("click", () => {
			ctx.setBetaFrozen(id, !frozen);
			ctx.renderBetaList();
		});

		// 操作 3：取消跟踪（只删记录，不动已装文件）
		const rmBtn = row.createEl("button", {
			cls: "pt-updates-row-update pt-beta-action pt-beta-untrack clickable-icon",
			attr: { "aria-label": t("beta.remove"), title: t("beta.remove"), type: "button" },
		});
		setIcon(rmBtn, "x");
		rmBtn.addEventListener("click", () => {
			ctx.removeBetaPlugin(id);
			ctx.renderBetaList();
		});
	}
}
