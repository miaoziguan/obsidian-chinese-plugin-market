import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TranslatorSettingTab } from "@app/settings-tab";
import type ChinesePluginMarket from "@app/main";
import { DEFAULT_SETTINGS } from "@ui/view/translator-view";
import { createDefaultManageSettings } from "@domain/manage/group";
import { PHASE } from "@domain/search/search-timing";
import { setHttpClient, resetHttpClient, type HttpResponse } from "@data/net/http-port";
import { Platform } from "obsidian";

/**
 * `Notice` 是 obsidian 的模块导出（不是 globalThis 属性），无法用
 * `vi.spyOn(globalThis, "Notice")` 拦截，故用 vi.mock 替换整个模块，
 * 其余导出原样透传。
 */
const notices = vi.hoisted(() => ({ messages: [] as string[], durations: [] as number[] }));

/**
 * 网络替身：testAIConnection / testBaiduConnection 会真实调用 requestUrl，
 * 这里拦截并允许用例注入「HTTP 状态」或「抛错」，从而覆盖每种失败分支。
 */
const netStub = vi.hoisted(() => ({
	lastRequest: null as null | Record<string, unknown>,
	response: { status: 200, json: {} } as unknown,
	error: null as null | unknown,
}));

vi.mock("obsidian", async (importOriginal) => {
	const actual = await importOriginal<typeof import("obsidian")>();
	class NoticeStub {
		constructor(message: string, duration?: number) {
			notices.messages.push(message);
			notices.durations.push(duration ?? 0);
		}
	}
	return {
		...actual,
		Notice: NoticeStub,
		requestUrl: async (opts: Record<string, unknown>) => {
			netStub.lastRequest = opts;
			if (netStub.error) throw netStub.error;
			return netStub.response;
		},
	};
});

/** 破坏性操作确认框替身：只记录「是否打开」与「传入选项」，不渲染真实模态框 */
const confirmStub = vi.hoisted(() => ({
	opened: 0,
	lastOptions: null as null | Record<string, unknown>,
}));
vi.mock("@ui/modals/confirm-modal", () => ({
	ConfirmModal: class {
		constructor(options: Record<string, unknown>) {
			confirmStub.lastOptions = options;
		}
		open(): void {
			confirmStub.opened++;
		}
	},
}));

/**
 * 设置页测试替身。
 *
 * 与 view-toolbar.test.ts 同一套做法：补齐 Obsidian 在 HTMLElement 上挂载的助手方法
 * （test/setup.ts 的注释声称已补齐，但实现里只有样式方法，见该文件注释与实现的差异）。
 * 这里额外提供 addToggle/addText/addButton/addDropdown 等 `Setting` 控件 API，
 * 使声明式设置项在 jsdom 下可真实渲染，从而覆盖渲染分支。
 */
function ensureDomHelpers(): void {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	// 注意：这些补充必须放在 createEl 的早退判断之前——否则一旦别处已补过 createEl，
	// setAttr / getAttr 就永远不会被补上（本文件曾因早退顺序踩到此坑）。
	if (!proto.setAttr) {
		proto.setAttr = function (this: HTMLElement, name: string, value: string): HTMLElement {
			this.setAttribute(name, value);
			return this;
		};
	}
	if (!proto.getAttr) {
		proto.getAttr = function (this: HTMLElement, name: string): string | null {
			return this.getAttribute(name);
		};
	}
	if (proto.createEl) return;

	type ElInfo = {
		cls?: string;
		text?: string;
		attr?: Record<string, string>;
		href?: string;
		type?: string;
		placeholder?: string;
		/** <option> 需要 value 才能让 select.value 赋值生效（否则 jsdom 会回落空串） */
		value?: string;
	};
	const applyInfo = (el: HTMLElement, o?: ElInfo | string) => {
		if (!o) return;
		if (typeof o === "string") {
			el.textContent = o;
			return;
		}
		if (o.cls) el.className = o.cls;
		if (o.text != null) el.textContent = o.text;
		if (o.type) el.setAttribute("type", o.type);
		if (o.href) el.setAttribute("href", o.href);
		if (o.placeholder) el.setAttribute("placeholder", o.placeholder);
		if (o.value != null) el.setAttribute("value", o.value);
		if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, v);
	};
	proto.createEl = function (this: HTMLElement, tag: string, o?: ElInfo | string): HTMLElement {
		const el = document.createElement(tag);
		applyInfo(el, o);
		this.appendChild(el);
		return el;
	};
	proto.createDiv = function (this: HTMLElement, o?: ElInfo | string): HTMLElement {
		return (this as unknown as { createEl(t: string, o?: unknown): HTMLElement }).createEl("div", o);
	};
	proto.createSpan = function (this: HTMLElement, o?: ElInfo | string): HTMLElement {
		return (this as unknown as { createEl(t: string, o?: unknown): HTMLElement }).createEl("span", o);
	};
	proto.setText = function (this: HTMLElement, t: string): void {
		this.textContent = t;
	};
}

