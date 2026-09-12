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
 * - HTML 安全：`setDesc` 可能含 <a>/<b> 等标签，只翻文本节点、保留结构。
 * - 安全开关：默认关；按插件 ID 黑名单（个别会回读自身 DOM 文案的插件）；已是中文的串（含 CJK）跳过，
 *   这也顺带避免翻译我们自己的中文设置页。
 */

import {
	Setting,
	ButtonComponent,
	DropdownComponent,
	TextComponent,
	type App,
} from "obsidian";
import type { Translator } from "@domain/catalog/translator";
import { logger } from "@shared/logger";

/** 命中中文（含 CJK 统一表意/扩展A/全角）则视为已翻译，跳过 */
const CJK_RE = /[㐀-䶿一-鿿＀-￯]/;

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
/** 单实例全局守卫：防止 Hot Reload 重复打补丁 */
let originals: PatchOriginals | null = null;
let activeInstance: SettingsTranslator | null = null;

export class SettingsTranslator {
	private translator: Translator;
	private getConfig: () => SettingsTranslateConfig;
	private app: App;
	private cache = new Map<string, string>();
	private pending = new Map<string, Promise<string | null>>();
	private patched = false;

	constructor(app: App, translator: Translator, getConfig: () => SettingsTranslateConfig) {
		this.app = app;
		this.translator = translator;
		this.getConfig = getConfig;
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
	}

	isPatched(): boolean {
		return this.patched;
	}

	enable(): void {
		if (this.patched) return;
		if (activeInstance && activeInstance !== this) activeInstance.disable();
		this.install();
		this.patched = true;
		activeInstance = this;
	}

	disable(): void {
		if (!this.patched) return;
		this.restore();
		this.pending.clear();
		this.patched = false;
		activeInstance = null;
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
			const setting = (this.app as unknown as {
				setting?: { activeTab?: { plugin?: { manifest?: { id?: string } } } };
			}).setting;
			return setting?.activeTab?.plugin?.manifest?.id;
		} catch {
			return undefined;
		}
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
	 * HTML 安全翻译：只翻译文本节点，保留标签结构（setDesc 常含 <a>/<b> 等）。
	 * 纯文本（无标签）走普通串翻译路径。
	 */
	async translateHtml(html: string): Promise<string | null> {
		if (this.shouldSkip(html)) return null;
		if (!html.includes("<")) {
			return this.translateText(html);
		}
		// 按标签切分：偶数索引为文本段（待译），奇数索引为标签（原样保留）。
		// 不使用 DOM 创建，避免触发偏好规则，且对 jsdom/运行时零依赖。
		const parts = html.split(/(<[^>]*>)/g);
		const uniq = Array.from(
			new Set(parts.filter((p, i) => i % 2 === 0 && p.trim() !== "" && !isCjkText(p)))
		);
		if (uniq.length === 0) return html;
		const results = await Promise.all(uniq.map((t) => this.translateText(t)));
		const map = new Map(uniq.map((t, i) => [t, results[i]]));
		for (let i = 0; i < parts.length; i++) {
			if (i % 2 !== 0) continue;
			const text = parts[i];
			if (text.trim() === "" || isCjkText(text)) continue;
			const tr = map.get(text);
			if (tr) parts[i] = tr;
		}
		return parts.join("");
	}

	private install(): void {
		const self = this;
		if (!originals) {
			originals = {
				setName: Setting.prototype.setName as unknown as PatchOriginals["setName"],
				setDesc: Setting.prototype.setDesc as unknown as PatchOriginals["setDesc"],
				setButtonText: ButtonComponent.prototype.setButtonText as unknown as PatchOriginals["setButtonText"],
				addOption: DropdownComponent.prototype.addOption as unknown as PatchOriginals["addOption"],
				addOptions: DropdownComponent.prototype.addOptions as unknown as PatchOriginals["addOptions"],
				setPlaceholder: TextComponent.prototype.setPlaceholder as unknown as PatchOriginals["setPlaceholder"],
			};
		}
		const o = originals;

		(Setting.prototype as unknown as { setName: (...a: unknown[]) => unknown }).setName = function (
			this: { nameEl?: HTMLElement },
			name: unknown,
			...rest: unknown[]
		) {
			const ret = o.setName.apply(this, [name, ...rest]);
			if (typeof name !== "string" || self.shouldSkip(name)) return ret;
			const el = this.nameEl;
			if (el) {
				void self.translateText(name).then((t) => {
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
			if (typeof desc !== "string" || self.shouldSkip(desc)) return ret;
			const el = this.descEl;
			if (el) {
				void self.translateHtml(desc).then((html) => {
					if (html && el.innerHTML === desc) el.innerHTML = html;
				});
			}
			return ret;
		};

		(ButtonComponent.prototype as unknown as { setButtonText: (...a: unknown[]) => unknown }).setButtonText = function (
			this: { buttonEl?: HTMLElement },
			text: string,
			...rest: unknown[]
		) {
			const ret = o.setButtonText.apply(this, [text, ...rest]);
			if (self.shouldSkip(text)) return ret;
			const el = this.buttonEl;
			if (el) {
				void self.translateText(text).then((t) => {
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
			if (self.shouldSkip(display)) return ret;
			const sel = this.selectEl;
			if (sel) {
				void self.translateText(display).then((t) => {
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
						if (self.shouldSkip(display)) return;
						const t = await self.translateText(display);
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
			if (self.shouldSkip(text)) return ret;
			const el = this.inputEl;
			if (el) {
				void self.translateText(text).then((t) => {
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
