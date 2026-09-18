# 插件依赖提示与关联 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让用户事前知道插件依赖谁、事后知道缺什么并一键补上（未安装 / 已装未启用 / 版本过低）。

**架构：** 随包分发一份 `plugin-deps.json`（插件 id → 依赖边列表，人工精修 + 离线自动检测生成），启动时后台加载进 `DepGraph`（正向边 + 运行时构建的反向索引 + 状态判定）；UI 分三处落点——详情抽屉只读区块、卡片「依赖未满足」徽标、安装完成后的依赖检查弹窗。数据缺失时整功能静默消失，不影响其它能力。

**技术栈：** TypeScript / Obsidian API（`requestUrl` / `Modal` / `Notice` / `setIcon`）/ vitest（jsdom）/ esbuild / Node 脚本。

**规格来源：** `docs/superpowers/specs/2026-09-19-plugin-dependency-design.md`（先读它，本计划的所有阈值与命名与之一致）

---

## 文件结构

### 新建

| 文件 | 职责 |
|---|---|
| `src/domain/deps/types.ts` | `DepEdge` / `DepKind` / `DepSource` / `DepStatus` / `PluginDepsFile` / `DependentRef` |
| `src/domain/deps/graph.ts` | `DepGraph`：解析校验、正向边查询、反向索引、`statusOf`、`blockingOf`、运行时 `merge` |
| `src/domain/deps/rules.ts` | 检测规则表（正则模板 + 置信度 + kind），**TS 与生成脚本共用的唯一真相源** |
| `src/domain/deps/detect.ts` | `detectDeps()` 纯函数：manifest / main.js / README → `DepEdge[]` |
| `src/shared/version.ts` | `compareVersion`（从 `view-data.ts` 抽出，供依赖判定与可更新检测共用） |
| `src/ui/components/dep-section.ts` | 详情抽屉「依赖」区块与「被依赖」折叠区的 DOM 渲染（纯展示 + 回调） |
| `src/ui/modals/dep-check-modal.ts` | 安装完成后的依赖检查 Modal（逐条 + 一键处理） |
| `src/ui/view/deps-report.ts` | 安装后钩子：算未满足依赖并决定是否弹窗 |
| `src/ui/view/deps-lazy.ts` | 运行时按需兜底检测（表中无记录时按 repo 现算） |
| `scripts/gen-plugin-deps.mjs` | 离线全量生成脚本（产出数据文件 + 人工抽查候选清单） |
| `scripts/deps/curated.json` | 人工精修源（不随包分发，仅供脚本消费） |
| `plugin-deps.json` | 生成产物，随包分发 |

### 修改

| 文件 | 改动 |
|---|---|
| `src/shared/i18n.ts` | 新增 `dep.*` 文案键 |
| `src/app/plugin.ts` | 新增 `pluginDeps` 字段 + `loadPluginDeps()`；后台加载处挂一行 |
| `src/ui/view/view-context.ts` | 新增 `pluginDeps` / `fixDep` 端口与工厂绑定 |
| `src/ui/view/translator-view.ts` | `fixDep` 实现 |
| `src/ui/components/detail-drawer.ts` | `DrawerOptions.deps?` 端口 + `buildContent` 插入区块（:839 之后） |
| `src/ui/view/view-cards.ts` | 打开抽屉时装配 `deps` 端口 |
| `src/ui/components/card-render.ts` | 新增 `pt-card-dep-badge` 徽标（创建 :353 后 / 填充 :887 后） |
| `src/data/platform/plugin-installer.ts` | 安装成功分支调用 `reportMissingDeps`（:432 附近） |
| `src/ui/view/view-data.ts` | 删除本地 `compareVersion`（:651-664），改为 import |
| `styles.css` | `.pt-detail-deps` / `.pt-card-dep-badge` 样式 |
| `sync.sh` | `FILES` 数组加入 `plugin-deps.json` |

### 测试

| 文件 | 覆盖 |
|---|---|
| `src/shared/version.test.ts` | 版本比较边界 |
| `src/domain/deps/graph.test.ts` | 解析降级、反向索引、五态判定、`blockingOf` |
| `src/domain/deps/detect.test.ts` | 强/弱模式、别名、自依赖丢弃、阈值降级 |

---

## 阶段 P0：数据骨架 + 详情只读展示

### 任务 1：抽出 `compareVersion` 到 shared

**文件：**
- 创建：`src/shared/version.ts`、`src/shared/version.test.ts`
- 修改：`src/ui/view/view-data.ts:651-664`

- [ ] **步骤 1：写失败测试**

`src/shared/version.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { compareVersion } from "@shared/version";

describe("compareVersion", () => {
	it("忽略 v 前缀", () => {
		expect(compareVersion("v1.2.3", "1.2.3")).toBe(0);
	});
	it("按数值段比较：1.10 > 1.9", () => {
		expect(compareVersion("1.10.0", "1.9.0")).toBe(1);
		expect(compareVersion("1.9.0", "1.10.0")).toBe(-1);
	});
	it("段数不等时缺位补 0", () => {
		expect(compareVersion("1.2", "1.2.0")).toBe(0);
		expect(compareVersion("1.2", "1.2.1")).toBe(-1);
	});
	it("非数字段按 0 处理，不抛错", () => {
		expect(compareVersion("1.x", "1.0")).toBe(0);
		expect(compareVersion("", "1.0")).toBe(-1);
	});
});
```

- [ ] **步骤 2：运行确认失败**

运行：`npx vitest run src/shared/version.test.ts`
预期：FAIL —— `Cannot resolve "@shared/version"`

- [ ] **步骤 3：实现**

`src/shared/version.ts`：

```ts
/**
 * 版本号比较（语义化版本的极简实现，够用于「是否满足最低版本 / 是否有更新」判定）。
 *
 * 原为 view-data.ts 的私有函数，抽出供依赖状态判定复用，避免两份实现漂移。
 * @returns a > b 为 1，a < b 为 -1，相等为 0
 */
export function compareVersion(a: string, b: string): number {
	const pa = a.replace(/^v/i, "").split(".");
	const pb = b.replace(/^v/i, "").split(".");
	const n = Math.max(pa.length, pb.length);
	for (let i = 0; i < n; i++) {
		const x = parseInt(pa[i] ?? "0", 10) || 0;
		const y = parseInt(pb[i] ?? "0", 10) || 0;
		if (x !== y) return x > y ? 1 : -1;
	}
	return 0;
}
```

`src/ui/view/view-data.ts`：删除本地 `compareVersion`（:651-664），在其原使用处（:706）改用 import：

```ts
import { compareVersion } from "@shared/version";
```

- [ ] **步骤 4：运行确认通过**

运行：`npx vitest run src/shared/version.test.ts src/ui/view/view-data.test.ts`
预期：PASS（4 + 4）

- [ ] **步骤 5：Commit**

```bash
git add src/shared/version.ts src/shared/version.test.ts src/ui/view/view-data.ts
git commit -m "refactor(shared): compareVersion 抽到 shared/version 供依赖判定复用"
```

---

### 任务 2：`DepGraph` 数据层

**文件：**
- 创建：`src/domain/deps/types.ts`、`src/domain/deps/graph.ts`、`src/domain/deps/graph.test.ts`

- [ ] **步骤 1：写类型**

`src/domain/deps/types.ts`：

```ts
/** 依赖目标类型；本期只有 plugin（外部程序依赖不在本期） */
export type DepTargetKind = "plugin";

/** required = 不装跑不起来；optional = 装了才能用某某功能 */
export type DepKind = "required" | "optional";

/** 证据来源（决定置信度与 UI 是否标「可能」） */
export type DepSource = "curated" | "manifest" | "mainjs" | "readme";

export type DepStatus = "ok" | "missing" | "disabled" | "outdated" | "unknown";

export interface DepEdge {
	/** 依赖目标的插件 id */
	id: string;
	/** 目标显示名快照（目标下架/改名时仍能显示） */
	name: string;
	kind: DepKind;
	/** 最低版本要求 */
	minVersion?: string;
	source: DepSource;
	/** 0~1；curated 恒为 1；<0.85 时 UI 标「可能」 */
	confidence: number;
}

/** 反向关系：谁依赖我 */
export interface DependentRef {
	id: string;
	name: string;
	kind: DepKind;
}

export interface PluginDepsFile {
	version: 1;
	generatedAt: string;
	edges: Record<string, DepEdge[]>;
}

/** 状态判定的输入快照（由视图层提供，DepGraph 不碰 Obsidian API） */
export interface DepStatusInput {
	installedIds: Set<string>;
	enabledIds: Set<string>;
	installedVersions: Map<string, string>;
	/** 官方社区列表的插件 id 集合；不在其中则无法给出安装入口 */
	knownIds: Set<string>;
}
```

