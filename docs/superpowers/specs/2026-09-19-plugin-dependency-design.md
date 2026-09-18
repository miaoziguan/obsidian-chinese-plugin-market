# 插件依赖提示与关联（Plugin Dependencies）设计规格

日期：2026-09-19
状态：待用户审查
版本目标：v2.59.0 起分阶段落地

## 1. 目标与背景

### 痛点

新用户反馈：部分插件装上后跑不起来，因为必须同时安装并启用另一款插件（典型是 Dataview）。用户事前无从得知，事后排查成本极高。

### 目标

- **G1 事前可见**：浏览/安装前就知道某插件依赖哪些插件，并区分「必需」与「可选联动」
- **G2 事后可补救**：依赖未满足（未安装 / 已装未启用 / 版本过低）时明确告知，并给一键处理入口
- **G3 关系可见**：枢纽插件（Dataview 等）页面能看到「谁依赖它」

### 非目标（本版不做）

- 不做外部程序依赖：Pandoc / Python / LaTeX / 字体等（数据结构预留 `kind`，本期只填 `plugin`）
- 不做主题、CSS 片段依赖
- 不自动替用户安装依赖：只给入口，任何写盘动作都必须用户点确认
- 不做依赖冲突求解、版本区间语义：只支持「最低版本」这一条约束
- 不做远程热更新：数据集随包分发（与既有 `plugin-*.json` 一致）

## 2. 数据模型

### 2.1 类型定义

新增 `src/domain/deps/types.ts`：

```ts
/** 依赖目标类型；本期只有 plugin */
export type DepTargetKind = "plugin";

/** required = 不装跑不起来；optional = 装了才能用某某功能 */
export type DepKind = "required" | "optional";

export interface DepEdge {
	/** 依赖目标的插件 id（官方列表 id） */
	id: string;
	/** 目标显示名快照：目标插件下架/改名时仍能显示 */
	name: string;
	kind: DepKind;
	/** 最低版本要求（可选） */
	minVersion?: string;
	/** evidence：这条依赖是从哪儿知道的（决定置信度与 UI 标注） */
	source: "curated" | "manifest" | "mainjs" | "readme";
	/** 0~1；curated 恒为 1。UI 仅对 <0.85 的显示「可能」（即 README 推断的那批） */
	confidence: number;
}

export interface PluginDepsFile {
	version: 1;
	/** 生成时间（ISO），仅排障用 */
	generatedAt: string;
	/** 正向索引：插件 id → 它的依赖列表 */
	edges: Record<string, DepEdge[]>;
}
```

### 2.2 数据文件

文件名：`plugin-deps.json`，位置与其它 `plugin-*.json` 相同（插件根目录，由 `sync.sh` 分发到 `.obsidian/plugins/chinese-plugin-market/`）。

```json
{
  "version": 1,
  "generatedAt": "2026-09-19T00:00:00.000Z",
  "edges": {
    "obsidian-banners": [
      { "id": "dataview", "name": "Dataview", "kind": "required", "source": "curated", "confidence": 1 }
    ],
    "some-plugin": [
      { "id": "templater", "name": "Templater", "kind": "optional", "minVersion": "1.16.0",
        "source": "readme", "confidence": 0.7 }
    ]
  }
}
```

- **反向索引（被依赖）运行时构建**，不落盘：`Map<depId, { id: string; name: string; kind: DepKind }[]>`
- **规模预估**：约 40 个枢纽插件 × 平均 15 个依赖者 ≈ 600 条精修边 + 长尾检测边，文件 < 100KB
- **失效策略**：`version !== 1` 则整份丢弃并 `logger.warn`（照抄 `InsightCache` 的 schema 失效套路）

### 2.3 人工精修源（A 打底）

维护文件：`scripts/deps/curated.json`（**仓库内、不随包分发**，仅供生成脚本消费），按「枢纽插件」组织——维护者写「Dataview 被哪些插件依赖」比反过来写更容易：

```json
{
  "dataview": {
    "name": "Dataview",
    "aliases": ["DataviewJS", "dataviewjs"],
    "dependents": {
      "required": ["obsidian-banners", "dbfolder", "obsidian-projects"],
      "optional": ["advanced-tables"]
    }
  }
}
```

生成脚本把它展开成正向 `edges`，并**覆盖**自动检测的同 id 结果（`source: "curated"`、`confidence: 1`）。

## 3. 数据来源与生成

### 3.1 精修层（A）

人工维护，覆盖头部生态（Dataview / Templater / QuickAdd / Excalidraw / Kanban / Calendar / Tasks / Obsidian Git / Daily Note / Style Settings / Linter / Breadcrumbs / Meta Bind / Buttons / Timeline / Kanban 等枢纽插件）。

### 3.2 自动检测层（B）

规则表（正则 + 置信度 + kind 映射）以 **`src/domain/deps/rules.ts`** 为唯一真相源：运行时按需检测直接用它；生成脚本通过 `esbuild`（已是 devDependency）把它打成临时 `.mjs` 后 import，避免两份正则漂移。

