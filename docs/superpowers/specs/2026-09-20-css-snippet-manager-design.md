# CSS 片段管理 Tab 设计（2026-09-20）

## 背景

Obsidian 1.10+ 把「设置 → 外观 → CSS 片段」收拢成「已启用 N 个 ›」汇总行，原生不再逐行列出片段。
本插件已在**设置页增强器**（`SnippetListEnhancer` + `renderCssSnippetRow`）补回了行列表（分组徽标 / 备注 / 启用开关 / 打开文件 / 重命名）。

用户希望在插件市场主视图顶部 Tab 栏新增一个独立 **「CSS 片段」** Tab，做一个完整的片段管理页：
独立入口、完整 CRUD、搜索/筛选、勾选式批量操作。这样用户不必进设置页即可管理片段。

数据层 `data/platform/snippet.ts` 已具备全部底层能力（`writeSnippet` / `deleteSnippet` / `renameSnippet` /
`setSnippetEnabled` / `readSnippetContent` / `openSnippetInDefaultApp`），只是 `CssStorePort` 接口未暴露
创建/删除。行 UI `renderCssSnippetRow` 也已完备。本设计主要补「入口 + 页面模块 + 数据接口暴露 + 批量交互」。

## 目标

1. 主视图顶部 Tab 栏新增「CSS 片段」，与「浏览 / 更新 / 直链」平级，点击切换进独立管理页。
2. 管理页列出全部 CSS 片段，每行复用现有行 UI（分组 / 备注 / 启停 / 打开 / 重命名）。
3. 支持新建片段（写空 `.css`）与删除片段（磁盘删除 + 元数据孤儿清理）。
4. 支持搜索 / 分组筛选。
5. 支持勾选 + 顶部批量工具栏（批量启 / 批量停 / 批量删除）。

## 非目标（YAGNI，本次不做）

- 片段内容编辑器（行内编辑 .css 文本）—— 用系统默认应用「打开」即可编辑，不在市场内做编辑器。
- 片段导入/导出、版本历史、云端同步。
- 直链式远程片段（仅管理本地 `snippets/` 目录下的 `.css`）。
- 移动端专属适配（打开/删除依赖桌面能力，移动端对应按钮静默失效即可，沿用现有 `openSnippet` 行为）。

## 架构总览

新建独立渲染模块 `src/ui/view/view-css-snippets.ts`，与现有 `view-updates.ts` / `view-beta.ts` 对称。
主视图 `ChinesePluginMarketView` 在 `viewTab === "css"` 时委托该模块渲染，复用 `renderCssSnippetRow` 画行。

数据通过现有 `CssStorePort`（注入 `app` 层已有的 store 工厂）读写，仅扩展 `createSnippet` / `deleteSnippet` 两方法。

```
translator-view.ts
  └─ viewTab: "css"  ──┐
view-css-snippets.ts   ◄ 渲染模块（新建）
  ├─ 工具栏（搜索 / 分组筛选 / 新建 / 批量工具栏）
  ├─ 列表（renderCssSnippetRow 复用，每行加勾选框）
  └─ 批量操作（createSnippet/deleteSnippet/setSnippetEnabled 调 store）
        │
CssStorePort（扩展 createSnippet / deleteSnippet）
        │
data/platform/snippet.ts（已具备 writeSnippet / deleteSnippet / setSnippetEnabled / renameSnippet）
```

## 分阶段（分多次迭代）

**P0 — 独立 Tab + 列表 + 单条 CRUD**
- `ViewTab` 联合类型加 `"css"`；Tab 栏渲染 + 切换。
- `view-css-snippets.ts` 基础版：顶部「新建片段」按钮 + 列表（复用 `renderCssSnippetRow`）+ 启停/重命名/打开。
- `CssStorePort` 加 `createSnippet` / `deleteSnippet`；store 工厂接入 `writeSnippet` / `deleteSnippet`。
- 进入 Tab 调 `refreshSnippets()` 预扫。