- [ ] **步骤 2：写失败测试**

`src/domain/deps/graph.test.ts`（关键用例，完整断言）：

```ts
import { describe, it, expect } from "vitest";
import { DepGraph } from "@domain/deps/graph";
import type { DepEdge, DepStatusInput } from "@domain/deps/types";

const file = JSON.stringify({
	version: 1,
	generatedAt: "2026-09-19T00:00:00.000Z",
	edges: {
		banners: [
			{ id: "dataview", name: "Dataview", kind: "required", source: "curated", confidence: 1 },
			{ id: "templater", name: "Templater", kind: "optional", source: "readme", confidence: 0.7 },
		],
		"old-thing": [
			{ id: "dataview", name: "Dataview", kind: "required", minVersion: "0.5.0", source: "curated", confidence: 1 },
		],
	},
});

const input = (over: Partial<DepStatusInput> = {}): DepStatusInput => ({
	installedIds: new Set(["dataview"]),
	enabledIds: new Set(["dataview"]),
	installedVersions: new Map([["dataview", "0.5.6"]]),
	knownIds: new Set(["dataview", "templater"]),
	...over,
});

describe("DepGraph.parse", () => {
	it("正常解析并构建反向索引", () => {
		const g = DepGraph.parse(file)!;
		expect(g.edgesOf("banners")).toHaveLength(2);
		const deps = g.dependentsOf("dataview").map((d) => d.id);
		expect(deps).toContain("banners");
		expect(deps).toContain("old-thing");
	});
	it("坏 JSON / schema 不匹配 / 缺字段 → 返回 null（静默降级）", () => {
		expect(DepGraph.parse("{ 坏")).toBeNull();
		expect(DepGraph.parse(JSON.stringify({ version: 2, edges: {} }))).toBeNull();
		expect(DepGraph.parse(JSON.stringify({ version: 1 }))).toBeNull();
	});
	it("丢弃形状不合法的边（缺 id / 非法 kind）", () => {
		const g = DepGraph.parse(JSON.stringify({
			version: 1, generatedAt: "", edges: { a: [{ id: "x", name: "X", kind: "bogus", source: "curated", confidence: 1 }, { name: "无 id" }] },
		}))!;
		expect(g.edgesOf("a")).toHaveLength(0);
	});
});

describe("DepGraph.statusOf", () => {
	const g = DepGraph.parse(file)!;
	const edge = (over: Partial<DepEdge> = {}): DepEdge => ({
		id: "dataview", name: "Dataview", kind: "required", source: "curated", confidence: 1, ...over,
	});

	it("未安装 → missing", () => {
		expect(g.statusOf(edge(), input({ installedIds: new Set() }))).toBe("missing");
	});
	it("已装未启用 → disabled", () => {
		expect(g.statusOf(edge(), input({ enabledIds: new Set() }))).toBe("disabled");
	});
	it("已启用但版本低于 minVersion → outdated", () => {
		expect(g.statusOf(edge({ id: "old-thing" }), input())).toBe("missing");
		const g2 = DepGraph.parse(file)!;
		expect(g2.statusOf(edge({ minVersion: "0.6.0" }), input())).toBe("outdated");
	});
	it("已启用且版本满足 → ok", () => {
		expect(g.statusOf(edge({ minVersion: "0.5.0" }), input())).toBe("ok");
	});
	it("目标不在官方列表 → unknown（优先于 missing）", () => {
		expect(g.statusOf(edge({ id: "beta-thing" }), input({ installedIds: new Set() }))).toBe("unknown");
	});
});

describe("DepGraph.blockingOf", () => {
	it("只返回 required 且未满足的依赖", () => {
		const g = DepGraph.parse(file)!;
		expect(g.blockingOf("banners", input())).toHaveLength(0); // dataview 已装已启用，templater 是 optional
		const blocking = g.blockingOf("banners", input({ enabledIds: new Set() }));
		expect(blocking).toHaveLength(1);
		expect(blocking[0].dep.id).toBe("dataview");
		expect(blocking[0].status).toBe("disabled");
	});
});
```

- [ ] **步骤 3：运行确认失败**

运行：`npx vitest run src/domain/deps/graph.test.ts`
预期：FAIL —— 模块不存在

- [ ] **步骤 4：实现**

`src/domain/deps/graph.ts`：

```ts
import { compareVersion } from "@shared/version";
import type { DepEdge, DepKind, DependentRef, DepStatus, DepStatusInput, PluginDepsFile } from "./types";

const SCHEMA_VERSION = 1;
const VALID_KINDS: DepKind[] = ["required", "optional"];

function isValidEdge(e: unknown): e is DepEdge {
	if (!e || typeof e !== "object") return false;
	const v = e as Record<string, unknown>;
	return (
		typeof v.id === "string" &&
		v.id.length > 0 &&
		typeof v.name === "string" &&
		VALID_KINDS.includes(v.kind as DepKind) &&
		typeof v.confidence === "number"
	);
}

export interface BlockingDep {
	dep: DepEdge;
	status: DepStatus;
}

/**
 * 依赖图：正向边（谁依赖谁）+ 反向索引（谁被依赖）+ 状态判定。
 * 不碰 Obsidian API：状态判定所需的集合全部由调用方以 DepStatusInput 传入，便于单测。
 */
export class DepGraph {
	/** 随包基线（不可变） */
	private edges: Record<string, DepEdge[]> = {};
	private dependents = new Map<string, DependentRef[]>();
	/** 运行时按需检测补充（会话内有效，不落盘） */
	private runtime = new Map<string, DepEdge[]>();

	constructor(file: PluginDepsFile | null = null) {
		if (file) this.load(file);
	}

	/** 解析随包 JSON；任何不合法都返回 null，由调用方静默降级 */
	static parse(text: string): DepGraph | null {
		try {
			const parsed = JSON.parse(text) as unknown;
			if (!parsed || typeof parsed !== "object") return null;
			const f = parsed as Partial<PluginDepsFile>;
			if (f.version !== SCHEMA_VERSION) return null;
			if (!f.edges || typeof f.edges !== "object") return null;
			const g = new DepGraph();
			g.load(f as PluginDepsFile);
			return g;
		} catch {
			return null;
		}
	}

	private load(file: PluginDepsFile): void {
		const clean: Record<string, DepEdge[]> = {};
		for (const [id, list] of Object.entries(file.edges)) {
			if (!Array.isArray(list)) continue;
			const ok = list.filter(isValidEdge);
			if (ok.length > 0) clean[id] = ok;
		}
		this.edges = clean;
		// 反向索引：depId → 依赖它的插件
		const rev = new Map<string, DependentRef[]>();
		for (const [id, list] of Object.entries(clean)) {
			for (const e of list) {
				const arr = rev.get(e.id) ?? [];
				arr.push({ id, name: id, kind: e.kind });
				rev.set(e.id, arr);
			}
		}
		this.dependents = rev;
	}

	/** 正向：该插件依赖什么（运行时补充优先于基线） */
	edgesOf(id: string): DepEdge[] {
		return this.runtime.get(id) ?? this.edges[id] ?? [];
	}

	/** 反向：谁依赖它 */
	dependentsOf(id: string): DependentRef[] {
		return this.dependents.get(id) ?? [];
	}

	statusOf(dep: DepEdge, s: DepStatusInput): DepStatus {
		if (!s.knownIds.has(dep.id)) return "unknown";
		if (!s.installedIds.has(dep.id)) return "missing";
		if (!s.enabledIds.has(dep.id)) return "disabled";
		if (dep.minVersion) {
			const local = s.installedVersions.get(dep.id) ?? "";
			if (compareVersion(local, dep.minVersion) < 0) return "outdated";
		}
		return "ok";
	}

	/** 未满足的必需依赖（卡片徽标与安装后检查共用） */
	blockingOf(id: string, s: DepStatusInput): BlockingDep[] {
		return this.edgesOf(id)
			.filter((d) => d.kind === "required")
			.map((dep) => ({ dep, status: this.statusOf(dep, s) }))
			.filter((x) => x.status !== "ok");
	}

	/** 运行时按需检测后写入（覆盖基线中的同 id 记录） */
	merge(id: string, edges: DepEdge[]): void {
		this.runtime.set(id, edges);
	}
}
```

