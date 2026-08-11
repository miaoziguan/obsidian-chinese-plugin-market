/**
 * 离线插件分类脚本（方案 A：预生成静态分类索引，零外部依赖版 · 精细化 v2）
 * ─────────────────────────────────────────────
 * 不调用任何外部 LLM API——分类规则由 AI agent 设计的中文关键词映射表完成，
 * 输入为随包词典 obsidian-translator-full-dict.json（5617 条，已含中文译名/译描），
 * 输出 plugin-tags.json（id → { category, tags }），随包发布，UI 零成本浏览。
 *
 * 相比 v1 的精细化改进：
 *   1. 引入【英文 id 信号】：很多插件中文译名很弱，但 id 含 calendar/kanban/theme
 *      等强信号，把 id 也纳入匹配并加权，显著降低“其他 / 笔记兜底”虚胖。
 *   2. 引入【优先级否决机制】：PRIORITY 数组定义分类硬优先级，命中高优先级“强信号”
 *      词时直接定类，不被“笔记/编辑/管理”等泛词喧宾夺主。
 *   3. 引入【二级强信号校正】：加权打分后用 STRONG 表做最终校正（kanban→任务、
 *      calendar/agenda→日历、theme/css→主题 等），语义更准。
 *   4. 细分长尾关键词 + 把“笔记与编辑”按语义拆出更多子信号，并随插件生态增长
 *      持续新增一级分类（UI 为网格渲染，新增分类仅多一个格子，无副作用）。
 *
 * 用法：npm run gen-tags
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 输入源：
 *   - 默认从官方 community-plugins.json 拉取（含 id/name/author/description/repo，
 *     不含 tags——官方 tags 仅在各插件 manifest.json 里）。
 *   - 可用 TAG_SRC 指定本地 community-plugins.json 路径（离线构建）。
 * 注意：旧的 obsidian-translator-full-dict.json（仅含译名）已弃用，不再作为数据源。
 */
const SRC = process.env.TAG_SRC ?? "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json";
const OUT = process.env.TAG_OUT ?? "plugin-tags.json";

/** 是否联网补全官方 manifest tags（增量对齐）。默认关，纯离线生成（category + 中文 tags）。 */
const ENABLE_OFFICIAL_TAGS = process.env.ENABLE_OFFICIAL_TAGS === "1";
/** 官方插件清单地址（与 SRC 默认同源） */
const PLUGINS_URL = SRC;

/** 一级分类（功能域，UI 已绑定，保持稳定）。
 *  在自有细分体系基础上，吸收了 Obsidian 官方社区市场（community.obsidian.md/categories）
 *  的维度灵感：官方 10 类（APPEARANCE/DATA/DEVELOPERS/FORMATS/KNOWLEDGE/MEDIA/
 *  ORGANIZATION/SHARING/WORKFLOW/WRITING）与我们的细分基本可对上，唯一明显缺口是
 *  FORMATS（格式与渲染：PDF/LaTeX/Org/CSV 等格式转换与渲染），已补为「格式与渲染」。
 *  此外，针对 AI 类插件快速增长的趋势，单独增设「AI 助手」类，吸纳聊天/提示词/
 *  语音转写/AI 集成等插件，避免未来海量 AI 插件堆积到「其他」。 */
const CATEGORIES = [
	"笔记与编辑",
	"任务与项目管理",
	"知识管理与双向链接",
	"白板与可视化",
	"表格与数据库",
	"格式与渲染",
	"日程与日历",
	"同步与备份",
	"文件与附件管理",
	"主题与外观",
	"命令与效率",
	"搜索与导航",
	"导出与发布",
	"隐私与安全",
	"开发与技术",
	"AI 助手",
	"游戏与娱乐",
	"学习辅助",
	"天气与位置",
	"界面与布局",
	"生活与社交",
	"学术与研究",
	"其他",
];

/**
 * 分类规则：每条 = { category, keywords, weight }。
 * 加权打分：统计每个分类命中的关键词权重和，取最高分者。
 *   - 中文长词（≥4 字）与 id 信号词额外 +1，提升专精度。
 *   - 平局按 RULES 顺序（专精度高的优先）。
 */
