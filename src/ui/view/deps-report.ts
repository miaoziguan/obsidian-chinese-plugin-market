/**
 * 安装完成后的依赖检查钩子。
 *
 * 只在「有必需依赖没到位」时弹 DepCheckModal；依赖都齐了一声响不响。
 *
 * 关键时序：必须晚于 snapshotInstalled 调用。安装流程在写盘后会立刻调
 * snapshotInstalled 把新装的插件塞进 installedIds/enabledIds，所以到这里时
 * 刚装的本体已经被识别为「已装已启用」，blockingOf 不会再把它自己算成缺失。
 * 缺失的只会是它真正缺的那些依赖（Dataview 等）。
 */

import { DepCheckModal, type DepCheckItem } from "@ui/modals/dep-check-modal";
import type { ViewContext } from "@ui/view/view-context";
import type { DepStatus } from "@domain/deps/types";

/** 状态 → 补就动作；unknown 等无法从官方列表处理的不给动作（只显示名字） */
function actionOf(status: DepStatus): DepCheckItem["action"] {
	if (status === "missing") return "install";
	if (status === "disabled") return "enable";
	if (status === "outdated") return "update";
	return null;
}

export function reportMissingDeps(ctx: ViewContext, pluginId: string, pluginName: string): void {
	const graph = ctx.pluginDeps;
	if (!graph) return;
	const blocking = graph.blockingOf(pluginId, {
		installedIds: ctx.installedIds,
		enabledIds: ctx.enabledIds,
		installedVersions: ctx.installedVersions,
		knownIds: new Set(ctx.allPlugins.map((p) => p.id)),
	});
	if (blocking.length === 0) return;

	const items: DepCheckItem[] = blocking.map((b) => ({
		id: b.dep.id,
		name: b.dep.name || b.dep.id,
		status: b.status,
		action: actionOf(b.status),
	}));
	new DepCheckModal({
		app: ctx.app,
		pluginName,
		items,
		t: ctx.t,
		onFix: (item) => {
			if (!item.action) return;
			ctx.fixDep(item.id, item.action);
		},
	}).open();
}
