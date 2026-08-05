/**
 * 插件功能洞察（基于仓库多要素综合判断）。
 *
 * 数据源（按可信度由高到低）：
 *   - manifest.json：description / author / version / tags / dependencies（依赖暴露技术栈/联动对象）
 *   - main.js：实际代码里注册的 commands（id/name）+ 是否有设置页（比文档诚实）
 *   - README.md：原文片段（可能过时 / 含营销话术，仅作补充，不采信为唯一依据）
 * 让 LLM 综合这些证据写一段「这插件到底干什么、适合谁」的中文概述，
 * 结果缓存到 translator.pluginInsights，避免重复烧 token。
 */

import type { PluginInfo } from "./translator";
import type { LLMClient } from "./translate/api";
import { netRequest } from "./net";
import { resolveUrl, buildReadmeUrl, type MirrorConfig } from "./mirror";

/** manifest.json 中我们关心的字段 */
export interface PluginManifest {
	description?: string;
	author?: string;
	version?: string;
	tags?: string[];
	dependencies?: Record<string, string>;
	/** manifest.main（入口文件，通常 "main.js"） */
	main?: string;
}

/** 从 main.js 抽取的结构化信号 */
export interface MainSignals {
	commands: { id: string; name: string }[];
	hasSettings: boolean;
}

/** 综合洞察的额外证据（README 片段 + main.js 信号） */
export interface InsightExtra {
	readme?: string;
	mainSignals?: MainSignals;
}

/** 对比场景单个插件的完整输入（市场元数据 + 仓库真实信号） */
export interface CompareItem {
	id: string;
	name: string;
	description: string;
	tags: string[];
	/** main.js 实际注册的命令名（真实功能的最诚实证据） */
	commands: string[];
	/** manifest.dependencies 的键（暴露技术栈 / 联动对象） */
	dependencies: string[];
	/** README 截断片段（可选，补充真实使用场景） */
	readme?: string;
}

/** 由 repo（owner/name）构造 manifest.json 的 raw URL 并按镜像映射 */
export function buildManifestUrl(repo: string | undefined, mirror: MirrorConfig): string {
	if (!repo) return "";
	const cleaned = repo.replace(/^\/+|\/+$/g, "");
	const parts = cleaned.split("/");
	if (parts.length !== 2 || !parts[0] || !parts[1]) return "";
	const [owner, name] = parts;
	const rawUrl = `https://raw.githubusercontent.com/${owner}/${name}/HEAD/manifest.json`;
	return resolveUrl(rawUrl, mirror);
}

/** 构造 main.js 的 raw URL（manifest.main 指定入口；缺省 main.js） */
export function buildMainJsUrl(
	repo: string | undefined,
	main: string | undefined,
	mirror: MirrorConfig
): string {
	if (!repo) return "";
	const cleaned = repo.replace(/^\/+|\/+$/g, "");
	const parts = cleaned.split("/");
	if (parts.length !== 2 || !parts[0] || !parts[1]) return "";
	const [owner, name] = parts;
	const entry = main && main.trim() ? main.trim() : "main.js";
	const rawUrl = `https://raw.githubusercontent.com/${owner}/${name}/HEAD/${entry}`;
	return resolveUrl(rawUrl, mirror);
}

/** 拉取并解析 manifest.json；失败返回空对象（不阻断洞察生成，降级用已有元数据） */
export async function fetchManifest(
	repo: string | undefined,
	mirror: MirrorConfig
): Promise<PluginManifest> {
	const url = buildManifestUrl(repo, mirror);
	if (!url) return {};
	try {
		const resp = await netRequest({ url, method: "GET" });
		if (resp.status < 200 || resp.status >= 300) return {};
		const json = resp.json as Partial<PluginManifest>;
		if (!json || typeof json !== "object") return {};
		return {
			description: typeof json.description === "string" ? json.description : undefined,
			author: typeof json.author === "string" ? json.author : undefined,
			version: typeof json.version === "string" ? json.version : undefined,
			tags: Array.isArray(json.tags) ? json.tags.filter((t: unknown) => typeof t === "string") : undefined,
			dependencies:
				json.dependencies && typeof json.dependencies === "object"
					? (json.dependencies as Record<string, string>)
					: undefined,
			main: typeof json.main === "string" ? json.main : undefined,
		};
	} catch {
		return {};
	}
}

/** 拉取 README 原文片段（截断，给 LLM 抓核心介绍；可能过时，仅作补充） */
export async function fetchReadmeText(
	repo: string | undefined,
	mirror: MirrorConfig
): Promise<string> {
	const url = buildReadmeUrl(repo, mirror);
	if (!url) return "";
	try {
		const resp = await netRequest({ url, method: "GET" });
		if (resp.status < 200 || resp.status >= 300) return "";
		const text = resp.text || "";
		// 截断到前 5000 字符（README 开头通常是功能介绍）
		return text.slice(0, 5000);
	} catch {
		return "";
	}
}

/** 拉取 main.js 并抽取 commands / 设置页信号 */
export async function fetchMainSignals(
	repo: string | undefined,
	main: string | undefined,
	mirror: MirrorConfig
): Promise<MainSignals> {
	const url = buildMainJsUrl(repo, main, mirror);
	if (!url) return { commands: [], hasSettings: false };
	try {
		const resp = await netRequest({ url, method: "GET" });
		if (resp.status < 200 || resp.status >= 300) return { commands: [], hasSettings: false };
		return extractMainSignals(resp.text || "");
	} catch {
		return { commands: [], hasSettings: false };
	}
}

