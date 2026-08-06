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

## 六、行为准则

- 讨论对事不对人,保持友善与尊重。
- 提前在 issue 里对齐技术方案,避免闭门造车后 PR 被拒。
- 拿不准的地方尽管问,没有"愚蠢的问题"。

再次感谢你的贡献 —— 一起把中文区插件生态做得更好!🀄
