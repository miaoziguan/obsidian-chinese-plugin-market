import { describe, it, expect, vi } from "vitest";
import {
	buildVectorIndex,
	vectorRecall,
	LocalEmbeddingProvider,
	DEFAULT_LOCAL_MODEL,
	type EmbeddingProvider,
	type VectorIndex,
	type LocalModelBackend,
} from "@semantic/embedding";
import { Translator } from "@domain/catalog/translator";

/** 可注入的 FakeBackend：记录调用、可模拟失败，无需真实下载模型。 */
function makeFakeBackend(opts?: {
	throwOnEmbed?: boolean;
	dim?: number;
}): LocalModelBackend & { calls: number[] } {
	const dim = opts?.dim ?? 3;
	return {
		name: "fake",
		calls: 0 as unknown as number[],
		async embed(texts: string[]): Promise<number[][]> {
			this.calls++;
			if (opts?.throwOnEmbed) throw new Error("backend boom");
			// 确定性的伪向量：每个字符码值映射到坐标，便于断言顺序
			return texts.map((t, i) => [
				((t.length + i) % dim) / dim,
				1 - ((t.length + i) % dim) / dim,
				0.5,
			]);
		},
	};
}

/** 内存 mock provider：把文本映射成确定性向量，避免真实网络调用。 */
function makeMockProvider(
	map: Record<string, number[]>,
	fallbackDim = 3
): EmbeddingProvider & { calls: number } {
	const provider = {
		name: "mock",
		calls: 0,
		async embed(texts: string[]): Promise<number[][]> {
			this.calls++;
			return texts.map(
				(t) => map[t] ?? new Array(fallbackDim).fill(0)
			);
		},
	};
	return provider;
}

	const plugins = [
	{ id: "sync", name: "Sync", description: "keep notes in sync across devices" },
	{ id: "theme", name: "Theme", description: "beautiful color themes" },
	{ id: "kanban", name: "Kanban", description: "task board" },
];

describe("buildVectorIndex", () => {
	it("首次构建：调用 provider.embed 并返回 ids/vectors/hash/model", async () => {
		const provider = makeMockProvider({});
		const idx = await buildVectorIndex(provider, plugins, "m1");
		expect(idx.ids).toEqual(["sync", "theme", "kanban"]);
		expect(idx.vectors.length).toBe(3);
		expect(idx.model).toBe("m1");
		expect(typeof idx.hash).toBe("string");
		expect(provider.calls).toBe(1);
	});

	it("内容 + 模型未变：复用 prevIndex，不再调用 embed", async () => {
		const provider = makeMockProvider({});
		const first = await buildVectorIndex(provider, plugins, "m1");
		const second = await buildVectorIndex(provider, plugins, "m1", first);
		expect(second).toBe(first);
		expect(provider.calls).toBe(1); // 未新增调用
	});

	it("模型变化：即使内容相同也重建", async () => {
		const provider = makeMockProvider({});
		const first = await buildVectorIndex(provider, plugins, "m1");
		const second = await buildVectorIndex(provider, plugins, "m2", first);
		expect(second).not.toBe(first);
		expect(second.model).toBe("m2");
		expect(provider.calls).toBe(2);
	});

	it("内容变化：重建", async () => {
		const provider = makeMockProvider({});
		const first = await buildVectorIndex(provider, plugins, "m1");
		const changed = [...plugins, { id: "new", name: "New", description: "x" }];
		const second = await buildVectorIndex(provider, changed, "m1", first);
		expect(second).not.toBe(first);
		expect(second.ids).toContain("new");
		expect(provider.calls).toBe(2);
	});
});