/** 构造满足 TranslatorSettingTab 的最小 plugin 替身 */
function makePlugin(overrides: Record<string, unknown> = {}) {
	const settings = structuredClone(DEFAULT_SETTINGS);
	const translator = {
		setAIConfig: vi.fn(),
		setApiConfig: vi.fn(),
		setSelfHostedTranslators: vi.fn(),
		setUseMyMemory: vi.fn(),
		setUseTransmart: vi.fn(),
		getCacheSize: vi.fn(() => 0),
		getAIDictSize: vi.fn(() => 0),
		clearCache: vi.fn(),
		clearAIDict: vi.fn(),
		// 诊断面板：无最近一次搜索时返回 null，走「暂无数据」空态分支
		getLastSearchTiming: vi.fn(() => null),
		getLastMatchDiagnostics: vi.fn(() => null),
	};
	const base: Record<string, unknown> = {
		settings,
		translator,
		app: {
			vault: { configDir: ".obsidian", getResourcePath: () => "" },
			workspace: { getLeavesOfType: () => [] },
		},
		manifest: { id: "chinese-plugin-market" },
		localIndexState: { status: "idle", loaded: 0, total: 0 },
		flushSaveSettings: vi.fn().mockResolvedValue(undefined),
		refreshSettingsIntegration: vi.fn(),
		setRibbonUpdateBadge: vi.fn(),
		// 必须返回 Promise：renderEmbeddingIndex 里 `.then(...).catch(...)` 消费它
		getLocalVectorStatus: vi.fn().mockResolvedValue({ sqliteReady: true, ready: true, count: 10 }),
		// 下面这些在渲染期会被 .then() 消费：必须返回 Promise，否则报
		// "Cannot read properties of undefined (reading 'then')"
		reloadCssSnippets: vi.fn().mockResolvedValue(undefined),
		refreshProfileCommands: vi.fn().mockResolvedValue(undefined),
		applyProfile: vi.fn().mockResolvedValue(undefined),
		saveCurrentAsProfile: vi.fn().mockResolvedValue(undefined),
		clearApprovedTM: vi.fn().mockResolvedValue(undefined),
		ensureSettingsTranslator: vi.fn().mockResolvedValue(undefined),
		migrateTMFromDefault: vi.fn().mockResolvedValue(undefined),
		buildLocalIndex: vi.fn().mockResolvedValue(undefined),
		saveTranslatorData: vi.fn().mockResolvedValue(undefined),
		settingsTranslator: {
			enable: vi.fn(),
			disable: vi.fn(),
			exportCache: vi.fn(() => ({})),
			clearCache: vi.fn(),
		},
		// CssSnippetSettingsList 依赖完整的 CssStorePort，构造后立即被 render 消费
		createCssStore: vi.fn(() => ({
			settings: createDefaultManageSettings(),
			saveCssGroups: vi.fn(),
			saveCssMeta: vi.fn(),
			saveCssFilterState: vi.fn(),
			refreshSnippets: vi.fn().mockResolvedValue(undefined),
			listSnippets: vi.fn(() => []),
			setSnippetEnabled: vi.fn().mockResolvedValue(true),
			renameSnippet: vi.fn().mockResolvedValue(undefined),
		})),
		...overrides,
	};
	// 惰性兜底：未预置的 plugin 方法首次访问时自动变成 spy，避免逐条补齐契约。
	// 取舍：这会掩盖「调用了不存在的方法」，但它换来的是测试不被无关契约阻塞；
	//      真正的缺方法由 tsc 在源码侧保证（plugin 是具体类型）。
	return new Proxy(base, {
		get(t, p) {
			if (!(p in t)) t[p as string] = vi.fn();
			return t[p as string];
		},
	}) as unknown as ChinesePluginMarket & Record<string, unknown>;
}

function makeTab(pluginOverrides: Record<string, unknown> = {}, settingsOverrides: Record<string, unknown> = {}) {
	const plugin = makePlugin(pluginOverrides);
	Object.assign(plugin.settings, settingsOverrides);
	const tab = new TranslatorSettingTab(
		(plugin as unknown as { app: never }).app,
		plugin as unknown as ChinesePluginMarket,
	);
	// Obsidian 真实运行时由基类保存 app 并提供 containerEl；
	// mock 的 PluginSettingTab 是空类（不执行 super 的赋值），这里补齐两者。
	(tab as unknown as { containerEl: HTMLElement }).containerEl = document.createElement("div");
	(tab as unknown as { app: unknown }).app = (plugin as unknown as { app: unknown }).app;
	// confirmDanger 的确认回调会调 this.update() 触发设置面板重绘（否则条数文案与真实状态脱节）
	(tab as unknown as { update: () => void }).update = vi.fn();
	return { tab, plugin };
}

/** 递归展开声明式定义，返回叶子项与其所属分组 */
type Leaf = {
	key?: string;
	kind?: string;
	defaultValue?: unknown;
	options?: Record<string, string>;
	group?: string;
	hasRender: boolean;
	name?: string;
	/** 自定义渲染回调（复杂项：自托管列表 / 嵌入索引状态 / 诊断面板等） */
	render?: (setting: unknown) => void;
};

function flatten(defs: unknown[]): Leaf[] {
	const out: Leaf[] = [];
	const walk = (items: unknown[], group?: string) => {
		for (const raw of items) {
			const item = raw as {
				type?: string;
				heading?: string;
				name?: string;
				items?: unknown[];
				control?: { type?: string; key?: string; defaultValue?: unknown; options?: Record<string, string> };
				render?: unknown;
			};
			if (item.type === "group") {
				walk(item.items ?? [], item.heading ?? group);
				continue;
			}
			out.push({
				key: item.control?.key,
				kind: item.control?.type,
				defaultValue: item.control?.defaultValue,
				options: item.control?.options,
				group,
				hasRender: typeof item.render === "function",
				name: item.name,
				render: typeof item.render === "function" ? (item.render as (s: unknown) => void) : undefined,
			});
		}
	};
	walk(defs);
	return out;
}

/**
 * 最小 Setting 替身：覆盖 render 回调会用到的元素与链式控件 API。
 * Obsidian 真实运行时由框架构造 Setting 并调用我们的 render(setting)；
 * 这里手工构造等价物，使「复杂项」渲染分支可被测试。
 */
type SettingStub = {
	settingEl: HTMLElement;
	infoEl: HTMLElement;
	/** 描述行：renderEmbeddingIndex 会反复 descEl.setText(...) 更新状态文案 */
	descEl: HTMLElement & { setText(t: string): void };
	controlEl: HTMLElement;
	/** 每次 addButton 注册的按钮及其事件回调，供用例触发 onClick */
	buttons: Array<{ handlers: Record<string, (...a: unknown[]) => unknown> }>;
};

function makeSettingStub(): SettingStub {
	const settingEl = document.createElement("div");
	const infoEl = document.createElement("div");
	const controlEl = document.createElement("div");
	const descEl = document.createElement("div") as HTMLElement & { setText(t: string): void };
	descEl.setText = (t: string) => {
		descEl.textContent = t;
	};

	const buttons: SettingStub["buttons"] = [];

	/**
	 * 造一个链式控件替身 + 捕获其 onClick/onChange 回调。
	 * 链式 setter 用 Proxy 兜底（Obsidian 的 ButtonComponent 方法多：
	 * setCta / setDestructive / setWarning / setIcon ...），逐个列举必然随版本漏；
	 * 但 onClick/onChange 必须真实捕获，否则无法测交互分支。
	 */
	const makeChain = () => {
		const handlers: Record<string, (...a: unknown[]) => unknown> = {};
		const chain: Record<string, unknown> = new Proxy({} as Record<string, unknown>, {
			get(t, p) {
				if (p === "onClick" || p === "onChange") {
					return (fn: (...a: unknown[]) => unknown) => {
						handlers[p] = fn;
						return chain;
					};
				}
				if (!(p in t)) t[p as string] = () => chain;
				return t[p as string];
			},
		});
		return { chain, handlers };
	};

	const stub: Record<string, unknown> = {
		settingEl,
		infoEl,
		descEl,
		controlEl,
		buttons,
		addText: (cb: (c: unknown) => void) => {
			cb(makeChain().chain);
			return stub;
		},
		addButton: (cb: (c: unknown) => void) => {
			const c = makeChain();
			cb(c.chain);
			buttons.push({ handlers: c.handlers });
			return stub;
		},
		addToggle: (cb: (c: unknown) => void) => {
			const c = makeChain();
			cb(c.chain);
			// 与 addButton 一致地收集回调：buttons 实为「已注册控件回调」集合，
			// 名称沿用历史（既有用例按 buttons[0] 取），避免改动全部调用点。
			buttons.push({ handlers: c.handlers });
			return stub;
		},
		addDropdown: (cb: (c: unknown) => void) => {
			cb(makeChain().chain);
			return stub;
		},
		addExtraButton: (cb: (c: unknown) => void) => {
			cb(makeChain().chain);
			return stub;
		},
		setName: () => stub,
		setDesc: () => stub,
		setHeading: () => stub,
		setClass: () => stub,
	};
	return stub as unknown as SettingStub;
}

