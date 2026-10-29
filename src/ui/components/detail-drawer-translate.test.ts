import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PluginDetailDrawer, type DrawerOptions } from "./detail-drawer";
import type { PluginInfo } from "@domain/catalog/translator";
import { MarkdownRenderer, Notice } from "obsidian";
import { isMacOS, macosSystemTranslate, splitMarkdownForTranslate } from "@translation/platform/macos-shortcuts";

/**
 * README 系统翻译流程（sysTranslate + 通道解析 + translateReadmeSegments）。
 *
 * 这是「翻译正确性」的核心：把 README 拆成「结构块（不译）/ 文本块（可译）」，
 * 只把文本喂给引擎、结构原样拼回，且对失败段做 best-effort 保留原文。
 * 错误模式是「译文错乱 / 整篇回显 / 按钮状态不更新」——不抛错，只让用户
 * 拿到错误的翻译结果，属于静默退化。前一轮已覆盖 loadReadme 的加载与降级，
 * 这一轮覆盖「拿到原文后的翻译动作」。
 *
 * 策略：
 * - vi.mock("obsidian", importOriginal)：保留 Component/MarkdownRenderer，覆盖 requestUrl 为
 *   no-op、Notice 为可断言的记录型 vi.fn（便于校验 toast 文案与早退分支）。
 * - macos-shortcuts 的 isMacOS / macosSystemTranslate / splitMarkdownForTranslate 均做成
 *   可控 mock：默认「整篇一个文本块 + 腾讯云翻译返回 译:原文」，按需切换 macOS 通道或制造失败。
 * - @domain/catalog/mirror 的 rewriteReadmeUrls 返回原文（聚焦抽屉逻辑，不测 URL 重写）。
 * - @shared/i18n 的 makeT 回传 key，断言改用 key。
 */

const idleMock = vi.hoisted(() => ({ tasks: [] as Array<() => void> }));
const confirmMock = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));

vi.mock("@shared/platform", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@shared/platform")>();
	return { ...actual, requestIdle: (fn: () => void) => { idleMock.tasks.push(fn); return 0; } };
});

vi.mock("@translation/platform/macos-shortcuts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@translation/platform/macos-shortcuts")>();
	return {
		...actual,
		isMacOS: vi.fn(() => false),
		macosSystemTranslate: vi.fn(async (s: string) => `mac:${s}`),
		splitMarkdownForTranslate: vi.fn((md: string) => [{ value: md, isKeep: false }]),
	};
});

vi.mock("@ui/modals/confirm-modal", () => ({
	ConfirmModal: class {
		constructor(opts: Record<string, unknown>) {
			confirmMock.last = opts;
		}
		open() {}
	},
}));

vi.mock("@shared/i18n", () => ({
	makeT: () => (k: string) => String(k),
}));

vi.mock("obsidian", async (importOriginal) => {
	const actual = await importOriginal<typeof import("obsidian")>();
	return {
		...actual,
		requestUrl: vi.fn(async () => ({ status: 200, text: "" })) as unknown as typeof actual.requestUrl,
		Notice: vi.fn().mockImplementation((msg?: string) => ({ message: msg })),
	};
});

vi.mock("@domain/catalog/mirror", () => ({
	buildReadmeUrl: vi.fn((repo: string, _opts?: unknown, fileName?: string) => `https://raw.test/${repo}/${fileName ?? "README.md"}`),
	rewriteReadmeUrls: vi.fn((md: string) => md),
	classifyNetworkError: vi.fn(() => ({ kind: "blocked", message: "网络错误", suggestMirror: true })),
}));

const info = (over: Partial<PluginInfo> = {}): PluginInfo =>
	({ id: "p1", name: "插件一", description: "", author: "作者", repo: "user/plugin", ...over } as PluginInfo);