- [ ] **步骤 5：运行确认通过**

运行：`npx vitest run src/domain/deps/graph.test.ts`
预期：PASS（9）

- [ ] **步骤 6：Commit**

```bash
git add src/domain/deps
git commit -m "feat(deps): DepGraph 数据层（解析降级 / 反向索引 / 五态判定）"
```

---

### 任务 3：加载数据集 + i18n 文案

**文件：**
- 修改：`src/shared/i18n.ts`、`src/app/plugin.ts`、`sync.sh`
- 创建（占位数据，供开发期自测）：`plugin-deps.json`

- [ ] **步骤 1：加 i18n 键**

在 `src/shared/i18n.ts` 的 `journal.*` 区块之后新增：

```ts
	// 插件依赖提示（dep）
	"dep.section": { zh: "依赖" },
	"dep.required": { zh: "必需" },
	"dep.optional": { zh: "可选" },
	"dep.minVersion": { zh: "需 ≥ {v}" },
	"dep.maybe": { zh: "可能" },
	"dep.status.ok": { zh: "已就绪" },
	"dep.status.missing": { zh: "未安装" },
	"dep.status.disabled": { zh: "已安装未启用" },
	"dep.status.outdated": { zh: "版本过低" },
	"dep.status.unknown": { zh: "非官方渠道" },
	"dep.action.install": { zh: "安装" },
	"dep.action.enable": { zh: "启用" },
	"dep.action.update": { zh: "更新" },
	"dep.dependents": { zh: "被依赖（{n}）" },
	"dep.dependents.hint": { zh: "以下插件依赖它，改动前留意影响面" },
	"dep.modal.title": { zh: "{name} 还缺依赖" },
	"dep.modal.desc": { zh: "这些插件不装上（或没启用），{name} 无法正常工作：" },
	"dep.modal.dismiss": { zh: "知道了" },
	"card.depBadge": { zh: "需 {name}" },
	"card.depBadge.more": { zh: "需 {name} +{n}" },
```

- [ ] **步骤 2：写占位数据文件**

`plugin-deps.json`（先手工放两条真实边，P2 由脚本全量替换；放进仓库根，随包分发）：

```json
{
  "version": 1,
  "generatedAt": "2026-09-19T00:00:00.000Z",
  "edges": {
    "obsidian-banners": [
      { "id": "dataview", "name": "Dataview", "kind": "required", "source": "curated", "confidence": 1 }
    ],
    "obsidian-tasks": [
      { "id": "dataview", "name": "Dataview", "kind": "optional", "source": "curated", "confidence": 1 }
    ]
  }
}
```

- [ ] **步骤 3：加载实现**

`src/app/plugin.ts`：

```ts
import { DepGraph } from "@domain/deps/graph";
```

在 `journalHistory` 等字段附近新增字段：

```ts
	/** 插件依赖数据集（plugin-deps.json）；未加载 / 加载失败为 null，依赖相关 UI 整体不渲染 */
	pluginDeps: DepGraph | null = null;
```

新增方法（紧邻 `loadChineseEcosystem` 之后，:2278 之后）：

```ts
	/**
	 * 加载随插件分发的「插件依赖」数据集 plugin-deps.json。
	 * 缺失 / 解析失败 / schema 不匹配一律静默降级（依赖提示整体消失，不影响其它功能）。
	 */
	private async loadPluginDeps(): Promise<void> {
		const fileName = "plugin-deps.json";
		try {
			const adapter = this.app.vault.adapter;
			const fullPath = `.obsidian/plugins/${this.manifest.id}/${fileName}`;
			if (!(await adapter.exists(fullPath))) return;
			const graph = DepGraph.parse(await adapter.read(fullPath));
			if (!graph) return;
			this.pluginDeps = graph;
			// 已打开的视图重渲染一次，使详情区块 / 卡片徽标即时生效
			this.refreshOpenViews();
			logger.debug("[Chinese Plugin Market] 已加载插件依赖数据集");
		} catch (e: unknown) {
			logger.warn("[Chinese Plugin Market] 加载插件依赖数据集失败，已跳过：", e);
		}
	}
```

在后台并行加载那一批（`loadReleaseDates` / `loadChineseEcosystem` / `loadBambooSeries` 所在处，约 :1154-1164）追加：

```ts
			this.loadPluginDeps().catch(() => {});
```

- [ ] **步骤 4：加入分发清单**

`sync.sh` 的 `FILES=(...)` 数组末尾追加 `"plugin-deps.json"`。

- [ ] **步骤 5：校验**

运行：`npx tsc -noEmit -skipLibCheck && npx eslint src --max-warnings=0`
预期：无输出（无错误）

- [ ] **步骤 6：Commit**

```bash
git add src/shared/i18n.ts src/app/plugin.ts sync.sh plugin-deps.json
git commit -m "feat(deps): 加载 plugin-deps.json 数据集并纳入分发清单"
```

---

### 任务 4：详情抽屉「依赖 / 被依赖」区块

**文件：**
- 创建：`src/ui/components/dep-section.ts`
- 修改：`src/ui/components/detail-drawer.ts`（`DrawerOptions` 与 `buildContent`）、`src/ui/view/view-context.ts`、`src/ui/view/translator-view.ts`、`src/ui/view/view-cards.ts`、`styles.css`

- [ ] **步骤 1：写渲染组件**

`src/ui/components/dep-section.ts`：

```ts
import { setIcon } from "obsidian";
import type { I18nKey } from "@shared/i18n";
import type { DepEdge, DepStatus, DependentRef } from "@domain/deps/types";

/** 区块渲染所需的宿主端口（保持组件不依赖 ViewContext） */
export interface DepSectionHost {
	t: (k: I18nKey, vars?: Record<string, string>) => string;
	statusOf: (dep: DepEdge) => DepStatus;
	canOpen: (depId: string) => boolean;
	onOpen: (depId: string) => void;
	onFix: (depId: string, action: "install" | "enable" | "update") => void;
}

const STATUS_KEY: Record<DepStatus, I18nKey> = {
	ok: "dep.status.ok",
	missing: "dep.status.missing",
	disabled: "dep.status.disabled",
	outdated: "dep.status.outdated",
	unknown: "dep.status.unknown",
};

/** 未满足状态下给什么动作按钮；ok / unknown 无动作 */
function actionOf(status: DepStatus): "install" | "enable" | "update" | null {
	if (status === "missing") return "install";
	if (status === "disabled") return "enable";
	if (status === "outdated") return "update";
	return null;
}

export function renderDepSection(parent: HTMLElement, deps: DepEdge[], host: DepSectionHost): void {
	const list = parent.createDiv({ cls: "pt-detail-dep-list" });
	for (const dep of deps) {
		const status = host.statusOf(dep);
		const row = list.createDiv({ cls: `pt-detail-dep-row is-${status}` });

		const dot = row.createSpan({ cls: "pt-detail-dep-dot" });
		setIcon(dot, status === "ok" ? "check-circle" : "alert-circle");

		const name = row.createSpan({ cls: "pt-detail-dep-name", text: dep.name });
		if (host.canOpen(dep.id)) {
			name.addClass("is-link");
			name.addEventListener("click", () => host.onOpen(dep.id));
		}

		row.createSpan({
			cls: "pt-detail-dep-kind",
			text: host.t(dep.kind === "required" ? "dep.required" : "dep.optional"),
		});
		if (dep.minVersion) {
			row.createSpan({ cls: "pt-detail-dep-ver", text: host.t("dep.minVersion", { v: dep.minVersion }) });
		}
		if (dep.confidence < 0.85) {
			row.createSpan({ cls: "pt-detail-dep-maybe", text: host.t("dep.maybe") });
		}
		row.createSpan({ cls: "pt-detail-dep-status", text: host.t(STATUS_KEY[status]) });

		const action = actionOf(status);
		if (action) {
			const btn = row.createEl("button", {
				cls: "pt-detail-dep-fix",
				text: host.t(action === "install" ? "dep.action.install" : action === "enable" ? "dep.action.enable" : "dep.action.update"),
			});
			btn.addEventListener("click", () => host.onFix(dep.id, action));
		}
	}
}

export function renderDependentsSection(
	parent: HTMLElement,
	list_: DependentRef[],
	host: Pick<DepSectionHost, "t" | "canOpen" | "onOpen">,
): void {
	const box = parent.createEl("details", { cls: "pt-detail-dependents" });
	box.createEl("summary", { text: host.t("dep.dependents", { n: String(list_.length) }) });
	box.createDiv({ cls: "pt-detail-dependents-hint", text: host.t("dep.dependents.hint") });
	const wrap = box.createDiv({ cls: "pt-detail-dependents-list" });
	for (const d of list_) {
		const chip = wrap.createSpan({ cls: "pt-detail-dependent-chip", text: d.name });
		if (host.canOpen(d.id)) {
			chip.addClass("is-link");
			chip.addEventListener("click", () => host.onOpen(d.id));
		}
	}
}
```

