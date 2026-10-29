/**
 * 纯函数工具集（无 Obsidian/DOM 依赖，便于单元测试）
 * 从 main.ts / translator.ts 提取，集中此处便于复用与回归测试。
 */

/** 去除首尾空白和尾斜杠，保留服务商的 API 路径及版本。 */
export function normalizeBaseUrl(raw: string): string {
	return (raw ?? "").trim().replace(/\/+$/, "");
}

/** 根地址默认使用 /v1；显式 API 路径（如智谱 /api/paas/v4）原样保留。 */
export function buildOpenAIEndpoint(raw: string, resource: "chat/completions" | "embeddings"): string {
	const base = normalizeBaseUrl(raw);
	const prefix = base.replace(/\/(?:chat\/completions|embeddings)$/i, "");
	const hasPath = /^https?:\/\/[^/]+\//i.test(base);
	return `${prefix}${hasPath ? "" : "/v1"}/${resource}`;
}

/**
 * 判定 Base URL 是否指向本机（localhost / 127.0.0.1 / [::1]）。
 *
 * 本地大模型（如 Ollama `http://localhost:11434`、LM Studio、vLLM 等）
 * 通常**不要求 API Key 鉴权**，留空 Key 是合法用法。此函数供「AI 是否可用」
 * 判定使用：本地地址时放宽对 Key 的强制要求，避免把无 Key 的本地模型误判为未配置。
 */
export function isLocalBaseUrl(raw: string): boolean {
	const u = (raw ?? "").trim();
	if (!u) return false;
	try {
		const root = new URL(u);
		return (
			root.protocol === "http:" &&
			/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(root.hostname)
		);
	} catch {
		return false;
	}
}

/**
 * 判定 AI 智能搜索是否可用（启用且鉴权就绪）。
 *
 * - 必须开启 `aiSearchEnabled`。
 * - Key 缺失时：仅当 Base URL 指向本机（无鉴权模型）才视为可用，
 *   否则仍需要 API Key。避免在本地模型场景卡死「未配置 API Key」。
 */
export function isAISearchUsable(
	enabled: boolean,
	baseURL: string,
	apiKey: string
): boolean {
	if (!enabled) return false;
	return isLocalBaseUrl(baseURL) || !!apiKey;
}

/**
 * 判定本地插件列表快照是否已「过期」，需要重新拉取（产品改进 #15）。
 * - lastFetchAt <= 0：从未拉取过 → 视为过期（应拉取）。
 * - now - lastFetchAt > ttlMs：超过有效期 → 过期。
 * 纯函数，便于单元测试，视图与 TTL 自动失效逻辑共用。
 */
export function isListStale(
	lastFetchAt: number,
	now: number,
	ttlMs: number
): boolean {
	// 从未拉取、或时间戳非法 → 视为过期（应拉取）
	if (!Number.isFinite(lastFetchAt) || lastFetchAt <= 0) return true;
	// now 非法（如 NaN）无法确定时效，保守按过期处理
	if (!Number.isFinite(now)) return true;
	// 时钟回拨（now 早于上次拉取）→ 视为未过期，不抛错
	if (now <= lastFetchAt) return false;
	// 严格超过有效期才过期（整点 TTL 仍视为有效，与 ensureDataLoaded 原逻辑一致）
	return now - lastFetchAt > ttlMs;
}

/**
 * 屏蔽描述末尾的「Obsidian 官方审核提示」句。
 *
 * 官方插件描述末尾常附「- 此插件尚未经过 Obsidian 工作人员的手动审核。」这类提示，
 * 属于平台免责声明而非插件功能信息，对中文用户是噪音。因官方源措辞不一（人工/手动、
 * 工作人员/官方/团队/员工），此处用正则统一匹配并剔除。
 *
 * 匹配要点：
 * - 总在描述末尾，锚定 $（兼容 . 或 。结尾）；
 * - 前导分隔符与「此/该插件」前缀可选；
 * - 主体为「尚未经过 Obsidian xxx 的?人工/手动审核」。
 *
 * 注意：不匹配「已通过审核」等正面表述（本插件上架即已人工审核，不会出现该句）。
 */
