/**
 * 插件功能洞察缓存
 *
 * 从 translator.ts 抽出的独立小块（P2-7 续）：
 * 封装 AI 生成的「插件功能概述（pluginInsights）」与「多插件深度对比（compareInsights）」
 * 两套按 key 索引的缓存。两者都带 schema 版本号，旧版（含最初纯 string 格式）一律丢弃重算。
 *
 * 该模块与翻译管线、TM、aiDict 完全解耦，仅被 Translator 持有并转发，外部 API 不变。
 */

/** 洞察数据源 schema 版本；数据源变化（如新增 main.js/README）须 bump，使旧缓存失效重算 */
export const INSIGHT_SCHEMA_VERSION = 2;

/** 缓存的洞察条目（带 schema 版本，避免新旧数据源的概述混用） */
export interface InsightEntry {
	v: number;
	text: string;
}

/** 可被持久化的原始数据（loadData 入参的子集） */
export interface InsightRawData {
	pluginInsights?: Record<string, InsightEntry>;
	compareInsights?: Record<string, InsightEntry>;
}

/** 导出给持久化的结构 */
export interface InsightExport {
	pluginInsights: Record<string, InsightEntry>;
	compareInsights: Record<string, InsightEntry>;
}

/** 单条洞察的 schema 校验：仅接纳当前版本且 text 为 string 的条目 */
function isValidEntry(e: unknown): e is InsightEntry {
	return (
		!!e &&
		typeof e === "object" &&
		(e as InsightEntry).v === INSIGHT_SCHEMA_VERSION &&
		typeof (e as InsightEntry).text === "string"
	);
}

/**
 * 洞察缓存。Translator 持有单一实例，原 pluginInsights/compareInsights 字段与读写方法
 * 改为委托本类，对外暴露的方法签名保持不变。
 */
export class InsightCache {
	/** 插件功能洞察（AI 基于仓库 manifest + main.js + README 综合生成的中文概述，按插件 id 索引） */
	private pluginInsights: Record<string, InsightEntry> = {};
	/** 插件对比深度分析（AI 基于多插件真实信号生成，按插件 id 排序集合索引） */
	private compareInsights: Record<string, InsightEntry> = {};

	/** 从持久化恢复；只接纳当前 schema 版本的条目，旧版一律丢弃重算 */
	load(raw: InsightRawData): void {
		if (raw.pluginInsights) {
			const next: Record<string, InsightEntry> = {};
			for (const [pid, entry] of Object.entries(raw.pluginInsights)) {
				if (isValidEntry(entry)) next[pid] = entry;
			}
			this.pluginInsights = next;
		}
		if (raw.compareInsights) {
			const nextC: Record<string, InsightEntry> = {};
			for (const [key, entry] of Object.entries(raw.compareInsights)) {
				if (isValidEntry(entry)) nextC[key] = entry;
			}
			this.compareInsights = nextC;
		}
	}

	/** 导出可持久化数据 */
	toJSON(): InsightExport {
		return {
			pluginInsights: this.pluginInsights,
			compareInsights: this.compareInsights,
		};
	}

	// ───── 插件功能洞察 ─────

	getInsight(pid: string): string | undefined {
		return this.pluginInsights[pid]?.text;
	}

	setInsight(pid: string, text: string): void {
		this.pluginInsights[pid] = { v: INSIGHT_SCHEMA_VERSION, text };
	}

	// ───── 多插件深度对比 ─────

	/** 对比缓存键：按插件 id 排序集合，保证 {A,B} 与 {B,A} 命中同一缓存 */
	compareKey(ids: string[]): string {
		return [...ids].sort().join("|");
	}

	getCompareInsight(ids: string[]): string | undefined {
		return this.compareInsights[this.compareKey(ids)]?.text;
	}

	setCompareInsight(ids: string[], text: string): void {
		this.compareInsights[this.compareKey(ids)] = { v: INSIGHT_SCHEMA_VERSION, text };
	}
}
