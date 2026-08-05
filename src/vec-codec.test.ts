import { describe, it, expect } from "vitest";
import { encodeVectorIndex, decodeVectorIndex, VectorCodecError } from "./vec-codec";
import type { VectorIndex } from "./embedding";

describe("vec-codec · int8 量化 + 二进制编解码", () => {
	const makeIndex = (): VectorIndex => ({
		ids: ["a", "b", "c"],
		vectors: [
			[1.0, 0.0, -1.0],
			[0.5, 0.5, 0.0],
			[-0.8, 0.3, 0.9],
		],
		hash: "abc123",
		model: "text-embedding-3-small",
		categorySchemaVersion: "v7",
	});

	it("往返编码解码后 id/hash/model/schema 完整保留", () => {
		const idx = makeIndex();
		const decoded = decodeVectorIndex(encodeVectorIndex(idx));
		expect(decoded.ids).toEqual(idx.ids);
		expect(decoded.hash).toBe(idx.hash);
		expect(decoded.model).toBe(idx.model);
		expect(decoded.categorySchemaVersion).toBe(idx.categorySchemaVersion);
	});

	it("向量反量化后与原始相近（int8 量化误差可控），且相对序保持", () => {
		const idx = makeIndex();
		const decoded = decodeVectorIndex(encodeVectorIndex(idx));
		expect(decoded.vectors.length).toBe(3);
		// 每行维度一致
		for (const v of decoded.vectors) expect(v.length).toBe(3);
		// 相对大小关系（决定 topK 召回正确性）应当保持：第 1 行 [1,0,-1] 的首维最大
		expect(decoded.vectors[0][0]).toBeGreaterThan(decoded.vectors[0][1]);
		expect(decoded.vectors[0][0]).toBeGreaterThan(decoded.vectors[0][2]);
		// 量化误差应在合理范围内（int8 → 误差 < range/127）
		expect(Math.abs(decoded.vectors[0][0] - 1.0)).toBeLessThan(0.1);
	});

	it("空向量索引可往返", () => {
		const idx: VectorIndex = { ids: [], vectors: [], hash: "", model: "m" };
		const decoded = decodeVectorIndex(encodeVectorIndex(idx));
		expect(decoded.ids).toEqual([]);
		expect(decoded.vectors).toEqual([]);
	});

	it("无 categorySchemaVersion 时往返为 undefined", () => {
		const idx: VectorIndex = { ids: ["x"], vectors: [[0.1, 0.2]], hash: "h", model: "m" };
		const decoded = decodeVectorIndex(encodeVectorIndex(idx));
		expect(decoded.categorySchemaVersion).toBeUndefined();
	});

	it("坏数据抛 VectorCodecError", () => {
		expect(() => decodeVectorIndex(new ArrayBuffer(4))).toThrow(VectorCodecError);
	});
});
