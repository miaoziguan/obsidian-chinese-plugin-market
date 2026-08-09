# UI 审计报告 — 中文区插件市场视图（obsidian-plugin-translator）

> **状态：已闭环（2026-08-09，#8）** —— 本报告三条漂移均已修复，验收通过。
> 复核时发现 P1 徽章金色、P2 字号标尺、P3 裸 `#fff` 在报告发布后的迭代中已陆续落地，
> 但同一「裸色不随 `--pt-gold` 暗色覆盖」根因仍有 6 处残留（`.pt-card.is-recommended`、
> `.pt-card.is-favorited`、`@keyframes pt-fav-pulse`、`--pt-gold-muted` 定义本身），
> 以及 #13 新引入的召回信号徽标 3 色裸 hex —— 已一并收敛为令牌。详见文末「七、闭环记录」。
> **下方行号为 2026-08-03 审计时的快照，现已漂移，仅作历史证据保留。**

> 审计方式：严格只读源码（styles.css / src/*.ts 渲染路径），所有发现均附带「文件:行号」证据。
> 审计日期：2026-08-03
> 审计范围：主产品任务界面 —— 插件市场列表视图（卡片、工具栏、筛选、推荐徽章、字典行）。
> 设计契约来源：`styles.css` 顶部 v5 设计升级区块（L1–L120）定义的令牌体系。

---

## 一、设计系统证据（契约来源）

`styles.css` 顶部声明了完整的设计令牌体系，并明确两条约束：

1. **主题适配约束**（L4）："借用宿主 CSS 变量，自动适配明/暗主题，不引入外部字体与色板"
2. **排版节奏约束**（L107 注释）："替换散落值，统一视觉节奏" —— 已定义 6 阶模块化字号标尺：
   - `--pt-text-2xs: 0.58rem` / `--pt-text-xs: 0.64rem` / `--pt-text-sm: 0.72rem`
   - `--pt-text-base: 0.78rem` / `--pt-text-md: 0.85rem` / `--pt-text-lg: 0.92rem`
   - `--pt-text-xl: 1.1rem` / `--pt-text-2xl: 1.25rem`（L108–L115）
3. **金色语义令牌**（L53）：`--pt-gold: #d99a1c`，并在暗色主题下覆盖为 `--pt-gold: #b8841a`（L138）。

**结论**：任何组件使用裸 `#xxxxxx` 颜色或裸 `px` 字号，都构成对 v5 契约的偏离。

---

## 二、已验证的设计漂移问题

### 问题 1（真实 Bug，高优先级）：推荐徽章金色不随暗色主题切换

**证据链**：
- 令牌定义：亮色 `--pt-gold: #d99a1c`（L53），暗色覆盖 `--pt-gold: #b8841a`（L138）
- 推荐徽章亮色背景（L1484）：`background: linear-gradient(135deg, #e6b54a, #c8881a);` —— **裸色，未引用 `--pt-gold`**
- 推荐徽章暗色背景（L1492–L1493）：
  ```css
  background: linear-gradient(135deg,
      color-mix(in srgb, #e6b54a 50%, var(--pt-surface-2, var(--background-secondary))),
      color-mix(in srgb, #c8881a 50%, var(--pt-surface-2, var(--background-secondary)))
  );
  ```
  —— **仍用裸 `#e6b54a/#c8881a`，完全无视 L138 的暗色 `--pt-gold: #b8841a` 覆盖值**
- 同文件其他金色用法已正确引用令牌：`--pt-gold` 在 L1468/L4597、`color-mix(... #d99a1c ...)` 在 L1464/L1469/L1470/L1496，证明"应引用令牌"是既有共识。

**影响**：暗色主题下推荐徽章保持亮色金（刺眼、与 L138 暗色令牌自相矛盾），违反 v5"自动适配明/暗主题"约束（L4）。
**根因**：徽章 gradient 用裸 hex 而非 `var(--pt-gold)` + `color-mix`，导致暗色覆盖失效。

### 问题 2（系统性漂移，中优先级）：字号标尺未落地，22 处裸 px 硬编码

**证据**：v5 已定义 6 阶字号标尺（L108–L115），但搜索发现 22 处直接使用裸 `px` 字号，未引用 `--pt-text-*` 令牌：
- `.pt-dict-add-row .pt-dict-input`：`font-size: 12.5px;`（L2130）
- `.pt-dict-add-row button`：`font-size: 12.5px;`（L2141）
- 卡片/工具栏/筛选项散落：`10px`(L2212) / `11px`(L2241) / `12px`(L2221/L2234/L3025/L3036/L3043) / `13px`(L2578/L2595/L2632/L2672) / `14px`(L2197/L2610/L4297) / `11.5px`(L2995/L3011) 等

**对比正例**：同文件推荐徽章已正确使用 `--pt-text-xs`（L1480），证明裸 px 确属"已定义令牌却未使用"的漂移，而非令牌缺失。
**影响**：视觉节奏不统一，且字体大小无法随设计令牌集中调整（违背 L107 注释意图）。

### 问题 3（轻微，低优先级）：几处裸 `#fff` 未走 `--text-on-accent`

**证据**：L1483、L1944、L3978 使用 `color: #fff;`，而同类强调文本在其他处用 `color: var(--text-on-accent, #fff)`（L1127/L1800/L2099/L2106/L3810）。
**影响**：在极端自定义主题（宿主 `--text-on-accent` 非白）下，这几处文字会失去对比度适配。范围小、风险低。

---

## 三、未发现问题（正向结论，供实施时勿过度修改）

- 间距系统已统一：组件普遍使用 `--pt-space-*` 令牌（如 L1477–L1479 推荐徽章），未发现裸 px 间距漂移。
- 圆角系统已统一：卡片/按钮普遍引用 `--pt-radius-*` / `--radius-*`，未发现漂移。
- 焦点系统统一：`.pt-view :focus{outline:none}` + `--pt-focus-ring`（L12–L15、L95）已全局应用，未见第二种硬边框。
- 阴影克制：符合 v5"极弱阴影用于分层"意图（L88–L91）。

---

## 四、实施计划（供另一智能体执行，保持只读审计的改动最小化）

### P1 — 修复推荐徽章暗色金色（问题 1，必做）
**目标**：让推荐徽章金色随主题切换，并与 `--pt-gold` 令牌一致。
**改动**：`styles.css` L1484、L1492–L1493 的 gradient 改为引用 `var(--pt-gold)`：
```css
/* 亮色 */
background: linear-gradient(135deg,
    color-mix(in srgb, var(--pt-gold) 85%, #fff),
    var(--pt-gold));
/* 暗色（.theme-dark 块内）*/
background: linear-gradient(135deg,
    color-mix(in srgb, var(--pt-gold) 50%, var(--pt-surface-2, var(--background-secondary))),
    color-mix(in srgb, var(--pt-gold) 50%, var(--pt-surface-2, var(--background-secondary))));
```
这样亮色仍近似 `#e6b54a→#c8881a` 观感，暗色自动落到 `#b8841a`。
**验证**：在 Obsidian 亮/暗主题下分别截图对比推荐徽章金色；确认暗色不再刺眼。

### P2 — 字号标尺落地（问题 2，批量）
**目标**：消除裸 px 字号，统一引用 `--pt-text-*`。
**改动**：对 22 处裸 px 按就近语义映射：
- `12.5px`/≈`0.78rem` → `--pt-text-base`
- `10px`/≈`0.64rem` → `--pt-text-xs`（或 `--pt-text-2xs` 用于极小标签）
- `11px`/`11.5px` → `--pt-text-xs`（或新增 `--pt-text-sm` 区间，需先在 L108–L115 补一档，谨慎）
- `13px` → `--pt-text-md`
- `14px` → `--pt-text-md` 或 `--pt-text-lg`（按组件层级）
**注意**：`0.64rem`（基准 16px）≈ 10.24px，与裸 `10px`/`12.5px` 非精确相等；批量替换后需目视确认密度无跳变。建议优先处理密度敏感的卡片/工具栏区域，字典行（L2130/L2141）可一并修。
**验证**：肉眼对比替换前后卡片行高与工具栏密度；跑现有 UI 快照测试（如有）。

### P3 — 裸 `#fff` 收敛（问题 3，可选）
**目标**：L1483/L1944/L3978 的 `color: #fff` 改为 `color: var(--text-on-accent, #fff)`。
**注意**：先确认这三处确为强调背景上的文字（语义等同 `--text-on-accent`），而非独立意图的白字。

---

## 五、执行边界与风险

- **只读审计已冻结改动**：本报告所有改动点均指向 `styles.css`，不触及 `src/*.ts` 渲染逻辑。
- **令牌优先原则**：新增任何颜色/字号必须走 `styles.css` 顶部已定义令牌；若确需新档位（如 P2 的 11px 区间），先在 L108–L115 的标尺区补充并注明用途。
- **勿引入外部色板/字体**：守住 v5"借用宿主变量"约束（L4）。
- **回归验证**：每次改动后用 Obsidian 亮/暗双主题目视，并运行 `npx vitest run`（现有 578 单测不含视觉回归，但可确认无逻辑回归）。

---

## 六、证据索引（file:line）

| 问题 | 证据位置 |
|------|----------|
| 设计契约（令牌/约束） | styles.css L1–L120 |
| 金色令牌定义 | styles.css L53（亮）/ L138（暗） |
| 问题1：徽章裸金不随主题 | styles.css L1484 / L1492–L1493 |
| 问题1：正例（正确引用 --pt-gold） | styles.css L1468 / L4597 |
| 问题2：裸 px 字号 | styles.css L2130 / L2141 / L2197 / L2212 / L2241 / L2578 / L2595 / L2610 / L2632 / L2672 / L2995 / L3011 / L3025 / L3036 / L3043 / L4297 / L4464 |
| 问题2：正确用法正例 | styles.css L1480（--pt-text-xs） |
| 问题3：裸 #fff | styles.css L1483 / L1944 / L3978 |
| 问题3：正确用法正例 | styles.css L1127 / L1800 / L2099 / L2106 / L3810 |

---

## 七、闭环记录（2026-08-09，#8）

### 复核结论：三条主问题在本次施工前已部分落地

| 项 | 报告时状态 | 复核时实际状态 |
|---|---|---|
| P1 推荐徽章金色 | 裸 `#e6b54a/#c8881a` | **已修**（`.pt-card-recommend-badge` 亮/暗均引用 `var(--pt-gold)`，与报告 §四给出的方案逐字一致） |
| P2 字号标尺 | 22 处裸 px | **已修**（全文 184 处 `font-size`，裸 px 归零） |
| P3 裸 `#fff` | L1483/L1944/L3978 | **已修**（全文 `color: #fff` 归零，均为 `var(--text-on-accent, #fff)`） |

> 说明：现存 20 处 `font-size` 未引用 `--pt-text-*`，但全部使用宿主变量
> （`--font-small` / `--font-smaller` / `--font-smallest` / `--font-ui-*`），
> 符合 v5「借用宿主 CSS 变量」约束（L4），**不属于漂移，勿改**。
> 其中 5 处形如 `var(--font-small, 12.5px)` 的 px 是 `var()` 回退值，非裸 px。

### 本次实际修复：同根因残留 + 新增漂移

报告 §二问题 1 的根因是「金色写死 hex，绕过 `--pt-gold`，导致 L134 暗色覆盖失效」。
徽章本身已修，但**同根因在其他选择器仍有残留**，本次一并收敛：

| 位置 | 修复前 | 修复后 |
|---|---|---|
| `.pt-card.is-recommended` 描边 | `color-mix(..., #d99a1c 45%, ...)` | `var(--pt-gold)` |
| `.pt-card.is-favorited` 描边 + 光环 | `#d99a1c` ×2 | `var(--pt-gold)` |
| `@keyframes pt-fav-pulse` | `#d99a1c` ×2 | `var(--pt-gold, #d99a1c)` |
| `--pt-gold-muted` 定义（L54） | 派生自写死的 `#d99a1c` | 派生自 `var(--pt-gold)`，暗色自动跟随 |

另修复 **#13（AI 搜索召回信号徽标）新引入的 3 色裸 hex**（`--vector/--llm/--title`），
新增 4 个令牌 `--pt-signal-vector / --pt-signal-llm / --pt-signal-title / --pt-signal-title-tint`
并补 `.theme-dark .pt-view` 暗色覆盖（深底提亮文字，与亮色主题压暗方向相反）。
`title` 档拆 `-title`（文字，压暗保对比）与 `-title-tint`（描边/底色，保持原亮橙）两个令牌，
以无损保留原设计的双色意图。

### 验收结果

- **P1**：推荐徽章 + 推荐/收藏卡片描边 + 收藏脉冲，暗色下全部走 `--pt-gold: #b8841a`。
- **P2**：`grep 'font-size:\s*[0-9.]*px'` → 零结果。
- **P3**：`grep 'color:\s*#fff'` → 零结果。
- **全局**：令牌定义区（L17–L155）之外无任何裸 hex（`var()` 回退除外）。
- **回归**：`npm run build` 通过；`vitest` 585/585 全绿（无视觉快照测试，逻辑无回归）。