- [ ] **步骤 2：抽屉加端口**

`src/ui/components/detail-drawer.ts` 的 `DrawerOptions` 追加（在 `versionControl?` 之后）：

```ts
	/**
	 * 依赖提示端口（未提供则不渲染依赖区块）。
	 * 数据全部由宿主提供，抽屉不直接读 plugin 形状，与既有端口风格一致。
	 */
	deps?: {
		edgesOf: (id: string) => DepEdge[];
		dependentsOf: (id: string) => DependentRef[];
		statusOf: (dep: DepEdge) => DepStatus;
		canOpen: (depId: string) => boolean;
		onOpen: (depId: string) => void;
		onFix: (depId: string, action: "install" | "enable" | "update") => void;
	};
```

并在文件顶部补 import：

```ts
import type { DepEdge, DependentRef, DepStatus } from "@domain/deps/types";
import { renderDepSection, renderDependentsSection } from "@ui/components/dep-section";
```

类中新增字段与构造赋值（沿用 `versionControl` 的写法）：

```ts
	/** 依赖提示端口；缺省时详情页不渲染依赖区块 */
	private deps?: DrawerOptions["deps"];
```

```ts
		this.deps = opts.deps;
```

- [ ] **步骤 3：插入区块**

在 `buildContent` 中「安装状态」meta 之后、描述之前（:839 的 `}` 之后、`// ── 描述` 之前）插入：

```ts
		// ── 依赖 / 被依赖（数据缺失时整块不渲染）──
		if (this.deps) {
			const dc = this.deps;
			const host = {
				// this.t 是 TFunc，原生支持带参（见 :924 的 version.pinned），直接透传即可
				t: (k: I18nKey, vars?: Record<string, string>) => this.t(k, vars),
				statusOf: (dep: DepEdge) => dc.statusOf(dep),
				canOpen: (id: string) => dc.canOpen(id),
				onOpen: (id: string) => dc.onOpen(id),
				onFix: (id: string, action: "install" | "enable" | "update") => dc.onFix(id, action),
			};
			const deps = dc.edgesOf(p.id);
			if (deps.length > 0) {
				const section = headBlock.createDiv({ cls: "pt-detail-deps" });
				section.createDiv({ cls: "pt-detail-deps-title", text: this.t("dep.section") });
				renderDepSection(section, deps, host);
			}
			const dependents = dc.dependentsOf(p.id);
			if (dependents.length > 0) {
				const section = headBlock.createDiv({ cls: "pt-detail-deps" });
				renderDependentsSection(section, dependents, host);
			}
		}
```

- [ ] **步骤 4：ctx 端口与装配**

`src/ui/view/view-context.ts` 追加字段（在 `listPluginVersions` 之后）：

```ts
	// ── 插件依赖提示 ──
	/** 依赖数据集（未加载时为 null，依赖相关 UI 整体不渲染） */
	pluginDeps: DepGraph | null;
	/** 处理某个依赖：安装 / 启用 / 更新（由视图层找到 PluginInfo 后走既有流程） */
	fixDep: (depId: string, action: "install" | "enable" | "update") => void;
```

工厂（`createViewContext`）追加绑定：

```ts
		get pluginDeps() { return view.plugin.pluginDeps; },
		fixDep: (id, action) => view.fixDep(id, action),
```

`src/ui/view/translator-view.ts` 新增方法（放在 `renderBetaList` 之后）：

```ts
	/**
	 * 处理一个依赖插件：安装 / 启用 / 更新。
	 * 复用既有流程（handleInstall / handleToggleEnabled / updatePlugin），
	 * 保证与卡片上的同名操作行为完全一致（含 installingIds 加锁与刷新）。
	 */
	public fixDep = (depId: string, action: "install" | "enable" | "update") => {
		const info = this.plugins.find((p) => p.id === depId);
		if (!info) return;
		if (action === "install") void handleInstall(this._ctx, info);
		else if (action === "enable") void handleToggleEnabled(this._ctx, info);
		else void this.updatePlugin(depId);
	};
```

（需在 `translator-view.ts` 顶部 import `handleInstall` / `handleToggleEnabled`，文件已 import 过 `installCommunityPlugin` 等，按需补齐。）

`src/ui/view/view-cards.ts` 的 `openDetailDrawer` 装配端口（在 `versionControl` 之后）：

```ts
		deps: ctx.pluginDeps
			? (() => {
					const graph = ctx.pluginDeps as DepGraph;
					const knownIds = new Set(ctx.allPlugins.map((p) => p.id));
					return {
						edgesOf: (id: string) => graph.edgesOf(id),
						dependentsOf: (id: string) => graph.dependentsOf(id),
						statusOf: (dep: DepEdge) =>
							graph.statusOf(dep, {
								installedIds: ctx.installedIds,
								enabledIds: ctx.enabledIds,
								installedVersions: ctx.installedVersions,
								knownIds,
							}),
						canOpen: (id: string) => knownIds.has(id),
						onOpen: (id: string) => ctx.openDetailDrawer(id),
						onFix: (id: string, action: "install" | "enable" | "update") => ctx.fixDep(id, action),
					};
				})()
			: undefined,
```

- [ ] **步骤 5：CSS**

`styles.css` 末尾追加：

```css
/* 详情抽屉：依赖 / 被依赖区块 */
.pt-detail-deps {
	margin-top: 8px;
}
.pt-detail-deps-title {
	font-weight: var(--font-semibold, 600);
	color: var(--text-normal);
	margin-bottom: 4px;
}
.pt-detail-dep-row {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 3px 0;
	color: var(--text-normal);
	font-size: var(--font-ui-smaller, 12px);
}
.pt-detail-dep-dot {
	display: inline-flex;
	color: var(--text-faint);
}
.pt-detail-dep-row.is-ok .pt-detail-dep-dot {
	color: var(--text-success);
}
.pt-detail-dep-row.is-missing .pt-detail-dep-dot,
.pt-detail-dep-row.is-disabled .pt-detail-dep-dot,
.pt-detail-dep-row.is-outdated .pt-detail-dep-dot {
	color: var(--text-error);
}
.pt-detail-dep-dot svg {
	width: 13px;
	height: 13px;
}
.pt-detail-dep-name.is-link,
.pt-detail-dependent-chip.is-link {
	cursor: pointer;
	text-decoration: underline dotted var(--text-faint);
	text-underline-offset: 3px;
}
.pt-detail-dep-name.is-link:hover,
.pt-detail-dependent-chip.is-link:hover {
	color: var(--text-accent);
}
.pt-detail-dep-kind,
.pt-detail-dep-ver,
.pt-detail-dep-maybe,
.pt-detail-dependent-chip {
	padding: 0 6px;
	border: 1px solid var(--background-modifier-border);
	border-radius: 8px;
	color: var(--text-muted);
}
.pt-detail-dep-status {
	color: var(--text-muted);
	margin-left: auto;
}
.pt-detail-dep-fix {
	margin: 0;
	padding: 1px 8px;
}
.pt-detail-dependents summary {
	cursor: pointer;
	color: var(--text-muted);
	font-size: var(--font-ui-smaller, 12px);
}
.pt-detail-dependents-hint {
	color: var(--text-faint);
	font-size: var(--font-ui-smaller, 12px);
	margin: 4px 0;
}
.pt-detail-dependents-list {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
}
```

