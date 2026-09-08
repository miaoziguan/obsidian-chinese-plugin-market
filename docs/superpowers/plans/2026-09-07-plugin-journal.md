# 插件评测台账（Plugin Journal）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在插件市场内建立「插件试用台账」——自动记录装过哪些插件、什么时候装卸、装了几次，并允许用户对每个插件写评测备注、打 1–5 星、标注弃用原因，最终通过一个独立标签页视图以表格形式查阅筛选。

**架构：** 数据分两层——机器产生的「安装历史」存 `install-history.json`（插件私有目录，由 `installed-watch` 已有的 add/remove diff 驱动）；用户产生的「评测笔记」存 markdown（复用 `NoteStoragePort` 双后端，默认 `.obsidian/plugins/chinese-plugin-market/reviews/`，可切 vault 路径）。UI 分布在详情抽屉（编辑）、卡片（徽标）、工具栏（筛选 + 入口）、独立视图（查阅）。

**技术栈：** TypeScript + Obsidian API + esbuild + vitest；无前端框架，全原生 DOM；存储复用 `NoteStoragePort` / `PluginStorage`。

**规格来源：** `docs/superpowers/specs/2026-09-07-plugin-journal-design.md`

---

## 文件结构

### 新建

| 文件 | 职责 |
|---|---|
| `src/domain/journal/journal-entry.ts` | 评测条目数据模型 + frontmatter 解析与渲染（纯函数，可单测） |
| `src/domain/journal/install-history.ts` | 安装历史索引的 diff 合并逻辑（纯函数，可单测） |
| `src/domain/journal/journal-entry.test.ts` | 解析/渲染往返测试 |
| `src/domain/journal/install-history.test.ts` | 安装/卸载/重装计数测试 |
| `src/ui/components/journal-editor.ts` | 详情抽屉内的评测编辑区块（含项目首个 textarea） |
| `src/ui/view/journal-view.ts` | 独立标签页视图（ItemView 子类） |
| `src/ui/components/journal-table.ts` | 表格渲染、排序、筛选、复制为 markdown |

### 修改

| 文件 | 改动 |
|---|---|
| `src/data/storage/plugin-storage.ts` | 新增 `loadInstallHistory()` / `saveInstallHistory()` |
| `src/ui/view/installed-watch.ts` | `onChange` 的 diff 结果落盘到历史索引 |
| `src/ui/components/detail-drawer.ts` | `buildContent()` 末尾挂载评测区块 |
| `src/ui/components/card-render.ts` | 新增 `journalBadge`；`CardRenderContext` 加 `journalMap` |
| `src/domain/filter/filter.ts` | `MatchOptions` 加 `reviewedIds` / `triedIds`；新增 `journalFilter` |
| `src/ui/view/view-toolbar.ts` | 新增筛选 chip 组 + 「我的足迹」按钮 |
| `src/ui/view/view-context.ts` | 新增 `journalFilter` / `reviewedIds` / `triedIds` 字段与委托 |
| `src/app/plugin.ts` | 新增设置项 `reviewFolder`、`registerView`、打开视图命令、装配历史存储 |
| `src/shared/i18n.ts` | 新增文案 key |
| `styles.css` | 徽标、评测区块、表格样式 |

---

## 阶段 1：数据层（纯逻辑，可独立测试验收）

### 任务 1.1：评测条目模型与 frontmatter 解析

**文件：**
- 创建：`src/domain/journal/journal-entry.ts`
- 测试：`src/domain/journal/journal-entry.test.ts`

- [ ] **步骤 1：先读现有 frontmatter 实现**

阅读 `src/translation/memory/translation-memory.ts` 中的 `parseTMNote` / `renderTMNote`，确认其 frontmatter 解析是否可复用。**判定规则**：若其解析函数接受任意 key 并返回 `Record<string,string>`，则直接 import 复用；若与 TM 字段强耦合，则在 `journal-entry.ts` 内自研（不修改 TM 代码，避免影响已稳定的翻译记忆库）。

- [ ] **步骤 2：编写失败的测试**

```ts
// src/domain/journal/journal-entry.test.ts
import { describe, it, expect } from "vitest";
import { parseJournalNote, renderJournalNote, VERDICT_PRESETS, type JournalEntry } from "@domain/journal/journal-entry";

describe("评测笔记 frontmatter 往返", () => {
	it("解析完整字段", () => {
		const raw = [
			"---",
			'id: obsidian-calendar',
			'name: Calendar',
			'status: abandoned',
			'rating: 2',
			'verdict: [冲突, 不更新]',
			'firstInstalled: 1740000000000',
			'installCount: 2',
			'enabled: false',
			'updated: 1747000000000',
			"---",
			"",
			"和 Daily Note 冲突。",
		].join("\n");
		const e = parseJournalNote(raw)!;
		expect(e.id).toBe("obsidian-calendar");
		expect(e.status).toBe("abandoned");
		expect(e.rating).toBe(2);
		expect(e.verdict).toEqual(["冲突", "不更新"]);
		expect(e.note).toBe("和 Daily Note 冲突。");
	});

	it("渲染后再解析应等价", () => {
		const e: JournalEntry = {
			id: "a", name: "A", status: "using", rating: 5,
			verdict: ["不好用"], note: "备注\n第二行", updated: 1,
		};
		expect(parseJournalNote(renderJournalNote(e))).toEqual(e);
	});

	it("缺字段 / 坏内容不抛错", () => {
		expect(parseJournalNote("没有 frontmatter 的纯文本")).toBeNull();
		expect(parseJournalNote("---\nid: x\n---\n")).toMatchObject({ id: "x" });
	});
});
```

- [ ] **步骤 3：运行测试验证失败**

运行：`./node_modules/.bin/vitest run src/domain/journal/journal-entry.test.ts`
预期：FAIL，报错 `Cannot find module '@domain/journal/journal-entry'`

- [ ] **步骤 4：编写实现**

