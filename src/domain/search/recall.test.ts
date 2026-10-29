import { describe, it, expect } from "vitest";
import { buildVectorIndex, vectorRecallScores, type EmbeddingProvider } from "@semantic/embedding";

describe("向量召回扩容", () => {
	it("从 400 条索引中返回 300 条，保持分数及顺序", async () => {
		const plugins = Array.from({ length: 400 }, (_, i) => ({
			id: `p${i}`,
			name: `plugin ${i}`,
			description: `desc ${i}`,
		}));
		const provider: EmbeddingProvider = {
			name: "recall-cap-test",
			async embed(texts) { return texts.map(() => [1, 0, 0]); },
		};
		const index = await buildVectorIndex(provider, plugins, "m1");
		const scores = await vectorRecallScores(provider, "plugin", index, 300);
		expect(scores!.size).toBe(300);
		expect([...scores!.keys()]).toEqual(plugins.slice(0, 300).map((p) => p.id));
		expect([...scores!.values()].every((score) => score === 1)).toBe(true);
	});
});