**P1 — 搜索 / 筛选 / 批量**
- 搜索框 + 分组筛选下拉（复用 `manage-filter` 的 `ManageFilterState` / `matchesFilter` / `countByGroup`）。
- 每行勾选框；选中后顶部浮现批量工具栏（批量启 / 批量停 / 批量删除）。

## 接口变更

`src/ui/settings/snippet-manage-store.ts` 的 `CssStorePort` 增加：

```ts
/** 新建片段：在 <configDir>/snippets/<baseName>.css 写空文件（content 可选） */
createSnippet(baseName: string, content?: string): Promise<void>;
/** 删除片段文件（含已禁用状态的元数据孤儿清理触发） */
deleteSnippet(baseName: string): Promise<void>;
```

实现方（`createCssStore` 工厂，设置页创建 store 处）转发到 `data/platform/snippet` 的
`writeSnippet(app, baseName, content ?? "")` / `deleteSnippet(app, baseName)`。
删除后触发 `replaceCssMeta` 孤儿清理（沿用现有路径），并 `refreshSnippets()` 重扫。

## UI 结构（view-css-snippets.ts）

```
.cpm-view-root
  .cpm-css-toolbar                ← 常驻：搜索框 / 分组筛选 / 新建片段按钮
  .cpm-css-bulkbar (hidden)      ← 选中后显示：批量启 / 批量停 / 批量删除 / 已选 N
  .cpm-css-list
    .setting-item (每行)          ← renderCssSnippetRow 渲染 + 行首勾选框
  .cpm-css-empty                 ← 真空态引导
```

- 行 UI 完全复用 `renderCssSnippetRow`，仅在该模块外层给每行包一个勾选框（不污染行渲染器本身）。
- 工具栏与 `SnippetListEnhancer` 的筛选栏口径一致，避免行为漂移。

## 数据流

1. 进入 css Tab → `store.refreshSnippets()` 异步预扫 → 拿到 `SnippetInfo[]` 镜像。
2. 渲染：遍历 list，每条 `renderCssSnippetRow(rowEl, snippet, ctx)`。
3. 启停：`store.setSnippetEnabled(base, enabled)`（`setCssEnabledStatus` + 重载，现有）。
4. 新建：弹窗取 baseName → `store.createSnippet(base, "")` → `refreshSnippets()` → 重渲染。
5. 删除：确认 Modal → `store.deleteSnippet(base)` → 孤儿清理 + `refreshSnippets()` → 重渲染。
6. 筛选/搜索：纯前端 `matchesFilter(snippet, filterState)`，不改数据层。
7. 批量：收集勾选集合 → 批量调 4/5 对应 store 方法，逐项容错。

## 错误处理与边界

- 所有磁盘写沿用 `data/platform/snippet` 的 fire-and-forget + try/catch 风格，失败 `Notice`，绝不抛原生链。
- `refreshSnippets` 未完成时 `listSnippets` 返回空数组 = 加载态；已扫完且无片段 = 真空态。两者文案区分。
- 批量操作逐项容错：单条失败不影响其余，最后汇总 `Notice`（成功 N / 失败 M）。
- baseName 校验：空名 / 含路径分隔符 / 与现有重名 → 拦截并 `Notice`，不写盘。
- 删除前确认 Modal（防误删）；删除后禁用状态由 `setCssEnabledStatus(base, false)` 兜底清理。

## 测试

- `view-css-snippets` 单测（mock `CssStorePort`）：
  - 列表渲染正确调用 `renderCssSnippetRow`；
  - 搜索/分组过滤正确筛选可见行；
  - 勾选集合与批量工具栏显隐；
  - 批量启/停/删逐项容错。
- `renderCssSnippetRow` 已有测试，**无需改动**（行渲染器不在本设计修改范围内）。
- `data/platform/snippet` 的 `writeSnippet` / `deleteSnippet` 不新增测试（已存在且容错完备）。

## 风险 / 回归

- 不改动 `SnippetListEnhancer` / `renderCssSnippetRow` / `data/platform/snippet`，回归面为零。
- 仅扩展 `CssStorePort` 接口（加方法，不破坏现有实现），设置页增强器不受影响。
- 新增独立模块，与现有 browse/update/直链 Tab 互不干扰。
