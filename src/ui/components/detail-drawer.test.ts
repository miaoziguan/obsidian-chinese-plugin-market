import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PluginDetailDrawer, type DrawerOptions } from "./detail-drawer";
import type { PluginInfo } from "@domain/catalog/translator";

/**
 * 详情抽屉的生命周期与判定逻辑。
 *
 * 这里挑的是「不依赖完整渲染」但最容易出错的部分：
 *   · close() 里那段「吞掉紧随点击」——曾经无条件吞全局下一个 click，
 *     导致关闭抽屉后第一次点搜索框清除按钮没反应（第二次才生效）
 *   · onKeydown 的 Esc 守卫——嵌套 Modal 打开时按 Esc 只能关最内层，
 *     否则用户刚浏览的 README/依赖上下文全丢
 *   · Tab trap 的兜底——重渲染后 activeElement 会回落 body，
 *     此时 first/last 边界判定永不成立，陷阱形同虚设
 */
const idleMock = vi.hoisted(() => ({ tasks: [] as Array<() => void> }));

vi.mock("@shared/platform", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@shared/platform")>();
	return {
		...actual,
		requestIdle: (fn: () => void) => {
			idleMock.tasks.push(fn);
			return 0;
		},
	};
});

vi.mock("@translation/platform/macos-shortcuts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@translation/platform/macos-shortcuts")>();
	return {
		...actual,
		isMacOS: () => false,
		macosSystemTranslate: vi.fn(async () => ""),
		splitMarkdownForTranslate: vi.fn(() => []),
	};
});

const info = (over: Partial<PluginInfo> = {}): PluginInfo => ({
	id: "p1",
	name: "插件一",
	description: "描述",
	author: "作者",
	...over,
});

function makeHost(over: Record<string, unknown> = {}) {
	return {
		settings: {
			favorites: [] as string[],
			useTransmart: false,
			secretId: "",
			secretKey: "",
			baiduAppId: "",
			baiduKey: "",
		},
		translator: {
			translateTextSegment: vi.fn(async (s: string) => `译:${s}`),
			getPluginTag: () => null,
		},
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
		openJournalView: vi.fn(),
		...over,
	} as unknown as Record<string, unknown>;
}

function makeOpts(over: Partial<DrawerOptions> = {}) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const opts = {
		app: { plugins: { manifests: { p1: { version: "1.2.3" } } } },
		plugin: makeHost() as never,
		info: info(),
		result: undefined,
		similar: [],
		triggerCard: null,
		openDetail: vi.fn(),
		toggleFavorite: vi.fn(() => true),
		container,
		onClose: vi.fn(),
		...over,
	} as unknown as DrawerOptions;
	return { opts, container };
}

const call = <T = unknown>(drawer: PluginDetailDrawer, method: string, ...args: unknown[]): T =>
	(drawer as unknown as Record<string, (...a: unknown[]) => T>)[method](...args);

const setField = (drawer: PluginDetailDrawer, key: string, value: unknown) => {
	(drawer as unknown as Record<string, unknown>)[key] = value;
};

const getField = <T = unknown>(drawer: PluginDetailDrawer, key: string): T =>
	(drawer as unknown as Record<string, T>)[key];

beforeEach(() => {
	idleMock.tasks = [];
	document.body.innerHTML = "";
});

afterEach(() => {
	vi.useRealTimers();
});

describe("构造与基础判定", () => {
	it("currentPluginId 跟随当前 info", () => {
		const { opts } = makeOpts();
		expect(new PluginDetailDrawer(opts).currentPluginId).toBe("p1");
	});

	it("从 Obsidian 内部 manifests 读本地版本号", () => {
		const { opts } = makeOpts();
		const drawer = new PluginDetailDrawer(opts);
		expect(call(drawer, "installedVersionOf", "p1")).toBe("1.2.3");
		expect(call(drawer, "installedVersionOf", "ghost")).toBeUndefined();
	});

	it("读不到内部结构时返回 undefined（不抛错）", () => {
		const { opts } = makeOpts({ app: {} as never });
		const drawer = new PluginDetailDrawer(opts);
		expect(call(drawer, "installedVersionOf", "p1")).toBeUndefined();
	});
});

