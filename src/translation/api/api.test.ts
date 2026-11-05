import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 让腾讯翻译走可控的桩
vi.mock("@translation/api/tencent-signer", () => ({
	tencentTranslate: vi.fn(),
}));

import { setHttpClient, resetHttpClient } from "@data/net/http-port";
import { tencentTranslate } from "@translation/api/tencent-signer";
import {
	MyMemoryClient,
	TencentClient,
	GoogleClient,
	LLMClient,
	callAITranslate,
} from "@translation/api/api";
import { CircuitOpenError, TimeoutError } from "@translation/api/guard";
import type { PluginInfo } from "@domain/catalog/translator";

// 依赖倒置后：api 层统一走 netRequest → 注入的 HttpClient，单测直接注入 mock，无需 mock "obsidian"
const req = vi.fn();
const tc = tencentTranslate as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
	req.mockReset();
	tc.mockReset();
	setHttpClient({ request: req });
});
afterEach(() => {
	vi.useRealTimers();
	resetHttpClient();
});

describe("LLMClient · 服务商接口路径", () => {
	it.each([
		["https://api.deepseek.com", "https://api.deepseek.com/v1/chat/completions"],
		["https://open.bigmodel.cn/api/paas/v4/", "https://open.bigmodel.cn/api/paas/v4/chat/completions"],
		["https://open.bigmodel.cn/api/paas/v4/chat/completions", "https://open.bigmodel.cn/api/paas/v4/chat/completions"],
		["https://gateway.example/chat/completions", "https://gateway.example/chat/completions"],
	])("%s 请求正确端点", async (baseURL, url) => {
		req.mockResolvedValue({ status: 200, json: { choices: [{ message: { content: "你好" } }] } });
		const client = new LLMClient({ baseURL, apiKey: "test-key", model: "glm-4" });
		await expect(client.call("system", "hello", 10, false)).resolves.toBe("你好");
		expect(req).toHaveBeenCalledOnce();
		expect(req).toHaveBeenCalledWith(expect.objectContaining({ url, method: "POST" }));
	});
});

describe("LLMClient · 超时与熔断", () => {
	it("成功调用后熔断器保持关闭", async () => {
		req.mockResolvedValue({
			status: 200,
			json: { choices: [{ message: { content: '{"name":"同步","description":"保持笔记同步"}' } }] },
		});
		const llm = new LLMClient({ baseURL: "http://x", apiKey: "k", model: "m" });
		const out = await llm.call("sys", "usr", 1024);
		expect(typeof out).toBe("string");
		expect(llm.isAvailable()).toBe(true);
	});

	it("连续失败达阈值后开路，后续调用直接抛 CircuitOpenError（不再打真实请求）", async () => {
		req.mockRejectedValue(new Error("网络不可达"));
		const llm = new LLMClient({ baseURL: "http://x", apiKey: "k", model: "m" });
		await expect(llm.call("s", "u", 10)).rejects.toThrow();
		expect(llm.isAvailable()).toBe(true); // 第 1 次失败未达阈值
		await expect(llm.call("s", "u", 10)).rejects.toThrow();
		// 第 2 次失败达阈值 → 开路
		expect(llm.isAvailable()).toBe(false);
		await expect(llm.call("s", "u", 10)).rejects.toBeInstanceOf(CircuitOpenError);
		// 开路期间不再发起真实请求
		expect(req).toHaveBeenCalledTimes(2);
	});

	it("鉴权/配额(401)触发 fatal 开路", async () => {
		req.mockResolvedValue({ status: 401, json: { error: { message: "invalid key" } } });
		const llm = new LLMClient({ baseURL: "http://x", apiKey: "k", model: "m" });
		await expect(llm.call("s", "u", 10)).rejects.toThrow(/401/);
		expect(llm.isAvailable()).toBe(false); // 一次即开路（fatal）
	});

	it("超时（TimeoutError）按瞬时错误计数，连续达阈值才开路", async () => {
		// 直接以 TimeoutError 模拟请求卡死（真实 15s 超时由 guard.test.ts 覆盖）
		req.mockRejectedValue(new TimeoutError(1, "AI 翻译"));
		const llm = new LLMClient({ baseURL: "http://x", apiKey: "k", model: "m" });
		// PERF-1：瞬时超时不再视为 fatal（鉴权/配额），单次超时不开路（走短冷却计数），
		// 避免「一次弱网抖动 = 该来源当天被 24h 熔断跳过」的错误降级。
		await expect(llm.call("s", "u", 10)).rejects.toThrow();
		expect(llm.isAvailable()).toBe(true);
		// 连续第二次超时达阈值（threshold=2）才开路
		await expect(llm.call("s", "u", 10)).rejects.toThrow();
		expect(llm.isAvailable()).toBe(false);
		// 开路期间直接抛 CircuitOpenError，不再打真实请求
		await expect(llm.call("s", "u", 10)).rejects.toBeInstanceOf(CircuitOpenError);
		expect(req).toHaveBeenCalledTimes(2);
	});
});

