import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PluginDetailDrawer, type DrawerOptions } from "./detail-drawer";
import type { PluginInfo } from "@domain/catalog/translator";
import { MarkdownRenderer, requestUrl } from "obsidian";

/**
 * README 加载 / 渲染 / 网络错误降级。
 *
 * 这一轮打的是 detail-drawer 里「最危险却最没覆盖」的网络分支：
 * loadReadme 真去拉 GitHub README（大小写 fallback、会话缓存、错误分类与降级 UI）。
 * 这些分支一旦出错，用户看到的是空白 README 或整页报错，而不是崩溃——
 * 属于「静默退化」，正好是被覆盖率漏斗漏掉的那一类。
 *
 * 策略：
 * - 通过 vi.mock("obsidian", importOriginal) 保留 Component/MarkdownRenderer/Notice 等，
 *   只覆盖 requestUrl 为可控 mock（避免误连真实网络）。
 * - 通过 vi.mock("@domain/catalog/mirror") 控制 buildReadmeUrl / classifyNetworkError，
 *   把测试聚焦在抽屉自身的分支逻辑，而不是镜像 URL 拼装细节。
 */

const idleMock = vi.hoisted(() => ({ tasks: [] as Array<() => void> }));
const confirmMock = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));

vi.mock("@shared/platform", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@shared/platform")>();
	return { ...actual, requestIdle: (fn: () => void) => { idleMock.tasks.push(fn); return 0; } };
});

vi.mock("@translation/platform/macos-shortcuts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@translation/platform/macos-shortcuts")>();
	return { ...actual, isMacOS: () => false, macosSystemTranslate: vi.fn(async () => ""), splitMarkdownForTranslate: vi.fn(() => []) };
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

// 保留 obsidian mock 的真实导出（Component / MarkdownRenderer / Notice / setIcon …），
// 仅覆盖 requestUrl：默认抛错会污染全仓，这里改成可控 mock。
vi.mock("obsidian", async (importOriginal) => {
	const actual = await importOriginal<typeof import("obsidian")>();
	return {
		...actual,
		requestUrl: vi.fn(async () => ({ status: 200, text: "" })) as unknown as typeof actual.requestUrl,
	};
});

vi.mock("@domain/catalog/mirror", () => ({
	buildReadmeUrl: vi.fn((repo: string, _opts?: unknown, fileName?: string) => `https://raw.test/${repo}/${fileName ?? "README.md"}`),
	rewriteReadmeUrls: vi.fn((md: string) => md),
	classifyNetworkError: vi.fn(() => ({ message: "网络错误", suggestMirror: true })),
}));

// obsidian 测试 mock 把 createDiv/createEl/createSpan 只挂成全局函数，没挂到
// HTMLElement.prototype（源码以 this.el.createDiv(...) 调用）。这里局部补齐原型方法。
// 注意：只在本测试文件的 worker 内生效，不会像 setup.ts 那样跨文件泄漏。
type ElInfo = { cls?: string | string[]; text?: string; attr?: Record<string, string> } | string | undefined;
function applyElInfo(el: HTMLElement, o: ElInfo) {
	if (!o) return;
	if (typeof o === "string") {
		el.textContent = o;
		return;
	}
	if (o.cls) {
		const cls = Array.isArray(o.cls) ? o.cls : String(o.cls).split(/\s+/);
		cls.filter(Boolean).forEach((c) => el.classList.add(c));
	}
	if (o.text != null) el.textContent = o.text;
	if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, String(v));
}
if (!(HTMLElement.prototype as unknown as { createDiv?: unknown }).createDiv) {
	const proto = HTMLElement.prototype as unknown as {
		createDiv: (o?: ElInfo) => HTMLElement;
		createEl: (tag: string, o?: ElInfo) => HTMLElement;
		createSpan: (o?: ElInfo) => HTMLElement;
	};
	proto.createDiv = function (o) {
		const el = document.createElement("div");
		applyElInfo(el, o);
		this.appendChild(el);
		return el;
	};
	proto.createEl = function (tag, o) {
		const el = document.createElement(tag);
		applyElInfo(el, o);
		this.appendChild(el);
		return el;
	};
	proto.createSpan = function (o) {
		const el = document.createElement("span");
		applyElInfo(el, o);
		this.appendChild(el);
		return el;
	};
}

import { buildReadmeUrl, classifyNetworkError } from "@domain/catalog/mirror";

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
	requestUrlMock().mockReset();
	requestUrlMock().mockResolvedValue({ status: 200, text: "" });
	vi.mocked(classifyNetworkError).mockReturnValue({ kind: "blocked", message: "网络错误", suggestMirror: true });
	vi.mocked(buildReadmeUrl).mockClear();
	// MarkdownRenderer.render 在 mock 工厂里是普通函数，必须包装成 spy 才能断言调用
	vi.spyOn(MarkdownRenderer, "render");
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function requestUrlMock() {
	return requestUrl as unknown as ReturnType<typeof vi.fn>;
}

