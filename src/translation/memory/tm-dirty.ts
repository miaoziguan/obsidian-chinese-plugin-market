/**
 * TM 脏标记跟踪器（P2-1 God file 拆分：从 translator.ts 下沉）。
 *
 * 追踪自上次 flush 以来新增/更新的 approved 条目（dirty）与移除的 human 条目（removed），
 * 供 plugin flush 写/删 vault 笔记。原则：写成功才清标记（clear*），失败保留到下次重试，
 * 避免「脏标记已清空但笔记未落盘」导致的人工校正/flagged 标记静默丢失（T2/#2）。
 */
export class TMDirtyTracker {
	private dirty = new Set<string>();
	private removed = new Set<string>();

	/** 标记某条目需要写盘（approved 新增/更新、flagged 修正后） */
	markDirty(id: string): void {
		this.dirty.add(id);
	}

	/** 标记某条目需要从 vault 删除（human 来源 TM 条目移除） */
	markRemoved(id: string): void {
		this.removed.add(id);
	}

	/** 取走脏集合（取后清空），供一次性批量写盘 */
	takeDirty(): string[] {
		const ids = [...this.dirty];
		this.dirty.clear();
		return ids;
	}

	/** 仅查看脏集合（不清空），供逐条写成功后再 clearDirty */
	peekDirty(): string[] {
		return [...this.dirty];
	}

	/** 单条清除脏标记（写 vault 笔记成功后调用） */
	clearDirty(id: string): void {
		this.dirty.delete(id);
	}

	/** 取走移除集合（取后清空），供一次性批量删盘 */
	takeRemoved(): string[] {
		const ids = [...this.removed];
		this.removed.clear();
		return ids;
	}

	/** 仅查看移除集合（不清空） */
	peekRemoved(): string[] {
		return [...this.removed];
	}

	/** 单条清除移除标记（删 vault 笔记成功后调用） */
	clearRemoved(id: string): void {
		this.removed.delete(id);
	}
}
