/**
 * 高级搜索语法解析与匹配（产品改进 #3）。
 *
 * 零依赖纯函数，便于单测。语法：
 *  - 空格分词        = AND（全部命中）
 *  - `|` 或 `OR`     = OR（任一命中，作为独立分组）
 *  - `-词`           = 排除（命中则淘汰）
 *  - `field:value`   = 字段限定（field ∈ name / id / author / desc / any）
 *  - `"精确短语"`     = 短语整体子串匹配（可与 field: 组合）
 *
 * 设计取舍：解析结果为「AND 项 + 若干 OR 分组 + 排除项」的扁平 AST，
 * 不做完整布尔表达式树。这覆盖 90% 实用场景且实现/心智成本低。
 */

export type QueryFieldName = "any" | "name" | "id" | "author" | "desc";

export interface QueryTerm {
	field: QueryFieldName;
	/** 已 lower-case 归一化的匹配值 */
	value: string;
}

export interface QueryAST {
	/** AND 项：全部命中才算匹配 */
	terms: QueryTerm[];
	/** OR 分组：每组内任一命中即算该组通过；多组之间是 AND（全部组都要通过） */
	orGroups: QueryTerm[][];
	/** 排除项：任一命中则整体淘汰 */
	excludes: QueryTerm[];
	/** 是否使用了高级语法（用于决定能否复用前缀增量缓存） */
	advanced: boolean;
}

/** 匹配所需的插件字段（均由调用方转小写传入或本函数内转小写） */
export interface QueryFields {
	name: string;
	id: string;
	description: string;
	author: string;
	/** 预拼接的全字段 blob（小写），any 字段走它 */
	blob: string;
}

const FIELD_ALIASES: Record<string, QueryFieldName> = {
	name: "name",
	id: "id",
	author: "author",
	desc: "desc",
	description: "desc",
};

/**
 * 快速判断输入是否包含高级语法特征。
 * 用于：语法查询禁用前缀增量缓存（保守做全量），纯子串查询保留缓存。
 */
export function isAdvancedQuery(input: string): boolean {
	const s = input.trim();
	if (!s) return false;
	return (
		/\s/.test(s) || // 空格分词
		s.includes("-") || // 排除
		s.includes(":") || // 字段限定
		s.includes('"') || // 精确短语
		s.includes("|") // OR
	);
}

/**
 * 把原始输入切成 token，正确处理带引号的短语（引号内空格不切分）。
 * 返回的每个 token 保留其原始前缀（如 `-`、`author:`）与引号内容（去引号）。
 */
function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	const n = input.length;
	while (i < n) {
		// 跳过空白
		while (i < n && /\s/.test(input[i])) i++;
		if (i >= n) break;

		let tok = "";
		// 读取一个 token，直到遇到空白（但引号内的空白不算分隔）
		while (i < n && !/\s/.test(input[i])) {
			if (input[i] === '"') {
				// 读入引号（含内容，直到闭合引号或字符串结束）
				tok += input[i]; // 保留开引号，便于后续识别短语
				i++;
				while (i < n && input[i] !== '"') {
					tok += input[i];
					i++;
				}
				if (i < n && input[i] === '"') {
					tok += input[i];
					i++;
				}
			} else {
				tok += input[i];
				i++;
			}
		}
		if (tok) tokens.push(tok);
	}
	return tokens;
}

/** 解析单个 token 的 field 前缀与值（去引号、转小写）。 */
function parseTermToken(raw: string): QueryTerm {
	let field: QueryFieldName = "any";
	let rest = raw;

	// 字段前缀 field:value（field 必须是已知别名，且冒号出现在引号之前）
	const colonIdx = rest.indexOf(":");
	const quoteIdx = rest.indexOf('"');
	if (colonIdx > 0 && (quoteIdx === -1 || colonIdx < quoteIdx)) {
		const maybeField = rest.slice(0, colonIdx).toLowerCase();
		if (FIELD_ALIASES[maybeField]) {
			field = FIELD_ALIASES[maybeField];
			rest = rest.slice(colonIdx + 1);
		}
	}

	// 去引号（精确短语）
	if (rest.startsWith('"') && rest.endsWith('"') && rest.length >= 2) {
		rest = rest.slice(1, -1);
	} else if (rest.startsWith('"')) {
		rest = rest.slice(1);
	}

	return { field, value: rest.toLowerCase().trim() };
}

