# CSS 片段管理 Tab 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在插件市场主视图顶部新增独立「CSS 片段」Tab，提供片段的完整管理：列表 + 启停 + 分组/备注（复用现有行 UI）+ 新建/删除 + 搜索/筛选 + 勾选式批量启停/删除。

**架构：** 新建独立渲染模块 `src/ui/view/view-css-snippets.ts`（与 `view-beta.ts` 对称），复用 `renderCssSnippetRow` 画行；`ViewTab` 联合类型加 `"css"`，Tab 栏按钮在 `view-toolbar.ts`、列表容器在 `view-chrome.ts`；数据经 `CssStorePort`（在 `plugin.ts` 的 `createCssStore` 实现）读写，仅扩展 `createSnippet` / `deleteSnippet` 两方法，底层转发到既有的 `data/platform/snippet.ts`。

**技术栈：** TypeScript + Obsidian API（ItemView / Modal / ToggleComponent）、Vitest 单测、现有 `CssStorePort` / `renderCssSnippetRow` / `manage-filter` 复用。

---

## 文件结构

**修改：**
- `src/ui/view/view-context.ts` — `ViewTab` 加 `"css"`；`ViewContext` 接口加 `cssSnippetListEl` / `cssStore` / `renderCssSnippetsList`；`createViewContext` 透传。
- `src/ui/view/translator-view.ts` — 加 `cssSnippetListEl` 字段；`switchViewTab` 加 css 分支；加 `renderCssSnippetsList` 方法委托 `view-css-snippets`。
- `src/ui/view/view-toolbar.ts` — 加「CSS 片段」Tab 按钮。
- `src/ui/view/view-chrome.ts` — 创建 `.pt-css-list` 容器并挂到 `ctx.cssSnippetListEl`。
- `src/app/plugin.ts` — `createCssStore` 实现补 `createSnippet` / `deleteSnippet`（调用 `data/platform/snippet` 的 `writeSnippet` / `deleteSnippet` + 孤儿清理 + `refreshSnippets`）。
- `src/ui/settings/snippet-manage-store.ts` — `CssStorePort` 接口加 `createSnippet` / `deleteSnippet`。
- `src/data/platform/snippet.ts` — 加导出纯函数 `isValidSnippetBaseName`（供 UI 与 store 校验）。
- `src/shared/i18n.ts` — 加 css 相关 i18n 键。

**创建：**
- `src/ui/view/view-css-snippets.ts` — 渲染模块（`renderCssSnippetsList(ctx)` + 工具栏 + 列表 + 过滤 + 批量）。
- `src/ui/view/view-css-snippets.test.ts` — 单测（mock ctx + mock store）。
- `src/data/platform/snippet.test.ts` — `isValidSnippetBaseName` 单测。

---

### 任务 1：数据层 — baseName 校验纯函数（TDD）

**文件：**
- 修改：`src/data/platform/snippet.ts`
- 测试：`src/data/platform/snippet.test.ts`（新建）

- [ ] **步骤 1：编写失败的测试**

```ts
// src/data/platform/snippet.test.ts
import { describe, it, expect } from "vitest";
import { isValidSnippetBaseName } from "./snippet";

describe("isValidSnippetBaseName", () => {
  it("接受普通基名", () => {
    expect(isValidSnippetBaseName("my-theme")).toBe(true);
    expect(isValidSnippetBaseName("  blue  ")).toBe(true); // 仅首尾空格，内核合法
  });
  it("拒绝空名", () => {
    expect(isValidSnippetBaseName("")).toBe(false);
    expect(isValidSnippetBaseName("   ")).toBe(false);
  });
  it("拒绝路径分隔符与上级引用", () => {
    expect(isValidSnippetBaseName("a/b")).toBe(false);
    expect(isValidSnippetBaseName("a\\b")).toBe(false);
    expect(isValidSnippetBaseName("..")).toBe(false);
    expect(isValidSnippetBaseName("../etc")).toBe(false);
  });
  it("拒绝过长基名", () => {
    expect(isValidSnippetBaseName("x".repeat(201))).toBe(false);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/data/platform/snippet.test.ts`