export function stripReviewNotice(text: string): string {
	if (!text) return text;
	// 中文变体（obsidian-releases 远程源 + 本地缓存共 10+ 种：官方/团队/工作人员/员工 × 人工/手动 × 有无"的" × 有无"尚"）
	// 要点：前缀 [\s\-—–。．]* 吞掉正文尾句号 + 列表分隔符；「此/该/插/件」均可选以覆盖无前缀变体；
	// 「尚」可选覆盖「尚未经过」与「未经过」两种措辞（用户截图里的 omni-viewer 即「未经过」无「尚」）；
	// [^审核]*? 容忍空格/大小写/标点差异；锚定 $ 保证只删末尾整句。
	const re = /[\s\-—–。．]*[此该]?插?件?尚?未经过[^审核]*?(?:人工|手动)\s*审核[。.]?\s*$/;
	return text.replace(re, "").trim();
}

/**
 * 清理中文文本中的多余空格：
 * 1. 去除两个中文字符之间的空格（中文字间不应有空格）
 * 2. 压缩多个英文空格为单个
 * 3. 去除首尾空白
 * 注意：不在此处剔除 Obsidian 官方审核句（仅卡片描述需要，见 stripReviewNotice，
 * 由调用方按需叠加；详情页描述保留原文）。
 */
export function cleanChineseSpaces(text: string): string {
	if (!text) return text;
	return text
		.replace(/([\u4e00-\u9fff\u3400-\u4dbf])\s+([\u4e00-\u9fff\u3400-\u4dbf])/g, "$1$2")
		.replace(/([\u4e00-\u9fff\u3400-\u4dbf])\s+([\u4e00-\u9fff\u3400-\u4dbf])/g, "$1$2")
		.replace(/  +/g, " ")
		.trim();
}

/**
 * 从可能夹杂说明文字的模型返回中截取首个 JSON 对象并解析。
 * 模型常在 JSON 前后附赠解释文字，因此用正则贪婪匹配最外层 {…}。
 */
/**
 * 将常见全角标点归一化为半角，提升对"不乖巧"模型的容错。
 * 部分国产后处理/采样会把 { } [ ] : , 输出成全角 ｛｝［］：， 导致 JSON.parse 失败。
 * 注意：仅在 JSON 结构层（引号外）做替换，保留字符串值内的全角标点。
 */
function normalizeJSONPunctuation(s: string): string {
	let result = "";
	let inString = false;
	let escape = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (escape) {
			result += c;
			escape = false;
			continue;
		}
		if (c === "\\") {
			result += c;
			escape = true;
			continue;
		}
		if (c === '"') {
			inString = !inString;
			result += c;
			continue;
		}
		if (inString) {
			result += c;
			continue;
		}
		switch (c) {
			case "｛": result += "{"; break;
			case "｝": result += "}"; break;
			case "［": result += "["; break;
			case "］": result += "]"; break;
			case "：": result += ":"; break;
			case "，": result += ","; break;
			case "＂": result += '"'; break;
			case "＇": result += "'"; break;
			default: result += c;
		}
	}
	return result;
}

export function parseJSON(content: string): Record<string, unknown> {
	const normalized = normalizeJSONPunctuation(content);
	const jsonMatch = normalized.match(/\{[\s\S]*\}/);
	if (!jsonMatch) {
		throw new Error(
			`AI 返回非 JSON 格式（模型未遵循格式要求）：${content.slice(0, 80)}`
		);
	}
	try {
		return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
	} catch {
		throw new Error("AI 返回的 JSON 解析失败（格式损坏）");
	}
}

/** 召回候选（与 translator.ts 的 AISearchCandidate 等价，但保持 utils 零依赖） */
export interface RecallCandidate {
	id: string;
	name: string;
	description: string;
	/** 中文名（译文，可选）：模糊标题路的第二匹配目标（如"番茄"命中 nameZh"迷你番茄钟"） */
	nameZh?: string;
}

// ──────────────────────────────────────────
// 标题模糊匹配（第三路检索器，借鉴 vault-curate 的 Jaro-Winkler）
// ──────────────────────────────────────────