beforeEach(() => {
	ensureDomHelpers();
	notices.messages.length = 0;
	notices.durations.length = 0;
	document.body.innerHTML = "";
});

afterEach(() => {
	// 还原 Platform.isMobile 等 getter spy，避免跨用例泄漏（例如移动端用例污染桌面端用例）
	vi.restoreAllMocks();
});

describe("getSettingDefinitions 声明式契约", () => {
	it("返回非空的分组定义数组", () => {
		const { tab } = makeTab();
		const defs = tab.getSettingDefinitions();
		expect(Array.isArray(defs)).toBe(true);
		expect(defs.length).toBeGreaterThan(0);
	});

	it("顶层每一项都是带标题的分组", () => {
		const { tab } = makeTab();
		const defs = tab.getSettingDefinitions() as unknown as Array<{ type?: string; heading?: string }>;
		for (const d of defs) {
			expect(d.type).toBe("group");
			expect(typeof d.heading).toBe("string");
			expect(d.heading!.length).toBeGreaterThan(0);
		}
	});

	it("控件 key 不重复（重复会导致一个控件覆盖另一个的读写）", () => {
		const { tab } = makeTab();
		const keys = flatten(tab.getSettingDefinitions()).map((l) => l.key).filter(Boolean);
		const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
		expect(dup).toEqual([]);
	});

	it("每个控件 key 都在 DEFAULT_SETTINGS 中有默认值（防拼写错误静默失效）", () => {
		const { tab } = makeTab();
		const defaults = Object.keys(DEFAULT_SETTINGS as unknown as Record<string, unknown>);
		const missing = flatten(tab.getSettingDefinitions())
			.map((l) => l.key)
			.filter((k): k is string => typeof k === "string" && !defaults.includes(k));
		expect(missing).toEqual([]);
	});

	it("下拉控件的 defaultValue 必定落在其 options 内", () => {
		const { tab } = makeTab();
		const bad = flatten(tab.getSettingDefinitions())
			.filter((l) => l.kind === "dropdown" && l.options)
			.filter((l) => !Object.keys(l.options!).includes(String(l.defaultValue)))
			.map((l) => `${l.key}=${String(l.defaultValue)}`);
		expect(bad).toEqual([]);
	});

	it("每个叶子项都有可见名称或自定义渲染（不留无标签控件）", () => {
		const { tab } = makeTab();
		const bad = flatten(tab.getSettingDefinitions())
			.filter((l) => !l.hasRender && !l.name)
			.map((l) => l.key ?? "(anonymous)");
		expect(bad).toEqual([]);
	});

	it("同一设置可重复调用且结构稳定（无跨实例污染）", () => {
		const { tab } = makeTab();
		const a = flatten(tab.getSettingDefinitions()).map((l) => l.key);
		const b = flatten(tab.getSettingDefinitions()).map((l) => l.key);
		expect(a).toEqual(b);
	});
});

describe("getControlValue / setControlValue 值收敛", () => {
	it("getControlValue 透传 plugin.settings", () => {
		const { tab } = makeTab({}, { aiSearchModel: "gpt-4o" });
		expect(tab.getControlValue("aiSearchModel")).toBe("gpt-4o");
	});

	it("文本类字段写入时 trim 首尾空白（复制粘贴常见坑）", async () => {
		const { tab, plugin } = makeTab();
		await tab.setControlValue("aiSearchApiKey", "  sk-abc123  ");
		expect(plugin.settings.aiSearchApiKey).toBe("sk-abc123");
	});

	it("非字符串值原样写入，不触发 trim", async () => {
		const { tab, plugin } = makeTab();
		await tab.setControlValue("aiSearchEnabled", true);
		expect(plugin.settings.aiSearchEnabled).toBe(true);
	});

	it('数字窗口字段把 "off"/空值收敛为 null（表示不过滤）', async () => {
		const { tab, plugin } = makeTab();
		await tab.setControlValue("defaultNewWithinDays", "off");
		expect(plugin.settings.defaultNewWithinDays).toBeNull();

		await tab.setControlValue("defaultNewWithinDays", "");
		expect(plugin.settings.defaultNewWithinDays).toBeNull();

		await tab.setControlValue("defaultUpdatedWithinDays", null);
		expect(plugin.settings.defaultUpdatedWithinDays).toBeNull();
	});

	it('数字窗口字段把字符串数字收敛为 number', async () => {
		const { tab, plugin } = makeTab();
		await tab.setControlValue("healthHealthyDays", "30");
		expect(plugin.settings.healthHealthyDays).toBe(30);
		expect(typeof plugin.settings.healthHealthyDays).toBe("number");
	});

	it("采样率始终收敛为 number", async () => {
		const { tab, plugin } = makeTab();
		await tab.setControlValue("querySamplingRate", "0.25");
		expect(plugin.settings.querySamplingRate).toBe(0.25);
	});

	it("未知 key 走 default 分支原样写入", async () => {
		const { tab, plugin } = makeTab();
		await tab.setControlValue("someUnknownKey", { a: 1 });
		expect((plugin.settings as unknown as Record<string, unknown>).someUnknownKey).toEqual({ a: 1 });
	});

	it("每次写入都触发落盘", async () => {
		const { tab, plugin } = makeTab();
		await tab.setControlValue("useMyMemory", false);
		expect(plugin.flushSaveSettings).toHaveBeenCalledTimes(1);
	});
});

