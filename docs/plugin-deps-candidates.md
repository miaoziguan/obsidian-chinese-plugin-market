# 依赖候选（弱信号，需人工抽查后并入 scripts/deps/curated.json）

本文件由 `scripts/gen-plugin-deps.mjs` 全量扫描后生成（当前为空）。

弱信号（README 弱措辞 / main.js 低置信）不自动入库：误报比漏报贵，一条错误的「必需」
会直接劝退用户安装。候选清单里确认成立的关系，把目标 hub 加进
`scripts/deps/curated.json` 的 `dependents` 即可下次生效。

## 运行方式（需联网环境）

```bash
node scripts/gen-plugin-deps.mjs            # 全量
node scripts/gen-plugin-deps.mjs --limit 200 # 先小样本验证
node scripts/gen-plugin-deps.mjs --only-new  # 只处理现有结果里没有的 id
```

扫完后会在此追加表格：`| 插件 | 插件名 | 依赖 | 依赖名 | 类型 | 置信度 | 来源 |`。
