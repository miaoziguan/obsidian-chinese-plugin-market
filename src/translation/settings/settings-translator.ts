/**
 * 设置页即时机翻
 *
 * 目标：翻译其他插件设置页的文案（设置项名称、描述、控件标签/占位符/下拉选项按钮文字）。
 * 路线：钩住 Obsidian 的 `Setting` 组件与常用控件组件的原型方法，在渲染时拦截每个字符串，
 * 用本插件已有的翻译引擎（腾讯翻译·免费 / 百度）即时翻译，而非维护逐插件词典
 * （i18n-plus 的众包词典路线对长描述、动态生成的设置页覆盖率为零，不适合）。
 *
 * 设计要点：
 * - 同步优先：命中本地串缓存 → 直接替换，零闪烁。
 * - 异步兜底：缓存未命中 → 调 translator.translateTextSegment（免费通道优先，百度兜底）→
 *   拿到后就地更新元素，并写回缓存（跨会话持久）。首次打开会有「原文→译文」短暂闪烁。
 * - HTML 安全：`setDesc` 可能含 <a>/<b> 等标签，只翻译文本节点、保留结构；改写走 DOM
 *   文本节点 nodeValue 原地更新，绝不赋值 element.innerHTML / outerHTML（避免 XSS 与注入风险）。
 * - 安全开关：默认关；按插件 ID 黑名单（个别会回读自身 DOM 文案的插件）；已是中文的串（含 CJK）跳过，
 *   这也顺带避免翻译我们自己的中文设置页。
 *
 * 两条通道（缺一不可）：
 * - 组件通道（本文件）：钩 Obsidian 原生 Setting / Button / Dropdown / Text 组件原型方法，
 *   覆盖用 `new Setting()` 搭出来的传统设置页。
 * - DOM 通道（settings-dom-translator.ts）：直接扫描设置面板 DOM 的英文文本节点。
 *   覆盖 React / Vue 自绘设置页（如 Copilot 全程 `render(<SettingsMainV2 />)`，
 *   不碰原生 Setting 组件，组件通道一个字符串都拦不到）。
 */

import {
	Setting,
	ButtonComponent,
	DropdownComponent,
	TextComponent,
	type App,
} from "obsidian";
import type { Translator } from "@domain/catalog/translator";
import { asAppInternals } from "@data/platform/obsidian-internals";
import { SettingsDomTranslator } from "./settings-dom-translator";
import { logger } from "@shared/logger";

/** 命中中文（含 CJK 统一表意/扩展A/全角）则视为已翻译，跳过 */
const CJK_RE = /[㐀-䶿一-鿿＀-￯]/;
/** 本插件自身 ID：不翻译自己的设置页（页内 API / Provider 等术语译后更难懂） */
const SELF_PLUGIN_ID = "chinese-plugin-market";

export function isCjkText(text: string): boolean {
	return CJK_RE.test(text);
}

export type SettingsTranslateProvider = "free" | "baidu";

export interface SettingsTranslateConfig {
	enabled: boolean;
	provider: SettingsTranslateProvider;
	/** 不翻译的插件 ID 列表 */
	blacklist: string[];
}

interface PatchOriginals {
	setName: (name: unknown, ...rest: unknown[]) => unknown;
	setDesc: (desc: unknown, ...rest: unknown[]) => unknown;
	setButtonText: (text: string, ...rest: unknown[]) => unknown;
	addOption: (value: string, display: string, ...rest: unknown[]) => unknown;
	addOptions: (options: Record<string, string>, ...rest: unknown[]) => unknown;
	setPlaceholder: (text: string, ...rest: unknown[]) => unknown;
}

/** 缓存上限：超出后按插入顺序淘汰最旧，避免无限增长 */
const CACHE_CAP = 3000;
/** 原型原始方法备份（用于卸载时恢复）；仅 install 一次时填充 */
let originals: PatchOriginals | null = null;
/** 当前已挂载补丁的实例的卸载钩子；避免跨实例重复打补丁（不持有 this 引用） */
let activeDisable: (() => void) | null = null;

export class SettingsTranslator {
	private translator: Translator;
	private getConfig: () => SettingsTranslateConfig;
	private app: App;
	private cache = new Map<string, string>();
	private pending = new Map<string, Promise<string | null>>();
	private patched = false;
	/** DOM 扫描通道（覆盖 React / Vue 自绘设置页） */
	private readonly dom: SettingsDomTranslator;

