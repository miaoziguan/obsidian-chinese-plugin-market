/**
 * 插件专属同义词表：中文口语/术语 → 英文别名。
 *
 * 动机：插件市场插件名大多是英文（Notion、Kanban、Mind Map…），中文用户常
 * 用中文口语搜索（"思维导图""笔记""同步"）。把 query 里的中文词扩展出英文
 * 别名，能让关键词路（BM25）命中英文插件名，提升"用中文搜英文名"的召回。
 *
 * 借鉴 vault-curate 的 expandQuery 思路（但 vault 里未接线，这里我们接入
 * BM25 query 管线）。只扩展 query，不改索引。
 */

/** 常见插件领域同义词（中文词 → 英文别名列表）。key 为中文词，value 为别名。 */
export const PLUGIN_SYNONYMS: Record<string, string[]> = {
	"思维导图": ["mind map", "mindmap", "markmap", "map"],
	"笔记": ["note", "notes", "obsidian"],
	"同步": ["sync", "syncing"],
	"看板": ["kanban"],
	"日历": ["calendar"],
	"番茄": ["pomodoro", "tomato", "focus"],
	"番茄钟": ["pomodoro"],
	"待办": ["todo", "task", "checklist"],
	"任务": ["task", "todo"],
	"清单": ["list", "checklist", "todo"],
	"表格": ["table", "database", "spreadsheet"],
	"数据库": ["database", "db", "sql"],
	"文件夹": ["folder", "directory"],
	"标签": ["tag", "tags"],
	"标签管理": ["tag", "tagging"],
	"关系图": ["graph", "graph view"],
	"图谱": ["graph", "graph view"],
	"日记": ["daily", "journal", "diary"],
	"周记": ["weekly", "journal"],
	"模板": ["template", "templater"],
	"引用": ["citation", "quote", "bibtex"],
	"文献": ["citation", "reference", "bibtex"],
	"搜索": ["search", "find"],
	"高亮": ["highlight", "mark"],
	"标注": ["highlight", "annotation", "annotate"],
	"翻译": ["translate", "translation"],
	"朗读": ["tts", "read", "speech"],
	"录音": ["record", "recording", "audio"],
	"语音": ["speech", "tts", "audio"],
	"图片": ["image", "img", "attachment"],
	"图片粘贴": ["paste", "image"],
	"附件": ["attachment", "file"],
	"文件": ["file", "attachment"],
	"网页": ["web", "page", "url"],
	"网页剪藏": ["clipper", "web", "save"],
	"剪藏": ["clipper", "web clipper"],
	"代码": ["code", "codeblock", "coder"],
	"编程": ["code", "developer"],
	"开发": ["developer", "dev", "code"],
	"导出": ["export", "pdf", "html"],
	"导入": ["import", "importing"],
	"发布": ["publish", "deploy", "share"],
	"分享": ["share", "publish"],
	"链接": ["link", "wikilink", "url"],
	"双链": ["wikilink", "backlink", "link"],
	"反链": ["backlink", "link"],
	"思维": ["thinking", "thought"],
	"AI": ["ai", "gpt", "llm", "openai"],
	"人工智能": ["ai", "gpt", "llm"],
	"统计": ["statistics", "stats", "count"],
	"图表": ["chart", "graph", "plot"],
	"图表分析": ["chart", "charting"],
	"数据分析": ["data", "analysis", "analytics"],
	"分析": ["analysis", "analytics", "stats"],
	"学习": ["learning", "study", "spaced repetition"],
	"间隔重复": ["spaced repetition", "anki", "srs"],
	"记忆": ["memory", "spaced repetition", "anki"],
	"写作": ["writing", "writer"],
	"编辑器": ["editor", "edit"],
	"预览": ["preview", "view"],
	"样式": ["style", "css", "theme"],
	"主题": ["theme", "css", "style"],
	"字体": ["font", "type"],
	"图床": ["image", "upload", "picgo"],
	"上传": ["upload", "image"],
	"备份": ["backup", "sync"],
	"版本": ["version", "git"],
	"版本控制": ["git", "version control"],
	"历史": ["history", "revision", "undo"],
	"恢复": ["recover", "restore", "undo"],
	"撤销": ["undo", "history"],
	"快捷键": ["hotkey", "shortcut", "keyboard"],
	"命令": ["command", "palette", "cmd"],
	"文件夹导航": ["file", "explorer", "navigation"],
	"导航": ["navigation", "nav", "breadcrumb"],
	"书签": ["bookmark", "favorite"],
	"收藏": ["favorite", "bookmark", "star"],
	"悬浮": ["hover", "popup", "preview"],
	"预览窗口": ["hover", "popup", "preview"],
	"阅读模式": ["reading", "read"],
	"编辑模式": ["source", "edit"],
	"密码": ["password", "encrypt", "lock"],
	"加密": ["encrypt", "encryption", "password"],
	"隐私": ["privacy", "encrypt"],
	"中文": ["chinese", "zh", "cn"],
	"英文": ["english", "en"],
	"拼写": ["spell", "spelling", "grammar"],
	"语法": ["grammar", "spell"],
	"校对": ["proofread", "grammar", "spell"],
	"摘录": ["excerpt", "quote", "highlight"],
	"摘要": ["summary", "summarize"],
	"字数": ["word count", "count", "stats"],
	"字数统计": ["word count", "count"],
	"滚动": ["scroll", "scrollbar"],
	"折叠": ["collapse", "fold"],
	"大纲": ["outline", "toc", "heading"],
	"目录": ["toc", "outline", "table of contents"],
	"标题": ["heading", "header", "h1"],
	"分割线": ["divider", "hr", "separator"],
	"代码高亮": ["highlight", "syntax", "code"],
	"语法高亮": ["syntax highlight", "highlight"],
	"图标": ["icon", "emoji"],
	"表情": ["emoji", "icon"],
	"角标": ["badge", "count"],
	"进度": ["progress", "bar"],
	"习惯": ["habit", "tracker"],
	"习惯追踪": ["habit tracker", "tracker"],
	"健身": ["fitness", "workout", "habit"],
	"运动": ["fitness", "exercise", "sport"],
	"健康": ["health", "fitness"],
	"冥想": ["meditation", "mindful"],
	"理财": ["finance", "money", "expense"],
	"记账": ["expense", "finance", "money"],
	"预算": ["budget", "finance"],
	"食谱": ["recipe", "food"],
	"美食": ["recipe", "food", "cooking"],
	"菜谱": ["recipe", "cooking"],
	"旅行": ["travel", "trip"],
	"行程": ["itinerary", "trip", "travel"],
	"天气": ["weather", "forecast"],
	"时区": ["timezone", "time"],
	"时间": ["time", "clock", "timer"],
	"日期": ["date", "day"],
	"年龄": ["age", "birthday"],
	"名字": ["name", "naming"],
	"命名": ["naming", "name"],
	"邮箱": ["email", "mail"],
	"邮件": ["email", "mail"],
	"微信": ["wechat", "weixin"],
	"浏览器": ["browser", "web"],
	"剪贴板": ["clipboard", "paste"],
	"复制": ["copy", "clipboard"],
	"剪切": ["cut", "clipboard"],
	"粘贴": ["paste", "clipboard"],
};

/** 扩展 query：把 query 中命中的中文词追加其英文别名到末尾（vault-curate 的 expandQuery 思路）。
 * 匹配先统一转小写，避免 "ai" 小写时不命中 "AI" 键；
 * 纯 ASCII 键（如 "AI"）用词边界 \b 匹配，避免误命中 "email"/"tai" 等含子串的词。 */
export function expandQuery(query: string): string {
	const q = query.toLowerCase();
	let expanded = query;
	for (const [cn, aliases] of Object.entries(PLUGIN_SYNONYMS)) {
		const key = cn.toLowerCase();
		const hit = /^[a-z0-9_-]+$/.test(key)
			? new RegExp(`\\b${escapeRegExp(key)}\\b`).test(q)
			: q.includes(key);
		if (hit) {
			expanded += " " + aliases.join(" ");
		}
	}
	return expanded;
}

/** 转义正则特殊字符（key 含 -/_ 等时避免 RegExp 解析错误） */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
