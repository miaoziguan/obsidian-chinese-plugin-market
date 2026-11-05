import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PluginInfo } from "@domain/catalog/translator";
import { netRequest } from "@data/net/net";
import {
	DeepLXClient,
	LibreTranslateClient,
	buildSelfHostedTranslators,
} from "./self-hosted";

const h = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("@data/net/net", () => ({ netRequest: vi.fn() }));
vi.mock("@shared/logger", () => ({
	logger: { warn: h.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const req = vi.mocked(netRequest);

const plugin = (over: Partial<PluginInfo> = {}): PluginInfo =>
	({ id: "p1", name: "Name", description: "Description", author: "a", ...over } as PluginInfo);

type RawResp = { status?: number; json?: unknown; text?: string };
/** 按调用次序返回预设响应（translate 内部 Promise.all 会连发两次） */
const seq = (...responses: RawResp[]): void => {
	let i = 0;
	req.mockImplementation(() =>
		Promise.resolve({
			status: 200,
			json: undefined,
			text: "",
			...responses[Math.min(i++, responses.length - 1)],
		} as never),
	);
};
const deeplxOk = (text: string): RawResp => ({ status: 200, json: { translations: [{ text }] }, text: "" });
const libreOk = (text: string): RawResp => ({ status: 200, json: { translatedText: text }, text: "" });
const call = (n = 0) => req.mock.calls[n][0] as unknown as { url: string; method: string; headers: Record<string, string>; body: string };
const priv = (c: object, name: string, ...args: unknown[]): Promise<unknown> =>
	(c as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name](...args);

let nowSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	vi.clearAllMocks();
	nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
});
afterEach(() => {
	nowSpy.mockRestore();
});

describe("DeepLXClient", () => {
	it("constructor 去尾斜杠、key/provider/isAvailable", () => {
		const c = new DeepLXClient("http://localhost:1188///");
		expect(c.provider).toBe("deeplx");
		expect(c.key).toBe("deeplx:http://localhost:1188");
		expect(c.isAvailable()).toBe(true);
	});

	it("callApi 请求构造（url/method/headers/body）与超长文本截断 500", async () => {
		seq(deeplxOk("译"));
		const c = new DeepLXClient("http://x");
		const long = "a".repeat(600);
		await priv(c, "callApi", long);
		const r = call();
		expect(r.url).toBe("http://x/translate");
		expect(r.method).toBe("POST");
		expect(r.headers["Content-Type"]).toBe("application/json");
		const body = JSON.parse(r.body);
		expect(body.text[0]).toHaveLength(500);
		expect(body.source_lang).toBe("EN");
		expect(body.target_lang).toBe("ZH");
	});

	it("callApi 正常返回首个 translation.text", async () => {
		seq(deeplxOk("译文"));
		expect(await priv(new DeepLXClient("http://x"), "callApi", "hi")).toBe("译文");
	});

	it("callApi HTTP 非 2xx → 抛错，正文截断到 120 且 text 缺失时回退空串", async () => {
		const c = new DeepLXClient("http://x");
		seq({ status: 503, text: "Z".repeat(200) });
		await expect(priv(c, "callApi", "hi")).rejects.toThrow(/^DeepLX HTTP 503：Z{120}$/);
		vi.clearAllMocks();
		seq({ status: 401, json: {} });
		await expect(priv(c, "callApi", "hi")).rejects.toThrow(/^DeepLX HTTP 401：$/);
	});

	it("callApi 非预期结构（null / translations 非数组 / text 缺失 / 空串）→ 抛错", async () => {
		const c = new DeepLXClient("http://x");
		for (const json of [
			null,
			{},
			{ translations: "oops" },
			{ translations: [{}] },
			{ translations: [{ text: "" }] },
		]) {
			vi.clearAllMocks();
			seq({ status: 200, json });
			await expect(priv(c, "callApi", "hi")).rejects.toThrow("DeepLX 返回非预期结构");
		}
	});

	it("translate 两者都译出 → source=online + provider=deeplx", async () => {
		seq(deeplxOk("名称"), deeplxOk("描述"));
		const r = await new DeepLXClient("http://x").translate(plugin());
		expect(r).toEqual({
			translatedName: "名称",
			translatedDesc: "描述",
			source: "online",
			provider: "deeplx",
		});
	});

	it("translate 两者都未变化（含大小写/空白归一）→ null", async () => {
		seq(deeplxOk("  name  "), deeplxOk("DESCRIPTION"));
		expect(await new DeepLXClient("http://x").translate(plugin())).toBeNull();
	});

	it("translate name 未变化 → 保留原名；desc 未变化 → 保留原描述", async () => {
		seq(deeplxOk("NAME"), deeplxOk("译述"));
		const r1 = await new DeepLXClient("http://x").translate(plugin());
		expect(r1).toMatchObject({ translatedName: "Name", translatedDesc: "译述" });
		vi.clearAllMocks();
		seq(deeplxOk("译名"), deeplxOk("  description  "));
		const r2 = await new DeepLXClient("http://x").translate(plugin());
		expect(r2).toMatchObject({ translatedName: "译名", translatedDesc: "Description" });
	});

	it("translate 请求失败 → warn + 返回 null；连续两次失败后熔断开路直接跳过", async () => {
		const c = new DeepLXClient("http://x");
		seq({ status: 500 });
		expect(await c.translate(plugin())).toBeNull();
		expect(h.warn).toHaveBeenCalledTimes(1);
		expect(c.isAvailable()).toBe(true); // 阈值 2，尚未开路
		expect(await c.translate(plugin())).toBeNull();
		expect(c.isAvailable()).toBe(false);
		const before = req.mock.calls.length;
		expect(await c.translate(plugin())).toBeNull(); // 开路后不再发请求
		expect(req.mock.calls.length).toBe(before);
	});

	it("HTTP 成功后复位熔断器计数（不会累计成永久开路）", async () => {
		const c = new DeepLXClient("http://x");
		seq({ status: 500 });
		await c.translate(plugin()); // 失败 1 次
		vi.clearAllMocks();
		seq(deeplxOk("译名"), deeplxOk("译述"));
		await c.translate(plugin()); // 成功 → recordSuccess 复位
		vi.clearAllMocks();
		seq({ status: 500 });
		await c.translate(plugin()); // 再失败 1 次，仍未开路
		expect(c.isAvailable()).toBe(true);
	});

	it("冷却结束进入半开，可再次试探", async () => {
		const c = new DeepLXClient("http://x");
		seq({ status: 500 });
		await c.translate(plugin());
		await c.translate(plugin());
		expect(c.isAvailable()).toBe(false);
		nowSpy.mockReturnValue(1_700_000_000_000 + 60_001);
		expect(c.isAvailable()).toBe(true);
	});
});

describe("LibreTranslateClient", () => {
	it("constructor 去尾斜杠、key/provider/isAvailable", () => {
		const c = new LibreTranslateClient("http://localhost:5000/");
		expect(c.provider).toBe("libretranslate");
		expect(c.key).toBe("libretranslate:http://localhost:5000");
		expect(c.isAvailable()).toBe(true);
	});

	it("callApi 请求构造（q/source/target/format）与截断 500", async () => {
		seq(libreOk("译"));
		await priv(new LibreTranslateClient("http://x"), "callApi", "b".repeat(700));
		const body = JSON.parse(call().body);
		expect(body.q).toHaveLength(500);
		expect(body.source).toBe("en");
		expect(body.target).toBe("zh");
		expect(body.format).toBe("text");
		expect(call().url).toBe("http://x/translate");
	});

	it("callApi 正常返回 translatedText", async () => {
		seq(libreOk("译文"));
		expect(await priv(new LibreTranslateClient("http://x"), "callApi", "hi")).toBe("译文");
	});

	it("callApi HTTP 非 2xx → 抛错（text 缺失回退空串）", async () => {
		const c = new LibreTranslateClient("http://x");
		seq({ status: 429, text: "limited" });
		await expect(priv(c, "callApi", "hi")).rejects.toThrow(/^LibreTranslate HTTP 429：limited$/);
		vi.clearAllMocks();
		seq({ status: 500, json: {} });
		await expect(priv(c, "callApi", "hi")).rejects.toThrow(/^LibreTranslate HTTP 500：$/);
	});

	it("callApi 非预期结构（null / 非字符串 / 空白串）→ 抛错", async () => {
		const c = new LibreTranslateClient("http://x");
		for (const json of [null, {}, { translatedText: 5 }, { translatedText: "   " }]) {
			vi.clearAllMocks();
			seq({ status: 200, json });
			await expect(priv(c, "callApi", "hi")).rejects.toThrow("LibreTranslate 返回非预期结构");
		}
	});

	it("translate 两者都译出 → provider=libretranslate", async () => {
		seq(libreOk("名称"), libreOk("描述"));
		expect(await new LibreTranslateClient("http://x").translate(plugin())).toEqual({
			translatedName: "名称",
			translatedDesc: "描述",
			source: "online",
			provider: "libretranslate",
		});
	});

	it("translate 都未变化 → null；单侧未变化 → 保留原文", async () => {
		seq(libreOk("name"), libreOk("Description"));
		expect(await new LibreTranslateClient("http://x").translate(plugin())).toBeNull();
		vi.clearAllMocks();
		seq(libreOk("NAME"), libreOk("译述"));
		expect(await new LibreTranslateClient("http://x").translate(plugin())).toMatchObject({
			translatedName: "Name",
			translatedDesc: "译述",
		});
	});

	it("translate 失败 → warn + null；两次失败后开路跳过", async () => {
		const c = new LibreTranslateClient("http://x");
		seq({ status: 500 });
		expect(await c.translate(plugin())).toBeNull();
		expect(h.warn).toHaveBeenCalled();
		expect(await c.translate(plugin())).toBeNull();
		expect(c.isAvailable()).toBe(false);
		const before = req.mock.calls.length;
		expect(await c.translate(plugin())).toBeNull();
		expect(req.mock.calls.length).toBe(before);
	});
});

describe("buildSelfHostedTranslators", () => {
	it("undefined / 空数组 → 空数组", () => {
		expect(buildSelfHostedTranslators(undefined)).toEqual([]);
		expect(buildSelfHostedTranslators([])).toEqual([]);
	});

	it("过滤空 / 纯空白 baseUrl", () => {
		expect(
			buildSelfHostedTranslators([
				{ type: "deeplx", baseUrl: "" },
				{ type: "libretranslate", baseUrl: "   " },
			]),
		).toEqual([]);
	});

	it("按质量序 DeepLX > LibreTranslate，trim + 去尾斜杠，key 正确", () => {
		const list = buildSelfHostedTranslators([
			{ type: "libretranslate", baseUrl: "  http://libre///  " },
			{ type: "deeplx", baseUrl: "http://deeplx/" },
		]);
		expect(list.map((t) => t.provider)).toEqual(["deeplx", "libretranslate"]);
		expect(list[0].key).toBe("deeplx:http://deeplx");
		expect(list[1].key).toBe("libretranslate:http://libre");
		expect(list[0]).toBeInstanceOf(DeepLXClient);
		expect(list[1]).toBeInstanceOf(LibreTranslateClient);
	});

	it("未知 type 走 LibreTranslateClient 分支", () => {
		const list = buildSelfHostedTranslators([
			{ type: "other" as "deeplx", baseUrl: "http://x" },
		]);
		expect(list[0]).toBeInstanceOf(LibreTranslateClient);
	});

	it("全部可用（新实例未开路）", () => {
		const list = buildSelfHostedTranslators([{ type: "deeplx", baseUrl: "http://x" }]);
		expect(list[0].isAvailable()).toBe(true);
	});
});
