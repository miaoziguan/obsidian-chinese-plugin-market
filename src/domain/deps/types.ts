/**
 * 插件依赖的数据模型。
 *
 * 关系方向约定（别搞反）：
 * - `DepEdge` 是**正向**：「插件 X 依赖谁」，存在 `edges[X]`
 * - `DependentRef` 是**反向**：「谁依赖插件 X」，由 DepGraph 从正向边现算，不落盘
 */

/** required = 不装跑不起来；optional = 装了才能用某某功能 */
export type DepKind = "required" | "optional";

/** 证据来源（决定置信度与 UI 是否标「可能」） */
export type DepSource = "curated" | "manifest" | "mainjs" | "readme";

/** 依赖的当前状态（判定顺序见 DepGraph.statusOf） */
export type DepStatus = "ok" | "missing" | "disabled" | "outdated" | "unknown";

export interface DepEdge {
	/** 依赖目标的插件 id（官方社区列表的 id） */
	id: string;
	/** 目标显示名快照：目标插件下架 / 改名时仍能显示，不因列表变化而变空 */
	name: string;
	kind: DepKind;
	/** 最低版本要求（可缺） */
	minVersion?: string;
	source: DepSource;
	/** 0~1；curated 恒为 1；UI 仅对 <0.85 标「可能」（即 README 推断的那批） */
	confidence: number;
}

/** 反向关系：谁依赖我 */
export interface DependentRef {
	id: string;
	/** 依赖方的插件 id；展示名由宿主按官方列表解析（数据文件里不带全量名字） */
	name: string;
	kind: DepKind;
}

export interface PluginDepsFile {
	version: 1;
	/** 生成时间（ISO），仅排障用 */
	generatedAt: string;
	/** 正向索引：插件 id → 它的依赖列表 */
	edges: Record<string, DepEdge[]>;
}

/** 状态判定输入（全部由视图层提供，DepGraph 不碰 Obsidian API，便于单测） */
export interface DepStatusInput {
	installedIds: Set<string>;
	enabledIds: Set<string>;
	installedVersions: Map<string, string>;
	/** 官方社区列表的插件 id 集合；不在其中则无法给出安装入口（状态为 unknown） */
	knownIds: Set<string>;
}