const RULES: { category: string; keywords: string[]; weight: number }[] = [
	{ category: "白板与可视化", weight: 3, keywords: ["白板", "画布", "思维导图", "流程图", "图形", "绘图", "手绘", "草图", "节点图", "关系图", "可视化", "图表", "mermaid", "excalidraw", "脑图", "diagram", "canvas", "架构图", "时序图", "甘特图可视化", "拓扑", "网络图", "xmind", "地图"] },
	{ category: "表格与数据库", weight: 3, keywords: ["表格", "数据库", "dataview", "csv", "字段", "行列", "sheet", "统计表", "数据表", "关系型", "元数据表格", "电子表格", "表格视图"] },
	{ category: "格式与渲染", weight: 3, keywords: ["pdf 渲染", "pdf 预览", "latex", "asciimath", "org mode", "org 模式", "pandoc", "格式转换", "markdown 渲染", "渲染增强", "代码块渲染", "数学公式", "公式", "callout", "admonition", "提示框", "脚注渲染", "目录渲染", "格式增强", "typst", "katex", "bibtex", "引用格式", "csv 渲染", "yaml 渲染", "高亮渲染", "obsidian latex", "mathjax", "图表渲染", "乐谱", "五线谱", "记谱法", "化学结构", "分子结构", "麻将牌", "招式谱", "铁拳", "形式律", "真值表", "定义列表", "转写", "拼音声调", "拼音", "buckwalter", "lilypond", "verovio", "spartito", "鼓谱", "vextab", "吉他谱", "计算器", "代数系统", "求解", "数学与逻辑", "反向互补", "DNA", "IPA", "TIPA", "精灵文", "音标记法", "HTML 文档", "writetex", "平板书写数学", "元音", "八字排盘"] },
	{ category: "任务与项目管理", weight: 3, keywords: ["任务", "待办", "清单", "看板", "kanban", "项目", "甘特", "gantt", "进度", "习惯", "目标", "里程碑", "工时", "敏捷", "sprint", "番茄", "pomodoro", "代办", "todo", " Eisenhower", "优先级矩阵", "google tasks", "marvin", "回顾", "review", "每日动态", "每日统计", "时间追踪", "遗忘曲线", "wakatime", "工时统计", "战役管理", "rpg", "追踪器", "追踪", "心情", "健身", "剧集", "保质期", "轻断食", "专注", "阵营", "扑克", "膳食", "订阅", "记账", "财务", "营养", "日志", "反思", "决策转盘", "膳食计划", "GTD", "搞定", "打卡", "连续打卡", "健康", "日历追踪", "分数", "记分", "范围网格", "对局"] },
	{ category: "日程与日历", weight: 3, keywords: ["日历", "日程", "日期", "时间轴", "timeline", "事件", "周计划", "月历", "clock", "提醒事项", "agenda", "倒计时", "农历", "节气", "时间表", "时间管理", "提醒", "闹钟"] },
	{ category: "同步与备份", weight: 3, keywords: ["同步", "备份", "git", "sync", "版本控制", "云同步", "dropbox", "onedrive", "webdav", "icloud", "自动保存", "快照", "多端", "rsync", "github", "异地备份", "增量备份", "文件推送", "远程仓库", "批量重装", "重装社区插件"] },
	{ category: "知识管理与双向链接", weight: 3, keywords: ["双向链接", "反链", "知识库", "标签管理", "图谱分析", "关系图谱", "卡片盒", "zk", "关联笔记", "链接图谱", "backlink", "卡片笔记", "obsidian graph", "知识图谱", "概念地图", "链接嵌入", "自动链接", "嵌入", "embed", "uri", "二跳链接", "孤立文件", "邻接矩阵", "笔记链接", "链接标题", "链接器", "跳转链接", "内部链接", "别名", "alias", "相对链接", "链接建议", "复选框", "checkbox", "标题转别名", "更新链接", "网络思维", "奇异新世界", "链接转换", "超链接", "链接树", "失效链接", "标签链接", "定义链接", "链接修复", "重链接", "链接器", "彩色标签", "页面属性", "标签清理", "标签组", "自动标签", "单选属性", "标签云", "维基链接", "一步链接", "缺失链接", "断链", "书架", "链接组织", "知识问答", "本地知识"] },
	{ category: "文件与附件管理", weight: 3, keywords: ["附件", "文件管理", "资源管理", "图片管理", "媒体库", "pdf", "视频", "音频", "文件夹", "重命名", "批量重命名", "导入", "附件管理", "图床", "资产管理", "图像", "相册", "文件树", "标签文件", "文件预览", "上传", "upload", "相机", "camera", "剪贴板图片", "文件浏览器", "文件移动", "侧载", "calibre", "书库", "媒体播放", "音频播放", "视频播放", "音乐", "播放器", "player", "媒体嵌入", "gif", "图片预览", "spotify", "mpv", "midi", "自动暂停", "音效台", "媒体网格", "外部文件卡片", "文件卡片", "图片链接", "小红书", "外部文件", "下载文件", "paperless", "文档链接", "归档", "社交归档", "媒体帖子", "音效板", "Last.fm", "最近播放"] },
	{ category: "主题与外观", weight: 2, keywords: ["主题", "外观", "样式", "css", "配色", "字体", "暗色", "亮色", "皮肤", "背景", "图标集", "theme", "横幅", "banner", "彩虹", "边框", "美化", "排版样式", "圆角", "高亮主题", "夜间模式", "隐藏界面", "界面隐藏", "图标替换", "窗口调整", "窗口设置", "隐藏侧栏", "状态栏隐藏", "electron 窗口", "彩色文字", "调色板", "颜色循环", "渐变", "模糊", "着色", "彩色工具栏", "图标", "禅模式", "无头模式", "全屏", "背景模糊", "工具栏", "多彩", "界面微调", "红绿灯", "亚克力", "半透明窗口", "置顶", "始终置顶", "浮动窗口", "布局管理", "动画", "便利贴", "多列布局", "拖拽", "可拖拽", "窗口透明", "隐藏元素", "修改界面", "迷你宠物", "游荡", "小组件"] },
	{ category: "命令与效率", weight: 2, keywords: ["命令", "快捷键", "快捷", "效率", "自动化", "宏", "模板", "snippet", "热键", "hotkey", "工作流", "一键", "批量操作", "格式化", "linter", "整理", "规整", "快捷输入", "正则替换", "命令面板", "鼠标手势", "快捷命令", "动作", "脚本按钮", "补全", "completion", "自动配对", "配对", "标签补全", "html 标签", "去除空白", "空白字符", "打字", "聚焦", "淡出聚焦", "缩放", "滚动", "标签切换", "标签页", "工作区", "悬停", "输入法", "符号配对", "标题编号", "编号", "插件管理", "插件分组", "插件更新", "测试插件", "brat", "用户插件", "实用工具", "螺丝刀", "状态栏", "成就", "语录", "提示文件", "灵感", "标签轮播", "标签限制", "缩小钉选", "恢复 tab", "恢复链接", "通知控制", "插件热重载", "插件重装", "当前文件", "点击提示", "窗口置顶", "后台托盘", "系统托盘", "全屏切换", "标签名", "功能区分隔", "浏览器接口", "功能键", "快捷键提示", "窗口透明", "discord", "计时器", "随机数生成", "打开插件设置", "打开标签设置", "文件差异", "差异", "压缩", "剪贴板", "片段管理", "粘贴增强", "懒加载", "延迟加载", "布局", "标签打开方式", "手机号", "Steam 验证", "令牌", "触发操作", "哨兵", "检测变更", "并排差异"] },
	{ category: "搜索与导航", weight: 2, keywords: ["搜索", "检索", "导航", "跳转", "书签", "大纲", "outline", "标签栏", "侧边栏", "面包屑", "筛选", "filter", "快速切换", "switcher", "目录树", "链接跳转", "最近文件", "路径", "标签筛选", "定位文件", "活动文件", "显示活动文件", "获取链接", "复制链接", "短链", "golinks", "上网", "冲浪", "浏览器打开", "链接命名", "外部链接", "网页", "surfing", "hacker news", "头条", "url 清理", "跟踪参数", "链接打开方式", "恢复链接打开"] },
	{ category: "导出与发布", weight: 2, keywords: ["导出", "发布", "分享", "博客", "网站", "html导出", "pdf 导出", "word", "markdown导出", "obsidian publish", "wordpress", "静态站点", "ppt", "幻灯", "presentation", "部署", "截图", "打印", "生成网页", "导出图片", "镜像", "mirror", "分享链接", "webhook"] },
	{ category: "隐私与安全", weight: 3, keywords: ["加密", "密码", "隐私", "安全", "密码库", "密钥", "权限", "脱敏", "敏感", "加密笔记", "锁", "lock", "私密", "指纹", "二次验证", "访问保护", "代理", "全局代理", "网络代理", "vpn"] },
	{ category: "开发与技术", weight: 2, keywords: ["代码", "开发", "api", "脚本运行", "插件开发", "python", "javascript", "regex", "正则", "json", "yaml", "sql", "终端", "命令行", "terminal", "dataviewjs", "技术文档", "代码片段", "代码块", "运行脚本", "shell", "node", "编程", "frontmatter", "元数据", "metadata", "uri 控制", "电子窗口", "obsidian uri", "教程", "调试", "stack overflow", "栈溢出", "技术集成", "插件代码", "代码高亮", "语法高亮", "模块修复", "require 模块", "键值存储", "持久键值", "组件库", "组件库下载", "数据透视表", "bases", "查询控制", "jira", "票据", "health", "仪表盘", "温度热力图", "插件评分", "svn", "devops", "查询引擎", "datacore", "Web3", "IPFS", "去中心化", "DeSci", "基础设施", "接口请求", "HTTP 链接"] },
	{ category: "AI 助手", weight: 3, keywords: ["ai", "人工智能", "大模型", "聊天", "聊天机器人", "对话", "对话流", "提示词", "prompt", "ChatGPT", "chatgpt", "GPT", "Claude", "Gemini", "OpenAI", "Whisper", "语音转文字", "语音输入", "语音转写", "智能体", "agent", "副驾", "copilot", "知识副驾", "总结", "摘要", "AI 集成", "AI 服务", "AI 功能", "LLM", "大语言模型", "生成图片", "AI 聊天", "提问", "AI 助手", "硅基", "机器学习", "神经网络", "语义搜索", "智能标签", "自动生成标签", "对话代理", "流式"] },
	{ category: "游戏与娱乐", weight: 3, keywords: ["国际象棋", "中国象棋", "象棋", "麻将", "万智牌", "mtg", "塔罗", "桌游", "角色扮演", "dnd", "trpg", "法术", "敌人与", "魔法物品", "阵型", "足球阵型", "奇幻", "世界构建", "随机生成", "棋盘", "棋子", "卡牌", "牌表", "对局", "变着树", "pathfinder", "DaggerHeart", "八", "八字排盘", "精灵文", "宠物", "像素宠物", "小猫", "挂件", "组件", "widget", "恶搞", "愚人节"] },
	{ category: "学习辅助", weight: 2, keywords: ["学习", "记忆", "复习", "闪卡", "flashcard", "间隔重复", "背单词", "单词", "阅读", "标注", "高亮", "翻译", "词典", "论文", "文献", "引用", "citation", "笔记法", "anki", "quiz", "测验", "笔记回顾", "spaced repetition", "校对", "语法", "拼写", "languagetool", "zotero", "readwise", "图书", "圣经", "经文", "日文注音", "振假名", "ruby", "语言学习", "外语", "RSS", "历史上的今天", "维基", "新闻", "史料", "历史资料", "文献管理", "电影资料", "电影", "电视剧", "流媒体", "观影", "题库", "测试", "考试", "八字", "占卜", "塔罗"] },
	{ category: "天气与位置", weight: 3, keywords: ["天气", "气象", "weather", "温度", "forecast", "地理位置", "地理坐标", "经纬度", "latitude", "longitude", "地图位置", "地图坐标", "geolocation", "mapbox", "tenki", "openweather", "当前天气", "天气显示", "位置感知", "位置时间线", "记录地点", "插入位置"] },
	{ category: "界面与布局", weight: 2, keywords: ["界面元素", "界面微调", "界面调整", "UI 微调", "UI元素", "UI 元素", "隐藏界面", "修改界面", "布局调整", "布局微调", "排列", "由下至上", "底部到顶部", "周起始", "一周起始", "标签限制", "标签数", "行内标题", "剧透", "隐藏信息", "揭示", "混淆", "符文", "短码", "emoji 码", "时间戳", "换行符", "末尾换行", "上下移动", "行移动", "重定向", "HTTPS 重定向", "界面隐藏", "元素隐藏", "禅模式", "无头模式", "全屏", "窗口调整", "窗口设置", "浮动窗口", "窗口透明", "置顶", "始终置顶", "背景模糊", "动画", "小组件", "便利贴", "迷你宠物", "游荡", "工具栏", "状态栏", "红绿灯", "拖拽", "可拖拽", "缩放", "滚动", "悬停"] },
	{ category: "生活与社交", weight: 2, keywords: ["天气", "捕获", "快速捕获", "主页", "home base", "首页", "记账", "账务", "客户", "供应商", "库存", "交易", "债务", "社区", "团体", "探访", "巴哈伊", "日记", "感受", "情绪", "通知", "toast", "规划器", "活动记录", "使用统计", "扩展活动", "清理", "仓库清理", "个人发展", "发展计划", "热力图", "星标", "时效", "最近文件", "memos", "条目", "上下文", "Telegram", "桥接", "社交归档", "外部文件卡片", "个人操作系统", "个人知识操作系统", "名字生成", "随机名字", "生成名字", "杂项", "元插件", "体验优化"] },
	{ category: "学术与研究", weight: 3, keywords: ["haskell", "文学化编程", "形式语言", "形式化方法", "量化研究", "质性研究", "编码与", "结构化文档", "文档生成器", "学术协议", "思想工具协议", "samepage", "fabric 集成", "wikidata", "文献管理", "引用生成", "bibtex 生成", "数据录入表单", "表单录入数据", "结构化数据录入", "表单方式录入", "录入结构化数据"] },
	// 兜底（最宽泛，权重最低，必须最后）：覆盖未命中具体分类的通用笔记/编辑场景。
	// 已分层——仅当完全没有更专精度信号时才落入，配合 STRONG/PRIORITY 把真正边缘的才进“其他”。
	{ category: "笔记与编辑", weight: 1, keywords: ["笔记", "编辑", "写作", "文本", "光标", "折叠", "排版", "日记", "daily note", "周记", "摘录", "引用块", "大纲笔记", "重构笔记", "拆分", "合并笔记", "markdown", " md", "内容", "文章", "查看器", "预览", "viewer", "阅读器", "面板", "视图", "侧边", "收集", "辅助", "助手", "便签", "草稿", "速记", "段落", "标点", "引用", "批注", "注脚", "脚注", "目录", "链接笔记", "vim", "emacs", "tab 键", "大小写", "行排布", "标题升降", "缩写", "插入新行", "有序列表", "上下标", "注释开关", "脑暴", "海明威", "禁止退格", "浮动标题", "标题级别", "新文件名", "定义列表", "随机名字", "奇幻命名", "填空练习", "键值列表", "Markdown 支持", "简体", "繁体", "中文转换", "长破折号", "破折号", "字数", "CJK", "元音图", "音标", "日语", "八字", "推文", "便利", "复制为 html", "复制区块", "粘贴", "末端换行", "中文标点"] },
];

