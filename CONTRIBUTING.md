# 贡献指南 / Contributing

感谢你愿意为 **Chinese Market** 出一份力!无论是修 Bug、加功能,还是完善文档,都非常欢迎。

---

## 一、开始之前

- **开发环境与命令**:见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。
- **架构与分层规则**:见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。**动手前请务必读一遍**,本项目采用七层单向依赖架构,PR 若违反分层会被要求调整。
- **待办任务**:见仓库 [Issues](https://github.com/miaoziguan/obsidian-chinese-plugin-market/issues),里面有按优先级和难度整理好的任务,可按兴趣认领。

---

## 二、报告问题 / 提建议

请用 GitHub Issue,并选择对应模板:

- **🐛 Bug 报告** —— 发现异常行为,附复现步骤与环境信息。
- **✨ 功能建议** —— 提新功能或改进想法。

使用问题或开放式讨论请到 [Discussions](https://github.com/miaoziguan/obsidian-chinese-plugin-market/discussions)。

---

## 三、认领任务

想接手一个已有任务?很简单:

1. 到 [Issues](https://github.com/miaoziguan/obsidian-chinese-plugin-market/issues) 挑一个你感兴趣的。
2. **在该 issue 下评论认领**(例如「我来做这个 👋」),避免和他人撞车。
3. 有拿不准的技术方案,先在 issue 里和 maintainer 对齐,再动手。

认领后按下方流程提交代码即可。

---

## 四、提交代码流程

1. **Fork & 分支**:
   ```bash
   git checkout -b feat/virtual-scroll
   ```
   分支命名建议:`feat/` `fix/` `refactor/` `docs/` + 简短描述。
2. **开发**:遵守 [ARCHITECTURE.md](docs/ARCHITECTURE.md) 的分层与命名约定。
3. **提交前自检**(对齐 [DEVELOPMENT.md §九](docs/DEVELOPMENT.md)):
   - [ ] `npm run build` —— tsc 零错误 + esbuild 成功产出
   - [ ] `npm test` —— vitest 全绿
   - [ ] `npm run lint` —— eslint + stylelint 零报错（含样式 `!important` 拦截）
   - [ ] import 全部走 `@layer/` 别名,无跨层相对路径
   - [ ] 新增代码归属层正确,依赖方向未反向
   - [ ] 新平台耦合已尽量收口到 `data/` 或 `app/`
4. **开 PR**:填写 PR 模板,正文用 `closes #<issue号>` 关联你认领的 issue,勾选自检清单。
5. **等待 Review**:CI 跑绿 + maintainer 通过后合并。

---

## 五、Commit 信息约定

采用类 Conventional Commits:

| 前缀 | 用途 |
|---|---|
| `feat:` | 新功能 |
| `fix:` | 修复 Bug |
| `refactor:` | 重构(不改行为) |
| `docs:` | 文档 |
| `test:` | 测试 |
| `chore:` | 构建 / 工具 / 依赖 |
| `perf:` | 性能优化 |

示例:`feat: 自研虚拟滚动替换全量常驻 DOM`

---

## 六、CSS / 样式约定（避免 !important）

本项目样式集中在根目录 `styles.css`，构建时原样拷贝进插件分发（不经过 postcss 等处理）。
为避免「用 `!important` 压主题」这类难维护、易回归的写法死灰复燃，做如下约定：

- **命名空间**：所有插件 UI 都挂在 `.pt-view` 根容器下，设计变量一律使用 `--pt-*`（如 `--pt-surface` / `--pt-border` / `--pt-text`），不直接引用 Obsidian 原生 `--background-*` 等变量，以免主题改原生变量后被迫用 `!important` 去覆盖。
- **覆盖主题靠特异性，绝不靠 `!important`**：需要压过主题默认样式时，提高选择器特异性即可——给选择器加 `.pt-view` / `.theme-light` / `.theme-dark` 前缀，或重复类名（如 `.pt-card.pt-card`）。Obsidian 插件样式本身后于主题加载，同/更高特异性下插件稳定胜出。
- **强制拦截**：`stylelint` 的 `declaration-no-important` 规则已在 `npm run lint` 中启用，任何新增 `!important` 都会直接报错。
- **唯一豁免**：无障碍 `prefers-reduced-motion` 的「无条件禁用动画」语义允许使用 `!important`（如 `animation: none !important`），但必须紧邻加 `/* stylelint-disable declaration-no-important */` 注释说明原因。
- **不要引入 postcss 自动前缀**：构建链里不存在 postcss；若日后加 `postcss-prefix-selector` 自动给选择器加 `.pt-view`，会和现有手写的 `.pt-view` 前缀叠加成 `.pt-view .pt-view …`，而 DOM 里只有一个 `.pt-view`，选择器直接失效、UI 崩。现有前缀 + 后加载已足够，无需此机制。

## 七、行为准则

- 讨论对事不对人,保持友善与尊重。
- 提前在 issue 里对齐技术方案,避免闭门造车后 PR 被拒。
- 拿不准的地方尽管问,没有"愚蠢的问题"。

再次感谢你的贡献 —— 一起把中文区插件生态做得更好!🀄