describe("buildVectorIndex · 用法 A：分类维度注入（召回信号）", () => {
	const tagged = [
		{ id: "sync", name: "Sync", description: "keep notes in sync", category: "同步与备份", tags: ["同步", "云盘"] },
		{ id: "theme", name: "Theme", description: "color themes", category: "外观与主题", tags: ["美化"] },
		{ id: "kanban", name: "Kanban", description: "task board", category: "任务与项目", tags: ["看板"] },
	];

	it("category 作为强锚点放在句首，tags 尾随（文本含「分类：」与「标签：」）", async () => {
		const captured: string[] = [];
		const provider: EmbeddingProvider = {
			name: "cap",
			async embed(texts) {
				captured.push(...texts);
				return texts.map(() => [0, 0, 0]);
			},
		};
		await buildVectorIndex(provider, tagged, "m1");
		expect(captured[0]).toContain("分类：同步与备份");
		expect(captured[0]).toContain("标签：同步 云盘");
		// 句首应为「分类：」前缀（强锚点先于 name/description）
		expect(captured[0].startsWith("分类：同步与备份")).toBe(true);
	});

	it("无 category/tags 时退化为旧格式（仅 name + description），向后兼容", async () => {
		const captured: string[] = [];
		const provider: EmbeddingProvider = {
			name: "cap",
			async embed(texts) {
				captured.push(...texts);
				return texts.map(() => [0, 0, 0]);
			},
		};
		await buildVectorIndex(provider, plugins, "m1");
		expect(captured[0]).toBe("Sync\nkeep notes in sync across devices");
		expect(captured[0]).not.toContain("分类：");
		expect(captured[0]).not.toContain("标签：");
	});

	it("categorySchemaVersion 变化 → 即使 texts/hash/category 文本相同也强制重建", async () => {
		const provider = makeMockProvider({});
		const first = await buildVectorIndex(provider, tagged, "m1", undefined, "v1");
		// 相同 plugins + 相同版本 → 复用
		const second = await buildVectorIndex(provider, tagged, "m1", first, "v1");
		expect(second).toBe(first);
		expect(provider.calls).toBe(1);
		// 版本号变化 → 强制重建（护栏：分类体系大改但文本指纹巧合相同）
		const third = await buildVectorIndex(provider, tagged, "m1", first, "v2");
		expect(third).not.toBe(first);
		expect(third.categorySchemaVersion).toBe("v2");
		expect(provider.calls).toBe(2);
	});

	it("返回的索引记录 categorySchemaVersion 字段", async () => {
		const provider = makeMockProvider({});
		const idx = await buildVectorIndex(provider, tagged, "m1", undefined, "v3");
		expect(idx.categorySchemaVersion).toBe("v3");
	});

	it("分类体系版本号缺失（undefined）时也能正常构建与复用", async () => {
		const provider = makeMockProvider({});
		const first = await buildVectorIndex(provider, tagged, "m1");
		const second = await buildVectorIndex(provider, tagged, "m1", first);
		expect(second).toBe(first);
		expect(second.categorySchemaVersion).toBeUndefined();
	});
});

describe("vectorRecall", () => {
	const index: VectorIndex = {
		ids: ["sync", "theme", "kanban"],
		vectors: [
			[1, 0, 0], // sync
			[0, 1, 0], // theme
			[0, 0, 1], // kanban
		],
		hash: "h",
		model: "m1",
	};

	it("query 向量与 sync 同向 → sync 排第一", async () => {
		const provider = makeMockProvider({ "同步": [1, 0, 0] });
		const out = await vectorRecall(provider, "同步", index, 2);
		expect(out[0]).toBe("sync");
		expect(out.length).toBe(2);
	});

	it("query 向量与 theme 同向 → theme 排第一", async () => {
		const provider = makeMockProvider({ q: [0, 1, 0] });
		const out = await vectorRecall(provider, "q", index, 1);
		expect(out).toEqual(["theme"]);
	});

	it("空索引返回空", async () => {
		const provider = makeMockProvider({ q: [1, 0, 0] });
		const empty: VectorIndex = { ids: [], vectors: [], hash: "", model: "m1" };
		expect(await vectorRecall(provider, "q", empty, 5)).toEqual([]);
	});

	it("query 向量为空返回空", async () => {
		const provider = makeMockProvider({ q: [] });
		expect(await vectorRecall(provider, "q", index, 5)).toEqual([]);
	});
});

describe("provider embed 失败应向上抛（供上层降级）", () => {
	it("embed 抛错时 vectorRecall 抛错", async () => {
		const provider: EmbeddingProvider = {
			name: "fail",
			embed: vi.fn().mockRejectedValue(new Error("network down")),
		};
		const index: VectorIndex = {
			ids: ["a"],
			vectors: [[1, 0]],
			hash: "h",
			model: "m1",
		};
		await expect(vectorRecall(provider, "q", index, 1)).rejects.toThrow(
			"network down"
		);
	});
});

