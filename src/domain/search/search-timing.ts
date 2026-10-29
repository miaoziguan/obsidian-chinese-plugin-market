/**
 * 搜索链路分段计时（生产埋点）。
 *
 * 为什么需要它：此前要判断「搜索慢在哪一步」，只能靠散落在 ai.ts 里的临时
 * logger.debug 探针（注释直接写着「探针：…」）。那些探针有三个问题：
 *   1. 只覆盖当时被怀疑的环节，覆盖面靠猜 —— 换个瓶颈就看不见了；
 *   2. 输出是非结构化字符串，无法前后对照或做回归；
 *   3. 每次搜索刷多条日志，真出问题时反而淹没有效信息。
 * 本模块把「一次搜索的耗时构成」变成一等公民：统一采集 → 单行结构化摘要 →
 * 经 AISearcher.getLastSearchTiming() 暴露给 UI。
 *
 * 设计取舍：
 * - 计时用 performance.now()（单调时钟），不受系统时间调整 / 时区影响。
 * - 阶段按调用顺序记录，不做嵌套归并：当前召回链是顺序的，嵌套只增加复杂度而
 *   不增加信息量。若将来某步改为并行，需要相应调整（见 measure 的说明）。
 * - 耗时与计数器分离：命中数 / 是否重建索引这类「规模信息」对判断性能问题同样
 *   关键（例如「向量命中=0」说明索引可能没建对，而不是慢）。
 */

/** 单个阶段的耗时记录 */
export interface SearchPhaseTiming {
	/** 阶段名（中文，可直接用于展示） */
	name: string;
	/** 该阶段耗时（ms） */
	ms: number;
}

/** 一次搜索的完整计时快照 */
export interface SearchTimingSnapshot {
	/** 各阶段耗时，按执行完成顺序 */
	phases: SearchPhaseTiming[];
	/** 从 start() 到 finish() 的总耗时（ms） */
	totalMs: number;
	/** 规模 / 状态计数（各召回命中数、插件数、是否重建索引等） */
	counters: Record<string, number>;
	/** 本次搜索的墙钟时刻（Date.now()），便于与其它日志对齐 */
	at: number;
}

/**
 * 阶段名常量。
 *
 * 集中定义而非各处写字符串字面量：EXTERNAL_PHASES / localPhaseMs 靠名字判定归属，
 * 一旦某处改名而这里没跟着改，判定会**静默失效**（不再报错，只是指标悄悄变错）。
 */
export const PHASE = {
	/** 向量索引（复用或重建，见 vectorIndex 的注释） */
	vectorIndex: "向量索引",
	/** query 编码 + 余弦召回（embedding 走 API 时含一次 HTTP 往返） */
	queryEncode: "query 编码+余弦",
	/** CJK 三元组 BM25 关键词召回（纯本地） */
	keyword: "关键词召回",
	/** 标题模糊匹配 Jaro-Winkler（纯本地） */
	fuzzy: "标题模糊",
	/** RRF 名次融合（纯本地） */
	rrf: "RRF 融合",
	/** 无本地命中时的 LLM 兜底召回（一次完整 LLM 调用） */
	llmFallback: "LLM 兜底召回",
	/** LLM 精排（受服务端与网络影响） */
	llmRank: "LLM 精排",
} as const;

/**
 * 受外部因素（网络往返 / 模型推理）主导的阶段名。
 *
 * 这些阶段不能用来判断「我们自己的代码是否变慢」：
 * - LLM 精排受服务端与网络影响，正常也能到秒级；
 * - LLM 兜底召回是一次完整 LLM 调用；
 * - query 编码在 embedding 走 API 时是一次 HTTP 往返；
 * - 向量索引在重建时要 embed 数千条（走网络或模型推理）。
 * 把它们计入「本地」指标，会让正常搜索持续误报，最终训练出「忽略告警」的习惯。
 *
 * 注：向量索引「是否每次重建」由 `索引重建` 计数器单独呈现，不依赖本指标。
 */
