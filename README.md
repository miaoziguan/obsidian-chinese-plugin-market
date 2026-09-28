# 🀄 Chinese Market —— 重建 Obsidian 生态的巴别塔，实现天下大同

> 传说里，人类曾想共建一座通天的高塔，却因为语言变乱而停工、四散——工具与知识从此只在高处流转。
> Obsidian 社区插件市场有数千个插件，名字、描述、README 几乎全是英文：对中文用户，这就是又一座没能建成的巴别塔。
> **Chinese Market 要做的，是把这座塔接着建起来：用中文找、用中文读、用中文判断，让语言不再决定你能用上什么工具。**
> **天下大同，不是让所有人说同一种语言，而是让说不同语言的人，用得上同一座塔。**

[English](#english) · [三分钟上手](#二、三分钟上手) · [能力全景](#三、能力全景) · [架构](#六、架构与开发者指南) · [参与共建](#七、参与共建（一起把塔建起来）)

---

## 一、被语言隔开的人

Obsidian 的社区插件市场是一座真正的宝库。数千个插件，覆盖了你能想到的每一种工作方式：双链、图谱、日记、看板、任务管理、排版美化、与外部工具的同步。它是 Obsidian 之所以是 Obsidian 的原因之一。

但这座宝库的门牌全是英文写的。

于是中文用户撞上三堵墙，一堵比一堵高。

**第一堵墙是「找不到」。** 你想做一个思维导图，脑子里冒出来的是「思维导图」四个字，可搜索框只认 `mindmap`。你想找个日历插件，翻遍推荐帖才知道它叫 `periodic-notes`。需求与工具之间横着一本你没背过的英汉词典，多数人不是败给难度，而是败给第一步——他们根本不知道该搜什么词。

**第二堵墙是「看不懂」。** 就算搜到了，`templater-obsidian`、`obsidian-linter`、`dataview` 这些名字像密码；点开描述，是几百字英文。你只能靠截图、靠别人的一句「这个好用」来盲选，装了半天发现它解决的是另一个问题。

**第三堵墙是「不敢装」。** README 是英文长文，依赖是什么、兼容哪个版本、有没有已知问题，全都埋在你看不懂的段落里。于是你不敢启用，不敢更新，最后只敢用被反复推荐过的那几个插件——而真正适合你的那一个，还蹲在市场深处等你。

这不是能力问题，这是接入问题。Chinese Market 就是把这三堵墙逐一打通：用中文检索（含离线语义与可选的 AI 语义）解决找不到，用多层翻译与可沉淀的翻译记忆解决看不懂，用详情页里补齐的 README 译文、相似推荐、依赖图谱、版本选择与评测台账解决不敢装。

不是给英文市场贴一层中文皮，而是在中文这一侧重建一整套基础设施：检索、翻译、理解、决策、管理，每一层都重新做过。

---

## 二、三分钟上手

**安装。** 最省事的办法是打开 Obsidian → 设置 → 第三方插件 → 浏览，搜索 **Chinese Market**，安装并启用。如果你想用最新构建，就去 [Releases](https://github.com/miaoziguan/obsidian-chinese-plugin-market/releases) 下载 `main.js`、`manifest.json`、`styles.css`，放进 `<你的仓库>/.obsidian/plugins/chinese-plugin-market/`，再回到设置里启用。要求 Obsidian **1.13.0** 及以上；手机、平板同样可用，并且为触控单独做了适配。

**打开。** 点左侧栏那个 🌐 图标（它会在有可用更新时挂上红点），或者按 <kbd>Ctrl/⌘ + P</kbd> 调出命令面板，输入「插件搜索」。

**使用，只有三步。** 一，在搜索框里打中文——「思维导图」「日历」「同步」，想到什么打什么。二，看卡片上的中文译名与描述，点开详情读翻译后的 README、相似推荐和依赖关系。三，点安装；需要稳妥时，先在详情页锁定一个版本再装。

**你不需要配置任何东西就能开始。** 翻译走内置的免费通道，搜索用关键词或本地语义（离线即可）。想要 AI 语义检索或更高质量的翻译通道，再去设置里填上自己的密钥——那是可选的增强，不是入场券。

---

## 三、能力全景

### 3.0 五个页签，一个台账

主视图（命令「插件搜索」）分五个页签。**浏览**是默认卡片流，搜索、筛选、排序都在这里发生。**更新**集中展示已安装插件的可用更新，带数量徽标，支持批量处理。**直链**收纳通过直链安装的 Beta 插件与主题。**CSS 片段**把 vault 里的片段做成分组可管、批量可切的东西。**收藏**则是你自己的工具箱，同样可以分组。

另有一个独立视图：**我的插件足迹**（命令「打开我的插件足迹」）。它记录你装过的每一个插件——状态、评分、弃用原因、首次安装时间、最近动态，可以整体复制成 Markdown。装过什么、为什么扔掉，时间长了没人记得住，这个台账替你记。

### 3.1 三种搜索：从「我知道名字」到「我只知道想要什么」

**关键词模式**负责你已经知道要找什么的时刻。它搜中文译名、英文原名和作者名，并且支持一套高级语法：空格代表 AND，`|` 代表 OR，`-词` 用于排除，`name:`、`id:`、`author:`、`desc:` 用来限定字段，双引号锁住短语。想找思维导图或大纲类但不要看板？输入 `思维导图 | 大纲 -kanban`。只想看某个作者的作品？`author:zsviczian`。按原名精确查找？`name:dataview`。

**本地语义模式**负责你只知道想要什么效果的时刻。它被一句话描述驱动，向量召回跑在你自己的机器上：离线、免密钥、结果按相关度排序。第一次使用会下载一次本地模型（默认 `Xenova/multilingual-e5-small`，量化后约 118MB），之后彻底离线可用。

**AI 语义模式**负责需求复杂、需要模型替你判断相关度的时刻。你用自然语言描述，大模型召回并精排。它需要你在设置里填 BaseURL、Key 与 Model——它是增强项，不是门槛项。

三种模式覆盖了从「我知道名字」到「我只知道想要什么」的全部地带。而本地语义模式的存在意味着一件事：**检索能力不该被网络环境或付费门槛垄断**，断网、没有密钥，你依然能靠语义找到东西。

### 3.2 翻译体系：本项目的地基

翻译在这里不是「调一个接口」，而是一条自动降级的多层通道链。顺序是这样的：已缓存译名 → 翻译记忆里你已采纳的译文 → AI 固化的词典资产 → AI 翻译 → 自托管翻译（DeepLX / LibreTranslate）→ 百度 → 腾讯免费通道（Transmart）→ Google → MyMemory → 腾讯云 → 原文。

任何一层失败——超时、配额耗尽、断网——就自动交给下一层。所有通道统一走超时与熔断，返回空就降级，不会因为某个服务挂掉而卡住界面。腾讯 Transmart、Google、MyMemory 这三个**零配置免费通道默认开启**，不需要你填任何东西；百度、腾讯云、AI、自托管这些**需要密钥的通道默认关闭**，填了才会启用。MyMemory 配额耗尽时会当日封禁、跨天自动解除——这类细节都被熔断逻辑兜住了。

**离线不是空话。** 插件随包分发一份种子译名库（`seeded-translator-cache.json`），与你的本地缓存合并，而你自己的译文永远优先于种子。断网时，已经积累的中文名照样显示。

**翻译记忆（TM）是这里最值得说的一件事。** 在线或 AI 产生的译文会落成 vault 里的 Markdown 笔记，默认在插件数据目录的 `tm/` 下（可以在设置里改到 vault 任意位置），每条带 frontmatter，记录 `id`、`source`、`status`、`confidence`、`created`。这意味着三件事：你改过的译法立即生效，并优先于后续任何在线结果；译文可以进 Git，能回溯、能同步、能分享；译文属于你，不锁在任何云端服务里。翻译不是一次性消费品，而是一代人传给下一代的公共资产——这是「重建」这个词在这里的真正含义：不是替每个人翻译一遍，而是让翻译被积累下来。

**设置界面翻译**是一个可选能力：它可以把**其他插件的设置页**也译成中文。实现方式很克制——钩住 Obsidian 的 `Setting` 组件，只替换文本节点，不碰 DOM 结构，跳过本插件与已经包含中文的内容。默认关闭，可指定通道与黑名单。别人的插件我们管不了，但至少可以让你读懂它。

### 3.3 卡片：一眼看懂一个插件

卡片是决策的第一现场，所以信息密度必须够。每张卡片给出中文译名与英文原名（显示偏好可切换）、作者（点一下就钻取该作者的全部插件）、下载量、最近更新时间与新上线标记，以及已安装、已启用、有更新、已弃用这些状态徽标。健康度信号会提示维护活跃度与风险；**未命中译文时如实标注「尚未有中文译名」**——我们宁可承认没翻译，也不制造假装的理解。

卡片上能做的事：安装与卸载、启用开关、加入对比、收藏、写评测、让 AI 解释它到底能干什么（了解功能）、打开仓库、打开插件设置。

### 3.4 详情抽屉：从「敢装」到「装得明白」

点开卡片，进入详情。**README 翻译**把整篇文档译成中文，可以切换翻译通道、随时返回原文、一键复制；macOS 桌面端还能调用**系统翻译**处理长文。**了解功能**让 AI 用几句话讲清这个插件的价值。**相似推荐**基于分类与功能标签给出同类选项，方便横向比较。**版本选择**让你查看历史版本并**固定安装某个版本**——新版本引入不兼容时，这是你的退路。**依赖图谱**列出必需与可选依赖及其状态（已装 / 缺失 / 未启用 / 版本过低），可以一键补齐，同时告诉你「谁依赖了它」。**我的评测**记录安装次数、卸载时间、评分与弃用原因，沉淀进前面的那个台账。

英文 README、隐藏的依赖、版本风险——这些「只有读懂英文才拿得到的信息」，在这里全部补齐。决策不再依赖别人替你试错。

### 3.5 筛选与排序：把主动权交回给你

筛选维度包括翻译状态（全部 / 已翻译 / 未翻译）、安装状态（全部 / 已装 / 已启用 / 已装未启用）、收藏、官方推荐、中文生态、系列（竹林中国系列 / 羽鳞精选）、装过、弃用、踩坑原因、分类、作者，以及新上线与近期更新的时间窗口（1 / 3 / 7 / 30 / 90 / 365 天）。

所有生效条件都以小圆片常驻显示，随手点 ✕ 就清掉。**不会出现列表莫名其妙变少、你却不知道为什么的情况**——筛选必须是可见的、可撤销的。

排序提供八种口径：相关度、下载量、最近更新、名称、最新上架、热度、趋势、推荐。搜索之后看相关度；想稳妥就按下载量；想找活跃维护的就看最近更新；想发现正在被更多人装的东西，看热度或趋势；想看别人替你筛过的，看推荐。

### 3.6 装得上，还要装得稳

安装、卸载、启用走半官方 API，并正确维护 Obsidian 的配置；Beta 插件与主题可以走**直链安装**。详情页能**固定版本**，避免新版本把你正在用的工作流打断。**更新页签**集中展示可用更新，支持全部更新与更新选中两种批量方式。**健康度徽标**按最后发布时长判断维护状态（活跃 / 老化 / 风险），阈值可以自己定，也可以选择让风险插件降级。有更新时，侧栏图标会挂上红点。

能装只是及格线，装得稳才算交付。

### 3.7 对比：把纠结变成决策

把两个以上候选插件放进**对比托盘**，打开对比视图并排比较，可以让 AI 给出深度分析，还能把结论**导出为 Markdown 或截图**——留给自己，或者发给同样在纠结的人。功能相近的插件最难选，而这类比较恰恰最依赖英文描述，对比模式把这一步中文化、结构化。

### 3.8 收藏、足迹，与「谁来决定什么值得推荐」

**收藏**可以分组，是你自己的中文工具箱。**我的插件足迹**是长期台账，记状态、评分、弃用原因、首次安装与最近动态，可一键复制为 Markdown。

推荐体系则有四个来源：**羽鳞精选**是人工策划清单，在排序中置顶；**竹林中国系列**面向中文用户场景，可单独筛选；**官方推荐**是策划清单；**中文生态**由人工清单加算法判定共同构成。此外还有基于采样计算的**趋势**热度。

为什么要做这么多层？因为如果推荐只由「下载量」这一个数字决定，那么永远是英文世界先流行起来的插件排在前面，中文用户的需求永远排在后面。让人工策划、中文生态与本地趋势进入排序逻辑，就是让中文用户的需求也参与决定「什么值得被看见」。

### 3.9 组合与批量管理

把当前启用的一组插件存成**组合（Profile）**，可以一键应用、绑定到布局，每个组合还会生成一条命令——在 Obsidian 的快捷键设置里给它绑个键，「写作模式」「研究模式」「整理模式」就能瞬间切换。

对已装插件，插件给 Obsidian 原生的「社区插件」设置页做增强：分组、备注、筛选；CSS 片段页同样支持分组与批量启用、停用、删除。**这是增强，不是替代**——你已有的习惯不被夺走，只补上缺失的那一块。

### 3.10 命令与入口

命令面板里可以找到这些：插件搜索；打开我的插件足迹；打开社区插件管理（直达 Obsidian 原生设置页）；从直链安装插件与直链安装主题；检查更新；清除与打开翻译记忆库。此外还有三类动态命令——每个组合一条「应用组合：〈名称〉」，每个已装插件一条「启用 / 停用〈插件〉」，每个片段一条「切换 CSS 片段〈名称〉」。

插件不预设快捷键，你可以在 Obsidian 的快捷键设置里自行绑定。

### 3.11 设置项地图

设置面板按主题分组。**偏好**里是数据源筛选、默认排序、名称显示方式（译名优先还是原名优先）。**更新管理**里是新上线与近期更新窗口、健康度徽标与阈值、风险降级、趋势采样与保留天数、安装后的更新提醒。**数据源**里可以切镜像源——GitHub、jsDelivr 或自定义，网络不通时换一条路，而不是被挡在门外。**翻译引擎**里是各免费通道的开关，以及百度、腾讯云、自托管、AI 的配置。**AI 语义搜索**里是开关、BaseURL / Key / Model 与是否展示推理过程。**本地向量**里是模型选择、HF 镜像、WebGPU 状态与索引管理。**缓存与质量**里可以清除译名缓存与 AI 词典。**翻译记忆库**里是路径、迁移、打开文件夹、清除已采纳与评测笔记路径。**设置页翻译**里是开关、通道与黑名单。**组合**里是保存、应用、绑定布局与删除。**已装插件管理**里是增强开关、插件分组与 CSS 片段分组。

---

## 四、隐私与数据：能本地就本地，能不传就不传

原则只有一句，但每一处都照着做。

**必须联网的部分**就那么多：拉取官方插件清单与统计（走 `raw.githubusercontent.com` 或 jsDelivr 镜像）、你在用的翻译通道、你自己填的 AI 地址，以及本地语义模型的一次性下载（HuggingFace 或镜像）。**需要密钥才能启用的部分**——百度、腾讯云、AI 翻译与 AI 搜索、自托管服务——默认全部关闭，你不填，它们就不存在。

**密钥单独存放**：它们被写在插件目录下的 `credentials.json` 里，并且从普通配置 `data.json` 中剥离出去。你备份、分享、同步 vault 的时候，不会顺手把密钥带走。

**本地优先**是默认姿态：关键词搜索、本地语义搜索、已缓存译名、翻译记忆、SQLite 向量索引，全在你自己机器上。翻译全部失败时，我们如实回退原文——宁可给你看英文，也不给你一段错的中译文。

**你的译文归你**：翻译记忆就是 vault 里的 Markdown 文件，能编辑、能删除、能跟着仓库一起同步。它不属于任何服务方。

---

## 五、为什么这样设计：每一处技术选择，都是一次立场表态

翻译做成多级降级，免费零配置通道打底、密钥通道可选——因为**有没有密钥、会不会配置，不该成为获取信息的门槛**。本地向量用 WebAssembly 跑 transformers.js，模型可走镜像——因为**语义检索能力不应依赖付费 API**。镜像源可以切换——因为**网络环境不该把人挡在生态之外**。译文落成 Markdown 进你的 vault——因为**翻译是公共资产，不是服务方的私有数据**。增强而非替代官方面板——因为**不夺走用户已有的习惯，只补齐缺失的那块**。移动端单独做触控热区、容器查询断点与平板折叠策略——因为「能用」不等于「好用」。未命中译文时如实标注——因为**宁可承认没翻译，也不制造假的理解**。

这些不是设计美学，是一件件具体的事：有人在断网的飞机上想找个插件，有人没有信用卡也配不了 API，有人所在的网络访问不了默认源，有人用手机记笔记。每一条设计的背后，都是一个真实的人。

---

## 六、架构与开发者指南

### 分层：七层单向依赖

项目按**七层单向依赖**组织，import 统一走 `@layer/*` 别名，禁止跨层相对路径（详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)）。最上层的 **app**（`src/app/`）是 Obsidian 装配层，负责插件入口、命令、设置面板、更新器与平台适配。**ui**（`src/ui/`）承载视图与组件——虚拟滚动列表、卡片、工具栏、详情抽屉、各个页签。**domain**（`src/domain/`）是纯逻辑域，不依赖 Obsidian，装着检索、排序、推荐、对比、依赖分析、评测。**translation**（`src/translation/`）管翻译通道、词典、简繁转换与翻译记忆。**semantic**（`src/semantic/`）管向量嵌入、SQLite 向量库、编解码与 worker。**data**（`src/data/`）收口平台与 IO：HTTP 端口、存储、安装器、片段管理。**shared**（`src/shared/`）放常量、i18n、工具与平台判定。

依赖只能从上往下走。这条规则保证了核心逻辑可以脱离 Obsidian 被测试——单测里跑得动的，才是真的逻辑，而不是插件的附庸。

### 数据流

官方清单与统计从远程拉取，带 TTL 与镜像容错；落进本地存储（PluginStorage）；进入检索与排序管线（关键词、BM25、向量召回、AI 精排）；再经推荐与多样性重排；最后由虚拟滚动渲染，DOM 节点数始终受控。

### 关键工程机制

**虚拟滚动**用定高行加上下占位，DOM 节点数稳定在数百以内，搜索输入有防抖。**向量存储**由 sql.js（WASM）承载 SQLite，向量以量化形式存放，变更累积后批量落盘——因为写入低频、读取频繁。**模型推理**跑在独立的 worker bundle 里（transformers.js），模型按需下载，跨域请求由主线程代发。**响应式**一律用容器查询（`@container`）而不是视口宽度，因此在分屏、侧栏里也判断正确。**无障碍**上，卡片、工具栏、抽屉大量使用 `aria-*`、`role`、`tabindex` 标注。**降级链**贯穿始终：AI 精排失败退回本地向量 ∪ 关键词，向量失败退回纯关键词，统计失败复用磁盘缓存，翻译失败回退原文。

### 数据文件与生成脚本

`plugin-tags.json` 是离线中文分类索引，由 `npm run gen-tags` 生成；`plugin-release-dates.json` 记录首次上架时间，是从官方仓库的 git 历史里解析出来的，用 `npm run gen-release-dates` 生成；`plugin-chinese-ecosystem.json` 是中文生态清单，对应 `npm run gen-chinese-ecosystem`；`plugin-recommend.json` 是推荐策划清单，由 `node scripts/gen-recommend.mjs` 产出；`plugin-deps.json` 是依赖图数据，由 `node scripts/gen-plugin-deps.mjs` 产出；`seeded-translator-cache.json` 是随包分发的种子译名库，构建期产出；`versions.json` 维护版本与最低 Obsidian 版本的映射，由发布脚本维护。

### 常用命令

```bash
npm install       # 安装依赖
npm run dev       # 开发构建（watch）
npm run build     # 类型检查 + 生产构建
npm test          # 单元测试（vitest）
npm run lint      # eslint + stylelint
npm run build:e2e # 构建 e2e 用例 bundle
npm run test:e2e  # 端到端测试（playwright）
npm run sync      # 构建并同步到本机 vault
```

### 文档地图

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 讲分层架构、依赖方向与命名约定，**动手前务必读一遍**。[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 是开发环境与命令，附提交前自检清单。[docs/PERF-ISSUES.md](docs/PERF-ISSUES.md) 记录性能问题与优化轨迹。[docs/SELF-AUDIT.md](docs/SELF-AUDIT.md) 是提官方市场 PR 前的自检清单。[CONTRIBUTING.md](CONTRIBUTING.md) 是贡献流程、分支与提交规范。

---

## 七、参与共建（一起把塔建起来）

巴别塔不是一个人能重建的。这个项目里，「建塔」的最小单位不是代码，而是**一条译名、一份清单、一次修正**。

**报告问题与提建议。** Bug 与功能建议请走 [Issues](https://github.com/miaoziguan/obsidian-chinese-plugin-market/issues)，带上复现步骤与环境信息；使用问题与开放讨论，请到 [Discussions](https://github.com/miaoziguan/obsidian-chinese-plugin-market/discussions)。

**贡献代码。** Fork 之后建分支，用 `feat/`、`fix/`、`refactor/`、`docs/` 加简短描述命名。提交前跑完自检：`npm run build`（tsc 零错误）、`npm test`（单测全绿）、`npm run lint`（eslint 与 stylelint 零报错，含样式 `!important` 拦截），并确认 import 全部走 `@layer/*` 别名、依赖方向没有反向。提交信息采用类 Conventional Commits（`fix(css): …`、`feat(ui): …`）。开 PR 时用 `closes #<issue号>` 关联你认领的 issue。

> 改移动端样式请特别留意 [CONTRIBUTING.md](CONTRIBUTING.md) 里的约定：统一用 `.pt-mobile` 类（它与 `.pt-view` 是同一元素，选择器必须写成后代形式），视觉尺寸与桌面零差异，触控热区用 `::after` 隐形扩张，不要用 `@media(width)`。

**贡献译名与数据。** 门槛从低到高有三种方式。最低的一种：译文就在你 vault 的 `tm/` 目录里（路径可在设置改），是带 frontmatter 的 Markdown，直接编辑即可生效，改完立即优先于任何在线结果。第二种是提交数据文件 PR——`plugin-tags.json`（分类与标签）、`plugin-chinese-ecosystem.json`（中文生态）、`plugin-recommend.json`（推荐策划）、`plugin-deps.json`（依赖数据）、`plugin-release-dates.json`（上架时间），各配一个生成脚本。第三种是参与词典补译：跑 `npm run check-dict` 会产出缺失清单，按它逐条补译后提交。

**鸣谢。** 设置页的「鸣谢」列出了所有贡献者的 GitHub 账号。每一条译名、每一次修正都会被记在这里——**天下大同不是一家之言，而是众人各添一块砖**。

---

## 八、许可证

MIT —— 自由使用，自由改造。

---

## English

**Chinese Market** is an Obsidian community-plugin browser built for Chinese-speaking users. The official plugin directory lists thousands of plugins with English names and English READMEs; Chinese Market removes that barrier so you can **search in Chinese, read in Chinese, and decide with confidence**.

Its goal is not to make everyone speak one language, but to **rebuild the tower** — so that people using different languages can reach the same tools.

Highlights: three search modes (keyword with advanced syntax, on-device semantic search that works offline without an API key, and optional AI semantic search); a layered translation pipeline with free zero-config channels by default and automatic fallback; translation memory stored as editable Markdown in your vault; a detail view with translated README, AI summary, similar plugins, dependency graph and version pinning; filters, sorting, compare mode, favorites and profiles for the full management loop; and an enhancement — not a replacement — of Obsidian's native plugin settings.

Install from Obsidian's community plugin browser, or manually from [Releases](https://github.com/miaoziguan/obsidian-chinese-plugin-market/releases). Requires Obsidian 1.13.0+; works on desktop and mobile.

Development: `npm install`, `npm run dev`, `npm run build`, `npm test`, `npm run lint`. Architecture and contribution rules are documented in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

MIT licensed.