预期：FAIL（报错 `isValidSnippetBaseName is not exported`）

- [ ] **步骤 3：编写最少实现**

```ts
// 在 src/data/platform/snippet.ts 末尾追加
/**
 * 校验 CSS 片段基名（文件名去 .css）是否安全可写。
 * 禁止空名、路径分隔符、上级目录引用（../）、超长，避免越权写盘。
 */
export function isValidSnippetBaseName(base: string): boolean {
  const b = base.trim();
  if (!b) return false;
  if (b === "." || b === "..") return false;
  if (/[/\\]/.test(b)) return false;
  if (b.startsWith("..")) return false;
  if (b.length > 200) return false;
  return true;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/data/platform/snippet.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/data/platform/snippet.ts src/data/platform/snippet.test.ts
git commit -m "feat(css): 新增 isValidSnippetBaseName 校验纯函数"
```

---

### 任务 2：数据层 — CssStorePort 加 createSnippet / deleteSnippet（TDD 接口 + 实现）

**文件：**
- 修改：`src/ui/settings/snippet-manage-store.ts`（接口）
- 修改：`src/app/plugin.ts`（`createCssStore` 实现）

- [ ] **步骤 1：扩展接口**

在 `src/ui/settings/snippet-manage-store.ts` 的 `CssStorePort` 接口（`async deleteSnippet` 之前或之后）追加：

```ts
	/** 新建片段：在 <configDir>/snippets/<baseName>.css 写空文件（content 可选，默认空） */
	createSnippet(baseName: string, content?: string): Promise<void>;
	/** 删除片段文件（含元数据孤儿清理），并重新扫描目录 */
	deleteSnippet(baseName: string): Promise<void>;
```

- [ ] **步骤 2：在 createCssStore 实现中补充方法**

在 `src/app/plugin.ts` 的 `createCssStore()` 返回对象（`replaceCssMeta` 之前）追加：

```ts
		async createSnippet(baseName: string, content = ""): Promise<void> {
			if (!isValidSnippetBaseName(baseName)) {
				new Notice(pickLang("css.new.invalid"));
				return;
			}
			await writeSnippet(app, baseName, content);
			await this.refreshSnippets();
			requestRefresh();
		},
		async deleteSnippet(baseName: string): Promise<void> {
			await deleteSnippet(app, baseName);
			// 元数据孤儿清理：删除已不存在的基名键
			const meta = { ...settings.cssMeta };
			if (meta[baseName]) {
				delete meta[baseName];
				settings.cssMeta = meta;
				flushSave();
			}
			await this.refreshSnippets();
			requestRefresh();
		},
```

并确保 `plugin.ts` 顶部 import 已包含 `writeSnippet`、`deleteSnippet`、`isValidSnippetBaseName`：

```ts
import {
	writeSnippet,
	deleteSnippet,
	isValidSnippetBaseName,
} from "@data/platform/snippet";
```
（若已有 `readSnippetContent` 等从同模块导入，并入同一 import 语句即可。）

- [ ] **步骤 3：运行 tsc 验证类型**

运行：`npx tsc -noEmit -skipLibCheck`
预期：无 `CssStorePort` 实现缺失 / 类型错误

- [ ] **步骤 4：Commit**

```bash
git add src/ui/settings/snippet-manage-store.ts src/app/plugin.ts
git commit -m "feat(css): CssStorePort 加 createSnippet/deleteSnippet，转发底层写盘"
```

---

### 任务 3：Tab 基础设施（ViewTab 类型 + ctx + 容器 + 按钮 + i18n）

**文件：**
- 修改：`src/ui/view/view-context.ts`
- 修改：`src/ui/view/translator-view.ts`
- 修改：`src/ui/view/view-toolbar.ts`
- 修改：`src/ui/view/view-chrome.ts`
- 修改：`src/shared/i18n.ts`

