import { describe, it, expect, vi } from "vitest";
import { SettingsTranslator, isCjkText, type SettingsTranslateConfig } from "./settings-translator";
import type { Translator } from "@domain/catalog/translator";

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