describe("README 翻译通道判定", () => {
	const withSettings = (over: Record<string, unknown>) =>
		new PluginDetailDrawer(
			makeOpts({
				plugin: {
					...makeHost(),
					settings: {
						favorites: [],
						useTransmart: false,
						secretId: "",
						secretKey: "",
						baiduAppId: "",
						baiduKey: "",
						...over,
					},
				} as never,
			}).opts,
		);

	it("什么都没配时没有可用通道", () => {
		expect(call(withSettings({}), "availableReadmeChannels")).toEqual([]);
	});

	it("开启腾讯免费通道", () => {
		expect(call(withSettings({ useTransmart: true }), "availableReadmeChannels")).toEqual([
			"tencent-transmart",
		]);
	});

	it("腾讯云需要 id+key 同时存在", () => {
		expect(call(withSettings({ secretId: "id" }), "availableReadmeChannels")).toEqual([]);
		expect(call(withSettings({ secretId: "id", secretKey: "key" }), "availableReadmeChannels")).toEqual([
			"tencent",
		]);
	});

	it("百度需要 appid+key 同时存在", () => {
		expect(call(withSettings({ baiduAppId: "a", baiduKey: "k" }), "availableReadmeChannels")).toEqual([
			"baidu",
		]);
	});

	it("多通道按固定优先级排列（免费 > 腾讯云 > 百度）", () => {
		const drawer = withSettings({ useTransmart: true, secretId: "i", secretKey: "k", baiduAppId: "a", baiduKey: "b" });
		expect(call(drawer, "availableReadmeChannels")).toEqual([
			"tencent-transmart",
			"tencent",
			"baidu",
		]);
	});

	it("默认取第一个可用通道", () => {
		const drawer = withSettings({ secretId: "i", secretKey: "k", baiduAppId: "a", baiduKey: "b" });
		expect(call(drawer, "getCurrentReadmeChannel")).toBe("tencent");
	});

	it("无可用通道时返回 null", () => {
		expect(call(withSettings({}), "getCurrentReadmeChannel")).toBeNull();
	});

	it("会话内显式选择优先于默认", () => {
		const drawer = withSettings({ useTransmart: true, baiduAppId: "a", baiduKey: "b" });
		setField(drawer, "readmeChannel", "baidu");
		expect(call(drawer, "getCurrentReadmeChannel")).toBe("baidu");
	});

	it("四种通道各有独立文案（t 为真实实例，返回中文而非 key）", () => {
		const drawer = withSettings({});
		const labels = (["macos", "tencent", "baidu", "tencent-transmart"] as const).map((ch) =>
			String(call(drawer, "readmeChannelLabel", ch)),
		);

		expect(new Set(labels).size).toBe(4);
		for (const l of labels) expect(l.length).toBeGreaterThan(0);
	});
});

describe("README 分段翻译：失败时保留原文", () => {
	it("空文本直接返回空串", async () => {
		const { opts } = makeOpts();
		await expect(call(new PluginDetailDrawer(opts), "translateReadmeSegments", "", "tencent")).resolves.toBe("");
	});

	it("全部段失败时返回 null（不能把原文当译文交出去）", async () => {
		const host = makeHost({
			translator: { translateTextSegment: vi.fn(async (s: string) => s), getPluginTag: () => null },
		});
		const { opts } = makeOpts({ plugin: host as never });
		await expect(
			call(new PluginDetailDrawer(opts), "translateReadmeSegments", "hello", "tencent"),
		).resolves.toBeNull();
	});

	it("部分成功时保留失败段的原文（best-effort，别让整篇不可用）", async () => {
		let n = 0;
		const host = makeHost({
			translator: {
				translateTextSegment: vi.fn(async (s: string) => (n++ === 0 ? s : `译:${s}`)),
				getPluginTag: () => null,
			},
		});
		const { opts } = makeOpts({ plugin: host as never });
		// 超过 500 字才会分段；优先在换行处切断，故首段是含换行的那一小段
		const text = "第一段\n" + "b".repeat(600);
		const out = await call<string | null>(
			new PluginDetailDrawer(opts),
			"translateReadmeSegments",
			text,
			"tencent",
		);

		expect(out).not.toBeNull();
		expect(typeof out).toBe("string");
		// 失败段保留原文、成功段用译文
		expect(out).toContain("第一段");
	});
});