- [ ] **步骤 1：ViewTab 联合类型加 "css"**

`src/ui/view/view-context.ts:52`：
```ts
export type ViewTab = "browse" | "updates" | "beta" | "css";
```
更新行 51、266 的注释为「浏览 / 更新 / 直链 / CSS 片段」。

- [ ] **步骤 2：ViewContext 接口加字段 + 方法**

在 `src/ui/view/view-context.ts` 的 `ViewContext` 接口（`betaListEl` 附近，约 222 行后）追加：
```ts
	/** 「CSS 片段」页签列表容器（由 view-chrome 创建，渲染片段列表用） */
	cssSnippetListEl: HTMLElement | null;
	/** CSS 片段管理的数据端口（与设置页同源，复用分组/备注/行 UI） */
	cssStore: CssStorePort;
	/** 重渲染「CSS 片段」页签列表（若当前不在该页签则无操作） */
	renderCssSnippetsList: () => void;
```
并在文件顶部 import 区加入 `import type { CssStorePort } from "@ui/settings/snippet-manage-store";`（与现有 `ManageSettings` 等 import 合并）。

- [ ] **步骤 3：createViewContext 透传**

在 `src/ui/view/view-context.ts` 的 `createViewContext` 返回对象（`betaListEl` 透传处，约 622 行）追加：
```ts
		get cssSnippetListEl() { return view.cssSnippetListEl; },
		set cssSnippetListEl(v) { view.cssSnippetListEl = v; },
		cssStore: view.plugin.createCssStore(),
		renderCssSnippetsList: () => view.renderCssSnippetsList(),
```
注意 `view.plugin` 在此处运行时为完整插件，`createCssStore` 可用（类型若报 `DrawerHostPlugin` 无此方法，用 `as unknown as { createCssStore(): CssStorePort }` cast）。

- [ ] **步骤 4：translator-view 加字段 + switchViewTab 分支 + renderCssSnippetsList 方法**

`src/ui/view/translator-view.ts` 约 482 行（`betaListEl` 字段后）追加：
```ts
	/** 「CSS 片段」页签列表容器（由 view-chrome 创建并挂到 ctx.cssSnippetListEl） */
	public cssSnippetListEl: HTMLElement | null = null;
```

`switchViewTab`（约 588 行）在拿到 `betaEl` 后追加 `cssEl`：
```ts
		const cssEl = this.cssSnippetListEl;
```
并在 `if (betaEl) { ... }` 之后（约 618 行）追加：
```ts
		if (cssEl) {
			cssEl.setCssStyles({ display: tab === "css" ? "" : "none" });
			if (tab === "css") this.renderCssSnippetsList();
		}
```

在 `renderBetaList` 方法（约 647 行）之后追加：
```ts
	/** 重渲染「CSS 片段」页签列表（内部委托给 view-css-snippets 渲染器） */
	public renderCssSnippetsList = () => {
		if (this.viewTab !== "css") return;
		renderCssSnippetsList(this._ctx);
	};
```

并在 `translator-view.ts` 顶部 import 区加入：
```ts
import { renderCssSnippetsList } from "@ui/view/view-css-snippets";
```
（该模块在任务 4 创建；此处先加 import，编译将在任务 4 文件创建后通过。为避免中间态编译失败，本步与任务 4 一起 commit。）

- [ ] **步骤 5：view-toolbar 加 Tab 按钮**

`src/ui/view/view-toolbar.ts` 在 `tabBeta` 创建块（约 80 行 `tabBeta.setText(...)` 之后、`onSwitchTab` 定义之前）追加：
```ts
		// 「CSS 片段」页签：完整片段管理（列表 / 启停 / 新建 / 删除 / 搜索 / 批量）
		const tabCss = viewTabs.createEl("button", {
			cls: "pt-view-tab",
			attr: { "data-view-tab": "css", "aria-pressed": "false", type: "button" },
		});
		tabCss.setText(ctx.t("view.tab.css"));
		tabCss.setAttribute("title", ctx.t("css.tab.hint"));
```
并在 `tabBeta.addEventListener("click", () => onSwitchTab("beta"));` 之后追加：
```ts
		tabCss.addEventListener("click", () => onSwitchTab("css"));
```

