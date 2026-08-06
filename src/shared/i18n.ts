/**
 * 界面文案（纯中文）
 *
 * 插件面向中文区 Obsidian 用户，界面只需中文。
 * - 文案集中在本文件的字典里，UI 代码调用 t(key)。
 * - 纯函数优先：t / pickLang 不依赖 Obsidian 运行时，可直接单测。
 */

/**
 * 文案字典：key → 中文文案。
 * 新增 UI 文案时在此登记，UI 处用 t("key") 取用。
 */
export const STRINGS = {
	// 通用
	"app.search": { zh: "插件搜索" },
	"app.loading": { zh: "加载中" },
	"stats.fetching": {
		zh: "正在拉取社区插件列表…",

	},
	"stats.plugins": { zh: "插件" },
	"stats.cache": { zh: "缓存" },

	// 搜索引导
	"guide.title": { zh: "搜索中文区插件" },
	"guide.hint": {
		zh: "在上方输入关键词，即可检索并展示社区插件卡片。支持 AI 语义、名称、作者等多种搜索方式。",

	},
	"guide.examples": { zh: "试试" },

	// 搜索模式
	"mode.keyword": { zh: "关键词" },
	"mode.local": { zh: "本地语义" },
	"mode.ai": { zh: "AI 语义" },
	// 搜索模式引导行（无查询时在搜索栏下方显示，帮助用户理解「何时用哪种模式」）
	"mode.guidance.keyword": { zh: "搜中文名、原名、作者；支持高级语法" },
	"mode.guidance.local": { zh: "本地向量语义召回，离线、免 API，按相关度排序" },
	"mode.guidance.ai": { zh: "用自然语言描述需求，AI 召回并排序" },
	"sort.popular.hint": {
		zh: "未安装插件置顶，已安装沉底，其余按下载量与更新时间排序——帮你聚焦尚未决策的插件。",

	},

	// 手动刷新（产品改进 #15）
	"action.refresh": { zh: "刷新列表" },
	"action.refresh.done": { zh: "已更新到最新插件列表" },
	// 智能混合翻译（AI 优先，失败自动降级 Google/MyMemory/腾讯免费引擎）
	"action.aiTranslate": { zh: "智能混合翻译" },
	"action.aiTranslate.disabled": { zh: "智能混合翻译（未配置）" },
	"ai.translate.guide": { zh: "配置 AI 搜索 API Key 后优先用 AI 翻译，未配置则自动使用 Google/MyMemory/腾讯免费引擎混合翻译" },
	"ai.translate.progress": { zh: "混合翻译中 {done}/{total}" },
	"ai.translate.done": { zh: "已用混合翻译 {n} 个插件" },
	"ai.translate.running": { zh: "混合翻译进行中…" },
	"ai.translate.rerun": { zh: "正在「未翻译」筛选态，点击重新翻译" },
	"ai.translate.hint": { zh: "还有 {n} 个插件未翻译，点击智能混合翻译" },
	"ai.translate.free": { zh: "未配置 AI，将使用 Google/MyMemory/腾讯免费引擎混合翻译" },
	"ai.translate.none": { zh: "当前列表内所有插件均已翻译" },
	// 刷新后的「新增插件翻译增量」提示（本地集合 diff，无需网络）
	"refresh.newPlugins": { zh: "本次新增 {n} 个插件" },
	"refresh.newTranslated": { zh: "已自动翻译 {n} 个" },
	"refresh.newUntranslated": { zh: "未译 {n} 个" },
	"stats.updatedAt": { zh: "上次更新" },
	"time.minutesAgo": { zh: "{n} 分钟前" },
	"time.daysAgo": { zh: "{n} 天前" },
	"placeholder.keyword": {
		zh: "搜索插件名称或作者...",

	},
	"placeholder.local": {
		zh: "本地语义搜索，如「做思维导图的插件」...",

	},
	"placeholder.ai": {
		zh: "用自然语言描述需求，如「做思维导图的插件」...",

	},
	// AI 等待提示
	"ai.pending.title": { zh: "按 Enter 运行 AI 语义搜索" },
	"ai.pending.hint": {
		zh: "AI 模式会理解自然语言需求（如「做思维导图的插件」），按 Enter 后由 AI 召回并排序。",

	},

	// 加载失败
	"error.title": { zh: "加载失败" },
	"error.fetch": {
		zh: "无法获取社区插件列表：",

	},
	"error.retry": { zh: "重试" },
	"error.mirror": { zh: "切换镜像并重试" },
	"error.guide": { zh: "返回搜索引导" },

	// 加载进度（UX: 分阶段提示，减少等待焦虑）
	"loading.translating": { zh: "正在合并离线翻译词典…" },
	"loading.tm.resolving": { zh: "正在准备翻译记忆库索引…" },
	"loading.tm.scanning": { zh: "正在扫描翻译记忆库… {current}/{total}" },
	"loading.tm.indexing": { zh: "正在索引已采纳译名… {current}/{total}" },
	"loading.tm.merging": { zh: "正在合并离线翻译词典… {current}/{total}" },
	"loading.tm.done": { zh: "已加载 {total} 条翻译记忆，正在合并…" },

	// 空状态
	"empty.noData": { zh: "暂无数据" },
	"empty.noData.filter": {
		zh: "当前筛选条件下没有插件。切换上方筛选胶囊试试。",

	},
	"empty.noMatch": { zh: "未找到匹配的插件" },
	"empty.clearFilter": {
		zh: "试试更换关键词，或清除来源筛选查看全部结果。",

	},
	"empty.clearAction": { zh: "清除筛选查看全部" },
	"empty.tryAI": { zh: "试试 AI 语义搜索" },
	"empty.tryKeyword": { zh: "试试关键词搜索" },
	"empty.ai.hint": {
		zh: "用自然语言描述你的需求，如「做思维导图的插件」，按 Enter 触发 AI 召回+排序。",

	},
	"empty.local.pending": { zh: "按 Enter 运行本地语义搜索" },
	"empty.local.hint": {
		zh: "本地语义模式用向量召回相关插件（离线、免 API）。按 Enter 触发。",

	},

	// 来源标签
	"source.custom": { zh: "自定义" },
	"source.bulk": { zh: "批量词典" },
	"source.online": { zh: "在线翻译" },
	"source.ai": { zh: "AI翻译" },
	"source.original": { zh: "未翻译" },

	// 官方推荐（羽鳞君策划，随包发布的 plugin-recommend.json）
	"recommend.badge": { zh: "推荐" },
	"recommend.filter": { zh: "推荐" },
	"recommend.title": { zh: "官方推荐" },
	"recommend.section.collapse": { zh: "收起" },
	"recommend.section.expand": { zh: "展开" },

	// 卡片操作
	"card.detail": { zh: "详情" },
	"card.copy": { zh: "复制 ID" },
	"card.copy.done": { zh: "已复制 ✓" },
	"card.copy.fail": { zh: "复制失败" },
	"card.repo": { zh: "打开仓库" },
	"card.market": { zh: "社区市场" },
	"card.install": { zh: "安装" },
	"card.favorite": { zh: "收藏" },
	"card.insight": { zh: "了解功能" },
	"card.sysTranslate": { zh: "系统翻译" },
	"card.sysTranslate.readme": { zh: "macOS 翻译" },
	"card.sysTranslate.done": { zh: "已用系统翻译补全" },
	"card.sysTranslate.partial": { zh: "系统翻译完成，其中 {n} 段失败已保留原文（可稍后重试）" },
	"card.sysTranslate.fail": { zh: "系统翻译失败（请确认「快捷指令」App 中有名为「CPM 系统翻译」的指令，且为：接收输入 → 翻译文本到中文 → 停止并输出）" },
	"card.desc.expand": { zh: "展开" },
	"card.desc.collapse": { zh: "收起" },
	"card.original.hint": { zh: "未翻译 · 在线翻译未命中，可手动补译" },
	"card.name.toggleOriginal": { zh: "点击显示英文原名" },
	"card.name.toggleBack": { zh: "点击返回中文译名" },
	"card.installed.on": { zh: "已启用" },
	"card.author.tip": { zh: "作者：{author}（点击只看该作者的插件）" },
	"card.installed.off": { zh: "已安装" },
	"card.enable": { zh: "启用" },
	"favorite.added": { zh: "已收藏" },
	"favorite.removed": { zh: "已取消收藏" },

	// 详情弹窗
	"detail.back": { zh: "← 返回" },
	"detail.drawer.close": { zh: "关闭" },
	"detail.drawer.title": { zh: "插件详情" },
	"detail.author": { zh: "作者" },
	"detail.id": { zh: "ID" },
	"detail.downloads": { zh: "下载量" },
	"detail.updated": { zh: "最近更新" },
	"detail.status": { zh: "状态" },
	"detail.readme": { zh: "README" },
	"detail.readme.loading": { zh: "正在加载 README…" },
	"detail.readme.empty": { zh: "README 内容为空。" },
	"detail.readme.noRepo": {
		zh: "该插件未提供仓库信息，无法加载 README。",

	},
	"detail.readme.noUrl": { zh: "无法构造 README 地址。" },
	"detail.readme.backOriginal": { zh: "返回原文" },
	"detail.readme.translate": { zh: "翻译 README" },
	"detail.readme.translating": { zh: "翻译中…" },
	"detail.readme.showOriginal": { zh: "查看原文" },
	"detail.readme.translateFailed": { zh: "翻译失败，请重试。" },
	"detail.readme.noContent": { zh: "请先加载 README。" },
	"detail.readme.noTranslator": {
		zh: "请先在设置中配置 LLM（AI 搜索）或腾讯翻译 API。",
	},
	// 一键了解功能（基于仓库 manifest 元数据，不读 README）
	"detail.insight": { zh: "了解功能" },
	"insight.descHint": { zh: "综合 manifest、main.js 实际命令与 README 由 AI 生成（缓存 24 项以内，旧版自动重算）" },
	"insight.noContent": { zh: "暂无可用信息。" },
	"insight.noAI": { zh: "未配置 AI，已显示官方描述。" },
	"insight.loading": { zh: "正在了解插件功能…" },
	"insight.failed": { zh: "了解功能失败" },
	// 相似推荐面板
	"detail.similar": { zh: "相似推荐" },
	"detail.similar.none": { zh: "暂无相似推荐" },
	"detail.similar.hint": { zh: "基于同分类和功能标签推荐" },
	"detail.similar.more": { zh: "查看更多" },
	"detail.similar.installed": { zh: "已安装" },

	// 设置面板
	"settings.title": { zh: "插件搜索设置" },
	"settings.engineAndAi": { zh: "翻译引擎" },
	"settings.engineAndAi.desc": { zh: "翻译引擎配置（批量词典、MyMemory、腾讯 API）。" },
	"settings.dataSource": { zh: "数据源" },
	"settings.dataSource.desc": { zh: "选择插件列表的镜像数据源；自建/代理场景可填自定义镜像地址。" },
	"settings.cacheQuality": { zh: "缓存与质量" },
	// AI 能力
	"settings.ai.title": { zh: "AI 能力" },
	"settings.ai.title.desc": { zh: "配置 AI 语义搜索、排序理由和深度对比功能所需的接口参数" },
	// 自托管翻译源（DeepLX / LibreTranslate）
	"settings.selfHosted.title": { zh: "自托管翻译源（可选）" },
	"settings.selfHosted.desc": {
		zh: "填你本机运行的 DeepLX / LibreTranslate 地址（如 http://localhost:1188），质量优先且零成本、数据不出本机。留空则不启用，不影响现有免费翻译。DeepLX 质量优于 LibreTranslate，多源按质量序自动排序。",
	},
	"settings.selfHosted.empty": { zh: "尚未配置自托管翻译源，使用默认免费翻译（Google / MyMemory）。" },
	"settings.selfHosted.add": { zh: "添加翻译源" },
	"settings.selfHosted.addBtn": { zh: "+ 添加" },
	"settings.selfHosted.type.deeplx": { zh: "DeepLX" },
	"settings.selfHosted.type.libretranslate": { zh: "LibreTranslate" },
	"settings.ai.enable": { zh: "启用 AI 能力" },
	"settings.ai.enable.desc": {
		zh: "开启后一键翻译与语义搜索同时生效，关闭则回退到免费机翻。",
	},
	"settings.ai.baseUrl": { zh: "API Base URL" },
	"settings.ai.baseUrl.desc": {
		zh: "OpenAI 兼容接口地址。默认 DeepSeek，可改为通义千问 / 智谱 / 本地模型等。",

	},
	"settings.ai.key": { zh: "API Key" },
	"settings.ai.key.desc": {
		zh: "你的 API 密钥（不会上传到任何第三方服务器）。",

	},
	"settings.ai.model": { zh: "模型名称" },
	"settings.ai.model.desc": {
		zh: "如 deepseek-chat、qwen-plus、glm-4-flash 等。",

	},
	"settings.ai.test": { zh: "测试连接" },
	"settings.ai.test.desc": { zh: "发一次最小请求，验证 API Key 与地址是否可用。" },
	"settings.ai.test.btn": { zh: "测试连接" },
	"settings.ai.test.noKey": { zh: "请先填写 API Key" },
	"settings.ai.test.testing": { zh: "正在测试连接..." },
	"settings.ai.test.ok": { zh: "连接成功" },
	"settings.ai.test.badKey": { zh: "连接失败：API Key 无效或已过期，请检查" },
	"settings.ai.test.rate": { zh: "连接失败：请求过于频繁或额度不足，请稍后重试" },
	"settings.ai.test.server": { zh: "连接失败：服务器错误" },
	"settings.ai.test.http": { zh: "连接失败" },
	"settings.ai.test.netfail": { zh: "网络连接失败，请检查 API URL 或网络设置" },
	"settings.ai.test.fail": { zh: "连接失败" },
	"settings.ai.showReason": { zh: "显示 AI 排序理由" },
	"settings.ai.showReason.desc": {
		zh: "在插件卡片中显示 AI 为什么推荐该插件（会增加 token 消耗）。",

	},
	// Embedding
	"settings.embedding.title": { zh: "检索召回（Embedding / 关键词）" },
	"settings.embedding.desc": {
		zh: "召回方式决定「候选如何被找出来」。关键词=零依赖开箱即用；API 向量=语义更准（需支持 embedding 的接口）；本地模型=离线运行（首次需联网从 CDN 下载模型权重并缓存）。任何模式失败都会自动降级到关键词。",

	},
	"settings.embedding.mode": { zh: "召回方式" },
	"settings.embedding.mode.desc": {
		zh: "keyword：本地关键词（默认）；api：API 向量语义；local：本地模型（离线，依赖 @xenova/transformers）。",

	},
	"settings.embedding.keyword": { zh: "关键词（本地，默认）" },
	"settings.embedding.api": { zh: "API 向量（语义）" },
	"settings.embedding.local": { zh: "本地模型（离线）" },
	"settings.embedding.baseUrl": { zh: "Embedding Base URL" },
	"settings.embedding.baseUrl.desc": {
		zh: "向量接口地址（OpenAI 兼容 /v1/embeddings）。可与聊天接口不同。",

	},
	"settings.embedding.key": { zh: "Embedding API Key" },
	"settings.embedding.key.desc": {
		zh: "向量接口的密钥（可与聊天接口不同）。",

	},
	"settings.embedding.model": { zh: "Embedding 模型" },
	"settings.embedding.model.desc": {
		zh: "如 text-embedding-3-small（OpenAI）、nomic-embed-text（ollama）等。",

	},
	"settings.embedding.localModel": { zh: "本地模型名（local 模式）" },
	"settings.embedding.localModel.desc": {
		zh: "transformers.js 模型 ID，默认 Xenova/bge-small-zh-v1.5（面向中文语义，体积 ~110MB）。",

	},
	"settings.embedding.wasm": { zh: "ONNX WASM 路径（可选）" },
	"settings.embedding.wasm.desc": {
		zh: "留空则用 transformers.js 默认 CDN。可填自托管/CDN 地址以加速或离线加载 wasm。",

	},
	"settings.embedding.webgpu": { zh: "WebGPU 加速" },
	"settings.embedding.webgpu.on": {
		zh: "当前环境支持 WebGPU，本地向量搜索将走 GPU 加速（快）。",

	},
	"settings.embedding.webgpu.off": {
		zh: "当前环境未暴露 WebGPU（navigator.gpu），本地向量搜索将回退 WASM（较慢）。若你的 Obsidian 支持 WebGPU 却提示不可用，可尝试给 Obsidian 加 --enable-webgpu 启动开关。",

	},
	"settings.embedding.ready": { zh: "本地向量运行时" },
	"settings.embedding.ready.checking": { zh: "正在检测…" },
	"settings.embedding.ready.fail": { zh: "检测失败" },
	"settings.embedding.index": { zh: "本地向量索引" },
	"settings.embedding.index.btn": { zh: "构建/重建" },
	"settings.embedding.index.buildingBtn": { zh: "构建中…" },
	"settings.embedding.index.start": { zh: "开始后台构建（需本地模型，首次约数百 MB 下载，耗时数秒~十几秒）…" },
	"settings.embedding.index.building": { zh: "正在构建本地向量索引… {p}/{t}" },
	"settings.embedding.index.idle": { zh: "尚未构建。首次使用「本地语义」模式会自动构建；也可点击按钮手动预建（推荐，避免首次搜索等待）。" },
	"settings.embedding.index.done": { zh: "本地向量索引已就绪，可离线语义搜索。" },
	"settings.embedding.index.error": { zh: "构建失败" },
	// 翻译引擎
	"settings.engine.myMemory": { zh: "启用 MyMemory 免费翻译" },
	"settings.engine.myMemory.desc": {
		zh: "无需密钥，每天 5000 字符免费，翻译后缓存到本地。",

	},
	// 腾讯翻译
	"settings.tencent.title": { zh: "腾讯云翻译（可选）" },
	"settings.tencent.secretId": { zh: "SecretId" },
	"settings.tencent.secretId.desc": { zh: "腾讯云 API 密钥标识" },
	"settings.tencent.secretKey": { zh: "SecretKey" },
	"settings.tencent.secretKey.desc": { zh: "腾讯云 API 密钥" },
	"settings.tencent.region": { zh: "Region" },
	"settings.tencent.region.desc": { zh: "API 调用地域，默认 ap-guangzhou" },
	"settings.mirror": { zh: "数据源镜像" },
	"settings.mirror.desc": {
		zh: "国内访问 GitHub 可能受限。切换镜像后，插件列表 / 统计 / README 均走对应镜像源。推荐 jsDelivr。",

	},
	"settings.mirror.github": { zh: "GitHub 原始" },
	"settings.mirror.jsdelivr": { zh: "jsDelivr" },
	"settings.mirror.custom": { zh: "自定义" },
	"settings.mirror.ghproxy": { zh: "gh-proxy（GitHub 加速代理）" },
	"settings.mirror.customBase": { zh: "自定义镜像地址" },
	"settings.mirror.customBase.desc": {
		zh: "仅当镜像源选「自定义」时生效，替换 https://raw.githubusercontent.com 部分（保留 /<owner>/<repo>/<ref>/<path>）。",
	},

	// 默认偏好
	"settings.prefs": { zh: "默认偏好" },
	"settings.prefs.desc": {
		zh: "每次打开插件时的默认筛选和排序方式（随时可在主界面切换）。",
	},
	"settings.prefs.sortBy": { zh: "默认排序" },
	"settings.prefs.sortBy.downloads": { zh: "按下载量" },
	"settings.prefs.sortBy.updated": { zh: "按更新时间" },
	"settings.prefs.sourceFilter": { zh: "默认来源" },
	"settings.prefs.sourceFilter.all": { zh: "全部来源" },
	"settings.prefs.sourceFilter.translated": { zh: "已翻译" },
	"settings.prefs.sourceFilter.bulk": { zh: "批量词典" },
	"settings.prefs.sourceFilter.online": { zh: "在线翻译" },
	"settings.prefs.sourceFilter.ai": { zh: "AI 翻译" },
	"settings.prefs.sourceFilter.original": { zh: "从未翻译" },

	"settings.cache": { zh: "缓存管理" },

	// 缓存管理子项
	"settings.cache.desc": { zh: "当前已缓存 " },
	"settings.cache.clear": { zh: "清除缓存" },

	// 个人 AI 固化资产
	"settings.aidict": { zh: "个人 AI 固化资产" },
	"settings.aidict.desc": { zh: "已固化的 AI 译文（共 " },
	"settings.aidict.clear": { zh: "清除 AI 资产" },

	// 插值测试样本（pickLang 多变量替换单测使用，保留）
	"settings.dashboard.coverage.trend": {
		zh: " 较 {prev} {arrow}{delta}pp",

	},

	// 翻译记忆库（TM）
	"settings.tm": { zh: "翻译记忆库 (TM)" },
	"settings.tm.desc": { zh: "AI 与在线（腾讯/MyMemory）译文直接沉淀为 vault 笔记（单条 O(1) 写入、可随 Sync 同步、可手编），无需审核。" },
	"settings.tm.clearApproved": { zh: "清除已采纳" },
	"settings.tm.clearDesc": { zh: "删除「翻译记忆库」文件夹下全部已采纳笔记及其索引" },
	"tm.clear.command": { zh: "清除翻译记忆库已采纳" },
	"notice.tmNoApproved": { zh: "暂无已采纳的 TM" },
	"notice.tmCleared": { zh: "已清除 {n} 条已采纳的 TM" },
	"notice.tmApproved": { zh: "已采纳并写入 vault 笔记" },
	"notice.tmRejected": { zh: "已忽略" },

	// 通知
	"notice.ai.fail": { zh: "AI 智能排序暂不可用，已保留常规搜索结果（原因：" },
	"notice.ai.fail.cn": {
		zh: "国内模型直连本应可用。若仍失败，请确认 Base URL 与 API Key 正确、且网络可达后重试。",
	},
	"notice.ai.fail.oversea": {
		zh: "国外模型调用失败，请确认 Base URL 与 API Key 正确、且网络可达后重试。",
	},
	"notice.ai.localFail": {
		zh: "本地语义搜索失败",
	},
	"notice.local.indexing": {
		zh: "正在构建本地向量索引（首次需下载模型，稍候）…",
	},
	"notice.market.opened": { zh: "已跳转到社区市场" },
	"notice.ai.loadFail": {
		zh: "插件列表加载失败，无法执行 AI 搜索。请检查网络后重试。",

	},
	"notice.ai.done": { zh: "AI 已按" },
	"notice.ai.analyzing": { zh: "AI 正在分析..." },
	"notice.ai.analyzing.hint": { zh: "正在根据您的描述进行语义匹配，请稍候" },
	"notice.translated": { zh: "个结果" },
	"notice.saved": { zh: "已保存自定义翻译：" },
	"notice.mirror.switched": {
		zh: "已切换数据源为",

	},
	"notice.mirror.retry": { zh: "，正在重试…" },
	"notice.mirror.auto": { zh: "已自动切换到镜像：" },
	"notice.cacheCleared": { zh: "翻译缓存已清除" },
	"notice.aiDictCleared": { zh: "个人 AI 资产已清除" },
	"time.justNow": { zh: "刚刚" },
	"time.hoursAgo": { zh: "{n} 小时前" },

	// 选品对比
	"close": { zh: "关闭" },
	"card.compare": { zh: "对比" },
	"compare.title": { zh: "对比 {n} 个插件" },
	"compare.func": { zh: "功能对比" },
	"compare.common": { zh: "共同功能" },
	"compare.complementary": { zh: "功能互补：没有共同标签" },
	"compare.metrics": { zh: "参考指标" },
	"compare.downloads": { zh: "下载量" },
	"compare.popular": { zh: "最受欢迎" },
	"compare.updated": { zh: "更新时间" },
	"compare.status": { zh: "安装状态" },
	"compare.installed.on": { zh: "已启用" },
	"compare.installed.off": { zh: "已安装" },
	"compare.installed.no": { zh: "未安装" },
	"compare.category": { zh: "分类" },
	"compare.unknown": { zh: "未知" },
	"compare.noTags": { zh: "暂无功能标签" },
	"compare.ai.title": { zh: "AI 深度对比" },
	"compare.ai.start": { zh: "AI 深度对比" },
	"compare.ai.noKey": { zh: "未配置 AI（不可用）" },
	"compare.ai.noKeyHint": {
		zh: "在设置中开启 AI 能力并填写 API Key 后，可让 AI 生成深度对比分析。",
	},
	"compare.ai.loading": { zh: "AI 分析中…" },
	"compare.ai.cancel": { zh: "取消" },
	"compare.ai.cancelled": { zh: "已取消分析" },
	"compare.ai.retry": { zh: "重新分析" },
	"compare.ai.fail": { zh: "AI 对比失败" },
	"compare.tray.title": { zh: "已选 {n} 个" },
	"compare.tray.open": { zh: "对比 {n} 个" },
	"compare.tray.clear": { zh: "清空" },
	"compare.tray.min": { zh: "至少选择 2 个插件" },
	"compare.discover": { zh: "提示：点击卡片上的对比图标，选择多个插件进行横向对比" },
	"facet.noData": { zh: "分类数据暂不可用" },
	"facet.category": { zh: "分类" },
	"facet.author": { zh: "作者" },
	"facet.filterable": { zh: "（可筛选）" },
	"compare.added": { zh: "已加入对比集" },
	"compare.removed": { zh: "已移出对比集" },
	// 对比导出（复制 / 截图）
	"compare.export.md": { zh: "复制 MD" },
	"compare.export.png": { zh: "截图" },
	"compare.export.md.done": { zh: "对比 Markdown 已复制到剪贴板" },
	"compare.export.png.done": { zh: "对比截图已下载" },
	"compare.export.png.fail": { zh: "截图生成失败，请重试" },
	"compare.export.md.done2": { zh: "已复制对比报告到剪贴板" },
	"compare.export.copyFail": { zh: "剪贴板写入失败" },
	"compare.nav.back": { zh: "← 返回列表" },
	"compare.nav.add": { zh: "+ 添加插件" },
	"compare.remove": { zh: "移出对比" },
	"compare.insight.title": { zh: "分析结论" },
	"compare.insight.suggest": { zh: "建议" },
	"compare.suggest.noOverlap": { zh: "两者功能无重叠，解决不同场景，推荐同时使用。" },
	"compare.suggest.totalOverlap": { zh: "两者功能高度重叠，选 {name}（下载量更高 + 维护更活跃）。" },
	"compare.suggest.multiNoOverlap": { zh: "这些插件功能无重叠，解决不同场景，可按需同时使用。" },
	"compare.suggest.multiTop": { zh: "综合推荐 {name}（下载量 + 维护活跃度最优）" },
	"compare.suggest.coexist": { zh: "它们可以共存，无冲突。" },
	"compare.suggest.coexistMulti": { zh: "不同侧重的插件可共存。" },
	"compare.ai.hint": { zh: "AI 将从功能差异、使用场景、维护活跃度等维度深度分析，给出个性化选型建议。" },
	"compare.ai.fetching": { zh: "正在拉取各插件仓库真实信号（manifest / 命令 / README）…" },
	"compare.warn.stale": { zh: "{names} 超过 2 年未更新，可能存在兼容性风险。" },
	"compare.fresh.gap": { zh: "{fresh} 近期活跃，而 {stale} 已超过 {days} 天未更新——维护风险需注意。" },
	"compare.fresh.active": { zh: "{fresh} 近期仍在活跃更新。" },
	"compare.fresh.stale": { zh: "{stale} 超过 2 年未更新，可能存在兼容性风险。" },
	"compare.overlap.none": { zh: "这些插件几乎没有功能重叠，解决的是不同的问题，可以共存。" },
	"compare.overlap.high": { zh: "功能重叠度较高（{pct}%），选其一即可。" },
	"compare.overlap.mid": { zh: "部分功能重叠（{pct}%），各有侧重。" },
	"compare.cmds.overlap": { zh: "实际命令高度重叠，本质是同类工具，建议只装一个。" },
	"compare.cmds.unique": { zh: "命令几乎不重叠，各自解决不同动作，可共存互补。" },
	"compare.commands.detail": { zh: "查看各插件实际命令" },
	"compare.commands.none": { zh: "（无提取到命令）" },
	"compare.installed.onDevice": { zh: "{names} 已安装启用在这台设备上。" },
	"compare.installed.notEnabled": { zh: "{names} 已安装但未启用。" },
	"compare.dl.gap2": { zh: "{top} 下载量是 {bottom} 的 {ratio} 倍，社区认可度差距明显。" },
	"compare.dl.lead2": { zh: "{top} 下载量领先（{topDl} vs {bottomDl}）。" },
	"compare.dl.gapMulti": { zh: "下载量差距明显：{ranking}。" },
	"compare.dl.rankingMulti": { zh: "下载量排名：{ranking}。" },
	"compare.dl.closeMulti": { zh: "下载量接近：{ranking}。" },
	"compare.daysAgo": { zh: "{n} 天前" },
	"compare.suggest.need": { zh: "如果你需要 {tags} → 选 {name}" },
	// 作者钻取状态条
	"author.filter.active": { zh: "正在查看作者 {author} 的 {n} 个插件" },
	"author.filter.clear": { zh: "✕ 清除" },
	"filter.reset": { zh: "重置" },
	// 活跃筛选条件 chips（折叠面板收起时，在搜索行下方常驻显示已生效的筛选）
	"filter.active.label": { zh: "筛选中" },
	"filter.active.source": { zh: "翻译：{value}" },
	"filter.active.installed": { zh: "仅已安装" },
	"filter.active.category": { zh: "分类：{value}" },
	"filter.active.author": { zh: "作者：{value}" },
	"filter.active.clear": { zh: "清除该筛选" },
} as const;