	constructor(app: App, translator: Translator, getConfig: () => SettingsTranslateConfig) {
		this.app = app;
		this.translator = translator;
		this.getConfig = getConfig;
		this.dom = new SettingsDomTranslator({
			shouldSkip: (text) => !this.domEligible() || this.shouldSkip(text),
			translate: (text) => this.translateText(text),
			translateBatch: (texts) => this.translateBatchTexts(texts),
			getRoot: () => this.domRoot(),
		});
	}

	loadCache(map: Record<string, string> | undefined): void {
		if (!map) return;
		for (const [k, v] of Object.entries(map)) this.cache.set(k, v);
	}

	/** 导出缓存（用于跨会话持久化），超额自动淘汰 */
	exportCache(): Record<string, string> {
		this.evict();
		return Object.fromEntries(this.cache);
	}

	/** 清空内存缓存（设置页「清空翻译缓存」按钮用） */
	clearCache(): void {
		this.cache.clear();
		this.pending.clear();
		this.dom.reset();
	}

	isPatched(): boolean {
		return this.patched;
	}

	enable(): void {
		if (this.patched) return;
		// 卸载上一任持有者（理论上只有单实例，热重载兜底）
		activeDisable?.();
		this.install();
		this.dom.start();
		this.patched = true;
		activeDisable = () => this.restore();
	}

	disable(): void {
		if (!this.patched) return;
		this.dom.stop();
		this.restore();
		this.pending.clear();
		this.patched = false;
		activeDisable = null;
	}

	private evict(): void {
		while (this.cache.size > CACHE_CAP) {
			const k = this.cache.keys().next().value;
			if (k === undefined) break;
			this.cache.delete(k);
		}
	}

	/** 读取当前打开的设置页所属插件 ID（用于黑名单过滤；取不到则不做黑名单） */
	private currentPluginId(): string | undefined {
		try {
			return asAppInternals(this.app).setting?.activeTab?.plugin?.manifest?.id;
		} catch {
			return undefined;
		}
	}

	/** DOM 通道扫描根：当前 Tab 的内容容器（比整块 tabContentContainer 更精准） */
	private domRoot(): HTMLElement | null {
		try {
			const setting = asAppInternals(this.app).setting;
			if (!setting) return null;
			return setting.activeTab?.containerEl ?? setting.tabContentContainer ?? null;
		} catch {
			return null;
		}
	}

	/**
	 * DOM 通道是否放行：只翻第三方插件设置页。
	 * 原生核心页（社区插件 / 外观等）刻意不扫 —— 那里的英文多为插件 ID、作者名、
	 * 片段文件名，翻了反而干扰识别；且部分已由本插件的增强栏单独译过。
	 */
	private domEligible(): boolean {
		const cfg = this.getConfig();
		if (!cfg.enabled) return false;
		const pid = this.currentPluginId();
		if (!pid || pid === SELF_PLUGIN_ID) return false;
		return !cfg.blacklist.includes(pid);
	}

	private shouldSkip(text: string): boolean {
		if (!text || !text.trim()) return true;
		if (isCjkText(text)) return true;
		const cfg = this.getConfig();
		if (!cfg.enabled) return true;
		const pid = this.currentPluginId();
		if (pid && cfg.blacklist.includes(pid)) return true;
		return false;
	}

	private async translateText(text: string): Promise<string | null> {
		const cached = this.cache.get(text);
		if (cached !== undefined) return cached;
		const inflight = this.pending.get(text);
		if (inflight) return inflight;
		const cfg = this.getConfig();
		const providers: Array<"tencent-transmart" | "baidu"> =
			cfg.provider === "baidu" ? ["baidu"] : ["tencent-transmart", "baidu"];
		const p = (async () => {
			try {
				for (const prov of providers) {
					const r = await this.translator.translateTextSegment(text, prov);
					if (r && r !== text) {
						this.cache.set(text, r);
						this.evict();
						return r;
					}
				}
				return null;
			} catch (e) {
				logger.warn("[Chinese Plugin Market] 设置页翻译失败:", e);
				return null;
			} finally {
				this.pending.delete(text);
			}
		})();
		this.pending.set(text, p);
		return p;
	}