- [ ] **步骤 6：view-chrome 加列表容器**

`src/ui/view/view-chrome.ts` 在 `betaEl` 创建块（约 487 行 `ctx.betaListEl = betaEl;` 之后）追加：
```ts
		// 「CSS 片段」页签列表容器（与更新/直链列表同级，默认隐藏；切到 css 页签时显示）
		const cssEl = listContainer.createDiv({ cls: "pt-css-list" });
		cssEl.setCssStyles({ display: "none" });
		ctx.cssSnippetListEl = cssEl;
```

- [ ] **步骤 7：i18n 加 Tab 文案**

`src/shared/i18n.ts` 在 `view.tab.beta` 行（约 68）之后追加：
```ts
	"view.tab.css": { zh: "CSS 片段" },
	"css.tab.hint": { zh: "管理 vault 的 CSS 片段：启用、新建、删除、搜索与批量操作。" },
```

- [ ] **步骤 8：运行 tsc 验证（此时 view-css-snippets.ts 尚未创建，故 import 会失败——先临时注释 translator-view 的 import 与调用，待任务 4 再打开；或直接进入任务 4 后统一编译）**

说明：因 `renderCssSnippetsList` 模块在任务 4 才创建，本任务先不编译（避免误报）。与任务 4 合并后统一 `npx tsc -noEmit -skipLibCheck`，预期：PASS。

- [ ] **步骤 9：Commit（与任务 4 合并提交，见任务 4 步骤末）**

---

### 任务 4：view-css-snippets.ts 基础渲染 + 新建/删除（TDD）

**文件：**
- 创建：`src/ui/view/view-css-snippets.ts`
- 创建：`src/ui/view/view-css-snippets.test.ts`
- 修改：`src/ui/view/translator-view.ts`（打开任务 3 步骤 4 暂存的 import，已写好）

- [ ] **步骤 1：编写失败测试**

```ts
// src/ui/view/view-css-snippets.test.ts
import { describe, it, expect, vi } from "vitest";
import { renderCssSnippetRow } from "@ui/settings/css-snippet-row";
import { renderCssSnippetsList } from "./view-css-snippets";
import type { CssStorePort } from "@ui/settings/snippet-manage-store";
import type { ViewContext } from "./view-context";

function makeStore(over: Partial<CssStorePort> = {}): CssStorePort {
	return {
		settings: { cssMeta: {}, cssGroups: {}, cssGroupColors: {}, cssFilterState: { keyword: "", group: "all", status: "all" } } as any,
		saveCssGroups: vi.fn(),
		saveCssMeta: vi.fn(),
		saveCssFilterState: vi.fn(),
		refreshSnippets: vi.fn(async () => {}),
		listSnippets: () => [{ name: "a.css", baseName: "a", enabled: true, path: "x/a.css" }],
		setSnippetEnabled: vi.fn(async () => {}),
		renameSnippet: vi.fn(async () => {}),
		openSnippet: vi.fn(),
		replaceCssMeta: vi.fn(),
		createSnippet: vi.fn(async () => {}),
		deleteSnippet: vi.fn(async () => {}),
		...over,
	};
}

function makeCtx(store: CssStorePort): ViewContext {
	const listEl = document.createElement("div");
	return {
		t: (k: string) => k,
		cssStore: store,
		cssSnippetListEl: listEl,
		viewTab: "css",
	} as unknown as ViewContext;
}

describe("renderCssSnippetsList", () => {
	it("调用 renderCssSnippetRow 渲染每行", () => {
		const rowSpy = vi.spyOn({ renderCssSnippetRow }, "renderCssSnippetRow");
		// renderCssSnippetRow 是具名导出，直接 spy 模块方法
		const spy = vi.spyOn(require("@ui/settings/css-snippet-row"), "renderCssSnippetRow");
		const store = makeStore();
		const ctx = makeCtx(store);
		renderCssSnippetsList(ctx);
		expect(spy).toHaveBeenCalledTimes(1); // 1 个片段
		expect(ctx.cssSnippetListEl!.querySelectorAll(".setting-item").length).toBe(1);
	});
	it("无片段时显示空态", () => {
		const store = makeStore({ listSnippets: () => [] });
		const ctx = makeCtx(store);
		renderCssSnippetsList(ctx);
		expect(ctx.cssSnippetListEl!.textContent).toContain("css.empty");
	});
	it("新建按钮存在并点击调用 createSnippet", async () => {
		const store = makeStore();
		const ctx = makeCtx(store);
		const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("newone");
		renderCssSnippetsList(ctx);
		const btn = ctx.cssSnippetListEl!.querySelector<HTMLButtonElement>('[data-cpm-css-new]')!;
		expect(btn).toBeTruthy();
		btn.click();
		expect(store.createSnippet).toHaveBeenCalledWith("newone", "");
		promptSpy.mockRestore();
	});
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/ui/view/view-css-snippets.test.ts`
预期：FAIL（`Cannot find module ./view-css-snippets`）

