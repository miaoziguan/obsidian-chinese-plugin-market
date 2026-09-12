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
		const r1 = await (st as unknown as { translateText: (t: string) => Promise<string | null> }).translateText("Enable");
		expect(r1).toBe("启用");
		const r2 = await (st as unknown as { translateText: (t: string) => Promise<string | null> }).translateText("Enable");
		expect(r2).toBe("启用");
		expect(translator.translateTextSegment).toHaveBeenCalledTimes(1);
	});

	it("已是中文则跳过，不调用引擎", async () => {
		const config: SettingsTranslateConfig = { enabled: true, provider: "free", blacklist: [] };
		const { st, translator } = makeSt({}, config);
		const r = await st.translateHtml("已启用");
		expect(r).toBeNull();
		expect(translator.translateTextSegment).not.toHaveBeenCalled();
	});

	it("黑名单插件 ID 跳过翻译", async () => {
		const config: SettingsTranslateConfig = { enabled: true, provider: "free", blacklist: ["foo"] };
		const { st, translator } = makeSt({ Enable: "启用" }, config, "foo");
		const r = await st.translateHtml("Enable");
		expect(r).toBeNull();
		expect(translator.translateTextSegment).not.toHaveBeenCalled();
	});
});

describe("SettingsTranslator.translateHtml", () => {
	it("仅翻译文本节点并保留标签结构", async () => {
		const config: SettingsTranslateConfig = { enabled: true, provider: "free", blacklist: [] };
		const { st } = makeSt({ Enable: "启用", Click: "点击" }, config);
		const html = '<p>Enable</p><a href="x">Click</a>';
		const out = await st.translateHtml(html);
		expect(out).not.toBeNull();
		expect(out).toContain("启用");
		expect(out).toContain("点击");
		expect(out).toContain('<a href="x">');
	});

	it("纯文本走普通串翻译", async () => {
		const config: SettingsTranslateConfig = { enabled: true, provider: "free", blacklist: [] };
		const { st } = makeSt({ Enable: "启用" }, config);
		const out = await st.translateHtml("Enable");
		expect(out).toBe("启用");
	});
});