/**
 * 强信号校正表：key 命中（中/英/id 任一）即【直接强制】归入对应分类，
 * 覆盖加权打分的平局或泛词误吞。优先级从高到低（数组顺序即优先级）。
 * 用于纠正“含 kanban 被笔记吞”“含 theme 被外观外分类吞”等典型错误。
 */
const STRONG: { category: string; signals: string[] }[] = [
	{ category: "任务与项目管理", signals: ["kanban", "看板", "gantt", "甘特", "todo", "待办", "番茄", "pomodoro", "habit", "习惯", "任务管理", "项目", "checklist", "清单"] },
	{ category: "日程与日历", signals: ["calendar", "日历", "agenda", "日程", "timeline", "时间轴", "clock", "提醒", "闹钟", "农历", "倒计时"] },
	{ category: "主题与外观", signals: ["theme", "主题", "css", "配色", "字体", "banner", "横幅", "皮肤", "夜间模式", "暗色", "亮色"] },
	{ category: "同步与备份", signals: ["sync", "同步", "git", "备份", "dropbox", "onedrive", "webdav", "icloud", "snapshot", "快照", "github"] },
	{ category: "白板与可视化", signals: ["canvas", "白板", "excalidraw", "mermaid", "diagram", "思维导图", "脑图", "流程图", "绘图", "手绘"] },
	{ category: "表格与数据库", signals: ["dataview", "表格", "数据库", "csv", "sheet", "电子表格"] },
	{ category: "格式与渲染", signals: ["latex", "asciimath", "org mode", "org 模式", "pandoc", "mathjax", "katex", "typst", "bibtex", "pdf 渲染", "pdf 预览", "callout", "admonition", "格式转换", "markdown 渲染", "数学公式", "公式", "代码块渲染", "wavedrom", "dmn"] },
	{ category: "知识管理与双向链接", signals: ["backlink", "反链", "双向链接", "图谱", "graph", "知识库", "卡片盒", "zk"] },
	{ category: "隐私与安全", signals: ["encrypt", "加密", "password", "密码", "lock", "锁", "隐私", "私密", "密钥"] },
	{ category: "开发与技术", signals: ["python", "javascript", "terminal", "终端", "shell", "regex", "正则", "代码", "code", "api", "sql", "yaml", "json", "dataviewjs", "脚本运行"] },
	{ category: "AI 助手", signals: ["ai", "聊天", "聊天机器人", "对话", "提示词", "prompt", "chatgpt", "gpt", "claude", "gemini", "openai", "whisper", "语音转", "大模型", "大语言模型", "llm", "智能体", "agent", "副驾", "copilot", "总结", "摘要", "AI 集成", "AI 服务", "机器学习", "神经网络", "语义搜索", "生成图片"] },
	{ category: "导出与发布", signals: ["publish", "发布", "export", "导出", "wordpress", "博客", "静态站点", "presentation", "幻灯", "ppt"] },
	{ category: "学习辅助", signals: ["flashcard", "闪卡", "anki", "间隔重复", "复习", "单词", "词典", "翻译", "citation", "引用", "文献", "论文", "quiz"] },
	{ category: "文件与附件管理", signals: ["attachment", "附件", "pdf", "视频", "音频", "图床", "文件夹", "文件管理", "媒体库", "image", "图像", "相册"] },
	{ category: "搜索与导航", signals: ["search", "搜索", "outline", "大纲", "switcher", "快速切换", "书签", "导航", "breadcrumb", "面包屑", "跳转"] },
	{ category: "命令与效率", signals: ["hotkey", "快捷键", "命令面板", "command", "宏", "macro", "模板", "template", "自动化", "automation", "linter", "格式化"] },
	{ category: "天气与位置", signals: ["weather", "天气", "气象", "经纬度", "latitude", "longitude", "mapbox", "tenki", "openweather", "geolocation", "当前天气"] },
	{ category: "界面与布局", signals: ["界面微调", "UI 微调", "UI元素", "界面元素", "隐藏界面", "修改界面", "布局调整", "由下至上", "周起始", "剧透", "混淆", "符文", "短码", "时间戳", "末尾换行", "重定向", "上下移动", "禅模式", "无头模式", "窗口透明", "置顶", "浮动窗口", "便利贴", "小组件", "迷你宠物", "游荡"] },
	{ category: "生活与社交", signals: ["捕获", "快速捕获", "主页", "home base", "记账", "账务", "社区", "团体", "日记", "情绪", "通知", "toast", "规划器", "热力图", "星标", "memos", "Telegram", "桥接", "个人操作系统", "名字生成", "杂项", "元插件"] },
	{ category: "学术与研究", signals: ["haskell", "文学化编程", "形式语言", "量化研究", "质性研究", "samepage", "fabric 集成", "wikidata", "文献管理", "数据录入表单"] },
];

