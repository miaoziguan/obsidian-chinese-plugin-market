/**
 * src/services/ai-explorer.ts
 * ─────────────────────────────────────────────
 * AI 搜索路由分类器：判断查询该走 AI 语义搜索还是关键词搜索。
 *
 * 注：原「AIExplorerService 迁移蓝图」接口已删除（P3-1 死代码清理）——
 * 其配套的 deterministic-pipe.ts / search-strategy.ts 已在早前重构中移除，
 * 蓝图从未落地；AI 实现现直接位于 translator.ts。
 */

/**
 * 判断查询是否值得走 AI 语义搜索。
 *
 * 启发式规则：
 * - 短查询（≤3 字符）→ 更可能是插件名关键词，跳过 AI
 * - 纯数字 → 可能是版本号，跳过 AI
 * - 包含中文字符（≥4 个 CJK 字符）→ 自然语言描述，适合 AI
 * - 长查询（>15 字符）→ 大概率是描述性搜索，适合 AI
 * - 包含多个英文单词（≥5 词）→ 可能是功能描述，适合 AI
 */
export function isAIWorthyQuery(query: string): boolean {
	const trimmed = query.trim();
	if (trimmed.length <= 3) return false;
	if (/^\d+$/.test(trimmed)) return false;

	const cjk = (trimmed.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length;
	if (cjk >= 4) return true;
	if (trimmed.length > 15) return true;

	const words = trimmed.split(/\s+/).filter(Boolean);
	if (words.length >= 5) return true;

	return false;
}

/**
 * 判断查询是否适合走关键词搜索。
 * 与 isAIWorthyQuery 严格互补：不适合 AI 的查询即适合关键词。
 *
 * 修复路由盲区：旧实现只认领「≤2 字符 / 纯数字 / CJK<3 且 ≤6 字符」，
 * 中间带查询（如 4-15 字符的中英混合词）两个启发式都不认领，
 * 空态桥接（AI 无结果 → 试试关键词）双向失效，用户陷入无出口的死胡同。
 * 互补后任何非空查询至少被一侧认领。
 */
export function isKeywordWorthyQuery(query: string): boolean {
	const trimmed = query.trim();
	if (trimmed.length === 0) return false;
	return !isAIWorthyQuery(trimmed);
}
