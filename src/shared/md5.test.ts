import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

import { md5Hex } from "@shared/md5";

// 纯 JS MD5 必须与 Node 内置实现字节级一致（跨环境：Electron / 浏览器 / Node）
const cases = [
	"",
	"a",
	"abc",
	"apple",
	"message digest",
	"2015063000000001apple143566028812345678",
	"sk-test-key-123",
	"appid123",
	"你好世界",
	"https://api.siliconflow.cn/v1/chat/completions",
	"Mixed 中英文 + symbols !@#$%^&*()",
];

describe("md5Hex · 与 node:crypto 字节级一致", () => {
	for (const c of cases) {
		it(`md5("${c.slice(0, 20)}") 一致`, () => {
			expect(md5Hex(c)).toBe(createHash("md5").update(c, "utf8").digest("hex"));
		});
	}

	it("百度签名场景：MD5(appid + q + salt + key) 与 Node 一致", () => {
		const appId = "2015063000000001";
		const q = "hello world";
		const salt = "1435660288";
		const key = "12345678";
		expect(md5Hex(appId + q + salt + key)).toBe(
			createHash("md5").update(appId + q + salt + key, "utf8").digest("hex")
		);
	});
});