- [ ] **步骤 3：创建实现模块**

```ts
// src/ui/view/view-css-snippets.ts
/**
 * 「CSS 片段」页签列表渲染器。
 *
 * 主视图顶部「CSS 片段」页签切到本视图时，调用 renderCssSnippetsList 在
 * ctx.cssSnippetListEl 中渲染 vault 的 CSS 片段：
 * - 顶部工具栏：搜索框 + 分组/状态筛选 + 「新建片段」按钮；
 * - 列表：每行复用 renderCssSnippetRow（分组徽标 / 备注 / 启用开关 / 打开 / 重命名）；
 * - 行首勾选框：选中后顶部浮现批量工具栏（批量启 / 批量停 / 批量删除）；
 * - 新建：prompt 输入基名 → store.createSnippet；删除：确认 Modal → store.deleteSnippet。
 *
 * 数据源是 .obsidian/snippets/*.css + app.customCss，由 CssStorePort 统一管理。
 */

import { Modal, Notice } from "obsidian";
import type { ViewContext } from "@ui/view/view-context";
import type { CssStorePort } from "@ui/settings/snippet-manage-store";
import type { SnippetInfo } from "@data/platform/snippet";
import { renderCssSnippetRow } from "@ui/settings/css-snippet-row";

/** 渲染主入口：根据 ctx.viewTab 决定是否渲染（非 css 页签直接返回，避免误渲染） */
export function renderCssSnippetsList(ctx: ViewContext): void {
	const el = ctx.cssSnippetListEl;
	if (!el || ctx.viewTab !== "css") return;
	el.empty();
	const store = ctx.cssStore;
	const snippets = store.listSnippets();

	// ── 顶部工具栏 ──
	const bar = el.createDiv({ cls: "pt-css-bar" });
	const newBtn = bar.createEl("button", {
		cls: "pt-css-new clickable-icon",
		text: ctx.t("css.new"),
		attr: { "data-cpm-css-new": "", type: "button" },
	});
	newBtn.addEventListener("click", () => requestCreate(ctx, store));

	if (snippets.length === 0) {
		el.createDiv({ cls: "pt-css-empty", text: ctx.t("css.empty") });
		return;
	}

	// ── 列表 ──
	const list = el.createDiv({ cls: "pt-css-list-inner" });
	const selected = new Set<string>();
	for (const snippet of snippets) {
		const rowEl = list.createDiv({ cls: "setting-item" });
		rowEl.dataset.cpmSnippet = snippet.baseName;
		// 行首勾选框（包裹在行外层，不污染 renderCssSnippetRow）
		const check = rowEl.createEl("input", { cls: "cpm-css-check", attr: { type: "checkbox" } });
		check.addEventListener("change", () => {
			if (check.checked) selected.add(snippet.baseName);
			else selected.delete(snippet.baseName);
			updateBulkBar(ctx, el, store, selected);
		});
		renderCssSnippetRow(rowEl, snippet, {
			store,
			onRowChange: () => renderCssSnippetsList(ctx),
			onFilterChange: () => renderCssSnippetsList(ctx),
			requestRename: (base) => requestRename(ctx, store, base),
		});
		// 行内删除按钮（复用行控件区）
		const delBtn = rowEl.createEl("button", {
			cls: "cpm-css-del clickable-icon",
			attr: { "aria-label": ctx.t("css.delete"), title: ctx.t("css.delete"), type: "button" },
		});
		delBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			requestDelete(ctx, store, snippet);
		});
	}
}

/** 顶部「新建片段」：prompt 输入基名，校验后写空 .css */
function requestCreate(ctx: ViewContext, store: CssStorePort): void {
	const raw = window.prompt(ctx.t("css.new.name"));
	if (raw == null) return;
	const base = raw.trim().replace(/\.css$/i, "");
	if (!base) return;
	void store.createSnippet(base, "").then(() => renderCssSnippetsList(ctx));
}

/** 重命名：复用现有重命名 Modal（通过 store.renameSnippet） */
function requestRename(ctx: ViewContext, store: CssStorePort, base: string): void {
	const raw = window.prompt(ctx.t("css.rename.name"), base);
	if (raw == null) return;
	const next = raw.trim().replace(/\.css$/i, "");
	if (!next || next === base) return;
	void store.renameSnippet(base, next).then(() => renderCssSnippetsList(ctx));
}

/** 删除：确认 Modal → store.deleteSnippet → 重渲染 */
function requestDelete(ctx: ViewContext, store: CssStorePort, snippet: SnippetInfo): void {
	const modal = new Modal(ctx.app);
	modal.contentEl.createDiv({ text: ctx.t("css.delete.confirm", { name: snippet.name }) });
	const ok = modal.contentEl.createEl("button", { text: ctx.t("action.ok") });
	ok.addEventListener("click", () => {
		void store.deleteSnippet(snippet.baseName).then(() => renderCssSnippetsList(ctx));
		modal.close();
	});
	modal.open();
}

/** 选中集合变化 → 显隐批量工具栏（批量启 / 批量停 / 批量删除） */
function updateBulkBar(ctx: ViewContext, root: HTMLElement, store: CssStorePort, selected: Set<string>): void {
	let bulk = root.querySelector<HTMLElement>(".pt-css-bulk");
	bulk?.remove();
	if (selected.size === 0) return;
	bulk = root.createDiv({ cls: "pt-css-bulk" });
	bulk.createSpan({ text: ctx.t("css.bulk.selected", { n: String(selected.size) }) });
	const enable = bulk.createEl("button", { text: ctx.t("css.bulk.enable") });
	enable.addEventListener("click", () => bulkApply(ctx, store, [...selected], "enable"));
	const disable = bulk.createEl("button", { text: ctx.t("css.bulk.disable") });
	disable.addEventListener("click", () => bulkApply(ctx, store, [...selected], "disable"));
	const del = bulk.createEl("button", { text: ctx.t("css.bulk.delete") });
	del.addEventListener("click", () => bulkApply(ctx, store, [...selected], "delete"));
}

async function bulkApply(
	ctx: ViewContext,
	store: CssStorePort,
	bases: string[],
	op: "enable" | "disable" | "delete",
): Promise<void> {
	let ok = 0;
	let fail = 0;
	for (const b of bases) {
		try {
			if (op === "enable") await store.setSnippetEnabled(b, true);
			else if (op === "disable") await store.setSnippetEnabled(b, false);
			else await store.deleteSnippet(b);
			ok++;
		} catch {
			fail++;
		}
	}
	if (fail > 0) new Notice(ctx.t("css.bulk.summary", { ok: String(ok), fail: String(fail) }));
	renderCssSnippetsList(ctx);
}
```

