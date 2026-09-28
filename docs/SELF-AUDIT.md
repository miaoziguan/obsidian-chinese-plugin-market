# 官方审核自我预检清单（Self-Audit）

## 目的
Obsidian 社区插件的官方审核 = 向 `obsidianmd/obsidian-releases` 提 PR + Obsidian 团队**人工 review** + 有限自动化（GitHub Actions 仅校验 manifest 字段、版本单调递增、文件齐全、PR 格式，**不审查代码质量与安全**）。

本清单把官方依据逐条映射为「自动 / 人工」检查，用于**提官方 PR 前先过一遍**，消灭机械性驳回点。
**注意**：语义类问题（是否真的收集数据、性能/体积是否可接受、移动端是否真能跑）只能靠人工判断，自动化替代不了官方审核。

官方依据：
- Plugin guidelines：`docs.obsidian.md/Plugins/Releasing/Plugin+guidelines`
- Developer policies：`docs.obsidian.md/community-directory/developer-policies`

## 0. 本仓库已有的自动化防线
- **ESLint + `eslint-plugin-obsidianmd`**：`prefer-create-el` / `no-static-styles-assignment` / `no-forbidden-elements` / `no-unsupported-api` 已设为 `error`，直接覆盖官方 guidelines 的安全 / 样式红线。
- **Stylelint**：`declaration-no-important` 强制拦截（见 `CONTRIBUTING.md` §六）。
- **CI**（`.github/workflows/ci.yml`）：push / PR 自动跑 `lint` + `test` + `build`。

## 1. 硬性红线（Developer policies，违反即拒 / 移除）
| 红线 | 本插件现状 | 检查 |
|---|---|---|
| 客户端遥测（收集用量数据） | 无；运行时无 analytics / 埋点上报 | 自动：`grep` 无 telemetry/analytics 上报；人工确认 |
| 自更新机制（代码内自动下载更新） | 无；依赖 Obsidian 官方更新通道 | 人工确认无 `fetch` 下载并执行新代码 |
| 动态广告 / UI 外静态广告 | 无 | 人工 |
| 代码混淆 / 加密（必须可审计） | 生产构建对 `main.js` 启用 esbuild `minify`（标准压缩，**非加密/混淆**）；保留 `main.js.map`。如需可审计可提供未压缩产物 | 自动：确保无 `eval` / `new Function` / 加密逻辑；人工确认非混淆 |
| 商标侵权（主名 / `id` 含 "obsidian"、冒充官方） | `manifest.name` = "Chinese Market"、`id` = "chinese-plugin-market"，均不含 "obsidian" | 自动：校验 manifest 字段 |
| 恶意代码 | 无 | 人工 |
| 仓库根 `LICENSE` 文件 | 已存在（根 `LICENSE`） | 自动 / 人工 |

## 2. Plugin guidelines（常见审核评论，逐项对照）
| 条目 | 规则 | 本插件 | 检查 |
|---|---|---|---|
| 安全 | 禁 `innerHTML` / `outerHTML` / `insertAdjacentHTML`，用 `createEl` 等 | 已合规 | 自动：`prefer-create-el`(error) |
| 样式 | 禁硬编码 `el.style.xxx`，用 CSS 类 + Obsidian 变量 | 已合规 | 自动：`no-static-styles-assignment`(error) |
| 资源 | `onunload` 清理事件/资源；推荐 `registerEvent` / `addCommand` | 需确认 worker / wasm 在 unload 释放 | 人工 |
| 资源 | 禁在 `onunload` 中 `detachLeavesOfType` | — | 人工：`grep` 确认 |
| 命令 | 禁默认热键 | — | 人工：`grep` `addCommand` 无 default hotkey |
| 工作区 | 禁直接 `workspace.activeLeaf`；禁持有自定义视图引用 | — | 人工：`grep` 确认 |
| Vault | 用 Vault API 而非 Adapter；`processFrontMatter` / `normalizePath` | 基本不直接操作 vault 文件 | 人工 |
| 性能 | 不遍历全部文件按路径查找 | 主要操作随包 `plugin-*.json`，不遍历 vault | 人工 |
| 通用 | 不用全局 `app` / `window.app`；少 `console.log` | 部分 | 自动：`no-global-this`(warn)；人工查 `console` |
| UI 文本 | 句子大小写、设置标题用 `setHeading`、标题不写 "settings" | — | 人工 |
| 移动端 | 避免 Node / Electron API、regex lookbehind | ⚠️ 见 §3 风险 1 | 人工 |

## 3. ⚠️ 本次预检发现的风险点（需决策）
1. **`isDesktopOnly: false` 却重度依赖 wasm / onnx / sql.js**
   `manifest.json` 宣称支持移动端，但插件依赖 `@huggingface/transformers` + `onnxruntime-web`（WebGPU 仅桌面，移动端需回退 wasm，内存/性能压力大）与 `sql.js`（wasm SQLite）。须二选一：
   - 真在 iOS / Android 实测语义搜索 + SQLite 正常；**或**
   - 若仅桌面可用，将 `isDesktopOnly` 改为 `true`，避免上架后被移动端用户投诉 / 审核质疑。
2. **运行时网络请求披露**
   本插件数据来自随包分发的本地 `plugin-*.json`，语义搜索为本地 onnx 推理，**运行时无外部网络请求**，故无需在 README 披露网络服务。提 PR 前请人工确认代码中确实无任何未披露的 `fetch` / 外部请求。
3. **生产 `minify` 的可审计性**
   prod 构建 `minify: true` 属标准压缩，非加密/混淆；已生成 `main.js.map`。如审核要求，可临时提供未压缩 `main.js`。

## 4. 提官方 PR 前的执行步骤
```bash
npm run lint     # eslint + stylelint，必须零报错
npm test         # vitest 全绿
npm run build    # 产出 main.js / styles.css / wasm
```
并在上方清单逐项打勾（尤其 §2 人工项与 §3 风险点已处置），再向 `obsidianmd/obsidian-releases` 提 PR。