/** 标签提取词表：从译名/译描抽取通用功能词（去重，最多 4 个） */
const TAG_VOCAB = [
	"白板", "思维导图", "流程图", "表格", "数据库", "任务", "看板", "甘特图", "日历",
	"日程", "同步", "备份", "Git", "图谱", "双向链接", "反链", "标签", "附件", "图片",
	"PDF", "视频", "音频", "主题", "样式", "字体", "命令", "快捷键", "模板", "自动化",
	"宏", "搜索", "导航", "大纲", "书签", "导出", "发布", "博客", "加密", "隐私",
	"代码", "API", "正则", "闪卡", "记忆", "翻译", "词典", "日记", "写作", "格式化",
	"图标", "云同步", "版本控制", "手绘", "草图", "关系图", "统计", "数据可视化",
	"OCR", "语音", "AI", "摘要", "总结", "图床", "媒体库", "截图", "幻灯",
];

/** 判断信号是否命中（中/英/id 任一包含即可；id 用原始小写便于匹配英文信号） */
function hit(text: string, lower: string, idLower: string, signal: string): boolean {
	const s = signal.toLowerCase();
	return (
		text.includes(signal) ||
		lower.includes(s) ||
		idLower.includes(s)
	);
}

/**
 * 分类灵感说明：本体系的细分维度吸收了 Obsidian 官方社区市场
 * （community.obsidian.md/categories）的分类思路——官方 10 类
 * （APPEARANCE/DATA/DEVELOPERS/FORMATS/KNOWLEDGE/MEDIA/ORGANIZATION/
 * SHARING/WORKFLOW/WRITING）与我们的细分基本可对上，唯一明显缺口是
 * FORMATS（格式与渲染），已补为独立的「格式与渲染」分类。
 */