describe("嵌套 Modal 守卫", () => {
	it("没有 .modal-container 时视为无嵌套", () => {
		const { opts } = makeOpts();
		expect(call(new PluginDetailDrawer(opts), "hasOpenNestedModal")).toBe(false);
	});

	it("存在可见的 .modal-container 时视为有嵌套", () => {
		const el = document.createElement("div");
		el.className = "modal-container";
		// jsdom 里 offsetParent 恒为 null，用 getClientRects 非空模拟可见
		el.getClientRects = () => [{ width: 100, height: 100 } as DOMRect] as unknown as DOMRectList;
		document.body.appendChild(el);

		const { opts } = makeOpts();
		expect(call(new PluginDetailDrawer(opts), "hasOpenNestedModal")).toBe(true);
	});

	it("保留的空容器不算嵌套（否则 Esc 会彻底失效）", () => {
		const el = document.createElement("div");
		el.className = "modal-container";
		document.body.appendChild(el);

		const { opts } = makeOpts();
		expect(call(new PluginDetailDrawer(opts), "hasOpenNestedModal")).toBe(false);
	});
});

describe("键盘：Esc 与 Tab 焦点陷阱", () => {
	const esc = (over: Partial<KeyboardEvent> = {}) =>
		({ key: "Escape", defaultPrevented: false, preventDefault: vi.fn(), ...over }) as unknown as KeyboardEvent;

	it("Esc 关闭抽屉", () => {
		const { opts } = makeOpts();
		const drawer = new PluginDetailDrawer(opts);
		const close = vi.spyOn(drawer, "close");

		drawer["onKeydown"](esc());

		expect(close).toHaveBeenCalled();
	});

	it("嵌套 Modal 打开时 Esc 不关抽屉（只关最内层）", () => {
		const el = document.createElement("div");
		el.className = "modal-container";
		el.getClientRects = () => [{ width: 1, height: 1 } as DOMRect] as unknown as DOMRectList;
		document.body.appendChild(el);

		const { opts } = makeOpts();
		const drawer = new PluginDetailDrawer(opts);
		const close = vi.spyOn(drawer, "close");

		drawer["onKeydown"](esc());

		expect(close).not.toHaveBeenCalled();
	});

	it("已被内层处理过的事件不再插手", () => {
		const { opts } = makeOpts();
		const drawer = new PluginDetailDrawer(opts);
		const close = vi.spyOn(drawer, "close");

		drawer["onKeydown"](esc({ defaultPrevented: true }));

		expect(close).not.toHaveBeenCalled();
	});

	it("Tab 在最后一个元素上时回卷到第一个", () => {
		const drawerEl = document.createElement("div");
		const first = document.createElement("button");
		const last = document.createElement("button");
		drawerEl.append(first, last);
		document.body.appendChild(drawerEl);

		const { opts } = makeOpts();
		const drawer = new PluginDetailDrawer(opts);
		setField(drawer, "drawerEl", drawerEl);
		last.focus();

		const ev = { key: "Tab", shiftKey: false, defaultPrevented: false, preventDefault: vi.fn() } as unknown as KeyboardEvent;
		drawer["onKeydown"](ev);

		expect(ev.preventDefault).toHaveBeenCalled();
		expect(document.activeElement).toBe(first);
	});

	it("Shift+Tab 在第一个元素上时回卷到最后一个", () => {
		const drawerEl = document.createElement("div");
		const first = document.createElement("button");
		const last = document.createElement("button");
		drawerEl.append(first, last);
		document.body.appendChild(drawerEl);

		const { opts } = makeOpts();
		const drawer = new PluginDetailDrawer(opts);
		setField(drawer, "drawerEl", drawerEl);
		first.focus();

		const ev = { key: "Tab", shiftKey: true, defaultPrevented: false, preventDefault: vi.fn() } as unknown as KeyboardEvent;
		drawer["onKeydown"](ev);

		expect(ev.preventDefault).toHaveBeenCalled();
		expect(document.activeElement).toBe(last);
	});

	it("焦点跑到抽屉外时拉回首个元素（重渲染后的兜底）", () => {
		const drawerEl = document.createElement("div");
		const first = document.createElement("button");
		drawerEl.appendChild(first);
		document.body.appendChild(drawerEl);

		const outside = document.createElement("button");
		document.body.appendChild(outside);
		outside.focus();

		const { opts } = makeOpts();
		const drawer = new PluginDetailDrawer(opts);
		setField(drawer, "drawerEl", drawerEl);

		const ev = { key: "Tab", shiftKey: false, defaultPrevented: false, preventDefault: vi.fn() } as unknown as KeyboardEvent;
		drawer["onKeydown"](ev);

		expect(ev.preventDefault).toHaveBeenCalled();
		expect(document.activeElement).toBe(first);
	});

	it("抽屉内没有可聚焦元素时不处理 Tab", () => {
		const drawerEl = document.createElement("div");
		document.body.appendChild(drawerEl);

		const { opts } = makeOpts();
		const drawer = new PluginDetailDrawer(opts);
		setField(drawer, "drawerEl", drawerEl);

		const ev = { key: "Tab", shiftKey: false, defaultPrevented: false, preventDefault: vi.fn() } as unknown as KeyboardEvent;
		drawer["onKeydown"](ev);

		expect(ev.preventDefault).not.toHaveBeenCalled();
	});
});

