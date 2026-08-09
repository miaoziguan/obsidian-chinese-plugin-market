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
} from "@translation/api/api";
import { CircuitOpenError, TimeoutError } from "@translation/api/guard";

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

	it("超时（TimeoutError）触发熔断，避免逐条挂起", async () => {
		// 直接以 TimeoutError 模拟请求卡死（真实 15s 超时由 guard.test.ts 覆盖）
		req.mockRejectedValue(new TimeoutError(1, "AI 翻译"));
		const llm = new LLMClient({ baseURL: "http://x", apiKey: "k", model: "m" });
		await expect(llm.call("s", "u", 10)).rejects.toThrow();
		// 致命错误（超时/鉴权/配额）一次即开路，避免对死端点逐条重试
		expect(llm.isAvailable()).toBe(false);
		// 开路期间直接抛 CircuitOpenError，不再打真实请求
		await expect(llm.call("s", "u", 10)).rejects.toBeInstanceOf(CircuitOpenError);
		expect(req).toHaveBeenCalledTimes(1);
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