纯函数 `detectDeps(manifest, readme, mainJs, dict, rules)` 置于 `src/domain/deps/detect.ts`（可单测、不碰网络），信号与置信度：

| 信号 | source | confidence | kind |
|---|---|---|---|
| `manifest.dependencies` 命中 | `manifest` | 0.9 | required |
| main.js 出现 `app.plugins.plugins.<id>` / `plugins["<id>"]` / `getPlugin("<id>")` / `DataviewAPI` 等 | `mainjs` | 0.85 | required |
| README 强模式：`requires? X` / `依赖 X` / `must (have|install) X` / `X is required` / `需要安装 X` | `readme` | 0.7 | required |
| README 弱模式：`works with X` / `integrates? with X` / `supports? X` / `compatible with X` / `可选` | `readme` | 0.35 | optional |
| 目标解析：`dict` = 官方列表的 `{id, name}` + 别名表，匹配规则为小写去空格/连字符后精确相等 | | | |

**过滤规则**（写入文件前）：

- `confidence < 0.4` 丢弃
- `0.4 <= confidence < 0.7` 强制降级为 `optional`（宁可少报必需，不可误报必需）
- 自依赖（id === 自己）丢弃
- 目标不在官方列表且不在别名表 → 丢弃（无法给出安装入口，只会制造噪音）

### 3.3 生成脚本

`scripts/gen-plugin-deps.mjs`（Node，可重跑、幂等）：

1. 拉官方列表 `community-plugins.json`（复用 `PLUGINS_URL`）
2. 并发 8（脚本内自行实现）逐个拉 `manifest.json` + README（前 5000 字符，与 `fetchReadmeText` 一致）
3. 用 esbuild 将 `src/domain/deps/rules.ts` 打包成临时文件后 import，调 `detectDeps`
4. 合并精修层（精修覆盖检测）
5. **自动采纳**强信号（`confidence >= 0.7`）为 `required`；弱信号（0.4~0.7）**只写进候选清单**，不进 `plugin-deps.json`
6. 输出 `plugin-deps.json` + `docs/plugin-deps-candidates.md`（弱信号候选 + 证据原文，人工抽查后并入 `scripts/deps/curated.json`）

参数：`--only-new`（增量，只处理上次结果里没有的 id）、`--out`、`--limit`。

> 弱信号不自动入库的理由：误报代价高于漏报——一条错误的「必需」会直接劝退用户安装。长尾覆盖由强信号自动承担，弱信号走人工确认。

## 4. 运行时加载与按需兜底

### 4.1 加载（照抄 `loadChineseEcosystem` 套路）

`src/app/plugin.ts` 新增 `loadPluginDeps()`：

- 后台异步（`onload` 的后台并行块，不阻塞首屏）
- `adapter.exists` → `read` → `JSON.parse` → 校验 `version` → 注入 `this.pluginDeps` 并构建反向索引 → `invalidateAndRender(false)`
- 失败仅 `logger.warn` 静默降级（功能整体消失，不影响其它）
- `sync.sh` 的 `FILES` 数组加入 `plugin-deps.json`

### 4.2 按需兜底（B 的运行时部分）

触发条件：**表中无该 id 记录** 且 **用户打开了该插件详情**。

- `detectDepsFor(app, repo, mirror)`：拉 manifest + README → `detectDeps` → 写入内存 `runtimeDeps: Map<string, DepEdge[]>`（FIFO 限容 200）
- **不落盘**：保持随包基线干净；会话内有效。二期若发现重复检测代价高，再考虑 `deps-cache.json` 持久化
- 网络失败静默：详情页不显示依赖区块，不提示错误

## 5. 状态判定（核心价值）

```ts
export type DepStatus = "ok" | "missing" | "disabled" | "outdated" | "unknown";

export function resolveDepStatus(
	dep: DepEdge,
	installedIds: Set<string>,
	enabledIds: Set<string>,
	installedVersions: Map<string, string>,
	knownIds: Set<string>, // 官方列表 id 集合
): DepStatus;
```

判定顺序：

1. 不在 `knownIds` → `unknown`（目标不在官方列表，无法引导安装，只显示名字）
2. 不在 `installedIds` → `missing`
3. 在 `installedIds` 但不在 `enabledIds` → `disabled`
4. 有 `minVersion` 且 `compareVersion(local, minVersion) < 0` → `outdated`
5. 否则 `ok`

`compareVersion` 现为 `view-data.ts` 的私有函数（:655），**抽到 `src/shared/version.ts`** 并让 `view-data.ts` 复用，避免第二份实现。

## 6. UI 落点

### 6.1 卡片徽标（`card-render.ts`）

