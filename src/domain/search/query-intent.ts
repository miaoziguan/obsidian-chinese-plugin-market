/**
 * 语义搜索查询意图与轻量重排。
 *
 * 这层只消费候选文本和各召回路分数，不触碰向量索引或 LLM。它解决两类
 * 纯 RRF 不擅长的问题：自然语言否定（如「不要导出」）以及用户明确写出的
 * 功能短语（如「实时转换」「即时预览」「直接粘贴」）。
 */

import { expandQuery } from "@translation/lexicon/synonyms";
import { t2sForEmbed } from "@translation/lexicon/t2s";

export interface SearchCandidateText {
	id: string;
	name: string;
	description: string;
	nameZh?: string;
	descZh?: string;
}

export interface QueryIntentProfile {
	key: string;
	label: string;
	/** 用户 query 中出现这些词之一时启用该意图。 */
	queryTerms: string[];
	/** 候选文本中出现这些词之一时记为命中。 */
	candidateTerms: string[];
}

export interface ParsedQueryIntent {
	raw: string;
	/** 去除否定片段后交给关键词/向量召回的 query。 */
	recallQuery: string;
	positiveTerms: string[];
	negativeTerms: string[];
	/** query 只有排除条件、没有任何正向检索词。 */
	isPureNegative: boolean;
	/** 引号短语与内置功能短语，按原始用户语言保存。 */
	phrases: string[];
	activeProfiles: QueryIntentProfile[];
}

export interface SearchMatchDiagnostics {
	/** 各召回路的 1-based 名次；没有命中时为 null。 */
	keywordRank: number | null;
	vectorRank: number | null;
	titleRank: number | null;
	keywordScore: number | null;
	vectorScore: number | null;
	titleScore: number | null;
	rrfScore: number;
	rerankScore: number;
	matchedTerms: string[];
	phraseMatches: string[];
	intentMatches: string[];
	negativeMatches: string[];
}

/** 最近一次语义搜索的匹配证据快照，供设置页的搜索诊断面板读取。 */
export interface SearchMatchDiagnosticsSnapshot {
	query: string;
	mode: "ai" | "local";
	/** 精排后的结果顺序；诊断面板按此顺序展示前 N 个候选。 */
	rankedIds: string[];
	/** 插件 id → 展示名；快照不保存描述正文，避免诊断状态膨胀。 */
	labels: Record<string, string>;
	diagnostics: Record<string, SearchMatchDiagnostics>;
	at: number;
}

/**
 * 只保留已经在用户 query 中表达的意图，避免候选文本偶然出现「预览」时被
 * 无条件加分。候选侧再用 candidateTerms 做一次匹配。
 */