function classify(id: string, name: string, desc: string): { category: string; tags: string[] } {
	const text = `${name} ${desc}`;
	const lower = text.toLowerCase();
	const idLower = id.toLowerCase();

	// 1. 加权打分取候选分类
	let bestCat = "其他";
	let bestScore = 0;
	for (const rule of RULES) {
		let score = 0;
		for (const kw of rule.keywords) {
			if (hit(text, lower, idLower, kw)) {
				// 长词（≥4 字，更专精度）+ id 命中强信号 额外加分
				const bonus = kw.length >= 4 ? 1 : 0;
				const idBonus = idLower.includes(kw.toLowerCase()) ? 1 : 0;
				score += rule.weight + bonus + idBonus;
			}
		}
		if (score > bestScore) {
			bestScore = score;
			bestCat = rule.category;
		}
	}
	let category = bestScore > 0 ? bestCat : "其他";

	// 2. 强信号校正：仅当加权结果落在【宽泛桶】（笔记与编辑 / 其他）时，
	//    才用 STRONG 优先级覆盖；若加权已给出具体分类则保留，避免夺走本属
	//    该类的插件（同时压低“其他”与“笔记兜底”虚胖）。
	const VAGUE = new Set(["笔记与编辑", "其他"]);
	if (VAGUE.has(category)) {
		for (const s of STRONG) {
			if (s.signals.some((sig) => hit(text, lower, idLower, sig))) {
				category = s.category;
				break; // 已按优先级，第一个命中即定
			}
		}
	}

	// 3. 标签抽取（译名优先 + 译描补充），去重最多 4——这是【中文自造词标签】，
	//    作为基础标签层。官方 manifest 的英文 tags 由 main() 在联网模式下【增量追加】
	//    （双轨并存，零覆盖损失，见 fetchOfficialTags）。
	const tags: string[] = [];
	const addTag = (t: string) => {
		if (t && !tags.includes(t) && tags.length < 4) tags.push(t);
	};
	for (const t of TAG_VOCAB) {
		if (text.slice(0, 24).includes(t)) addTag(t);
	}
	for (const t of TAG_VOCAB) {
		if (text.includes(t)) addTag(t);
	}
	if (tags.length === 0) addTag(category); // 兜底：至少带分类名
	return { category, tags };
}