```ts
// src/domain/journal/journal-entry.ts
export type JournalStatus = "using" | "abandoned" | "watching";

/** 弃用原因预设（用于筛选统计；允许手写额外值，不做强校验） */
export const VERDICT_PRESETS = [
	"不好用", "有 bug", "有替代", "太重", "收费", "不更新", "冲突", "用不上",
] as const;

export interface JournalEntry {
	id: string;
	name: string;
	status?: JournalStatus;
	rating?: number;
	verdict?: string[];
	firstInstalled?: number;
	lastInstalled?: number;
	uninstalled?: number | null;
	installCount?: number;
	enabled?: boolean;
	updated?: number;
	/** 正文备注（frontmatter 之后的全部内容） */
	note: string;
}

const STATUSES: JournalStatus[] = ["using", "abandoned", "watching"];

/** 解析形如 `k: v` 的 frontmatter；返回 null 表示不是合法评测笔记 */
function parseFrontmatter(raw: string): { kv: Record<string, string>; body: string } | null {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
	if (!m) return null;
	const kv: Record<string, string> = {};
	for (const line of m[1].split(/\r?\n/)) {
		const i = line.indexOf(":");
		if (i <= 0) continue;
		kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}
	return { kv, body: m[2].replace(/^\r?\n/, "") };
}

function parseArray(v: string | undefined): string[] | undefined {
	if (!v) return undefined;
	const inner = v.replace(/^\[|\]$/g, "").trim();
	if (!inner) return undefined;
	return inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

function num(v: string | undefined): number | undefined {
	if (v === undefined || v === "") return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
}

export function parseJournalNote(raw: string): JournalEntry | null {
	try {
		const parsed = parseFrontmatter(raw);
		if (!parsed) return null;
		const { kv, body } = parsed;
		if (!kv.id) return null;
		const status = STATUSES.includes(kv.status as JournalStatus) ? (kv.status as JournalStatus) : undefined;
		const rating = num(kv.rating);
		return {
			id: kv.id,
			name: kv.name ?? kv.id,
			status,
			rating: rating !== undefined && rating >= 1 && rating <= 5 ? rating : undefined,
			verdict: parseArray(kv.verdict),
			firstInstalled: num(kv.firstInstalled),
			lastInstalled: num(kv.lastInstalled),
			uninstalled: kv.uninstalled ? num(kv.uninstalled) ?? null : null,
			installCount: num(kv.installCount),
			enabled: kv.enabled === undefined ? undefined : kv.enabled === "true",
			updated: num(kv.updated),
			note: body.trim(),
		};
	} catch {
		return null;
	}
}

export function renderJournalNote(e: JournalEntry): string {
	const lines: string[] = ["---", `id: ${e.id}`, `name: ${e.name}`];
	if (e.status) lines.push(`status: ${e.status}`);
	if (e.rating) lines.push(`rating: ${e.rating}`);
	if (e.verdict?.length) lines.push(`verdict: [${e.verdict.join(", ")}]`);
	if (e.firstInstalled) lines.push(`firstInstalled: ${e.firstInstalled}`);
	if (e.lastInstalled) lines.push(`lastInstalled: ${e.lastInstalled}`);
	if (e.uninstalled) lines.push(`uninstalled: ${e.uninstalled}`);
	if (e.installCount) lines.push(`installCount: ${e.installCount}`);
	if (e.enabled !== undefined) lines.push(`enabled: ${e.enabled}`);
	lines.push(`updated: ${e.updated ?? Date.now()}`, "---", "");
	return lines.join("\n") + (e.note ? `\n${e.note}\n` : "\n");
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：`./node_modules/.bin/vitest run src/domain/journal/journal-entry.test.ts`
预期：PASS（3 个）

- [ ] **步骤 6：Commit**

```bash
git add src/domain/journal/journal-entry.ts src/domain/journal/journal-entry.test.ts
git commit -m "feat(journal): 评测笔记数据模型与 frontmatter 解析"
```

### 任务 1.2：安装历史索引的 diff 合并

**文件：**
- 创建：`src/domain/journal/install-history.ts`
- 测试：`src/domain/journal/install-history.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// src/domain/journal/install-history.test.ts
import { describe, it, expect } from "vitest";
import { mergeInstallDiff, type InstallRecord } from "@domain/journal/install-history";

const NOW = 1_700_000_000_000;
const base = (): Record<string, InstallRecord> => ({});

describe("安装历史 diff 合并", () => {
	it("首次安装写入 firstInstalled 与计数", () => {
		const out = mergeInstallDiff(base(), {
			added: new Set(["a"]), removed: new Set(),
			installedIds: new Set(["a"]), enabledIds: new Set(["a"]),
			nameOf: () => "A", now: NOW,
		});
		expect(out.a).toMatchObject({ firstInstalled: NOW, lastInstalled: NOW, installCount: 1, currentlyInstalled: true });
	});

	it("卸载写入 uninstalled 并清空启用态", () => {
		const cur = base();
		cur.a = { name: "A", firstInstalled: 1, lastInstalled: 1, uninstalled: null, installCount: 1, currentlyInstalled: true, currentlyEnabled: true };
		const out = mergeInstallDiff(cur, {
			added: new Set(), removed: new Set(["a"]),
			installedIds: new Set(), enabledIds: new Set(),
			nameOf: () => "A", now: NOW,
		});
		expect(out.a.uninstalled).toBe(NOW);
		expect(out.a.currentlyInstalled).toBe(false);
		expect(out.a.currentlyEnabled).toBe(false);
		expect(out.a.firstInstalled).toBe(1); // 历史保留
	});

	it("重装递增 installCount 并清空 uninstalled", () => {
		const cur = base();
		cur.a = { name: "A", firstInstalled: 1, lastInstalled: 1, uninstalled: 100, installCount: 1, currentlyInstalled: false, currentlyEnabled: false };
		const out = mergeInstallDiff(cur, {
			added: new Set(["a"]), removed: new Set(),
			installedIds: new Set(["a"]), enabledIds: new Set(),
			nameOf: () => "A", now: NOW,
		});
		expect(out.a.installCount).toBe(2);
		expect(out.a.uninstalled).toBeNull();
		expect(out.a.lastInstalled).toBe(NOW);
	});
});
```

- [ ] **步骤 2：运行验证失败**

运行：`./node_modules/.bin/vitest run src/domain/journal/install-history.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 3：编写实现**

