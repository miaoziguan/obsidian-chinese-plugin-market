#!/usr/bin/env node
/**
 * gen-recommend.mjs — 生成 plugin-recommend.json（官方推荐清单）
 *
 * 用法（二选一）：
 *   1) 从本地 community-plugins.json 提取某作者的全部插件：
 *      node scripts/gen-recommend.mjs 羽鳞君 ./community-plugins.json
 *   2) 从在线社区清单 URL 提取（需能访问网络，必要时设 HTTPS_PROXY）：
 *      node scripts/gen-recommend.mjs 羽鳞君 https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json
 *
 * 输出：仓库根目录 plugin-recommend.json（保留已有 title，仅刷新 ids）。
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const [, , author = "羽鳞君", source] = process.argv;
const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, "..", "plugin-recommend.json");

async function loadCommunity() {
	if (!source) {
		throw new Error("请传入 community-plugins.json 的本地路径或在线 URL");
	}
	if (source.startsWith("http://") || source.startsWith("https://")) {
		const res = await fetch(source);
		if (!res.ok) throw new Error(`下载失败：${res.status} ${source}`);
		return res.json();
	}
	const text = await readFile(source, "utf8");
	return JSON.parse(text);
}

const community = await loadCommunity();
const ids = community
	.filter((p) => p.author && p.author.includes(author))
	.map((p) => p.id);

let existing = {};
try {
	existing = JSON.parse(await readFile(outPath, "utf8"));
} catch {
	/* 不存在则用默认 title */
}

const out = {
	title: existing.title || `官方推荐 · ${author}`,
	ids,
};
await writeFile(outPath, JSON.stringify(out, null, "\t") + "\n", "utf8");
console.log(`✅ 已写入 ${out.ids.length} 个「${author}」的插件到 plugin-recommend.json`);
console.log(out.ids.join(", "));