/**
 * 从 main.js 源码抽取 commands（id/name）+ 是否有设置页。
 * addCommand({ id:"...", name:"..." }) 在 Obsidian 插件里通常无嵌套 `}`，
 * 非贪婪到第一个 `}` 即能截到 id/name；若有回调含 `}` 也因 id/name 在块首而先被命中。
 */
export function extractMainSignals(code: string): MainSignals {
	const commands: { id: string; name: string }[] = [];
	const re = /addCommand\(\{([\s\S]*?)\}/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(code)) !== null && commands.length < 40) {
		const block = m[1];
		const idM = block.match(/id:\s*["']([^"']+)["']/);
		const nameM = block.match(/name:\s*["']([^"']+)["']/);
		if (idM && nameM) commands.push({ id: idM[1], name: nameM[1] });
	}
	const hasSettings =
		/addSettingTab|settingTab|name:\s*["']设置["']|new\s+\w*SettingTab/.test(code);
	return { commands, hasSettings };
}

/** 构造给 LLM 的中文概述 prompt */
export function buildInsightPrompt(
	plugin: PluginInfo,
	manifest: PluginManifest,
	extra?: InsightExtra
): string {
	const deps = manifest.dependencies ? Object.keys(manifest.dependencies) : [];
	const parts: string[] = [];
	parts.push(`插件 ID：${plugin.id}`);
	parts.push(`名称：${plugin.name}`);
	if (plugin.description) parts.push(`官方描述：${plugin.description}`);
	if (manifest.description && manifest.description !== plugin.description)
		parts.push(`manifest 描述：${manifest.description}`);
	if (manifest.author) parts.push(`作者：${manifest.author}`);
	if (manifest.version) parts.push(`版本：${manifest.version}`);
	if (plugin.downloads != null) parts.push(`下载量：${plugin.downloads}`);
	if (plugin.updated) parts.push(`最近更新：${new Date(plugin.updated).toISOString().slice(0, 10)}`);
	if (manifest.tags?.length) parts.push(`官方标签：${manifest.tags.join("、")}`);
	if (deps.length) parts.push(`依赖（暴露技术栈/联动对象）：${deps.join("、")}`);

	const sig = extra?.mainSignals;
	if (sig?.commands?.length) {
		parts.push(
			`代码里实际注册的命令（最能反映真实功能，优先采信）：${sig.commands
				.map((c) => `${c.name}（${c.id}）`)
				.join("、")}`
		);
	}
	if (sig?.hasSettings) parts.push(`代码包含设置页（有可配置项）`);
	if (extra?.readme) {
		parts.push(
			`README 原文片段（可能过时 / 含营销话术，仅作补充参考，不要全信）：\n${extra.readme}`
		);
	}

	return [
		"你是 Obsidian 插件测评助手。下面给出一个插件的「市场元数据 + 仓库真实代码信号 + README 片段」三类证据。",
		"请综合判断，用简体中文写一段「用户视角」的功能概述，帮助用户快速判断要不要装：",
		"1. 一句话讲清这插件核心解决什么痛点；",
		"2. 适合谁用（典型场景/工作流）；",
		"3. 不适合谁（何时用不上）。",
		"采信优先级：代码里的 commands / manifest 字段 > README（README 可能过时，只作补充）。",
		"不要逐条罗列输入，写成连贯的 2-4 句话。若证据不足，就基于名称与描述合理推断，但不要编造具体功能。",
		"",
		"【证据】",
		parts.join("\n"),
	].join("\n");
}

/**
 * 生成插件功能洞察。
 * @returns 中文概述文本；无 AI Key 或失败时抛出错误，由调用方降级到 description。
 */
export async function generateInsight(
	llm: LLMClient,
	plugin: PluginInfo,
	manifest: PluginManifest,
	extra?: InsightExtra
): Promise<string> {
	const prompt = buildInsightPrompt(plugin, manifest, extra);
	const result = await llm.call(
		"你是基于仓库元数据与代码信号总结 Obsidian 插件功能的助手，只输出中文概述，不要使用 Markdown 标题。",
		prompt,
		700,
		false
	);
	const text = result.trim();
	if (!text) throw new Error("AI 未返回有效概述");
	return text;
}

/** 一个插件被「了解功能 / 对比」所需的全部真实信号聚合 */
export interface InsightSources {
	manifest: PluginManifest;
	mainSignals: MainSignals;
	readme: string;
}

/**
 * 并行拉取一个插件的全部真实信号（manifest + main.js 命令 + README 片段）。
 * 单路失败不影响其余路，缺失部分在 prompt 中以"无"呈现，不阻断整体生成。
 * @param readmeLimit README 截断字符数（对比场景多插件，默认比单插件洞察更短）
 */
export async function gatherInsightSources(
	repo: string | undefined,
	mirror: MirrorConfig,
	readmeLimit = 5000
): Promise<InsightSources> {
	const manifest = await fetchManifest(repo, mirror);
	const [readmeRaw, mainSignals] = await Promise.all([
		fetchReadmeText(repo, mirror),
		fetchMainSignals(repo, manifest.main, mirror),
	]);
	// 对比场景统一更短，避免多插件输入爆 token
	const readme = readmeLimit < readmeRaw.length ? readmeRaw.slice(0, readmeLimit) : readmeRaw;
	return { manifest, mainSignals, readme };
}
