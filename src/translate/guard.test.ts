import { describe, it, expect, vi } from "vitest";
import {
	withTimeout,
	TimeoutError,
	CircuitBreaker,
	CircuitOpenError,
	isFatalError,
} from "./guard";

describe("withTimeout", () => {
	it("成功在超时内 resolve", async () => {
		const v = await withTimeout(Promise.resolve(42), 100);
		expect(v).toBe(42);
	});

	it("超时后 reject TimeoutError", async () => {
		const never = new Promise<number>((resolve) => setTimeout(() => resolve(1), 1000));
		await expect(withTimeout(never, 20, "测试")).rejects.toBeInstanceOf(TimeoutError);
	});

	it("原 promise reject 时透传错误", async () => {
		const err = new Error("boom");
		await expect(withTimeout(Promise.reject(err), 100)).rejects.toBe(err);
	});
});

describe("CircuitBreaker", () => {
	it("初始关闭，连续失败达阈值后开路", () => {
		const b = new CircuitBreaker(2, 1000);
		expect(b.isOpen()).toBe(false);
		b.recordFailure();
		expect(b.isOpen()).toBe(false); // 第 1 次还没到阈值
		b.recordFailure();
		expect(b.isOpen()).toBe(true); // 第 2 次达阈值
	});

	it("冷却结束后半开，允许一次试探", () => {
		vi.useFakeTimers();
		const b = new CircuitBreaker(1, 50);
		b.recordFailure();
		expect(b.isOpen()).toBe(true);
		vi.advanceTimersByTime(60); // 越过冷却
		expect(b.isOpen()).toBe(false); // 进入半开，允许一次试探
		vi.useRealTimers();
	});

	it("成功调用复位计数/开路", () => {
		const b = new CircuitBreaker(1, 1000);
		b.recordFailure();
		expect(b.isOpen()).toBe(true);
		b.recordSuccess();
		expect(b.isOpen()).toBe(false);
	});

	it("fatal 错误用更长冷却", () => {
		const b = new CircuitBreaker(3, 1000, 5000);
		b.recordFailure(true);
		expect(b.isOpen()).toBe(true);
	});
});

describe("isFatalError", () => {
	it("识别鉴权/配额/超时类错误", () => {
		expect(isFatalError(new TimeoutError(1))).toBe(true);
		expect(isFatalError(new Error("HTTP 401（API Key 无效）"))).toBe(true);
		expect(isFatalError(new Error("rate limit 429"))).toBe(true);
		expect(isFatalError(new Error("普通网络错误"))).toBe(false);
	});
});

describe("CircuitOpenError", () => {
	it("可被实例识别", () => {
		expect(new CircuitOpenError("腾讯").name).toBe("CircuitOpenError");
	});

	it("文案含降级说明", () => {
		const msg = new CircuitOpenError("AI 翻译").message;
		expect(msg).toContain("熔断器已开路，暂时跳过");
		expect(msg).toContain("服务连续失败过多，本批次直接降级");
	});

	it("TimeoutError 文案只陈述事实不做归因", () => {
		const msg = new TimeoutError(15000, "AI 翻译").message;
		expect(msg).toContain("请求超时（>15000ms）：AI 翻译");
		expect(msg).toContain("未在阈值内收到响应，已跳过该来源");
	});

	it("与 notice.ai.fail 拼接后括号闭合", () => {
		const prefix = "AI 智能排序暂不可用，已保留常规搜索结果（原因：";
		const full = `${prefix}${new CircuitOpenError("AI 翻译").message}）`;
		// 不应出现未闭合的「（原因：」且无尾随左括号
		expect(full.endsWith("）")).toBe(true);
		expect(full).not.toMatch(/（原因：.*（原因：/);
	});
});