describe("TencentClient · 超时与熔断", () => {
	it("成功翻译并复位", async () => {
		tc.mockResolvedValue("同步");
		const client = new TencentClient();
		client.setConfig({ secretId: "a", secretKey: "b" });
		const out = await client.translate("Sync");
		expect(out).toBe("同步");
		expect(client.isAvailable()).toBe(true);
	});

	it("连续失败达阈值后开路，且 isAvailable()=false 跳过", async () => {
		tc.mockRejectedValue(new Error("腾讯鉴权失败"));
		const client = new TencentClient();
		client.setConfig({ secretId: "a", secretKey: "b" });
		await expect(client.translate("Sync")).rejects.toThrow();
		await expect(client.translate("Sync")).rejects.toThrow();
		expect(client.isAvailable()).toBe(false);
		await expect(client.translate("Sync")).rejects.toBeInstanceOf(CircuitOpenError);
	});
});

describe("MyMemoryClient · 弱网瞬时熔断", () => {
	function makeClient() {
		const c = new MyMemoryClient();
		c.setEnabled(true);
		return c;
	}

	it("连续网络失败达阈值后开路，translate 直接返回 null 且不再发请求", async () => {
		req.mockRejectedValue(new Error("网络不可达"));
		const c = makeClient();
		// 每次 translate 并行请求 name+desc（各 1 次 requestUrl），记 1 次失败
		// 阈值 3：第 4 次 translate 被熔断器跳过，不再发请求
		await c.translate({ id: "a", name: "Sync", description: "keep notes", author: "t" });
		await c.translate({ id: "b", name: "Theme", description: "color", author: "t" });
		await c.translate({ id: "c", name: "Kanban", description: "board", author: "t" });
		const r = await c.translate({ id: "d", name: "Dataview", description: "x", author: "t" });
		expect(r).toBeNull();
		// a/b/c 各 2 次请求 = 6；d 被熔断跳过 = 0
		expect(req).toHaveBeenCalledTimes(6);
	});
});