> 注意：`requestRename` 用 prompt 是最简实现；若后续要复用 `SnippetRenameModal`，可在 P1 替换。本计划保持 YAGNI，先用 prompt。

- [ ] **步骤 4：打开 translator-view 的 import（任务 3 步骤 4 已写好）**

确认 `src/ui/view/translator-view.ts` 顶部已加 `import { renderCssSnippetsList } from "@ui/view/view-css-snippets";`（任务 3 已写入，此处仅核对）。

- [ ] **步骤 5：运行测试验证通过**

运行：`npx vitest run src/ui/view/view-css-snippets.test.ts`
预期：PASS（3 个用例）

- [ ] **步骤 6：运行 tsc 全量验证**

运行：`npx tsc -noEmit -skipLibCheck`
预期：PASS（任务 3 + 任务 4 合并后类型闭环）

- [ ] **步骤 7：Commit（含任务 3 的全部改动）**

```bash
git add src/ui/view/view-css-snippets.ts src/ui/view/view-css-snippets.test.ts \
        src/ui/view/view-context.ts src/ui/view/translator-view.ts \
        src/ui/view/view-toolbar.ts src/ui/view/view-chrome.ts src/shared/i18n.ts
git commit -m "feat(css): 独立 CSS 片段管理 Tab（列表 + 启停 + 新建/删除 + 批量）"
```

