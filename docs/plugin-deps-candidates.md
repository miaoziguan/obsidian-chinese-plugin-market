# 依赖候选（弱信号，需人工抽查后并入 scripts/deps/curated.json）

弱信号（README 弱措辞 / main.js 低置信）不自动入库：误报比漏报贵，一条错误的「必需」会劝退安装。
确认成立的，把目标 hub 加进 scripts/deps/curated.json 的 dependents 即可下次生效。

| 插件 | 插件名 | 依赖 | 依赖名 | 类型 | 置信度 | 来源 |
| --- | --- | --- | --- | --- | --- | --- |
