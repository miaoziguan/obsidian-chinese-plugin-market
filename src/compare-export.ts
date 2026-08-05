/**
 * 对比导出引擎：Markdown 文本导出（零外部依赖）。
 *
 * 导出：
 *  1) renderCompareMarkdown() — 生成格式化对比报告（Markdown）
 *
 * 设计：纯函数，输入对比数据 → 输出文本，不依赖 DOM / Obsidian API。
 */

import { formatDownloads, formatUpdated } from "./stats";
import { compareTagsMulti } from "./compare";
import type { PluginTag } from "./plugin-tags";

// ── 对外类型 ──

export interface CompareExportItem {
	id: string;
	name: string;            // 翻译名
	originalName: string;    // 原名
	description: string;     // 翻译后的描述
	downloads?: number;
	updated?: number;
	installed: "on" | "off" | "none";
	tags: PluginTag | null;
}

// ── Markdown 导出 ──

export function renderCompareMarkdown(
	items: CompareExportItem[],
	title: string
): string {
	const allTags = items.map((it) => it.tags?.tags ?? []);
	const { common } = compareTagsMulti(allTags);

	const lines: string[] = [];
	lines.push(`# ${title}`);
	lines.push("");

	// 共同功能
	if (common.length) {
		lines.push("## 共同功能");
		lines.push("");
		for (const tag of common) lines.push(`- ${tag}`);
		lines.push("");
	} else {
		lines.push("> 这些插件各有侧重、功能互补");
		lines.push("");
	}

	// 逐插件
	for (const it of items) {
		const name = it.name !== it.originalName ? `${it.name} (${it.originalName})` : it.name;
		lines.push(`## ${name}`);
		lines.push("");

		if (it.tags?.category) {
			lines.push(`- **分类**：${it.tags.category}`);
		}
		if (it.tags?.tags?.length) {
			lines.push(`- **功能标签**：${it.tags.tags.join(" / ")}`);
		}
		if (it.downloads != null) {
			lines.push(`- **下载量**：${formatDownloads(it.downloads)}`);
		}
		if (it.updated != null) {
			lines.push(`- **更新时间**：${formatUpdated(it.updated)}`);
		}
		lines.push(`- **安装状态**：${it.installed === "on" ? "已安装·已启用" : it.installed === "off" ? "已安装·未启用" : "未安装"}`);
		if (it.description) {
			lines.push("");
			lines.push(it.description);
		}
		lines.push("");
	}

	// 页脚
	lines.push("---");
	lines.push(`*由「插件搜索」对比生成 · ${new Date().toLocaleDateString("zh-CN")}*`);

	return lines.join("\n");
}
