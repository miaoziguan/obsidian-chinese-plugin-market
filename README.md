# 🀄 Chinese Market —— 重建 Obsidian 生态的巴别塔，实现天下大同

> 传说里，人类曾想共建一座通天的高塔，却因为语言变乱而停工、四散——工具与知识从此只在高处流转。
> Obsidian 社区插件市场有数千个插件，名字、描述、README 几乎全是英文：对中文用户，这就是又一座没能建成的巴别塔。
> **Chinese Market 要做的，是把这座塔接着建起来：用中文找、用中文读、用中文判断，让语言不再决定你能用上什么工具。**
> **天下大同，不是让所有人说同一种语言，而是让说不同语言的人，用得上同一座塔。**

[English](#english) · [快速上手](#二、快速上手) · [功能总览](#三、功能总览) · [架构](#六、架构与开发者指南) · [参与共建](#七、参与共建（一起把塔建起来）)

---

## 一、我们面对的是什么

Obsidian 的社区插件市场是个巨大的宝库，但对中文用户存在三层门槛：

| 门槛 | 具体表现 | 后果 |
|---|---|---|
| **找不到** | 想做思维导图，却不知道该搜 `mindmap`；官方市场只认英文原名 | 需求与工具之间隔着一本「英汉词典」，多数人卡在这一步就放弃 |
| **看不懂** | 插件名 `templater-obsidian`、`obsidian-linter`，描述是几百字英文 | 只能靠截图和口碑盲选，装了才发现不是自己要的 |
| **不敢装** | README 是英文长文，依赖、版本、兼容性看不明白 | 不敢启用、不敢更新，最终只敢用别人推荐的少数几个 |

Chinese Market 把这三层逐一打通：

- **找不到** → 中文检索，含离线本地语义与可选的 AI 语义（[3.1](#31-三种搜索模式)）
- **看不懂** → 多层翻译通道 + 可沉淀的翻译记忆（[3.2](#32-翻译体系（本项目的地基）)）
- **不敢装** → 详情页补齐 README 译文、相似推荐、依赖图谱、版本选择与评测台账（[3.4](#34-详情抽屉（从敢装到装得明白）)）

这不是「又一个英文市场的中文壳」，而是一套完整的中文侧基础设施：检索、翻译、理解、决策、管理，全部围绕中文用户重构。

---

## 二、快速上手

### 安装

**方式一：社区插件市场（推荐）**

1. Obsidian → 设置 → 第三方插件 → 浏览
2. 搜索 **Chinese Market**
3. 安装并启用

**方式二：手动安装**

1. 到 [Releases](https://github.com/miaoziguan/obsidian-chinese-plugin-market/releases) 下载 `main.js`、`manifest.json`、`styles.css`
2. 放入 `<你的仓库>/.obsidian/plugins/chinese-plugin-market/`
3. 在设置 → 第三方插件中启用

> 要求 Obsidian **1.13.0** 及以上；桌面端与移动端（手机 / 平板）均可用，移动端有专门的触控与折叠适配。

### 打开与使用

- 左侧 **Ribbon 图标**（🌐）→ 打开插件搜索；图标上会显示待更新数量红点
- 或命令面板（<kbd>Ctrl/⌘ + P</kbd>）搜索 **「插件搜索」**

三步走：

1. **搜**：直接输入中文需求，如「思维导图」「日历」「同步」
2. **读**：卡片显示中文译名与描述；点开详情看翻译后的 README、相似推荐、依赖关系
3. **装**：点卡片上的安装按钮，或在详情页固定某个版本后安装

默认零配置即可使用：翻译走内置免费通道，搜索用关键词或本地语义（离线）。AI 语义搜索与更高质量的翻译通道需要自己在设置里填密钥。

---

## 三、功能总览

### 3.0 视图与页签

主视图（命令「插件搜索」）包含五个页签：

| 页签 | 用途 |
|---|---|
| **浏览** | 默认卡片流，搜索、筛选、排序都在这里 |
| **更新** | 已安装插件的可用更新（带数量徽标），支持批量更新 |
| **直链** | 通过直链安装的 Beta 插件与主题 |
| **CSS 片段** | 片段的分组与批量启用 / 停用 / 删除 |
| **收藏** | 收藏插件的分组管理 |

另有一个独立视图：**我的插件足迹**（命令「打开我的插件足迹」）——记录装过的每个插件的状态、评分与弃用原因，是长期使用的台账。

### 3.1 三种搜索模式

| 模式 | 怎么用 | 何时用 | 是否需要配置 |
|---|---|---|---|
| **关键词** | 搜中文译名、英文原名、作者名 | 已经知道要找什么 | 无需 |
| **本地语义** | 一句话描述需求，本地向量召回 | 只知道「想要什么效果」，且希望离线、免密钥 | 首次需下载一次本地模型，之后离线可用 |
| **AI 语义** | 自然语言描述，大模型召回 + 精排 | 需求复杂、需要模型判断相关度 | 需填 AI 的 BaseURL / Key / Model |

关键词模式支持高级语法（空格 = AND，`|` = OR，`-词` = 排除，`name:` / `id:` / `author:` / `desc:` = 字段限定，`"短语"` = 精确匹配）：

```
思维导图 | 大纲 -kanban     # 找思维导图或大纲类，排除 kanban
author:zsviczian            # 只看该作者的插件
name:dataview               # 按原名精确查找
"daily note"                # 短语精确匹配
```

**价值**：语言障碍的第一层是「你不知道该用什么英文词」。三种模式覆盖从「我知道名字」到「我只知道想要什么」的全部情况；本地语义模式保证断网、无密钥时依然可用——**检索能力不该被网络环境或付费门槛垄断**。

---

### 3.2 翻译体系（本项目的地基）

翻译不是「调一个接口」，而是一条**自动降级的多层通道链**。任一层失败（超时、配额、断网）就自动交给下一层，最终兜底为原文：

```
已缓存译名 → 翻译记忆（用户已采纳） → AI 固化的词典资产 → AI 翻译
→ 自托管翻译（DeepLX / LibreTranslate） → 百度 → 腾讯免费通道（Transmart）
→ Google → MyMemory → 腾讯云 → 原文
```

- **零配置可用的免费通道**：腾讯 Transmart、Google、MyMemory 默认开启，无需密钥；超时或配额耗尽会自动熔断并切换（MyMemory 配额耗尽会当日封禁、跨天自动解除）。
- **自带密钥的通道**：百度、腾讯云、AI（OpenAI 兼容接口）、自托管服务——填了才会启用。
- **失败永不阻塞**：所有通道统一走超时与熔断，返回空即降级，不会因为某个服务挂掉而卡住界面。

**离线词典与种子库**：插件随包分发一份种子译名库（`seeded-translator-cache.json`），与本地缓存合并，**你自己的译文始终优先于种子**。断网时依然能显示已积累的中文名。

**翻译记忆（TM）笔记**：在线或 AI 产生的译文会落成 vault 里的 Markdown 笔记（默认在插件数据目录 `tm/`，可在设置里改到 vault 任意位置），带 frontmatter 记录 `id / source / status / confidence / created` 等。这意味着：

- **可人工编辑**——你改过的译法立即生效，并优先于后续在线结果
- **可版本管理**——放进 Git 仓库就能回溯、同步、分享
- **属于你**——不锁在任何云端服务里

**设置界面翻译**（可选）：可以把**其他插件的设置页**也翻译成中文——钩住 Obsidian 的 `Setting` 组件，只替换文本节点、不碰 DOM 结构、跳过本插件与已含中文的内容。默认关闭，可指定通道（免费 / 百度）与黑名单。

**价值**：翻译是「信息平权」的核心。多层降级保证「任何环境下都有结果」，TM 笔记保证「译文可被修正与沉淀」——翻译不是一次性消费品，而是能一代代积累的公共资产。

---

### 3.3 卡片：一眼看懂一个插件

每张卡片承载：

- 中文译名 + 英文原名（可切换显示偏好）
- 作者（点击钻取该作者的全部插件）
- 下载量、最近更新时间、新上线标记
- 状态徽标：已安装 / 已启用 / 有更新 / 弃用标记
- 健康度信号：维护活跃度与风险降级提示
- 未翻译提示：如实标出「尚未有中文译名」

卡片上的操作：安装 / 卸载、启用开关、加入对比、收藏、写评测、了解功能（AI 洞察）、打开仓库、打开插件设置。

**价值**：把「判断值不值得装」所需的信息压缩到一屏，且**未翻译状态如实标注**——我们不做「假装翻译过」的事。

---

### 3.4 详情抽屉（从敢装到装得明白）

- **README 翻译**：整篇 README 译成中文，可切换翻译通道、返回原文、一键复制
- **macOS 系统翻译**（仅 macOS 桌面端）：调用系统翻译能力处理长文
- **了解功能**：用 AI 概括这个插件「到底能干什么」
- **相似推荐**：基于分类与功能标签给出同类插件，便于横向比较
- **版本选择**：查看历史版本并**固定安装某个版本**（避免新版本引入不兼容）
- **依赖图谱**：显示必需 / 可选依赖及其状态（已装 / 缺失 / 未启用 / 版本过低），可一键补齐；同时显示「谁依赖了它」
- **我的评测**：记录安装次数、卸载时间、评分与弃用原因（沉淀进「我的插件足迹」）

**价值**：把英文 README、隐藏的依赖、版本风险这些「只有读懂英文才拿得到的信息」全部补齐，让决策不再依赖别人的推荐。

---

### 3.5 筛选与排序

**筛选维度**：翻译状态（全部 / 已翻译 / 未翻译）、安装状态（全部 / 已装 / 已启用 / 已装未启用）、收藏、官方推荐、中文生态、系列（竹林中国系列 / 羽鳞精选）、装过、弃用、踩坑原因、分类、作者、新上线与近期更新时间窗口（1 / 3 / 7 / 30 / 90 / 365 天）。

筛选条件以小圆片（facet chip）常驻显示，随手 ✕ 即清——**不会出现「列表莫名其妙变少却不知道为什么」**。

**排序方式**：相关度、下载量、最近更新、名称、最新上架、热度、趋势、推荐。

| 排序 | 适合场景 |
|---|---|
| 相关度 | 关键词搜索后，找最匹配的 |
| 下载量 | 想找「大家都用」的稳妥选择 |
| 最近更新 / 最新上架 | 想找活跃维护或新出现的工具 |
| 热度 / 趋势 | 想发现最近正被更多人安装的插件 |
| 推荐 | 想看官方与社区的策划清单 |

---

### 3.6 安装、更新与更新管理

- **安装 / 卸载 / 启用**：走半官方 API 并正确维护 Obsidian 配置；支持直链安装（Beta 插件、主题）
- **固定版本**：详情页可锁定特定版本安装
- **更新页签**：集中展示已安装插件的可用更新，支持**批量更新**（全部更新 / 更新选中）
- **健康度徽标**：按最后发布时长判断维护状态（活跃 / 老化 / 风险），阈值与「风险插件降级」可配置
- **更新提醒**：ribbon 图标红点提示待更新数量

**价值**：装得上之外还要**装得稳**——版本固定、批量更新、健康度提示共同降低「更新后崩掉」的风险。

---

### 3.7 对比：把纠结变成决策

把 ≥2 个候选插件加入**对比托盘**，打开对比视图并排比较，可让 AI 给出深度分析，并**导出为 Markdown 或截图**（便于留存或分享给他人）。

**价值**：功能相近的插件最难选，而这类比较恰恰最依赖英文描述——对比模式把这一步中文化并结构化。

---

### 3.8 收藏、足迹与推荐体系

- **收藏**：可分组管理，构建自己的中文插件工具箱
- **我的插件足迹**（独立视图）：记录装过的每个插件——状态、评分、弃用原因、首次安装、最近动态，可复制为 Markdown
- **羽鳞精选**：人工策划清单，在排序中置顶
- **竹林中国系列**：面向中文用户的系列插件，可单独筛选
- **官方推荐**：策划推荐清单
- **中文生态**：中文相关插件的人工清单 + 算法判定
- **趋势**：基于采样数据计算近期安装热度

**价值**：推荐不该只由「下载量」这一个英文世界的数字决定。人工策划 + 中文生态 + 本地趋势，让中文用户的需求进入排序逻辑。

---

### 3.9 组合（Profile）与批量管理

把当前启用的一组插件保存为**组合**，可一键应用、绑定布局，并为每个组合生成一条命令（可在快捷键设置里绑定）。适合「写作模式 / 研究模式 / 整理模式」这类场景切换。

**已装插件管理**：给 Obsidian 原生的「社区插件」设置页增强——分组、备注、筛选；CSS 片段页同样支持分组与批量启用 / 停用 / 删除。

**价值**：不是替代官方面板，而是**在官方面板上补一层中文组织能力**——尊重已有习惯，只补齐缺失部分。

---

### 3.10 命令与入口

| 命令 | 作用 |
|---|---|
| 插件搜索 | 打开主市场视图 |
| 打开我的插件足迹 | 打开评测台账视图 |
| 打开社区插件管理 | 跳转到 Obsidian 原生「设置 → 社区插件」 |
| 从直链安装插件 / 直链安装主题 | 直链安装弹窗（Beta 插件 / 主题） |
| 检查更新 | 检测已安装插件的可用更新 |
| 清除 / 打开翻译记忆库 | 维护 TM 笔记 |
| 应用组合：`<名称>` | 每个组合一条动态命令 |
| 启用 / 停用 `<插件>` | 每个已装插件一条动态命令 |
| 切换 CSS 片段 `<名称>` | 每个片段一条动态命令 |

> 插件不预设快捷键，可在 Obsidian 的「快捷键」设置里自行绑定。

---

### 3.11 设置项地图

设置面板按主题分组，关键项如下（默认值以界面为准）：

- **偏好**：数据源筛选、默认排序、名称显示方式（译名优先 / 原名优先）
- **更新管理**：新上线与近期更新窗口、健康度徽标与阈值、风险降级、趋势采样与保留天数、安装后更新提醒
- **数据源**：镜像源（GitHub / jsDelivr / 自定义）——网络不通时可以换源，而不是被挡在门外
- **翻译引擎**：各免费通道开关、百度 / 腾讯云密钥、自托管地址、AI 翻译配置
- **AI 语义搜索**：开关、BaseURL / Key / Model、是否展示推理过程
- **本地向量**：模型选择（默认 `Xenova/multilingual-e5-small`）、HF 镜像、WebGPU 状态、索引管理
- **缓存与质量**：清除译名缓存、清除 AI 词典
- **翻译记忆库**：路径、迁移、打开文件夹、清除已采纳、评测笔记路径
- **设置页翻译**：开关、通道、黑名单
- **组合（Profile）**：保存 / 应用 / 绑定布局 / 删除
- **已装插件管理**：增强开关、插件分组、CSS 片段分组

---

## 四、隐私与数据

原则是「能本地就本地，能不传就不传」：

- **必须联网的部分**：拉取官方插件清单与统计（`raw.githubusercontent.com` 或 jsDelivr 镜像）、你启用的翻译通道、你填的 AI 地址、本地语义模型的一次性下载（HuggingFace 或镜像）
- **需要密钥才启用的部分**：百度、腾讯云、AI 翻译与 AI 搜索、自托管服务——**默认全部关闭**
- **密钥存储**：密钥单独存于插件目录下的 `credentials.json`，并从普通配置 `data.json` 中剥离，避免备份 vault 时误泄露
- **本地优先**：关键词搜索、本地语义搜索、已缓存译名、翻译记忆、SQLite 向量索引全部在本地；翻译全部失败时如实回退原文，而不是给你一段错误译文
- **你的译文归你**：翻译记忆是 vault 里的 Markdown 文件，可编辑、可删除、可随仓库同步

---

## 五、为什么这样设计：技术选择背后的立场

| 选择 | 做法 | 立场 |
|---|---|---|
| 翻译多级降级 | 免费零配置通道打底，密钥通道可选 | 不让「没有密钥 / 不会配置」成为获取信息的门槛 |
| 本地向量（WebAssembly） | transformers.js 跑在独立 worker，模型可走镜像 | 语义检索能力不应依赖付费 API |
| 镜像可切换 | GitHub / jsDelivr / 自定义 | 网络环境不该把人挡在生态之外 |
| 译文落成 Markdown | 翻译记忆写在 vault，可人工编辑 | 翻译是公共资产，不是服务方的私有数据 |
| 增强而非替代官方面板 | 给原生设置页加分组 / 备注 / 筛选 | 不夺走用户已有习惯，只补齐缺失 |
| 移动端同等适配 | 触控热区、容器查询断点、平板折叠策略 | 「能用」不等于「好用」，移动端也要完整体验 |
| 如实标注未翻译 | 未命中译文时明确提示 | 宁可承认没翻译，也不制造假的理解 |

---

## 六、架构与开发者指南

### 分层

项目采用**七层单向依赖**架构（详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)），import 统一走 `@layer/*` 别名，禁止跨层相对路径：

| 层 | 路径 | 职责 |
|---|---|---|
| **app** | `src/app/` | Obsidian 装配层：插件入口、命令、设置面板、更新器、平台适配 |
| **ui** | `src/ui/` | 视图与组件：虚拟滚动列表、卡片、工具栏、详情抽屉、各页签 |
| **domain** | `src/domain/` | 纯逻辑域（不依赖 Obsidian）：检索、排序、推荐、对比、依赖、评测 |
| **translation** | `src/translation/` | 翻译通道、词典、简繁转换、翻译记忆 |
| **semantic** | `src/semantic/` | 向量嵌入、SQLite 向量库、编解码与 worker |
| **data** | `src/data/` | 平台与 IO：HTTP 端口、存储、安装器、片段管理 |
| **shared** | `src/shared/` | 常量、i18n、工具、平台判定 |

### 数据流

```
官方清单 / 统计（远程，带 TTL 与镜像容错）
   → 本地存储（PluginStorage）
   → 检索与排序管线（关键词 / BM25 / 向量召回 / AI 精排）
   → 推荐与多样性重排
   → 虚拟滚动渲染（DOM 节点数受控）
```

### 关键工程机制

- **虚拟滚动**：定高行 + 上下占位，DOM 节点数受控，搜索输入有防抖
- **向量存储**：sql.js（WASM）承载 SQLite，向量以量化形式存储，变更累积后批量落盘
- **模型推理**：transformers.js 运行在独立 worker bundle 中，模型按需下载，主线程代发跨域请求
- **响应式**：以**容器查询**（`@container`）而非视口宽度做断点，因此在分屏 / 侧栏中也正确
- **无障碍**：卡片、工具栏、抽屉大量使用 `aria-*` / `role` / `tabindex` 标注
- **降级链**：AI 精排失败 → 本地向量 ∪ 关键词；向量失败 → 纯关键词；统计失败 → 复用磁盘缓存；翻译失败 → 原文

### 数据文件与生成脚本

| 文件 | 作用 | 生成 |
|---|---|---|
| `plugin-tags.json` | 离线中文分类索引 | `npm run gen-tags` |
| `plugin-release-dates.json` | 首次上架时间（由官方仓库 git 历史解析） | `npm run gen-release-dates` |
| `plugin-chinese-ecosystem.json` | 中文生态清单 | `npm run gen-chinese-ecosystem` |
| `plugin-recommend.json` | 推荐策划清单 | `node scripts/gen-recommend.mjs` |
| `plugin-deps.json` | 依赖图数据 | `node scripts/gen-plugin-deps.mjs` |
| `seeded-translator-cache.json` | 随包种子译名库 | 构建期产出 |
| `versions.json` | 版本与最低 Obsidian 版本映射 | 发布脚本维护 |

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

| 文档 | 面向 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 分层架构、依赖方向、命名约定（**动手前必读**） |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 开发环境、命令、自检清单 |
| [docs/PERF-ISSUES.md](docs/PERF-ISSUES.md) | 性能问题记录与优化轨迹 |
| [docs/SELF-AUDIT.md](docs/SELF-AUDIT.md) | 提官方市场 PR 前的自检清单 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献流程、分支与提交规范 |

---

## 七、参与共建（一起把塔建起来）

巴别塔不是一个人能重建的。这个项目里，「建塔」的最小单位不是代码，而是**一条译名、一份清单、一次修正**。

### 报告问题与提建议

- Bug 与功能建议请用 [Issues](https://github.com/miaoziguan/obsidian-chinese-plugin-market/issues)（带复现步骤与环境信息）
- 使用问题与开放讨论请到 [Discussions](https://github.com/miaoziguan/obsidian-chinese-plugin-market/discussions)

### 贡献代码

1. Fork 后建分支：`feat/` `fix/` `refactor/` `docs/` + 简短描述
2. 提交前自检（对齐 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)）：
   - `npm run build` —— tsc 零错误 + 构建成功
   - `npm test` —— 单测全绿
   - `npm run lint` —— eslint + stylelint 零报错（含样式 `!important` 拦截）
   - import 全部走 `@layer/*` 别名，依赖方向不反向
3. 提交信息采用类 Conventional Commits（`fix(css): …` / `feat(ui): …`）
4. 开 PR，正文用 `closes #<issue号>` 关联 issue

> 移动端样式改动请特别留意 [CONTRIBUTING.md](CONTRIBUTING.md) 中的约定：统一用 `.pt-mobile` 类（它与 `.pt-view` 是同一元素，选择器须写成后代形式），视觉尺寸与桌面零差异，触控热区用 `::after` 隐形扩张，不用 `@media(width)`。

### 贡献译名与数据

三种方式，门槛从低到高：

1. **改自己的翻译记忆**：译文就在 vault 的 `tm/` 目录（可在设置里改路径），是带 frontmatter 的 Markdown，直接编辑即可生效，改完立即优先于在线结果。
2. **提交数据文件 PR**：
   - `plugin-tags.json` —— 分类与标签（可用 `npm run gen-tags` 重新生成）
   - `plugin-chinese-ecosystem.json` —— 中文生态清单
   - `plugin-recommend.json` —— 推荐策划清单
   - `plugin-deps.json` —— 依赖数据（可用 `node scripts/gen-plugin-deps.mjs` 生成）
   - `plugin-release-dates.json` —— 上架时间（可用 `npm run gen-release-dates` 生成）
3. **参与词典补译**：`npm run check-dict` 会按缺失情况产出补译报告，可按报告逐条补译后提交。

### 鸣谢

设置页「鸣谢」列出了所有贡献者的 GitHub 账号。每一条译名、每一次修正都会被记在这里——**天下大同不是一家之言，而是众人各添一块砖**。

---

## 八、许可证

MIT —— 自由使用，自由改造。

---

## English

**Chinese Market** is an Obsidian community-plugin browser built for Chinese-speaking users. The official plugin directory lists thousands of plugins with English names and English READMEs; Chinese Market removes that barrier so you can **search in Chinese, read in Chinese, and decide with confidence**.

Its goal is not to make everyone speak one language, but to **rebuild the tower** — so that people using different languages can reach the same tools.

Highlights:

- **Three search modes** — keyword (with advanced syntax), on-device semantic search (offline, no API key), and optional AI semantic search.
- **Layered translation pipeline** — free zero-config channels by default, optional key-based providers, with automatic fallback and offline seed dictionary.
- **Translation memory as Markdown** — translations live in your vault, editable and versionable.
- **Rich detail view** — translated README, AI summary, similar plugins, dependency graph, version pinning.
- **Filters, sorting, compare mode, favorites, profiles** — the full management loop, in Chinese.
- **Enhances rather than replaces** Obsidian's native plugin settings, adding grouping, notes and filtering.

Install from Obsidian's community plugin browser, or manually from [Releases](https://github.com/miaoziguan/obsidian-chinese-plugin-market/releases). Requires Obsidian 1.13.0+; works on desktop and mobile.

Development: `npm install`, `npm run dev`, `npm run build`, `npm test`, `npm run lint`. Architecture and contribution rules are documented in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

MIT licensed.
