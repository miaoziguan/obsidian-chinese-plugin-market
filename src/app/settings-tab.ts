import {
	PluginSettingTab,
	Setting,
	Notice,
	requestUrl,
	Platform,
	type App,
	type SettingDefinitionItem,
} from "obsidian";
import type ChinesePluginMarket from "@app/main";
import { makeT, type I18nKey } from "@shared/i18n";
import { normalizeBaseUrl } from "@shared/utils";
import { isWebGPUAvailable } from "@semantic/embedding";
import { VIEW_TYPE } from "@shared/constants";
import { asAppInternals } from "@data/platform/obsidian-internals";
import { applyProfileByIds, applyEnabledProfile } from "@data/platform/plugin-installer";
import type { PluginProfile, ChinesePluginMarketView } from "@ui/view/translator-view";

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


	/**
	 * 声明式设置定义（Obsidian 1.13+ 可搜索设置面板）。
	 * 值绑定类设置项用 control（key 透传 getControlValue/setControlValue），
	 * 按钮用 action，自托管列表/嵌入状态等复杂项用 render 保持原行为。
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		const s = this.plugin.settings;
		return [
			{
				type: "group",
				heading: this.t("settings.prefs"),
				items: [
					{
						name: this.t("settings.prefs.sourceFilter"),
						control: {
							type: "dropdown",
							key: "sourceFilter",
							defaultValue: "all",
							options: {
								all: this.t("settings.prefs.sourceFilter.all"),
								translated: this.t("settings.prefs.sourceFilter.translated"),
								original: this.t("settings.prefs.sourceFilter.original"),
							},
						},
					},
					{
						name: this.t("settings.prefs.sortBy"),
						control: {
							type: "dropdown",
							key: "sortBy",
							defaultValue: "downloads",
							options: {
								downloads: this.t("settings.prefs.sortBy.downloads"),
								updated: this.t("settings.prefs.sortBy.updated"),
							},
						},
					},
				],
			},
			{
				type: "group",
				heading: this.t("settings.updateManage"),
				desc: this.t("settings.updateManage.desc"),
				items: [
					{
						name: this.t("settings.updateManage.defaultNew"),
						desc: this.t("settings.updateManage.defaultNew.desc"),
						control: {
							type: "dropdown",
							key: "defaultNewWithinDays",
							defaultValue: "off",
							options: {
								off: this.t("settings.updateManage.window.off"),
								"1": this.t("settings.updateManage.window.1"),
								"3": this.t("settings.updateManage.window.3"),
								"7": this.t("settings.updateManage.window.7"),
								"30": this.t("settings.updateManage.window.30"),
								"90": this.t("settings.updateManage.window.90"),
								"365": this.t("settings.updateManage.window.365"),
							},
						},
					},
					{
						name: this.t("settings.updateManage.defaultUpdated"),
						desc: this.t("settings.updateManage.defaultUpdated.desc"),
						control: {
							type: "dropdown",
							key: "defaultUpdatedWithinDays",
							defaultValue: "off",
							options: {
								off: this.t("settings.updateManage.window.off"),
								"1": this.t("settings.updateManage.window.1"),
								"3": this.t("settings.updateManage.window.3"),
								"7": this.t("settings.updateManage.window.7"),
								"30": this.t("settings.updateManage.window.30"),
								"90": this.t("settings.updateManage.window.90"),
								"365": this.t("settings.updateManage.window.365"),
							},
						},
					},
					{
						name: this.t("settings.updateManage.healthBadge"),
						desc: this.t("settings.updateManage.healthBadge.desc"),
						control: { type: "toggle", key: "showHealthBadge", defaultValue: true },
					},
					{
						name: this.t("settings.updateManage.demoteAtRisk"),
						desc: this.t("settings.updateManage.demoteAtRisk.desc"),
						visible: () => this.plugin.settings.showHealthBadge,
						control: { type: "toggle", key: "demoteAtRisk", defaultValue: false },
					},
					{
						name: this.t("settings.updateManage.healthHealthy"),
						desc: this.t("settings.updateManage.healthHealthy.desc"),
						visible: () => this.plugin.settings.showHealthBadge,
						control: { type: "text", key: "healthHealthyDays", placeholder: "120" },
					},
					{
						name: this.t("settings.updateManage.healthAging"),
						desc: this.t("settings.updateManage.healthAging.desc"),
						visible: () => this.plugin.settings.showHealthBadge,
						control: { type: "text", key: "healthAgingDays", placeholder: "365" },
					},
					{
						name: this.t("settings.updateManage.trendSampling"),
						desc: this.t("settings.updateManage.trendSampling.desc"),
						control: { type: "toggle", key: "trendSampling", defaultValue: true },
					},
					{
						name: this.t("settings.updateManage.trendInterval"),
						visible: () => this.plugin.settings.trendSampling,
						control: {
							type: "dropdown",
							key: "trendIntervalMs",
							defaultValue: String(6 * 60 * 60 * 1000),
							options: {
								"3600000": this.t("settings.updateManage.interval.3600000"),
								"21600000": this.t("settings.updateManage.interval.21600000"),
								"43200000": this.t("settings.updateManage.interval.43200000"),
								"86400000": this.t("settings.updateManage.interval.86400000"),
							},
						},
					},
					{
						name: this.t("settings.updateManage.trendKeep"),
						desc: this.t("settings.updateManage.trendKeep"),
						visible: () => this.plugin.settings.trendSampling,
						control: { type: "text", key: "trendKeepDays", placeholder: "90" },
					},
					{
						name: this.t("settings.updateManage.notifyInstalled"),
						desc: this.t("settings.updateManage.notifyInstalled.desc"),
						control: { type: "toggle", key: "notifyInstalledUpdates", defaultValue: true },
					},
				],
			},
			{
				type: "group",
				heading: this.t("settings.dataSource"),
				desc: this.t("settings.dataSource.desc"),
				items: [
					{
						name: this.t("settings.mirror"),
						desc: this.t("settings.mirror.desc"),
						control: {
							type: "dropdown",
							key: "mirrorSource",
							defaultValue: "github",
							options: {
								jsdelivr: this.t("settings.mirror.jsdelivr"),
								github: this.t("settings.mirror.github"),
								custom: this.t("settings.mirror.custom"),
							},
						},
					},
					{
						name: this.t("settings.mirror.customBase"),
						desc: this.t("settings.mirror.customBase.desc"),
						visible: () => s.mirrorSource === "custom",
						control: {
							type: "text",
							key: "mirrorCustomBase",
							placeholder: "https://...",
						},
					},
				],
			},
			{
				type: "group",
				heading: this.t("settings.engineAndAi"),
				desc: this.t("settings.engineAndAi.desc"),
				items: [
					{
						name: this.t("settings.engine.myMemory"),
						desc: this.t("settings.engine.myMemory.desc"),
						control: { type: "toggle", key: "useMyMemory", defaultValue: true },
					},
					{
						type: "page",
						name: this.t("settings.tencent.title"),
						items: [
							{
								name: this.t("settings.tencent.secretId"),
								desc: this.t("settings.tencent.secretId.desc"),
								control: { type: "text", key: "secretId", placeholder: "AKID..." },
							},
							{
								name: this.t("settings.tencent.secretKey"),
								desc: this.t("settings.tencent.secretKey.desc"),
								control: { type: "text", key: "secretKey", placeholder: "..." },
							},
							{
								name: this.t("settings.tencent.region"),
								desc: this.t("settings.tencent.region.desc"),
								control: { type: "text", key: "region", placeholder: "ap-guangzhou" },
							},
						],
					},
					{
						type: "page",
						name: this.t("settings.ai.title"),
						items: [
							{
								name: this.t("settings.ai.enable"),
								desc: this.t("settings.ai.enable.desc"),
								control: { type: "toggle", key: "aiSearchEnabled", defaultValue: false },
							},
							{
								name: this.t("settings.ai.baseUrl"),
								desc: this.t("settings.ai.baseUrl.desc"),
								control: { type: "text", key: "aiSearchBaseURL", placeholder: "https://api.deepseek.com" },
							},
							{
								name: this.t("settings.ai.key"),
								desc: this.t("settings.ai.key.desc"),
								control: { type: "text", key: "aiSearchApiKey", placeholder: "sk-..." },
							},
							{
								name: this.t("settings.ai.model"),
								desc: this.t("settings.ai.model.desc"),
								control: { type: "text", key: "aiSearchModel", placeholder: "deepseek-chat" },
							},
							{
								name: this.t("settings.ai.test"),
								desc: this.t("settings.ai.test.desc"),
								render: (setting) => {
									setting.addButton((btn) =>
										btn
											.setButtonText(this.t("settings.ai.test.btn"))
											.onClick(() => void this.testAIConnection())
									);
								},
							},
							{
								name: this.t("settings.ai.showReason"),
								desc: this.t("settings.ai.showReason.desc"),
								control: { type: "toggle", key: "aiSearchShowReason", defaultValue: false },
							},
						],
					},
					{
						name: this.t("settings.selfHosted.title"),
						desc: this.t("settings.selfHosted.desc"),
						render: (setting) => this.renderSelfHosted(setting),
					},
					{
						type: "page",
						name: this.t("settings.embedding.title"),
						items: [
							{
								name: this.t("settings.embedding.mode"),
								desc: this.t("settings.embedding.mode.desc"),
								control: {
									type: "dropdown",
									key: "embeddingSource",
									defaultValue: "local",
									options: {
										keyword: this.t("settings.embedding.keyword"),
										api: this.t("settings.embedding.api"),
										local: this.t("settings.embedding.local"),
									},
								},
							},
							{
								// #6: 移动端语义搜索降级提示。仅移动端展示，提醒用户本地模型的内存/下载开销。
								name: this.t("settings.embedding.mobileWarn"),
								visible: () => Platform.isMobile,
								render: (setting) => {
									setting.descEl.setText(this.t("settings.embedding.mobileWarn"));
								},
							},
							{
								name: this.t("settings.embedding.baseUrl"),
								desc: this.t("settings.embedding.baseUrl.desc"),
								visible: () => s.embeddingSource === "api",
								control: { type: "text", key: "embeddingBaseURL", placeholder: "https://api.openai.com" },
							},
							{
								name: this.t("settings.embedding.key"),
								desc: this.t("settings.embedding.key.desc"),
								visible: () => s.embeddingSource === "api",
								control: { type: "text", key: "embeddingApiKey", placeholder: "sk-..." },
							},
							{
								name: this.t("settings.embedding.model"),
								desc: this.t("settings.embedding.model.desc"),
								visible: () => s.embeddingSource === "api",
								control: { type: "text", key: "embeddingModel", placeholder: "text-embedding-3-small" },
							},
							{
								name: this.t("settings.embedding.localModel"),
								desc: this.t("settings.embedding.localModel.desc"),
								visible: () => s.embeddingSource === "local",
								control: { type: "text", key: "embeddingLocalModel", placeholder: "Xenova/bge-small-zh-v1.5" },
							},
							{
								name: this.t("settings.embedding.wasm"),
								desc: this.t("settings.embedding.wasm.desc"),
								visible: () => s.embeddingSource === "local",
								control: { type: "text", key: "embeddingLocalWasmPaths", placeholder: "/wasm/" },
							},
							{
								name: this.t("settings.embedding.webgpu"),
								visible: () => s.embeddingSource === "local",
								desc: isWebGPUAvailable()
									? this.t("settings.embedding.webgpu.on")
									: this.t("settings.embedding.webgpu.off"),
							},
							{
								name: this.t("settings.embedding.ready"),
								visible: () => s.embeddingSource === "local",
								desc: this.t("settings.embedding.ready.checking"),
								render: (setting) => {
									void this.plugin.getLocalVectorStatus().then((st) => {
										const parts: string[] = [];
										parts.push(`SQLite：${st.sqliteReady ? "✓ 就绪" : "✗ 不可用"}`);
										parts.push(`transformers.js：${st.transformReady ? "✓ 就绪" : "✗ 缺失"}`);
										if (!st.sqliteReady && !st.sqlWasm) {
											parts.push(`（缺 sql-wasm.wasm，需 ./sync.sh --with-ml）`);
										}
										setting.descEl.setText(parts.join(" · "));
									}).catch(() => setting.descEl.setText(this.t("settings.embedding.ready.fail")));
								},
							},
							{
								name: this.t("settings.embedding.index"),
								visible: () => s.embeddingSource === "local",
								desc: this.t("settings.embedding.index.idle"),
								render: (setting) => this.renderEmbeddingIndex(setting),
							},
						],
					},
				],
			},
			{
				type: "group",
				heading: this.t("settings.cacheQuality"),
				items: [
					{
						name: this.t("settings.cache"),
						desc: this.t("settings.cache.desc"),
						render: (setting) => {
							setting.addButton((btn) =>
								btn
									.setButtonText(this.t("settings.cache.clear"))
									.setDestructive()
									.onClick(() => void this.clearCache())
							);
						},
					},
					{
						name: this.t("settings.aidict"),
						desc: `${this.t("settings.aidict.desc")} ${this.plugin.translator.getAIDictSize()} 条）`,
						render: (setting) => {
							setting.addButton((btn) =>
								btn
									.setButtonText(this.t("settings.aidict.clear"))
									.setDestructive()
									.onClick(() => void this.clearAIDict())
							);
						},
					},
				],
			},
			{
				type: "group",
				heading: this.t("settings.tm"),
				desc: this.t("settings.tm.desc"),
				items: [
					{
						name: this.t("settings.tm.clearApproved"),
						desc: this.t("settings.tm.clearDesc"),
						render: (setting) => {
							setting.addButton((btn) =>
								btn
									.setButtonText(this.t("settings.tm.clearApproved"))
									.setDestructive()
									.onClick(() => void this.plugin.clearApprovedTM())
							);
						},
					},
				],
			},
			{
				type: "group",
				heading: this.t("settings.profiles"),
				desc: this.t("settings.profiles.desc"),
				items: [
					{
						name: this.t("settings.profiles.list"),
						// 现有预设列表 + 保存新预设（动态渲染，增删后重画本设置页）
						render: (setting) => {
							const list = this.plugin.settings.profiles;
							// 预设列表：每行「名称 · N个」+ 应用 + 删除
							for (const p of list) {
								const row = setting.controlEl.createDiv({ cls: "pt-profile-row" });
								row.createSpan({ text: `${p.name}（${p.enabled.length}）`, cls: "pt-profile-name" });
								row.createEl("button", { text: this.t("settings.profiles.apply") }).addEventListener("click", () => {
									void this.applyProfile(p);
								});
								row.createEl("button", { text: this.t("settings.profiles.delete"), cls: "pt-profile-del" }).addEventListener("click", () => {
									this.plugin.settings.profiles = list.filter((x) => x !== p);
									void this.plugin.flushSaveSettings();
									new Notice(this.t("settings.profiles.deleted", { name: p.name }));
									this.display();
								});
							}
							// 保存当前为预设
							const nameInput = setting.controlEl.createEl("input", {
								cls: "pt-profile-input",
								placeholder: this.t("settings.profiles.name.ph"),
							});
							setting.controlEl.createEl("button", {
								text: this.t("settings.profiles.save"),
								cls: "pt-profile-save",
							}).addEventListener("click", () => {
								const name = nameInput.value.trim();
								if (!name) {
									new Notice(this.t("settings.profiles.nameRequired"));
									return;
								}
								const enabled = this.getCurrentEnabledIds();
								const profiles = this.plugin.settings.profiles.slice();
								const idx = profiles.findIndex((x) => x.name === name);
								const profile: PluginProfile = { name, enabled: [...enabled] };
								if (idx >= 0) {
									profiles[idx] = profile;
									new Notice(this.t("settings.profiles.exists", { name }));
								} else {
									profiles.push(profile);
									new Notice(this.t("settings.profiles.saved", { name, n: String(enabled.size) }));
								}
								this.plugin.settings.profiles = profiles;
								void this.plugin.flushSaveSettings();
								this.display();
							});
						},
					},
				],
			},
		];
	}

	/** 读取当前真正启用的插件 id 集合（来自 app.plugins.enabledPlugins，不依赖视图是否打开） */
	private getCurrentEnabledIds(): Set<string> {
		const plugins = asAppInternals(this.app).plugins;
		const ep = plugins?.enabledPlugins as unknown as Set<string> | string[] | undefined;
		if (!ep) return new Set();
		return new Set(ep);
	}

	/** 应用一个启用组合 Profile（排除本插件自身，避免误关市场） */
	private async applyProfile(p: PluginProfile): Promise<void> {
		const selfId = this.plugin.manifest.id;
		const target = new Set(p.enabled);
		// 视图开着则用 ctx 包装版（应用后即时刷新卡片），否则用底层版（仅落盘+内存）
		const view = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view as
			| ChinesePluginMarketView
			| undefined;
		const r = view?.ctx
			? await applyEnabledProfile(view.ctx, target, selfId)
			: await applyProfileByIds(this.app, this.getCurrentEnabledIds(), target, selfId);
		new Notice(this.t("settings.profiles.applied", { name: p.name, n: String(r.enabled), m: String(r.disabled) }));
	}

	/** 声明式控件读值：透传到 plugin.settings[key] */
	getControlValue(key: string): unknown {
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	/** 移动端切到本地模型时，本设置页会话内已弹过的内存警告标记（#6：警告一次） */
	private mobileLocalWarned = false;

	/** 声明式控件写值：透传到 plugin.settings[key]，带 trim/类型收窄 + 副作用 + 持久化 */
	setControlValue(key: string, value: unknown): void | Promise<void> {
		// #6: 移动端用户手动切到本地模型时，弹一次内存占用警告（自担风险）。
		if (key === "embeddingSource" && value === "local" && Platform.isMobile && !this.mobileLocalWarned) {
			this.mobileLocalWarned = true;
			new Notice(this.t("settings.embedding.mobileLocalNotice"), 8000);
		}
		const s = this.plugin.settings as unknown as Record<string, unknown>;
		switch (key) {
			case "mirrorCustomBase":
			case "secretId":
			case "secretKey":
			case "region":
			case "aiSearchBaseURL":
			case "aiSearchApiKey":
			case "aiSearchModel":
			case "embeddingBaseURL":
			case "embeddingApiKey":
			case "embeddingModel":
			case "embeddingLocalModel":
			case "embeddingLocalWasmPaths":
				s[key] = typeof value === "string" ? value.trim() : value;
				break;
			// 数字字段：声明式 dropdown/text 回传字符串，收敛为 number（null 表示不过滤）
			case "defaultNewWithinDays":
			case "defaultUpdatedWithinDays":
			case "trendIntervalMs":
			case "healthHealthyDays":
			case "healthAgingDays":
			case "trendKeepDays":
				s[key] = value == null || value === "" || value === "off"
					? null
					: Number(value);
				break;
			default:
				s[key] = value;
		}
		if (key === "secretId" || key === "secretKey" || key === "region") {
			this.syncTranslatorApiConfig();
		}
		if (key === "aiSearchEnabled" || key === "aiSearchBaseURL" || key === "aiSearchApiKey" || key === "aiSearchModel") {
			this.syncTranslatorAIConfig();
		}
		if (key === "useMyMemory") {
			this.plugin.translator.setUseMyMemory(Boolean(value));
		}
		if (key === "notifyInstalledUpdates") {
			// 关闭更新提醒时立即清除 ribbon 红点；开启时由下次检测（或打开视图）重算
			if (!value) this.plugin.setRibbonUpdateBadge(0);
		}
		return this.plugin.flushSaveSettings();
	}

	/** 渲染自托管翻译源列表（增/删/改行） */
	private renderSelfHosted(setting: Setting): void {
		const items = this.plugin.settings.selfHostedTranslators;
		const listEl = setting.controlEl.createDiv({ cls: "pt-selfhosted-list" });
		const render = () => {
			listEl.empty();
			if (items.length === 0) {
				listEl.createDiv({
					cls: "pt-selfhosted-empty",
					text: this.t("settings.selfHosted.empty"),
				});
				return;
			}
			items.forEach((item, idx) => {
				const row = listEl.createDiv({ cls: "pt-selfhosted-row" });
				const sel = row.createEl("select", { cls: "pt-selfhosted-type" });
				(["deeplx", "libretranslate"] as const).forEach((tp) => {
					const opt = sel.createEl("option", {
						value: tp,
						text: this.t(`settings.selfHosted.type.${tp}` as I18nKey),
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
				});
				txt.value = item.baseUrl;
				txt.addEventListener("change", () => {
					void (async () => {
						this.plugin.settings.selfHostedTranslators[idx].baseUrl = txt.value.trim();
						await this.plugin.flushSaveSettings();
						this.syncSelfHosted();
					})();
				});
				const del = row.createEl("button", { cls: "pt-selfhosted-del", text: "✕" });
				del.addEventListener("click", () => {
					void (async () => {
						this.plugin.settings.selfHostedTranslators.splice(idx, 1);
						await this.plugin.flushSaveSettings();
						this.syncSelfHosted();
						render();
					})();
				});
			});
		};
		render();
		setting.addButton((btn) =>
			btn
				.setButtonText(this.t("settings.selfHosted.addBtn"))
				.setTooltip(this.t("settings.selfHosted.add"))
				.onClick(() => {
					void (async () => {
						this.plugin.settings.selfHostedTranslators.push({ type: "deeplx", baseUrl: "" });
						await this.plugin.flushSaveSettings();
						this.syncSelfHosted();
						render();
					})();
				})
		);
	}

	private async clearCache(): Promise<void> {
		this.plugin.translator.clearCache();
		this.plugin.saveTranslatorData();
		new Notice(this.t("notice.cacheCleared"));
	}

	private async clearAIDict(): Promise<void> {
		this.plugin.translator.clearAIDict();
		this.plugin.saveTranslatorData();
		new Notice(this.t("notice.aiDictCleared"));
	}

	/** 渲染本地向量索引构建行：按钮 + 实时状态（building→done/error/idle）+ 进度条 + Notice 提示 */
	private renderEmbeddingIndex(setting: Setting): void {
		// 进度条（building 时显示，其它态隐藏）
		const progress = setting.controlEl.createEl("progress", { cls: "pt-index-progress" });
		progress.max = 100;
		progress.value = 0;
		progress.setCssStyles({ display: "none", width: "100%", margin: "6px 0 0" });

		let btn: { setDisabled: (d: boolean) => void; setButtonText: (t: string) => void } | null = null;
		const renderState = () => {
			if (!btn) return;
			const st = this.plugin.localIndexState;
			if (st.status === "building") {
				setting.descEl.setText(this.t("settings.embedding.index.building", { p: String(st.progress), t: String(st.total) }));
				const pct = st.total > 0 ? Math.round((st.progress / st.total) * 100) : 0;
				progress.value = pct;
				progress.setCssStyles({ display: "" });
				btn.setDisabled(true);
				btn.setButtonText(this.t("settings.embedding.index.buildingBtn"));
			} else {
				if (st.status === "done") setting.descEl.setText(this.t("settings.embedding.index.done"));
				else if (st.status === "error") setting.descEl.setText(this.t("settings.embedding.index.error") + (st.error ? `（${st.error}）` : ""));
				else setting.descEl.setText(this.t("settings.embedding.index.idle"));
				progress.setCssStyles({ display: "none" });
				btn.setDisabled(false);
				btn.setButtonText(this.t("settings.embedding.index.btn"));
			}
		};
		setting.addButton((b) => {
			btn = b;
			b.setButtonText(this.t("settings.embedding.index.btn")).onClick(async () => {
				if (this.plugin.localIndexState.status === "building") return;
				setting.descEl.setText(this.t("settings.embedding.index.start"));
				new Notice(this.t("settings.embedding.index.start"), 4000);
				// 构建期间轮询 localIndexState，实时刷新进度条（buildLocalIndex 内部用时间片让出主线程）
				const timer = window.setInterval(() => renderState(), 120);
				await this.plugin.buildLocalIndex(true);
				window.clearInterval(timer);
				const st = this.plugin.localIndexState;
				if (st.status === "done") {
					new Notice(this.t("settings.embedding.index.doneNotice", { p: String(st.progress) }), 6000);
				} else if (st.status === "error") {
					new Notice(this.t("settings.embedding.index.errorNotice") + (st.error || ""), 10000);
				}
				renderState();
			});
		});
		renderState();
		void this.plugin.getLocalVectorStatus().then((st) => {
			// 若当前非构建态，补一行 SQLite 就绪状态（构建态不打断进度文案）
			if (this.plugin.localIndexState.status !== "building") {
				setting.descEl.setText(`${this.t("settings.embedding.index.idle")} · SQLite ${st.sqliteReady ? "✓" : "✗"}`);
			}
		}).catch(() => {});
	}
}