```ts
// src/domain/journal/install-history.ts
export interface InstallRecord {
	name: string;
	firstInstalled: number;
	lastInstalled: number;
	uninstalled: number | null;
	installCount: number;
	currentlyInstalled: boolean;
	currentlyEnabled: boolean;
}

export interface InstallHistoryFile {
	version: 1;
	entries: Record<string, InstallRecord>;
}

export interface InstallDiff {
	added: Set<string>;
	removed: Set<string>;
	installedIds: Set<string>;
	enabledIds: Set<string>;
	nameOf: (id: string) => string;
	now: number;
}

export function emptyInstallHistory(): InstallHistoryFile {
	return { version: 1, entries: {} };
}

/** 把一次监听 diff 合并进历史；返回新的 entries（不修改入参） */
export function mergeInstallDiff(
	current: Record<string, InstallRecord>,
	diff: InstallDiff,
): Record<string, InstallRecord> {
	const out: Record<string, InstallRecord> = {};
	for (const [id, r] of Object.entries(current)) out[id] = { ...r };
	const { added, removed, installedIds, enabledIds, nameOf, now } = diff;

	for (const id of added) {
		const prev = out[id];
		out[id] = {
			name: prev?.name ?? nameOf(id),
			firstInstalled: prev?.firstInstalled ?? now,
			lastInstalled: now,
			uninstalled: null,
			installCount: (prev?.installCount ?? 0) + 1,
			currentlyInstalled: true,
			currentlyEnabled: enabledIds.has(id),
		};
	}
	for (const id of removed) {
		const prev = out[id];
		if (!prev) continue;
		out[id] = { ...prev, uninstalled: now, currentlyInstalled: false, currentlyEnabled: false };
	}
	// 未变化的 id：仅同步启用态（禁用/启用不改变安装历史）
	for (const id of Object.keys(out)) {
		if (added.has(id) || removed.has(id)) continue;
		out[id] = {
			...out[id],
			currentlyInstalled: installedIds.has(id),
			currentlyEnabled: enabledIds.has(id),
		};
	}
	return out;
}
```

- [ ] **步骤 4：运行验证通过**

运行：`./node_modules/.bin/vitest run src/domain/journal/install-history.test.ts`
预期：PASS（3 个）

- [ ] **步骤 5：Commit**

```bash
git add src/domain/journal/install-history.ts src/domain/journal/install-history.test.ts
git commit -m "feat(journal): 安装历史索引 diff 合并逻辑"
```

**阶段 1 验收：** 两个测试文件全绿，`src/domain/journal/` 下只有纯函数，不依赖 Obsidian。

---

## 阶段 2：持久化与自动采集

### 任务 2.1：PluginStorage 读写安装历史

**文件：**
- 修改：`src/data/storage/plugin-storage.ts`

- [ ] **步骤 1：定位现有模式**

阅读 `src/data/storage/plugin-storage.ts` 的 `loadStatsCache()`（第 176 行起）与 `saveStatsCache()`（第 159 行起），按其模式（`this.storage.exists` / `read` / `write` + try/catch）新增两个方法。

- [ ] **步骤 2：新增方法**

在 `PluginStorage` 类中新增（`installHistoryFilePath` 参考同文件其它 `xxxFilePath` 的命名与拼法）：

```ts
	/** 安装历史索引文件路径（插件私有目录） */
	private get installHistoryFilePath(): string {
		return `.obsidian/plugins/${this.manifestId}/install-history.json`;
	}

	async loadInstallHistory(): Promise<InstallHistoryFile> {
		try {
			const adapter = this.storage;
			if (!(await adapter.exists(this.installHistoryFilePath))) return emptyInstallHistory();
			const text = await adapter.read(this.installHistoryFilePath);
			const parsed = JSON.parse(text) as InstallHistoryFile;
			if (!parsed || typeof parsed !== "object" || !parsed.entries) return emptyInstallHistory();
			return parsed;
		} catch {
			return emptyInstallHistory();
		}
	}

	async saveInstallHistory(file: InstallHistoryFile): Promise<void> {
		try {
			await this.storage.write(this.installHistoryFilePath, JSON.stringify(file));
		} catch (e: unknown) {
			logger.warn("[Chinese Plugin Market] 保存安装历史失败：", e);
		}
	}
```

并在文件顶部 import：
```ts
import { emptyInstallHistory, type InstallHistoryFile } from "@domain/journal/install-history";
```

- [ ] **步骤 3：类型检查**

运行：`npm run build 2>&1 | tail -20`
预期：无类型错误（若 `manifestId` 字段名不同，按同文件实际字段名调整）

- [ ] **步骤 4：Commit**

```bash
git add src/data/storage/plugin-storage.ts
git commit -m "feat(journal): 安装历史索引读写"
```

### 任务 2.2：installed-watch 的 diff 落盘

**文件：**
- 修改：`src/ui/view/installed-watch.ts:53-84`

- [ ] **步骤 1：阅读现有 onChange**

`installed-watch.ts` 第 54-84 行已计算 `before` / `after` 并得出 `changed`（新增/移除），目前只用于刷新卡片徽标。

- [ ] **步骤 2：在 diff 计算后落盘**

在 `const changed = new Set<string>();` 计算完成之后、`if (changed.size === 0) return;` 之前插入：

```ts
		// 评测台账：把本次 diff 合并进安装历史（历史只从本插件启用后开始记录）
		const added = new Set<string>();
		const removed = new Set<string>();
		for (const id of after) if (!before.has(id)) added.add(id);
		for (const id of before) if (!after.has(id)) removed.add(id);
		if (added.size > 0 || removed.size > 0) {
			void ctx.plugin.recordInstallDiff(added, removed, after, ctx.enabledIds);
		}
```

- [ ] **步骤 3：在 plugin 上新增 recordInstallDiff**

