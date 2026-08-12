# 卸载确认弹窗 UI 审计与改进计划

## 设计语言

- **审计界面**：插件卡片上的「卸载」操作所触发的二次确认弹窗（`UninstallConfirmModal`，`src/ui/view/view-cards.ts:116-141`）。
- **设计来源**：仓库无独立 `DESIGN.md`，设计契约来自插件自身现有组件的实际样式：
  - 详情抽屉操作按钮：`.pt-detail-btn`（`styles.css:2710-2744`）
  - 卡片主操作按钮：`.pt-card-action-btn`（同文件相关规则）
- **已记录的决策**：
  - 插件内通用按钮统一为 `.pt-detail-btn`：圆角 8px、边框 1px、inline-flex、gap 5px、padding 7px 14px、字号 `var(--pt-text-md)`。
  - 主 CTA 变体 `.pt-detail-btn.mod-cta`：pill 形状、填充主题色、无 border、半粗体、阴影。
  - 破坏性操作目前没有独立变体，但应沿用同一按钮原语，通过颜色区分危险等级。
- **管辖所有者和消费者**：
  - 按钮原语所有者：`styles.css` 中的 `.pt-detail-btn`。
  - 当前违规使用者：`UninstallConfirmModal` 直接创建裸 `<button class="mod-cta">` / `<button class="mod-warning">`，未继承 `.pt-detail-btn` 系统。
- **明确的异常**：无记录。

## 发现

| # | 问题 | 证据 | 提议的变更 | 范围 | 置信度 |
| --- | --- | --- | --- | --- | --- |
| 1 | **按钮风格与插件设计系统不统一**：弹窗使用 Obsidian 默认 `mod-cta`（绿色）和 `mod-warning`（橙红色）裸按钮，而插件其余按钮（详情抽屉、卡片操作、错误重试等）均使用 `.pt-detail-btn` 体系。 | 运行时路径：`UninstallConfirmModal.onOpen()`（`src/ui/view/view-cards.ts:136-140`）直接 `createEl("button", { cls: "mod-cta" })` 与 `createEl("button", { cls: "mod-warning" })`，未加 `pt-detail-btn`。截图显示绿色「取消」与橙红色「卸载」圆角、粗细、阴影均与详情抽屉 pill 按钮不一致。 | 将两个按钮统一改为 `pt-detail-btn` 体系：「取消」用基础 `.pt-detail-btn` 描边样式；「卸载」用 `.pt-detail-btn mod-warning`（新建危险变体，复用圆角/字号/内边距，仅改背景/文字/边框色为 `--text-error` 系列），使视觉语言与 `.pt-detail-btn.mod-cta` 一致。 | `src/ui/view/view-cards.ts` + `styles.css` | 高 |
| 2 | **按钮布局/间距不规范**：`modal-button-row` 完全依赖 Obsidian 默认样式，截图中按钮贴近右侧边缘、与警告块间距过小，无统一 gap。 | `styles.css` 中 0 命中 `modal-button-row` / `pt-uninstall-actions` 相关规则；`view-cards.ts:131` 仅创建 `cls: "modal-button-row"`，未接入插件间距系统。 | 给按钮容器加 `.pt-uninstall-actions`，使用 `display: flex; justify-content: flex-end; gap: var(--pt-space-sm); margin-top: var(--pt-space-lg)`，按钮加 `min-width` 保证等宽。 | `src/ui/view/view-cards.ts` + `styles.css` | 高 |
| 3 | **警告块视觉层级过强/不协调**：截图中警告块是满宽红底条，文字与底色对比不足，且紧贴弹窗两侧，破坏呼吸感。 | 当前 `styles.css` 已新增 `.pt-uninstall-warn`（本次审计前的改动），使用 `var(--text-error)` 文字 + 红底色块 + 红边框，但背景透明度仅 10%，在浅色主题下仍显浑浊。 | 将警告块改为左侧强调线样式（border-left + 透明背景），或降低背景饱和度、增加内边距与文字对比，使其成为「提示」而非「告警横幅」。 | `styles.css` | 中 |

## 优先改进

选择 **发现 #1 + #2 合并执行**：因为按钮风格不统一和布局问题直接决定弹窗看起来是否「像我们插件」，且修复只需在同一处组件与样式表内完成，成本最低、影响最直接。

## 实施计划

### 目标
让卸载确认弹窗的按钮与布局完全复用插件现有 `.pt-detail-btn` 设计系统，视觉上与详情抽屉、卡片操作按钮保持一致。

### 涉及的文件
1. `src/ui/view/view-cards.ts`（`UninstallConfirmModal` 类）
2. `styles.css`（追加/调整卸载弹窗样式）

### 步骤

