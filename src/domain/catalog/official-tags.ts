/**
 * 官方 manifest tags 中英对照。
 *
 * 背景：用户希望分类维度「和官方对齐」。实证发现官方 tags 覆盖率极低
 * （community-plugins.json 不含 tags，仅在各插件 manifest.json，且多数作者不填），
 * 故采用「增量双轨」策略：plugin-tags.json 的 tags = 中文自造词（基础层）
 * + 若插件官方 manifest 真带 tags 则【追加】官方英文 tag（增强层）。
 *
 * 本模块只负责把增强层的【英文官方 tag】在 UI 上渲染成「中文(tag)」对照形式，
 * 零覆盖、零回归：自造中文 tag 原样显示，英文官方 tag 走映射（无映射则显示原词）。
 */

/** 官方常见 tag → 中文对照（覆盖 Obsidian 官方 categories 与高频 manifest tags）。
 *  持续补全：官方新增 tag 若未命中映射，UI 会显示原英文词（空白期可接受）。 */
export const OFFICIAL_TAG_ZH: Record<string, string> = {
	// 官方 10 大类（community.obsidian.md/categories）
	appearance: "外观",
	data: "数据",
	developers: "开发",
	formats: "格式",
	knowledge: "知识",
	media: "媒体",
	organization: "组织",
	sharing: "分享",
	workflow: "工作流",
	writing: "写作",
	// 高频功能 tag（基于社区 manifest 常见填写）
	calendar: "日历",
	kanban: "看板",
	task: "任务",
	tasks: "任务",
	ai: "AI",
	productivity: "效率",
	notes: "笔记",
	note: "笔记",
	markdown: "Markdown",
	pdf: "PDF",
	theme: "主题",
	database: "数据库",
	graph: "图谱",
	search: "搜索",
	navigation: "导航",
	tag: "标签",
	tags: "标签",
	plugin: "插件",
	plugins: "插件",
	export: "导出",
	import: "导入",
	sync: "同步",
	backup: "备份",
	encryption: "加密",
	security: "安全",
	privacy: "隐私",
	publish: "发布",
	blog: "博客",
	canvas: "白板",
	board: "看板",
	table: "表格",
	tables: "表格",
	spreadsheet: "电子表格",
	diagram: "图表",
	mindmap: "思维导图",
	flashcards: "闪卡",
	education: "教育",
	learning: "学习",
	language: "语言",
	translation: "翻译",
	automation: "自动化",
	command: "命令",
	commands: "命令",
	template: "模板",
	templates: "模板",
	utility: "工具",
	utilities: "工具",
	integrations: "集成",
	integration: "集成",
	api: "API",
	dev: "开发",
	developer: "开发",
	editor: "编辑器",
	editing: "编辑",
	formatting: "格式化",
	links: "链接",
	linking: "链接",
	metadata: "元数据",
	frontmatter: "前置元数据",
	image: "图片",
	images: "图片",
	audio: "音频",
	video: "视频",
	weather: "天气",
	location: "位置",
	datetime: "日期时间",
	date: "日期",
	time: "时间",
	statistics: "统计",
	stats: "统计",
	mobile: "移动端",
	desktop: "桌面端",
};

/**
 * 把单个 tag 渲染为展示文本。
 * - 纯中文（自造层）→ 原样返回
 * - 英文（官方层）→ 命中映射返回「中文(英文)」，未命中返回原英文
 * 这样双轨标签在卡片/对比视图里自然共存、可读。
 */
export function formatOfficialTag(tag: string): string {
	if (!tag) return tag;
	// 含中文 → 视为自造词，原样
	if (/[一-龥]/.test(tag)) return tag;
	const key = tag.toLowerCase();
	const zh = OFFICIAL_TAG_ZH[key];
	// 中英文同形（如 ai→AI、api→API）不加括号，原样返回
	if (!zh || zh.toLowerCase() === tag.toLowerCase()) return tag;
	return `${zh}(${tag})`;
}
