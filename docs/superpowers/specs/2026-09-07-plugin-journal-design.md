# 插件评测台账（Plugin Journal）设计规格

日期：2026-09-07
状态：待用户审查
版本目标：v2.49.0

## 1. 目标与背景

### 痛点

用户会试用大量 Obsidian 插件，但事后想不起来：

1. 这个插件我到底装过没有
2. 当时为什么没继续用
3. 测出过什么问题

### 目标

在插件市场内建立一份「插件试用台账」，提供：

- **足迹**：自动记录装过哪些、什么时候装/卸、装了几次
- **弃用可见**：哪些现在不在用了
- **评测备注**：每个插件可写自由文本备注 + 结构化状态

### 非目标（本版不做）

- 不推断主观结论：不把"已卸载"自动等同于"弃用"
- 不做插件功能评测的自动化（不检测插件是否报错、不采集遥测）
- 不做评分聚合/推荐（不根据评分影响搜索排序）
- 不做云端同步/分享

## 2. 数据分层

台账数据分两层，避免为"装过但没评测"的插件生成大量空笔记。

### 2.1 安装历史索引（自动）

文件：`install-history.json`，位于插件私有目录 `.obsidian/plugins/chinese-plugin-market/`，**始终在此处**，不随评测目录设置切换（它是机器数据，不是知识资产）。

```json
{
  "version": 1,
  "entries": {
    "obsidian-calendar": {
      "name": "Calendar",
      "firstInstalled": 1740000000000,
      "lastInstalled": 1745000000000,
      "uninstalled": 1747000000000,
      "installCount": 2,
      "currentlyInstalled": false,
      "currentlyEnabled": false
    }
  }
}
```

字段语义：

| 字段 | 说明 |
|---|---|
| `name` | 首次记录时的插件显示名（社区列表可能后来下架该插件，用于兜底展示） |
| `firstInstalled` | 首次观测到安装的时间戳 |
| `lastInstalled` | 最近一次观测到安装 |
| `uninstalled` | 最近一次观测到卸载；当前仍安装则为 `null` |
| `installCount` | 观测到的安装次数（含重装） |
| `currentlyInstalled` | 当前是否仍安装（快照） |
| `currentlyEnabled` | 当前是否启用（快照） |

### 2.2 评测笔记（用户主动创建）

只有用户写过备注 / 设过状态 / 打过分 / 选了弃用原因，才创建笔记。

路径：`<评测目录>/<plugin-id>.md`
默认评测目录：`.obsidian/plugins/chinese-plugin-market/reviews/`
可在设置中切换到 vault 内路径（如「插件评测/」）。

```markdown
---
id: obsidian-calendar
name: Calendar
status: abandoned
rating: 2
verdict: [冲突, 不更新]
firstInstalled: 2026-02-10
lastInstalled: 2026-05-02
uninstalled: 2026-06-18
installCount: 2
enabled: false
updated: 2026-06-18
---

和 Daily Note 冲突，启用后日报模板失效。
作者 2024 年后就没更新过，issue 一直挂着。
```

字段：

| 字段 | 维护方 | 取值 | 说明 |
|---|---|---|---|
| `id` | 自动 | 插件 id | 文件名即 `<id>.md` |
| `name` | 自动 | 显示名 | 写笔记时的译名/原名 |
| `status` | 用户 | `using` / `abandoned` / `watching` | 可不填 |
| `rating` | 用户 | 1–5 | 可不填 |
| `verdict` | 用户 | 见预设集合 | 数组，可不填 |
| `firstInstalled` / `lastInstalled` / `uninstalled` / `installCount` / `enabled` | 自动 | — | 从历史索引同步写回，便于在 vault 里直接看到事实 |
| `updated` | 自动 | 时间戳 | 用户内容变更时间 |

**弃用原因预设集合**（多选，允许手写额外值，不做强校验）：

`不好用` `有 bug` `有替代` `太重` `收费` `不更新` `冲突` `用不上`