- [ ] **步骤 6：校验**

运行：`npx tsc -noEmit -skipLibCheck && npx eslint src --max-warnings=0 && npx vitest run`
预期：全部通过，无新增失败

- [ ] **步骤 7：Commit**

```bash
git add src/ui/components/dep-section.ts src/ui/components/detail-drawer.ts src/ui/view/view-context.ts src/ui/view/translator-view.ts src/ui/view/view-cards.ts styles.css
git commit -m "feat(deps): 详情抽屉展示依赖与状态，未满足时给安装/启用/更新入口"
```

---

## 阶段 P1：卡片徽标 + 安装后检查

### 任务 5：卡片「依赖未满足」徽标

**文件：**
- 修改：`src/ui/components/card-render.ts`、`styles.css`

- [ ] **步骤 1：创建徽标节点**

在 `createCardElement` 的「装过」徽标之后（:353 之后）插入：

```ts
	// 「依赖未满足」徽标：存在 required 依赖且状态非 ok 时显示（装齐了不显示，零打扰）
	const depBadge = metaInfo.createSpan({ cls: "pt-card-dep-badge" });
	depBadge.setAttribute("aria-hidden", "true");
	depBadge.setCssStyles({ display: "none" });
```

并在 refs 注册处（:475-480，与 `triedBadge` 同批）加入 `depBadge`。

- [ ] **步骤 2：CardRenderContext 补输入**

在 `CardRenderContext` 中追加（`src/ui/components/card-render.ts:118-121` 附近）：

```ts
	/** 依赖数据集（未加载为 null） */
	depGraph?: DepGraph | null;
	/** 已装插件本地版本号 */
	installedVersions?: Map<string, string>;
	/** 官方列表 id 集合（判定依赖目标能否给出安装入口） */
	knownPluginIds?: Set<string>;
```

- [ ] **步骤 3：填充逻辑**

在 `applyCardState` 中「装过」徽标填充之后（约 :887 之后）插入：

```ts
	// 依赖未满足徽标：只在「必需依赖没到位」时出现，避免常态噪音
	const graph = ctx.depGraph;
	const blocking =
		graph && ctx.installedVersions && ctx.knownPluginIds
			? graph.blockingOf(plugin.id, {
					installedIds: ctx.installedIds,
					enabledIds: ctx.enabledIds,
					installedVersions: ctx.installedVersions,
					knownIds: ctx.knownPluginIds,
				})
			: [];
	if (blocking.length > 0) {
		const first = blocking[0].dep.name || blocking[0].dep.id;
		refs.depBadge.setText(
			blocking.length > 1
				? ctx.t("card.depBadge.more", { name: first, n: String(blocking.length - 1) })
				: ctx.t("card.depBadge", { name: first }),
		);
		refs.depBadge.setCssStyles({ display: "" });
	} else {
		refs.depBadge.setCssStyles({ display: "none" });
	}
```

- [ ] **步骤 4：卡片 ctx 注入**

在构造 `cardCtxMap` / 卡片渲染上下文处（搜索 `cardCtxMap.set`）补齐：

```ts
		depGraph: ctx.pluginDeps,
		installedVersions: ctx.installedVersions,
		knownPluginIds: knownIds,   // 与视图共用同一份 Set；若此处未缓存则 new Set(ctx.allPlugins.map(p => p.id))
```

- [ ] **步骤 5：CSS**

```css
.pt-card-dep-badge {
	padding: 0 6px;
	border: 1px solid var(--text-error);
	border-radius: 8px;
	color: var(--text-error);
	font-size: var(--font-ui-smaller, 11px);
	white-space: nowrap;
}
```

- [ ] **步骤 6：校验 + Commit**

```bash
npx tsc -noEmit -skipLibCheck && npx eslint src --max-warnings=0
git add src/ui/components/card-render.ts src/ui/view/view-render.ts styles.css
git commit -m "feat(deps): 卡片显示「依赖未满足」徽标（装齐则不显示）"
```

---

### 任务 6：安装后的依赖检查弹窗

**文件：**
- 创建：`src/ui/modals/dep-check-modal.ts`、`src/ui/view/deps-report.ts`
- 修改：`src/data/platform/plugin-installer.ts`（:432 附近）

- [ ] **步骤 1：写 Modal**

`src/ui/modals/dep-check-modal.ts`：

新 Modal 直接复用 `TFunc` 类型（与抽屉、设置页一致），避免任何 `as never` 强转：

```ts
import { App, Modal, Setting } from "obsidian";
import type { TFunc } from "@shared/i18n";
import type { DepStatus } from "@domain/deps/types";

export interface DepCheckItem {
	name: string;
	status: DepStatus;
	action: "install" | "enable" | "update" | null;
}

export interface DepCheckOptions {
	app: App;
	pluginName: string;
	items: DepCheckItem[];
	t: TFunc;
	onFix: (item: DepCheckItem) => void;
}

/** 安装完成后提示「还缺依赖」，并给一键处理入口（Notice 不可点击，必须弹窗） */
export class DepCheckModal extends Modal {
	private opts: DepCheckOptions;

	constructor(opts: DepCheckOptions) {
		super(opts.app);
		this.opts = opts;
	}

	onOpen(): void {
		const { contentEl, opts } = this;
		contentEl.empty();
		contentEl.addClass("pt-dep-check-modal");
		contentEl.createEl("h3", { text: opts.t("dep.modal.title", { name: opts.pluginName }) });
		contentEl.createEl("p", {
			cls: "pt-dep-check-desc",
			text: opts.t("dep.modal.desc", { name: opts.pluginName }),
		});

		for (const item of opts.items) {
			new Setting(contentEl)
				.setName(item.name)
				.setDesc(
					opts.t(
						item.status === "missing"
							? "dep.status.missing"
							: item.status === "disabled"
								? "dep.status.disabled"
								: "dep.status.outdated",
					),
				)
				.addButton((btn) => {
					if (!item.action) return;
					btn.setButtonText(
						opts.t(
							item.action === "install"
								? "dep.action.install"
								: item.action === "enable"
									? "dep.action.enable"
									: "dep.action.update",
						),
					).setCta().onClick(() => {
						opts.onFix(item);
						btn.setDisabled(true);
					});
				});
		}

		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText(opts.t("dep.modal.dismiss")).onClick(() => this.close()),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
```

- [ ] **步骤 2：写钩子**

`src/ui/view/deps-report.ts`：