describe("loadReadme 同步守卫", () => {
	it("无 repo → 直接渲染「无仓库」占位，不发网络请求", async () => {
		const { drawer, container } = makeDrawer({ info: info({ repo: undefined }) });
		await call(drawer, "loadReadme", container);
		expect(requestUrlMock()).not.toHaveBeenCalled();
		expect(container.querySelector(".pt-detail-readme-empty")).not.toBeNull();
		expect(container.querySelector(".pt-detail-readme-empty")!.textContent).toBe("detail.readme.noRepo");
	});

	it("buildReadmeUrl 返回空 → 渲染「无可用地址」占位", async () => {
		vi.mocked(buildReadmeUrl).mockReturnValueOnce(null as unknown as string);
		const { drawer, container } = makeDrawer({ info: info({ repo: "repo/nourl" }) });
		await call(drawer, "loadReadme", container);
		expect(requestUrlMock()).not.toHaveBeenCalled();
		expect(container.querySelector(".pt-detail-readme-empty")!.textContent).toBe("detail.readme.noUrl");
	});

	it("抽屉已关闭 → 立即返回，不发请求也不渲染", async () => {
		const { drawer, container } = makeDrawer({ info: info({ repo: "repo/closed" }) });
		(drawer as unknown as Record<string, unknown>).drawerEl = null;
		await call(drawer, "loadReadme", container);
		expect(requestUrlMock()).not.toHaveBeenCalled();
		expect(container.children.length).toBe(0);
	});
});

describe("loadReadme 网络成功路径", () => {
	it("README.md 命中 → 缓存原文并渲染（不再残留 loading）", async () => {
		requestUrlMock().mockResolvedValue({ status: 200, text: "# Hello" });
		const { drawer, opts, container } = makeDrawer({ info: info({ repo: "repo/success" }) });
		await call(drawer, "loadReadme", container);
		expect((drawer as unknown as { readmeRaw: string | null }).readmeRaw).toBe("# Hello");
		expect(requestUrlMock()).toHaveBeenCalledTimes(1);
		expect(container.querySelector(".pt-detail-readme-loading")).toBeNull();
		expect(MarkdownRenderer.render).toHaveBeenCalledWith(
			opts.app,
			"# Hello",
			container,
			expect.stringContaining("repo/success"),
			expect.anything(),
		);
	});

	it("README.md 404 后依次尝试 readme.md / Readme.md，最终命中", async () => {
		requestUrlMock()
			.mockResolvedValueOnce({ status: 404, text: "" })
			.mockResolvedValueOnce({ status: 404, text: "" })
			.mockResolvedValueOnce({ status: 200, text: "# fallback" });
		const { drawer, container } = makeDrawer({ info: info({ repo: "repo/fallback" }) });
		await call(drawer, "loadReadme", container);
		expect(requestUrlMock()).toHaveBeenCalledTimes(3);
		expect((drawer as unknown as { readmeRaw: string | null }).readmeRaw).toBe("# fallback");
		expect(MarkdownRenderer.render).toHaveBeenCalled();
	});

	it("会话级缓存：同一 url 第二次打开不再请求", async () => {
		requestUrlMock().mockResolvedValue({ status: 200, text: "# cached" });
		const { drawer, container } = makeDrawer({ info: info({ repo: "repo/cache" }) });
		await call(drawer, "loadReadme", container);
		expect(requestUrlMock()).toHaveBeenCalledTimes(1);
		const c2 = document.createElement("div");
		await call(drawer, "loadReadme", c2);
		expect(requestUrlMock()).toHaveBeenCalledTimes(1); // 命中缓存，未二次拉取
	});
});

describe("loadReadme 空结果与错误降级", () => {
	it("三个候选全部 404 → 渲染「空 README」且不渲染正文", async () => {
		requestUrlMock().mockResolvedValue({ status: 404, text: "" });
		const { drawer, container } = makeDrawer({ info: info({ repo: "repo/empty" }) });
		await call(drawer, "loadReadme", container);
		expect(requestUrlMock()).toHaveBeenCalledTimes(3);
		expect(container.querySelector(".pt-detail-readme-empty")!.textContent).toBe("detail.readme.empty");
		expect(MarkdownRenderer.render).not.toHaveBeenCalled();
	});

	it("网络错误 → 渲染错误框 + 重试按钮；重试会再次请求", async () => {
		requestUrlMock().mockRejectedValueOnce(new Error("ECONNREFUSED"));
		requestUrlMock().mockResolvedValueOnce({ status: 200, text: "# retry" });
		const { drawer, container } = makeDrawer({ info: info({ repo: "repo/err" }) });
		await call(drawer, "loadReadme", container);
		const box = container.querySelector(".pt-detail-readme-error");
		expect(box).not.toBeNull();
		// 受限提示文案（源码硬编码中文，不依赖 i18n）
		expect(box!.textContent).toContain("镜像源");
		expect(classifyNetworkError).toHaveBeenCalled();
		const retry = box!.querySelector<HTMLElement>(".pt-detail-readme-error-actions .pt-detail-btn");
		expect(retry).not.toBeNull();
		await retry!.click();
		expect(requestUrlMock()).toHaveBeenCalledTimes(2); // 重试触发第二次拉取
	});

	it("网络错误但无需切镜像源 → 错误框不提示镜像源", async () => {
		requestUrlMock().mockRejectedValueOnce(new Error("timeout"));
		vi.mocked(classifyNetworkError).mockReturnValueOnce({ kind: "timeout", message: "超时", suggestMirror: false });
		const { drawer, container } = makeDrawer({ info: info({ repo: "repo/err2" }) });
		await call(drawer, "loadReadme", container);
		const box = container.querySelector(".pt-detail-readme-error")!;
		expect(box.textContent).not.toContain("镜像源");
	});
});

describe("renderReadme", () => {
	it("清空容器后用 MarkdownRenderer 渲染（链接前缀含仓库）", () => {
		const { drawer, opts, container } = makeDrawer({ info: info({ repo: "repo/render" }) });
		container.appendChild(document.createElement("div")); // 预置内容，验证被清空
		call(drawer, "renderReadme", container, "# 标题", "repo/render");
		expect(container.textContent).toBe("");
		expect(MarkdownRenderer.render).toHaveBeenCalledWith(
			opts.app,
			"# 标题",
			container,
			expect.stringContaining("repo/render"),
			expect.anything(),
		);
	});
});