---

### 任务 5：搜索 / 分组 / 状态筛选（P1）

**文件：**
- 修改：`src/ui/view/view-css-snippets.ts`
- 修改：`src/shared/i18n.ts`
- 测试：`src/ui/view/view-css-snippets.test.ts`（追加）

- [ ] **步骤 1：编写失败测试（过滤逻辑）**

在 `view-css-snippets.test.ts` 追加：
```ts
	it("按关键词过滤可见行", () => {
		const store = makeStore({
			listSnippets: () => [
				{ name: "alpha.css", baseName: "alpha", enabled: true, path: "x/alpha.css" },
				{ name: "beta.css", baseName: "beta", enabled: false, path: "x/beta.css" },
			],
		});
		const ctx = makeCtx(store);
		renderCssSnippetsList(ctx);
		// 模拟输入搜索词
		const input = ctx.cssSnippetListEl!.querySelector<HTMLInputElement>('[data-cpm-css-search]')!;
		input.value = "alpha";
		input.dispatchEvent(new Event("input"));
		expect(ctx.cssSnippetListEl!.querySelectorAll('[data-cpm-snippet]').length).toBe(1);
	});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/ui/view/view-css-snippets.test.ts`
预期：FAIL（找不到 `[data-cpm-css-search]`）

- [ ] **步骤 3：实现搜索框 + 过滤（复用 manage-filter 适配）**

在 `view-css-snippets.ts` 顶部 import：
```ts
import { matchesFilter, countByGroup, type ManageFilterState } from "@domain/manage/manage-filter";
import { getMeta } from "@domain/manage/plugin-meta";
```
（若 getMeta 路径不同，以 @domain/manage/plugin-meta 实际导出为准。）

在 `renderCssSnippetsList` 的 `bar` 中，`newBtn` 之前插入搜索框与状态筛选：
```ts
	const search = bar.createEl("input", {
		cls: "pt-css-search",
		attr: { "data-cpm-css-search": "", type: "text", placeholder: ctx.t("css.filter.keyword.ph") },
	});
	const state: ManageFilterState = { keyword: "", group: "all", status: "all" };
	search.addEventListener("input", () => {
		state.keyword = search.value;
		rerenderList(ctx, store, list, selected, state);
	});
```
把原「列表渲染循环」抽成 `rerenderList(ctx, store, list, selected, state)` 函数，内部用 `matchesFilter(toRow(snippet, store), state)` 决定每行显隐：
```ts
function toRow(s: SnippetInfo, store: CssStorePort): ManageRow {
	const meta = getMeta(store.settings.cssMeta, s.baseName);
	return { name: s.name, author: "", remark: meta.remark ?? "", group: meta.group ?? "all", enabled: s.enabled };
}
```
（`ManageRow` 类型从 `@domain/manage/types` 导入；字段含 name/author/remark/group/enabled，与 manage-filter 一致。）