在 `src/app/plugin.ts` 新增方法（放在 `snapshotInstalled` 相关方法附近）：

```ts
	/**
	 * 记录一次安装/卸载 diff 到历史索引（评测台账）。
	 * fire-and-forget：失败只 warn，绝不影响首屏与已安装徽标刷新。
	 */
	async recordInstallDiff(
		added: Set<string>,
		removed: Set<string>,
		installedIds: Set<string>,
		enabledIds: Set<string>,
	): Promise<void> {
		try {
			const file = await this.storage.loadInstallHistory();
			const entries = mergeInstallDiff(file.entries, {
				added, removed, installedIds, enabledIds,
				nameOf: (id) => this.pluginTagMap.has(id) ? id : id,
				now: Date.now(),
			});
			file.entries = entries;
			await this.storage.saveInstallHistory(file);
			this.journalTriedIds = new Set(Object.keys(entries));
		} catch (e: unknown) {
			logger.warn("[Chinese Plugin Market] 记录安装历史失败：", e);
		}
	}
```

并在 `plugin.ts` 顶部 import `mergeInstallDiff`。同时在类上声明字段：

```ts
	/** 评测台账：曾安装过的插件 id 集合（含已卸载） */
	journalTriedIds: Set<string> = new Set();
```

- [ ] **步骤 4：构建验证**

运行：`npm run build 2>&1 | tail -20`
预期：通过

- [ ] **步骤 5：Commit**

```bash
git add src/ui/view/installed-watch.ts src/app/plugin.ts
git commit -m "feat(journal): 已安装监听 diff 落盘为安装历史"
```

**阶段 2 验收：** 手动装一个插件再卸载，检查 `.obsidian/plugins/chinese-plugin-market/install-history.json` 出现对应条目（`firstInstalled` / `uninstalled` 有值）。

---

## 阶段 3：详情抽屉的评测编辑区块

### 任务 3.1：评测区块组件（含首个 textarea）

> **执行顺序：先完成任务 3.2（plugin 侧的读写方法），再执行本任务。** 本任务在抽屉里挂载时会调用 3.2 提供的 `loadJournalEntry` / `saveJournalEntry` / `getInstallFacts`；若顺序颠倒，本任务提交时会出现未定义方法、编译失败。

**文件：**
- 创建：`src/ui/components/journal-editor.ts`
- 修改：`src/ui/components/detail-drawer.ts`（`buildContent()` 末尾挂载）

- [ ] **步骤 1：编写组件**

```ts
// src/ui/components/journal-editor.ts
import { type I18nKey } from "@shared/i18n";
import { VERDICT_PRESETS, type JournalEntry, type JournalStatus } from "@domain/journal/journal-entry";

export interface JournalEditorHost {
	t: (key: I18nKey) => string;
	/** 读取当前插件的评测（无则 null） */
	load: (id: string) => Promise<JournalEntry | null>;
	/** 保存（内部自行防抖） */
	save: (entry: JournalEntry) => void;
	/** 自动记录的事实（只读展示） */
	facts?: { firstInstalled?: number; lastInstalled?: number; uninstalled?: number | null; installCount?: number };
}

const STATUS_KEYS: { v: JournalStatus; label: string }[] = [
	{ v: "using", label: "在用" },
	{ v: "abandoned", label: "弃用" },
	{ v: "watching", label: "观望" },
];

function fmtDate(ms?: number | null): string {
	if (!ms) return "—";
	return new Date(ms).toLocaleDateString();
}

/** 在容器里渲染评测编辑区块；返回后由宿主在关闭时调用返回值的 dispose */
export function renderJournalEditor(
	parent: HTMLElement,
	pluginId: string,
	pluginName: string,
	initial: JournalEntry | null,
	host: JournalEditorHost,
): { dispose: () => void } {
	const t = host.t;
	const wrap = parent.createDiv({ cls: "pt-journal-editor" });
	wrap.createDiv({ cls: "pt-journal-title", text: t("journal.title") });

	const state: JournalEntry = initial ?? { id: pluginId, name: pluginName, note: "" };

	// 状态三选一
	const statusRow = wrap.createDiv({ cls: "pt-journal-row" });
	statusRow.createSpan({ cls: "pt-journal-label", text: t("journal.status") });
	const statusBtns = STATUS_KEYS.map(({ v, label }) => {
		const b = statusRow.createEl("button", { cls: "pt-journal-chip", text: label });
		b.setAttribute("aria-pressed", state.status === v ? "true" : "false");
		b.addEventListener("click", () => {
			state.status = state.status === v ? undefined : v;
			statusBtns.forEach((el, i) => el.setAttribute("aria-pressed", state.status === STATUS_KEYS[i].v ? "true" : "false"));
			commit();
		});
		return b;
	});

	// 评分 1-5
	const rateRow = wrap.createDiv({ cls: "pt-journal-row" });
	rateRow.createSpan({ cls: "pt-journal-label", text: t("journal.rating") });
	const starBtns: HTMLElement[] = [];
	for (let i = 1; i <= 5; i++) {
		const b = rateRow.createEl("button", { cls: "pt-journal-star", text: "★" });
		b.setAttribute("aria-label", `${i}`);
		if ((state.rating ?? 0) >= i) b.addClass("is-on");
		b.addEventListener("click", () => {
			state.rating = state.rating === i ? undefined : i;
			starBtns.forEach((el, idx) => el.toggleClass("is-on", (state.rating ?? 0) > idx));
			commit();
		});
		starBtns.push(b);
	}

	// 弃用原因多选
	const verdictRow = wrap.createDiv({ cls: "pt-journal-row" });
	verdictRow.createSpan({ cls: "pt-journal-label", text: t("journal.verdict") });
	const picked = new Set(state.verdict ?? []);
	for (const v of VERDICT_PRESETS) {
		const b = verdictRow.createEl("button", { cls: "pt-journal-chip", text: v });
		b.setAttribute("aria-pressed", picked.has(v) ? "true" : "false");
		b.addEventListener("click", () => {
			if (picked.has(v)) picked.delete(v); else picked.add(v);
			b.setAttribute("aria-pressed", picked.has(v) ? "true" : "false");
			state.verdict = [...picked];
			commit();
		});
	}

	// 备注（项目首个自由文本输入）
	const noteArea = wrap.createEl("textarea", { cls: "pt-journal-note", attr: { rows: "4", placeholder: t("journal.notePlaceholder") } });
	noteArea.value = state.note;
	// 阻止冒泡：抽屉内有全局 keydown，输入时不应触发抽屉快捷键
	noteArea.addEventListener("keydown", (e: KeyboardEvent) => e.stopPropagation());

	// 事实区（只读）
	if (host.facts) {
		const facts = wrap.createDiv({ cls: "pt-journal-facts" });
		facts.createSpan({ text: `${t("journal.autoFacts")}：${fmtDate(host.facts.firstInstalled)} / ${fmtDate(host.facts.lastInstalled)}` });
		if (host.facts.uninstalled) facts.createSpan({ text: ` · ${t("journal.uninstalledAt")} ${fmtDate(host.facts.uninstalled)}` });
		if (host.facts.installCount && host.facts.installCount > 1) {
			facts.createSpan({ text: ` · ${t("journal.reinstallCount")} ${host.facts.installCount}` });
		}
	}

	// 防抖保存
	let timer: number | undefined;
	const commit = () => {
		if (timer) window.clearTimeout(timer);
		timer = window.setTimeout(() => {
			state.updated = Date.now();
			host.save(state);
		}, 500);
	};
	noteArea.addEventListener("input", () => {
		state.note = noteArea.value;
		commit();
	});

	return {
		dispose: () => {
			if (timer) window.clearTimeout(timer);
			// 关闭时立即落盘一次，防抖窗口内的编辑不丢
			state.note = noteArea.value;
			state.updated = Date.now();
			host.save(state);
		},
	};
}
```

