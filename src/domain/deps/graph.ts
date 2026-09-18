import { compareVersion } from "@shared/version";
import type {
	DepEdge,
	DepKind,
	DependentRef,
	DepStatus,
	DepStatusInput,
	PluginDepsFile,
} from "./types";

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

/** 一条「没到位」的必需依赖（卡片徽标与安装后检查共用同一份结果） */
export interface BlockingDep {
	dep: DepEdge;
	status: DepStatus;
}

/**
 * 依赖图：正向边 + 反向索引 + 状态判定。
 *
 * 设计意图：
 * - 不碰 Obsidian API（状态判定所需集合全部由调用方传入），因此可以纯单测；
 * - 数据文件任何不合法都解析为 null，由调用方静默降级——依赖是「锦上添花」，
 *   绝不能因为一份脏数据影响市场本身；
 * - 运行时按需检测的结果只写进内存层（merge），不回写随包基线，保持基线干净。
 */
export class DepGraph {
	/** 随包基线（加载后视为不可变） */
	private edges: Record<string, DepEdge[]> = {};
	/** 反向索引：depId → 依赖它的插件 */
	private dependents = new Map<string, DependentRef[]>();
	/** 运行时按需检测补充（会话内有效，不落盘） */
	private runtime = new Map<string, DepEdge[]>();

	constructor(file: PluginDepsFile | null = null) {
		if (file) this.load(file);
	}

	/** 解析随包 JSON；坏 JSON / schema 不匹配 / 缺字段一律返回 null */
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

		const rev = new Map<string, DependentRef[]>();
		for (const [id, list] of Object.entries(clean)) {
			for (const e of list) {
				const arr = rev.get(e.id) ?? [];
				// 同一对关系只保留一条（required 优先于 optional）
				const exist = arr.findIndex((x) => x.id === id);
				if (exist >= 0) {
					if (e.kind === "required") arr[exist] = { id, name: id, kind: "required" };
					continue;
				}
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

	/**
	 * 判定一条依赖是否到位。顺序有讲究：
	 * unknown 优先于 missing ——「不在官方列表」意味着我们无法引导安装，
	 * 此时说「未安装」是误导（它可能是直链装的），只显示名字不给按钮。
	 */
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

	/** 未满足的必需依赖（按 missing/disabled/outdated 的严重度隐含顺序保留原始顺序） */
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