	/**
	 * 批量翻译（DOM 通道专用）：一次译一整块文案，命中缓存的串直接返回。
	 *
	 * 性能关键：设置页首屏常有上百条文案，若逐条走「detect + translate」两次往返，
	 * 免费通道要 30 秒以上才翻完一屏。这里整块一次请求（见 Translator.translateTextSegments），
	 * 块内未译出的再逐条兜底，最后仍译不出的留给下一个通道，全部失败才判失败。
	 */
	private async translateBatchTexts(texts: string[]): Promise<Map<string, string>> {
		const out = new Map<string, string>();
		const miss: string[] = [];
		for (const t of texts) {
			const cached = this.cache.get(t);
			if (cached !== undefined) out.set(t, cached);
			else miss.push(t);
		}
		if (miss.length === 0) return out;

		const cfg = this.getConfig();
		const providers: Array<"tencent-transmart" | "baidu"> =
			cfg.provider === "baidu" ? ["baidu"] : ["tencent-transmart", "baidu"];
		let remaining = miss;
		for (const prov of providers) {
			if (remaining.length === 0) break;
			let results: Array<string | null>;
			try {
				results = await this.translator.translateTextSegments(remaining, prov);
			} catch (e) {
				logger.warn("[Chinese Plugin Market] 设置页批量翻译失败:", e);
				continue;
			}
			const next: string[] = [];
			results.forEach((r, i) => {
				const src = remaining[i];
				if (src === undefined) return;
				if (r && r.trim() && r !== src) {
					out.set(src, r);
					this.cache.set(src, r);
				} else {
					next.push(src);
				}
			});
			remaining = next;
		}
		this.evict();
		return out;
	}

	/**
	 * HTML 安全翻译（DOM 内联版）：遍历 descEl 的文本节点，只翻译英文文本、
	 * 保留标签与结构，逐节点原地改写 nodeValue（不触碰 innerHTML / outerHTML）。
	 * 逐节点过 shouldSkip（含中文/未启用/黑名单插件跳过），避免重复翻译与 XSS 风险。
	 */
	async translateDescEl(el: HTMLElement): Promise<void> {
		const nodes: Text[] = [];
		const collect = (node: Node): void => {
			node.childNodes.forEach((child) => {
				if (child.nodeType === Node.TEXT_NODE) {
					const v = child.nodeValue;
					if (v !== null && v.trim() !== "") nodes.push(child as Text);
				} else {
					collect(child);
				}
			});
		};
		collect(el);
		if (nodes.length === 0) return;
		const candidates = nodes.map((n) => ({ node: n, text: n.nodeValue as string }));
		const toTranslate = candidates.filter((c) => !this.shouldSkip(c.text));
		if (toTranslate.length === 0) return;
		const uniq = Array.from(new Set(toTranslate.map((c) => c.text)));
		const results = await Promise.all(uniq.map((u) => this.translateText(u)));
		const map = new Map(uniq.map((u, i) => [u, results[i]]));
		for (const c of toTranslate) {
			const tr = map.get(c.text);
			if (tr) c.node.nodeValue = tr;
		}
	}