describe("setControlValue 副作用联动", () => {
	it("修改 secretId/secretKey/region 会重推腾讯配置给翻译引擎", async () => {
		const { tab, plugin } = makeTab();
		await tab.setControlValue("secretId", "id-1");
		expect(plugin.translator.setApiConfig).toHaveBeenCalled();
	});

	it("修改 AI 配置项会重推 AI 配置给翻译引擎", async () => {
		const { tab, plugin } = makeTab();
		await tab.setControlValue("aiSearchModel", "deepseek-chat");
		expect(plugin.translator.setAIConfig).toHaveBeenCalled();
	});

	it("AI 未启用时向翻译引擎推 null", async () => {
		const { tab, plugin } = makeTab();
		plugin.settings.aiSearchEnabled = false;
		await tab.setControlValue("aiSearchModel", "whatever");
		expect(plugin.translator.setAIConfig).toHaveBeenCalledWith(null);
	});

	it("AI 已启用且有 Key 时推具体配置", async () => {
		const { tab, plugin } = makeTab();
		plugin.settings.aiSearchEnabled = true;
		plugin.settings.aiSearchBaseURL = "https://api.deepseek.com";
		plugin.settings.aiSearchApiKey = "sk-1";
		plugin.settings.aiSearchModel = "deepseek-chat";
		await tab.setControlValue("aiSearchModel", "deepseek-chat");
		expect(plugin.translator.setAIConfig).toHaveBeenCalledWith({
			baseURL: "https://api.deepseek.com",
			apiKey: "sk-1",
			model: "deepseek-chat",
		});
	});

	it("切换 MyMemory / Transmart 开关会同步翻译引擎", async () => {
		const { tab, plugin } = makeTab();
		await tab.setControlValue("useMyMemory", true);
		expect(plugin.translator.setUseMyMemory).toHaveBeenCalledWith(true);
		await tab.setControlValue("useTransmart", false);
		expect(plugin.translator.setUseTransmart).toHaveBeenCalledWith(false);
	});
});

describe("移动端本地模型警告（#6：只弹一次）", () => {
	it("首次切到本地模型时弹一次提示", async () => {
		vi.spyOn(Platform, "isMobile", "get").mockReturnValue(true);
		const { tab } = makeTab();
		await tab.setControlValue("embeddingSource", "local");
		expect(notices.messages.length).toBeGreaterThan(0);
	});

	it("同一会话内再次切换不再重复打扰", async () => {
		vi.spyOn(Platform, "isMobile", "get").mockReturnValue(true);
		const { tab } = makeTab();
		await tab.setControlValue("embeddingSource", "local");
		notices.messages.length = 0;
		await tab.setControlValue("embeddingSource", "api");
		await tab.setControlValue("embeddingSource", "local");
		expect(notices.messages.length).toBe(0);
	});

	it("桌面端切到本地模型不弹提示", async () => {
		vi.spyOn(Platform, "isMobile", "get").mockReturnValue(false);
		const { tab } = makeTab();
		await tab.setControlValue("embeddingSource", "local");
		expect(notices.messages.length).toBe(0);
	});
});

