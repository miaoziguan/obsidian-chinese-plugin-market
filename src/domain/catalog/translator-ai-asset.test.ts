import { describe, it, expect, vi, beforeEach } from "vitest";

const callAITranslateMock = vi.hoisted(() => vi.fn());

// 用桩类替换在线翻译客户端，避免真实网络；callAITranslate 由本测试控制
vi.mock("@translation/api/api", () => {
	class StubClient {
		setEnabled() {}
		setConfig() {}
		updateConfig() {}
		translate() {
			return Promise.resolve(null);
		}
		restoreBlockedDate() {}
		getBlockedDate() {
			return null;
		}
		isBlocked() {
			return false;
		}
		isAvailable() {
			return true;
		}
	}
	return {
		MyMemoryClient: StubClient,
		TencentClient: StubClient,
		GoogleClient: StubClient,
		LLMClient: StubClient,
		callAITranslate: callAITranslateMock,
	};
});

import { Translator, type PluginInfo } from "@domain/catalog/translator";

const mkPlugin = (id: string, name: string, description: string): PluginInfo => ({
	id,
	name,
	description,
	author: "x",
	downloads: 0,
});

describe("Translator 个人 AI 固化资产", () => {
	let t: Translator;
	beforeEach(() => {
		callAITranslateMock.mockReset();
		callAITranslateMock.mockResolvedValue({
			translatedName: "日历中文",
			translatedDesc: "日历描述",
			source: "ai",
		});
		t = new Translator();
		t.setAIConfig({ baseURL: "x", apiKey: "k", model: "m" });
	});

	it("AI 翻译成功后固化进 aiDict；clearCache 不清；二次翻译复用且不重复烧 token", async () => {
		const plugin = mkPlugin("obsidian-calendar", "Calendar", "A calendar.");

		const r1 = await t.translatePlugin(plugin);
		expect(r1.source).toBe("ai");
		expect(r1.translatedName).toBe("日历中文");

		// 已固化进个人 AI 资产
		expect(t.getAIDictSize()).toBe(1);
		expect(t.aiDict["obsidian-calendar"].name).toBe("日历中文");

		// 清缓存不应清掉 AI 资产
		t.clearCache();
		expect(t.getAIDictSize()).toBe(1);

		// 二次翻译：命中固化资产，不再调用在线 AI
		const r2 = await t.translatePlugin(plugin);
		expect(r2.source).toBe("ai");
		expect(callAITranslateMock).toHaveBeenCalledTimes(1);
	});

	it("clearAIDict 可单独清除个人 AI 资产", () => {
		t.aiDict["p1"] = { name: "X", source: "ai" };
		expect(t.getAIDictSize()).toBe(1);
		t.clearAIDict();
		expect(t.getAIDictSize()).toBe(0);
	});

	it("aiDict 随 getData/loadData 持久化与恢复", () => {
		t.aiDict["obsidian-calendar"] = { name: "日历中文", description: "日历描述", source: "ai" };
		const dumped = t.getData();
		const t2 = new Translator();
		t2.loadData({
			aiDict: dumped.aiDict,
			cache: dumped.cache,
		});
		expect(t2.getAIDictSize()).toBe(1);
		expect(t2.aiDict["obsidian-calendar"].name).toBe("日历中文");
	});

	it("aiAutoApprove 开启时，一键翻译结果直接落库（tmApproved + 标记脏，可写 vault 笔记）", async () => {
		const plugin = mkPlugin("obsidian-calendar", "Calendar", "A calendar.");

		await t.translatePlugin(plugin);

		// 直接采纳：进入 tmApproved（approved），无待审队列机制
		expect(t.isTMApproved("obsidian-calendar")).toBe(true);
		expect(t.tmApproved["obsidian-calendar"].status).toBe("approved");
		expect(t.tmApproved["obsidian-calendar"].source).toBe("ai");
		// 标记脏 → flushTranslatorData 时 flushTMVault 会写出 vault 笔记
		expect(t.peekTMDirty()).toContain("obsidian-calendar");
	});

	it("一键翻译结果始终直接落库（无审核队列）", async () => {
		const plugin = mkPlugin("obsidian-calendar", "Calendar", "A calendar.");

		await t.translatePlugin(plugin);

		// 直接采纳：tmApproved 有此条，无待审队列
		expect(t.isTMApproved("obsidian-calendar")).toBe(true);
		expect(t.getTMApprovedCount()).toBe(1);
	});
});