describe("遮罩点击", () => {
	it("点在遮罩上关闭", () => {
		const { opts } = makeOpts();
		const drawer = new PluginDetailDrawer(opts);
		const backdrop = document.createElement("div");
		setField(drawer, "backdropEl", backdrop);
		const close = vi.spyOn(drawer, "close");

		drawer["onBackdropClick"]({ target: backdrop } as unknown as MouseEvent);

		expect(close).toHaveBeenCalled();
	});

	it("点在抽屉内容上不关闭", () => {
		const { opts } = makeOpts();
		const drawer = new PluginDetailDrawer(opts);
		setField(drawer, "backdropEl", document.createElement("div"));
		const close = vi.spyOn(drawer, "close");

		drawer["onBackdropClick"]({ target: document.createElement("div") } as unknown as MouseEvent);

		expect(close).not.toHaveBeenCalled();
	});
});

describe("close：清理、焦点恢复与「吞掉紧随点击」", () => {
	it("隐藏元素、清空历史并通知宿主", () => {
		const { opts } = makeOpts();
		const drawer = new PluginDetailDrawer(opts);
		const drawerEl = document.createElement("div");
		const backdropEl = document.createElement("div");
		document.body.append(drawerEl, backdropEl);
		setField(drawer, "drawerEl", drawerEl);
		setField(drawer, "backdropEl", backdropEl);
		setField(drawer, "_history", [{ info: info(), result: undefined, similar: [] }]);

		drawer.close();

		expect(drawerEl.style.display).toBe("none");
		expect(backdropEl.style.display).toBe("none");
		expect(getField(drawer, "_history")).toEqual([]);
		expect(opts.onClose).toHaveBeenCalled();
	});

	it("触发卡片仍在文档中时把焦点还给它", () => {
		const card = document.createElement("div");
		card.focus = vi.fn();
		document.body.appendChild(card);
		const { opts } = makeOpts({ triggerCard: card });
		const drawer = new PluginDetailDrawer(opts);

		drawer.close();

		expect(card.focus).toHaveBeenCalled();
	});

	it("触发卡片已被回收时按插件 id 找回新卡片（键盘用户不掉回 body）", () => {
		const oldCard = document.createElement("div");
		oldCard.setAttribute("data-plugin-id", "p1");
		const newCard = document.createElement("div");
		newCard.className = "pt-card";
		newCard.setAttribute("data-plugin-id", "p1");
		newCard.focus = vi.fn();
		document.body.appendChild(newCard);

		const { opts } = makeOpts({ triggerCard: oldCard });
		const drawer = new PluginDetailDrawer(opts);

		drawer.close();

		expect(newCard.focus).toHaveBeenCalled();
	});

	it("紧随其后的「会重开详情」的点击被吞掉（防双击 × 后立即重开）", () => {
		const { opts } = makeOpts();
		const drawer = new PluginDetailDrawer(opts);
		drawer.close();

		const card = document.createElement("div");
		card.className = "pt-card";
		document.body.appendChild(card);
		const bubble = vi.fn();
		document.addEventListener("click", bubble);

		card.dispatchEvent(new MouseEvent("click", { bubbles: true }));

		expect(bubble).not.toHaveBeenCalled();
		document.removeEventListener("click", bubble);
	});

	it("落在卡片内交互控件上的点击不被吞（否则关抽屉后第一次点按钮没反应）", () => {
		const { opts } = makeOpts();
		const drawer = new PluginDetailDrawer(opts);
		drawer.close();

		const card = document.createElement("div");
		card.className = "pt-card";
		const btn = document.createElement("button");
		card.appendChild(btn);
		document.body.appendChild(card);
		const bubble = vi.fn();
		document.addEventListener("click", bubble);

		btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));

		expect(bubble).toHaveBeenCalled();
		document.removeEventListener("click", bubble);
	});

	it("卡片外的点击（如搜索框清除按钮）同样不被吞", () => {
		const { opts } = makeOpts();
		const drawer = new PluginDetailDrawer(opts);
		drawer.close();

		const input = document.createElement("input");
		document.body.appendChild(input);
		const bubble = vi.fn();
		document.addEventListener("click", bubble);

		input.dispatchEvent(new MouseEvent("click", { bubbles: true }));

		expect(bubble).toHaveBeenCalled();
		document.removeEventListener("click", bubble);
	});

	it("空闲帧才做卸载（避免关闭帧被大 DOM 移除阻塞）", () => {
		const { opts } = makeOpts();
		const drawer = new PluginDetailDrawer(opts);
		const drawerEl = document.createElement("div");
		document.body.appendChild(drawerEl);
		setField(drawer, "drawerEl", drawerEl);

		drawer.close();
		expect(drawerEl.isConnected).toBe(true);
		expect(idleMock.tasks.length).toBe(1);

		idleMock.tasks[0]();
		expect(drawerEl.isConnected).toBe(false);
	});
});

describe("dispose：只释放资源，不触发 onClose", () => {
	it("执行登记过的清理函数", () => {
		const { opts } = makeOpts();
		const drawer = new PluginDetailDrawer(opts);
		const cleanup = vi.fn();
		setField(drawer, "_cleanupFns", [cleanup]);

		drawer.dispose();

		expect(cleanup).toHaveBeenCalled();
		expect(getField(drawer, "_cleanupFns")).toEqual([]);
	});

	it("不调用宿主的 onClose（由视图主动卸载时使用）", () => {
		const { opts } = makeOpts();
		const drawer = new PluginDetailDrawer(opts);

		drawer.dispose();

		expect(opts.onClose).not.toHaveBeenCalled();
	});
});