export const SEARCH_INTENT_PROFILES: QueryIntentProfile[] = [
	{
		key: "realtime-conversion",
		label: "实时转换",
		queryTerms: ["实时转换", "实时转化", "即时转换", "边输入边转换", "live conversion", "real-time conversion"],
		candidateTerms: ["实时转换", "实时转化", "即时转换", "边输入边转换", "自动转换", "live conversion", "real-time conversion", "on the fly"],
	},
	{
		key: "instant-preview",
		label: "即时预览",
		queryTerms: ["即时预览", "实时预览", "快速预览", "instant preview", "live preview"],
		candidateTerms: ["即时预览", "实时预览", "快速预览", "悬浮预览", "instant preview", "live preview", "preview"],
	},
	{
		key: "direct-paste",
		label: "直接粘贴",
		queryTerms: ["直接粘贴", "粘贴即用", "一键粘贴", "粘贴插入", "direct paste", "paste directly"],
		candidateTerms: ["直接粘贴", "粘贴即用", "一键粘贴", "粘贴插入", "paste directly", "paste", "clipboard"],
	},
	{
		key: "offline-local",
		label: "离线/本地处理",
		queryTerms: ["离线使用", "无需联网", "本地处理", "本地运行", "数据不出本地", "offline", "local-only", "without internet"],
		candidateTerms: ["离线", "无需联网", "本地处理", "本地运行", "本地模型", "不上传", "offline", "local", "on-device", "local-only"],
	},
	{
		key: "cross-device-sync",
		label: "跨设备同步",
		queryTerms: ["跨设备同步", "多设备同步", "自动同步", "同步到手机", "sync across devices", "cross-device sync"],
		candidateTerms: ["跨设备", "多设备", "自动同步", "同步到手机", "云同步", "sync", "cross-device", "cloud sync"],
	},
	{
		key: "batch-processing",
		label: "批量处理",
		queryTerms: ["批量处理", "批量转换", "批量导入", "批量导出", "batch processing", "bulk edit"],
		candidateTerms: ["批量处理", "批量转换", "批量导入", "批量导出", "批量", "batch", "bulk", "multiple files"],
	},
	{
		key: "quick-capture",
		label: "快速记录",
		queryTerms: ["快速记录", "快速捕捉", "一键记录", "快捷记录", "quick capture", "quick note"],
		candidateTerms: ["快速记录", "快速捕捉", "一键记录", "快捷记录", "收件箱", "quick capture", "quick note", "inbox", "capture"],
	},
	{
		key: "keyboard-command",
		label: "快捷键/命令入口",
		queryTerms: ["快捷键", "命令面板", "键盘操作", "keyboard shortcut", "command palette", "hotkey"],
		candidateTerms: ["快捷键", "命令面板", "键盘操作", "keyboard shortcut", "command palette", "hotkey", "shortcut"],
	},
	{
		key: "privacy-first",
		label: "隐私保护",
		queryTerms: ["隐私保护", "保护隐私", "数据不出本地", "不上传数据", "privacy", "private", "no telemetry"],
		candidateTerms: ["隐私保护", "保护隐私", "数据不出本地", "不上传数据", "隐私", "privacy", "private", "local-only", "no telemetry"],
	},
	{
		key: "task-project",
		label: "任务/项目管理",
		queryTerms: ["任务管理", "待办管理", "项目管理", "task management", "todo manager", "project management"],
		candidateTerms: ["任务管理", "待办", "任务", "项目管理", "task", "todo", "checklist", "project", "kanban"],
	},
	{
		key: "calendar-schedule",
		label: "日历/日程安排",
		queryTerms: ["日程安排", "日历视图", "日历同步", "日程管理", "calendar view", "calendar sync", "schedule"],
		candidateTerms: ["日历", "日程", "日历视图", "事件", "calendar", "schedule", "agenda", "event", "caldav"],
	},
	{
		key: "publish-web",
		label: "发布到网站",
		queryTerms: ["发布到网站", "发布博客", "个人网站", "静态网站", "publish notes", "publish to web", "blog"],
		candidateTerms: ["发布", "网站", "博客", "静态站点", "publish", "website", "blog", "static site", "deploy"],
	},
	{
		key: "format-conversion",
		label: "格式转换/导入导出",
		queryTerms: ["格式转换", "导入导出", "导出为 pdf", "转换成 markdown", "format conversion", "import/export", "convert files"],
		candidateTerms: ["格式转换", "导入", "导出", "转换", "import", "export", "convert", "pandoc", "pdf", "html"],
	},
	{
		key: "media-transcription",
		label: "音视频转写",
		queryTerms: ["语音转文字", "录音转写", "音频转录", "视频字幕", "speech to text", "audio transcription", "transcribe"],
		candidateTerms: ["转写", "转录", "字幕", "录音", "音频", "transcription", "transcript", "subtitle", "whisper", "recording"],
	},
	{
		key: "image-ocr",
		label: "图片识别/附件处理",
		queryTerms: ["图片文字识别", "截图识别", "图片管理", "附件处理", "image ocr", "text from image", "manage attachments"],
		candidateTerms: ["图片识别", "文字识别", "截图", "图片", "附件", "ocr", "image", "screenshot", "attachment"],
	},
	{
		key: "knowledge-graph",
		label: "知识图谱/链接关系",
		queryTerms: ["知识图谱", "关系图", "链接关系", "反向链接", "knowledge graph", "backlink graph", "link graph"],
		candidateTerms: ["知识图谱", "关系图", "反向链接", "双链", "graph", "graph view", "backlink", "wikilink", "link"],
	},
	{
		key: "table-database",
		label: "表格/数据库查询",
		queryTerms: ["数据库查询", "表格视图", "数据表", "表格管理", "database query", "table view", "dataview"],
		candidateTerms: ["数据库", "数据表", "表格", "查询", "database", "table", "query", "dataview", "spreadsheet"],
	},
	{
		key: "metadata-frontmatter",
		label: "元数据/属性管理",
		queryTerms: ["元数据管理", "frontmatter 管理", "属性管理", "字段管理", "metadata", "frontmatter", "properties"],
		candidateTerms: ["元数据", "frontmatter", "属性", "字段", "metadata", "frontmatter", "properties", "yaml", "field"],
	},
	{
		key: "template-automation",
		label: "模板/自动化工作流",
		queryTerms: ["模板变量", "模板自动化", "自动化工作流", "template automation", "templater", "workflow automation"],
		candidateTerms: ["模板", "自动化", "工作流", "脚本", "template", "templater", "automation", "macro", "workflow"],
	},
	{
		key: "research-citation",
		label: "文献/引用管理",
		queryTerms: ["文献管理", "参考文献", "文献引用", "学术写作", "citation manager", "reference manager", "zotero"],
		candidateTerms: ["文献", "引用", "参考文献", "学术", "citation", "reference", "bibliography", "bibtex", "zotero", "doi"],
	},
	{
		key: "spaced-repetition",
		label: "闪卡/间隔重复",
		queryTerms: ["间隔重复", "记忆卡片", "闪卡学习", "flashcard", "spaced repetition", "anki cards", "cloze"],
		candidateTerms: ["间隔重复", "闪卡", "记忆卡片", "flashcard", "spaced repetition", "anki", "cloze", "deck"],
	},
	{
		key: "ai-assistant",
		label: "AI 助手/对话",
		queryTerms: ["ai 助手", "人工智能助手", "ai 对话", "智能问答", "chatgpt", "ai assistant", "llm chat", "copilot"],
		candidateTerms: ["ai 助手", "智能问答", "对话", "人工智能", "ai", "gpt", "llm", "chat", "assistant", "copilot"],
	},
	{
		key: "mobile-first",
		label: "移动端体验",
		queryTerms: ["手机端", "移动端", "安卓端", "ios 端", "mobile app", "android", "ios", "phone"],
		candidateTerms: ["手机端", "移动端", "安卓", "苹果", "mobile", "android", "ios", "phone", "widget"],
	},
	{
		key: "canvas-visual",
		label: "画布/白板/可视化",
		queryTerms: ["画布", "画布笔记", "白板", "白板笔记", "思维导图", "流程图", "canvas", "whiteboard", "mind map", "diagram"],
		candidateTerms: ["画布", "白板", "思维导图", "流程图", "canvas", "whiteboard", "mind map", "diagram", "excalidraw", "tldraw"],
	},
	{
		key: "theme-ui",
		label: "主题/界面美化",
		queryTerms: ["主题美化", "界面美化", "自定义样式", "配色方案", "theme customization", "css style", "appearance"],
		candidateTerms: ["主题", "界面", "样式", "配色", "theme", "css", "style", "color", "appearance", "ui"],
	},
	{
		key: "file-attachments",
		label: "文件/附件管理",
		queryTerms: ["文件管理", "附件管理", "文件夹导航", "资源管理", "file manager", "attachment manager", "file explorer"],
		candidateTerms: ["文件管理", "附件管理", "文件夹", "资源", "file", "folder", "attachment", "asset", "explorer", "navigator"],
	},
	{
		key: "backup-version-control",
		label: "备份/版本控制",
		queryTerms: ["版本控制", "自动备份", "历史版本", "git 同步", "version control", "backup", "git", "revision history"],
		candidateTerms: ["备份", "版本控制", "历史版本", "恢复", "backup", "git", "version control", "revision", "restore", "repository"],
	},
	{
		key: "search-navigation",
		label: "搜索/导航/快速切换",
		queryTerms: ["全文搜索", "模糊搜索", "快速切换", "笔记导航", "full text search", "fuzzy search", "quick switcher", "navigation"],
		candidateTerms: ["搜索", "导航", "快速切换", "全文", "search", "fuzzy search", "quick switcher", "navigation", "explorer"],
	},
	{
		key: "language-dictionary",
		label: "翻译/词典/双语",
		queryTerms: ["翻译插件", "查词", "双语笔记", "语言学习", "translation", "dictionary", "bilingual", "language learning"],
		candidateTerms: ["翻译", "词典", "双语", "语言", "translation", "translate", "dictionary", "bilingual", "glossary"],
	},
	{
		key: "math-science",
		label: "数学公式/科学写作",
		queryTerms: ["数学公式", "公式编辑", "科学写作", "latex 公式", "math formula", "latex", "mathjax", "equation"],
		candidateTerms: ["数学公式", "公式", "科学写作", "latex", "mathjax", "formula", "equation", "math"],
	},
	{
		key: "rss-web-clipping",
		label: "RSS/网页剪藏/稍后读",
		queryTerms: ["rss 订阅", "网页剪藏", "稍后阅读", "阅读清单", "rss reader", "web clipper", "read later", "reading list"],
		candidateTerms: ["rss", "订阅", "网页剪藏", "稍后读", "阅读清单", "feed", "clipper", "web clipper", "read later", "bookmark"],
	},
	{
		key: "habit-focus",
		label: "习惯/专注/计时",
		queryTerms: ["习惯追踪", "专注计时", "番茄钟", "时间追踪", "habit tracker", "pomodoro", "focus timer", "time tracking"],
		candidateTerms: ["习惯", "专注", "计时", "番茄钟", "打卡", "habit", "tracker", "pomodoro", "timer", "streak", "heatmap"],
	},
	{
		key: "accessibility",
		label: "无障碍/阅读舒适度",
		queryTerms: ["无障碍阅读", "大字体", "护眼阅读", "阅读舒适", "accessibility", "font size", "dyslexia", "readability"],
		candidateTerms: ["无障碍", "大字体", "护眼", "阅读舒适", "accessibility", "font size", "dyslexia", "readability", "focus mode"],
	},
];