function makeHost(over: Record<string, unknown> = {}) {
	const baseSettings = {
		favorites: [] as string[],
		useTransmart: false,
		secretId: "",
		secretKey: "",
		baiduAppId: "",
		baiduKey: "",
		mirrorSource: "github" as const,
		mirrorCustomBase: "",
	};
	const { settings: overSettings, ...rest } = over;
	return {
		settings: { ...baseSettings, ...(overSettings as Record<string, unknown> | undefined) },
		translator: { translateTextSegment: vi.fn(async (s: string) => `译:${s}`), getPluginTag: () => null },
		saveTranslatorData: vi.fn(),
		scheduleIndexRefresh: vi.fn(),
		tmApprovedReady: Promise.resolve(),
		tmProgress: null,
		localModelState: { status: "idle", loaded: 0, total: 0 },
		recordInstallDiff: vi.fn(async () => {}),
		journalEnabled: () => false,
		loadJournalEntry: vi.fn(async () => null),
		saveJournalEntry: vi.fn(async () => {}),
		getInstallFacts: () => undefined,
		journalTriedIds: new Set<string>(),
		journalEntryIds: new Set<string>(),
		openJournalView: vi.fn(),
		...rest,
	} as unknown as Record<string, unknown>;
}

function makeApp(plugins?: { manifests?: Record<string, { version: string }>; enabledPlugins?: Set<string> }) {
	return {
		plugins: {
			manifests: plugins?.manifests ?? {},
			enabledPlugins: plugins?.enabledPlugins ?? new Set<string>(),
		},
	} as never;
}

function makeBtn(): HTMLElement {
	const b = document.createElement("button");
	const l = document.createElement("span");
	l.className = "pt-detail-btn-label";
	b.appendChild(l);
	return b;
}

function makeDrawer(over: Partial<DrawerOptions> = {}) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const opts = {
		app: makeApp(),
		plugin: makeHost(),
		info: info(),
		result: undefined,
		similar: [] as never[],
		triggerCard: null,
		openDetail: vi.fn(),
		toggleFavorite: vi.fn(() => true),
		container,
		onClose: vi.fn(),
		...over,
	} as unknown as DrawerOptions;
	const drawer = new PluginDetailDrawer(opts);
	(drawer as unknown as Record<string, unknown>).drawerEl = document.createElement("div");
	(drawer as unknown as Record<string, unknown>).backdropEl = document.createElement("div");
	return { drawer, opts, container };
}

const call = <T = unknown>(drawer: PluginDetailDrawer, method: string, ...args: unknown[]): T =>
	(drawer as unknown as Record<string, (...a: unknown[]) => T>)[method](...args);

