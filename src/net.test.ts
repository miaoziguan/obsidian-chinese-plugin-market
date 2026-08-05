import { describe, it, expect, vi, beforeEach } from "vitest";

// mock obsidian 的 requestUrl（无代理路径）
vi.mock("obsidian", () => ({
	requestUrl: vi.fn(),
}));

import { requestUrl } from "obsidian";
import { netRequest } from "./net";

const req = requestUrl as unknown as ReturnType<typeof vi.fn>;

describe("netRequest", () => {
	beforeEach(() => {
		req.mockReset();
	});

	it("无代理时走 Obsidian requestUrl，响应形状对齐", async () => {
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
});