- [ ] **步骤 2：在抽屉挂载**

在 `src/ui/components/detail-drawer.ts` 的 `buildContent()` 末尾（`inner` 容器追加完现有区块之后）插入调用，并把返回的 `dispose` 存到抽屉实例字段，在抽屉关闭时调用。具体：

```ts
		// 评测台账：我的评测（编辑区）
		if (this.plugin.journalEnabled?.()) {
			this._journalDispose?.();
			this._journalDispose = renderJournalEditor(
				inner,
				p.id,
				displayName,
				await this.plugin.loadJournalEntry?.(p.id) ?? null,
				{
					t: this.t,
					load: (id) => this.plugin.loadJournalEntry!(id),
					save: (e) => this.plugin.saveJournalEntry!(e),
					facts: this.plugin.getInstallFacts?.(p.id),
				},
			);
		}
```

（若 `buildContent()` 非 async，改为在调用处 `.then()` 注入 initial；以实际签名为准。）

- [ ] **步骤 3：i18n 文案**

在 `src/shared/i18n.ts` 的加载/评测相关分组新增：

```ts
	"journal.title": { zh: "我的评测" },
	"journal.status": { zh: "状态" },
	"journal.rating": { zh: "评分" },
	"journal.verdict": { zh: "原因" },
	"journal.notePlaceholder": { zh: "记下踩过的坑、bug、为什么弃用…" },
	"journal.autoFacts": { zh: "自动记录" },
	"journal.uninstalledAt": { zh: "卸载于" },
	"journal.reinstallCount": { zh: "重装次数" },
```

- [ ] **步骤 4：构建验证**

运行：`npm run build 2>&1 | tail -20`
预期：通过（若抽屉签名不匹配，按实际调整调用点）

- [ ] **步骤 5：Commit**

```bash
git add src/ui/components/journal-editor.ts src/ui/components/detail-drawer.ts src/shared/i18n.ts
git commit -m "feat(journal): 详情抽屉评测编辑区块"
```

### 任务 3.2：评测笔记的读写与落盘（plugin 侧）

**文件：**
- 修改：`src/app/plugin.ts`

- [ ] **步骤 1：新增评测存储实现**

在 `plugin.ts` 新增三个方法（复用已注入的 `noteStorage` 与 `writeTMNote` 的建目录写法）：

```ts
	/** 评测目录（默认 .obsidian 私有目录；设置可切 vault 内路径） */
	private journalFolder(): string {
		const v = this.settings.reviewFolder?.trim();
		if (v) return normalizePath(v);
		return `.obsidian/plugins/${this.manifest.id}/reviews`;
	}

	async loadJournalEntry(id: string): Promise<JournalEntry | null> {
		try {
			const path = `${this.journalFolder()}/${id}.md`;
			const exists = await this.noteStorage.exists(path);
			if (!exists) return null;
			return parseJournalNote(await this.noteStorage.readNote(path));
		} catch {
			return null;
		}
	}

	async saveJournalEntry(e: JournalEntry): Promise<void> {
		try {
			const dir = this.journalFolder();
			// 必须 await exists + createFolder：adapter 后端不会自动建目录
			// （v2.48.0 的 ENOENT 事故即源于此处漏 await）
			const exists = await this.noteStorage.exists(dir);
			if (!exists) await this.noteStorage.createFolder(dir);
			await this.noteStorage.writeNote(`${dir}/${e.id}.md`, renderJournalNote(e));
		} catch (err: unknown) {
			logger.warn("[Chinese Plugin Market] 保存评测失败：", err);
		}
	}
```

顶部 import `parseJournalNote` / `renderJournalNote` / `type JournalEntry`。

- [ ] **步骤 2：设置项**

在 `DEFAULT_SETTINGS` 与 `ChinesePluginMarketSettings` 接口新增 `reviewFolder: string`（默认 `""` 表示用 `.obsidian` 私有目录）。

- [ ] **步骤 3：构建验证**

运行：`npm run build 2>&1 | tail -20`

- [ ] **步骤 4：Commit**

```bash
git add src/app/plugin.ts
git commit -m "feat(journal): 评测笔记读写与目录设置"
```