	private install(): void {
		// 绑定实例方法，避免闭包内使用 self = this（no-this-alias）。
		// 注意 .bind() 在 lib 类型里返回 any，需显式标注类型，否则 .then 回调参数退化为隐式 any。
		const translateText: (text: string) => Promise<string | null> = this.translateText.bind(this);
		const translateDescEl: (el: HTMLElement) => Promise<void> = this.translateDescEl.bind(this);
		const shouldSkip: (text: string) => boolean = this.shouldSkip.bind(this);
		if (!originals) {
			// 保存原型原始方法以便卸载时恢复。此处有意持有方法引用，
			// 调用时通过 .apply(this, ...) 正确绑定组件实例的 this。
			/* eslint-disable @typescript-eslint/unbound-method -- 需保存原型的未绑定方法引用以便卸载时恢复，此处取方法引用属必要 */
			originals = {
				setName: Setting.prototype.setName as unknown as PatchOriginals["setName"],
				setDesc: Setting.prototype.setDesc as unknown as PatchOriginals["setDesc"],
				setButtonText: ButtonComponent.prototype.setButtonText as unknown as PatchOriginals["setButtonText"],
				addOption: DropdownComponent.prototype.addOption as unknown as PatchOriginals["addOption"],
				addOptions: DropdownComponent.prototype.addOptions as unknown as PatchOriginals["addOptions"],
				setPlaceholder: TextComponent.prototype.setPlaceholder as unknown as PatchOriginals["setPlaceholder"],
			};
			/* eslint-enable @typescript-eslint/unbound-method -- 仅上述对象字面量需关闭 unbound-method 检查，恢复默认 */
		}
		const o = originals;

		(Setting.prototype as unknown as { setName: (...a: unknown[]) => unknown }).setName = function (
			this: { nameEl?: HTMLElement },
			name: unknown,
			...rest: unknown[]
		) {
			const ret = o.setName.apply(this, [name, ...rest]);
			if (typeof name !== "string" || shouldSkip(name)) return ret;
			const el = this.nameEl;
			if (el) {
				void translateText(name).then((t) => {
					if (t && el.textContent === name) el.textContent = t;
				});
			}
			return ret;
		};

		(Setting.prototype as unknown as { setDesc: (...a: unknown[]) => unknown }).setDesc = function (
			this: { descEl?: HTMLElement },
			desc: unknown,
			...rest: unknown[]
		) {
			const ret = o.setDesc.apply(this, [desc, ...rest]);
			if (typeof desc !== "string" || shouldSkip(desc)) return ret;
			const el = this.descEl;
			if (el) void translateDescEl(el);
			return ret;
		};

		(ButtonComponent.prototype as unknown as { setButtonText: (...a: unknown[]) => unknown }).setButtonText = function (
			this: { buttonEl?: HTMLElement },
			text: string,
			...rest: unknown[]
		) {
			const ret = o.setButtonText.apply(this, [text, ...rest]);
			if (shouldSkip(text)) return ret;
			const el = this.buttonEl;
			if (el) {
				void translateText(text).then((t) => {
					if (t && el.textContent === text) el.textContent = t;
				});
			}
			return ret;
		};

		(DropdownComponent.prototype as unknown as { addOption: (...a: unknown[]) => unknown }).addOption = function (
			this: { selectEl?: HTMLSelectElement },
			value: string,
			display: string,
			...rest: unknown[]
		) {
			const ret = o.addOption.apply(this, [value, display, ...rest]);
			if (shouldSkip(display)) return ret;
			const sel = this.selectEl;
			if (sel) {
				void translateText(display).then((t) => {
					if (!t) return;
					const opt = Array.from(sel.options).find((op) => op.value === value && op.text === display);
					if (opt) opt.text = t;
				});
			}
			return ret;
		};

		(DropdownComponent.prototype as unknown as { addOptions: (...a: unknown[]) => unknown }).addOptions = function (
			this: { selectEl?: HTMLSelectElement },
			options: Record<string, string>,
			...rest: unknown[]
		) {
			const ret = o.addOptions.apply(this, [options, ...rest]);
			const sel = this.selectEl;
			if (sel) {
				void Promise.all(
					Object.entries(options).map(async ([value, display]) => {
						if (shouldSkip(display)) return;
						const t = await translateText(display);
						if (!t) return;
						const opt = Array.from(sel.options).find((op) => op.value === value && op.text === display);
						if (opt) opt.text = t;
					})
				);
			}
			return ret;
		};

		(TextComponent.prototype as unknown as { setPlaceholder: (...a: unknown[]) => unknown }).setPlaceholder = function (
			this: { inputEl?: HTMLInputElement },
			text: string,
			...rest: unknown[]
		) {
			const ret = o.setPlaceholder.apply(this, [text, ...rest]);
			if (shouldSkip(text)) return ret;
			const el = this.inputEl;
			if (el) {
				void translateText(text).then((t) => {
					if (t && el.placeholder === text) el.placeholder = t;
				});
			}
			return ret;
		};
	}

	private restore(): void {
		if (!originals) return;
		(Setting.prototype as unknown as { setName: unknown }).setName = originals.setName;
		(Setting.prototype as unknown as { setDesc: unknown }).setDesc = originals.setDesc;
		(ButtonComponent.prototype as unknown as { setButtonText: unknown }).setButtonText = originals.setButtonText;
		(DropdownComponent.prototype as unknown as { addOption: unknown }).addOption = originals.addOption;
		(DropdownComponent.prototype as unknown as { addOptions: unknown }).addOptions = originals.addOptions;
		(TextComponent.prototype as unknown as { setPlaceholder: unknown }).setPlaceholder = originals.setPlaceholder;
	}
}
