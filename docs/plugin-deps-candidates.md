# 依赖候选（弱信号，需人工抽查后并入 scripts/deps/curated.json）

弱信号（README 弱措辞 / main.js 低置信）不自动入库：误报比漏报贵，一条错误的「必需」会劝退安装。
确认成立的，把目标 hub 加进 scripts/deps/curated.json 的 dependents 即可下次生效。

| 插件 | 插件名 | 依赖 | 依赖名 | 类型 | 置信度 | 来源 |
| --- | --- | --- | --- | --- | --- | --- |
| sheets | Sheets Extended | table-editor-obsidian | Advanced Tables | optional | 0.35 | readme |
| remotely-secure | Remotely Sync | remotely-save | Remotely Save | optional | 0.35 | readme |
| contribution-graph | Contribution Graph | dataview | Dataview | optional | 0.35 | readme |
| better-order-list | Better Order List | order-list | Order List | optional | 0.35 | readme |
| orion-publish | Orion Publish | feeds | Feeds | optional | 0.35 | readme |
| structured-tree | Structured Tree | obsidian-structured-plugin | Structured | optional | 0.35 | readme |
| latex-exporter | Latex Exporter | obsidian-citation-plugin | Citations | optional | 0.35 | readme |
| exmemo-client | ExMemo Client | file-preview | File Preview | optional | 0.35 | readme |
| calloutx | CalloutX | desk | Desk | optional | 0.35 | readme |
| shaahmaat-md | ShaahMaat-md | arrows-in-md | Arrows | optional | 0.35 | readme |