/** 读取 community-plugins.json（本地文件或联网 URL） */
async function loadPlugins(): Promise<Record<string, { name: string; description: string; repo?: string }>> {
	if (existsSync(SRC)) {
		console.log(`[gen-tags] 读取本地清单: ${SRC}`);
		const arr = JSON.parse(readFileSync(SRC, "utf-8")) as { id: string; name: string; description: string; repo?: string }[];
		const map: Record<string, { name: string; description: string; repo?: string }> = {};
		for (const p of arr) map[p.id] = { name: p.name, description: p.description, repo: p.repo };
		return map;
	}
	console.log(`[gen-tags] 联网拉取清单: ${SRC}`);
	const res = await fetch(SRC);
	if (!res.ok) throw new Error(`下载社区清单失败: HTTP ${res.status}`);
	const arr = (await res.json()) as { id: string; name: string; description: string; repo?: string }[];
	const map: Record<string, { name: string; description: string; repo?: string }> = {};
	for (const p of arr) map[p.id] = { name: p.name, description: p.description, repo: p.repo };
	return map;
}

/** 若配置了 HTTPS_PROXY/https_proxy，启用代理 dispatcher（Node 18 原生 fetch 不读 env） */
async function setupProxy(): Promise<void> {
	const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
	if (!proxy) return;
	try {
		const { ProxyAgent, setGlobalDispatcher } = await import("undici");
		setGlobalDispatcher(new ProxyAgent(proxy));
		console.log(`[gen-tags] 已启用代理: ${proxy}`);
	} catch {
		console.warn(`[gen-tags] 警告：设置了代理但未安装 undici，将尝试直连（可能失败）`);
	}
}