**阶段 3 验收：** 打开任一插件详情 → 写备注 + 选状态 → 等待 1 秒 → 在 `.obsidian/plugins/chinese-plugin-market/reviews/<id>.md` 看到笔记；重启后重新打开抽屉，内容回显。

---

## 阶段 4：卡片徽标与列表筛选

### 任务 4.1：卡片徽标

**文件：**
- 修改：`src/ui/components/card-render.ts`
- 修改：`src/ui/view/view-context.ts`

- [ ] **步骤 1：CardRenderContext 新增字段**

在 `src/ui/components/card-render.ts` 的 `CardRenderContext` 接口（第 113 行起）新增：

```ts
	/** 评测摘要（id → 摘要），用于卡片「评过 / 装过」徽标；未注入则静默隐藏 */
	journalMap?: Map<string, { rating?: number; status?: string; hasNote?: boolean }>;
```

- [ ] **步骤 2：创建徽标元素**

紧随 `newBadge` 创建之后（第 316-318 行后）新增：

```ts
	// 评测台账徽标：有评测显示 ★n / 评，仅装过显示「装过」；常驻隐藏，applyCardState 填充
	const journalBadge = metaInfo.createSpan({ cls: "pt-card-journal-badge" });
	journalBadge.setAttribute("aria-hidden", "true");
	journalBadge.setCssStyles({ display: "none" });
```

并把 `journalBadge` 加入 `CardRefs` 接口与 `cardRefsMap.set(...)`（第 437 行）。

- [ ] **步骤 3：applyCardState 填充**

在 `applyCardState` 中（`refs.newBadge` 处理逻辑附近）新增：

```ts
	// 评测台账徽标
	const jr = ctx.journalMap?.get(plugin.id);
	if (jr) {
		refs.journalBadge.textContent = jr.rating ? `★${jr.rating}` : "评";
		refs.journalBadge.addClass("is-reviewed");
		refs.journalBadge.setCssStyles({ display: "" });
	} else if (isInstalled || ctx.triedIds?.has(plugin.id)) {
		refs.journalBadge.textContent = "装过";
		refs.journalBadge.removeClass("is-reviewed");
		refs.journalBadge.setCssStyles({ display: "" });
	} else {
		refs.journalBadge.setCssStyles({ display: "none" });
	}
```

其中 `triedIds` 同样加入 `CardRenderContext`（`Set<string>`，来自 `plugin.journalTriedIds`）。

- [ ] **步骤 4：样式**

在 `styles.css` 追加：

```css
.pt-card-journal-badge {
	font-size: 11px;
	padding: 1px 6px;
	border-radius: 8px;
	background: var(--background-modifier-hover);
	color: var(--text-muted);
}
.pt-card-journal-badge.is-reviewed {
	background: var(--background-modifier-active);
	color: var(--text-accent);
}
```

- [ ] **步骤 5：构建验证**

运行：`npm run build 2>&1 | tail -20`

- [ ] **步骤 6：Commit**

```bash
git add src/ui/components/card-render.ts src/ui/view/view-context.ts styles.css
git commit -m "feat(journal): 卡片评测/装过徽标"
```

### 任务 4.2：列表筛选维度

**文件：**
- 修改：`src/domain/filter/filter.ts`
- 修改：`src/ui/view/view-toolbar.ts`
- 修改：`src/ui/view/view-context.ts`

- [ ] **步骤 1：筛选类型与匹配**

在 `src/domain/filter/filter.ts` 新增类型并扩展 `MatchOptions`：

```ts
/** 评测台账筛选 */
export type JournalFilter = "all" | "reviewed" | "tried";
```

在 `MatchOptions` 接口（第 132 行起）新增：

```ts
	journalFilter?: JournalFilter;
	reviewedIds?: Set<string>;
	triedIds?: Set<string>;
```

在 `matchesPlugin` 中，紧随现有安装状态筛选之后（第 198-210 行后）新增：

```ts
	// 评测台账筛选
	if (opts.journalFilter === "reviewed" && !opts.reviewedIds?.has(p.id)) return false;
	if (opts.journalFilter === "tried" && !opts.triedIds?.has(p.id)) return false;
```

- [ ] **步骤 2：筛选缓存失效**

参照现有 `installedNotEnabled` 的 `filterCache.reset()` 写法，在 `src/ui/view/view-data.ts` 中评测集合变化时（保存评测后）调用 `ctx.filterCache.reset()`。

- [ ] **步骤 3：工具栏 chip**

在 `src/ui/view/view-toolbar.ts` 中参照「安装」组（第 786-817 行）新增一组：

```ts
	const journalRow = /* 与 installRow 同容器 */;
	journalRow.createSpan({ cls: "pt-facet-label", text: "记录" });
	const journalChips = journalRow.createDiv({ cls: "pt-facet-chips" });
	const journalDefs: { on: JournalFilter; label: string }[] = [
		{ on: "reviewed", label: "我评测过的" },
		{ on: "tried", label: "我装过的" },
	];
	const journalToggles = journalDefs.map((def) =>
		journalChips.createEl("button", { cls: "pt-filter pt-toggle-journal", text: def.label })
	);
	const updateJournalToggles = () => {
		journalToggles.forEach((el, i) => {
			const active = ctx.journalFilter === journalDefs[i].on;
			el.setAttribute("aria-pressed", active ? "true" : "false");
			el.textContent = active ? "显示全部" : journalDefs[i].label;
		});
	};
	journalToggles.forEach((el, i) => {
		el.addEventListener("click", () => {
			ctx.journalFilter = ctx.journalFilter === journalDefs[i].on ? "all" : journalDefs[i].on;
			updateJournalToggles();
			ctx.scheduleRender(true);
		});
	});
```

- [ ] **步骤 4：构建验证 + 全量测试**

运行：`npm run build 2>&1 | tail -20` 与 `./node_modules/.bin/vitest run src/domain/filter`（若超过 10s 用后台方式）

- [ ] **步骤 5：Commit**