describe("LocalEmbeddingProvider（阶段 2.5）", () => {
	it("空输入直接返回空数组，不触碰 backend", async () => {
		const backend = makeFakeBackend();
		const p = new LocalEmbeddingProvider(backend, "m", "wasm");
		expect(await p.embed([])).toEqual([]);
		expect(backend.calls).toBe(0);
	});

	it("透传 model/wasmPaths 给默认后端（构造校验）", () => {
		const p = new LocalEmbeddingProvider(undefined, "Xenova/foo", "http://w/");
		expect(p.name).toBe("local");
		// 默认后端应为 WorkerLocalBackend（worker 内跑 transformers），且携带传入的 model/wasm
		expect((p as any).backend.name).toContain("worker");
		expect((p as any).backend.cfg.model).toBe("Xenova/foo");
		expect((p as any).backend.cfg.wasmPaths).toBe("http://w/");
	});

	it("不超过 BATCH(32) 时一次调用 backend", async () => {
		const backend = makeFakeBackend();
		const p = new LocalEmbeddingProvider(backend);
		const texts = Array.from({ length: 5 }, (_, i) => `t${i}`);
		const out = await p.embed(texts);
		expect(backend.calls).toBe(1);
		expect(out.length).toBe(5);
		expect(out[0].length).toBe(3);
	});

	it("超过 BATCH(32) 时按 32 切片多次调用", async () => {
		const backend = makeFakeBackend();
		const p = new LocalEmbeddingProvider(backend);
		const texts = Array.from({ length: 70 }, (_, i) => `t${i}`);
		const out = await p.embed(texts);
		expect(backend.calls).toBe(3); // 32 + 32 + 6
		expect(out.length).toBe(70);
	});

	it("backend 抛错向上抛出（由上层降级到关键词）", async () => {
		const backend = makeFakeBackend({ throwOnEmbed: true });
		const p = new LocalEmbeddingProvider(backend);
		await expect(p.embed(["a"])).rejects.toThrow("backend boom");
	});
});

describe("本地 embedding 默认模型", () => {
	it("DEFAULT_LOCAL_MODEL 为面向中文的 bge-small-zh", () => {
		expect(DEFAULT_LOCAL_MODEL).toBe("Xenova/bge-small-zh-v1.5");
	});
});

describe("向量索引落盘往返（Translator 层）", () => {
	const sampleIndex: VectorIndex = {
		ids: ["sync", "theme", "kanban"],
		vectors: [
			[0.1, 0.2, 0.3],
			[0.4, 0.5, 0.6],
			[0.7, 0.8, 0.9],
		],
		hash: "abc123",
		model: "Xenova/all-MiniLM-L6-v2",
	};

	it("setVectorIndex 后 getVectorIndex 原样返回（模拟落盘前的内存态）", () => {
		const t = new Translator();
		expect(t.getVectorIndex()).toBeNull();
		t.setVectorIndex(sampleIndex);
		const got = t.getVectorIndex();
		expect(got).not.toBeNull();
		expect(got!.ids).toEqual(["sync", "theme", "kanban"]);
		expect(got!.vectors[1]).toEqual([0.4, 0.5, 0.6]);
		expect(got!.model).toBe("Xenova/all-MiniLM-L6-v2");
	});

	it("JSON 序列化往返不丢精度（模拟写盘→读盘）", () => {
		const t = new Translator();
		t.setVectorIndex(sampleIndex);
		// 模拟 main.ts 的 saveVectorIndex → loadVectorIndex 的 JSON 往返
		const roundTrip: VectorIndex = JSON.parse(
			JSON.stringify(t.getVectorIndex())
		);
		expect(roundTrip.ids).toEqual(sampleIndex.ids);
		expect(roundTrip.vectors).toEqual(sampleIndex.vectors);
		expect(roundTrip.hash).toBe("abc123");
		expect(roundTrip.model).toBe(sampleIndex.model);
	});

	it("落盘往返后可作为 prevIndex 复用（内容未变 → 零 embed）", async () => {
		// 先用 provider 真实构建一次，得到与 plugins 内容一致的 index（hash 匹配）
		const plugins = [
			{ id: "sync", name: "Sync", description: "keep notes in sync across devices" },
			{ id: "theme", name: "Theme", description: "beautiful color themes" },
			{ id: "kanban", name: "Kanban", description: "task board" },
		];
		const providerA = makeFakeBackend();
		const built = await buildVectorIndex(providerA, plugins, "m1");
		// 模拟落盘 → 读盘
		const roundTrip: VectorIndex = JSON.parse(JSON.stringify(built));
		const t = new Translator();
		t.setVectorIndex(roundTrip);

		// 第二次用同一批 plugins + 落盘 index：应直接复用，不再调用 embed
		const providerB = makeFakeBackend();
		const reused = await buildVectorIndex(providerB, plugins, "m1", t.getVectorIndex()!);
		expect(reused).toBe(roundTrip);
		expect(providerB.calls).toBe(0);
	});

	it("setVectorIndex(null) 清空索引", () => {
		const t = new Translator();
		t.setVectorIndex(sampleIndex);
		t.setVectorIndex(null);
		expect(t.getVectorIndex()).toBeNull();
	});
});
