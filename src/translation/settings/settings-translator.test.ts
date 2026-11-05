import { describe, it, expect, vi, afterEach } from "vitest";
import { Setting, ButtonComponent, DropdownComponent, TextComponent } from "obsidian";
import { SettingsTranslator, isCjkText, type SettingsTranslateConfig } from "./settings-translator";
import type { Translator } from "@domain/catalog/translator";

// 追加用例所需的替身：DOM 扫描通道 mock 掉（真实 start() 会挂 MutationObserver），
// 同时捕获构造参数里的四个回调，便于直接验证 domEligible/shouldSkip/translateBatch 的接线。
const domH = vi.hoisted(() => ({
	start: vi.fn(),
	stop: vi.fn(),
	reset: vi.fn(),
	instances: [] as Array<{ deps: Record<string, (...a: never[]) => unknown> }>,
	warn: vi.fn(),
}));
vi.mock("./settings-dom-translator", () => ({
	SettingsDomTranslator: vi.fn().mockImplementation((deps: Record<string, (...a: never[]) => unknown>) => {
		const inst = { deps, start: domH.start, stop: domH.stop, reset: domH.reset };
		domH.instances.push(inst);
		return inst;
	}),
}));
vi.mock("@shared/logger", () => ({
	logger: { warn: domH.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// obsidian mock 的 DropdownComponent 未提供 addOptions，补齐以便 install() 能保存/调用原型方法
if (typeof (DropdownComponent.prototype as unknown as Record<string, unknown>).addOptions !== "function") {
	(DropdownComponent.prototype as unknown as Record<string, unknown>).addOptions = function (
		this: { selectEl: HTMLSelectElement },
		options: Record<string, string>,
	) {
		for (const [value, text] of Object.entries(options)) {
			const opt = document.createElement("option");
			opt.value = value;
			opt.text = text;
			this.selectEl.appendChild(opt);
		}
		return this;
	};
}

/** 用固定映射模拟翻译引擎（仅 translateTextSegment 被调用） */
function makeTranslator(map: Record<string, string>) {
	const spy = vi.fn(async (text: string) => map[text] ?? null);
	return { translateTextSegment: spy } as unknown as Translator & { translateTextSegment: ReturnType<typeof vi.fn> };
}

function makeSt(map: Record<string, string>, config: SettingsTranslateConfig, pluginId?: string) {
	const translator = makeTranslator(map);
	const app = {
		setting: pluginId
			? { activeTab: { plugin: { manifest: { id: pluginId } } } }
			: undefined,
	} as unknown as ConstructorParameters<typeof SettingsTranslator>[0];
	const st = new SettingsTranslator(app, translator, () => config);
	return { st, translator };
}

/** 构造一个 descEl（DOM 节点，避免 innerHTML 注入） */
function makeDescEl(html: string): HTMLElement {
	const root = document.createElement("div");
	// 仅用于测试夹具的简单标签解析：支持 <p>..</p> 与 <a href="x">..</a>
	const re = /<a\s+href="([^"]*)">([^<]*)<\/a>|<p>([^<]*)<\/p>|([^<]+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html)) !== null) {
		if (m[1] !== undefined) {
			const a = document.createElement("a");
			a.setAttribute("href", m[1]);
			a.textContent = m[2];
			root.appendChild(a);
		} else if (m[3] !== undefined) {
			const p = document.createElement("p");
			p.textContent = m[3];
			root.appendChild(p);
		} else if (m[4] !== undefined && m[4].trim() !== "") {
			root.appendChild(document.createTextNode(m[4]));
		}
	}
	return root;
}

describe("isCjkText", () => {
	it("命中中文返回 true，英文返回 false", () => {
		expect(isCjkText("启用设置")).toBe(true);
		expect(isCjkText("Enable")).toBe(false);
		expect(isCjkText("Enable 启用")).toBe(true);
	});
});

describe("SettingsTranslator.translateText", () => {
	it("翻译并写回缓存，二次命中不再调用引擎", async () => {
		const config: SettingsTranslateConfig = { enabled: true, provider: "free", blacklist: [] };
		const { st, translator } = makeSt({ Enable: "启用" }, config);
		const translateText = (st as unknown as { translateText: (t: string) => Promise<string | null> }).translateText.bind(st);
		const r1 = await translateText("Enable");
		expect(r1).toBe("启用");
		const r2 = await translateText("Enable");
		expect(r2).toBe("启用");
		expect(translator.translateTextSegment).toHaveBeenCalledTimes(1);
	});
});

describe("SettingsTranslator.translateDescEl", () => {
	it("仅翻译文本节点并保留标签结构", async () => {
		const config: SettingsTranslateConfig = { enabled: true, provider: "free", blacklist: [] };
		const { st } = makeSt({ Enable: "启用", Click: "点击" }, config);
		const el = makeDescEl('<p>Enable</p><a href="x">Click</a>');
		const translateDescEl = (st as unknown as { translateDescEl: (el: HTMLElement) => Promise<void> }).translateDescEl.bind(st);
		await translateDescEl(el);
		const p = el.querySelector("p");
		const a = el.querySelector("a");
		expect(p?.textContent).toBe("启用");
		expect(a?.textContent).toBe("点击");
		expect(a?.getAttribute("href")).toBe("x");
	});

	it("纯文本走普通串翻译", async () => {
		const config: SettingsTranslateConfig = { enabled: true, provider: "free", blacklist: [] };
		const { st } = makeSt({ Enable: "启用" }, config);
		const el = makeDescEl("Enable");
		const translateDescEl = (st as unknown as { translateDescEl: (el: HTMLElement) => Promise<void> }).translateDescEl.bind(st);
		await translateDescEl(el);
		expect(el.textContent).toBe("启用");
	});

	it("已是中文则跳过，不调用引擎", async () => {
		const config: SettingsTranslateConfig = { enabled: true, provider: "free", blacklist: [] };
		const { st, translator } = makeSt({}, config);
		const el = makeDescEl("已启用");
		const translateDescEl = (st as unknown as { translateDescEl: (el: HTMLElement) => Promise<void> }).translateDescEl.bind(st);
		await translateDescEl(el);
		expect(el.textContent).toBe("已启用");
		expect(translator.translateTextSegment).not.toHaveBeenCalled();
	});

	it("黑名单插件 ID 跳过翻译", async () => {
		const config: SettingsTranslateConfig = { enabled: true, provider: "free", blacklist: ["foo"] };
		const { st, translator } = makeSt({ Enable: "启用" }, config, "foo");
		const el = makeDescEl("Enable");
		const translateDescEl = (st as unknown as { translateDescEl: (el: HTMLElement) => Promise<void> }).translateDescEl.bind(st);
		await translateDescEl(el);
		expect(el.textContent).toBe("Enable");
		expect(translator.translateTextSegment).not.toHaveBeenCalled();
	});
});

// ─────────────────────────────────────────────────────────────
// 以下为追加用例：缓存、生命周期补丁、DOM 通道接线、批量翻译、组件通道
// ─────────────────────────────────────────────────────────────

type SegFn = (text: string, prov: string) => string | null | Promise<string | null>;
type SegsFn = (texts: string[], prov: string) => (string | null)[] | Promise<(string | null)[]>;

const cfg = (over: Partial<SettingsTranslateConfig> = {}): SettingsTranslateConfig => ({
	enabled: true,
	provider: "free",
	blacklist: [],
	...over,
});
const baseApp = () => ({
	setting: {
		activeTab: {
			plugin: { manifest: { id: "some-plugin" } },
			containerEl: document.createElement("div"),
		},
		tabContentContainer: document.createElement("div"),
	},
});
const priv = (st: SettingsTranslator, name: string, ...args: unknown[]): unknown =>
	(st as unknown as Record<string, (...a: unknown[]) => unknown>)[name](...args);
const settle = (): Promise<void> => new Promise((r) => window.setTimeout(r, 5));

const created: SettingsTranslator[] = [];
afterEach(() => {
	for (const st of created.splice(0)) st.disable();
	domH.instances.length = 0;
	vi.clearAllMocks();
});

function mkCtx(o: { config?: SettingsTranslateConfig; app?: unknown; seg?: SegFn; segs?: SegsFn } = {}) {
	const translator = {
		translateTextSegment: vi.fn((text: string, prov: string) =>
			Promise.resolve(o.seg ? o.seg(text, prov) : null),
		),
		translateTextSegments: vi.fn((texts: string[], prov: string) =>
			Promise.resolve(o.segs ? o.segs(texts, prov) : texts.map(() => null)),
		),
	};
	const config = o.config ?? cfg();
	const app = o.app === undefined ? baseApp() : o.app;
	const st = new SettingsTranslator(app as never, translator as unknown as Translator, () => config);
	created.push(st);
	return { st, translator, config, app };
}
const deps = () => domH.instances[domH.instances.length - 1].deps;

describe("缓存管理", () => {
	it("loadCache(undefined) 静默；loadCache 注入后 translateText 直接命中不调引擎", async () => {
		const { st, translator } = mkCtx();
		st.loadCache(undefined);
		st.loadCache({ Enable: "启用" });
		expect(await priv(st, "translateText", "Enable")).toBe("启用");
		expect(translator.translateTextSegment).not.toHaveBeenCalled();
		expect(st.exportCache()).toEqual({ Enable: "启用" });
	});

	it("clearCache 清空缓存与 pending 并 reset DOM 通道", () => {
		const { st } = mkCtx();
		st.loadCache({ a: "甲" });
		st.clearCache();
		expect(st.exportCache()).toEqual({});
		expect(domH.reset).toHaveBeenCalled();
	});

	it("CACHE_CAP=3000：exportCache 按插入顺序淘汰最旧", () => {
		const { st } = mkCtx();
		const many: Record<string, string> = {};
		for (let i = 0; i < 3001; i++) many[`k${i}`] = "v";
		st.loadCache(many);
		const out = st.exportCache();
		expect(Object.keys(out)).toHaveLength(3000);
		expect(out.k0).toBeUndefined();
		expect(out.k3000).toBe("v");
	});

	it("translateText 成功后触发 evict，超出上限淘汰最旧", async () => {
		const { st } = mkCtx({ seg: () => "译文" });
		const many: Record<string, string> = {};
		for (let i = 0; i < 3000; i++) many[`k${i}`] = "v";
		st.loadCache(many);
		await priv(st, "translateText", "new");
		const out = st.exportCache();
		expect(Object.keys(out)).toHaveLength(3000);
		expect(out.k0).toBeUndefined();
		expect(out.new).toBe("译文");
	});
});

describe("生命周期补丁 enable / disable / restore", () => {
	it("originals 未初始化时 restore 直接返回（首个用例，此时无人 install 过）", () => {
		const { st } = mkCtx();
		expect(() => priv(st, "restore")).not.toThrow();
	});

	it("isPatched 状态机 + enable 幂等 + disable 恢复原型", () => {
		const { st } = mkCtx();
		const beforeName = Setting.prototype.setName;
		const beforeDesc = Setting.prototype.setDesc;
		expect(st.isPatched()).toBe(false);
		st.enable();
		expect(st.isPatched()).toBe(true);
		expect(domH.start).toHaveBeenCalledTimes(1);
		expect(Setting.prototype.setName).not.toBe(beforeName);
		st.enable(); // 幂等
		expect(domH.start).toHaveBeenCalledTimes(1);
		st.disable();
		expect(st.isPatched()).toBe(false);
		expect(domH.stop).toHaveBeenCalledTimes(1);
		expect(Setting.prototype.setName).toBe(beforeName);
		expect(Setting.prototype.setDesc).toBe(beforeDesc);
		expect(DropdownComponent.prototype.addOption).toBeDefined();
	});

	it("disable 未 patched 时直接返回", () => {
		const { st } = mkCtx();
		st.disable();
		expect(domH.stop).not.toHaveBeenCalled();
		expect(domH.reset).not.toHaveBeenCalled();
	});

	it("第二个实例 enable 会卸载上一任（activeDisable 热重载兜底）", () => {
		const a = mkCtx();
		const b = mkCtx();
		a.st.enable();
		expect(() => b.st.enable()).not.toThrow();
		expect(b.st.isPatched()).toBe(true);
		expect(domH.start).toHaveBeenCalledTimes(2);
	});

	it("disable 清空 pending（在途翻译不再复用）", async () => {
		let release: (v: string | null) => void = () => {};
		const { st } = mkCtx({ seg: () => new Promise<string | null>((r) => { release = r; }) });
		const p = priv(st, "translateText", "slow") as Promise<string | null>;
		st.disable();
		release("译文");
		expect(await p).toBe("译文");
		expect((st as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
	});
});

describe("插件 ID / DOM 根 / 放行判定", () => {
	it("currentPluginId：正常取到 / setting 缺失 / getter 抛错都容错", () => {
		expect(priv(mkCtx().st, "currentPluginId")).toBe("some-plugin");
		expect(priv(mkCtx({ app: {} }).st, "currentPluginId")).toBeUndefined();
		const throwing = { get setting() { throw new Error("boom"); } };
		expect(priv(mkCtx({ app: throwing }).st, "currentPluginId")).toBeUndefined();
	});

	it("domRoot：activeTab.containerEl 优先 / tabContentContainer 回退 / 全无 / 抛错", () => {
		const app = baseApp() as { setting: Record<string, unknown> };
		expect(priv(mkCtx({ app }).st, "domRoot")).toBe(app.setting.activeTab && (app.setting.activeTab as { containerEl: HTMLElement }).containerEl);
		expect(priv(mkCtx({ app: { setting: { tabContentContainer: document.body } } }).st, "domRoot")).toBe(document.body);
		expect(priv(mkCtx({ app: { setting: {} } }).st, "domRoot")).toBeNull();
		expect(priv(mkCtx({ app: {} }).st, "domRoot")).toBeNull();
		expect(priv(mkCtx({ app: { get setting() { throw new Error("x"); } } }).st, "domRoot")).toBeNull();
	});

	it("shouldSkip：空串/空白、CJK、未启用、黑名单、正常英文", () => {
		expect(priv(mkCtx().st, "shouldSkip", "")).toBe(true);
		expect(priv(mkCtx().st, "shouldSkip", "   ")).toBe(true);
		expect(priv(mkCtx().st, "shouldSkip", "中文")).toBe(true);
		expect(priv(mkCtx({ config: cfg({ enabled: false }) }).st, "shouldSkip", "Enable")).toBe(true);
		expect(priv(mkCtx({ config: cfg({ blacklist: ["some-plugin"] }) }).st, "shouldSkip", "Enable")).toBe(true);
		expect(priv(mkCtx().st, "shouldSkip", "Enable")).toBe(false);
	});

	it("domEligible：未启用 / 无 pid / 自身 / 黑名单 → false；第三方 → true", () => {
		expect(priv(mkCtx({ config: cfg({ enabled: false }) }).st, "domEligible")).toBe(false);
		expect(priv(mkCtx({ app: {} }).st, "domEligible")).toBe(false);
		const selfApp = { setting: { activeTab: { plugin: { manifest: { id: "chinese-plugin-market" } } } } };
		expect(priv(mkCtx({ app: selfApp }).st, "domEligible")).toBe(false);
		expect(priv(mkCtx({ config: cfg({ blacklist: ["some-plugin"] }) }).st, "domEligible")).toBe(false);
		expect(priv(mkCtx().st, "domEligible")).toBe(true);
	});

	it("DOM 通道四个回调接线可用（shouldSkip/translate/translateBatch/getRoot）", async () => {
		const { st } = mkCtx({ seg: () => "译文", segs: (ts) => ts.map(() => "译") });
		const d = deps() as unknown as {
			shouldSkip: (t: string) => boolean;
			translate: (t: string) => Promise<string | null>;
			translateBatch: (t: string[]) => Promise<Map<string, string>>;
			getRoot: () => HTMLElement | null;
		};
		expect(d.shouldSkip("中文")).toBe(true);
		expect(d.shouldSkip("Enable")).toBe(false);
		expect(await d.translate("Enable")).toBe("译文");
		expect((await d.translateBatch(["a"])).get("a")).toBe("译");
		expect(d.getRoot()).toBeInstanceOf(HTMLElement);
		expect(priv(st, "domEligible")).toBe(true);
	});
});

describe("translateText provider 链 / 去重 / 异常", () => {
	it("provider=free：首个通道返回 null → 兜底 baidu", async () => {
		const { st, translator } = mkCtx({ seg: (_t, p) => (p === "baidu" ? "译文" : null) });
		expect(await priv(st, "translateText", "Enable")).toBe("译文");
		expect(translator.translateTextSegment.mock.calls.map((c) => c[1])).toEqual(["tencent-transmart", "baidu"]);
		expect(st.exportCache()).toEqual({ Enable: "译文" });
	});

	it("provider=baidu：只走 baidu 一次", async () => {
		const { st, translator } = mkCtx({ config: cfg({ provider: "baidu" }), seg: () => "译" });
		expect(await priv(st, "translateText", "Enable")).toBe("译");
		expect(translator.translateTextSegment).toHaveBeenCalledTimes(1);
		expect(translator.translateTextSegment.mock.calls[0][1]).toBe("baidu");
	});

	it("译文等于原文不算成功，继续下一通道；全失败返回 null", async () => {
		const { st, translator } = mkCtx({ seg: (t) => t });
		expect(await priv(st, "translateText", "Enable")).toBeNull();
		expect(translator.translateTextSegment).toHaveBeenCalledTimes(2);
	});

	it("引擎抛错 → logger.warn + 返回 null，并清理 pending", async () => {
		// 真实 translateTextSegment 是 async，失败表现为 rejected Promise（而非同步 throw）
		const { st } = mkCtx({ seg: () => Promise.reject(new Error("net")) });
		expect(await priv(st, "translateText", "Enable")).toBeNull();
		expect(domH.warn).toHaveBeenCalled();
		expect((st as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
	});

	it("inflight 去重：并发同文本只调一次引擎", async () => {
		const { st, translator } = mkCtx({ seg: () => "译" });
		const [a, b] = await Promise.all([
			priv(st, "translateText", "Enable") as Promise<string | null>,
			priv(st, "translateText", "Enable") as Promise<string | null>,
		]);
		expect(a).toBe("译");
		expect(b).toBe("译");
		expect(translator.translateTextSegment).toHaveBeenCalledTimes(1);
		expect((st as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
	});

	it("finally 清理 pending 后可再次发起新翻译", async () => {
		const { st, translator } = mkCtx({ seg: () => "译" });
		await priv(st, "translateText", "Enable");
		vi.mocked(translator.translateTextSegment).mockClear(); // 缓存已命中，不应再调
		expect(await priv(st, "translateText", "Enable")).toBe("译");
		expect(translator.translateTextSegment).not.toHaveBeenCalled();
	});
});

describe("translateBatchTexts 批量翻译", () => {
	it("全部命中缓存 → 早返不调引擎", async () => {
		const { st, translator } = mkCtx();
		st.loadCache({ a: "甲", b: "乙" });
		const out = (await priv(st, "translateBatchTexts", ["a", "b"])) as Map<string, string>;
		expect(Object.fromEntries(out)).toEqual({ a: "甲", b: "乙" });
		expect(translator.translateTextSegments).not.toHaveBeenCalled();
	});

	it("缺缓存 → 整块一次请求，译出的写回缓存", async () => {
		const { st, translator } = mkCtx({ segs: (ts) => ts.map((t) => `${t}译`) });
		const out = (await priv(st, "translateBatchTexts", ["a", "b"])) as Map<string, string>;
		expect(out.get("a")).toBe("a译");
		expect(out.get("b")).toBe("b译");
		expect(translator.translateTextSegments).toHaveBeenCalledTimes(1);
		expect(st.exportCache()).toEqual({ a: "a译", b: "b译" });
	});

	it("块内未译出（null / 空串 / 回显）→ 交给下一通道", async () => {
		const { st, translator } = mkCtx({
			segs: (ts, p) => (p === "baidu" ? ts.map(() => "补译") : ts.map((t) => (t === "a" ? null : t))),
		});
		const out = (await priv(st, "translateBatchTexts", ["a", "b"])) as Map<string, string>;
		expect(translator.translateTextSegments.mock.calls.map((c) => c[1])).toEqual(["tencent-transmart", "baidu"]);
		expect(out.get("a")).toBe("补译");
		expect(out.get("b")).toBe("补译");
	});

	it("provider=baidu 只跑一轮", async () => {
		const { st, translator } = mkCtx({ config: cfg({ provider: "baidu" }), segs: () => [] });
		await priv(st, "translateBatchTexts", ["a"]);
		expect(translator.translateTextSegments).toHaveBeenCalledTimes(1);
		expect(translator.translateTextSegments.mock.calls[0][1]).toBe("baidu");
	});

	it("批量引擎抛错 → logger.warn + continue 到下一通道", async () => {
		const { st } = mkCtx({ segs: (_ts, p) => {
			if (p === "tencent-transmart") throw new Error("net");
			return ["译"];
		} });
		const out = (await priv(st, "translateBatchTexts", ["a"])) as Map<string, string>;
		expect(domH.warn).toHaveBeenCalled();
		expect(out.get("a")).toBe("译");
	});

	it("results 长于入参时多余项（src undefined）被跳过", async () => {
		const { st } = mkCtx({ segs: () => ["甲", "乙", "丙"] });
		const out = (await priv(st, "translateBatchTexts", ["a"])) as Map<string, string>;
		expect(out.size).toBe(1);
		expect(out.get("a")).toBe("甲");
	});
});

describe("translateDescEl 边界", () => {
	it("无文本节点 → 直接返回", async () => {
		const { st, translator } = mkCtx();
		await st.translateDescEl(document.createElement("div"));
		expect(translator.translateTextSegment).not.toHaveBeenCalled();
	});

	it("全是空白 / 中文节点 → 不调引擎", async () => {
		const { st, translator } = mkCtx();
		const el = document.createElement("div");
		el.appendChild(document.createTextNode("   "));
		el.appendChild(document.createTextNode("已中文"));
		await st.translateDescEl(el);
		expect(translator.translateTextSegment).not.toHaveBeenCalled();
	});

	it("重复文本去重 + 多个节点同步改写", async () => {
		const { st, translator } = mkCtx({ seg: () => "启用" });
		const el = makeDescEl("<p>Enable</p><p>Enable</p>");
		await st.translateDescEl(el);
		expect(Array.from(el.querySelectorAll("p")).map((p) => p.textContent)).toEqual(["启用", "启用"]);
		expect(translator.translateTextSegment).toHaveBeenCalledTimes(1);
	});

	it("翻译失败（返回 null）→ 保留原 nodeValue", async () => {
		const { st } = mkCtx({ seg: () => null });
		const el = makeDescEl("Enable");
		await st.translateDescEl(el);
		expect(el.textContent).toBe("Enable");
	});

	it("递归收集深层嵌套标签内的文本节点", async () => {
		const { st } = mkCtx({ seg: () => "启用" });
		const el = document.createElement("div");
		const p = document.createElement("p");
		const b = document.createElement("b");
		b.textContent = "Enable";
		p.appendChild(b);
		el.appendChild(p);
		await st.translateDescEl(el);
		expect(b.textContent).toBe("启用");
	});
});

describe("组件通道 6 个原型补丁", () => {
	const patched = (o: Parameters<typeof mkCtx>[0] = {}) => {
		const ctx = mkCtx(o);
		ctx.st.enable();
		return ctx;
	};

	it("Setting.setName：文本节点回写 / 非字符串与 shouldSkip 跳过", async () => {
		patched({ seg: () => "启用" });
		const s = new Setting(document.createElement("div"));
		(s as unknown as { nameEl: HTMLElement }).nameEl = document.createElement("div");
		const nameEl = (s as unknown as { nameEl: HTMLElement }).nameEl;
		s.setName("Enable");
		nameEl.textContent = "Enable"; // 原始 mock 不写 DOM，手工对齐守卫条件
		await settle();
		expect(nameEl.textContent).toBe("启用");

		s.setName(42 as unknown as string);
		s.setName("中文");
		await settle();
		expect(nameEl.textContent).toBe("启用");
	});

	it("Setting.setName：元素文案已被改写则不覆盖", async () => {
		patched({ seg: () => "启用" });
		const s = new Setting(document.createElement("div"));
		const nameEl = document.createElement("div");
		(s as unknown as { nameEl: HTMLElement }).nameEl = nameEl;
		s.setName("Enable");
		nameEl.textContent = "other";
		await settle();
		expect(nameEl.textContent).toBe("other");
	});

	it("Setting.setDesc：触发 translateDescEl 翻译文本节点", async () => {
		patched({ seg: () => "启用" });
		const s = new Setting(document.createElement("div"));
		const descEl = makeDescEl("Enable");
		(s as unknown as { descEl: HTMLElement }).descEl = descEl;
		s.setDesc("Enable");
		await settle();
		expect(descEl.textContent).toBe("启用");

		const skipEl = makeDescEl("中文");
		(s as unknown as { descEl: HTMLElement }).descEl = skipEl;
		s.setDesc(42 as unknown as string);
		s.setDesc("中文");
		await settle();
		expect(skipEl.textContent).toBe("中文");
	});

	it("ButtonComponent.setButtonText：回写 / shouldSkip 跳过", async () => {
		patched({ seg: () => "点击" });
		const b = new ButtonComponent(document.createElement("div"));
		b.setButtonText("Click");
		await settle();
		expect(b.buttonEl.textContent).toBe("点击");
		b.setButtonText("中文");
		await settle();
		expect(b.buttonEl.textContent).toBe("中文");
	});

	it("ButtonComponent：文案已变则不覆盖", async () => {
		patched({ seg: () => "点击" });
		const b = new ButtonComponent(document.createElement("div"));
		b.setButtonText("Click");
		b.buttonEl.textContent = "changed";
		await settle();
		expect(b.buttonEl.textContent).toBe("changed");
	});

	it("DropdownComponent.addOption：找到匹配 option 才改写", async () => {
		patched({ seg: () => "选项" });
		const d = new DropdownComponent(document.createElement("div"));
		d.addOption("v1", "One");
		await settle();
		expect(d.selectEl.options[0].text).toBe("选项");
		d.addOption("v2", "中文");
		await settle();
		expect(d.selectEl.options[1].text).toBe("中文");
	});

	it("DropdownComponent.addOption：option 已被移除时静默不报错", async () => {
		patched({ seg: () => "选项" });
		const d = new DropdownComponent(document.createElement("div"));
		d.addOption("v1", "One");
		d.selectEl.innerHTML = "";
		await expect(settle()).resolves.toBeUndefined();
	});

	it("DropdownComponent.addOptions：批量改写多个 option", async () => {
		patched({ seg: (t) => (t === "One" ? "一" : "二") });
		const d = new DropdownComponent(document.createElement("div"));
		(d as unknown as { addOptions: (o: Record<string, string>) => unknown }).addOptions({ v1: "One", v2: "Two" });
		await settle();
		expect(Array.from(d.selectEl.options).map((o) => o.text)).toEqual(["一", "二"]);
	});

	it("DropdownComponent.addOptions：shouldSkip 的项不翻译", async () => {
		patched({ seg: () => "译" });
		const d = new DropdownComponent(document.createElement("div"));
		(d as unknown as { addOptions: (o: Record<string, string>) => unknown }).addOptions({ v1: "One", v2: "中文" });
		await settle();
		expect(Array.from(d.selectEl.options).map((o) => o.text)).toEqual(["译", "中文"]);
	});

	it("TextComponent.setPlaceholder：回写 / 已改则不覆盖 / shouldSkip 跳过", async () => {
		patched({ seg: () => "请输入" });
		const t = new TextComponent(document.createElement("div"));
		t.setPlaceholder("Type here");
		await settle();
		expect(t.inputEl.placeholder).toBe("请输入");

		const t2 = new TextComponent(document.createElement("div"));
		t2.setPlaceholder("Type here");
		t2.inputEl.placeholder = "changed";
		await settle();
		expect(t2.inputEl.placeholder).toBe("changed");

		const t3 = new TextComponent(document.createElement("div"));
		t3.setPlaceholder("中文");
		await settle();
		expect(t3.inputEl.placeholder).toBe("中文");
	});
});