beforeEach(() => {
	document.body.innerHTML = "";
	vi.mocked(splitMarkdownForTranslate).mockImplementation((md: string) => [{ value: md, isKeep: false }]);
	vi.mocked(macosSystemTranslate).mockImplementation(async (s: string) => `mac:${s}`);
	vi.mocked(isMacOS).mockReturnValue(false);
	vi.spyOn(MarkdownRenderer, "render");
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("sysTranslate 守卫与通道解析", () => {
	it("无原文 → 提示加载中，不发起翻译", async () => {
		const { drawer, opts } = makeDrawer({ info: info({ repo: "u/p" }) });
		const host = opts.plugin as unknown as { translator: { translateTextSegment: ReturnType<typeof vi.fn> } };
		const btn = makeBtn();
		(drawer as unknown as Record<string, unknown>).readmeBodyEl = document.createElement("div");
		(drawer as unknown as Record<string, unknown>).readmeSysBtnEl = btn;
		await call(drawer, "sysTranslate", btn);
		expect(Notice).toHaveBeenCalledWith("detail.readme.loading");
		expect(host.translator.translateTextSegment).not.toHaveBeenCalled();
	});

	it("无可用通道 → 提示无通道，不发起翻译", async () => {
		// 默认 settings：useTransmart=false、无密钥、非 macOS → 无通道
		const { drawer, opts } = makeDrawer({ info: info({ repo: "u/p" }) });
		const host = opts.plugin as unknown as { translator: { translateTextSegment: ReturnType<typeof vi.fn> } };
		const btn = makeBtn();
		(drawer as unknown as Record<string, unknown>).readmeRaw = "# Hello";
		(drawer as unknown as Record<string, unknown>).readmeBodyEl = document.createElement("div");
		(drawer as unknown as Record<string, unknown>).readmeSysBtnEl = btn;
		await call(drawer, "sysTranslate", btn);
		expect(Notice).toHaveBeenCalledWith("detail.readme.noChannel");
		expect(host.translator.translateTextSegment).not.toHaveBeenCalled();
	});

	it("已翻译状态再点 → 切回原文，不重新翻译", async () => {
		const { drawer, opts } = makeDrawer({ info: info({ repo: "u/p" }), plugin: makeHost({ settings: { useTransmart: true } }) as never });
		const host = opts.plugin as unknown as { translator: { translateTextSegment: ReturnType<typeof vi.fn> } };
		const btn = makeBtn();
		const raw = "# Hello";
		(drawer as unknown as Record<string, unknown>).readmeRaw = raw;
		(drawer as unknown as Record<string, unknown>).readmeBodyEl = document.createElement("div");
		(drawer as unknown as Record<string, unknown>).readmeSysBtnEl = btn;
		(drawer as unknown as Record<string, unknown>).readmeTranslated = true;
		await call(drawer, "sysTranslate", btn);
		expect((drawer as unknown as { readmeTranslated: boolean }).readmeTranslated).toBe(false);
		expect(host.translator.translateTextSegment).not.toHaveBeenCalled();
		// 渲染回原文
		expect(MarkdownRenderer.render).toHaveBeenCalledWith(
			opts.app,
			raw,
			(drawer as unknown as { readmeBodyEl: HTMLElement }).readmeBodyEl,
			expect.stringContaining("u/p"),
			expect.anything(),
		);
		// 按钮文案回退为通道名（tencent-transmart）
		expect(btn.querySelector(".pt-detail-btn-label")!.textContent).toBe("channel.tencentTransmart");
	});
});

describe("sysTranslate 成功与降级路径", () => {
	it("腾讯免费通道：文本块翻译后拼回并渲染，按钮切到「返回原文」", async () => {
		const { drawer, opts } = makeDrawer({ info: info({ repo: "u/p" }), plugin: makeHost({ settings: { useTransmart: true } }) as never });
		const host = opts.plugin as unknown as { translator: { translateTextSegment: ReturnType<typeof vi.fn> } };
		const btn = makeBtn();
		const raw = "# Hello\n\nSome text to translate.";
		(drawer as unknown as Record<string, unknown>).readmeRaw = raw;
		(drawer as unknown as Record<string, unknown>).readmeBodyEl = document.createElement("div");
		(drawer as unknown as Record<string, unknown>).readmeSysBtnEl = btn;
		await call(drawer, "sysTranslate", btn);
		expect((drawer as unknown as { readmeTranslated: boolean }).readmeTranslated).toBe(true);
		// 整篇作为单文本块交给翻译通道
		expect(host.translator.translateTextSegment).toHaveBeenCalledWith(raw, "tencent-transmart");
		// 翻译结果包含译文前缀
		expect(MarkdownRenderer.render).toHaveBeenCalledWith(
			opts.app,
			expect.stringContaining("译:"),
			(drawer as unknown as { readmeBodyEl: HTMLElement }).readmeBodyEl,
			expect.stringContaining("u/p"),
			expect.anything(),
		);
		// 按钮文案与 loading 状态复位
		expect(btn.querySelector(".pt-detail-btn-label")!.textContent).toBe("detail.readme.backOriginal");
		expect(btn.classList.contains("pt-detail-btn--loading")).toBe(false);
		expect(Notice).toHaveBeenCalledWith("card.sysTranslate.done");
	});

	it("整篇都是结构块（无可译文本）→ 按原文渲染完成，不算失败", async () => {
		const { drawer, opts } = makeDrawer({ info: info({ repo: "u/p" }), plugin: makeHost({ settings: { useTransmart: true } }) as never });
		const host = opts.plugin as unknown as { translator: { translateTextSegment: ReturnType<typeof vi.fn> } };
		const btn = makeBtn();
		const raw = "![img](x.png)";
		vi.mocked(splitMarkdownForTranslate).mockReturnValue([{ value: raw, isKeep: true }]);
		(drawer as unknown as Record<string, unknown>).readmeRaw = raw;
		(drawer as unknown as Record<string, unknown>).readmeBodyEl = document.createElement("div");
		(drawer as unknown as Record<string, unknown>).readmeSysBtnEl = btn;
		await call(drawer, "sysTranslate", btn);
		expect((drawer as unknown as { readmeTranslated: boolean }).readmeTranslated).toBe(true);
		expect(host.translator.translateTextSegment).not.toHaveBeenCalled();
		expect(MarkdownRenderer.render).toHaveBeenCalledWith(
			opts.app,
			raw,
			(drawer as unknown as { readmeBodyEl: HTMLElement }).readmeBodyEl,
			expect.stringContaining("u/p"),
			expect.anything(),
		);
	});

	it("全部文本块翻译失败 → 提示整体失败，不写回译文", async () => {
		const { drawer, opts } = makeDrawer({ info: info({ repo: "u/p" }), plugin: makeHost({ settings: { useTransmart: true } }) as never });
		const host = opts.plugin as unknown as { translator: { translateTextSegment: ReturnType<typeof vi.fn> } };
		host.translator.translateTextSegment = vi.fn(async (s: string) => s); // 原文回显 = 失败
		const btn = makeBtn();
		const raw = "hello";
		(drawer as unknown as Record<string, unknown>).readmeRaw = raw;
		(drawer as unknown as Record<string, unknown>).readmeBodyEl = document.createElement("div");
		(drawer as unknown as Record<string, unknown>).readmeSysBtnEl = btn;
		await call(drawer, "sysTranslate", btn);
		expect((drawer as unknown as { readmeTranslated: boolean }).readmeTranslated).toBeFalsy();
		expect(Notice).toHaveBeenCalledWith("detail.readme.translateFailed");
		expect(MarkdownRenderer.render).not.toHaveBeenCalled();
	});

	it("部分文本块失败 → 已译段保留、提示部分失败（含失败段数）", async () => {
		const { drawer, opts } = makeDrawer({ info: info({ repo: "u/p" }), plugin: makeHost({ settings: { useTransmart: true } }) as never });
		const host = opts.plugin as unknown as { translator: { translateTextSegment: ReturnType<typeof vi.fn> } };
		// 第一个块成功，第二个块原文回显（失败）
		host.translator.translateTextSegment = vi.fn(async (s: string) => (s.includes("FAIL") ? s : `译:${s}`));
		vi.mocked(splitMarkdownForTranslate).mockReturnValue([
			{ value: "good", isKeep: false },
			{ value: "FAIL", isKeep: false },
		]);
		const btn = makeBtn();
		(drawer as unknown as Record<string, unknown>).readmeRaw = "good FAIL";
		(drawer as unknown as Record<string, unknown>).readmeBodyEl = document.createElement("div");
		(drawer as unknown as Record<string, unknown>).readmeSysBtnEl = btn;
		await call(drawer, "sysTranslate", btn);
		expect((drawer as unknown as { readmeTranslated: boolean }).readmeTranslated).toBe(true);
		expect(Notice).toHaveBeenCalledWith("card.sysTranslate.partial".replace("{n}", "1"));
	});

	it("macOS 通道：走 macosSystemTranslate，不调云端翻译", async () => {
		const { drawer, opts } = makeDrawer({ info: info({ repo: "u/p" }) });
		const host = opts.plugin as unknown as { translator: { translateTextSegment: ReturnType<typeof vi.fn> } };
		vi.mocked(isMacOS).mockReturnValue(true); // 通道解析得到 "macos"
		const btn = makeBtn();
		const raw = "hi";
		(drawer as unknown as Record<string, unknown>).readmeRaw = raw;
		(drawer as unknown as Record<string, unknown>).readmeBodyEl = document.createElement("div");
		(drawer as unknown as Record<string, unknown>).readmeSysBtnEl = btn;
		await call(drawer, "sysTranslate", btn);
		expect(macosSystemTranslate).toHaveBeenCalledWith(raw);
		expect(host.translator.translateTextSegment).not.toHaveBeenCalled();
		expect(MarkdownRenderer.render).toHaveBeenCalledWith(
			opts.app,
			expect.stringContaining("mac:"),
			(drawer as unknown as { readmeBodyEl: HTMLElement }).readmeBodyEl,
			expect.stringContaining("u/p"),
			expect.anything(),
		);
	});
});