/** Jaro 距离 ∈ [0,1]（1=完全一致）。在 UTF-16 码元上操作，对 BMP 中文单码元友好。 */
export function jaro(a: string, b: string): number {
	if (a === b) return 1;
	if (a.length === 0 || b.length === 0) return 0;
	const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
	const aMatches = new Array<boolean>(a.length).fill(false);
	const bMatches = new Array<boolean>(b.length).fill(false);
	let matches = 0;
	for (let i = 0; i < a.length; i++) {
		const start = Math.max(0, i - matchWindow);
		const end = Math.min(b.length - 1, i + matchWindow);
		for (let j = start; j <= end; j++) {
			if (bMatches[j]) continue;
			if (a[i] !== b[j]) continue;
			aMatches[i] = true;
			bMatches[j] = true;
			matches++;
			break;
		}
	}
	if (matches === 0) return 0;
	let k = 0;
	let transpositions = 0;
	for (let i = 0; i < a.length; i++) {
		if (!aMatches[i]) continue;
		while (!bMatches[k]) k++;
		if (a[i] !== b[k]) transpositions++;
		k++;
	}
	transpositions = transpositions / 2;
	return (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;
}

/** Jaro-Winkler：给匹配前缀（最多 4 字符）加权，scaling=0.1（Winkler 标准值）。 */
export function jaroWinkler(a: string, b: string): number {
	const j = jaro(a, b);
	if (j === 0) return 0;
	let prefix = 0;
	const max = Math.min(4, Math.min(a.length, b.length));
	for (let i = 0; i < max; i++) {
		if (a[i] === b[i]) prefix++;
		else break;
	}
	return j + prefix * 0.1 * (1 - j);
}

/**
 * 标题模糊匹配（第三路检索器）：把 query 与每个插件的 name / nameZh（中文名译文）
 * 分别做 Jaro-Winkler 取较高分，返回 `Map<插件id, 分数>`（相似度 ≥ minScore 且降序截断到 top）。
 *
 * 目的：覆盖「用户只记得插件名的大概/首字母/拼写，但记不全」的场景——
 * 关键词精确匹配与向量语义都可能漏，标题模糊匹配能兜住（如查 "番茄" 命中
 * "番茄钟番茄工作法"、"notion" 命中 "Notion 增强"）。
 * nameZh 作为第二目标后，中文查询对「英文原名 + 中文译名」的插件也能拼写容错
 * （如 "迷你番茄" 命中 name="Minidoro" nameZh="迷你番茄钟"；子串居中的短查询
 * 受 Jaro 匹配窗口限制打 0 分，由 BM25 三元组路兜底，两路互补）。
 *
 * @param query 用户输入
 * @param allPlugins 插件候选（用 name 与可选 nameZh）
 * @param top 最多保留多少条
 * @param minScore 相似度下限（默认 0.55，比 vault-curate 的 0.7 更宽松以兜住短名）
 */
/** 小写名缓存：插件 name/nameZh 固定，避免每次模糊搜索对每插件重复 toLowerCase（O(N) 字符串分配） */
const lowerNameCache = new Map<string, string>();

export function fuzzyTitleScores(
	query: string,
	allPlugins: RecallCandidate[],
	top = 50,
	minScore = 0.55
): Map<string, number> {
	const q = query.toLowerCase().trim();
	if (!q) return new Map();
	const out: Array<[string, number]> = [];
	// 字符粗筛用的 q 字符集（只算一次，避免每插件重建）
	const qChars = q.length > 0 ? new Set(q) : null;
	const lowerCached = (raw: string): string => {
		if (!raw) return "";
		let v = lowerNameCache.get(raw);
		if (v === undefined) {
			v = raw.toLowerCase();
			lowerNameCache.set(raw, v);
		}
		return v;
	};
	for (const p of allPlugins) {
		const title = lowerCached(p.name || "");
		const titleZh = lowerCached(p.nameZh || "");
		if (!title && !titleZh) continue;
		// 快速否决（严格安全）：q 的所有唯一字符都不在两个标题里 → 匹配字符必为 0，
		// Jaro 分数必为 0 < minScore，跳过完整 Jaro-Winkler。
		// 仅此严格情形可安全跳过（不改召回；任何有公共字符的情况仍跑 Jaro，避免误杀）
		if (qChars) {
			let allMissing = true;
			for (const ch of qChars) {
				if (title.indexOf(ch) !== -1 || titleZh.indexOf(ch) !== -1) { allMissing = false; break; }
			}
			if (allMissing) continue;
		}
		// 字符覆盖门（2026-09-18「打卡」真机截图暴露）：query ≤2 字时 Jaro 仅共享 1 字
		// 即得 (1/2+1/len+1)/3 ≥ 0.567，全过 0.55 阈值 → 「锁卡/桌卡/打印」等单字重叠
		// 家族 flood 顶部（50 条标题命中淹掉真目标）。门：query 全部字符出现在该标题
		// 才计分（「打卡」⊄「锁卡」拒、「打卡」⊂「打卡钟」留）；≥3 字 query 不动，
		// 保住 P-0061 的前缀/拼写容错场景。per-target 判定：两个标题各自独立过门。
		const strict = q.length <= 2;
		const covers = (t: string): boolean => {
			if (!strict || !qChars) return true;
			for (const ch of qChars) if (t.indexOf(ch) === -1) return false;
			return true;
		};
		const score = Math.max(
			title && covers(title) ? jaroWinkler(q, title) : 0,
			titleZh && covers(titleZh) ? jaroWinkler(q, titleZh) : 0
		);
		if (score >= minScore) out.push([p.id, score]);
	}
	out.sort((a, b) => b[1] - a[1]);
	return new Map(out.slice(0, top));
}

/** 归一化向量到单位长度（模长 0 时原样返回）。返回新数组。 */
export function normalizeVector(v: number[]): number[] {
	let norm = 0;
	for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
	norm = Math.sqrt(norm);
	if (norm === 0) return v;
	const out = new Array<number>(v.length);
	for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
	return out;
}

/**
 * 从一组条目向量中，取与 queryVec 余弦相似度最高的前 k 个。
 *
 * 实现为「有界最小堆」的部分选择，把选择阶段从 O(n log n) 降到 O(n log k)。
 *
 * 收益有限，别高估：实测（6000 条 × 512 维、k=300，见 scripts/bench-search-perf.mjs
 * 实验 3）整体约 1.35x。瓶颈其实是点积本身（n × dim 次乘加），选择阶段只占小头。
 * 曾以为「省下 n 个 { index, score } 对象分配」是主要收益，实测并不成立——改用并行
 * 类型化数组反而更慢（比较器要读两个数组，抵消了分配收益），故未采用。
 *
 * tie-break 与旧实现（score 降序 + Array.sort 稳定序）保持一致：同分按 index 升序。
 *
 * 维度不一致的条目会被拒绝并**整体抛错**（旧实现是静默按较短维度截断）。余弦在维度
 * 不同时没有定义，静默截断会把「索引与 query 来自不同 embedding 模型」这类 bug
 * 伪装成正常排序结果。
 *
 * @returns [{ index, score }]，按 score 降序，最多 k 个；k<=0 或无向量返回空。
 * @throws 存在与 queryVec 维度不同的条目时抛出（调用方应视为召回失败并降级）。
 */
export function topKBySimilarity(
	queryVec: number[],
	itemVecs: ArrayLike<ArrayLike<number>>,
	k: number,
	minScore = -1,
	allowedIndices?: ReadonlySet<number>,
): { index: number; score: number }[] {
	if (k <= 0 || !queryVec || queryVec.length === 0 || !itemVecs?.length) {
		return [];
	}
	const dim = queryVec.length;
	// 归一化 query（索引向量已在 buildVectorIndex 归一化，norm=1）
	const q = normalizeVector(queryVec);
	const n = itemVecs.length;
	const limit = Math.min(k, n);

	// 堆内并行数组：heapScore 是堆序键，heapIdx 只随交换同步搬运（不参与比较）。
	const heapIdx = new Int32Array(limit);
	const heapScore = new Float64Array(limit);
	let size = 0;

	/** a 是否比 b 更差（更差者浮到堆顶）。score 小者差；同分 index 大者差。 */
	const isWorse = (iA: number, sA: number, iB: number, sB: number): boolean =>
		sA < sB || (sA === sB && iA > iB);

	const swap = (a: number, b: number): void => {
		const ti = heapIdx[a];
		heapIdx[a] = heapIdx[b];
		heapIdx[b] = ti;
		const ts = heapScore[a];
		heapScore[a] = heapScore[b];
		heapScore[b] = ts;
	};

	const siftUp = (c: number): void => {
		while (c > 0) {
			const p = (c - 1) >> 1;
			if (!isWorse(heapIdx[c], heapScore[c], heapIdx[p], heapScore[p])) break;
			swap(c, p);
			c = p;
		}
	};

	const siftDown = (c: number): void => {
		for (;;) {
			const l = 2 * c + 1;
			if (l >= size) break;
			const r = l + 1;
			// 取左右孩子中更差的那个
			const m = r < size && isWorse(heapIdx[r], heapScore[r], heapIdx[l], heapScore[l]) ? r : l;
			if (!isWorse(heapIdx[m], heapScore[m], heapIdx[c], heapScore[c])) break;
			swap(c, m);
			c = m;
		}
	};

	// 纯点积：所有向量已归一化 → 余弦 = dot。单次扫描，避免任何 norm 计算。
	// itemVecs 元素为 ArrayLike<number>（number[] 或 Float32Array 均可），
	// 直接吃 getAllVecs 的 Float32Array，消除加载时的 Array.from 二次转换。
	let dimMismatch = 0;
	for (let vi = 0; vi < n; vi++) {
		if (allowedIndices && !allowedIndices.has(vi)) continue;
		const v = itemVecs[vi];
		// 维度必须一致：余弦在不同维度上没有定义。旧实现写 `i < dim && i < v.length`，
		// 对维度不一致的向量会**静默按较短维度截断** —— 于是「query 向量来自旧模型」
		// 这类 bug 会给出看似正常的错误排序，不报错、不告警（曾导致换 embedding 模型后
		// 静默错排）。这里改为显式拒绝，把同类问题从「悄悄算错」变成「立刻可见」。
		if (v.length !== dim) {
			dimMismatch++;
			continue;
		}
		let dot = 0;
		for (let i = 0; i < dim; i++) dot += q[i] * v[i];
		if (dot < minScore) continue;

		if (size < limit) {
			heapIdx[size] = vi;
			heapScore[size] = dot;
			siftUp(size);
			size++;
		} else if (isWorse(heapIdx[0], heapScore[0], vi, dot)) {
			// 优于当前堆顶（前 k 中最差的那个）→ 替换并重新下沉
			heapIdx[0] = vi;
			heapScore[0] = dot;
			siftDown(0);
		}
	}

	if (dimMismatch > 0) {
		throw new Error(
			`topKBySimilarity: 向量维度不一致（query=${dim} 维，${dimMismatch}/${n} 条条目维度不同）——` +
				`通常意味着索引与查询来自不同的 embedding 模型，或切换模型后索引未重建`
		);
	}

	const out: { index: number; score: number }[] = [];
	for (let i = 0; i < size; i++) out[i] = { index: heapIdx[i], score: heapScore[i] };
	out.sort((a, b) => b.score - a.score || a.index - b.index);
	return out;
}

/**
 * 稳定的内容指纹：用于判断插件库内容是否变化，从而决定是否需要重建向量索引。
 * 采用简单的 djb2 变体哈希（非加密，仅用于变更检测），对大量文本也很快。
 */
export function contentHash(texts: string[]): string {
	let h = 5381;
	for (const t of texts) {
		for (let i = 0; i < t.length; i++) {
			h = ((h << 5) + h + t.charCodeAt(i)) | 0;
		}
		h = ((h << 5) + h + 0x1f) | 0; // 分隔符，避免 ["ab","c"] 与 ["a","bc"] 撞车
	}
	// 转无符号十六进制
	return (h >>> 0).toString(16);
}

/**
 * Reciprocal Rank Fusion（RRF）—— 借鉴 vault-curate 的混合检索融合策略。
 *
 * 各检索器给出 {docId: score} 的打分，本函数在各自内部按分数降序排好名次后，
 * 对每个文档累加 `weight / (k + rank + 1)`。标准 k=60（TREC 文献）。
 *
 * 为何优于「并集取前 N」或直接线性加权：向量余弦分（约 0.3~0.9）与
 * 关键词分（整数 1~N）量纲不同，线性相加会被数值大的那路主导；RRF 只看
 * 名次、不看绝对分数，天然兼容异构分数，且两路都命中的文档会自然靠前。
 *
 * 融合后返回 docId → 融合分（降序由调用方自行排序/截取）。
 *
 * @param results 各检索器的 {docId: score} 映射（score 越大越相关）
 * @param weights 与各检索器一一对应的权重（0 表示该路不参与）
 * @param k RRF 常数，默认 60
 */
export function rrfFuse(
	results: Map<string, number>[],
	weights: number[],
	k = 60
): Map<string, number> {
	if (results.length !== weights.length) {
		throw new Error(
			`rrfFuse: results.length (${results.length}) !== weights.length (${weights.length})`
		);
	}
	const fused = new Map<string, number>();
	for (let i = 0; i < results.length; i++) {
		const w = weights[i];
		if (w === 0) continue; // 该路禁用则无贡献
		const ranked = Array.from(results[i].entries()).sort((a, b) => b[1] - a[1]);
		for (let rank = 0; rank < ranked.length; rank++) {
			const docId = ranked[rank][0];
			fused.set(docId, (fused.get(docId) ?? 0) + w / (k + rank + 1));
		}
	}
	return fused;
}

/** 把融合分 Map 转为降序的 [{id, score}] 并截取前 n 条 */
export function topNFused(
	fused: Map<string, number>,
	n: number
): Array<{ id: string; score: number }> {
	return Array.from(fused.entries())
		.sort((a, b) => b[1] - a[1])
		.slice(0, n)
		.map(([id, score]) => ({ id, score }));
}

/**
 * 从模型返回（已 JSON.parse）解析出召回候选列表。
 *
 * 容错策略：不同大模型在 prompt 明确要求 `{"indices": [...]}` 的情况下仍可能返回：
 *   - {"indices": [...]}    标准格式
 *   - {"ids": [...]}        直接给插件 ID 列表（最常见，DeepSeek 倾向如此）
 *   - {"ranking": [...]}    模型混淆了召回/精排两轮 prompt
 *   - {"plugins": [{id},…]} 嵌套结构
 *   - 顶层裸数组 [...]      模型省略了对象外壳
 * 这里按上述顺序逐一尝试，全部失败再抛错。
 *
 * 数值项既可能表示 batchPlugins 数组的索引（数字），也可能直接是插件 ID（字符串）。
 * 用「命中 batchPlugins[id 字段]」做歧义消解：先按 id 查 batchPlugins，命中即视为 ID；
 * 否则按数字索引查找，越界丢弃。
 */
export function parseRecallCandidates(
	parsed: unknown,
	batchPlugins: { id: string; name: string; description: string }[]
): RecallCandidate[] {
	if (!parsed || typeof parsed !== "object") {
		throw new Error("召回响应非对象");
	}
	const obj = parsed as Record<string, unknown>;

	const candidates: string[] = [];
	// 注意：只有「至少收进了一个候选」才算命中该字段。
	// 反例：`{"indices":[],"ids":["obsidian-git"]}` —— 若空数组也算命中，
	// 标准路径会被空的 indices 占住，真实候选所在的 ids 根本不会被读取，
	// 最终以「召回响应缺少可识别的候选字段」抛错，整批 LLM 兜底召回白做。
	const pushIfStringArray = (v: unknown) => {
		if (!Array.isArray(v)) return false;
		let hit = false;
		for (const x of v) {
			if (typeof x === "string" || typeof x === "number") {
				candidates.push(String(x));
				hit = true;
			}
		}
		return hit;
	};

	if (pushIfStringArray(obj.indices)) {
		// 标准路径
	} else if (pushIfStringArray(obj.ids)) {
		// 直接给 ID
	} else if (pushIfStringArray(obj.ranking)) {
		// 误用精排字段名
	} else if (Array.isArray(obj.plugins)) {
		// 嵌套结构
		for (const p of obj.plugins) {
			if (p && typeof p === "object" && typeof (p as Record<string, unknown>).id === "string") {
				candidates.push((p as Record<string, unknown>).id as string);
			}
		}
	} else if (Array.isArray(parsed)) {
		// 裸数组顶层
		for (const x of parsed) {
			if (typeof x === "string" || typeof x === "number") {
				candidates.push(String(x));
			}
		}
	}

	if (candidates.length === 0) {
		throw new Error("召回响应缺少可识别的候选字段（indices/ids/ranking/plugins/裸数组）");
	}

	const idToPlugin = new Map<string, (typeof batchPlugins)[number]>();
	for (const p of batchPlugins) idToPlugin.set(p.id, p);

	const out: RecallCandidate[] = [];
	const seen = new Set<string>();
	for (const raw of candidates) {
		const byId = idToPlugin.get(raw);
		if (byId) {
			if (!seen.has(byId.id)) {
				seen.add(byId.id);
				out.push({ id: byId.id, name: byId.name, description: byId.description });
			}
			continue;
		}
		if (/^\d+$/.test(raw)) {
			const idx = Number(raw);
			const p = batchPlugins[idx];
			if (p && !seen.has(p.id)) {
				seen.add(p.id);
				out.push({ id: p.id, name: p.name, description: p.description });
			}
		}
	}

	if (out.length === 0) {
		throw new Error("召回响应中的候选全部无法映射到本批插件");
	}
	return out;
}

/**
 * 从 OpenAI 兼容接口的响应 JSON 中提取「模型实际给我们的文本」并诊断 finish_reason。
 *
 * 不同厂商/模型在 content 为空时可能：
 *  - `message.refusal` 非空：模型拒答（安全/合规原因）
 *  - `message.tool_calls[0].function.arguments`：Function-calling 风格，部分模型走这条路
 *  - `finish_reason === "content_filter"`：被内容过滤器拦下
 *  - `finish_reason === "length"`：max_tokens 截断（但通常 content 仍非空）
 *  - `finish_reason === "tool_calls"`：同上，对应 tool_calls 路径
 *  - `choices` 多条：合并所有非空 content
 *
 * 抛出错误时把 finish_reason 与原始 content 摘要都带上，便于排查。
 */
export function extractLLMContent(responseJson: unknown): string {
	if (!responseJson || typeof responseJson !== "object") {
		throw new Error("AI 响应非 JSON 对象");
	}
	const json = responseJson as Record<string, unknown>;
	const choices = json.choices;
	if (!Array.isArray(choices) || choices.length === 0) {
		throw new Error("AI 响应缺少 choices 数组（模型/接口异常）");
	}

	const pieces: string[] = [];
	let sawRefusal = false;
	let refusalText = "";
	let sawToolCalls = false;
	let toolCallArgs = "";
	let lastFinishReason: string | null = null;

	for (const ch of choices) {
		if (!ch || typeof ch !== "object") continue;
		const choice = ch as Record<string, unknown>;
		const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : null;
		if (finishReason) lastFinishReason = finishReason;

		const message =
			choice.message && typeof choice.message === "object"
				? (choice.message as Record<string, unknown>)
				: null;
		if (!message) continue;

		if (typeof message.content === "string" && message.content.trim()) {
			pieces.push(message.content);
		}
		if (typeof message.refusal === "string" && message.refusal.trim()) {
			sawRefusal = true;
			refusalText = message.refusal;
		}
		if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
			sawToolCalls = true;
			const first = message.tool_calls[0] as Record<string, unknown> | undefined;
			const fn = first?.function as Record<string, unknown> | undefined;
			if (typeof fn?.arguments === "string" && fn.arguments.trim()) {
				toolCallArgs = fn.arguments;
			}
		}
	}

	if (pieces.length > 0) return pieces.join("\n");
	if (sawToolCalls && toolCallArgs) return toolCallArgs;
	if (sawRefusal) {
		throw new Error(`AI 拒答（${lastFinishReason ?? "refusal"}）：${refusalText}`);
	}

	const fr = lastFinishReason ?? "unknown";
	const tip =
		fr === "content_filter"
			? "触发内容安全过滤，可换模型或换表述"
			: fr === "length"
				? "达到 max_tokens 上限被截断，可尝试调大"
				: fr === "tool_calls"
					? "模型走了 Function-calling 但未给文本，可换模型或在 prompt 强调「直接返回 JSON 文本」"
					: "模型未生成内容，可尝试更换模型或检查模型名是否正确";
	throw new Error(`AI 返回空内容（finish_reason=${fr}，${tip}）`);
}

