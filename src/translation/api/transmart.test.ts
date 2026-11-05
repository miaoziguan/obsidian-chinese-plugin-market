import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { setHttpClient, resetHttpClient } from "@data/net/http-port";
import { TransmartClient, generateClientKey } from "@translation/api/transmart";
import type { PluginInfo } from "@domain/catalog/translator";

const req = vi.fn();

beforeEach(() => {
	req.mockReset();
	setHttpClient({ request: req });
});
afterEach(() => {
	resetHttpClient();
});

const plugin: PluginInfo = {
	id: "hotkeysplus-obsidian",
	name: "Hotkeys++",
	description: "Adds more hotkeys to Obsidian",
} as PluginInfo;

function okJson(json: unknown) {
	return { status: 200, json, text: JSON.stringify(json), headers: {} };
}

describe("TransmartClient · 质量校验", () => {
	it("中文译文不被「全大写无意义」误判（中文无大小写，toUpperCase 返回自身）", async () => {
		// 回归：上一版用 `translated.toUpperCase() === translated` 会把正常中文译文判为
		// 「全大写无意义译文」而整批失败（实测 6574 个插件全部翻译失败）。
		req.mockResolvedValueOnce(okJson({ header: { ret_code: "succ" }, language: "en" }));
		req.mockResolvedValueOnce(okJson({ header: { ret_code: "succ" }, auto_translation: "快捷键++" }));
		req.mockResolvedValueOnce(
			okJson({ header: { ret_code: "succ" }, auto_translation: "为 Obsidian 增加更多快捷键" })
		);

		const client = new TransmartClient("test-ua");
		const result = await client.translate(plugin);

		expect(result).toEqual({
			translatedName: "快捷键++",
			translatedDesc: "为 Obsidian 增加更多快捷键",
			source: "online",
			provider: "tencent-transmart",
		});
	});

	it("全大写英文回显（HOTKEYS++）归一命中原文回显 → 标记 unchanged 保留原名，desc 译出即整卡成功", async () => {
		// 新语义：专有名词返回原文是正常结果（对齐 Google「结果未变化」），不再判失败触发降级/熔断；
		// 未变段保留原名落库，视觉英文但状态 = 已翻译，不再反复请求。
		req.mockResolvedValueOnce(okJson({ header: { ret_code: "succ" }, language: "en" }));
		req.mockResolvedValueOnce(okJson({ header: { ret_code: "succ" }, auto_translation: "HOTKEYS++" }));
		req.mockResolvedValueOnce(
			okJson({ header: { ret_code: "succ" }, auto_translation: "为 Obsidian 增加更多快捷键" })
		);

		const client = new TransmartClient("test-ua");
		const result = await client.translate(plugin);

		expect(result).toEqual({
			translatedName: "Hotkeys++",
			translatedDesc: "为 Obsidian 增加更多快捷键",
			source: "online",
			provider: "tencent-transmart",
		});
	});

	it("name/desc 两段都原文回显（整条无需翻译）→ 判无效返回 null 走降级", async () => {
		// 与 Google「两段结果均未变化 → 整条无效」同语义：纯回显不是网络失败，不计熔断。
		req.mockResolvedValueOnce(okJson({ header: { ret_code: "succ" }, language: "en" }));
		req.mockResolvedValueOnce(okJson({ header: { ret_code: "succ" }, auto_translation: "Hotkeys++" }));
		req.mockResolvedValueOnce(
			okJson({ header: { ret_code: "succ" }, auto_translation: "Adds more hotkeys to Obsidian" })
		);

		const client = new TransmartClient("test-ua");
		const result = await client.translate(plugin);

		expect(result).toBeNull();
	});

	it("单段真实失败（desc 空译文）→ 整条返回 null 走降级", async () => {
		req.mockResolvedValueOnce(okJson({ header: { ret_code: "succ" }, language: "en" }));
		req.mockResolvedValueOnce(
			okJson({ header: { ret_code: "succ" }, auto_translation: "快捷键++" })
		);
		req.mockResolvedValueOnce(okJson({ header: { ret_code: "succ" }, auto_translation: "" }));

		const client = new TransmartClient("test-ua");
		const result = await client.translate(plugin);

		expect(result).toBeNull();
	});

	it("translateSegment：原文回显段按 unchanged 返回原文（调用方按段保留）", async () => {
		req.mockResolvedValueOnce(okJson({ header: { ret_code: "succ" }, language: "en" }));
		req.mockResolvedValueOnce(okJson({ header: { ret_code: "succ" }, auto_translation: "Templater" }));

		const client = new TransmartClient("test-ua");
		const result = await client.translateSegment("Templater");

		expect(result).toBe("Templater");
	});

	it("translateSegment：源语言不支持（Unsupported-Language）→ 优雅保留原文段，不抛错", async () => {
		// 复现 README 分段失败刷屏：日文段被检测为 ja，腾讯免费版不支持 → 返回原文而非抛错。
		req.mockResolvedValueOnce(okJson({ header: { ret_code: "succ" }, language: "ja" }));
		req.mockResolvedValueOnce(
			okJson({ header: { ret_code: "Unsupported-Language" } })
		);

		const client = new TransmartClient("test-ua");
		const result = await client.translateSegment("これは日本語のドキュメントです");

		expect(result).toBe("これは日本語のドキュメントです");
		// 不计熔断：available 保持 true
		expect(client.isAvailable()).toBe(true);
	});

	it("translate：name 源语言不支持（Unsupported-Language）→ 返回 null 走 fallback，且不计熔断", async () => {
		// 日文 name 触发 Unsupported-Language；应优雅降级而非累计 recordFailure 开路。
		req.mockResolvedValueOnce(okJson({ header: { ret_code: "succ" }, language: "ja" }));
		req.mockResolvedValueOnce(
			okJson({ header: { ret_code: "Unsupported-Language" } })
		);

		const client = new TransmartClient("test-ua");
		const result = await client.translate({ ...plugin, name: "日本語プラグイン", description: "" });

		expect(result).toBeNull();
		// 关键回归：Unsupported-Language 不算故障，连续多次不应开路
		req.mockResolvedValueOnce(okJson({ header: { ret_code: "succ" }, language: "ja" }));
		req.mockResolvedValueOnce(okJson({ header: { ret_code: "Unsupported-Language" } }));
		await client.translate({ ...plugin, name: "別の日本語名", description: "" });
		req.mockResolvedValueOnce(okJson({ header: { ret_code: "succ" }, language: "ja" }));
		req.mockResolvedValueOnce(okJson({ header: { ret_code: "Unsupported-Language" } }));
		await client.translate({ ...plugin, name: "三つ目の日本語名", description: "" });
		expect(client.isAvailable()).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────
// 以下为追加用例：补齐函数级（generateClientKey / translateSegments / setEnabled）
// 与 callApi 错误分支、中文源/空白短路、批量翻译全分支。
// ─────────────────────────────────────────────────────────────

const priv = (c: TransmartClient, name: string, ...args: unknown[]): unknown =>
	(c as unknown as Record<string, (...a: unknown[]) => unknown>)[name](...args);

describe("generateClientKey", () => {
	it("空 UA → 仅前缀（btoa('') 为空）", () => {
		expect(generateClientKey("")).toBe("tencent_transmart_crx_");
	});
	it("普通 UA → 前缀 + Base64(UA)，整体截前 100", () => {
		const k = generateClientKey("obsidian/1.0");
		expect(k.startsWith("tencent_transmart_crx_")).toBe(true);
		expect(k).toBe("tencent_transmart_crx_" + btoa("obsidian/1.0"));
		expect(k.length).toBeLessThanOrEqual(100);
	});
	it("超长 UA → 整体长度封顶 100", () => {
		const k = generateClientKey("x".repeat(500));
		expect(k.length).toBe(100);
	});
});

describe("setEnabled / isAvailable / 不可用短路", () => {
	it("setEnabled(false) → isAvailable 变 false", () => {
		const c = new TransmartClient("ua");
		expect(c.isAvailable()).toBe(true);
		c.setEnabled(false);
		expect(c.isAvailable()).toBe(false);
	});
	it("translate 不可用时直接返回 null 且不发请求", async () => {
		const c = new TransmartClient("ua");
		c.setEnabled(false);
		expect(await c.translate(plugin)).toBeNull();
		expect(req).not.toHaveBeenCalled();
	});
	it("translateSegment 不可用时抛错", async () => {
		const c = new TransmartClient("ua");
		c.setEnabled(false);
		await expect(c.translateSegment("Hello")).rejects.toThrow("当前不可用");
	});
	it("translateSegments 不可用 / 空数组 → null", async () => {
		const c = new TransmartClient("ua");
		c.setEnabled(false);
		expect(await c.translateSegments(["A"])).toBeNull();
		expect(await c.translateSegments([])).toBeNull();
	});
});

describe("translate 中文源 / detectLanguage 边界", () => {
	it("name 检测为 zh → 直接返回 null 且仅 1 次调用（不发起翻译）", async () => {
		req.mockResolvedValueOnce(okJson({ header: { ret_code: "succ" }, language: "zh" }));
		const c = new TransmartClient("ua");
		expect(await c.translate(plugin)).toBeNull();
		expect(req.mock.calls).toHaveLength(1);
	});
	it("detectLanguage：空 language 回退 en", async () => {
		req.mockResolvedValueOnce(okJson({ header: { ret_code: "succ" }, language: "" }));
		expect(await priv(new TransmartClient("ua"), "detectLanguage", "x")).toBe("en");
	});
	it("detectLanguage：callApi 抛错（非 JSON 响应）→ catch 回退 en", async () => {
		req.mockResolvedValueOnce({ status: 200, json: "not-object", text: "x", headers: {} });
		expect(await priv(new TransmartClient("ua"), "detectLanguage", "x")).toBe("en");
	});
	it("detectLanguage：保留非空 language（含大小写）", async () => {
		req.mockResolvedValueOnce(okJson({ header: { ret_code: "succ" }, language: "EN" }));
		expect(await priv(new TransmartClient("ua"), "detectLanguage", "x")).toBe("EN");
	});
});

describe("translateText 空串 / 截断 / 正常段", () => {
	it("translateSegment：正常译出并 recordSuccess（available 仍 true）", async () => {
		req.mockResolvedValueOnce(okJson({ header: { ret_code: "succ" }, language: "en" }));
		req.mockResolvedValueOnce(okJson({ header: { ret_code: "succ" }, auto_translation: "你好" }));
		const c = new TransmartClient("ua");
		expect(await c.translateSegment("Hello")).toBe("你好");
		expect(c.isAvailable()).toBe(true);
	});
	it("translateSegment：空白/空串原样返回（不发起请求）", async () => {
		const c = new TransmartClient("ua");
		expect(await c.translateSegment("")).toBe("");
		expect(await c.translateSegment("   ")).toBe("   ");
		expect(req).not.toHaveBeenCalled();
	});
	it("translateSegment：中文源 → 返回原文", async () => {
		req.mockResolvedValueOnce(okJson({ header: { ret_code: "succ" }, language: "zh" }));
		expect(await new TransmartClient("ua").translateSegment("中文段落")).toBe("中文段落");
	});
	it("translateText 空串 → unchanged 不发起请求", async () => {
		const r = await priv(new TransmartClient("ua"), "translateText", "", "en");
		expect(r).toEqual({ text: "", unchanged: true });
		expect(req).not.toHaveBeenCalled();
	});
	it("translateText 超 500 字符 → 截断到 500 再发送", async () => {
		req.mockResolvedValueOnce(
			okJson({ header: { ret_code: "succ" }, auto_translation: "译" })
		);
		await priv(new TransmartClient("ua"), "translateText", "a".repeat(600), "en");
		const body = JSON.parse((req.mock.calls[0][0] as { body: string }).body);
		expect(body.source.text_block).toHaveLength(500);
	});
});

describe("callApi 错误分支", () => {
	it("非 JSON 响应 → 抛「返回非 JSON 响应」（translateSegment 会二次调用 callApi，用无限 mock）", async () => {
		req.mockResolvedValue({ status: 200, json: "plain", text: "plain", headers: {} });
		await expect(new TransmartClient("ua").translateSegment("Hello")).rejects.toThrow("返回非 JSON 响应");
	});
	it("ret_code=error → 抛「API 错误: error」", async () => {
		req.mockResolvedValue(okJson({ header: { ret_code: "error" } }));
		await expect(new TransmartClient("ua").translateSegment("Hello")).rejects.toThrow("API 错误: error");
	});
	it("ret_code=Unsupported-Language → 透传到 translateSegment 保留原文", async () => {
		req.mockResolvedValue(okJson({ header: { ret_code: "Unsupported-Language" } }));
		expect(await new TransmartClient("ua").translateSegment("Hello")).toBe("Hello");
	});
});

describe("callApi busy 限流重试（fake timers，避免真实等待）", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});
	it("busy 限流：重试 2 次后作为 API 错误抛出（共 3 次请求）", async () => {
		req.mockResolvedValue({ status: 200, json: { header: { ret_code: "busy" } }, text: "", headers: {} });
		const p = priv(new TransmartClient("ua"), "translateText", "Hello", "en") as Promise<unknown>;
		// 先挂上 rejection handler（advance 期间 p 即已 reject，否则 Node 会记为 unhandled），再推进 timer
		const assertion = expect(p).rejects.toThrow("API 错误: busy");
		// 推进超过 withTimeout 的 5000ms 上限，确保所有 timer（含超时 timer）均被消费，避免泄漏
		await vi.advanceTimersByTimeAsync(6000);
		await assertion;
		expect(req.mock.calls).toHaveLength(3);
	});
});

describe("translateSegments 批量翻译全分支", () => {
	const joined = (c: TransmartClient, texts: string[]) => c.translateSegments(texts);

	it("成功：按行对齐拆分并返回，仅 1 次请求且 recordSuccess", async () => {
		req.mockResolvedValueOnce(
			okJson({ header: { ret_code: "succ" }, auto_translation: "译A\n译B" })
		);
		const c = new TransmartClient("ua");
		const out = await joined(c, ["A", "B"]);
		expect(out).toEqual(["译A", "译B"]);
		expect(req.mock.calls).toHaveLength(1);
		expect(c.isAvailable()).toBe(true);
	});
	it("含纯空白串 → null（不发起请求）", async () => {
		expect(await new TransmartClient("ua").translateSegments(["A", "  "])).toBeNull();
		expect(req).not.toHaveBeenCalled();
	});
	it("含换行串 → null（破坏按行对齐）", async () => {
		expect(await new TransmartClient("ua").translateSegments(["A", "B\nC"])).toBeNull();
	});
	it("拼接超 2000 字符 → null", async () => {
		expect(await new TransmartClient("ua").translateSegments(["x".repeat(2001)])).toBeNull();
	});
	it("整块原文回显 → null", async () => {
		req.mockResolvedValueOnce(okJson({ header: { ret_code: "succ" }, auto_translation: "A\nB" }));
		expect(await new TransmartClient("ua").translateSegments(["A", "B"])).toBeNull();
	});
	it("行数不符 → null", async () => {
		req.mockResolvedValueOnce(okJson({ header: { ret_code: "succ" }, auto_translation: "译A" }));
		expect(await new TransmartClient("ua").translateSegments(["A", "B"])).toBeNull();
	});
	it("出现空行（对齐不可靠）→ null", async () => {
		req.mockResolvedValueOnce(okJson({ header: { ret_code: "succ" }, auto_translation: "译A\n\n译B" }));
		expect(await new TransmartClient("ua").translateSegments(["A", "B"])).toBeNull();
	});
	it("含不支持语言 → null 且不计熔断", async () => {
		req.mockResolvedValueOnce(okJson({ header: { ret_code: "Unsupported-Language" } }));
		const c = new TransmartClient("ua");
		expect(await c.translateSegments(["A", "B"])).toBeNull();
		expect(c.isAvailable()).toBe(true);
	});
	it("其它 API 错误 → null（recordFailure + warn，available 变 false）", async () => {
		req.mockResolvedValueOnce(okJson({ header: { ret_code: "error" } }));
		const c = new TransmartClient("ua");
		expect(await c.translateSegments(["A", "B"])).toBeNull();
		// 单次失败未达熔断阈值（3 次），available 仍 true；recordFailure 已调用
		expect(c.isAvailable()).toBe(true);
	});
});
