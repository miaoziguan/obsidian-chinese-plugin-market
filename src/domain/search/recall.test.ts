import { describe, it, expect } from "vitest";
import {
	buildVectorIndex,
	vectorRecall,
	type VectorIndex,
} from "@semantic/embedding";
import { mergeRecallIds, localRecall, type RecallCandidate } from "@shared/utils";

/** 内存 mock provider */
	function makeMockProvider(
		map: Record<string, number[]>,
		fallbackDim = 3
	): { name: string; embed: (texts: string[]) => Promise<number[][]>; calls: number } {
		const provider = {
			name: "mock",
			calls: 0,
			async embed(texts: string[]): Promise<number[][]> {
				provider.calls++;
				return texts.map((t) => map[t] ?? new Array(fallbackDim).fill(0));
			},
		};
		return provider as any;
	}

describe("向量召回扩容（产品改进 #4）", () => {
	const plugins: RecallCandidate[] = Array.from({ length: 400 }, (_, i) => ({
		id: `p${i}`,
		name: `plugin ${i}`,
		description: `desc ${i}`,
	}));
	// 构造 400 条确定向量，query 与 p0..p299 同向 → 向量应召回前 300 条
	const vecMap: Record<string, number[]> = {};
	for (let i = 0; i < 400; i++) {
		vecMap[`q`] = [1, 0, 0];
		vecMap[`plugin ${i}`] = [1, 0, 0]; // 全部与 query 同向，看 cap 截断
	}
	// 但 localRecall 仅按字面，query="plugin" 命中全部 400 → 用 keyword 兜底应扩到 200
	it("纯 keyword 模式本地召回扩大到 200（不再截断到 100）", () => {
		const out = localRecall("plugin", plugins, 200);
		expect(out.length).toBe(200);
	});

	it("向量召回上限允许 >100（VECTOR_RECALL_CAP=300 语义）", async () => {
		const provider = makeMockProvider(vecMap);
		const index: VectorIndex = await buildVectorIndex(provider, plugins, "m1");
		// 全部同向 → recall k=300 应返回 300 条（而不是被旧 RECALL_CAP=100 限制）
		const ids = await vectorRecall(provider, "plugin", index, 300);
		expect(ids.length).toBe(300);
	});
});

describe("混合召回并集在扩容后保持去重与向量优先", () => {
	it("向量 300 + 关键词 200，并集去重且向量在前，不爆候选池", () => {
		const vectorIds = Array.from({ length: 300 }, (_, i) => `v${i}`);
		const localIds = Array.from({ length: 200 }, (_, i) => `l${i}`);
		const union = mergeRecallIds(vectorIds, localIds);
		// 无重叠 → 500；实际 aiSearch 会截到 CANDIDATE_POOL_CAP=150
		expect(union.length).toBe(500);
		expect(union[0]).toBe("v0");
		// 截断后向量优先保留
		expect(union.slice(0, 150).every((id) => id.startsWith("v"))).toBe(true);
	});

	it("向量与关键词重叠时去重", () => {
		const union = mergeRecallIds(
			["a", "b", "c"],
			["c", "d", "e"]
		);
		expect(union).toEqual(["a", "b", "c", "d", "e"]);
	});
});
