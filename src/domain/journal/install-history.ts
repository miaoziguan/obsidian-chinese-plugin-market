/**
 * 插件评测台账——安装历史索引。
 *
 * 记录「这个插件我装过吗、什么时候装/卸、装了几次」这类**事实**，
 * 与用户主观的评测笔记（journal-entry.ts）分开存：历史是机器数据（json），
 * 笔记是人的内容（markdown，只有用户写过才存在）。
 *
 * 数据来源：installed-watch 已有的 add/remove diff（桌面 fs.watch、移动 60s 轮询）。
 *
 * 硬边界：历史只能从本插件启用之后开始记录——Obsidian 卸载即删目录，
 * 此前装过又卸的插件任何插件都无从追溯。
 */

export interface InstallRecord {
	/** 首次记录时的插件显示名（社区列表后来下架该插件时用于兜底展示） */
	name: string;
	firstInstalled: number;
	lastInstalled: number;
	/** 最近一次卸载时间；当前仍安装则为 null */
	uninstalled: number | null;
	installCount: number;
	currentlyInstalled: boolean;
	currentlyEnabled: boolean;
}

export interface InstallHistoryFile {
	version: 1;
	entries: Record<string, InstallRecord>;
}

export interface InstallDiff {
	/** 本次新增（观测到安装）的 id */
	added: Set<string>;
	/** 本次移除（观测到卸载）的 id */
	removed: Set<string>;
	/** 当前已安装 id 快照 */
	installedIds: Set<string>;
	/** 当前已启用 id 快照 */
	enabledIds: Set<string>;
	/** 取显示名（新记录时用；已有记录保留首次的名字） */
	nameOf: (id: string) => string;
	now: number;
}

export function emptyInstallHistory(): InstallHistoryFile {
	return { version: 1, entries: {} };
}

/**
 * 把一次监听 diff 合并进历史，返回新的 entries（不修改入参，便于单测与并发安全）。
 *
 * 合并规则：
 * - 新增：首次则记 firstInstalled；installCount +1；清空 uninstalled
 * - 移除：记 uninstalled，且不再视为安装/启用（firstInstalled 等历史保留）
 * - 其余：仅同步启用态（禁用/启用不改变安装历史）
 */
export function mergeInstallDiff(
	current: Record<string, InstallRecord>,
	diff: InstallDiff,
): Record<string, InstallRecord> {
	const out: Record<string, InstallRecord> = {};
	for (const [id, r] of Object.entries(current)) out[id] = { ...r };
	const { added, removed, installedIds, enabledIds, nameOf, now } = diff;

	for (const id of added) {
		const prev = out[id];
		out[id] = {
			name: prev?.name ?? nameOf(id),
			firstInstalled: prev?.firstInstalled ?? now,
			lastInstalled: now,
			uninstalled: null,
			installCount: (prev?.installCount ?? 0) + 1,
			currentlyInstalled: true,
			currentlyEnabled: enabledIds.has(id),
		};
	}

	for (const id of removed) {
		const prev = out[id];
		if (!prev) continue;
		out[id] = {
			...prev,
			uninstalled: now,
			currentlyInstalled: false,
			currentlyEnabled: false,
		};
	}

	for (const id of Object.keys(out)) {
		if (added.has(id) || removed.has(id)) continue;
		const prev = out[id];
		const stillInstalled = installedIds.has(id);
		// 跨会话卸载：Obsidian 关闭期间被删掉的插件不会产生 watch 的 removed 事件
		// （watcher 基线里已无该 id）。若历史记着「仍安装」而当前快照已无此 id，
		// 补写 uninstalled —— 否则会留下「既非安装中、又没有卸载时间」的矛盾记录，
		// 面板按卸载时间排序时会出现空值。
		const orphaned = !stillInstalled && prev.uninstalled === null;
		out[id] = {
			...prev,
			currentlyInstalled: stillInstalled,
			currentlyEnabled: enabledIds.has(id),
			uninstalled: orphaned ? now : prev.uninstalled,
		};
	}

	return out;
}
