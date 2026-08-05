import { PluginSettingTab, Setting, Notice, requestUrl, type App } from "obsidian";
import type ChinesePluginMarket from "./main";
import { makeT, type I18nKey } from "./i18n";
import { normalizeBaseUrl } from "./utils";
import { isWebGPUAvailable } from "./embedding";
import type { SourceFilter } from "./filter";

export class TranslatorSettingTab extends PluginSettingTab {
	private plugin: ChinesePluginMarket;

	constructor(app: App, plugin: ChinesePluginMarket) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private t = makeT();

	/** 把当前 AI 配置实时同步给翻译引擎（视图的 applyAIConfig 是私有的，这里直接调 translator） */
	private syncTranslatorAIConfig() {
		const s = this.plugin.settings;
		this.plugin.translator.setAIConfig(
			s.aiSearchEnabled && s.aiSearchApiKey
				? {
						baseURL: s.aiSearchBaseURL,
						apiKey: s.aiSearchApiKey,
						model: s.aiSearchModel,
				  }
				: null
		);
	}

	/** 把当前腾讯翻译配置实时同步给翻译引擎 */
	private syncTranslatorApiConfig() {
		const s = this.plugin.settings;
		this.plugin.translator.setApiConfig(
			s.secretId && s.secretKey
				? { secretId: s.secretId, secretKey: s.secretKey, region: s.region }
				: null
		);
	}

	/** 把当前自托管翻译源实时同步给翻译引擎 */
	private syncSelfHosted() {
		this.plugin.translator.setSelfHostedTranslators(this.plugin.settings.selfHostedTranslators);
	}

