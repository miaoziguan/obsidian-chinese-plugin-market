/**
 * E2E 测试入口（浏览器侧）。
 * 在真实 Chromium 中调用源码的渲染函数，把结果挂到 #root，供 Playwright 断言。
 * 仅测试「渲染层」关键路径：插件卡片 + 对比页，不启动整个插件生命周期。
 */
import "./obsidian-mock";
import { createPluginCard } from "../../src/ui/components/card-render";
import { renderComparePage } from "../../src/ui/components/compare-view";
import { makeT } from "../../src/shared/i18n";
import type { PluginInfo, TranslateResult } from "../../src/domain/catalog/translator";

function baseCtx() {
	const t = makeT();
	return {
		t,
		installedIds: new Set<string>(),
		enabledIds: new Set<string>(),
		aiSearchResult: null,
		compareSet: new Set<string>(),
		recommendedIds: new Set<string>(),
		favoritesSet: new Set<string>(),
		smartSignals: new Map<string, unknown>(),
	} as any;
}

function samplePlugin(over: Partial<PluginInfo> = {}): PluginInfo {
	return {
		id: "dataview",
		name: "Dataview",
		description: "Complex data views for the rest of us.",
		author: "Michael Brenan",
		downloads: 5_000_000,
		updated: Date.now(),
		...over,
	};
}

const translatorStub = {
	lookupBulkDict: () => null,
	getPluginTag: () => null,
	hasAI: () => false,
} as any;

function renderCard(): string {
	const root = document.getElementById("root")!;
	root.empty();
	const card = createPluginCard(
		samplePlugin(),
		{ translatedName: "数据视图", translatedDesc: "为大众提供复杂的数据视图。", source: "bulk" },
		baseCtx()
	);
	root.appendChild(card);
	return card.outerHTML;
}

function renderCompare(): string {
	const root = document.getElementById("root")!;
	root.empty();
	const container = document.createElement("div");
	container.className = "pt-compare-container";
	root.appendChild(container);

	const plugins = [
		samplePlugin({ id: "alpha", name: "Alpha Plugin" }),
		samplePlugin({ id: "beta", name: "Beta Plugin" }),
	];
	const translated: Record<string, TranslateResult> = {
		alpha: { translatedName: "阿尔法插件", translatedDesc: "示例 A", source: "bulk" },
		beta: { translatedName: "贝塔插件", translatedDesc: "示例 B", source: "bulk" },
	};
	renderComparePage(container, plugins, translatorStub, translated, new Set(), new Set(), () => ({ source: "jsdelivr" as const }), {
		app: {} as any,
		onBack() {},
		onRemove() {},
		onAdd() {},
	});
	return container.outerHTML;
}

/**
 * 渲染「官方推荐」置顶区 head（含内联 !important 样式），挂到 #root，供截图诊断。
 * 注：此处逐字复刻 src/view-featured.ts ensureFeaturedSection 的 head 创建逻辑，
 * 以避免引入 card-render/plugin 等重依赖导致 e2e bundle 构建失败；DOM 与内联样式
 * 与源码保持一致，可 100% 复现 Obsidian 中的真实渲染结果。
 */
function renderFeatured(): string {
	const root = document.getElementById("root")!;
	root.empty();
	// 复刻 ensureFeaturedSection 的 DOM 创建（与源码一致）
	const section = root.createEl("div", { cls: "pt-featured" });
	const head = section.createEl("div", { cls: "pt-featured-head" });
	head.style.setProperty("display", "flex", "important");
	head.style.setProperty("flex-direction", "row", "important");
	head.style.setProperty("flex-wrap", "nowrap", "important");
	head.style.setProperty("align-items", "center", "important");
	head.style.setProperty("justify-content", "space-between", "important");
	head.style.setProperty("gap", "var(--pt-space-md)", "important");

	const titleEl = head.createEl("span", {
		cls: "pt-featured-title",
		text: "官方推荐 · 羽鳞君",
	});
	titleEl.style.setProperty("display", "flex", "important");
	titleEl.style.setProperty("align-items", "center", "important");
	titleEl.style.setProperty("height", "28px", "important");
	titleEl.style.setProperty("line-height", "28px", "important");
	titleEl.style.setProperty("margin", "0", "important");
	titleEl.style.setProperty("padding", "0", "important");

	const toggle = head.createEl("span", {
		cls: "pt-featured-toggle",
		attr: { role: "button", tabindex: "0", title: "收起" },
	});
	toggle.setText("收起");
	toggle.style.setProperty("display", "flex", "important");
	toggle.style.setProperty("align-items", "center", "important");
	toggle.style.setProperty("justify-content", "center", "important");
	toggle.style.setProperty("height", "28px", "important");
	toggle.style.setProperty("line-height", "28px", "important");
	toggle.style.setProperty("margin", "0", "important");
	toggle.style.setProperty("padding", "0 4px", "important");
	toggle.style.setProperty("background", "none", "important");
	toggle.style.setProperty("border", "none", "important");
	toggle.style.setProperty("box-shadow", "none", "important");
	toggle.style.setProperty("border-radius", "0", "important");
	toggle.style.setProperty("flex", "none", "important");

	return section.outerHTML;
}

(window as any).__e2e = { renderCard, renderCompare, renderFeatured };
