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
import { normalizeBaseUrl, isLocalBaseUrl, isAISearchUsable } from "@shared/utils";
import { BaiduTranslateClient } from "@translation/api/baidu";
import { isWebGPUAvailable } from "@semantic/embedding";
import { asAppInternals } from "@data/platform/obsidian-internals";
import { VIEW_TYPE } from "@shared/constants";
import { logger } from "@shared/logger";
import type { ChinesePluginMarketView } from "@ui/view/translator-view";
import { CONTRIBUTORS, contributorGitHubUrl } from "@shared/contributors";

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
			isAISearchUsable(s.aiSearchEnabled, s.aiSearchBaseURL, s.aiSearchApiKey)
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
		const baseURL = normalizeBaseUrl(s.aiSearchBaseURL || "https://api.openai.com");
		const isLocal = isLocalBaseUrl(s.aiSearchBaseURL || "");
		// 本地模型（如 Ollama / LM Studio）通常无需 API Key，留空 Key 属合法用法；
		// 仅当非本地且无 Key 时才拦截。
		if (!s.aiSearchApiKey && !isLocal) {
			new Notice(this.t("settings.ai.test.noKey"));
			return;
		}
		const model = s.aiSearchModel || "deepseek-chat";
		// Key 可能被前后空白污染（复制粘贴常见坑），自动 trim 用于本次请求，保留 settings 原值不动
		const apiKey = s.aiSearchApiKey?.trim() ?? "";
		try {
			const startTime = Date.now();
			const response = await requestUrl({
				url: `${baseURL}/v1/chat/completions`,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
				},
				body: JSON.stringify({
					model,
					messages: [{ role: "user", content: "你好" }],
					max_tokens: 10,
				}),
				throw: false,
			});
			const latency = Date.now() - startTime;
			// 把请求目标回显（脱敏），便于用户核对「我以为发的是 A，实际是不是 A」
			const reqInfo = `${baseURL} · ${model}`;
			if (response.status === 200) {
				const json = response.json as
					| { model?: string; usage?: { total_tokens?: number } }
					| undefined;
				const tokensUsed = json?.usage?.total_tokens;
				const tokenInfo = tokensUsed ? ` · 消耗 ${tokensUsed} tokens` : "";
				new Notice(
					`✓ ${this.t("settings.ai.test.ok")}\n${reqInfo} · ${latency}ms${tokenInfo}`,
					8000
				);
			} else if (response.status === 401 || response.status === 403) {
				// 鉴权失败：最常见原因是「Key 与 Base URL 不属于同一平台」（如 DeepSeek Key 配硅基流动 URL）。
				// 提示里点明两类原因 + 当前请求目标，便于用户定位。
				new Notice(
					`✗ ${this.t("settings.ai.test.badKey")}\n${reqInfo}\n${this.t("settings.ai.test.badKey.hint")}`,
					14000
				);
			} else if (response.status === 429) {
				new Notice(`✗ ${this.t("settings.ai.test.rate")}\n${reqInfo}`, 10000);
			} else if (response.status >= 500) {
				new Notice(`✗ ${this.t("settings.ai.test.server")}（HTTP ${response.status}）\n${reqInfo}`, 10000);
			} else {
				new Notice(`✗ ${this.t("settings.ai.test.http")}（HTTP ${response.status}）\n${reqInfo}`, 8000);
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

	/** 百度机器翻译连接测试：发一次最小翻译请求，验证 appid + 密钥是否有效 */
	private async testBaiduConnection(): Promise<void> {
		const s = this.plugin.settings;
		if (!s.baiduAppId || !s.baiduKey) {
			new Notice(this.t("settings.baidu.test.noKey"));
			return;
		}
		try {
			new Notice(this.t("settings.baidu.test.testing"));
			const client = new BaiduTranslateClient();
			client.setConfig({ appId: s.baiduAppId, key: s.baiduKey });
			const result = await client.translate("你好");
			if (result && result.trim()) {
				new Notice(`✓ ${this.t("settings.baidu.test.ok")}：${result}`, 8000);
			} else {
				new Notice(`✗ ${this.t("settings.baidu.test.http")}`, 8000);
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			let friendly = msg;
			if (msg.includes("Failed to fetch") || msg.includes("network") || msg.includes("ENOTFOUND")) {
				friendly = this.t("settings.baidu.test.netfail");
			} else if (msg.includes("54003") || msg.includes("54005")) {
				friendly = this.t("settings.baidu.test.rate");
			} else if (msg.includes("52003") || msg.includes("54001") || msg.includes("58000") || msg.includes("90107")) {
				friendly = this.t("settings.baidu.test.badKey");
			} else if (msg.includes("52002") || msg.includes("502")) {
				friendly = this.t("settings.baidu.test.server");
			}
			new Notice(`✗ ${this.t("settings.baidu.test.fail")}：${friendly}`, 10000);
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
				heading: this.t("settings.thanks"),
				desc: this.t("settings.thanks.desc"),
				items: [
					{
						// 左侧 label 留空：group 标题已经是「鸣谢」，无需重复显示
						name: "",
						render: (setting) => this.renderThanks(setting),
					},
				],
			},
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
					{
						name: this.t("settings.prefs.nameDisplay"),
						desc: this.t("settings.prefs.nameDisplay.desc"),
						control: {
							type: "dropdown",
							key: "nameDisplay",
							defaultValue: "translated",
							options: {
								translated: this.t("settings.prefs.nameDisplay.translated"),
								original: this.t("settings.prefs.nameDisplay.original"),
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
						name: this.t("settings.engine.transmart"),
						desc: this.t("settings.engine.transmart.desc"),
						control: { type: "toggle", key: "useTransmart", defaultValue: true },
					},
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
								// 密钥用 SecretComponent：不显示明文，防肩窥（方案 1）
								render: (setting) => this.renderSecretField(setting, "secretKey"),
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
						name: this.t("settings.baidu.title"),
						items: [
							{
								name: this.t("settings.baidu.appId"),
								desc: this.t("settings.baidu.appId.desc"),
								control: { type: "text", key: "baiduAppId", placeholder: "2025xxxx" },
							},
							{
								name: this.t("settings.baidu.key"),
								desc: this.t("settings.baidu.key.desc"),
								// 密钥用 SecretComponent：不显示明文，防肩窥
								render: (setting) => this.renderSecretField(setting, "baiduKey"),
							},
							{
								name: this.t("settings.baidu.test"),
								desc: this.t("settings.baidu.test.desc"),
								render: (setting) => {
									setting.addButton((btn) =>
										btn
											.setButtonText(this.t("settings.baidu.test.btn"))
											.onClick(() => void this.testBaiduConnection())
									);
								},
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
								// 密钥用 SecretComponent：不显示明文，防肩窥（方案 1）
								render: (setting) => this.renderSecretField(setting, "aiSearchApiKey"),
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
								// 密钥用 SecretComponent：不显示明文，防肩窥（方案 1）
								render: (setting) => this.renderSecretField(setting, "embeddingApiKey"),
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
							// 布局样式用 CSS 类（与 renderThanks 同款），规避内联 style 违反规范。
							setting.settingEl.addClass("pt-setting-full-width");
							if (setting.infoEl) setting.infoEl.addClass("pt-setting-info-hidden");
							setting.controlEl.addClass("pt-setting-control-full");
							// 预设列表：每行「名称 · N个 · 布局状态」+ 应用 + 绑定布局 + 删除
							for (const p of list) {
								const row = setting.controlEl.createDiv({ cls: "pt-profile-row" });
								const bound = p.layout ? this.t("settings.profiles.layoutBind") + " ✓" : "";
								row.createSpan({ text: `${p.name}（${p.enabled.length}）${bound ? " · " + bound : ""}`, cls: "pt-profile-name" });
								row.createEl("button", { text: this.t("settings.profiles.apply") }).addEventListener("click", () => {
									void this.plugin.applyProfile(p);
								});
								// 绑定当前布局快照到该组合（自管布局，getLayout() 存快照）
								row.createEl("button", {
									text: p.layout ? this.t("settings.profiles.layoutBind.clear") : this.t("settings.profiles.layoutBind.save"),
								}).addEventListener("click", () => {
									if (p.layout) {
										p.layout = null;
										new Notice(this.t("settings.profiles.layoutCleared", { name: p.name }));
									} else {
										try {
											p.layout = this.plugin.app.workspace.getLayout();
											new Notice(this.t("settings.profiles.layoutBound", { name: p.name }));
										} catch {
											new Notice(this.t("settings.profiles.layoutFail"));
											return;
										}
									}
									void this.plugin.flushSaveSettings();
									this.update();
								});
								row.createEl("button", { text: this.t("settings.profiles.delete"), cls: "pt-profile-del" }).addEventListener("click", () => {
									this.plugin.settings.profiles = list.filter((x) => x !== p);
									void this.plugin.flushSaveSettings();
									this.plugin.refreshProfileCommands();
									new Notice(this.t("settings.profiles.deleted", { name: p.name }));
									// 1.13+ 声明式设置刷新用 update()，display() 已弃用
									this.update();
								});
							}
							// 保存当前为预设（输入框 + 按钮同一行，flex 适配）
							const saveRow = setting.controlEl.createDiv({ cls: "pt-profile-save-row" });
							const nameInput = saveRow.createEl("input", {
								cls: "pt-profile-input",
								placeholder: this.t("settings.profiles.name.ph"),
							});
							saveRow.createEl("button", {
								text: this.t("settings.profiles.save"),
								cls: "pt-profile-save",
							}).addEventListener("click", () => {
								const name = nameInput.value.trim();
								if (!name) {
									new Notice(this.t("settings.profiles.nameRequired"));
									return;
								}
								const overwritten = this.plugin.saveCurrentAsProfile(name);
								new Notice(
									overwritten
										? this.t("settings.profiles.exists", { name })
										: this.t("settings.profiles.saved", { name, n: String(this.getCurrentEnabledIds().size) })
								);
								// 1.13+ 声明式设置刷新用 update()，display() 已弃用
								this.update();
							});
						},
					},
				],
			},
		];
	}

	/** 鸣谢清单渲染：遍历 CONTRIBUTORS，每行「昵称 + 可点击 GitHub 链接」。
	 * 布局样式收敛到 CSS 类 pt-setting-full-width（规避 Obsidian no-static-styles-assignment
	 * 规范：不得用内联 style.setProperty，须用 CSS 类）。 */
	private renderThanks(setting: Setting): void {
		setting.settingEl.addClass("pt-setting-full-width");
		if (setting.infoEl) setting.infoEl.addClass("pt-setting-info-hidden");
		setting.controlEl.addClass("pt-setting-control-full");
		setting.controlEl.empty();
		// 开场文案：致敬贡献者（写在清单上方，左对齐）
		setting.controlEl.createDiv({
			cls: "pt-thanks-prologue",
			text: this.t("settings.thanks.epilogue"),
		});
		const list = setting.controlEl.createDiv({ cls: "pt-thanks-list" });
		for (const c of CONTRIBUTORS) {
			const row = list.createDiv({ cls: "pt-thanks-row" });
			const url = contributorGitHubUrl(c.github);
			// 昵称文本（非链接，便于识别贡献者）
			row.createSpan({ text: c.name, cls: "pt-thanks-name" });
			row.createSpan({ text: " " });
			// GitHub 链接：直接显示 URL，可点击
			const link = row.createEl("a", {
				text: url,
				href: url,
				cls: "pt-thanks-link",
			});
			// 外链：新标签打开，避免离开 Obsidian 上下文
			link.setAttr("target", "_blank");
			link.setAttr("rel", "noopener noreferrer");
		}
	}

	/** 读取当前真正启用的插件 id 集合（来自 app.plugins.enabledPlugins，不依赖视图是否打开） */
	private getCurrentEnabledIds(): Set<string> {
		const plugins = asAppInternals(this.app).plugins;
		const ep = plugins?.enabledPlugins as unknown as Set<string> | string[] | undefined;
		if (!ep) return new Set();
		return new Set(ep);
	}

	/**
	 * 联动重试（对齐 better-store onTokenLinked）：凭据变更后，若市场视图开着，
	 * 重新翻译当前可见的未译项（original 兜底自动重试）。只处理可见项，不烧多余 token。
	 */
	private retryFailedTranslations(): void {
		const view = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view as
			| ChinesePluginMarketView
			| undefined;
		if (!view?.ctx) return;
		void view.ctx.aiTranslateAllPending().catch((e: unknown) => {
			logger.warn("[Chinese Plugin Market] 凭据变更后重试翻译失败：", e);
		});
	}

	/**
	 * 渲染敏感字段输入（防肩窥）。
	 * 之前用 Obsidian 原生 SecretComponent，但它内置的「添加密钥」模态框强制要填 ID（用于 Keychain 命名空间），
	 * 而我们每个字段只用一把密钥，不需要 ID 命名 → 改用 Setting.addText + type=password：
	 * - 无 ID 模态框，用户体验更直接
	 * - 仍然密码遮罩、防肩窥
	 * - 值仍走 setControlValue → settings + credentials.json 持久化，与原来一致
	 */
	private renderSecretField(setting: Setting, key: string): void {
		setting.addText((text) => {
			const current = (this.plugin.settings as unknown as Record<string, unknown>)[key];
			text
				.setPlaceholder("在此粘贴密钥")
				.setValue(typeof current === "string" ? current : "")
				.onChange(async (value) => {
					await this.setControlValue(key, value);
				});
			// 改为密码类型，输入框遮罩显示（防肩窥）
			text.inputEl.type = "password";
			// 防止浏览器自动填充干扰（Obsidian 桌面端影响不大，移动端/Safari 有意义）
			text.inputEl.autocomplete = "off";
			text.inputEl.spellcheck = false;
		});
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
		// 方案 3（对齐 better-store onTokenLinked）：凭据/开关变更后联动重试——
		// 之前因无 key 翻译失败的可见项（original 兜底）自动重新翻译，无需用户手动再触发。
		if (key === "aiSearchApiKey" || key === "aiSearchBaseURL" || key === "aiSearchModel" || key === "secretKey" || key === "embeddingApiKey") {
			this.retryFailedTranslations();
		}
		if (key === "useMyMemory") {
			this.plugin.translator.setUseMyMemory(Boolean(value));
		}
		if (key === "useTransmart") {
			this.plugin.translator.setUseTransmart(Boolean(value));
		}
		if (key === "notifyInstalledUpdates") {
			// 关闭更新提醒时立即清除 ribbon 红点；开启时由下次检测（或打开视图）重算
			if (!value) this.plugin.setRibbonUpdateBadge(0);
		}
		// 标题显示模式变更：即时刷新已打开的列表（标题译名/原名按新模式重绘）
		if (key === "nameDisplay") {
			for (const leaf of this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE)) {
				const view = leaf.view as unknown as { invalidateAndRender?: (preserveScroll: boolean) => void };
				view.invalidateAndRender?.(false);
			}
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