预设值用于面板筛选统计；手写值照常显示，只是不进筛选器。

## 3. 自动采集

### 3.1 复用现有监听

`src/ui/view/installed-watch.ts` 的 `startInstalledWatch` 已经在计算"新增/移除" diff（第 54-84 行的 `before` / `after` 对比），目前只用于刷新卡片徽标，**diff 结果用完即弃**。

本次改动：在 `onChange` 中把 diff 结果交给历史索引模块落盘。

| 事件 | 写入 |
|---|---|
| 新增（观测到安装） | 首次则写 `firstInstalled`；总是更新 `lastInstalled`、`installCount++`、`currentlyInstalled = true`、`uninstalled = null` |
| 移除（观测到卸载） | `uninstalled = now`、`currentlyInstalled = false`、`currentlyEnabled = false` |
| 启用状态变化 | `currentlyEnabled` 跟随 `enabledIds`（已有数据） |

桌面端 `fs.watch` 实时触发，移动端/降级为 60s 轮询——**不新增任何监听机制**。

### 3.2 硬边界

历史只能从**本插件启用之后**开始记录。此前装过又卸载的插件，Obsidian 卸载即删目录，任何插件都无法追溯。UI 上需明确说明这一点，避免用户误以为数据缺失是 bug。

## 4. 存储层

复用 `NoteStoragePort`（`src/translation/memory/note-port.ts`）及其 `ObsidianNoteStorage` 实现（vault 高层 API / `.obsidian` 底层 adapter 双后端）——与翻译记忆库完全一致：

- 默认路径落在 `.obsidian` → 走 adapter，不进 vault 文件树、不触发 vault 事件、不被其他插件检索
- 切到 vault 内路径 → 走 Vault API，可在 Obsidian 内编辑、全局搜索、双向链接、随 Sync 同步、被 Dataview 利用

**路径切换迁移**：复用翻译记忆库现有的迁移实现（`autoMigrateTMIfNeeded` / `migrateTMFiles`：先写后删、BATCH=20 并发、单条容错、8s 预算保护）。

**目录创建**：必须复用 `writeTMNote` 中"写入前 `await notes.exists()` + `createFolder`"的正确写法（此前此处漏 `await` 导致目录从未创建的事故，见 v2.48.0）。

历史索引 `install-history.json` 走现有 `PluginStorage`（`src/data/storage/plugin-storage.ts`），与 stats / trending 缓存同级。

## 5. UI

### 5.1 工具栏按钮

- 位置：紧邻现有「安装」筛选组
- 文案：`我的足迹`；有记录时带数量，如 `我的足迹 12`
- 无记录时置灰，提示"还没有记录，去插件详情里写一条"
- 点击：打开独立标签页视图（复用已有 leaf，不重复开）

### 5.2 详情抽屉「我的评测」区块

在 `src/ui/components/detail-drawer.ts` 现有操作按钮下方新增区块：

- **状态**：在用 / 弃用 / 观望 三个 chip 单选
- **评分**：1–5 星，点第 n 颗设为 n，再点同一颗取消
- **弃用原因**：预设 8 个 chip 多选
- **备注**：textarea（项目首个自由文本输入组件）
- **事实区（只读）**：首次安装 / 最近安装 / 卸载时间 / 重装次数，标注"自动记录"
- **保存**：输入防抖 500ms 自动落盘，无保存按钮（沿用 `saveTranslatorData` 的防抖模式）

### 5.3 卡片徽标

现有「已安装」徽标表示*当前装着*；新增徽标表示*我和它的历史*，语义不同，需视觉区分：

- 有评测 → 显示 `★4`（无评分则显示 `评`）
- 只装过、没评测 → 淡色 `装过`（含已卸载的）

实现上读取常驻内存的 Map，卡片渲染零 IO。

### 5.4 列表筛选

新增一组 facet，与「安装」组并列：