	/** 测试 AI 连接是否联通（参照竹叶飞刃的做法：发一次最小请求，按 HTTP 状态给友好提示） */
	private async testAIConnection(): Promise<void> {
		const s = this.plugin.settings;
		if (!s.aiSearchApiKey) {
			new Notice(this.t("settings.ai.test.noKey"));
			return;
		}
		const baseURL = normalizeBaseUrl(s.aiSearchBaseURL || "https://api.openai.com");
		const model = s.aiSearchModel || "deepseek-chat";
		try {
			new Notice(this.t("settings.ai.test.testing"));
			const startTime = Date.now();
			const response = await requestUrl({
				url: `${baseURL}/v1/chat/completions`,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${s.aiSearchApiKey}`,
				},
				body: JSON.stringify({
					model,
					messages: [{ role: "user", content: "你好" }],
					max_tokens: 10,
				}),
				throw: false,
			});
		const latency = Date.now() - startTime;
		if (response.status === 200) {
			const json = response.json as
				| { model?: string; usage?: { total_tokens?: number } }
				| undefined;
			const respModel = json?.model || model;
			const tokensUsed = json?.usage?.total_tokens;
				const tokenInfo = tokensUsed ? ` · 消耗 ${tokensUsed} tokens` : "";
				new Notice(
					`✓ ${this.t("settings.ai.test.ok")} · ${respModel} · ${latency}ms${tokenInfo}`,
					8000
				);
			} else if (response.status === 401 || response.status === 403) {
				new Notice(`✗ ${this.t("settings.ai.test.badKey")}`, 10000);
			} else if (response.status === 429) {
				new Notice(`✗ ${this.t("settings.ai.test.rate")}`, 10000);
			} else if (response.status >= 500) {
				new Notice(`✗ ${this.t("settings.ai.test.server")}（HTTP ${response.status}）`, 10000);
			} else {
				new Notice(`✗ ${this.t("settings.ai.test.http")}（HTTP ${response.status}）`, 8000);
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			let friendly = msg;
			if (msg.includes("Failed to fetch") || msg.includes("network") || msg.includes("ENOTFOUND")) {
				friendly = this.t("settings.ai.test.netfail");
			}
			new Notice(`✗ ${this.t("settings.ai.test.fail")}：${friendly}`, 10000);
		}
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("pt-settings-page");

		// 小节标题 + 说明辅助函数
		const section = (titleKey: I18nKey, descKey?: I18nKey) => {
			const wrap = containerEl.createDiv({ cls: "pt-settings-section" });
			new Setting(wrap).setHeading().setName(this.t(titleKey));
			if (descKey) {
				wrap.createEl("p", {
					text: this.t(descKey),
					cls: "pt-settings-section-desc",
				});
			}
			return wrap;
		};

		// ── 默认偏好 ──
		const prefs = section("settings.prefs", "settings.prefs.desc");
		new Setting(prefs)
			.setName(this.t("settings.prefs.sourceFilter"))
			.addDropdown((dd) =>
				dd
					.addOption("all", this.t("settings.prefs.sourceFilter.all"))
					.addOption("translated", this.t("settings.prefs.sourceFilter.translated"))
					.addOption("original", this.t("settings.prefs.sourceFilter.original"))
					.setValue(this.plugin.settings.sourceFilter)
					.onChange(async (value) => {
						this.plugin.settings.sourceFilter = value as SourceFilter;
						await this.plugin.flushSaveSettings();
					})
			);
		new Setting(prefs)
			.setName(this.t("settings.prefs.sortBy"))
			.addDropdown((dd) =>
				dd
					.addOption("downloads", this.t("settings.prefs.sortBy.downloads"))
					.addOption("updated", this.t("settings.prefs.sortBy.updated"))
					.setValue(this.plugin.settings.sortBy)
					.onChange(async (value) => {
						this.plugin.settings.sortBy = value as
							| "downloads"
							| "updated";
						await this.plugin.flushSaveSettings();
					})
			);

		// ── 数据源 ──
		const ds = section("settings.dataSource", "settings.dataSource.desc");
		new Setting(ds)
			.setName(this.t("settings.mirror"))
			.setDesc(this.t("settings.mirror.desc"))
			.addDropdown((dd) =>
				dd
					.addOption("jsdelivr", this.t("settings.mirror.jsdelivr"))
					.addOption("github", this.t("settings.mirror.github"))
					.addOption("custom", this.t("settings.mirror.custom"))
					.setValue(this.plugin.settings.mirrorSource)
					.onChange(async (value) => {
						this.plugin.settings.mirrorSource = value as
							| "jsdelivr"
							| "github"
							| "custom";
						await this.plugin.flushSaveSettings();
						this.display();
					})
			);
		const customMirrorSetting = new Setting(ds)
			.setName(this.t("settings.mirror.customBase"))
			.setDesc(this.t("settings.mirror.customBase.desc"))
			.addText((txt) =>
				txt
					.setPlaceholder("https://...")
					.setValue(this.plugin.settings.mirrorCustomBase)
					.onChange(async (value) => {
						this.plugin.settings.mirrorCustomBase = value.trim();
						await this.plugin.flushSaveSettings();
					})
			);
		customMirrorSetting.settingEl.setCssStyles({
			display: this.plugin.settings.mirrorSource === "custom" ? "" : "none",
		});

		// ── 翻译引擎 ──
		const engineSec = section("settings.engineAndAi", "settings.engineAndAi.desc");
		new Setting(engineSec)
			.setName(this.t("settings.engine.myMemory"))
			.setDesc(this.t("settings.engine.myMemory.desc"))
			.addToggle((tg) =>
				tg
					.setValue(this.plugin.settings.useMyMemory)
					.onChange(async (v) => {
						this.plugin.settings.useMyMemory = v;
						await this.plugin.flushSaveSettings();
						this.plugin.translator.setUseMyMemory(v);
					})
			);
		// 腾讯翻译折叠（大多数用户用不到，默认收起）
		const tencentDetails = engineSec.createEl("details", { cls: "pt-settings-details" });
		tencentDetails.createEl("summary", { text: this.t("settings.tencent.title") });
		const tencentBody = tencentDetails.createDiv({ cls: "pt-settings-details-body" });
		new Setting(tencentBody)
			.setName(this.t("settings.tencent.secretId"))
			.setDesc(this.t("settings.tencent.secretId.desc"))
			.addText((txt) =>
				txt
					.setPlaceholder("AKID...")
					.setValue(this.plugin.settings.secretId)
					.onChange(async (value) => {
						this.plugin.settings.secretId = value.trim();
						await this.plugin.flushSaveSettings();
						this.syncTranslatorApiConfig();
					})
			);
		new Setting(tencentBody)
			.setName(this.t("settings.tencent.secretKey"))
			.setDesc(this.t("settings.tencent.secretKey.desc"))
			.addText((txt) =>
				txt
					.setPlaceholder("...")
					.setValue(this.plugin.settings.secretKey)
					.onChange(async (value) => {
						this.plugin.settings.secretKey = value.trim();
						await this.plugin.flushSaveSettings();
						this.syncTranslatorApiConfig();
					})
			);
		new Setting(tencentBody)
			.setName(this.t("settings.tencent.region"))
			.setDesc(this.t("settings.tencent.region.desc"))
			.addText((txt) =>
				txt
					.setPlaceholder("ap-guangzhou")
					.setValue(this.plugin.settings.region)
					.onChange(async (value) => {
						this.plugin.settings.region = value.trim();
						await this.plugin.flushSaveSettings();
						this.syncTranslatorApiConfig();
					})
			);

		// ── AI 能力（折叠，默认收起） ──
		const aiDetails = engineSec.createEl("details", { cls: "pt-settings-details" });
		aiDetails.createEl("summary", { text: this.t("settings.ai.title") });
		const aiBody = aiDetails.createDiv({ cls: "pt-settings-details-body" });
		new Setting(aiBody)
			.setName(this.t("settings.ai.enable"))
			.setDesc(this.t("settings.ai.enable.desc"))
			.addToggle((tg) =>
				tg
					.setValue(this.plugin.settings.aiSearchEnabled)
					.onChange(async (v) => {
						this.plugin.settings.aiSearchEnabled = v;
						await this.plugin.flushSaveSettings();
						this.syncTranslatorAIConfig();
					})
			);
		new Setting(aiBody)
			.setName(this.t("settings.ai.baseUrl"))
			.setDesc(this.t("settings.ai.baseUrl.desc"))
			.addText((txt) =>
				txt
					.setPlaceholder("https://api.deepseek.com")
					.setValue(this.plugin.settings.aiSearchBaseURL)
					.onChange(async (value) => {
						this.plugin.settings.aiSearchBaseURL = value.trim();
						await this.plugin.flushSaveSettings();
						this.syncTranslatorAIConfig();
					})
			);
		new Setting(aiBody)
			.setName(this.t("settings.ai.key"))
			.setDesc(this.t("settings.ai.key.desc"))
			.addText((txt) =>
				txt
					.setPlaceholder("sk-...")
					.setValue(this.plugin.settings.aiSearchApiKey)
					.onChange(async (value) => {
						this.plugin.settings.aiSearchApiKey = value.trim();
						await this.plugin.flushSaveSettings();
						this.syncTranslatorAIConfig();
					})
			);
		new Setting(aiBody)
			.setName(this.t("settings.ai.model"))
			.setDesc(this.t("settings.ai.model.desc"))
			.addText((txt) =>
				txt
					.setPlaceholder("deepseek-chat")
					.setValue(this.plugin.settings.aiSearchModel)
					.onChange(async (value) => {
						this.plugin.settings.aiSearchModel = value.trim();
						await this.plugin.flushSaveSettings();
						this.syncTranslatorAIConfig();
					})
			);
		new Setting(aiBody)
			.setName(this.t("settings.ai.test"))
			.setDesc(this.t("settings.ai.test.desc"))
			.addButton((btn) =>
				btn
					.setButtonText(this.t("settings.ai.test.btn"))
					.onClick(async () => {
						await this.testAIConnection();
					})
			);
		new Setting(aiBody)
			.setName(this.t("settings.ai.showReason"))
			.setDesc(this.t("settings.ai.showReason.desc"))
			.addToggle((tg) =>
				tg
					.setValue(this.plugin.settings.aiSearchShowReason)
					.onChange(async (v) => {
						this.plugin.settings.aiSearchShowReason = v;
						await this.plugin.flushSaveSettings();
					})
			);

		// ── 自托管翻译源（DeepLX / LibreTranslate，可选增强，默认折叠）──
		const shDetails = engineSec.createEl("details", { cls: "pt-settings-details" });
		shDetails.createEl("summary", { text: this.t("settings.selfHosted.title") });
		const shBody = shDetails.createDiv({ cls: "pt-settings-details-body" });
		shBody.createEl("p", {
			cls: "pt-settings-hint",
			text: this.t("settings.selfHosted.desc"),
		});
		const shList = shBody.createDiv({ cls: "pt-selfhosted-list" });
		const renderSelfHosted = () => {
			shList.empty();
			const items = this.plugin.settings.selfHostedTranslators;
			if (items.length === 0) {
				shList.createDiv({
					cls: "pt-selfhosted-empty",
					text: this.t("settings.selfHosted.empty"),
				});
				return;
			}
			items.forEach((item, idx) => {
				const row = shList.createDiv({ cls: "pt-selfhosted-row" });
				const sel = row.createEl("select", { cls: "pt-selfhosted-type" }) as HTMLSelectElement;
				(["deeplx", "libretranslate"] as const).forEach((tp) => {
					const opt = sel.createEl("option", {
						value: tp,
						text: this.t(`settings.selfHosted.type.${tp}`),
					});
					if (tp === item.type) opt.selected = true;
				});
			sel.addEventListener("change", () => {
				void (async () => {
					this.plugin.settings.selfHostedTranslators[idx].type = sel.value as
						| "deeplx"
						| "libretranslate";
					await this.plugin.flushSaveSettings();
					this.syncSelfHosted();
				})();
			});
			const txt = row.createEl("input", {
				cls: "pt-selfhosted-url",
				type: "text",
				placeholder: "http://localhost:1188",
			}) as HTMLInputElement;
			txt.value = item.baseUrl;
			txt.addEventListener("change", () => {
				void (async () => {
					this.plugin.settings.selfHostedTranslators[idx].baseUrl = txt.value.trim();
					await this.plugin.flushSaveSettings();
					this.syncSelfHosted();
				})();
			});
			const del = row.createEl("button", {
				cls: "pt-selfhosted-del",
				text: "✕",
			});
			del.addEventListener("click", () => {
				void (async () => {
					this.plugin.settings.selfHostedTranslators.splice(idx, 1);
					await this.plugin.flushSaveSettings();
					this.syncSelfHosted();
					this.display();
				})();
			});
		});
	};
	renderSelfHosted();
	new Setting(shBody)
		.setName(this.t("settings.selfHosted.add"))
		.addButton((btn) =>
			btn
				.setButtonText(this.t("settings.selfHosted.addBtn"))
				.onClick(() => {
					void (async () => {
						this.plugin.settings.selfHostedTranslators.push({
							type: "deeplx",
							baseUrl: "",
						});
						await this.plugin.flushSaveSettings();
						this.syncSelfHosted();
						this.display();
					})();
				})
			);

		// ── 检索召回（Embedding / 关键词，默认折叠；大多数用户无需配置，保留"关键词"即可）──
		const embDetails = engineSec.createEl("details", { cls: "pt-settings-details" });
		embDetails.createEl("summary", { text: this.t("settings.embedding.title") });
		const embInner = embDetails.createDiv({ cls: "pt-settings-details-body" });
		new Setting(embInner)
			.setName(this.t("settings.embedding.mode"))
			.setDesc(this.t("settings.embedding.mode.desc"))
			.addDropdown((dd) =>
				dd
					.addOption("keyword", this.t("settings.embedding.keyword"))
					.addOption("api", this.t("settings.embedding.api"))
					.addOption("local", this.t("settings.embedding.local"))
					.setValue(this.plugin.settings.embeddingSource)
					.onChange(async (value) => {
						this.plugin.settings.embeddingSource = value as
							| "keyword"
							| "api"
							| "local";
						await this.plugin.flushSaveSettings();
						this.display();
					})
			);
		// API 模式字段组（仅 api 模式时显示）
		const isApi = this.plugin.settings.embeddingSource === "api";
		const isLocal = this.plugin.settings.embeddingSource === "local";
		const embUrl = new Setting(embInner)
			.setName(this.t("settings.embedding.baseUrl"))
			.setDesc(this.t("settings.embedding.baseUrl.desc"))
			.addText((txt) =>
				txt
					.setPlaceholder("https://api.openai.com")
					.setValue(this.plugin.settings.embeddingBaseURL)
					.onChange(async (value) => {
						this.plugin.settings.embeddingBaseURL = value.trim();
						await this.plugin.flushSaveSettings();
					})
			);
		const embKey = new Setting(embInner)
			.setName(this.t("settings.embedding.key"))
			.setDesc(this.t("settings.embedding.key.desc"))
			.addText((txt) =>
				txt
					.setPlaceholder("sk-...")
					.setValue(this.plugin.settings.embeddingApiKey)
					.onChange(async (value) => {
						this.plugin.settings.embeddingApiKey = value.trim();
						await this.plugin.flushSaveSettings();
					})
			);
		const embModel = new Setting(embInner)
			.setName(this.t("settings.embedding.model"))
			.setDesc(this.t("settings.embedding.model.desc"))
			.addText((txt) =>
				txt
					.setPlaceholder("text-embedding-3-small")
					.setValue(this.plugin.settings.embeddingModel)
					.onChange(async (value) => {
						this.plugin.settings.embeddingModel = value.trim();
						await this.plugin.flushSaveSettings();
					})
			);
		// 本地模式字段组（仅 local 模式时显示）
		const embLocal = new Setting(embInner)
			.setName(this.t("settings.embedding.localModel"))
			.setDesc(this.t("settings.embedding.localModel.desc"))
			.addText((txt) =>
				txt
					.setPlaceholder("Xenova/bge-small-zh-v1.5")
					.setValue(this.plugin.settings.embeddingLocalModel)
					.onChange(async (value) => {
						this.plugin.settings.embeddingLocalModel = value.trim();
						await this.plugin.flushSaveSettings();
					})
			);
		const embWasm = new Setting(embInner)
			.setName(this.t("settings.embedding.wasm"))
			.setDesc(this.t("settings.embedding.wasm.desc"))
			.addText((txt) =>
				txt
					.setPlaceholder("/wasm/")
					.setValue(this.plugin.settings.embeddingLocalWasmPaths)
					.onChange(async (value) => {
						this.plugin.settings.embeddingLocalWasmPaths = value.trim();
						await this.plugin.flushSaveSettings();
					})
			);
		// WebGPU 可用性提示（仅 local 模式显示）
		const webgpuOn = isWebGPUAvailable();
		const embGpu = new Setting(embInner)
			.setName(this.t("settings.embedding.webgpu"))
			.setDesc(
				webgpuOn
					? this.t("settings.embedding.webgpu.on")
					: this.t("settings.embedding.webgpu.off")
			);
		// 本地运行时就绪状态（SQLite + transformers.js，仅 local 模式显示）
		const embReady = new Setting(embInner)
			.setName(this.t("settings.embedding.ready"))
			.setDesc(this.t("settings.embedding.ready.checking"));
		void this.plugin.getLocalVectorStatus().then((st) => {
			const parts: string[] = [];
			parts.push(`SQLite：${st.sqliteReady ? "✓ 就绪" : "✗ 不可用"}`);
			parts.push(`transformers.js：${st.transformReady ? "✓ 就绪" : "✗ 缺失"}`);
			if (!st.sqliteReady && !st.sqlWasm) {
				parts.push(`（缺 sql-wasm.wasm，需 ./sync.sh --with-ml）`);
			}
			embReady.setDesc(parts.join(" · "));
		}).catch(() => embReady.setDesc(this.t("settings.embedding.ready.fail")));

		// 后台预建本地向量索引（A+B：手动触发 + 状态展示）
		const embIndex = new Setting(embInner)
			.setName(this.t("settings.embedding.index"))
			.setDesc(this.t("settings.embedding.index.idle"));
		let buildBtn: { setDisabled: (d: boolean) => void; setButtonText: (t: string) => void } | null = null;
		const renderIndexState = () => {
			const st = this.plugin.localIndexState;
			if (!buildBtn) return;
			if (st.status === "building") {
				embIndex.setDesc(this.t("settings.embedding.index.building", { p: String(st.progress), t: String(st.total) }));
				buildBtn.setDisabled(true);
				buildBtn.setButtonText(this.t("settings.embedding.index.buildingBtn"));
			} else {
				if (st.status === "done") embIndex.setDesc(this.t("settings.embedding.index.done"));
				else if (st.status === "error") embIndex.setDesc(this.t("settings.embedding.index.error") + (st.error ? `（${st.error}）` : ""));
				else embIndex.setDesc(this.t("settings.embedding.index.idle"));
				buildBtn.setDisabled(false);
				buildBtn.setButtonText(this.t("settings.embedding.index.btn"));
			}
		};
		embIndex.addButton((b) => {
			buildBtn = b;
			b.setButtonText(this.t("settings.embedding.index.btn")).onClick(async () => {
				if (this.plugin.localIndexState.status === "building") return;
				embIndex.setDesc(this.t("settings.embedding.index.start"));
				await this.plugin.buildLocalIndex(true);
				renderIndexState();
				// 状态变更后重新拉一次（构建完成/失败）
				void this.plugin.getLocalVectorStatus().then((st) => {
					const parts: string[] = [];
					parts.push(`SQLite：${st.sqliteReady ? "✓ 就绪" : "✗ 不可用"}`);
					parts.push(`transformers.js：${st.transformReady ? "✓ 就绪" : "✗ 缺失"}`);
					embReady.setDesc(parts.join(" · "));
				}).catch(() => {});
			});
		});
		renderIndexState();
		// 根据模式显示/隐藏相应字段组
		for (const s of [embUrl, embKey, embModel]) s.settingEl.setCssStyles({ display: isApi ? "" : "none" });
		for (const s of [embLocal, embWasm, embGpu, embReady, embIndex]) s.settingEl.setCssStyles({ display: isLocal ? "" : "none" });

		// ── 缓存与质量 ──
		const cacheSec = section("settings.cacheQuality");
		new Setting(cacheSec)
			.setName(this.t("settings.cache"))
			.setDesc(this.t("settings.cache.desc"))
			.addButton((btn) =>
				btn
					.setButtonText(this.t("settings.cache.clear"))
					.setDestructive()
					.onClick(() => {
						void (async () => {
							this.plugin.translator.clearCache();
							this.plugin.saveTranslatorData();
							new Notice(this.t("notice.cacheCleared"));
							this.display();
						})();
					})
			);
		new Setting(cacheSec)
			.setName(this.t("settings.aidict"))
			.setDesc(
				`${this.t("settings.aidict.desc")} ${this.plugin.translator.getAIDictSize()} 条）`
			)
			.addButton((btn) =>
				btn
					.setButtonText(this.t("settings.aidict.clear"))
					.setDestructive()
					.onClick(() => {
						void (async () => {
							this.plugin.translator.clearAIDict();
							this.plugin.saveTranslatorData();
							new Notice(this.t("notice.aiDictCleared"));
							this.display();
						})();
					})
			);
		// ── 翻译记忆库 (TM) ──
		const tmSec = section("settings.tm", "settings.tm.desc");
		new Setting(tmSec)
			.setName(this.t("settings.tm.clearApproved"))
			.setDesc(this.t("settings.tm.clearDesc"))
			.addButton((btn) =>
				btn
					.setButtonText(this.t("settings.tm.clearApproved"))
					.setDestructive()
					.onClick(() => void this.plugin.clearApprovedTM())
			);
	}
}