export const EXTERNAL_PHASES: readonly string[] = [
	PHASE.llmRank,
	PHASE.llmFallback,
	PHASE.queryEncode,
	PHASE.vectorIndex,
];

/** 默认单调时钟（浏览器/Node 均有 performance；兜底 Date.now） */
const defaultNow = (): number =>
	typeof performance !== "undefined" ? performance.now() : Date.now();

export class SearchTiming {
	private readonly phases: SearchPhaseTiming[] = [];
	private readonly counters: Record<string, number> = {};
	private readonly t0: number;
	/** 上一个阶段的结束时刻，mark() 据此计算区间 */
	private last: number;

	private constructor(
		private readonly now: () => number,
		private readonly startedAt: number,
	) {
		this.t0 = this.now();
		this.last = this.t0;
	}

	/**
	 * 开始一次计时。
	 * @param now       单调时钟（测试可注入，得到确定值）
	 * @param wallClock 墙钟（仅用于快照的 at 字段）
	 */
	static start(
		now: () => number = defaultNow,
		wallClock: () => number = Date.now,
	): SearchTiming {
		return new SearchTiming(now, wallClock());
	}

	/**
	 * 记录「自上一个阶段结束到此刻」的耗时。
	 * 与 measure() 可混用，两者都会推进区间游标。
	 */
	mark(phase: string): void {
		const t = this.now();
		this.phases.push({ name: phase, ms: t - this.last });
		this.last = t;
	}

	/**
	 * 包住一段（可异步）逻辑并记录其耗时。
	 * 抛错时同样记录 —— 「失败发生在哪一步」本身就是关键信息。
	 *
	 * 注意：不要并发包裹多个 measure，阶段会按完成顺序交错。当前召回链是顺序的，
	 * 满足该前提。
	 */
	async measure<T>(phase: string, fn: () => Promise<T> | T): Promise<T> {
		const t = this.now();
		try {
			return await fn();
		} finally {
			const end = this.now();
			this.phases.push({ name: phase, ms: end - t });
			this.last = end;
		}
	}

	/** 记录一个计数。同名重复记录以最后一次为准。 */
	count(name: string, value = 1): void {
		this.counters[name] = value;
	}

	/** 产出快照。返回拷贝 —— 之后继续记录不会影响已产出的快照。 */
	finish(): SearchTimingSnapshot {
		return {
			phases: this.phases.map((p) => ({ name: p.name, ms: p.ms })),
			totalMs: this.now() - this.t0,
			counters: { ...this.counters },
			at: this.startedAt,
		};
	}
}

/** 把快照格式化为单行摘要（独立导出，便于对已有快照复用）。 */
export function formatSearchTiming(s: SearchTimingSnapshot, label: string): string {
	const phases = s.phases.map((p) => `${p.name}=${p.ms.toFixed(1)}ms`).join(" · ");
	const counters = Object.entries(s.counters)
		.map(([k, v]) => `${k}=${v}`)
		.join(" · ");
	const tail = [phases, counters].filter(Boolean).join(" · ");
	return `[Chinese Plugin Market] ${label}：总计=${s.totalMs.toFixed(1)}ms${tail ? ` · ${tail}` : ""}`;
}

/**
 * 本地（非外部依赖）阶段的耗时合计：只统计我们自己的代码 ——
 * 关键词召回 / 标题模糊 / RRF 融合，排除 EXTERNAL_PHASES（见其注释）。
 *
 * 为什么不用总耗时：LLM 精排受网络与服务端影响，正常也能到秒级；embedding 走 API 时
 * query 编码同样是一次 HTTP 往返。用总耗时做阈值只会持续误报。
 */
export function localPhaseMs(s: SearchTimingSnapshot): number {
	let sum = 0;
	for (const p of s.phases) if (!EXTERNAL_PHASES.includes(p.name)) sum += p.ms;
	return sum;
}