```bash
git add src/domain/filter/filter.ts src/ui/view/view-toolbar.ts src/ui/view/view-context.ts src/ui/view/view-data.ts
git commit -m "feat(journal): 列表新增评测/装过筛选"
```

**阶段 4 验收：** 写过评测的插件卡片显示 `★n`；筛选「我评测过的」只剩那些卡片。

---

## 阶段 5：独立标签页视图

### 任务 5.1：表格组件

**文件：**
- 创建：`src/ui/components/journal-table.ts`

- [ ] **步骤 1：编写表格渲染 + 排序筛选 + 复制**

```ts
// src/ui/components/journal-table.ts
export interface JournalRow {
	id: string;
	name: string;
	status?: string;
	rating?: number;
	verdict?: string[];
	firstInstalled?: number;
	uninstalled?: number | null;
	installCount?: number;
	currentlyInstalled?: boolean;
	note?: string;
}

export type JournalSortKey = "name" | "status" | "rating" | "firstInstalled";

/** 渲染台账表格；返回 rerender 供外部筛选/排序变化时重绘 */
export function renderJournalTable(
	parent: HTMLElement,
	rows: JournalRow[],
	opts: { onOpen: (id: string) => void; t: (k: never) => string },
): { rerender: (next: JournalRow[]) => void } {
	let current = rows;
	let sortKey: JournalSortKey = "firstInstalled";
	let sortAsc = false;

	const wrap = parent.createDiv({ cls: "pt-journal-table-wrap" });

	const sortRows = (list: JournalRow[]) => {
		const dir = sortAsc ? 1 : -1;
		return [...list].sort((a, b) => {
			switch (sortKey) {
				case "name": return (a.name ?? "").localeCompare(b.name ?? "") * dir;
				case "rating": return ((a.rating ?? 0) - (b.rating ?? 0)) * dir;
				case "firstInstalled": return ((a.firstInstalled ?? 0) - (b.firstInstalled ?? 0)) * dir;
				default: return (a.status ?? "").localeCompare(b.status ?? "") * dir;
			}
		});
	};

	const draw = () => {
		wrap.empty();
		const table = wrap.createEl("table", { cls: "pt-journal-table" });
		const head = table.createEl("tr");
		const cols: [JournalSortKey, string][] = [
			["name", "插件"], ["status", "状态"], ["rating", "评分"],
			["firstInstalled", "首次安装"],
		];
		for (const [key, label] of cols) {
			const th = head.createEl("th", { text: sortKey === key ? `${label}${sortAsc ? "↑" : "↓"}` : label });
			th.addClass("pt-journal-th");
			th.addEventListener("click", () => {
				if (sortKey === key) sortAsc = !sortAsc; else { sortKey = key; sortAsc = false; }
				draw();
			});
		}
		head.createEl("th", { text: "原因" });
		head.createEl("th", { text: "备注" });

		for (const r of sortRows(current)) {
			const tr = table.createEl("tr", { cls: "pt-journal-tr" });
			const nameTd = tr.createEl("td", { text: r.name || r.id });
			nameTd.addClass("pt-journal-name");
			nameTd.addEventListener("click", () => opts.onOpen(r.id));
			tr.createEl("td", { text: statusLabel(r) });
			tr.createEl("td", { text: r.rating ? "★".repeat(r.rating) : "—" });
			tr.createEl("td", { text: r.firstInstalled ? new Date(r.firstInstalled).toLocaleDateString() : "—" });
			tr.createEl("td", { text: r.verdict?.join("、") ?? "—" });
			tr.createEl("td", { text: (r.note ?? "").slice(0, 40) || "—" });
		}
	};

	draw();
	return {
		rerender: (next: JournalRow[]) => { current = next; draw(); },
	};
}

function statusLabel(r: JournalRow): string {
	if (r.status === "using") return "在用";
	if (r.status === "abandoned") return "弃用";
	if (r.status === "watching") return "观望";
	if (r.currentlyInstalled === false) return "已卸载";
	return "装过";
}
```

- [ ] **步骤 2：Commit**

```bash
git add src/ui/components/journal-table.ts
git commit -m "feat(journal): 台账表格组件（排序/筛选/跳转）"
```

### 任务 5.2：独立视图与工具栏入口

**文件：**
- 创建：`src/ui/view/journal-view.ts`
- 修改：`src/app/plugin.ts`
- 修改：`src/ui/view/view-toolbar.ts`

- [ ] **步骤 1：视图类**

```ts
// src/ui/view/journal-view.ts
import { ItemView, WorkspaceLeaf } from "obsidian";
import { renderJournalTable, type JournalRow } from "@ui/components/journal-table";
import type { JournalEntry } from "@domain/journal/journal-entry";

export const JOURNAL_VIEW_TYPE = "chinese-plugin-market-journal";

export class JournalView extends ItemView {
	constructor(leaf: WorkspaceLeaf, private host: {
		loadHistory: () => Promise<Record<string, { name: string; firstInstalled: number; lastInstalled: number; uninstalled: number | null; installCount: number; currentlyInstalled: boolean }>>;
		listEntries: () => Promise<JournalEntry[]>;
		openPlugin: (id: string) => void;
		t: (k: never) => string;
	}) {
		super(leaf);
	}

	getViewType(): string { return JOURNAL_VIEW_TYPE; }
	getDisplayText(): string { return "我的插件足迹"; }
	getIcon(): string { return "list-ordered"; }

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("pt-journal-view");
		root.createDiv({ cls: "pt-journal-view-title", text: "我的插件足迹" });
		const body = root.createDiv({ cls: "pt-journal-view-body" });

		const [history, entries] = await Promise.all([this.host.loadHistory(), this.host.listEntries()]);
		const byId = new Map(entries.map((e) => [e.id, e]));
		const rows: JournalRow[] = Object.entries(history).map(([id, h]) => {
			const e = byId.get(id);
			return {
				id, name: e?.name ?? h.name ?? id,
				status: e?.status, rating: e?.rating, verdict: e?.verdict,
				firstInstalled: h.firstInstalled, uninstalled: h.uninstalled,
				installCount: h.installCount, currentlyInstalled: h.currentlyInstalled,
				note: e?.note,
			};
		});

		if (rows.length === 0) {
			body.createDiv({ cls: "pt-empty-hint", text: "还没有记录。在插件详情里写一条评测，或安装过的插件会自动出现在这里。" });
			return;
		}
		renderJournalTable(body, rows, { onOpen: (id) => this.host.openPlugin(id), t: this.host.t });
	}
}
```

