/**
 * facetChips：分类 facet 筛选器 chips 渲染纯函数。
 *
 * 与用法 B 的 `renderFacetChips` 闭包等价，抽取为纯函数后
 * 可独立单测（无需实例化 Obsidian Plugin 视图）。
 *
 * @param container  chips 容器（应支持 `.empty()` 和 `.createEl()`）
 * @param categories  所有分类名列表（空字符串会被跳过）
 * @param selectedCategories  当前选中的分类（用于决定 aria-pressed 初始状态）
 * @param onToggle  用户点击 chip 时的回调，传入被点击的分类名
 * @param options  折叠配置：分类超过 `maxVisible` 时折叠显示前 N 个 +
 *   「更多 ▾」展开按钮（展开后变「收起 ▴」）。`onToggleExpand` 由调用方维护展开态。
 */
export interface FacetChipOptions {
	maxVisible?: number;
	expanded?: boolean;
	onToggleExpand?: () => void;
}

export function renderFacetChips(
	container: { empty(): void; createEl(tag: string, attrs?: Record<string, unknown>): HTMLElement },
	categories: string[],
	selectedCategories: string[],
	onToggle: (category: string) => void,
	options?: FacetChipOptions
): void {
	container.empty();
	const maxVisible = options?.maxVisible ?? 12;
	const expanded = options?.expanded ?? false;
	const onToggleExpand = options?.onToggleExpand;

	// 折叠态：仅渲染前 maxVisible 个分类，剩余靠「更多 ▾」展开
	const visible = expanded ? categories : categories.slice(0, maxVisible);

	for (const cat of visible) {
		if (!cat) continue;
		const chip = container.createEl("button", {
			cls: "pt-filter pt-facet-chip",
			text: cat,
		});
		chip.setAttribute("data-cat", cat);
		chip.setAttribute("aria-pressed", selectedCategories.includes(cat) ? "true" : "false");
		chip.addEventListener("click", () => {
			onToggle(cat);
		});
	}

	// 分类过多：未展开显示「更多 ▾」，已展开显示「收起 ▴」，避免首屏被长列表占满
	if (categories.length > maxVisible) {
		const moreBtn = container.createEl("button", {
			cls: "pt-filter pt-facet-more",
			text: expanded ? "收起 ▴" : "更多 ▾",
		});
		moreBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
		moreBtn.addEventListener("click", () => {
			if (onToggleExpand) onToggleExpand();
		});
	}
}
