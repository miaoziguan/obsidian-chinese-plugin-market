import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { setHttpClient, resetHttpClient } from "@data/net/http-port";
import { netRequest } from "@data/net/net";

// 依赖倒置后：下层不再依赖 "obsidian"，单测直接注入 mock HttpClient，无需 mock 整个模块
const req = vi.fn();

describe("netRequest", () => {
	beforeEach(() => {
		req.mockReset();
		setHttpClient({ request: req });
	});
	afterEach(() => {
		resetHttpClient();
	});

	it("委托注入的 HttpClient，响应形状对齐", async () => {
		req.mockResolvedValue({
			status: 200,
			json: { ok: 1 },
			text: '{"ok":1}',
			headers: { "content-type": "application/json" },
		});

		const r = await netRequest({ url: "https://x.test/v1/chat", method: "POST", body: "{}" });
		expect(r.status).toBe(200);
		expect(r.json).toEqual({ ok: 1 });
		expect(req).toHaveBeenCalledOnce();
	});

	it("method 缺省时补 GET", async () => {
		req.mockResolvedValue({ status: 200, json: null, text: "", headers: {} });
		await netRequest({ url: "https://x.test/ping" });
		expect(req).toHaveBeenCalledWith(expect.objectContaining({ method: "GET" }));
	});

	it("未注入实现时显式抛错（而非静默降级）", async () => {
		resetHttpClient();
		await expect(netRequest({ url: "https://x.test" })).rejects.toThrow(/HttpClient 未注入/);
	});
});