const NEGATION_PATTERNS = [
	/(?:不要|不需要|无需|不用|不想要|不想|避免|排除|去掉|不含|不带|拒绝|别)\s*([a-z0-9][a-z0-9_-]*|[\u4e00-\u9fff]{1,8})/gi,
	/(?:without|exclude|excluding|avoid|no)\s+([a-z0-9][a-z0-9_-]*(?:\s+[a-z0-9][a-z0-9_-]*)?)/gi,
];

const QUOTED_PHRASE_RE = /["“]([^"”]{2,})["”]/g;
const TOKEN_RE = /[a-z0-9]+|[\u4e00-\u9fff]{2,}/gi;
const EXPLICIT_NEGATIVE_RE = /(?:^|\s)-([^\s,，。！？!?；;]+)/g;

function normalize(value: string): string {
	return t2sForEmbed(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function unique(values: string[]): string[] {
	return Array.from(new Set(values.map(normalize).filter(Boolean)));
}

const variantCache = new Map<string, string[]>();

/** 从同义词扩展中提取可用于文本包含判断的变体。 */
function variants(term: string): string[] {
	const key = normalize(term);
	const cached = variantCache.get(key);
	if (cached) return cached;
	const expanded = expandQuery(key);
	const tokens = expanded.match(/[a-z0-9]+(?:\s+[a-z0-9]+)*|[\u4e00-\u9fff]+/gi) ?? [];
	const asciiFragments = tokens.flatMap((token) => token.split(/\s+/));
	const out = unique([key, ...tokens, ...asciiFragments]);
	variantCache.set(key, out);
	return out;
}

/** Query 触发词必须在用户输入里直接出现，不能用同义词扩展反推激活意图。 */
function includesQueryTerm(normalizedQuery: string, term: string): boolean {
	const normalizedTerm = normalize(term);
	if (!normalizedTerm) return false;
	// 英文触发词必须按词边界匹配，避免「digital」误触发 git、「daily」误触发 ai。
	if (/^[a-z0-9]+(?:\s+[a-z0-9]+)*$/i.test(normalizedTerm)) {
		const escaped = normalizedTerm
			.split(/\s+/)
			.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join("\\s+");
		return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(normalizedQuery);
	}
	return normalizedQuery.includes(normalizedTerm) || normalizedQuery.replace(/\s+/g, "").includes(normalizedTerm.replace(/\s+/g, ""));
}

function includesNormalized(normalizedText: string, term: string): boolean {
	return variants(term).some((v) => {
		// 短英文词（尤其 AI/RSS/PDF）用词边界，避免把 daily/press 等普通单词误判为命中。
		if (/^[a-z0-9]+$/i.test(v) && v.length <= 3) {
			const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(normalizedText);
		}
		return normalizedText.includes(v);
	});
}

function candidateText(candidate: SearchCandidateText): string {
	return [candidate.id, candidate.name, candidate.nameZh, candidate.description, candidate.descZh]
		.filter(Boolean)
		.join(" ");
}

/** 返回候选文本实际命中的否定词，供纯否定策略和诊断共用。 */
export function negativeMatchesForCandidate(candidate: SearchCandidateText, intent: ParsedQueryIntent): string[] {
	const normalizedText = normalize(candidateText(candidate));
	return intent.negativeTerms.filter((term) => includesNormalized(normalizedText, term));
}

/** 纯否定 query 的候选池：不让被排除的能力进入候选，再由调用方按中性质量排序。 */
export function pureNegativeCandidateIds(
	intent: ParsedQueryIntent,
	plugins: SearchCandidateText[],
	limit = plugins.length
): string[] {
	if (!intent.isPureNegative) return [];
	return plugins
		.filter((plugin) => negativeMatchesForCandidate(plugin, intent).length === 0)
		.slice(0, Math.max(0, limit))
		.map((plugin) => plugin.id);
}

function extractNegativeTerms(input: string): { text: string; terms: string[] } {
	let text = normalize(input);
	const terms: string[] = [];

	for (const pattern of NEGATION_PATTERNS) {
		text = text.replace(pattern, (_match, rawTerm: string) => {
			terms.push(normalize(rawTerm));
			return " ";
		});
	}
	text = text.replace(EXPLICIT_NEGATIVE_RE, (_match, rawTerm: string) => {
		terms.push(normalize(rawTerm));
		return " ";
	});

	return { text: text.replace(/\s+/g, " ").trim(), terms: unique(terms) };
}

/** 解析自然语言否定和已知的高价值功能短语。 */
export function parseQueryIntent(query: string): ParsedQueryIntent {
	const raw = query ?? "";
	const normalized = normalize(raw);
	const negative = extractNegativeTerms(normalized);
	const positiveTerms = unique(negative.text.match(TOKEN_RE) ?? []);
	const quoted = Array.from(normalized.matchAll(QUOTED_PHRASE_RE), (m) => m[1]);
	const activeProfiles = SEARCH_INTENT_PROFILES.filter((profile) =>
		profile.queryTerms.some((term) => includesQueryTerm(normalized, term))
	);
	const phrases = unique([
		...quoted,
		...activeProfiles.flatMap((profile) => profile.queryTerms.filter((term) => includesQueryTerm(normalized, term))),
	]);
	const recallQuery = negative.text.replace(/["“”']/g, " ").replace(/[,，、;；]+/g, " ").replace(/\s+/g, " ").trim();

	return {
		raw,
		recallQuery,
		positiveTerms,
		negativeTerms: negative.terms,
		isPureNegative: negative.terms.length > 0 && positiveTerms.length === 0,
		phrases,
		activeProfiles,
	};
}

function rankMap(scores: Map<string, number>): Map<string, number> {
	const ranked = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
	return new Map(ranked.map(([id], index) => [id, index + 1]));
}

function scoreMapValue(scores: Map<string, number>, id: string): number | null {
	const score = scores.get(id);
	return typeof score === "number" && Number.isFinite(score) ? score : null;
}

export interface RerankSearchCandidatesInput {
	intent: ParsedQueryIntent;
	ids: string[];
	plugins: SearchCandidateText[];
	fusedScores: Map<string, number>;
	keywordScores: Map<string, number>;
	vectorScores: Map<string, number> | null;
	titleScores: Map<string, number>;
	limit?: number;
}

export interface RerankSearchCandidatesResult {
	ids: string[];
	diagnostics: Record<string, SearchMatchDiagnostics>;
}

// 评测集校准后的轻量权重：保留 RRF 主导，只有明确短语/意图才改变近邻顺序。
const PHRASE_BOOST = 0.12;
const INTENT_BOOST = 0.08;
const NEGATIVE_PENALTY = 0.3;

/**
 * 对 RRF 前 N 条候选做小幅、可解释的乘性调整。
 *
 * RRF 仍是主排序信号；短语/意图只改变近邻顺序，否定命中则施加更明显的
 * 软惩罚。保留软惩罚而不是直接删除，避免「同时支持导入和导出」的插件因为
 * 描述提到导出就被误杀，且诊断里会明确暴露该命中。
 */
export function rerankSearchCandidates(input: RerankSearchCandidatesInput): RerankSearchCandidatesResult {
	const limit = Math.max(0, Math.min(input.limit ?? input.ids.length, input.ids.length));
	const pluginsById = new Map(input.plugins.map((plugin) => [plugin.id, plugin]));
	const keywordRanks = rankMap(input.keywordScores);
	const vectorRanks = input.vectorScores ? rankMap(input.vectorScores) : new Map<string, number>();
	const titleRanks = rankMap(input.titleScores);
	const original = input.ids.slice(0, limit);
	const diagnostics = new Map<string, SearchMatchDiagnostics>();

	const ranked = original.map((id, originalIndex) => {
		const plugin = pluginsById.get(id);
		const text = plugin ? candidateText(plugin) : id;
		const normalizedText = normalize(text);
		const matchedTerms = input.intent.positiveTerms.filter((term) => includesNormalized(normalizedText, term));
		const phraseMatches = input.intent.phrases.filter((phrase) => includesNormalized(normalizedText, phrase));
		const intentMatches = input.intent.activeProfiles
			.filter((profile) => profile.candidateTerms.some((term) => includesNormalized(normalizedText, term)))
			.map((profile) => profile.label);
		const negativeMatches = plugin
			? negativeMatchesForCandidate(plugin, input.intent)
			: input.intent.negativeTerms.filter((term) => includesNormalized(normalizedText, term));
		const rrfScore = input.fusedScores.get(id) ?? 0;
		const multiplier = Math.max(
			0.3,
			Math.min(
				1.4,
				1 + phraseMatches.length * PHRASE_BOOST + intentMatches.length * INTENT_BOOST - negativeMatches.length * NEGATIVE_PENALTY,
			)
		);
		const rerankScore = rrfScore * multiplier;
		const entry: SearchMatchDiagnostics = {
			keywordRank: keywordRanks.get(id) ?? null,
			vectorRank: vectorRanks.get(id) ?? null,
			titleRank: titleRanks.get(id) ?? null,
			keywordScore: scoreMapValue(input.keywordScores, id),
			vectorScore: input.vectorScores ? scoreMapValue(input.vectorScores, id) : null,
			titleScore: scoreMapValue(input.titleScores, id),
			rrfScore,
			rerankScore,
			matchedTerms,
			phraseMatches,
			intentMatches,
			negativeMatches,
		};
		diagnostics.set(id, entry);
		return { id, originalIndex, rerankScore };
	});

	ranked.sort((a, b) => b.rerankScore - a.rerankScore || a.originalIndex - b.originalIndex);
	return {
		ids: ranked.map((item) => item.id),
		diagnostics: Object.fromEntries(ranked.map((item) => [item.id, diagnostics.get(item.id)!])),
	};
}
