import type { DepEdge, DepKind, DepSource } from "./types";
import {
	CONFIDENCE,
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
	/** manifest.dependencies（对象或数组，社区里两种写法都有） */
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
	if (v && typeof v === "object") return Object.keys(v);
	return [];
}

/** 把 ">=0.5.0" / "^1.2.0" / "0.5.0" 归一成 "0.5.0"；取不到返回 undefined */
function normalizeMinVersion(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const m = /(\d+(?:\.\d+)*)/.exec(raw);
	return m?.[1];
}

/**
 * 从 manifest / main.js / README 推断一个插件依赖谁。
 *
 * 纯函数：不碰网络、不碰 Obsidian API，便于单测，也便于生成脚本与运行时共用。
 * 同一个目标只保留置信度最高的一条证据。
 */
export function detectDeps(input: DetectInput): DepEdge[] {
	const { selfId, dict } = input;
	const readme = input.readme ?? "";
	const mainJs = input.mainJs ?? "";
	const declared = new Set(depKeys(input.manifestDeps));
	const depsObj = input.manifestDeps as Record<string, unknown> | undefined;

	const out: DepEdge[] = [];
	for (const c of dict) {
		if (c.id === selfId) continue; // 自依赖无意义

		let best: Hit | null = null;
		const consider = (h: Hit) => {
			if (!best || h.confidence > best.confidence) best = h;
		};

		// 1) manifest 显式声明（最强）
		if (declared.has(c.id) || declared.has(c.name)) {
			consider({
				source: "manifest",
				confidence: CONFIDENCE.manifest,
				kind: "required",
				minVersion: normalizeMinVersion(depsObj?.[c.id] ?? depsObj?.[c.name]),
			});
		}

		// 2) main.js 真的在调用目标插件
		if (MAINJS_PATTERNS.some((p) => compileRule(p, c.id).test(mainJs))) {
			consider({ source: "mainjs", confidence: CONFIDENCE.mainjs, kind: "required" });
		}

		// 3) README 措辞（强 → 必需候选；弱 → 可选）
		const names = [c.name, ...(c.aliases ?? [])].filter(Boolean);
		for (const n of names) {
			for (const r of README_STRONG) {
				if (!compileRule(r.pattern, n).test(readme)) continue;
				// 顺带抓「requires Dataview 0.5.0」这种带版本号的写法
				const withVer = new RegExp(`${r.pattern.replace("{{DEP}}", "([0-9][0-9.]*)")}`, "i").exec(readme);
				consider({
					source: r.source,
					confidence: r.confidence,
					kind: r.kind,
					minVersion: withVer?.[1],
				});
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
		// 置信度不足的一律降为 optional：宁可少报必需，不可误报必需
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
