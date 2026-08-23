import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";

import { setHttpClient, resetHttpClient } from "@data/net/http-port";
import { BaiduTranslateClient } from "@translation/api/baidu";

function md5(input: string): string {
	return createHash("md5").update(input, "utf8").digest("hex");
}

// 依赖倒置后走注入的 HttpClient，单测直接注入 mock
const req = vi.fn();

beforeEach(() => {
	req.mockReset();
	setHttpClient({ request: req });
});
afterEach(() => {
	resetHttpClient();
});

describe("BaiduTranslateClient · 签名与解析", () => {
	it("成功时按 appid+q+salt+key 计算 MD5 签名并解析 trans_result[0].dst", async () => {
		// 百度官方示例签名：md5("2015063000000001apple143566028812345678")
		req.mockResolvedValue({
			status: 200,
			json: { from: "en", to: "zh", trans_result: [{ src: "apple", dst: "苹果" }] },
		});
		const client = new BaiduTranslateClient();
		client.setConfig({ appId: "2015063000000001", key: "12345678" });
		const dst = await client.translate("apple");
		expect(dst).toBe("苹果");
		// 校验发出的请求参数（form-urlencoded body）
		const callArg = req.mock.calls[0][0];
		const body = new URLSearchParams(callArg.body as string);
		expect(body.get("q")).toBe("apple");
		expect(body.get("from")).toBe("en");
		expect(body.get("to")).toBe("zh");
		expect(body.get("appid")).toBe("2015063000000001");
		// salt 随机生成，按协议复算 md5(appid+q+salt+key) 校验签名正确
		const salt = body.get("salt")!;
		expect(body.get("sign")).toBe(md5("2015063000000001" + "apple" + salt + "12345678"));
		expect(callArg.headers["Content-Type"]).toContain("application/x-www-form-urlencoded");
	});

	it("错误码映射为友好提示（密钥无效 54001）", async () => {
		req.mockResolvedValue({
			status: 200,
			json: { error_code: "54001", error_msg: "sign 错误" },
		});
		const client = new BaiduTranslateClient();
		client.setConfig({ appId: "a", key: "k" });
		await expect(client.translate("hi")).rejects.toThrow(/54001|签名/);
	});

	it("未配置时抛出明确错误", async () => {
		const client = new BaiduTranslateClient();
		await expect(client.translate("hi")).rejects.toThrow(/未配置/);
	});

	it("空文本直接原样返回，不发起请求", async () => {
		const client = new BaiduTranslateClient();
		client.setConfig({ appId: "a", key: "k" });
		expect(await client.translate("   ")).toBe("   ");
		expect(req).not.toHaveBeenCalled();
	});
});
