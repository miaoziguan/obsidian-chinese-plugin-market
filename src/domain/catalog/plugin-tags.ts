/**
 * 插件分类标签管理（从 Translator 中抽出）。
 *
 * 职责：
 *   - 存储 plugin-tags.json 的离线分类索引
 *   - 提供分类查询、计数、浏览导航等纯数据操作
 *   - 不涉及任何网络/翻译/UI
 */

/** 插件功能分类标签 */
export interface PluginTag {
	category: string;
	tags: string[];
}

export class PluginTagService {
	private tags: Record<string, PluginTag> = {};
	private schemaVersion: string | undefined;

	/** 加载离线分类索引 */
	load(tags: Record<string, PluginTag>, schemaVersion?: string) {
		this.tags = tags ?? {};
		this.schemaVersion = schemaVersion;
	}

	/** 分类体系版本号 */
	getSchemaVersion(): string | undefined {
		return this.schemaVersion;
	}

	/** 某插件的分类标签 */
	getTag(id: string): PluginTag | null {
		return this.tags[id] ?? null;
	}

	/** 全量标签映射 */
	getAllTags(): Record<string, PluginTag> {
		return this.tags;
	}

	/** 全部一级分类名（按拼音排序） */
	getAllCategories(): string[] {
		const set = new Set<string>();
		for (const t of Object.values(this.tags)) {
			if (t?.category) set.add(t.category);
		}
		return [...set].sort((a, b) => a.localeCompare(b, "zh"));
	}

	/** 各分类及包含插件数量（按 count 降序） */
	getAllCategoryCounts(): { category: string; count: number }[] {
		const cnt = new Map<string, number>();
		for (const t of Object.values(this.tags)) {
			if (t?.category) cnt.set(t.category, (cnt.get(t.category) ?? 0) + 1);
		}
		return [...cnt.entries()]
			.map(([category, count]) => ({ category, count }))
			.sort((a, b) => b.count - a.count);
	}

	/** 某分类下的全部插件 id */
	getIdsByCategory(category: string): string[] {
		const ids: string[] = [];
		for (const [id, t] of Object.entries(this.tags)) {
			if (t?.category === category) ids.push(id);
		}
		return ids;
	}

	/** 全部标签名及频次（用于标签云，按 count 降序） */
	getAllTagCounts(): { tag: string; count: number }[] {
		const cnt = new Map<string, number>();
		for (const t of Object.values(this.tags)) {
			for (const tag of t?.tags ?? []) {
				cnt.set(tag, (cnt.get(tag) ?? 0) + 1);
			}
		}
		return [...cnt.entries()]
			.map(([tag, count]) => ({ tag, count }))
			.sort((a, b) => b.count - a.count);
	}

	/** 某标签下的全部插件 id */
	getIdsByTag(tag: string): string[] {
		const ids: string[] = [];
		for (const [id, t] of Object.entries(this.tags)) {
			if (t?.tags?.includes(tag)) ids.push(id);
		}
		return ids;
	}
}