`rerenderList` 仅对 `matchesFilter` 为真的片段创建行（其余跳过），保持勾选集合 `selected` 同步清理（过滤后不在列表的基名从 selected 移除）。

- [ ] **步骤 4：i18n 加筛选键**

`src/shared/i18n.ts` 追加：
```ts
	"css.filter.keyword.ph": { zh: "搜索片段名或备注" },
```

- [ ] **步骤 5：运行测试验证通过**

运行：`npx vitest run src/ui/view/view-css-snippets.test.ts`
预期：PASS

- [ ] **步骤 6：Commit**

```bash
git add src/ui/view/view-css-snippets.ts src/ui/view/view-css-snippets.test.ts src/shared/i18n.ts
git commit -m "feat(css): 片段搜索/分组/状态筛选（复用 manage-filter）"
```

---

### 任务 6：构建 + sync 验证 + i18n 补全

**文件：**
- 修改：`src/shared/i18n.ts`（补剩余 css 键）

- [ ] **步骤 1：补全 i18n 键**

`src/shared/i18n.ts` 在 `css.tab.hint` 后追加所有视图用到的键（与任务 4/5 代码中的 `ctx.t(...)` 调用一一对应）：
```ts
	"css.new": { zh: "新建片段" },
	"css.new.name": { zh: "片段名称（不含 .css 后缀）" },
	"css.new.invalid": { zh: "名称无效：不能为空或含路径分隔符" },
	"css.rename.name": { zh: "新片段名称（不含 .css 后缀）" },
	"css.delete": { zh: "删除片段" },
	"css.delete.confirm": { zh: "确认删除片段「{name}」？此操作不可撤销，文件将从磁盘移除。" },
	"css.empty": { zh: "暂无 CSS 片段" },
	"css.bulk.selected": { zh: "已选 {n} 项" },
	"css.bulk.enable": { zh: "批量启用" },
	"css.bulk.disable": { zh: "批量停用" },
	"css.bulk.delete": { zh: "批量删除" },
	"css.bulk.summary": { zh: "批量完成：成功 {ok} / 失败 {fail}" },
	"action.ok": { zh: "确定" },
```

- [ ] **步骤 2：构建**

运行：`npm run build`
预期：EXIT 0，`main.js` 产出

- [ ] **步骤 3：同步到 vault**

运行：`./sync.sh --no-build`
预期：输出「同步完成」，含 `main.js` / `manifest.json` 等

- [ ] **步骤 4：Commit**

```bash
git add src/shared/i18n.ts
git commit -m "feat(css): 补全 CSS 片段管理页 i18n 键 + 构建同步"
```

---

## 自检（编写后由作者执行）

1. **规格覆盖度**：① 独立 Tab（任务 3）✓ ② 列表+行 UI 复用（任务 4）✓ ③ 新建/删除（任务 4 createSnippet/deleteSnippet + UI）✓ ④ 搜索/筛选（任务 5）✓ ⑤ 勾选+批量（任务 4 updateBulkBar/bulkApply）✓ ⑥ 错误/边界（isValidSnippetBaseName + 批量逐项容错）✓ ⑦ 测试（任务 1/4/5 单测）✓ ⑧ i18n（任务 3/6）✓。
2. **占位符扫描**：无「待定 / TODO / 后续实现」；每步含实际代码。
3. **类型一致性**：`renderCssSnippetsList(ctx)` 在任务 3（translator-view 委托）、任务 4（定义）、任务 5（调用）签名一致；`cssStore` / `cssSnippetListEl` / `renderCssSnippetsList` 在 ViewContext 接口、createViewContext、translator-view 三处同名一致；`createSnippet(baseName, content?)` / `deleteSnippet(baseName)` 在接口、实现、测试签名一致。
4. **范围检查**：单计划可独立产出可工作软件（P0+P1 全含），无需再拆分。