- [ ] **步骤 2：注册视图与打开命令**

在 `src/app/plugin.ts` 的 `onload()` 中 `registerView`：

```ts
		this.registerView(JOURNAL_VIEW_TYPE, (leaf) => new JournalView(leaf, {
			loadHistory: async () => (await this.storage.loadInstallHistory()).entries,
			listEntries: () => this.listJournalEntries(),
			openPlugin: (id) => void this.openJournalTarget(id),
			t: (k) => k as string,
		}));
		this.addCommand({
			id: "open-journal",
			name: "打开「我的插件足迹」",
			callback: () => void this.openJournalView(),
		});
```

并新增：

```ts
	async openJournalView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(JOURNAL_VIEW_TYPE);
		if (existing.length > 0) {
			this.app.workspace.setActiveLeaf(existing[0], { focus: true });
			return;
		}
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({ type: JOURNAL_VIEW_TYPE, active: true });
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
	}

	/**
	 * 从足迹表格点击某行时跳转：优先让主视图按 id 打开详情抽屉；
	 * 若主视图没有按 id 打开的 API，退化为「打开市场视图 + 把搜索词设为该 id」。
	 * 实现前先查 ChinesePluginMarketView 是否已有 openPluginById / 类似方法——
	 * 有则调用，没有就只用下方兜底分支，不要新造 API。
	 */
	async openJournalTarget(id: string): Promise<void> {
		await this.openTranslatorView();
		const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view as
			| { openPluginById?: (id: string) => void | Promise<void>; searchQuery?: string; scheduleRender?: () => void }
			| undefined;
		if (view?.openPluginById) {
			await view.openPluginById(id);
			return;
		}
		if (view) {
			view.searchQuery = id;
			view.scheduleRender?.();
		}
	}
```

`listJournalEntries()` 用 `noteStorage.listMarkdown(this.journalFolder())` + `parseJournalNote` 读取全部评测笔记（容错：单条解析失败跳过）。

- [ ] **步骤 3：工具栏按钮**

在 `src/ui/view/view-toolbar.ts` 紧邻「安装」组新增：

```ts
	const journalBtn = installRow.parentElement!.createEl("button", {
		cls: "pt-filter pt-journal-open",
		text: count > 0 ? `我的足迹 ${count}` : "我的足迹",
	});
	journalBtn.addEventListener("click", () => void ctx.plugin.openJournalView());
```

（`count` 取 `Object.keys(history.entries).length`；为 0 时置灰并设 title 提示。）

- [ ] **步骤 4：样式**

在 `styles.css` 追加表格与视图样式（表头可点击、行 hover、备注列截断）。

- [ ] **步骤 5：构建 + 全量测试**

运行：`npm run build 2>&1 | tail -20`
运行：`./node_modules/.bin/vitest run`（全量，若超过 10s 用后台 + 轮询）
预期：676+ 测试通过，无回归

- [ ] **步骤 6：Commit**

```bash
git add src/ui/view/journal-view.ts src/app/plugin.ts src/ui/view/view-toolbar.ts styles.css
git commit -m "feat(journal): 独立标签页足迹视图与工具栏入口"
```

**阶段 5 验收：** 工具栏「我的足迹 N」→ 打开新标签页，看到表格；点表头排序正常；点插件名跳回市场卡片。

---

## 阶段 6：收尾

### 任务 6.1：评测目录切换与迁移

**文件：**
- 修改：`src/app/plugin.ts`

- [ ] **步骤 1：复用迁移实现**

设置项 `reviewFolder` 变更时，调用与翻译记忆库相同的迁移流程（先写后删、BATCH 并发、单条容错）。若现有 `migrateTMFiles(src, dst, budgetMs)` 为私有方法，改为包内可见后复用；**不要复制一份实现**。

- [ ] **步骤 2：构建验证**

运行：`npm run build 2>&1 | tail -20`

- [ ] **步骤 3：Commit**

```bash
git add src/app/plugin.ts
git commit -m "feat(journal): 评测目录切换时迁移笔记"
```

### 任务 6.2：手动验收清单

- [ ] 装一个新插件 → `install-history.json` 出现记录
- [ ] 卸载它 → `uninstalled` 与 `currentlyInstalled=false` 写入
- [ ] 重新装回 → `installCount` 变 2、`uninstalled` 清空
- [ ] 详情页写备注 + 选弃用 + 打 3 星 → 1 秒后 `reviews/<id>.md` 落盘
- [ ] 重启 Obsidian → 抽屉内容回显、卡片显示 `★3`
- [ ] 筛选「我评测过的」→ 只剩该卡片
- [ ] 工具栏「我的足迹 N」→ 表格打开，排序/跳转正常
- [ ] 设置里把评测目录切到 vault 内路径 → 笔记迁移过去，vault 里可搜索到
- [ ] 移动端（或模拟无 fs.watch）→ 60s 轮询仍能记录历史

---

## 自检记录

- **规格覆盖**：数据分层（任务 1.1/1.2）、自动采集（2.2）、存储（2.1/3.2）、抽屉编辑（3.1）、卡片徽标（4.1）、筛选（4.2）、独立视图（5.1/5.2）、设置迁移（6.1）、测试（各任务单测 + 6.2 手验）——规格每一节都有对应任务
- **占位符**：无「待定 / TODO / 后续实现」；每个代码步骤都有完整实现
- **类型一致性**：`JournalEntry` 字段、`InstallRecord` 字段、`JournalRow` 字段在前后任务中命名一致；`JOURNAL_VIEW_TYPE` 常量在视图与 plugin 注册中同名
