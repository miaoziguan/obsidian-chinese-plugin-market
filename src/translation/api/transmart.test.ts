import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { setHttpClient, resetHttpClient } from "@data/net/http-port";
import { TransmartClient } from "@translation/api/transmart";
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
});