#### 步骤 1：统一按钮类名
在 `src/ui/view/view-cards.ts:131-140` 的 `UninstallConfirmModal.onOpen()` 中：
- 给按钮容器增加 `.pt-uninstall-actions` 类名（保留 `.modal-button-row` 以兼容 Obsidian 默认样式结构）。
- 「取消」按钮：`cls: "pt-detail-btn"`（描边默认样式）。
- 「卸载」按钮：`cls: "pt-detail-btn mod-warning"`（复用 `.pt-detail-btn` 圆角/字号/内边距，新增 `.mod-warning` 危险变体）。

当前代码（已做部分前期改动）：
```ts
const actions = contentEl.createDiv({ cls: "modal-button-row pt-uninstall-actions" });
actions.createEl("button", { text: "取消", cls: "mod-cta" }).addEventListener("click", () => {
  this.close();
  this.resolve(false);
});
actions.createEl("button", { text: "卸载", cls: "mod-warning" }).addEventListener("click", () => {
  this.close();
  this.resolve(true);
});
```

改为：
```ts
const actions = contentEl.createDiv({ cls: "modal-button-row pt-uninstall-actions" });
actions.createEl("button", { text: "取消", cls: "pt-detail-btn" }).addEventListener("click", () => {
  this.close();
  this.resolve(false);
});
actions.createEl("button", { text: "卸载", cls: "pt-detail-btn mod-warning" }).addEventListener("click", () => {
  this.close();
  this.resolve(true);
});
```

#### 步骤 2：新增 `.pt-detail-btn.mod-warning` 变体
在 `styles.css` 的 `.pt-detail-btn.mod-cta` 规则之后，新增危险 CTA 变体：

```css
/* 危险操作按钮（卸载/删除）：与 mod-cta 同形，仅色变 */
.pt-detail-btn.mod-warning {
	color: var(--text-on-accent);
	background: var(--text-error);
	border: none;
	border-radius: var(--pt-radius-pill);
	font-weight: var(--pt-weight-semibold);
	padding: var(--pt-space-sm) var(--pt-space-xl);
	font-size: var(--pt-text-base);
	box-shadow: 0 1px 3px color-mix(in srgb, var(--text-error) 30%, transparent);
}
.pt-detail-btn.mod-warning:hover {
	background: color-mix(in srgb, var(--text-error) 88%, var(--background-primary));
	box-shadow: 0 2px 8px color-mix(in srgb, var(--text-error) 40%, transparent);
}
```

说明：保持与 `.pt-detail-btn.mod-cta` 完全相同的 pill 形状、字号、字重、内边距、阴影，仅将颜色替换为 `--text-error`，确保风格统一且危险语义明确。

#### 步骤 3：优化按钮容器布局
在 `styles.css` 中已有的 `.pt-uninstall-actions` 规则上调整：

```css
.pt-uninstall-actions {
	display: flex;
	justify-content: flex-end;
	gap: var(--pt-space-sm);
	margin-top: var(--pt-space-lg);
}
.pt-uninstall-actions .pt-detail-btn {
	min-width: 80px;
	justify-content: center;
}
```

#### 步骤 4：优化警告文案块
将当前 `.pt-uninstall-warn` 的「满宽红底条」改为左侧强调线 + 低饱和背景，避免与按钮打架：

```css
.pt-uninstall-warn {
	margin: 0;
	padding: var(--pt-space-md);
	border-radius: var(--pt-radius-sm);
	background: color-mix(in srgb, var(--text-error) 6%, transparent);
	border-left: 4px solid var(--text-error);
	border-top: none;
	border-right: none;
	border-bottom: none;
	color: var(--text-normal);
	font-size: var(--font-ui-small);
	line-height: 1.6;
}
.pt-uninstall-warn strong {
	color: var(--text-error);
	font-weight: var(--pt-weight-semibold);
}
```

并在 `view-cards.ts` 的警告文案中把「不可撤销」用 `<strong>` 包裹：
```ts
contentEl.createEl("p", {
  cls: "pt-uninstall-warn",
  text: "确定卸载该插件？插件文件将从磁盘删除，此操作不可撤销。",
});
```
由于 `createEl("p", { text: ... })` 会把字符串当作纯文本插入，需要用 `createEl("p", { cls: "pt-uninstall-warn" })` 后手动 `createEl("strong", { text: "不可撤销" })`，或接受纯文本版本仅保留左边框样式。

### 验证清单
- [ ] `tsc -noEmit` 无类型错误。
- [ ] `npm run build` 成功。
- [ ] Obsidian reload 后点击「卸载」按钮，弹窗按钮为 pill 形状，「取消」描边灰/白，「卸载」红色填充。
- [ ] 警告块为左侧红条，文字不过度抢眼。
- [ ] 弹窗在浅色/深色主题下均不崩坏。

### 范围外
- 不修改弹窗的确认逻辑、卸载逻辑、状态刷新逻辑。
- 不引入新的设计令牌或通用按钮组件；本次仅让弹窗复用已有 `.pt-detail-btn` 系统。
