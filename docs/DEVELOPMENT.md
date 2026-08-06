# 开发文档 / Development

面向本仓库贡献者的实操指南。架构与分层规则见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

---

## 一、环境准备

- **Node.js** ≥ 18(建议 20+)
- **包管理器**:pnpm(仓库有 `pnpm-lock.yaml` / `pnpm-workspace.yaml`;`package-lock.json` 亦保留兼容 npm)

```bash
pnpm install        # 或 npm install
```

> `pnpm-workspace.yaml` 里 `publicHoistPattern: onnxruntime-web` 是必需的——`esbuild.config.mjs` 硬编码了 `./node_modules/onnxruntime-web` 路径,pnpm 默认不提升该间接依赖,需显式提升以命中 WASM 拷贝与别名。

---

## 二、常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发构建(一次性,inline sourcemap,非 watch) |
| `npm run build` | `tsc` 类型检查 + esbuild 生产构建(minify + external sourcemap) |
| `npm test` | 运行 vitest 单元测试 |
| `npm run test:e2e` | 构建 e2e bundle 并跑 Playwright |
| `npm run sync` | 构建并同步产物到本地 Obsidian vault(见 `sync.sh`) |
| `npm run gen-tags` | 由脚本重生成 `plugin-tags.json`(分类索引) |
| `npm run check-dict` | 校验离线词典增量(`check-dict-delta.ts`) |

> `dev` 不是 watch 模式:改完源码需重新执行,或用 `npm run sync` 一步构建+推送。

---

## 三、构建产物与分发

esbuild 分两步(见 `esbuild.config.mjs`):

1. **Step 1** 打包 `src/semantic/workers/embedding-worker.ts` → 中间产物,内联进主 bundle。
2. **Step 2** 打包 `src/app/main.ts` → `main.js`。

打包进 `main.js` 的运行时:`sql.js`、`@huggingface/transformers`、onnxruntime-web。`obsidian` / `electron` / CodeMirror / Lezer 走 `external`(由宿主提供)。

**随插件分发的文件**(见 `sync.sh` 的 `FILES`):
```
main.js  styles.css  manifest.json
plugin-tags.json  plugin-recommend.json
sql-wasm.wasm  ort-wasm-simd-threaded.jsep.wasm
```
两个 `.wasm` 在构建时由 `copyWasm` 从 `node_modules` 拷到仓库根,SQLite 向量库与本地模型 WASM 回退依赖它们。

---

## 四、在 Obsidian 里调试

1. 构建:`npm run dev`。
2. 把分发文件放进 vault:`<vault>/.obsidian/plugins/chinese-plugin-market/`——直接用 `./sync.sh /path/to/vault`(含 `.obsidian` 的目录)自动构建+拷贝;`./sync.sh --no-build /path` 只拷不构建。
3. Obsidian → 设置 → 第三方插件 → 启用「Chinese Market」。
4. 改代码后重新 `sync`,在 Obsidian 用 `Cmd/Ctrl+R` 重载。

插件支持移动端(`manifest.json` 的 `isDesktopOnly: false`);`minAppVersion` 为 1.13.0。macOS 系统翻译等平台能力仅桌面端生效。

---

## 五、测试

### 单元测试(vitest)
- 位置:与被测源码同目录的 `*.test.ts`(`include: src/**/*.test.ts`)。
- 环境:jsdom;`test/setup.ts` 为全局初始化。
- 别名:`vitest.config.ts` 的 `resolve.alias` 手写 `@layer` 映射(与 tsconfig 一一对应)。
- **Obsidian mock**:`obsidian` 被指向 `test/mocks/obsidian.ts`;`@inline-worker` 指向 `test/mocks/inline-worker.ts`。需要网络的用例各自 mock provider,不走真实 `requestUrl`。

写测试时优先测 `domain` / `translation/lexicon` / `shared` 等纯逻辑,无需 DOM 即可覆盖。

### 端到端(Playwright)
- 位置:`test/e2e/*.spec.js`。
- `npm run test:e2e` 先跑 `scripts/build-e2e.mjs` 构建,再由 `scripts/serve-e2e.mjs` 起本地服务(`:4173`)供 Playwright 访问。

---

## 六、编码约定

- **import 一律用别名**(`@shared/*`、`@domain/*` …),不写跨层 `../../` 相对路径。别名唯一来源是 `tsconfig.json` 的 `paths`。
- **遵守依赖方向**:只向下依赖(`app→ui→domain→…→shared`)。需要"向上"时改用接口注入(依赖倒置)。
- **文件命名** kebab-case;放进对应层的子目录(归属判断见 [ARCHITECTURE.md §六](./ARCHITECTURE.md))。
- **平台隔离**:能不 import `obsidian` 就不 import;新平台调用尽量收口到 `data/` 或 `app/`。
- **日志**走 `@shared/logger`,不直接用 `console`。
- **文案**走 `@shared/i18n` 的 `t(key)`,新增 UI 文字先在 `STRINGS` 字典登记。
- `tsconfig` 开了 `noUnusedLocals` / `noUnusedParameters` / `strictNullChecks`——提交前确保 `npm run build` 的 `tsc` 阶段零报错。

---

## 七、数据文件

| 文件 | 来源 | 说明 |
|---|---|---|
| `plugin-tags.json` | `npm run gen-tags` | 插件 id→分类/功能标签离线索引 |
| `plugin-recommend.json` | `scripts/gen-recommend.mjs` | 官方推荐清单(标题 + id 列表) |

离线词典改动后用 `npm run check-dict` 校验增量,避免误删已有译名。

---

## 八、发布流程

1. 更新 `manifest.json` 与 `package.json` 的 `version`(保持一致)。
2. 在 `versions.json` 追加 `"<新版本>": "<minAppVersion>"`(供 Obsidian 判断兼容性)。
3. `npm run build` 确认类型检查 + 构建通过,`npm test` 全绿。
4. 发布 GitHub Release,附 `main.js`、`manifest.json`、`styles.css`(及需要的数据/WASM 文件)。

---

## 九、提交前自检清单

- [ ] `npm run build` —— tsc 零错误 + esbuild 成功产出 `main.js`
- [ ] `npm test` —— vitest 全绿
- [ ] import 全部走 `@layer` 别名,无跨层相对路径
- [ ] 新增代码归属层正确,依赖方向未反向
- [ ] 新平台耦合已尽量收口到 `data/` 或 `app/`