/** 并发上限下的 map（避免一次性 5617 个请求打爆 GitHub raw） */
async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let cursor = 0;
	async function worker() {
		while (cursor < items.length) {
			const i = cursor++;
			results[i] = await fn(items[i], i);
		}
	}
	const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
	await Promise.all(workers);
	return results;
}

/**
 * 联网补全官方 manifest tags（增量对齐，双轨并存）。
 * 仅当插件 manifest 真带 tags 时，把官方英文 tag 追加到既有中文 tags 之后（去重）。
 * 失败/超时/无 tag 的插件保持原样（不阻断、不降级分类）。
 */
async function fetchOfficialTags(
	ids: string[],
	repoOf: (id: string) => string | undefined,
	out: Record<string, { category: string; tags: string[] }>,
): Promise<number> {
	let appended = 0;
	const CONCURRENCY = 8;
	await mapWithConcurrency(ids, CONCURRENCY, async (id) => {
		const repo = repoOf(id);
		if (!repo) return;
		const rawUrl = `https://raw.githubusercontent.com/${repo}/HEAD/manifest.json`;
		try {
			const res = await fetch(rawUrl);
			if (!res.ok) return;
			const manifest = (await res.json()) as { tags?: unknown };
			if (!Array.isArray(manifest.tags)) return;
			const official = manifest.tags.filter((t): t is string => typeof t === "string");
			if (official.length === 0) return;
			const cur = out[id].tags;
			for (const t of official) {
				if (!cur.includes(t)) {
					cur.push(t); // 官方英文 tag 追加在后
					appended++;
				}
			}
		} catch {
			/* 单插件失败容错：跳过，不影响整体 */
		}
	});
	return appended;
}