```ts
import { DepCheckModal, type DepCheckItem } from "@ui/modals/dep-check-modal";
import type { ViewContext } from "@ui/view/view-context";
import type { DepStatus } from "@domain/deps/types";

/** 状态 → 补就动作；ok / unknown 不提供动作（unknown 无法从官方列表安装） */
function actionOf(status: DepStatus): "install" | "enable" | "update" | null {
	if (status === "missing") return "install";
	if (status === "disabled") return "enable";
	if (status === "outdated") return "update";
	return null;
}

/**
 * 安装完成后的依赖检查：有未满足的必需依赖才弹窗，否则一声不响。
 * 必须晚于 snapshotInstalled 调用，否则会把刚装的依赖读成「缺失」。
 */
export function reportMissingDeps(ctx: ViewContext, pluginId: string, pluginName: string): void {
	const graph = ctx.pluginDeps;
	if (!graph) return;
	const blocking = graph.blockingOf(pluginId, {
		installedIds: ctx.installedIds,
		enabledIds: ctx.enabledIds,
		installedVersions: ctx.installedVersions,
		knownIds: new Set(ctx.allPlugins.map((p) => p.id)),
	});
	if (blocking.length === 0) return;

	const items: DepCheckItem[] = blocking.map((b) => ({
		name: b.dep.name || b.dep.id,
		status: b.status,
		action: actionOf(b.status),
	}));
	new DepCheckModal({
		app: ctx.app,
		pluginName,
		items,
		t: ctx.t,
		onFix: (item) => {
			const depId = blocking.find((b) => (b.dep.name || b.dep.id) === item.name)?.dep.id;
			if (!depId || !item.action) return;
			ctx.fixDep(depId, item.action);
		},
	}).open();
}
```

- [ ] **步骤 3：接入安装流程**

`src/data/platform/plugin-installer.ts` 的成功分支（:432-435）：

```ts
	if (enabled) {
		new Notice(t("notice.install.success", { name: plugin.name }));
		reportMissingDeps(ctx, plugin.id, plugin.name);
		return { ok: true };
	}
```

`recognized` 分支（:437-441）同样补一行 `reportMissingDeps(ctx, plugin.id, plugin.name);`（文件已写盘，只是没自动启用，依赖提示仍然有意义）。

顶部补 import：

```ts
import { reportMissingDeps } from "@ui/view/deps-report";
```

- [ ] **步骤 4：校验 + Commit**

```bash
npx tsc -noEmit -skipLibCheck && npx eslint src --max-warnings=0 && npx vitest run
git add src/ui/modals/dep-check-modal.ts src/ui/view/deps-report.ts src/data/platform/plugin-installer.ts
git commit -m "feat(deps): 安装后检查必需依赖，缺失时弹窗给一键处理"
```

- [ ] **步骤 5：手工验收（P0+P1）**

1. `npm run build && ./sync.sh`
2. Obsidian 中重载插件
3. 打开 `obsidian-banners` 详情（占位数据里它必需 Dataview）→ 应看到「依赖」区块
4. 未装 Dataview 时：区块显示「未安装」+「安装」按钮；卡片上有「需 Dataview」徽标
5. 装了 Dataview 但禁用：显示「已安装未启用」+「启用」按钮
6. 安装 `obsidian-banners` 完成后：弹出依赖检查窗，点「安装」能拉起 Dataview 安装
7. 反向：打开 Dataview 详情 → 「被依赖（1）」折叠区列出 Banners

---

## 阶段 P2：自动检测补长尾

### 任务 7：检测规则与纯函数

**文件：**
- 创建：`src/domain/deps/rules.ts`、`src/domain/deps/detect.ts`、`src/domain/deps/detect.test.ts`

- [ ] **步骤 1：规则表**

`src/domain/deps/rules.ts`：

```ts
import type { DepKind, DepSource } from "./types";

/** 一条 README 匹配规则；`{{DEP}}` 会被替换为目标插件名（已正则转义） */
export interface ReadmeRule {
	pattern: string;
	source: DepSource;
	confidence: number;
	kind: DepKind;
}

/** 强措辞：作者明确表示「必须装」 */
export const README_STRONG: ReadmeRule[] = [
	{ pattern: "requires?\\s+{{DEP}}", source: "readme", confidence: 0.7, kind: "required" },
	{ pattern: "{{DEP}}\\s+is\\s+required", source: "readme", confidence: 0.7, kind: "required" },
	{ pattern: "must\\s+(?:have|install)\\s+{{DEP}}", source: "readme", confidence: 0.7, kind: "required" },
	{ pattern: "依赖\\s*{{DEP}}", source: "readme", confidence: 0.7, kind: "required" },
	{ pattern: "需要(?:安装|先装)\\s*{{DEP}}", source: "readme", confidence: 0.7, kind: "required" },
];

/** 弱措辞：只是「能配合」，不足以判成必需 */
export const README_WEAK: ReadmeRule[] = [
	{ pattern: "works?\\s+with\\s+{{DEP}}", source: "readme", confidence: 0.35, kind: "optional" },
	{ pattern: "integrates?\\s+with\\s+{{DEP}}", source: "readme", confidence: 0.35, kind: "optional" },
	{ pattern: "compatible\\s+with\\s+{{DEP}}", source: "readme", confidence: 0.35, kind: "optional" },
	{ pattern: "supports?\\s+{{DEP}}", source: "readme", confidence: 0.35, kind: "optional" },
	{ pattern: "(?:可)?配合\\s*{{DEP}}", source: "readme", confidence: 0.35, kind: "optional" },
];

/** main.js 里「真的在调用目标插件」的特征；`{{ID}}` 替换为插件 id */
export const MAINJS_PATTERNS: string[] = [
	"plugins\\.plugins\\.{{ID}}",
	"plugins\\[[\"']{{ID}}[\"']\\]",
	"getPlugin\\([\"']{{ID}}[\"']\\)",
];

/** 置信度阈值：<DROP 丢弃；[DROP, REQUIRED_MIN) 降为 optional；>= REQUIRED_MIN 才可为 required */
export const DROP_BELOW = 0.4;
export const REQUIRED_MIN = 0.7;
/** UI 标「可能」的阈值 */
export const MAYBE_BELOW = 0.85;

/** 把规则模板编译成针对某个目标的正则（大小写不敏感） */
export function compileRule(pattern: string, target: string): RegExp {
	const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(pattern.replace("{{DEP}}", escaped).replace("{{ID}}", escaped), "i");
}
```

- [ ] **步骤 2：写失败测试**

`src/domain/deps/detect.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { detectDeps } from "@domain/deps/detect";

const dict = [
	{ id: "dataview", name: "Dataview", aliases: ["DataviewJS"] },
	{ id: "templater", name: "Templater", aliases: [] },
];

describe("detectDeps", () => {
	it("README 强措辞 → required 0.7", () => {
		const out = detectDeps({ selfId: "x", readme: "This plugin requires Dataview.", dict });
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ id: "dataview", kind: "required", source: "readme", confidence: 0.7 });
	});
	it("README 弱措辞 → optional 0.35", () => {
		const out = detectDeps({ selfId: "x", readme: "Works with Templater!", dict });
		expect(out[0]).toMatchObject({ id: "templater", kind: "optional", confidence: 0.35 });
	});
	it("manifest 声明优先（0.9）且覆盖 README 的弱命中", () => {
		const out = detectDeps({
			selfId: "x",
			manifestDeps: { dataview: ">=0.5.0" },
			readme: "Works with Dataview",
			dict,
		});
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ source: "manifest", confidence: 0.9, kind: "required" });
	});
	it("main.js 调用特征 0.85，并取版本下限", () => {
		const out = detectDeps({
			selfId: "x",
			manifestDeps: { dataview: "0.5.0" },
			mainJs: "const dv = app.plugins.plugins['dataview'];",
			dict,
		});
		expect(out[0]).toMatchObject({ source: "manifest", minVersion: "0.5.0" });
	});
	it("自依赖与未知目标被丢弃", () => {
		expect(detectDeps({ selfId: "dataview", readme: "requires Dataview", dict })).toHaveLength(0);
		expect(detectDeps({ selfId: "x", readme: "requires SomeUnknownThing", dict })).toHaveLength(0);
	});
	it("别名命中（DataviewJS → dataview）", () => {
		const out = detectDeps({ selfId: "x", readme: "Needs DataviewJS to render.", dict });
		expect(out[0].id).toBe("dataview");
	});
});
```

- [ ] **步骤 3：运行确认失败**

运行：`npx vitest run src/domain/deps/detect.test.ts`
预期：FAIL —— 模块不存在

- [ ] **步骤 4：实现**

`src/domain/deps/detect.ts`：

