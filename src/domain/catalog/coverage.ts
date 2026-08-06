import type { CoverageSnapshot } from "@domain/catalog/translator";

export class CoverageTracker {
	private history: CoverageSnapshot[] = [];

	/** 从持久化快照恢复历史 */
	load(snapshots: CoverageSnapshot[]) {
		this.history = snapshots ?? [];
	}

	/** 导出持久化快照 */
	snapshot(): CoverageSnapshot[] {
		return [...this.history];
	}
}