export type I18nKey = keyof typeof STRINGS;

/** 文案插值变量（替换 {key} 占位） */
export type I18nVars = Record<string, string>;

/**
 * 纯函数：取出中文文案。
 * 缺失的 key 回退到 key 本身，保证不出现空白。
 */
export function pickLang(
	key: I18nKey,
	vars?: I18nVars
): string {
	const entry = STRINGS[key];
	let text: string = entry ? entry.zh : key;
	if (vars) {
		for (const [k, v] of Object.entries(vars)) {
			const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			text = text.replace(new RegExp(`\\{${escaped}\\}`, "g"), v);
		}
	}
	return text;
}

/**
 * 取界面文案的便捷函数。
 * 复用于设置面板、视图、详情弹窗等各处。
 * 第二个可选参数 vars 用于 {placeholder} 插值（如相对时间 {n}）。
 */
export function makeT(): (key: I18nKey, vars?: I18nVars) => string {
	return (key: I18nKey, vars?: I18nVars) => pickLang(key, vars);
}

/** 相对时间文案取用函数类型（与 makeT 返回一致） */
export type TFunc = (key: I18nKey, vars?: I18nVars) => string;

/**
 * 把时间戳格式化为「刚刚 / N 分钟前 / N 小时前 / N 天前」相对描述（产品改进 #15）。
 * 纯函数，注入 now 与 t（i18n 取词），便于单元测试，视图与 tooltip 共用。
 */
export function formatRelativeTime(ts: number, now: number, t: TFunc): string {
	if (!Number.isFinite(ts) || ts <= 0) return "";
	const diff = now - ts;
	if (diff < 0) return t("time.justNow");
	const min = Math.floor(diff / 60000);
	if (min < 1) return t("time.justNow");
	if (min < 60) return t("time.minutesAgo", { n: String(min) });
	const hr = Math.floor(min / 60);
	if (hr < 24) return t("time.hoursAgo", { n: String(hr) });
	const day = Math.floor(hr / 24);
	return t("time.daysAgo", { n: String(day) });
}