describe("GoogleClient · 零配置免费翻译", () => {
	function makeClient() {
		const c = new GoogleClient();
		c.setEnabled(true);
		return c;
	}

	it("成功翻译返回 source=online provider=google", async () => {
		// 非官方接口返回嵌套数组：json[0][i][0] 为各片段译文。
		// 用 mockImplementation 按 url 中的 q 生成「确定不同」的伪译文，
		// 避免被质量校验（原文回显）判定为无效。
		req.mockImplementation((opts: any) => {
			const m = /[?&]q=([^&]*)/.exec(opts.url);
			const q = m ? decodeURIComponent(m[1]) : "x";
			const fake = `【${q}】译`;
			return Promise.resolve({
				status: 200,
				json: [[[fake, null, q, null, 1]], null, "en", "zh-CN", null, null, 1, []],
			});
		});
		const c = makeClient();
		const r = await c.translate({ id: "x", name: "Sync", description: "keep your notes", author: "t" });
		expect(r).not.toBeNull();
		expect(r!.provider).toBe("google");
		expect(r!.source).toBe("online");
		expect(r!.translatedName).toBe("【Sync】译");
		expect(r!.translatedDesc).toBe("【keep your notes】译");
	});

	it("连续网络失败达阈值后开路，translate 返回 null 且不再发请求", async () => {
		req.mockRejectedValue(new Error("网络不可达"));
		const c = makeClient();
		await c.translate({ id: "a", name: "Sync", description: "keep notes", author: "t" });
		await c.translate({ id: "b", name: "Theme", description: "color", author: "t" });
		await c.translate({ id: "c", name: "Kanban", description: "board", author: "t" });
		const r = await c.translate({ id: "d", name: "Dataview", description: "x", author: "t" });
		expect(r).toBeNull();
		// a/b/c 各 2 次请求 = 6；d 被熔断跳过 = 0
		expect(req).toHaveBeenCalledTimes(6);
	});

	it("name 和 desc 都未变化时视为无效，返回 null 走 fallback", async () => {
		// 按 url 中的 q 回显原文：name="Sync" 回显 Sync、desc="keep" 回显 keep，
		// 两段都未变 → 走 MyMemory 兜底（返回 null）。
		req.mockImplementation((opts: any) => {
			const m = /[?&]q=([^&]*)/.exec(opts.url);
			const q = m ? decodeURIComponent(m[1]) : "x";
			return Promise.resolve({
				status: 200,
				json: [[[q, null, q, null, 1]], null, "en", "zh-CN", null, null, 1, []],
			});
		});
		const c = makeClient();
		const r = await c.translate({ id: "x", name: "Sync", description: "keep", author: "t" });
		expect(r).toBeNull();
	});

	it("name 未变化但 desc 已翻译时，仍返回结果（保留英文名 + 中文描述）", async () => {
		// name 是专有名词，Google 回显原文；desc 已翻译。按 url 中的 q 区分两次调用。
		req.mockImplementation((opts: any) => {
			const m = /[?&]q=([^&]*)/.exec(opts.url);
			const q = m ? decodeURIComponent(m[1]) : "x";
			const text = q === "Files Progress" ? "Files Progress" : "查看和追踪文件处理进度";
			return Promise.resolve({
				status: 200,
				json: [[[text, null, q, null, 1]], null, "en", "zh-CN", null, null, 1, []],
			});
		});
		const c = makeClient();
		const r = await c.translate({
			id: "files-progress",
			name: "Files Progress",
			description: "Track file progress",
			author: "t",
		});
		expect(r).not.toBeNull();
		expect(r!.translatedName).toBe("Files Progress");
		expect(r!.translatedDesc).toBe("查看和追踪文件处理进度");
		expect(r!.provider).toBe("google");
	});

	it("含大写专有名词（如 MCP/Agent）的 name 返回全大写回显时，不报错、视为未变化保留原文", async () => {
		// 复现 agent-mcp 场景：Google 对 "Agent MCP" 返回全大写 "AGENT MCP" 回显。
		// 全大写英文不应被误判为「无效译文」抛错（之前会告警 + 熔断计数），
		// 而应被 isUnchanged（大小写归一）捕获为未变化，保留原文 name。
		req.mockImplementation((opts: any) => {
			const m = /[?&]q=([^&]*)/.exec(opts.url);
			const q = m ? decodeURIComponent(m[1]) : "x";
			const text = q === "Agent MCP" ? "AGENT MCP" : "MCP 代理：连接大模型与外部工具";
			return Promise.resolve({
				status: 200,
				json: [[[text, null, q, null, 1]], null, "en", "zh-CN", null, null, 1, []],
			});
		});
		const c = makeClient();
		const r = await c.translate({
			id: "agent-mcp",
			name: "Agent MCP",
			description: "MCP agent connecting LLM with external tools",
			author: "t",
		});
		expect(r).not.toBeNull();
		// name 全大写回显 → 视为未变化 → 保留原名；desc 已翻译 → 采用译文
		expect(r!.translatedName).toBe("Agent MCP");
		expect(r!.translatedDesc).toBe("MCP 代理：连接大模型与外部工具");
		expect(r!.provider).toBe("google");
	});
});

// ─────────────────────────────────────────────────────────────
// 追加用例：补齐 callAITranslate（完全未测）、各客户端 restoreBlockedDate /
// translateText / isBlocked·getBlockedDate / isEnabled / updateConfig /
// httpStatusHint / 配额分支 / callApi 错误分支 / 未配置分支。保留原 13 例。
// ─────────────────────────────────────────────────────────────