- `我评测过的`
- `我装过的（含已卸载）`

涉及：`src/domain/filter/filter.ts` 的 `MatchOptions` / `matchesPlugin`、`src/ui/view/view-toolbar.ts` 新增 chip、`filterCache.reset()` 失效条件（参照现有 `installedNotEnabled` 写法）。

### 5.5 独立标签页视图

- 视图类型常量：`JOURNAL_VIEW_TYPE`（如 `chinese-plugin-market-journal`），在 `plugin.onload` 中 `registerView`，单例复用已有 leaf
- 视图名：`我的插件足迹`
- 数据来源：历史索引（全部装过的）左连接评测笔记（有评测的），按 id 关联
- 形态：原生 DOM 表格（项目无前端框架，与现有视图一致）
- 列：插件名（带译名）｜状态｜评分｜弃用原因｜首次安装｜最近动态｜备注摘要
- 能力：按列排序（时间 / 评分 / 状态）、按状态与原因筛选、关键词搜索、点击行跳转插件卡片、复制整表为 markdown 表格
- 性能：打开时读盘一次；笔记数量等于用户评测过的数量（通常几十条）

## 6. 模块划分（初步规划，实现时可微调）

新增：

| 文件 | 职责 |
|---|---|
| `src/domain/journal/journal-entry.ts` | 评测条目数据模型、frontmatter 解析与序列化 |
| `src/domain/journal/install-history.ts` | 安装历史索引的读取与增量更新 |
| `src/ui/view/journal-view.ts` | 独立标签页视图（ItemView） |
| `src/ui/components/journal-table.ts` | 表格渲染、排序、筛选、导出 |
| `src/ui/components/journal-editor.ts` | 详情抽屉内的评测区块（含 textarea） |

修改：

| 文件 | 改动 |
|---|---|
| `src/ui/view/installed-watch.ts` | diff 结果交给历史索引落盘 |
| `src/ui/components/detail-drawer.ts` | 挂载评测区块 |
| `src/ui/components/card-render.ts` | 新增徽标 |
| `src/domain/filter/filter.ts`、`src/ui/view/view-toolbar.ts` | 新增筛选维度与 chip |
| `src/app/plugin.ts` | registerView、设置项（评测目录路径）、打开视图的命令 |
| `src/shared/i18n.ts` | 新增文案 key |

## 7. 边界与错误处理

- **笔记被用户手改**（vault 模式）：解析全部 try/catch，字段缺失用默认值，单条坏笔记不影响启动与其他功能
- **插件已从社区列表下架**：面板按 id 兜底，名称取历史索引 / 笔记中的 `name`
- **移动端**：60s 轮询照常记录；textarea 与面板正常可用
- **卸载后又重装**：`installCount` 递增，`uninstalled` 清空，历史保留
- **评测目录切换**：走与翻译记忆库相同的先写后删迁移
- **性能**：评测摘要常驻内存 Map；面板打开时才读盘；历史索引写入走防抖，避免 fs.watch 频繁触发导致密集写盘

## 8. 测试

- 单测：历史索引的 add / remove 更新逻辑（含重装计数）、frontmatter 解析与序列化、新增筛选的匹配规则
- 集成：写评测 → 落笔记 → 重读回显；可复用 `src/translation/memory/tm-flush.integration.test.ts` 中的 `FakeVault` 与 `ObsidianNoteStorage`
- 手验清单：装/卸一个插件看历史是否记上、写备注后重启是否还在、切换评测目录是否迁移、移动端轮询是否记录

## 9. 开放问题

无。所有关键决策已与用户确认：

- 存储：复用笔记机制，默认 `.obsidian`、可切 vault（用户选定）
- 范围：方案 3 完整台账（用户选定，从方案 2 升级）
- 数据分层：历史索引 + 评测笔记（用户默认采纳 (b)）
- 面板入口：工具栏按钮（用户选定）
- 面板形态：独立标签页视图（用户选定）
