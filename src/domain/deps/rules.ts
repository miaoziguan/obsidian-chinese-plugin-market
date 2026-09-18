/**
 * 依赖自动检测规则表。
 *
 * 这是**唯一真相源**：运行时按需检测直接用它；离线生成脚本用 esbuild 把它打成
 * ESM 后 import（见 scripts/esbuild-load.mjs），杜绝两份正则各自漂移。
 *
 * 阈值纪律（误报比漏报贵：一条错误的「必需」会直接劝退用户安装）：
 * - < DROP_BELOW        丢弃
 * - [DROP_BELOW, REQUIRED_MIN)  强制降为 optional
 * - >= REQUIRED_MIN     才可为 required
 */

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
	{ pattern: "needs?\\s+{{DEP}}", source: "readme", confidence: 0.7, kind: "required" },
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

/**
 * 低于此置信度直接丢弃。
 * 取值 0.3 而非 0.4：弱措辞（0.35）必须存活下来降级为 optional —— 它们既是
 * 「可选联动」的信息来源，也是离线生成时给人工抽查的候选素材；只有真正的
 * 无意义命中（<0.3，目前不存在）才丢弃。
 */
export const DROP_BELOW = 0.3;
/** 达到此置信度才允许是 required */
export const REQUIRED_MIN = 0.7;
/** UI 标「可能」的阈值（README 推断的那批） */
export const MAYBE_BELOW = 0.85;

/** 各来源的置信度常量（detect.ts 与测试共用，避免魔法数字散落） */
export const CONFIDENCE = {
	manifest: 0.9,
	mainjs: 0.85,
	curated: 1,
} as const;

/** 把规则模板编译成针对某个目标的正则（大小写不敏感） */
export function compileRule(pattern: string, target: string): RegExp {
	const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(pattern.replace("{{DEP}}", escaped).replace("{{ID}}", escaped), "i");
}
