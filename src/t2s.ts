/**
 * 简体转换（借鉴 vault-curate 的 preproc.ts）：embed 前把繁体转简体。
 *
 * 为什么：bge-small-zh 主要在简体中文上训练，把 embedding 输入转成简体，
 * 能把向量拉进模型最擅长的 token 空间，显著提升语义准确度（vault-curate 实测
 * 无关结果排名降 3-4 倍）。
 *
 * 纪律：只转换【embedding 输入】（索引侧文本 + 搜索 query），绝不转换存储/展示
 * 文本。仅当文本含 CJK 时才做（避免纯 ASCII 的额外开销）。
 */
import { T2S_TABLE } from "./t2s-table";

/** 逐字符繁→简，表外字符原样通过（surrogate-safe）。 */
export function t2sForEmbed(text: string): string {
	let out = "";
	for (const ch of text) {
		out += T2S_TABLE[ch] ?? ch;
	}
	return out;
}

const CJK_RE = new RegExp("[\u4e00-\u9fff]");

/** 文本是否含 CJK 汉字（用于快速判断是否需要 t2s，纯 ASCII 直接跳过）。 */
export function hasCJK(text: string): boolean {
	return CJK_RE.test(text);
}
