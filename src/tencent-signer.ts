/**
 * 腾讯翻译 API 签名模块（TC3-HMAC-SHA256）
 *
 * 从 Translator 中提取，消除 God Object 对外部加密 API（Web Crypto）
 * 的隐性耦合。
 */

import { netRequest } from "./net";

// ──────────────────────────────────────────
// 类型
// ──────────────────────────────────────────

export interface TencentApiConfig {
	secretId: string;
	secretKey: string;
	region?: string;
}

// ──────────────────────────────────────────
// 加密工具函数
// ──────────────────────────────────────────

/** SHA-256 哈希，返回 hex 字符串 */
async function sha256Hex(message: string): Promise<string> {
	const msgBuffer = new TextEncoder().encode(message);
	const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
	return bufferToHex(hashBuffer);
}

/** HMAC-SHA256，返回 ArrayBuffer */
async function hmacSha256(
	key: string | ArrayBuffer,
	message: string
): Promise<ArrayBuffer> {
	const keyData =
		typeof key === "string" ? new TextEncoder().encode(key) : key;
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		keyData,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);
	return await crypto.subtle.sign(
		"HMAC",
		cryptoKey,
		new TextEncoder().encode(message)
	);
}

/** HMAC-SHA256，返回 hex 字符串 */
async function hmacSha256Hex(
	key: ArrayBuffer,
	message: string
): Promise<string> {
	const result = await hmacSha256(key, message);
	return bufferToHex(result);
}

/** ArrayBuffer → hex 字符串 */
function bufferToHex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// ──────────────────────────────────────────
// 腾讯翻译 API 调用
// ──────────────────────────────────────────

/**
 * 使用 TC3-HMAC-SHA256 签名调用腾讯云机器翻译 API。
 * @param text 待翻译英文文本
 * @param apiConfig API 密钥配置
 * @returns 中文翻译结果
 */
export async function tencentTranslate(
	text: string,
	apiConfig: TencentApiConfig
): Promise<string> {
	const host = "tmt.tencentcloudapi.com";
	const service = "tmt";
	const action = "TextTranslation";
	const version = "2018-03-21";
	const region = apiConfig.region || "ap-guangzhou";
	const timestamp = Math.floor(Date.now() / 1000);
	const date = new Date(timestamp * 1000).toISOString().split("T")[0];

	// 构造请求体
	const payload = JSON.stringify({
		SourceText: text,
		Source: "en",
		Target: "zh",
		ProjectId: 0,
	});

	// Step 1: 拼接规范请求串
	const httpRequestMethod = "POST";
	const canonicalUri = "/";
	const canonicalQueryString = "";
	const canonicalHeaders =
		`content-type:application/json; charset=utf-8\n` +
		`host:${host}\n` +
		`x-tc-action:${action.toLowerCase()}\n`;
	const signedHeaders = "content-type;host;x-tc-action";

	const hashedPayload = await sha256Hex(payload);
	const canonicalRequest = [
		httpRequestMethod,
		canonicalUri,
		canonicalQueryString,
		canonicalHeaders,
		signedHeaders,
		hashedPayload,
	].join("\n");

	// Step 2: 拼接待签名字符串
	const algorithm = "TC3-HMAC-SHA256";
	const credentialScope = `${date}/${service}/tc3_request`;
	const hashedCanonicalRequest = await sha256Hex(canonicalRequest);
	const stringToSign = [
		algorithm,
		String(timestamp),
		credentialScope,
		hashedCanonicalRequest,
	].join("\n");

	// Step 3: 计算签名
	const secretDate = await hmacSha256(
		"TC3" + apiConfig.secretKey,
		date
	);
	const secretService = await hmacSha256(secretDate, service);
	const secretSigning = await hmacSha256(secretService, "tc3_request");
	const signature = await hmacSha256Hex(secretSigning, stringToSign);

	// Step 4: 拼接 Authorization
	const authorization = `${algorithm} Credential=${apiConfig.secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

	// 发起请求（netRequest：直接走 Obsidian requestUrl）
	const response = await netRequest({
		url: `https://${host}`,
		method: "POST",
		headers: {
			Authorization: authorization,
			"Content-Type": "application/json; charset=utf-8",
			Host: host,
			"X-TC-Action": action,
			"X-TC-Version": version,
			"X-TC-Timestamp": String(timestamp),
			"X-TC-Region": region,
		},
		body: payload,
	});

	interface TencentTranslateResponse {
		Response?: {
			Error?: { Code: string; Message: string };
			TargetText?: string;
		};
	}
	const json = response.json as TencentTranslateResponse;

	if (json.Response?.Error) {
		throw new Error(
			`${json.Response.Error.Code}: ${json.Response.Error.Message}`
		);
	}

	return json.Response?.TargetText || text;
}