/**
 * 判断模型名是否属于「OpenAI 兼容 + 支持 response_format=json_object」白名单。
 * 用于在 callLLM 中选择是否注入 response_format 字段。
 *
 * 白名单覆盖主流国产 + 国外 + 部分本地小模型；其余模型（如未列出的实验模型）
 * 一律走普通模式以避免因字段不识别导致整次调用失败。
 */
export function supportsJsonMode(model: string): boolean {
	const m = (model || "").toLowerCase();
	return /^(gpt|deepseek|qwen|glm|moonshot|kimi|claude|llama|gemma|mistral|yi-|doubao|ernie|hunyuan|baichuan|abab|step|mixtral|qwen2|qwq)/.test(
		m
	);
}

/**
 * 带并发上限的异步映射：对 items 逐个调用 worker，同时进行的任务数不超过 concurrency。
 * 结果数组与 items 一一对应（保持原始索引顺序），worker 内部自行处理错误
 * （不应 reject，否则会中断整个池）。
 *
 * @param items       待处理项
 * @param concurrency 最大并发数（<=0 时按 1 处理）
 * @param worker      处理单项的异步函数，接收项与其索引
 */
export async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	const results = new Array<R>(items.length);
	if (items.length === 0) return results;

	const limit = Math.max(1, Math.min(concurrency, items.length));
	let cursor = 0;

	const runner = async () => {
		while (cursor < items.length) {
			const idx = cursor++;
			results[idx] = await worker(items[idx], idx);
		}
	};

	await Promise.all(Array.from({ length: limit }, () => runner()));
	return results;
}

