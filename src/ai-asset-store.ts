/**
 * 个人 AI 固化资产存储
 *
 * 从 translator.ts 抽出的独立小块（P2-7 续）：封装「个人 AI 固化资产」aiDict。
 * 它与 volatile `cache` 分离——clearCache() 不清除它，跨会话保留；
 * 后续命中时跳过在线 AI（省 token）。
 *
 * 该模块与翻译管线、TM 解耦。Translator 持有单一实例并转发读写，外部 API 不变。
 */

/** 单条 AI 固化资产（一份插件译名/译述，含来源标记） */
export interface DictEntry {
	name: string;
	description?: string;
	source?: string;
}

/** 可被持久化的原始数据（loadData 入参的子集） */
export interface AiAssetRawData {
	aiDict?: Record<string, DictEntry>;
}

/** 导出给持久化的结构 */
export interface AiAssetExport {
	aiDict: Record<string, DictEntry>;
}

/**
 * 个人 AI 固化资产存储。Translator 持有单一实例，原 aiDict 字段与读写方法改为委托本类。
 */
export class AiAssetStore {
	/** 个人 AI 固化资产：与 volatile `cache` 分离，跨会话保留 */
	private aiDict: Record<string, DictEntry> = {};

	/** 从持久化恢复 */
	load(raw: AiAssetRawData): void {
		if (raw.aiDict) this.aiDict = raw.aiDict;
	}

	/** 导出可持久化数据 */
	toJSON(): AiAssetExport {
		return { aiDict: this.aiDict };
	}

	/** 返回内部对象的实时引用（供历史直接字段访问 t.aiDict[pid] 兼容，勿长期依赖） */
	raw(): Record<string, DictEntry> {
		return this.aiDict;
	}

	// ───── 读写 ─────

	get(pid: string): DictEntry | undefined {
		return this.aiDict[pid];
	}

	set(pid: string, entry: DictEntry): void {
		this.aiDict[pid] = entry;
	}

	/** 删除单条（人工校正 / 移除反馈时连带清除，避免与可信层并存） */
	deleteEntry(pid: string): void {
		delete this.aiDict[pid];
	}

	/** 清空全部个人 AI 资产（不影响 cache） */
	clear(): void {
		this.aiDict = {};
	}

	/** 当前资产条数 */
	size(): number {
		return Object.keys(this.aiDict).length;
	}
}