describe("自定义 render 项可安全渲染", () => {
	it("每个 render 项都能在给定 Setting 上渲染且不抛错", () => {
		const { tab } = makeTab();
		const items = flatten(tab.getSettingDefinitions()).filter((l) => l.render);
		expect(items.length).toBeGreaterThan(0);

		for (const item of items) {
			const stub = makeSettingStub();
			expect(
				() => item.render!(stub),
				`渲染项（分组：${item.group ?? "?"}）抛错`,
			).not.toThrow();
		}
	});

	it("鸣谢区渲染出贡献者链接（外链带安全属性）", () => {
		const { tab } = makeTab();
		const item = flatten(tab.getSettingDefinitions()).find((l) => l.group !== undefined && l.hasRender && !l.name);
		expect(item).toBeTruthy();

		const stub = makeSettingStub();
		item!.render!(stub);

		const links = stub.controlEl.querySelectorAll("a");
		expect(links.length).toBeGreaterThan(0);
		for (const a of Array.from(links)) {
			expect(a.getAttribute("target")).toBe("_blank");
			expect(a.getAttribute("rel")).toContain("noopener");
		}
	});

	it("渲染项不会把异常抛给 Obsidian 设置框架", () => {
		// 回归护栏：设置页渲染期抛错会让整个设置面板白屏（比设置项失效严重得多）
		const { tab } = makeTab();
		for (const item of flatten(tab.getSettingDefinitions()).filter((l) => l.render)) {
			const stub = makeSettingStub();
			try {
				item.render!(stub);
			} catch (err) {
				throw new Error(`渲染项崩溃（分组：${item.group ?? "?"}）：${String(err)}`);
			}
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 以下为「有数据」分支：上一批只覆盖了各渲染项的空态，这里喂真实数据。
// 私有 render 方法通过反射调用——它们是声明式 render 回调的实际实现，
// 直接调用才能精确控制输入数据，且不依赖声明式数组里的分组顺序。
// ─────────────────────────────────────────────────────────────────────────────
function callPrivate(tab: TranslatorSettingTab, name: string, stub: SettingStub): void {
	(tab as unknown as Record<string, (s: unknown) => void>)[name](stub);
}

/** 等待 async IIFE 落定：内部有 await flushSaveSettings 等，需跨多个宏/微任务 tick */
const flushAsync = () => new Promise((resolve) => window.setTimeout(resolve, 0));

type SelfHosted = { type: string; baseUrl: string };
type SettingsBag = Record<string, unknown> & { selfHostedTranslators: SelfHosted[] };

function bagOf(plugin: unknown): SettingsBag {
	return (plugin as { settings: SettingsBag }).settings;
}

describe("自托管翻译源列表（有数据分支）", () => {
	it("空列表显示空态提示", () => {
		const { tab } = makeTab({}, { selfHostedTranslators: [] });
		const stub = makeSettingStub();
		callPrivate(tab, "renderSelfHosted", stub);
		expect(stub.controlEl.querySelector(".pt-selfhosted-empty")).toBeTruthy();
		expect(stub.controlEl.querySelectorAll(".pt-selfhosted-row").length).toBe(0);
	});

	it("有数据时每行渲染类型下拉 + URL 输入 + 删除按钮", () => {
		const { tab, plugin } = makeTab(
			{},
			{
				selfHostedTranslators: [
					{ type: "deeplx", baseUrl: "http://localhost:1188" },
					{ type: "libretranslate", baseUrl: "http://localhost:5000" },
				],
			},
		);
		const stub = makeSettingStub();
		callPrivate(tab, "renderSelfHosted", stub);

		expect(stub.controlEl.querySelectorAll(".pt-selfhosted-row").length).toBe(2);
		expect(stub.controlEl.querySelectorAll(".pt-selfhosted-type").length).toBe(2);
		expect(stub.controlEl.querySelectorAll(".pt-selfhosted-url").length).toBe(2);
		expect(bagOf(plugin).selfHostedTranslators[0].baseUrl).toBe("http://localhost:1188");
	});

	it("点击删除移除对应行并落盘、重推翻译源", async () => {
		const { tab, plugin } = makeTab(
			{},
			{
				selfHostedTranslators: [
					{ type: "deeplx", baseUrl: "a" },
					{ type: "libretranslate", baseUrl: "b" },
				],
			},
		);
		const stub = makeSettingStub();
		callPrivate(tab, "renderSelfHosted", stub);

		(stub.controlEl.querySelectorAll(".pt-selfhosted-del")[0] as HTMLElement).click();
		await flushAsync();

		expect(bagOf(plugin).selfHostedTranslators.length).toBe(1);
		expect(bagOf(plugin).selfHostedTranslators[0].baseUrl).toBe("b");
		expect(plugin.translator.setSelfHostedTranslators).toHaveBeenCalled();
		expect(plugin.flushSaveSettings).toHaveBeenCalled();
	});

	it("点击添加追加一条默认 deeplx 条目", async () => {
		const { tab, plugin } = makeTab({}, { selfHostedTranslators: [] });
		const stub = makeSettingStub();
		callPrivate(tab, "renderSelfHosted", stub);

		await stub.buttons[0].handlers.onClick();
		// 该 onClick 内部是 `void (async () => …)()`，不返回 Promise，必须额外等待
		await flushAsync();

		expect(bagOf(plugin).selfHostedTranslators).toEqual([{ type: "deeplx", baseUrl: "" }]);
		expect(plugin.translator.setSelfHostedTranslators).toHaveBeenCalled();
	});

	it("修改 URL 时 trim 后写回", async () => {
		const { tab, plugin } = makeTab({}, { selfHostedTranslators: [{ type: "deeplx", baseUrl: "old" }] });
		const stub = makeSettingStub();
		callPrivate(tab, "renderSelfHosted", stub);

		const input = stub.controlEl.querySelector(".pt-selfhosted-url") as HTMLInputElement;
		input.value = "  http://new:1188  ";
		input.dispatchEvent(new Event("change"));
		await flushAsync();

		expect(bagOf(plugin).selfHostedTranslators[0].baseUrl).toBe("http://new:1188");
	});

	it("切换类型时写回并重推", async () => {
		const { tab, plugin } = makeTab({}, { selfHostedTranslators: [{ type: "deeplx", baseUrl: "u" }] });
		const stub = makeSettingStub();
		callPrivate(tab, "renderSelfHosted", stub);

		const sel = stub.controlEl.querySelector(".pt-selfhosted-type") as HTMLSelectElement;
		sel.value = "libretranslate";
		sel.dispatchEvent(new Event("change"));
		await flushAsync();

		expect(bagOf(plugin).selfHostedTranslators[0].type).toBe("libretranslate");
		expect(plugin.translator.setSelfHostedTranslators).toHaveBeenCalled();
	});
});

describe("本地向量索引行（多状态）", () => {
	const setState = (plugin: unknown, state: Record<string, unknown>) => {
		(plugin as { localIndexState: Record<string, unknown> }).localIndexState = state;
	};

	it("idle：显示空闲文案，进度条隐藏，按钮可用", () => {
		const { tab, plugin } = makeTab();
		setState(plugin, { status: "idle" });
		const stub = makeSettingStub();
		callPrivate(tab, "renderEmbeddingIndex", stub);

		// t() 是真实 i18n（makeT），返回中文文案而非 key
		expect(stub.descEl.textContent).toContain("尚未构建");
		const progress = stub.controlEl.querySelector("progress") as HTMLProgressElement;
		expect(progress.style.display).toBe("none");
	});

	it("building 且 0/N：额外提示等待模型就绪（首载无百分比）", () => {
		const { tab, plugin } = makeTab();
		setState(plugin, { status: "building", progress: 0, total: 100 });
		const stub = makeSettingStub();
		callPrivate(tab, "renderEmbeddingIndex", stub);

		expect(stub.descEl.textContent).toContain("等待模型就绪");
	});

	it("building 且有进度：进度条可见且按比例赋值", () => {
		const { tab, plugin } = makeTab();
		setState(plugin, { status: "building", progress: 25, total: 100 });
		const stub = makeSettingStub();
		callPrivate(tab, "renderEmbeddingIndex", stub);

		const progress = stub.controlEl.querySelector("progress") as HTMLProgressElement;
		expect(progress.style.display).toBe("");
		expect(progress.value).toBe(25);
	});

	it("done：显示完成文案并附带 message", () => {
		const { tab, plugin } = makeTab();
		setState(plugin, { status: "done", message: "共 6000 条" });
		const stub = makeSettingStub();
		callPrivate(tab, "renderEmbeddingIndex", stub);
		expect(stub.descEl.textContent).toContain("共 6000 条");
	});

	it("error：显示错误文案并附带 error", () => {
		const { tab, plugin } = makeTab();
		setState(plugin, { status: "error", error: "OOM" });
		const stub = makeSettingStub();
		callPrivate(tab, "renderEmbeddingIndex", stub);
		expect(stub.descEl.textContent).toContain("OOM");
	});

	it("点击构建调用 buildLocalIndex 并给出提示", async () => {
		const { tab, plugin } = makeTab();
		setState(plugin, { status: "idle" });
		const stub = makeSettingStub();
		callPrivate(tab, "renderEmbeddingIndex", stub);

		await stub.buttons[0].handlers.onClick();

		expect(plugin.buildLocalIndex).toHaveBeenCalledWith(true);
		expect(notices.messages.length).toBeGreaterThan(0);
	});

	it("构建完成态给出完成提示，错误态给出错误提示", async () => {
		const { tab, plugin } = makeTab();
		setState(plugin, { status: "idle" });
		plugin.buildLocalIndex = vi.fn().mockImplementation(async () => {
			setState(plugin, { status: "error", error: "下载失败" });
		});
		const stub = makeSettingStub();
		callPrivate(tab, "renderEmbeddingIndex", stub);

		await stub.buttons[0].handlers.onClick();

		expect(notices.messages.some((m) => m.includes("下载失败"))).toBe(true);
	});
});

describe("搜索诊断面板（有快照）", () => {
	const timingSnapshot = {
		at: 0,
		totalMs: 123.4,
		phases: [
			{ name: PHASE.keyword, ms: 10.5 },
			{ name: PHASE.llmRank, ms: 90 },
		],
		counters: { docs: 100, hits: 12 },
	};

	const matchSnapshot = {
		at: 0,
		// as const：mode 是 "ai" | "local" 字面量联合，直接写会放宽成 string
		mode: "local" as const,
		query: "dataview 表格",
		rankedIds: ["a", "b"],
		labels: { a: "Dataview" },
		diagnostics: {
			a: {
				keywordRank: 1,
				vectorRank: null,
				titleRank: 2,
				keywordScore: 1.2,
				vectorScore: null,
				titleScore: 0.9,
				rrfScore: 0.5,
				rerankScore: 0.42,
				matchedTerms: ["表格"],
				phraseMatches: [],
				intentMatches: ["查询"],
				negativeMatches: [],
			},
		},
	};

	it("无快照时显示空态", () => {
		const { tab } = makeTab();
		const stub = makeSettingStub();
		callPrivate(tab, "renderSearchTiming", stub);
		expect(stub.controlEl.querySelector(".pt-timing-empty")).toBeTruthy();
	});

	it("有计时快照时渲染总耗时、本地阶段与各阶段条形", () => {
		const { tab, plugin } = makeTab();
		plugin.translator.getLastSearchTiming = vi.fn(() => timingSnapshot);
		const stub = makeSettingStub();
		callPrivate(tab, "renderSearchTiming", stub);

		expect(stub.controlEl.querySelector(".pt-timing-total")).toBeTruthy();
		expect(stub.controlEl.querySelector(".pt-timing-sub")).toBeTruthy();
		expect(stub.controlEl.querySelectorAll(".pt-timing-row").length).toBe(2);
		// LLM 阶段用独立配色，便于用户直观看出「慢在网络而非本地」
		expect(stub.controlEl.querySelector(".pt-timing-bar-llm")).toBeTruthy();
		expect(stub.controlEl.querySelector(".pt-timing-counters")!.textContent).toContain("docs=100");
	});

	it("有匹配诊断时渲染候选、缺失诊断行与召回证据", () => {
		const { tab, plugin } = makeTab();
		plugin.translator.getLastMatchDiagnostics = vi.fn(() => matchSnapshot);
		const stub = makeSettingStub();
		callPrivate(tab, "renderSearchTiming", stub);

		expect(stub.controlEl.querySelectorAll(".pt-match-row").length).toBe(2);
		// b 没有 diagnostic → 走 missing 分支
		expect(stub.controlEl.querySelectorAll(".pt-match-missing").length).toBe(1);
		expect(stub.controlEl.querySelectorAll(".pt-match-ranks").length).toBe(1);
		expect(stub.controlEl.querySelector(".pt-match-details")!.textContent).toContain("表格");
	});

	it("候选为空时展示空态而不渲染列表", () => {
		const { tab, plugin } = makeTab();
		plugin.translator.getLastMatchDiagnostics = vi.fn(() => ({
			...matchSnapshot,
			rankedIds: [],
		}));
		const stub = makeSettingStub();
		callPrivate(tab, "renderSearchTiming", stub);

		expect(stub.controlEl.querySelector(".pt-match-empty")).toBeTruthy();
		expect(stub.controlEl.querySelectorAll(".pt-match-row").length).toBe(0);
	});

	it("点击刷新重新读取最新快照", () => {
		const { tab, plugin } = makeTab();
		const getter = vi.fn((): null => null);
		plugin.translator.getLastSearchTiming = getter;
		const stub = makeSettingStub();
		callPrivate(tab, "renderSearchTiming", stub);
		const before = getter.mock.calls.length;

		stub.buttons[0].handlers.onClick!();

		expect(getter.mock.calls.length).toBe(before + 1);
	});
});

describe("破坏性操作必须二次确认", () => {
	beforeEach(() => {
		confirmStub.opened = 0;
		confirmStub.lastOptions = null;
	});

	it("有缓存时弹确认框，未确认前不清除", async () => {
		const { tab, plugin } = makeTab();
		(plugin.translator as unknown as { getCacheSize: () => number }).getCacheSize = () => 137;

		await (tab as unknown as { clearCache(): Promise<void> }).clearCache();

		expect(confirmStub.opened).toBe(1);
		expect(plugin.translator.clearCache).not.toHaveBeenCalled();
	});

	it("确认后才真正清除并落盘", async () => {
		const { tab, plugin } = makeTab();
		(plugin.translator as unknown as { getCacheSize: () => number }).getCacheSize = () => 137;

		await (tab as unknown as { clearCache(): Promise<void> }).clearCache();
		(confirmStub.lastOptions!.onConfirm as () => void)();

		expect(plugin.translator.clearCache).toHaveBeenCalled();
		expect(plugin.saveTranslatorData).toHaveBeenCalled();
	});

	it("缓存为空时直接提示，不弹确认框", async () => {
		const { tab } = makeTab();
		await (tab as unknown as { clearCache(): Promise<void> }).clearCache();
		expect(confirmStub.opened).toBe(0);
		expect(notices.messages.length).toBeGreaterThan(0);
	});

	it("AI 词典同样遵循「非空才确认」", async () => {
		const { tab, plugin } = makeTab();
		(plugin.translator as unknown as { getAIDictSize: () => number }).getAIDictSize = () => 42;

		await (tab as unknown as { clearAIDict(): Promise<void> }).clearAIDict();
		expect(confirmStub.opened).toBe(1);

		(confirmStub.lastOptions!.onConfirm as () => void)();
		expect(plugin.translator.clearAIDict).toHaveBeenCalled();
	});
});

describe("AI 连接测试（HTTP 全分支）", () => {
	const callAI = (tab: TranslatorSettingTab) =>
		(tab as unknown as { testAIConnection(): Promise<void> }).testAIConnection();

	/** 构造带 AI 配置的设置页 */
	const withAI = (over: Record<string, unknown> = {}) =>
		makeTab(
			{},
			{
				aiSearchBaseURL: "https://api.deepseek.com",
				aiSearchApiKey: "sk-test",
				aiSearchModel: "deepseek-chat",
				...over,
			},
		);

	const hasNotice = (fragment: string) => notices.messages.some((m) => m.includes(fragment));

	beforeEach(() => {
		netStub.lastRequest = null;
		netStub.response = { status: 200, json: {} };
		netStub.error = null;
	});

	it("未填 Key 且非本地地址：直接拦截，不发起任何请求", async () => {
		const { tab } = withAI({ aiSearchApiKey: "" });
		await callAI(tab);
		expect(netStub.lastRequest).toBeNull();
		expect(hasNotice("请先填写 API Key")).toBe(true);
	});

	it("本地地址允许空 Key（Ollama / LM Studio 属合法用法），且不带 Authorization", async () => {
		const { tab } = withAI({ aiSearchBaseURL: "http://localhost:11434", aiSearchApiKey: "" });
		await callAI(tab);
		const headers = netStub.lastRequest!.headers as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
		expect(hasNotice("连接成功")).toBe(true);
	});

	it("200：提示连接成功并回显请求目标", async () => {
		const { tab } = withAI();
		await callAI(tab);
		expect(netStub.lastRequest!.url).toBe("https://api.deepseek.com/v1/chat/completions");
		expect(hasNotice("连接成功")).toBe(true);
		expect(hasNotice("deepseek-chat")).toBe(true);
	});

	it("200 且返回 usage：额外回显 token 消耗", async () => {
		netStub.response = { status: 200, json: { usage: { total_tokens: 18 } } };
		const { tab } = withAI();
		await callAI(tab);
		expect(hasNotice("消耗 18 tokens")).toBe(true);
	});

	it("200 但无 usage：不回显 token 段", async () => {
		const { tab } = withAI();
		await callAI(tab);
		expect(notices.messages.join()).not.toContain("tokens");
	});

	it("401：按鉴权失败处理并给出排查提示", async () => {
		netStub.response = { status: 401, json: {} };
		const { tab } = withAI();
		await callAI(tab);
		expect(hasNotice("API Key 无效或已过期")).toBe(true);
	});

	it("403：同样按鉴权失败处理", async () => {
		netStub.response = { status: 403, json: {} };
		const { tab } = withAI();
		await callAI(tab);
		expect(hasNotice("API Key 无效或已过期")).toBe(true);
	});

	it("429：提示限流或额度不足", async () => {
		netStub.response = { status: 429, json: {} };
		const { tab } = withAI();
		await callAI(tab);
		expect(hasNotice("请求过于频繁或额度不足")).toBe(true);
	});

	it("5xx：提示服务器错误并带上状态码", async () => {
		netStub.response = { status: 503, json: {} };
		const { tab } = withAI();
		await callAI(tab);
		expect(hasNotice("服务器错误")).toBe(true);
		expect(hasNotice("503")).toBe(true);
	});

	it("其它状态码（如 400）：走通用失败提示并带状态码", async () => {
		netStub.response = { status: 400, json: {} };
		const { tab } = withAI();
		await callAI(tab);
		expect(hasNotice("连接失败")).toBe(true);
		expect(hasNotice("400")).toBe(true);
	});

	it("网络异常：转换为可操作的中文提示", async () => {
		netStub.error = new Error("Failed to fetch");
		const { tab } = withAI();
		await callAI(tab);
		expect(hasNotice("网络连接失败")).toBe(true);
	});

	it("非网络异常：原样透出错误信息，便于排查", async () => {
		netStub.error = new Error("boom-xyz");
		const { tab } = withAI();
		await callAI(tab);
		expect(hasNotice("boom-xyz")).toBe(true);
	});

	it("Key 前后空白会 trim 后再发请求", async () => {
		const { tab } = withAI({ aiSearchApiKey: "  sk-padded  " });
		await callAI(tab);
		const headers = netStub.lastRequest!.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer sk-padded");
	});

	it("成功提示停留时间明显长于默认（便于用户读数）", async () => {
		const { tab } = withAI();
		await callAI(tab);
		expect(notices.durations[0]).toBe(8000);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 百度路径不经过 obsidian，而是走依赖倒置的 HTTP 端口（data/net/http-port），
// 因此这里注入端口替身而非 mock 模块——顺带验证「下层不依赖 obsidian」这条分层规则。
// ─────────────────────────────────────────────────────────────────────────────
const httpStub: { last: Record<string, unknown> | null; response: unknown; error: unknown } = {
	last: null,
	response: null,
	error: null,
};

describe("百度翻译连接测试（错误码全分支）", () => {
	const callBaidu = (tab: TranslatorSettingTab) =>
		(tab as unknown as { testBaiduConnection(): Promise<void> }).testBaiduConnection();

	const withBaidu = (over: Record<string, unknown> = {}) =>
		makeTab({}, { baiduAppId: "appid-1", baiduKey: "key-1", ...over });

	const hasNotice = (fragment: string) => notices.messages.some((m) => m.includes(fragment));

	const okResponse = (dst: string): HttpResponse => ({
		status: 200,
		json: { trans_result: [{ dst }] },
		text: "",
		headers: {},
	});

	beforeEach(() => {
		httpStub.last = null;
		httpStub.error = null;
		httpStub.response = okResponse("你好");
		setHttpClient({
			request: async (opts) => {
				httpStub.last = opts as unknown as Record<string, unknown>;
				if (httpStub.error) throw httpStub.error;
				return httpStub.response as HttpResponse;
			},
		});
	});

	afterEach(() => {
		resetHttpClient();
	});

	it("缺少 APP ID 或密钥时直接提示，不发起请求", async () => {
		const { tab } = withBaidu({ baiduAppId: "", baiduKey: "" });
		await callBaidu(tab);
		expect(httpStub.last).toBeNull();
		expect(hasNotice("请先填写 APP ID 与密钥")).toBe(true);
	});

	it("仅缺密钥时同样拦截", async () => {
		const { tab } = withBaidu({ baiduKey: "" });
		await callBaidu(tab);
		expect(httpStub.last).toBeNull();
		expect(hasNotice("请先填写 APP ID 与密钥")).toBe(true);
	});

	it("先给「正在测试」的即时反馈，避免用户以为没响应", async () => {
		const { tab } = withBaidu();
		await callBaidu(tab);
		expect(hasNotice("正在测试连接")).toBe(true);
	});

	it("成功时回显译文，并对正确端点发起表单请求", async () => {
		const { tab } = withBaidu();
		await callBaidu(tab);
		expect(String(httpStub.last!.url)).toContain("fanyi-api.baidu.com");
		expect(httpStub.last!.method).toBe("POST");
		expect(hasNotice("连接成功")).toBe(true);
		expect(hasNotice("你好")).toBe(true);
	});

	it("译文为空时按通用失败处理", async () => {
		httpStub.response = { status: 200, json: {}, text: "", headers: {} };
		const { tab } = withBaidu();
		await callBaidu(tab);
		expect(hasNotice("连接失败")).toBe(true);
	});

	it.each(["52003", "54001", "58000", "90107"])(
		"错误码 %s 归为「APP ID 或密钥无效」并给出开通提示",
		async (code) => {
			httpStub.response = { status: 200, json: { error_code: code }, text: "", headers: {} };
			const { tab } = withBaidu();
			await callBaidu(tab);
			expect(hasNotice("APP ID 或密钥无效")).toBe(true);
		},
	);

	it.each(["54003", "54005"])("错误码 %s 归为限流/额度不足", async (code) => {
		httpStub.response = { status: 200, json: { error_code: code }, text: "", headers: {} };
		const { tab } = withBaidu();
		await callBaidu(tab);
		expect(hasNotice("请求过于频繁或额度不足")).toBe(true);
	});

	it.each(["52002", "502"])("错误码 %s 归为服务器错误", async (code) => {
		httpStub.response = { status: 200, json: { error_code: code }, text: "", headers: {} };
		const { tab } = withBaidu();
		await callBaidu(tab);
		expect(hasNotice("服务器错误")).toBe(true);
	});

	it("未知错误码原样透出，便于用户搜索定位", async () => {
		httpStub.response = { status: 200, json: { error_code: "99999" }, text: "", headers: {} };
		const { tab } = withBaidu();
		await callBaidu(tab);
		expect(hasNotice("99999")).toBe(true);
	});

	it("网络异常转成可操作提示，而非暴露原始网络错误", async () => {
		httpStub.error = new Error("Failed to fetch");
		const { tab } = withBaidu();
		await callBaidu(tab);
		expect(hasNotice("网络连接失败")).toBe(true);
	});

	it("未归类异常保留原始信息（含客户端上下文）", async () => {
		httpStub.error = new Error("weird-123");
		const { tab } = withBaidu();
		await callBaidu(tab);
		expect(hasNotice("weird-123")).toBe(true);
	});

	it("失败提示停留时间（10s）长于成功提示的一半以上，便于截图求助", async () => {
		httpStub.error = new Error("Failed to fetch");
		const { tab } = withBaidu();
		await callBaidu(tab);
		expect(notices.durations).toContain(10000);
	});
});

describe("设置页翻译缓存清理", () => {
	beforeEach(() => {
		confirmStub.opened = 0;
		confirmStub.lastOptions = null;
	});

	it("点击清空先弹确认；未确认前不动缓存", () => {
		const { tab, plugin } = makeTab({}, { settingsTranslateCache: { hello: "你好" } });
		const stub = makeSettingStub();
		callPrivate(tab, "renderClearSettingsCache", stub);

		stub.buttons[0].handlers.onClick!();

		expect(confirmStub.opened).toBe(1);
		expect(plugin.settings.settingsTranslateCache).toEqual({ hello: "你好" });
		expect(plugin.settingsTranslator!.clearCache).not.toHaveBeenCalled();
	});

	it("确认后清空内存缓存并落盘提示", () => {
		const { tab, plugin } = makeTab({}, { settingsTranslateCache: { hello: "你好" } });
		const stub = makeSettingStub();
		callPrivate(tab, "renderClearSettingsCache", stub);

		stub.buttons[0].handlers.onClick!();
		(confirmStub.lastOptions!.onConfirm as () => void)();

		expect(plugin.settingsTranslator!.clearCache).toHaveBeenCalled();
		expect(plugin.settings.settingsTranslateCache).toEqual({});
		expect(notices.messages.length).toBeGreaterThan(0);
	});
});

describe("读取当前启用插件集合", () => {
	const getIds = (tab: TranslatorSettingTab) =>
		(tab as unknown as { getCurrentEnabledIds(): Set<string> }).getCurrentEnabledIds();

	it("缺少 plugins 信息时返回空集合（不抛错）", () => {
		const { tab } = makeTab({ app: { workspace: { getLeavesOfType: () => [] } } });
		expect(getIds(tab).size).toBe(0);
	});

	it("支持 Set 形态（Obsidian 内部实际结构）", () => {
		const { tab } = makeTab({
			app: { plugins: { enabledPlugins: new Set(["a", "b"]) }, workspace: { getLeavesOfType: () => [] } },
		});
		expect([...getIds(tab)].sort()).toEqual(["a", "b"]);
	});

	it("兼容 string[] 形态（部分版本/测试替身返回数组）", () => {
		const { tab } = makeTab({
			app: { plugins: { enabledPlugins: ["x"] }, workspace: { getLeavesOfType: () => [] } },
		});
		expect([...getIds(tab)]).toEqual(["x"]);
	});
});

describe("凭据变更后的联动重试", () => {
	const retry = (tab: TranslatorSettingTab) =>
		(tab as unknown as { retryFailedTranslations(): void }).retryFailedTranslations();

	it("市场视图未打开时静默跳过", () => {
		const { tab } = makeTab({ app: { workspace: { getLeavesOfType: () => [] } } });
		expect(() => retry(tab)).not.toThrow();
	});

	it("视图存在但尚未建 ctx 时跳过", () => {
		const { tab } = makeTab({
			app: { workspace: { getLeavesOfType: () => [{ view: {} }] } },
		});
		expect(() => retry(tab)).not.toThrow();
	});

	it("视图就绪时对可见未译项触发一次重译", () => {
		const aiTranslateAllPending = vi.fn().mockResolvedValue(undefined);
		const { tab } = makeTab({
			app: { workspace: { getLeavesOfType: () => [{ view: { ctx: { aiTranslateAllPending } } }] } },
		});
		retry(tab);
		expect(aiTranslateAllPending).toHaveBeenCalledTimes(1);
	});

	it("重译失败只记日志，不把异常抛给设置页", async () => {
		const aiTranslateAllPending = vi.fn().mockRejectedValue(new Error("boom"));
		const { tab } = makeTab({
			app: { workspace: { getLeavesOfType: () => [{ view: { ctx: { aiTranslateAllPending } } }] } },
		});
		expect(() => retry(tab)).not.toThrow();
		await flushAsync();
		expect(aiTranslateAllPending).toHaveBeenCalled();
	});
});

describe("设置页翻译开关（实时生效）", () => {
	const render = (tab: TranslatorSettingTab) => {
		const stub = makeSettingStub();
		callPrivate(tab, "renderTranslateSettingsEnable", stub);
		return stub;
	};

	it("渲染出一个开关控件", () => {
		const { tab } = makeTab({}, { translateSettingsEnabled: true });
		expect(render(tab).buttons.length).toBe(1);
	});

	it("开启时挂载钩子并落盘", async () => {
		const { tab, plugin } = makeTab({}, { translateSettingsEnabled: false });
		await render(tab).buttons[0].handlers.onChange!(true);

		expect(plugin.settings.translateSettingsEnabled).toBe(true);
		expect(plugin.ensureSettingsTranslator).toHaveBeenCalled();
		expect(plugin.settingsTranslator!.enable).toHaveBeenCalled();
		expect(plugin.flushSaveSettings).toHaveBeenCalled();
	});

	it("关闭时卸载钩子并落盘", async () => {
		const { tab, plugin } = makeTab({}, { translateSettingsEnabled: true });
		await render(tab).buttons[0].handlers.onChange!(false);

		expect(plugin.settings.translateSettingsEnabled).toBe(false);
		expect(plugin.settingsTranslator!.disable).toHaveBeenCalled();
		expect(plugin.flushSaveSettings).toHaveBeenCalled();
	});
});
