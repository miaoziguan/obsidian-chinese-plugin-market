import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { webcrypto } from "node:crypto";
import { TextEncoder as NodeTextEncoder } from "node:util";
import { netRequest } from "@data/net/net";
import { tencentTranslate } from "./tencent-signer";

// netRequest 替身；crypto/TextEncoder 用 Node 真实实现（保证 TC3 签名链路真实执行）
vi.mock("@data/net/net", () => ({ netRequest: vi.fn() }));
const req = vi.mocked(netRequest);

const NOW = 1_700_000_000_000;
const TS = Math.floor(NOW / 1000);

const okResponse = (json: unknown) => ({ status: 200, json, text: "" }) as never;
type Call = {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string;
};
const lastCall = (): Call => req.mock.calls[req.mock.calls.length - 1][0] as unknown as Call;

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("crypto", webcrypto);
	vi.stubGlobal("TextEncoder", NodeTextEncoder);
	vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("tencentTranslate 成功路径（真实 TC3 签名）", () => {
	it("返回 TargetText，请求构造与 Authorization 符合 TC3 规范", async () => {
		req.mockResolvedValue(okResponse({ Response: { TargetText: "你好" } }));
		const result = await tencentTranslate("hello", { secretId: "sid", secretKey: "skey" });
		expect(result).toBe("你好");

		const call = lastCall();
		expect(call.url).toBe("https://tmt.tencentcloudapi.com");
		expect(call.method).toBe("POST");
		expect(call.headers["Content-Type"]).toBe("application/json; charset=utf-8");
		expect(call.headers.Host).toBe("tmt.tencentcloudapi.com");
		expect(call.headers["X-TC-Action"]).toBe("TextTranslation");
		expect(call.headers["X-TC-Version"]).toBe("2018-03-21");
		expect(call.headers["X-TC-Timestamp"]).toBe(String(TS));
		expect(call.headers["X-TC-Region"]).toBe("ap-guangzhou");
		expect(JSON.parse(call.body)).toEqual({
			SourceText: "hello",
			Source: "en",
			Target: "zh",
			ProjectId: 0,
		});

		const auth = call.headers.Authorization;
		expect(auth).toMatch(/^TC3-HMAC-SHA256 /);
		expect(auth).toContain("Credential=sid/");
		expect(auth).toContain("/tmt/tc3_request");
		expect(auth).toContain("SignedHeaders=content-type;host;x-tc-action");
		// Signature 为 64 位 hex，且随密钥变化（证明 HMAC 真实参与）
		expect(auth).toMatch(/Signature=[0-9a-f]{64}$/);
	});

	it("自定义 region 透传；不同密钥得到不同签名", async () => {
		req.mockResolvedValue(okResponse({ Response: { TargetText: "甲" } }));
		await tencentTranslate("a", { secretId: "sid", secretKey: "key1", region: "ap-beijing" });
		const first = lastCall().headers.Authorization;
		expect(lastCall().headers["X-TC-Region"]).toBe("ap-beijing");

		req.mockResolvedValue(okResponse({ Response: { TargetText: "乙" } }));
		await tencentTranslate("a", { secretId: "sid", secretKey: "key2" });
		const second = lastCall().headers.Authorization;
		expect(first).not.toBe(second);
	});
});

describe("tencentTranslate 故障必须与成功区分（不可静默吞掉）", () => {
	it("HTTP < 200 抛错", async () => {
		req.mockResolvedValue({ status: 199, json: null, text: "" } as never);
		await expect(tencentTranslate("x", { secretId: "s", secretKey: "k" })).rejects.toThrow("腾讯云翻译 HTTP 199");
	});

	it("HTTP >= 300 抛错（401/429/5xx 同理）", async () => {
		for (const status of [300, 401, 429, 503]) {
			req.mockResolvedValue({ status, json: null, text: "" } as never);
			await expect(tencentTranslate("x", { secretId: "s", secretKey: "k" })).rejects.toThrow(`腾讯云翻译 HTTP ${status}`);
		}
	});

	it("status 非数值 → 跳过 HTTP 检查，按 json 继续判定", async () => {
		req.mockResolvedValue({ status: "200", json: { Response: { TargetText: "译" } }, text: "" } as never);
		await expect(tencentTranslate("x", { secretId: "s", secretKey: "k" })).resolves.toBe("译");
	});

	it("json 为 null → 抛非对象响应", async () => {
		req.mockResolvedValue(okResponse(null));
		await expect(tencentTranslate("x", { secretId: "s", secretKey: "k" })).rejects.toThrow("腾讯云翻译返回非对象响应");
	});

	it("json 为非对象（字符串/数字）→ 抛非对象响应", async () => {
		for (const json of ["oops", 42]) {
			req.mockResolvedValue(okResponse(json));
			await expect(tencentTranslate("x", { secretId: "s", secretKey: "k" })).rejects.toThrow("腾讯云翻译返回非对象响应");
		}
	});

	it("Response.Error → 抛 Code: Message", async () => {
		req.mockResolvedValue(okResponse({ Response: { Error: { Code: "AuthFailure", Message: "签名错误" } } }));
		await expect(tencentTranslate("x", { secretId: "s", secretKey: "k" })).rejects.toThrow("AuthFailure: 签名错误");
	});

	it("TargetText 缺失 / 空串 / 非字符串 → 抛空译文（不兜回原文）", async () => {
		for (const json of [
			{ Response: {} },
			{ Response: { TargetText: "" } },
			{ Response: { TargetText: 123 } },
			{},
		]) {
			req.mockResolvedValue(okResponse(json));
			await expect(tencentTranslate("original", { secretId: "s", secretKey: "k" })).rejects.toThrow("腾讯云翻译返回空译文");
		}
	});
});