/**
 * 解析查询串为 QueryAST。
 */
export function parseQuery(input: string): QueryAST {
	const ast: QueryAST = {
		terms: [],
		orGroups: [],
		excludes: [],
		advanced: isAdvancedQuery(input),
	};
	const trimmed = input.trim();
	if (!trimmed) {
		ast.advanced = false;
		return ast;
	}

	// 无空格 OR 写法归一化：`a|b` 拆为 `a | b`（引号短语不拆，独立 `|` 原样保留）
	const rawTokens = tokenize(trimmed);
	const tokens: string[] = [];
	for (const t of rawTokens) {
		if (t !== "|" && !t.includes('"') && t.includes("|")) {
			const parts = t.split("|");
			for (let idx = 0; idx < parts.length; idx++) {
				if (parts[idx]) tokens.push(parts[idx]);
				if (idx < parts.length - 1) tokens.push("|");
			}
		} else {
			tokens.push(t);
		}
	}

	// 先按 OR 关键字 / `|` 分割为若干「AND 片段」，片段间为 OR。
	// 但为兼容「AND 与 OR 混合」的实用心智：把连续被 `|`/OR 连接的相邻词归为一个 OR 组，
	// 其余词为顶层 AND 项。实现上：扫描 token，遇到 OR 连接符时，把上一 token 与下一 token 并入同一 OR 组。
	let pendingOr = false;
	let currentOrGroup: QueryTerm[] | null = null;

	for (let k = 0; k < tokens.length; k++) {
		const t = tokens[k];
		// OR 连接符
		if (t === "|" || t.toLowerCase() === "or") {
			pendingOr = true;
			// 把上一个已归入 terms 的普通项移出，作为 OR 组的第一个成员
			if (!currentOrGroup) {
				const last = ast.terms.pop();
				currentOrGroup = last ? [last] : [];
			}
			continue;
		}

		// 排除项
		if (t.startsWith("-") && t.length > 1) {
			ast.excludes.push(parseTermToken(t.slice(1)));
			// 修复：曾直接置 null 丢弃未收尾的 OR 组（如 `a | -b` 中的 a 整个丢失），
			// 先把已收集的组归档再复位
			if (currentOrGroup && currentOrGroup.length > 0) {
				ast.orGroups.push(currentOrGroup);
			}
			pendingOr = false;
			currentOrGroup = null;
			continue;
		}

		const term = parseTermToken(t);
		if (!term.value) continue;

		if (pendingOr && currentOrGroup) {
			currentOrGroup.push(term);
			// 一个 OR 连接消费完毕；若后面继续 `|` 会再次进入 pendingOr 分支扩展本组
			pendingOr = false;
			// 若下一个不是 OR 连接符，则收尾该组
			const next = tokens[k + 1];
			if (!(next === "|" || (next && next.toLowerCase() === "or"))) {
				ast.orGroups.push(currentOrGroup);
				currentOrGroup = null;
			}
		} else {
			ast.terms.push(term);
		}
	}

	// 收尾：残留未 push 的 OR 组
	if (currentOrGroup && currentOrGroup.length > 0) {
		ast.orGroups.push(currentOrGroup);
	}

	return ast;
}

/** 单个 term 是否命中给定字段集。 */
function termHits(fields: QueryFields, term: QueryTerm): boolean {
	const v = term.value;
	if (!v) return true;
	switch (term.field) {
		case "name":
			return fields.name.toLowerCase().includes(v);
		case "id":
			return fields.id.toLowerCase().includes(v);
		case "author":
			return fields.author.toLowerCase().includes(v);
		case "desc":
			return fields.description.toLowerCase().includes(v);
		case "any":
		default:
			return fields.blob.includes(v);
	}
}

/**
 * 按 AST 匹配字段集：AND 项全中 且 每个 OR 组任一命中 且 无排除项命中。
 */
export function matchQueryAST(fields: QueryFields, ast: QueryAST): boolean {
	// 排除项优先淘汰
	for (const ex of ast.excludes) {
		if (termHits(fields, ex)) return false;
	}
	// AND 项
	for (const t of ast.terms) {
		if (!termHits(fields, t)) return false;
	}
	// OR 组（组间 AND）
	for (const group of ast.orGroups) {
		if (group.length === 0) continue;
		if (!group.some((t) => termHits(fields, t))) return false;
	}
	return true;
}
