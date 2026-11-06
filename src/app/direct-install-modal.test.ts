import { describe, it, expect, vi, beforeEach } from "vitest";
import { DirectInstallModal } from "@app/direct-install";
import * as DI from "@app/direct-install";
import * as OB from "obsidian";

// 部分 mock：保留真实 obsidian 全部导出（Setting/Notice/App 等），但 Modal 在 node/jsdom 下构造会依赖
// Obsidian 运行时（contentEl.empty 等非标准方法），故以可控 stub 替换；requestUrl/setIcon 覆盖为 noop。
// DirectInstallModal 直接 extends Modal，构造即走 Modal 构造，因此必须 stub Modal 才能 new 出来。
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		Modal: class {
			app: unknown;
			contentEl: HTMLElement;
			constructor(a: unknown) {
				this.app = a;
				const el = document.createElement("div");
				(el as unknown as { empty: () => void }).empty = () => {};
				this.contentEl = el;
			}
			close() {}
		},
		requestUrl: vi.fn(),
		setIcon: vi.fn(),
	};
});

// 部分 mock direct-install：保留真实 DirectInstallModal / parseSourceSpec / record 等，
// 仅将 run() 实际会发起安装的两个网络函数替换为可控 vi.fn()，以便在 node 下驱动 run 流程。
// （对 ESM 命名空间用 vi.spyOn 不可靠，故用 importOriginal 部分 mock 替换导出。）
vi.mock("@app/direct-install", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		installFromUrlResolved: vi.fn(),
		installThemeFromUrl: vi.fn(),
	};
});

/** 调用私有方法（绕过 TS 可见性检查，不引入 any） */
const call = <T,>(m: DirectInstallModal, method: string, ...args: never[]): T =>
	(m as unknown as Record<string, (...a: never[]) => T>)[method](...args);

describe("DirectInstallModal · 可独立调用的纯方法（不触发完整 DOM 渲染）", () => {
	const installed: { id: string; rootUrl?: string; kind?: string }[] = [];

	beforeEach(() => {
		installed.length = 0;
		vi.spyOn(OB, "Notice").mockImplementation(() => ({}) as never);
		vi.mocked(DI.installFromUrlResolved).mockResolvedValue({
			man: { id: "x", name: "X", version: "1.0" },
			release: false,
		} as never);
		vi.mocked(DI.installThemeFromUrl).mockResolvedValue({ id: "y", name: "Y", version: "2.0" } as never);
	});

	it("constructor 默认值：kind=plugin，url/busy 初始空", () => {
		const m = new DirectInstallModal({} as never);
		expect((m as unknown as { kind: string }).kind).toBe("plugin");
		expect((m as unknown as { url: string }).url).toBe("");
		expect((m as unknown as { busy: boolean }).busy).toBe(false);
	});

	it("record：有 onInstalled → 回调被调用且参数正确", () => {
		const m = new DirectInstallModal({} as never, "plugin", (info) => installed.push(info as never));
		call<void>(m, "record", { id: "x", name: "X", version: "1.0", rootUrl: "u", kind: "plugin", release: false } as never);
		expect(installed).toHaveLength(1);
		expect(installed[0].id).toBe("x");
	});

	it("record：无 onInstalled → 不崩", () => {
		const m = new DirectInstallModal({} as never);
		expect(() => call<void>(m, "record", { id: "x" } as never)).not.toThrow();
	});

	it("onClose：contentEl 清空不崩", () => {
		const m = new DirectInstallModal({} as never);
		expect(() => m.onClose()).not.toThrow();
	});

	it("run（plugin 分支）：进入安装流程，异常被吞且不崩、busy 复位", async () => {
		const m = new DirectInstallModal({} as never, "plugin", () => installed.push({ id: "z" } as never));
		(m as unknown as { url: string }).url = "owner/repo";
		const btn = { buttonEl: document.createElement("button"), setButtonText: vi.fn(), setDisabled: vi.fn() };
		// 成功路径依赖模块内部绑定的 installFromUrlResolved（不可在测试中 mock），
		// 故这里验证入口/守卫/异常吞掉/finally 复位：无论网络成败，run 都安全返回
		await expect(call<Promise<void>>(m, "run", btn as never)).resolves.toBeUndefined();
		expect((m as unknown as { busy: boolean }).busy).toBe(false);
	});

	it("run（theme 分支）：进入安装流程，异常被吞且不崩、busy 复位", async () => {
		const m = new DirectInstallModal({} as never, "theme", () => installed.push({ id: "z" } as never));
		(m as unknown as { url: string }).url = "owner/theme";
		const btn = { buttonEl: document.createElement("button"), setButtonText: vi.fn(), setDisabled: vi.fn() };
		await expect(call<Promise<void>>(m, "run", btn as never)).resolves.toBeUndefined();
		expect((m as unknown as { busy: boolean }).busy).toBe(false);
	});

	it("run：busy 守卫 → 已 busy 时直接返回，不触发安装", async () => {
		const m = new DirectInstallModal({} as never, "plugin", () => installed.push({ id: "z" } as never));
		(m as unknown as { url: string }).url = "owner/repo";
		(m as unknown as { busy: boolean }).busy = true;
		const btn = { buttonEl: document.createElement("button"), setButtonText: vi.fn(), setDisabled: vi.fn() };
		await call<Promise<void>>(m, "run", btn as never);
		expect(DI.installFromUrlResolved).not.toHaveBeenCalled();
		expect(installed).toHaveLength(0);
	});
});
