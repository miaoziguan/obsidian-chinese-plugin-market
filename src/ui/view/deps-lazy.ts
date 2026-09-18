/**
 * 依赖基线的运行时兜底：基线（plugin-deps.json）里没有某个插件时，按它的仓库现算一次。
 *
 * 触发面刻意做得很窄——只有「用户真的打开了该插件详情」才检测，绝不批量扫：
 * 6000 个插件的 README 全量拉取既慢又浪费，而长尾插件的依赖其实没人关心。
 *
 * 结果只写进 DepGraph 的内存层（不落盘）：保持随包基线干净，避免一次误判被
 * 持久化成长期错误数据。代价是下次会话会重算一次，属于可接受范围。
 */

import { requestUrl } from "obsidian";
import type { ViewContext } from "@ui/view/view-context";
import { detectDeps } from "@domain/deps/detect";
import { fetchManifest } from "@domain/compare/plugin-insight";
import { logger } from "@shared/logger";

/** 正在检测中的 id（防重复请求） */
const pending = new Set<string>();
/** 已检测过的 id（含「检测出来没有依赖」的情况，避免反复打网络） */
const done = new Set<string>();

const README_LIMIT = 5000;

/**
 * 确保该插件有依赖数据：基线已有则不作为；否则拉 manifest + README 现算一次。
 * 网络失败静默：详情页不显示依赖区块，也不提示错误（依赖是锦上添花）。
 */
export async function ensureDepsFor(
	ctx: ViewContext,
	id: string,
	repo: string | undefined,
): Promise<void> {
	const graph = ctx.pluginDeps;
	if (!graph || !repo) return;
	if (done.has(id) || pending.has(id)) return;
	if (graph.edgesOf(id).length > 0) {
		done.add(id);
		return;
	}
	pending.add(id);
	try {
		const manifest = await fetchManifest(repo, ctx.mirrorConfig());
		let readme = "";
		const root = repo.replace(/\/+$/, "");
		for (const name of ["README.md", "readme.md"]) {
			const r = await requestUrl({
				url: `https://raw.githubusercontent.com/${root}/HEAD/${name}`,
				throw: false,
			});
			if (r.status >= 200 && r.status < 300) {
				readme = r.text.slice(0, README_LIMIT);
				break;
			}
		}
		const dict = ctx.allPlugins.map((p) => ({ id: p.id, name: p.name }));
		const edges = detectDeps({ selfId: id, manifestDeps: manifest.dependencies, readme, dict });
		if (edges.length > 0) {
			graph.merge(id, edges);
			logger.debug(`[Chinese Plugin Market] 按需检测到 ${id} 的 ${edges.length} 条依赖`);
		}
	} catch {
		/* 静默：长尾插件检测失败不影响使用 */
	} finally {
		pending.delete(id);
		done.add(id);
	}
}