- `metaInfo` 行新增 `pt-card-dep-badge`（常驻 `display:none`，`applyCardState` 填充，与健康度/新/装过徽标同排）
- **显示条件**：存在 `required` 依赖且状态非 `ok` → 显示；全部满足则不显示（零打扰）
- 文案：`需 {第一个未满足依赖名}`，多于一个时 `+N`
- 点击 → `ctx.openDetailDrawer(depId)`（目标在官方列表时才可点）
- `optional` 依赖**不占卡片空间**，只在详情页体现

### 6.2 详情抽屉「依赖」区块（`detail-drawer.ts`）

位置：`buildContent` 的 meta 区之后、描述之前（约 :839 之后）新增 `pt-detail-deps` section。

每行：状态点（红/黄/绿）+ 依赖名（可点跳转）+ kind 标签（必需 / 可选）+ 最低版本（有则显示）+ 「可能」标注（`confidence < 0.85` 时，即非精修 / 非 manifest / 非 main.js 证据）。

未满足时行内给按钮：

- `missing` → 「安装」（复用 `handleInstall` 的 ctx 动作）
- `disabled` → 「启用」（复用 `handleToggleEnabled`）
- `outdated` → 「更新」（复用 `ctx.updatePlugin`）
- `unknown` → 无按钮，仅显示名字

### 6.3 反向区块「被依赖」

同一 section 下方 `<details>` 折叠区（默认收起）：列出依赖它的插件名，可点跳转。仅当反向索引里有 ≥1 条时渲染。标题 `dep.dependents`。

### 6.4 安装后检查（`plugin-installer.ts`）

在 `installCommunityPlugin` 的成功分支（:432 之前，`snapshotInstalled()` 之后）插入 `reportMissingDeps(ctx, plugin)`：

- 只统计 `required` 且状态为 `missing` / `disabled` / `outdated` 的依赖
- **有缺失** → 先弹安装成功 Notice，再弹 `DepCheckModal`：逐条列出 + 一键安装/启用/更新按钮 + 「知道了」关闭
- **无缺失** → 不做任何额外提示（不打扰）
- `optional` 不弹窗

选择 Modal 而非 Notice 的原因：Obsidian 的 `Notice` 不可点击，无法承载「一键处理」；而 required 依赖缺失是低频事件，Modal 的打断代价可接受。

## 7. i18n

新增（沿用 `dep.*` 前缀）：

```
dep.section / dep.required / dep.optional / dep.minVersion / dep.maybe
dep.status.ok / dep.status.missing / dep.status.disabled / dep.status.outdated / dep.status.unknown
dep.action.install / dep.action.enable / dep.action.update
dep.dependents / dep.dependents.hint
dep.modal.title / dep.modal.desc / dep.modal.dismiss
card.depBadge / card.depBadge.more
```

## 8. 测试

- `src/domain/deps/detect.test.ts`：`detectDeps` 纯函数——强/弱模式命中、别名解析、自依赖丢弃、未知目标丢弃、阈值降级（<0.4 丢弃 / 0.4~0.7 降 optional / ≥0.7 保留 required）
- `src/domain/deps/status.test.ts`：四态 + unknown 判定、`compareVersion` 边界（`v` 前缀、段数不等、`1.10` vs `1.9`）
- 加载降级：`plugin-deps.json` 缺失 / 损坏 / version 不匹配 → 功能静默消失，不抛错（照抄 `plugin.test.ts` 里数据集加载的降级测试套路）
- 手工验收：装一个已知依赖 Dataview 的插件 → 安装后弹依赖检查；未启用 Dataview → 详情页显示「已安装未启用」并给启用按钮

## 9. 分阶段实施

| 阶段 | 内容 | 价值 |
|---|---|---|
| **P0** | 数据模型 + 精修表（A）+ 加载 + 状态判定 + 详情只读区块 | 头部生态的依赖可见、状态可见 |
| **P1** | 卡片徽标 + 安装后 `DepCheckModal` | 方案 2 的核心价值：装完就能跑起来 |
| **P2** | 生成脚本 + 全量基线数据 + 运行时按需兜底 + 反向「被依赖」区块 | 长尾覆盖与关系网 |

P0 与 P1 建议同版本发布（缺了 P1，这个功能只是"多一行字"）。

## 10. 风险与应对

| 风险 | 应对 |
|---|---|
| 自动检测误报（"works with Dataview" 被判成必需） | 弱信号（<0.7）强制降为 optional 且只进候选清单；0.7~0.85 区间虽为 required 但 UI 标注「可能」 |
| 数据滞后（新插件不在基线里） | 运行时按需兜底；生成脚本可重跑，`--only-new` 增量 |
| 依赖目标是直链安装的插件（不在官方列表） | 状态 `unknown`，只显示名字不给按钮 |
| 精修表维护成本 | 按枢纽插件组织，一次维护覆盖十几个依赖者；随发版增量补充 |
| 6000 个插件离线全量扫描耗时 | 脚本并发 8、可 `--limit`、可 `--only-new`；首次全量本地跑一次即可 |