const todayStrLocal = (): string => {
	const d = new Date();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${m}-${day}`;
};

describe("callAITranslate · 完全未测函数补齐", () => {
	const llmOk = (content: string) =>
		req.mockResolvedValue({ status: 200, json: { choices: [{ message: { content } }] } });

	it("熔断器开路（isAvailable=false）直接返回 null，不发请求", async () => {
		const llm = { isAvailable: () => false, call: vi.fn() } as unknown as LLMClient;
		expect(await callAITranslate(llm, { id: "x", name: "Sync", description: "keep", author: "t" })).toBeNull();
		expect(req).not.toHaveBeenCalled();
	});

	it("成功解析 JSON → source=ai 结果", async () => {
		llmOk('{"name":"同步","description":"保持笔记同步"}');
		const llm = new LLMClient({ baseURL: "http://x", apiKey: "k", model: "m" });
		const r = await callAITranslate(llm, { id: "x", name: "Sync", description: "keep notes in sync", author: "t" });
		expect(r).toEqual({ translatedName: "同步", translatedDesc: "保持笔记同步", source: "ai" });
	});

	it("name 解析为空 → 返回 null", async () => {
		llmOk('{"name":"","description":"保持笔记同步"}');
		const llm = new LLMClient({ baseURL: "http://x", apiKey: "k", model: "m" });
		expect(await callAITranslate(llm, { id: "x", name: "Sync", description: "keep", author: "t" })).toBeNull();
	});

	it("name+desc 都回显（未翻译）→ 返回 null（防污染 vault）", async () => {
		llmOk('{"name":"Sync","description":"keep notes in sync"}');
		const llm = new LLMClient({ baseURL: "http://x", apiKey: "k", model: "m" });
		expect(await callAITranslate(llm, { id: "x", name: "Sync", description: "keep notes in sync", author: "t" })).toBeNull();
	});

	it("仅 name 变化、desc 回显 → 采用译文名 + 回退原 desc", async () => {
		llmOk('{"name":"同步","description":"keep notes in sync"}');
		const llm = new LLMClient({ baseURL: "http://x", apiKey: "k", model: "m" });
		const r = await callAITranslate(llm, { id: "x", name: "Sync", description: "keep notes in sync", author: "t" });
		expect(r).toEqual({ translatedName: "同步", translatedDesc: "keep notes in sync", source: "ai" });
	});

	it("llm.call 抛错（网络/熔断）→ catch 返回 null", async () => {
		req.mockRejectedValue(new Error("net"));
		const llm = new LLMClient({ baseURL: "http://x", apiKey: "k", model: "m" });
		expect(await callAITranslate(llm, { id: "x", name: "Sync", description: "keep", author: "t" })).toBeNull();
	});

	it("返回非 JSON → parseJSON 失败 catch 返回 null", async () => {
		llmOk("这不是 JSON");
		const llm = new LLMClient({ baseURL: "http://x", apiKey: "k", model: "m" });
		expect(await callAITranslate(llm, { id: "x", name: "Sync", description: "keep", author: "t" })).toBeNull();
	});
});

describe("MyMemoryClient · 补充（状态恢复 / 单段 / 配额 / 错误分支）", () => {
	const mk = () => { const c = new MyMemoryClient(); c.setEnabled(true); return c; };
	const plugin = (o: Partial<PluginInfo> = {}): PluginInfo => ({ id: "x", name: "Sync", description: "keep notes", author: "t", ...o });

	it("restoreBlockedDate：跨天自动解除（不恢复 blocked）", () => {
		const c = mk();
		c.restoreBlockedDate("2099-01-01");
		expect(c.isBlocked()).toBe(false);
	});

	it("restoreBlockedDate：当天日期 → 恢复 blocked 且记录日期", () => {
		const c = mk();
		const t = todayStrLocal();
		c.restoreBlockedDate(t);
		expect(c.isBlocked()).toBe(true);
		expect(c.getBlockedDate()).toBe(t);
	});

	it("translateText：成功返回译文（拉丁文避免 isAllCaps 误判）；空串返回空 MyMemoryResult（非 null）", async () => {
		req.mockResolvedValue({ status: 200, json: { responseStatus: 200, responseData: { translatedText: "Bonjour" } } });
		const c = mk();
		expect(await c.translateText("Sync")).toEqual({ translatedName: "Bonjour", translatedDesc: "", match: 0 });
		expect(await c.translateText("")).toEqual({ translatedName: "", translatedDesc: "", match: 0 });
	});

	it("translateText：中文译文不再被 isAllCaps 误判为 unchanged（bug 修复回归）", async () => {
		req.mockResolvedValue({ status: 200, json: { responseStatus: 200, responseData: { translatedText: "你好" } } });
		const c = mk();
		expect(await c.translateText("Hello")).toEqual({ translatedName: "你好", translatedDesc: "", match: 0 });
	});

	it("translateText：blocked 时返回 null", async () => {
		const c = mk();
		c.restoreBlockedDate(todayStrLocal());
		expect(await c.translateText("Sync")).toBeNull();
	});

	it("translate：配额提示（QUOTA_HINTS）→ blocked=true 且返回 null", async () => {
		req.mockResolvedValue({ status: 200, json: { responseStatus: 200, responseData: { translatedText: "PLEASE SELECT" } } });
		const c = mk();
		expect(await c.translate(plugin())).toBeNull();
		expect(c.isBlocked()).toBe(true);
	});

	it("translate：name+desc 都回显（unchanged）→ 降级 null、不记熔断", async () => {
		req.mockImplementation((opts: any) => {
			const m = /[?&]q=([^&]*)/.exec(opts.url);
			const q = m ? decodeURIComponent(m[1]) : "x";
			return Promise.resolve({ status: 200, json: { responseStatus: 200, responseData: { translatedText: q } } });
		});
		const c = mk();
		expect(await c.translate(plugin())).toBeNull();
		expect(c.isBlocked()).toBe(false);
	});

	it("translate：返回非 JSON 响应 → 失败降级 null（不计 blocked）", async () => {
		req.mockResolvedValue({ status: 200, json: "plain" });
		const c = mk();
		expect(await c.translate(plugin())).toBeNull();
		expect(c.isBlocked()).toBe(false);
	});

	it("translate：responseStatus≠200 → API 错误降级 null", async () => {
		req.mockResolvedValue({ status: 200, json: { responseStatus: 402, responseDetails: "err" } });
		const c = mk();
		expect(await c.translate(plugin())).toBeNull();
		expect(c.isBlocked()).toBe(false);
	});

	it("translate：未启用 → 直接返回 null", async () => {
		const c = new MyMemoryClient();
		c.setEnabled(false);
		expect(await c.translate(plugin())).toBeNull();
		expect(req).not.toHaveBeenCalled();
	});
});

describe("GoogleClient · 补充（状态恢复 / 单段 / 配额 / 错误分支）", () => {
	const mk = () => { const c = new GoogleClient(); c.setEnabled(true); return c; };
	const plugin = (o: Partial<PluginInfo> = {}): PluginInfo => ({ id: "x", name: "Sync", description: "keep notes", author: "t", ...o });
	const gResp = (text: string) =>
		req.mockResolvedValue({ status: 200, json: [[[text, null, "q", null, 1]], null, "en", "zh-CN", null, null, 1, []] });
	const gEcho = () =>
		req.mockImplementation((opts: any) => {
			const m = /[?&]q=([^&]*)/.exec(opts.url);
			const q = m ? decodeURIComponent(m[1]) : "x";
			return Promise.resolve({ status: 200, json: [[[q, null, q, null, 1]], null, "en", "zh-CN", null, null, 1, []] });
		});

	it("isEnabled / isBlocked / getBlockedDate 基础读", () => {
		const c = mk();
		expect(c.isEnabled()).toBe(true);
		expect(c.isBlocked()).toBe(false);
		expect(c.getBlockedDate()).toBeNull();
	});

	it("restoreBlockedDate：当天 → blocked；跨天 → 不恢复", () => {
		const c = mk();
		c.restoreBlockedDate(todayStrLocal());
		expect(c.isBlocked()).toBe(true);
		const c2 = mk();
		c2.restoreBlockedDate("2099-01-01");
		expect(c2.isBlocked()).toBe(false);
	});

	it("translateText：成功返回译文；空串返回 null", async () => {
		gResp("同步");
		const c = mk();
		expect(await c.translateText("Sync")).toBe("同步");
		expect(await c.translateText("")).toBe("");
	});

	it("translateText：blocked 返回 null", async () => {
		const c = mk();
		c.restoreBlockedDate(todayStrLocal());
		expect(await c.translateText("Sync")).toBeNull();
	});

	it("translate：配额错误（含 429 字样）→ blocked=true 且返回 null", async () => {
		req.mockRejectedValue(new Error("HTTP 429 rate limit"));
		const c = mk();
		expect(await c.translate(plugin())).toBeNull();
		expect(c.isBlocked()).toBe(true);
	});

	it("translate：返回非预期结构 → 降级 null", async () => {
		req.mockResolvedValue({ status: 200, json: { foo: "bar" } });
		const c = mk();
		expect(await c.translate(plugin())).toBeNull();
	});

	it("translate：空译文 → 降级 null", async () => {
		gResp("");
		const c = mk();
		expect(await c.translate(plugin())).toBeNull();
	});

	it("translate：name+desc 都回显（未变化）→ 降级 null 走兜底", async () => {
		gEcho();
		const c = mk();
		expect(await c.translate(plugin())).toBeNull();
	});
});

describe("LLMClient · 补充（updateConfig / httpStatusHint / 非 2xx / forceJson）", () => {
	it("updateConfig 运行时切换 model", async () => {
		const llm = new LLMClient({ baseURL: "http://a", apiKey: "k", model: "m" });
		llm.updateConfig({ model: "newmodel" });
		req.mockResolvedValue({ status: 200, json: { choices: [{ message: { content: "你好" } }] } });
		await llm.call("s", "u", 10);
		const body = JSON.parse((req.mock.calls[0][0] as { body: string }).body);
		expect(body.model).toBe("newmodel");
	});

	it("httpStatusHint 覆盖各状态码与默认", () => {
		expect(LLMClient.httpStatusHint(401)).toContain("API Key");
		expect(LLMClient.httpStatusHint(403)).toContain("无权限");
		expect(LLMClient.httpStatusHint(404)).toContain("接口地址");
		expect(LLMClient.httpStatusHint(429)).toContain("额度");
		expect(LLMClient.httpStatusHint(500)).toContain("服务端");
		expect(LLMClient.httpStatusHint(502)).toContain("服务端");
		expect(LLMClient.httpStatusHint(503)).toContain("服务端");
		expect(LLMClient.httpStatusHint(418)).toBe("");
	});

	it("非 2xx：带 error.message 抛出含状态码与详情", async () => {
		req.mockResolvedValue({ status: 404, json: { error: { message: "not found" } } });
		const llm = new LLMClient({ baseURL: "http://x", apiKey: "k", model: "m" });
		await expect(llm.call("s", "u", 10)).rejects.toThrow(/404/);
		await expect(llm.call("s", "u", 10)).rejects.toThrow(/not found/);
	});

	it("非 2xx：error.message 缺失时回退到 response.text 截断（bug 修复回归）", async () => {
		req.mockResolvedValue({ status: 500, json: { foo: "bar" }, text: "internal server error long text" });
		const llm = new LLMClient({ baseURL: "http://x", apiKey: "k", model: "m" });
		await expect(llm.call("s", "u", 10)).rejects.toThrow(/500/);
		await expect(llm.call("s", "u", 10)).rejects.toThrow(/internal server error/);
	});

	it("forceJson=false 时不带 response_format", async () => {
		req.mockResolvedValue({ status: 200, json: { choices: [{ message: { content: "你好" } }] } });
		const llm = new LLMClient({ baseURL: "http://x", apiKey: "k", model: "m" });
		await llm.call("s", "u", 10, false);
		const body = JSON.parse((req.mock.calls[0][0] as { body: string }).body);
		expect(body).not.toHaveProperty("response_format");
	});
});

describe("TencentClient · 补充", () => {
	it("未配置 config → translate 抛「未配置翻译 API」", async () => {
		const c = new TencentClient();
		await expect(c.translate("Sync")).rejects.toThrow("未配置翻译 API");
	});
});