/** 新增插件翻译增量统计（computePluginDelta 返回） */
export interface PluginDelta {
	/** 本次新冒出（之前未见）的插件 id */
	newIds: string[];
	/** 新增项中已被翻译的数量（source 非 original） */
	translated: number;
	/** 新增项中仍为原文兜底的数量 */
	untranslated: number;
	/** 是否首次加载（seen 为空）——首次不弹增量提示，仅记录基线 */
	isFirstLoad: boolean;
}

/**
 * 计算「新增插件翻译增量」：当前插件全集相对「已见过」集合的差量，及新增项的翻译状况。
 * 纯集合运算，零网络、零 API 成本；Notice 文案拼装与 seen 集合更新留在调用方。
 * @param currentIds 本次社区列表全量插件 id
 * @param seenIds 已见过的插件 id 集合
 * @param sourceOf 给定 id 返回其翻译来源（缺省视为 "original"）
 */
export function computePluginDelta(
	currentIds: Iterable<string>,
	seenIds: ReadonlySet<string>,
	sourceOf: (id: string) => string
): PluginDelta {
	const newIds: string[] = [];
	for (const id of currentIds) {
		if (!seenIds.has(id)) newIds.push(id);
	}
	const isFirstLoad = seenIds.size === 0;
	let translated = 0;
	let untranslated = 0;
	for (const id of newIds) {
		if (sourceOf(id) === "original") untranslated++;
		else translated++;
	}
	return { newIds, translated, untranslated, isFirstLoad };
}

