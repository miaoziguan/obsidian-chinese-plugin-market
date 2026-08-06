import { describe, it, expect, vi, beforeEach } from "vitest";

const callAITranslateMock = vi.hoisted(() => vi.fn());

// 用桩类替换在线翻译客户端，避免真实网络；本测试聚焦 TM 可信层，不触网
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

describe("Translator 翻译记忆库 (TM)", () => {
	let t: Translator;
	beforeEach(() => {
		callAITranslateMock.mockReset();
		t = new Translator();
	});

	it("AI 固化后直接落库为 approved（无需审核队列）", async () => {
		// solidifyAI 经类型转换调用（私有方法）
		(t as unknown as { solidifyAI: (id: string, r: unknown) => void }).solidifyAI(
			"p2",
			{ translatedName: "AI名", translatedDesc: "AI描述", source: "ai" }
		);
		expect(t.isTMApproved("p2")).toBe(true);
		expect(t.tmApproved["p2"].status).toBe("approved");
		expect(t.tmApproved["p2"].source).toBe("ai");
		// 翻译命中 tmApproved（source 映射 ai）
		const r = await t.translatePlugin(mkPlugin("p2", "Plugin2", "desc2"));
		expect(r.source).toBe("ai");
		expect(r.translatedName).toBe("AI名");
	});

	it("翻译命中优先读 tmApproved（human 覆盖 aiDict 固化资产）", async () => {
		t.aiDict["p3"] = { name: "固化名", description: "固化描述", source: "ai" };
		// 人工校正译文 → 进入 tmApproved（custom，权威最高）
		t.tmApproved["p3"] = {
			id: "p3", name: "手编名", description: "手编描述",
			source: "human", status: "approved", confidence: 1, created: 0, promoted: 0,
		};
		const r = await t.translatePlugin(mkPlugin("p3", "Plugin3", "desc3"));
		expect(r.translatedName).toBe("手编名");
		expect(r.source).toBe("custom");
	});

	it("translateBatch 命中 tmApproved 直接出结果（不触网）", async () => {
		t.tmApproved["p4"] = {
			id: "p4", name: "批译名", description: "批译描述",
			source: "human", status: "approved", confidence: 1, created: 0, promoted: 0,
		};
		const out = await t.translateBatch([mkPlugin("p4", "Plugin4", "desc4")]);
		expect(out["p4"].translatedName).toBe("批译名");
		expect(out["p4"].source).toBe("custom");
	});

	it("online 来源（Google/MyMemory/腾讯）直接 approved 落库", () => {
		// 模拟 Google 翻译成功后 cache 中 source=online，调用 enqueueOnlineTM
		(t as unknown as { cache: Record<string, { source: string; provider?: string; translatedName: string; translatedDesc: string }> }).cache["g1"] = {
			source: "online",
			provider: "google",
			translatedName: "谷歌名",
			translatedDesc: "谷歌描述",
		};
		t.enqueueOnlineTM("g1");
		expect(t.isTMApproved("g1")).toBe(true);
		expect(t.tmApproved["g1"].source).toBe("online");
		expect(t.tmApproved["g1"].status).toBe("approved");
		expect(t.takeTMDirty()).toEqual(["g1"]);
	});

	it("online 来源始终直接落库为 approved（无待审队列）", () => {
		(t as unknown as { cache: Record<string, { source: string; provider?: string; translatedName: string; translatedDesc: string }> }).cache["g2"] = {
			source: "online",
			provider: "mymemory",
			translatedName: "社区名",
			translatedDesc: "社区描述",
		};
		t.enqueueOnlineTM("g2");
		expect(t.isTMApproved("g2")).toBe(true);
		expect(t.tmApproved["g2"].status).toBe("approved");
		expect(t.tmApproved["g2"].source).toBe("online");
	});
});