```ts
import type { DepEdge, DepKind, DepSource } from "./types";
import {
	DROP_BELOW,
	MAINJS_PATTERNS,
	README_STRONG,
	README_WEAK,
	REQUIRED_MIN,
	compileRule,
} from "./rules";

export interface DepCandidate {
	id: string;
	name: string;
	aliases?: string[];
}

export interface DetectInput {
	selfId: string;
	/** manifest.dependencies（对象或数组，社区插件形态不一） */
	manifestDeps?: unknown;
	readme?: string;
	mainJs?: string;
	/** 候选目标（官方列表 id/name + 别名） */
	dict: DepCandidate[];
}

interface Hit {
	source: DepSource;
	confidence: number;
	kind: DepKind;
	minVersion?: string;
}

/** manifest.dependencies 的 key 列表（兼容对象与数组两种写法） */
function depKeys(v: unknown): string[] {
	if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
	if (v && typeof v === "object") return Object.keys(v as Record<string, unknown>);
	return [];
}

/**
 * 从 manifest / main.js / README 推断一个插件依赖谁。
 * 纯函数：不碰网络，便于单测，也便于生成脚本与运行时共用同一套规则。
 */
export function detectDeps(input: DetectInput): DepEdge[] {
	const { selfId, dict } = input;
	const readme = input.readme ?? "";
	const mainJs = input.mainJs ?? "";
	const declared = new Set(depKeys(input.manifestDeps));

	const out: DepEdge[] = [];
	for (const c of dict) {
		if (c.id === selfId) continue; // 自依赖无意义

		let best: Hit | null = null;
		const consider = (h: Hit) => {
			if (!best || h.confidence > best.confidence) best = h;
		};

		// 1) manifest 显式声明
		if (declared.has(c.id) || declared.has(c.name)) {
			const raw = (input.manifestDeps as Record<string, unknown> | undefined)?.[c.id];
			const minVersion = typeof raw === "string" ? raw.replace(/^[^\d]*/, "") : undefined;
			consider({ source: "manifest", confidence: 0.9, kind: "required", minVersion });
		}

		// 2) main.js 真的在调用
		if (MAINJS_PATTERNS.some((p) => compileRule(p, c.id).test(mainJs))) {
			consider({ source: "mainjs", confidence: 0.85, kind: "required" });
		}

		// 3) README 措辞（强 → 必需候选，弱 → 可选）
		const names = [c.name, ...(c.aliases ?? [])].filter(Boolean);
		for (const n of names) {
			for (const r of README_STRONG) {
				if (compileRule(r.pattern, n).test(readme)) {
					const m = new RegExp(`${r.pattern.replace("{{DEP}}", "([0-9][0-9.]*)")}`, "i").exec(readme);
					consider({ source: r.source, confidence: r.confidence, kind: r.kind, minVersion: m?.[1] });
				}
			}
			for (const r of README_WEAK) {
				if (compileRule(r.pattern, n).test(readme)) {
					consider({ source: r.source, confidence: r.confidence, kind: r.kind });
				}
			}
		}

		if (!best) continue;
		const hit = best as Hit;
		if (hit.confidence < DROP_BELOW) continue;
		// 置信度不足 REQUIRED_MIN 的一律降为 optional：宁可少报必需，不可误报必需
		const kind: DepKind = hit.confidence >= REQUIRED_MIN ? hit.kind : "optional";
		out.push({
			id: c.id,
			name: c.name,
			kind,
			minVersion: hit.minVersion,
			source: hit.source,
			confidence: hit.confidence,
		});
	}
	return out;
}
```

- [ ] **步骤 5：运行确认通过**

运行：`npx vitest run src/domain/deps/detect.test.ts`
预期：PASS（6）

- [ ] **步骤 6：Commit**

```bash
git add src/domain/deps
git commit -m "feat(deps): 依赖自动检测纯函数（manifest/main.js/README 三路证据）"
```

---

### 任务 8：离线生成脚本与全量数据

**文件：**
- 创建：`scripts/gen-plugin-deps.mjs`、`scripts/deps/curated.json`
- 修改：`plugin-deps.json`（脚本产出覆盖）

- [ ] **步骤 1：精修源**

`scripts/deps/curated.json`（先录入最典型的枢纽插件，后续按反馈增补）：

```json
{
  "dataview": {
    "name": "Dataview",
    "aliases": ["DataviewJS"],
    "dependents": {
      "required": ["obsidian-banners", "dbfolder", "obsidian-projects", "dataview-serializer"],
      "optional": ["obsidian-tasks", "advanced-tables"]
    }
  },
  "templater": {
    "name": "Templater",
    "aliases": [],
    "dependents": { "required": ["templater-obsidian-snippets"], "optional": ["quickadd"] }
  }
}
```

- [ ] **步骤 2：脚本**

`scripts/gen-plugin-deps.mjs`（要点：并发 8、esbuild 现打 rules.ts 后以 data URL import、强信号采纳 / 弱信号只进候选清单）：

```js
#!/usr/bin/env node
/**
 * 离线生成 plugin-deps.json（插件依赖基线）。
 *
 * 用法：
 *   node scripts/gen-plugin-deps.mjs                 # 全量
 *   node scripts/gen-plugin-deps.mjs --limit 200     # 只处理前 200 个（调试）
 *   node scripts/gen-plugin-deps.mjs --only-new      # 只处理现有结果里没有的 id
 *
 * 注意：PLUGINS_URL 在此处写成字面量（与 src/shared/constants.ts 的 PLUGINS_URL 保持一致），
 * 因为脚本是纯 Node 环境，不能直接 import TS 常量文件。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { loadModule, loadRules } from "./esbuild-load.mjs";

const PLUGINS_URL =
	"https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json";
const CONCURRENCY = 8;
const README_LIMIT = 5000;

async function fetchText(url) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.text();
}

async function fetchJson(url) {
	return JSON.parse(await fetchText(url));
}

/** 依次尝试常见 README 文件名，取前 README_LIMIT 字符；都取不到返回空串 */
async function fetchReadme(repo) {
	for (const name of ["README.md", "readme.md"]) {
		try {
			const text = await fetchText(`https://raw.githubusercontent.com/${repo}/HEAD/${name}`);
			return text.slice(0, README_LIMIT);
		} catch {
			/* 换下一个文件名 */
		}
	}
	return "";
}

async function main() {
	const args = process.argv.slice(2);
	const limitIdx = args.indexOf("--limit");
	const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;
	const onlyNew = args.includes("--only-new");

	const rules = await loadRules();
	const { detectDeps } = await loadModule("src/domain/deps/detect.ts");
	const curated = JSON.parse(readFileSync("scripts/deps/curated.json", "utf8"));
	const list = (await fetchJson(PLUGINS_URL)).slice(0, limit);

	const prev = onlyNew
		? JSON.parse(readFileSync("plugin-deps.json", "utf8")).edges ?? {}
		: {};
	const dict = list.map((p) => ({
		id: p.id,
		name: p.name,
		aliases: curated[p.id]?.aliases ?? [],
	}));

	const edges = { ...prev };
	const candidates = [];
	let cursor = 0;

	async function worker() {
		while (cursor < list.length) {
			const p = list[cursor++];
			if (!p.repo || edges[p.id]) continue;
			try {
				const manifest = await fetchJson(
					`https://raw.githubusercontent.com/${p.repo}/HEAD/manifest.json`,
				);
				const readme = await fetchReadme(p.repo);
				const found = detectDeps({ selfId: p.id, manifestDeps: manifest.dependencies, readme, dict });
				for (const e of found) {
					if (e.confidence >= rules.REQUIRED_MIN) (edges[p.id] ??= []).push(e);
					else candidates.push({ id: p.id, name: p.name, ...e });
				}
			} catch {
				/* 单插件失败不影响整体 */
			}
		}
	}
	await Promise.all(Array.from({ length: CONCURRENCY }, worker));

	// 精修层覆盖检测结果
	for (const [hubId, hub] of Object.entries(curated)) {
		for (const kind of ["required", "optional"]) {
			for (const dependentId of hub.dependents?.[kind] ?? []) {
				const arr = (edges[dependentId] ??= []).filter((e) => e.id !== hubId);
				arr.push({ id: hubId, name: hub.name, kind, source: "curated", confidence: 1 });
				edges[dependentId] = arr;
			}
		}
	}

	writeFileSync(
		"plugin-deps.json",
		`${JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), edges }, null, 2)}\n`,
	);
	writeFileSync(
		"docs/plugin-deps-candidates.md",
		[
			"# 依赖候选（弱信号，需人工抽查后并入 scripts/deps/curated.json）",
			"",
			"| 插件 | 目标 | 来源 | 置信度 |",
			"| --- | --- | --- | --- |",
			...candidates.map((c) => `| ${c.name} | ${c.id} | ${c.source} | ${c.confidence} |`),
			"",
		].join("\n"),
	);
	console.log(`✓ 写入 ${Object.keys(edges).length} 条插件记录，${candidates.length} 条弱信号候选`);
}