/**
 * 防抖工具：把高频触发合并为一次执行。
 *
 * 统一收敛此前散落在 view-chrome / view-render / plugin 的三套手写
 * `setTimeout` + `clearTimeout` 逻辑（审计 P1-1），并暴露 `cancel/flush/pending`
 * 以满足持久化场景的「取消挂起 / 立即执行 / 卸载兜底判断是否挂起」需求。
 *
 * 语义：
 * - 调用 handle()：重置计时器，ms 后执行 fn（连续调用只保留最后一次）。
 * - handle.cancel()：取消挂起的计时器（不执行 fn）。
 * - handle.flush()：若挂起则立即执行 fn 并取消计时器（等价于「立即落盘」）。
 * - handle.pending()：是否存在挂起的计时器。
 */
export interface DebounceHandle {
	(): void;
	cancel(): void;
	flush(): void;
	pending(): boolean;
}

export function debounce(fn: () => void, ms: number): DebounceHandle {
	let timer: number | null = null;
	const run = () => {
		timer = null;
		fn();
	};
	const handle = (() => {
		if (timer != null) window.clearTimeout(timer);
		timer = window.setTimeout(run, ms);
	}) as DebounceHandle;
	handle.cancel = () => {
		if (timer != null) {
			window.clearTimeout(timer);
			timer = null;
		}
	};
	handle.flush = () => {
		if (timer != null) {
			window.clearTimeout(timer);
			timer = null;
			fn();
		}
	};
	handle.pending = () => timer != null;
	return handle;
}