async function main() {
	await setupProxy();
	console.log(`[gen-tags] 读取插件清单: ${SRC}`);
	const dict = await loadPlugins();
	const ids = Object.keys(dict);
	console.log(`[gen-tags] 共 ${ids.length} 个插件`);

	// 基准：已有 plugin-tags.json（正确的中文分类体系，基于译名训练）。
	// 直接透传 category + 中文 tags，避免「换成英文原文输入」导致中文关键词分类体系失真。
	// 仅社区清单里【新增】的插件才用英文轻量分类（占比小，略糙可接受）。
	let base: Record<string, { category: string; tags: string[] }> = {};
	if (existsSync(OUT)) {
		base = JSON.parse(readFileSync(OUT, "utf-8"));
		console.log(`[gen-tags] 以现有 plugin-tags.json 为分类基准（${Object.keys(base).length} 条）`);
	}

	const out: Record<string, { category: string; tags: string[] }> = {};
	const dist: Record<string, number> = {};
	let newCount = 0;
	for (const id of ids) {
		if (base[id]?.category) {
			// 透传：保留既有正确中文分类 + 中文 tags（官方 tag 补全阶段会在此之上追加）
			out[id] = { category: base[id].category, tags: [...base[id].tags] };
		} else {
			// 新增插件：英文输入轻量分类（中文关键词命中率低，仅作兜底）
			const entry = dict[id];
			const { category, tags } = classify(id, entry.name, entry.description);
			out[id] = { category, tags };
			newCount++;
		}
		dist[out[id].category] = (dist[out[id].category] ?? 0) + 1;
	}
	console.log(`[gen-tags] 透传 ${ids.length - newCount} 条，新增分类 ${newCount} 条`);

	// 增量补全官方 manifest tags（需 ENABLE_OFFICIAL_TAGS=1 + 联网；幂等：已追加过的不重复）
	if (ENABLE_OFFICIAL_TAGS) {
		console.log("[gen-tags] 联网补全官方 manifest tags（增量追加）...");
		const repoOf = (id: string) => dict[id]?.repo;
		const appended = await fetchOfficialTags(ids, repoOf, out);
		console.log(`[gen-tags] 官方 tag 追加完成，本次新增 ${appended} 个标签映射`);
	} else {
		console.log("[gen-tags] 跳过官方 tag 补全（默认离线模式；如需补全设 ENABLE_OFFICIAL_TAGS=1）");
	}

	writeFileSync(OUT, JSON.stringify(out, null, 0), "utf-8");
	console.log("[gen-tags] 分类分布:");
	const ordered = [...CATEGORIES.filter((c) => dist[c]), ...Object.keys(dist).filter((c) => !CATEGORIES.includes(c))];
	for (const c of ordered) {
		console.log(`  ${c}: ${dist[c]}`);
	}
	console.log(`[gen-tags] 已写入 ${OUT}（${ids.length} 条）`);
}

main().catch((e) => {
	console.error("[gen-tags] 失败:", e);
	process.exit(1);
});