main();
```

- [ ] **步骤 3：写 TS 模块加载器（脚本与运行时共用同一份规则的关键）**

`scripts/esbuild-load.mjs`：

```js
/**
 * 在纯 Node 脚本里加载 TS 模块：用 esbuild 现打成 ESM，再以 data URL 动态 import。
 * 目的：让生成脚本与运行时共用 src/domain/deps/rules.ts 这一份规则，杜绝两份正则漂移。
 */
import { build } from "esbuild";

export async function loadModule(entry) {
	const out = await build({
		entryPoints: [entry],
		bundle: true,
		format: "esm",
		platform: "node",
		write: false,
	});
	const code = out.outputFiles[0].text;
	return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

export const loadRules = () => loadModule("src/domain/deps/rules.ts");
```

- [ ] **步骤 3b：脚本行为约定（上面代码已实现，此处是对产物的验收口径）**

- 每个插件取 `https://raw.githubusercontent.com/<repo>/HEAD/manifest.json` 与 README（依次尝试 `README.md` / `readme.md`，取前 5000 字符）；任一失败即跳过该插件
- 判定时 `dict` = 全量列表的 `{id, name}` + curated 里的 `aliases`
- 合并顺序：先放检测结果（仅 `confidence >= REQUIRED_MIN` 的强信号），再用 curated 覆盖（展开成 `source:"curated", confidence:1`；required/optional 分别取自 curated 的两个数组）
- 输出 `plugin-deps.json`（`{version:1, generatedAt, edges}`）与 `docs/plugin-deps-candidates.md`（弱信号候选表，供人工抽查后并入 curated）
- `--only-new`：读现有 `plugin-deps.json` 的 key，跳过已存在的 id

- [ ] **步骤 3：跑全量并抽查**

```bash
node scripts/gen-plugin-deps.mjs --limit 50   # 先小样本验证输出形状
node scripts/gen-plugin-deps.mjs              # 全量（几分钟）
```

检查 `plugin-deps.json`：`edges` 里 curated 的边 `source` 必须是 `curated`、`confidence` 必须是 1；抽查 `docs/plugin-deps-candidates.md` 里 10 条弱信号，把确认成立的并入 `scripts/deps/curated.json` 后重跑。

- [ ] **步骤 4：Commit**

```bash
git add scripts/gen-plugin-deps.mjs scripts/esbuild-load.mjs scripts/deps/curated.json plugin-deps.json docs/plugin-deps-candidates.md
git commit -m "feat(deps): 离线生成依赖基线（精修打底 + 强信号自动采纳）"
```

---

### 任务 9：运行时按需兜底

**文件：**
- 创建：`src/ui/view/deps-lazy.ts`
- 修改：`src/ui/components/detail-drawer.ts`、`src/ui/view/view-cards.ts`

- [ ] **步骤 1：按需检测模块**

`src/ui/view/deps-lazy.ts`：

```ts
import { requestUrl } from "obsidian";
import type { ViewContext } from "@ui/view/view-context";
import { detectDeps } from "@domain/deps/detect";
import { fetchManifest } from "@domain/compare/plugin-insight";

/** 已在检测中的 id，避免重复请求 */
const pending = new Set<string>();
/** 已检测过（含「检测出来没有依赖」）的 id */
const done = new Set<string>();

/**
 * 基线里没有该插件时，按它的 repo 现算一次依赖并写回 DepGraph（会话内有效，不落盘）。
 * 网络失败静默：详情页不显示依赖区块，不提示错误。
 */
export async function ensureDepsFor(ctx: ViewContext, id: string, repo: string | undefined): Promise<void> {
	const graph = ctx.pluginDeps;
	if (!graph || !repo || done.has(id) || pending.has(id)) return;
	if (graph.edgesOf(id).length > 0) {
		done.add(id);
		return;
	}
	pending.add(id);
	try {
		const mirror = ctx.mirrorConfig();
		const manifest = await fetchManifest(repo, mirror);
		const root = repo.replace(/\/+$/, "");
		let readme = "";
		for (const name of ["README.md", "readme.md"]) {
			const r = await requestUrl({
				url: `https://raw.githubusercontent.com/${root}/HEAD/${name}`,
				throw: false,
			});
			if (r.status >= 200 && r.status < 300) {
				readme = r.text.slice(0, 5000);
				break;
			}
		}
		const dict = ctx.allPlugins.map((p) => ({ id: p.id, name: p.name }));
		const edges = detectDeps({ selfId: id, manifestDeps: manifest.dependencies, readme, dict });
		if (edges.length > 0) graph.merge(id, edges);
	} catch {
		/* 静默：长尾插件检测失败不影响使用 */
	} finally {
		pending.delete(id);
		done.add(id);
	}
}
```

- [ ] **步骤 2：抽屉触发**

`DrawerOptions.deps` 追加：

```ts
		/** 基线缺失时按需现算（异步；完成后由抽屉自行重渲依赖区块） */
		ensure?: (id: string, repo?: string) => Promise<void>;
```

在抽屉的依赖区块渲染之后追加：

```ts
		if (this.deps?.ensure && deps.length === 0 && p.repo) {
			const dc = this.deps;
			void dc.ensure(p.id, p.repo).then(() => {
				if (this.currentPluginId !== p.id) return; // 期间跳走了就别再动 DOM
				const fresh = dc.edgesOf(p.id);
				if (fresh.length === 0) return;
				const section = headBlock.createDiv({ cls: "pt-detail-deps" });
				section.createDiv({ cls: "pt-detail-deps-title", text: this.t("dep.section") });
				renderDepSection(section, fresh, host);
			});
		}
```

`view-cards.ts` 装配时补：

```ts
						ensure: (id: string, repo?: string) => ensureDepsFor(ctx, id, repo),
```

- [ ] **步骤 3：全量校验**

```bash
npx tsc -noEmit -skipLibCheck && npx eslint src --max-warnings=0 && npx vitest run && npm run build
```

预期：全部通过；`main.js` 构建成功。

- [ ] **步骤 4：Commit + 发版**

```bash
git add -A
git commit -m "feat(deps): 长尾插件按需检测依赖兜底（会话内缓存，失败静默）"
```

随后按既有流程：`manifest.json` / `package.json` / `versions.json` 升版本号 → `npm run build` → commit → `git push origin main` → `node scripts/release.mjs` → `./sync.sh`。

---

## 自检清单（编写后已核对）

1. **规格覆盖度**：数据模型（任务 2/3）、精修层（任务 8）、检测层（任务 7/8/9）、状态判定（任务 2）、卡片徽标（任务 5）、详情区块（任务 4）、反向依赖（任务 4）、安装后检查（任务 6）、i18n（任务 3）、测试（任务 1/2/7）——规格每一节都有对应任务。
2. **占位符扫描**：无「待定 / TODO / 后续实现」；脚本里所有实现细节都已写死（含 `esbuild-load.mjs` 的完整代码）。
3. **类型一致性**：全计划统一使用 `DepEdge` / `DepKind` / `DepStatus` / `DependentRef` / `DepGraph.blockingOf` / `ctx.fixDep` / `DepStatusInput`；`compareVersion` 只在 `src/shared/version.ts` 定义一次。
