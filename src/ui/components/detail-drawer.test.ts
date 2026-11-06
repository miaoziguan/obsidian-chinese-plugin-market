import { describe, it, expect, vi, afterEach } from "vitest";
import { PluginDetailDrawer } from "@ui/components/detail-drawer";
import type { ReadmeChannel } from "@ui/components/detail-drawer";
import { isMacOS } from "@translation/platform/macos-shortcuts";

// 测试环境下用可控 stub 替换运行时依赖，使 new PluginDetailDrawer 与可独立调用的纯方法可运行。
// 部分 mock：保留真实 obsidian 的全部导出（App/Modal/Component/MarkdownRenderer/Notice/Menu/
// Platform 等），只覆盖运行时不安全或默认会抛错/联网的 requestUrl、setIcon。
// 委托模块（confirm-modal 的 Modal 子类、view-cards、dep-section 等）顶层 import 的 obsidian 符号
// 全部由真实包提供，无需逐个补全。
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		requestUrl: vi.fn(),
		setIcon: vi.fn(),
	};
});

vi.mock("@shared/platform", () => ({
	requestIdle: vi.fn(),
	isMobileEnvironment: () => false,
	isTouchEnvironment: () => false,
}));

vi.mock("@translation/platform/macos-shortcuts", () => ({
	isMacOS: vi.fn(() => false),
	macosSystemTranslate: vi.fn(),
	splitMarkdownForTranslate: vi.fn(),
}));

/** 调用私有方法（绕过 TS 可见性检查，不引入 any） */
const call = <T,>(d: PluginDetailDrawer, m: string, ...args: never[]): T =>
	(d as unknown as Record<string, (...a: never[]) => T>)[m](...args);

const makeDrawer = (overrides: Record<string, unknown> = {}) => {
	const settings = {
		useTransmart: true,
		secretId: "id",
		secretKey: "key",
		baiduAppId: "aid",
		baiduKey: "bk",
		favorites: [] as string[],
		...(overrides.settings || {}),
	};
	const plugin = { settings, translator: { translateTextSegment: vi.fn() } } as unknown as never;
	const info = { id: "x", name: "X" } as unknown as never;
	const container = document.createElement("div");
	const opts = {
		app: {},
		plugin,
		info,
		result: undefined,
		similar: [] as never[],
		triggerCard: null,
		openDetail: vi.fn(),
		installPlugin: vi.fn(),
		uninstallPlugin: vi.fn(),
		toggleFavorite: vi.fn(),
		isFavorited: vi.fn().mockReturnValue(false),
		installedIds: new Set<string>(),
		container,
		onClose: vi.fn(),
		mode: "overlay",
		...(overrides.settings ? { settings } : {}),
		...overrides,
	} as unknown as never;
	const drawer = new PluginDetailDrawer(opts);
	const onClose = (opts as unknown as { onClose: () => void }).onClose;
	return { drawer, onClose, settings };
};

describe("PluginDetailDrawer · 可独立调用的纯方法（不触发完整 DOM 渲染）", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("constructor + currentPluginId 返回 info.id", () => {
		const { drawer } = makeDrawer();
		expect((drawer as unknown as { currentPluginId: string }).currentPluginId).toBe("x");
	});

	it("availableReadmeChannels：全开 → [transmart, tencent, baidu]", () => {
		const { drawer } = makeDrawer();
		expect(call<ReadmeChannel[]>(drawer, "availableReadmeChannels")).toEqual([
			"tencent-transmart",
			"tencent",
			"baidu",
		]);
	});

	it("availableReadmeChannels：关闭 useTransmart → 不含 tencent-transmart", () => {
		const { drawer } = makeDrawer({ settings: { useTransmart: false } });
		const r = call<ReadmeChannel[]>(drawer, "availableReadmeChannels");
		expect(r).not.toContain("tencent-transmart");
		expect(r).toContain("tencent");
	});

	it("availableReadmeChannels：无 secretId/Key → 不含 tencent", () => {
		const { drawer } = makeDrawer({ settings: { secretId: "", secretKey: "" } });
		expect(call<ReadmeChannel[]>(drawer, "availableReadmeChannels")).not.toContain("tencent");
	});

	it("availableReadmeChannels：无 baidu 凭据 → 不含 baidu", () => {
		const { drawer } = makeDrawer({ settings: { baiduAppId: "", baiduKey: "" } });
		expect(call<ReadmeChannel[]>(drawer, "availableReadmeChannels")).not.toContain("baidu");
	});

	it("availableReadmeChannels：isMacOS=true → 含 macos 通道", () => {
		vi.mocked(isMacOS).mockReturnValue(true);
		const { drawer } = makeDrawer();
		expect(call<ReadmeChannel[]>(drawer, "availableReadmeChannels")).toContain("macos");
	});

	it("getCurrentReadmeChannel：未显式选择 → 首个可用通道", () => {
		const { drawer } = makeDrawer();
		expect(call<ReadmeChannel | null>(drawer, "getCurrentReadmeChannel")).toBe("tencent-transmart");
	});

	it("getCurrentReadmeChannel：已显式选择 → 返回所选", () => {
		const { drawer } = makeDrawer();
		(drawer as unknown as { readmeChannel: ReadmeChannel | null }).readmeChannel = "baidu";
		expect(call<ReadmeChannel | null>(drawer, "getCurrentReadmeChannel")).toBe("baidu");
	});

	it("readmeChannelLabel：各通道返回非空字符串", () => {
		const { drawer } = makeDrawer();
		const labels = (["tencent-transmart", "tencent", "baidu", "macos"] as ReadmeChannel[]).map((c) =>
			call<string>(drawer, "readmeChannelLabel", c as never),
		);
		expect(labels.every((l) => typeof l === "string" && l.length > 0)).toBe(true);
	});

	it("hasOpenNestedModal：无 modal → false", () => {
		const { drawer } = makeDrawer();
		expect(call<boolean>(drawer, "hasOpenNestedModal")).toBe(false);
	});

	it("hasOpenNestedModal：存在可见 modal-container → true", () => {
		const { drawer } = makeDrawer();
		const m = document.createElement("div");
		m.className = "modal-container";
		m.getClientRects = () => [{ width: 1, height: 1 } as DOMRect] as unknown as DOMRectList;
		document.body.appendChild(m);
		expect(call<boolean>(drawer, "hasOpenNestedModal")).toBe(true);
	});

	it("onBackdropClick：target 即 backdropEl → 触发 onCloseCb", () => {
		const { drawer, onClose } = makeDrawer();
		const backdrop = document.createElement("div");
		(drawer as unknown as { backdropEl: HTMLElement | null }).backdropEl = backdrop;
		call<void>(drawer, "onBackdropClick", { target: backdrop } as never);
		expect(onClose).toHaveBeenCalled();
	});

	it("onBackdropClick：target 非 backdropEl → 不触发 onCloseCb", () => {
		const { drawer, onClose } = makeDrawer();
		const backdrop = document.createElement("div");
		(drawer as unknown as { backdropEl: HTMLElement | null }).backdropEl = backdrop;
		call<void>(drawer, "onBackdropClick", {
			target: document.createElement("div"),
		} as never);
		expect(onClose).not.toHaveBeenCalled();
	});

	it("onKeydown：Escape 且无嵌套 modal → 触发 onCloseCb", () => {
		const { drawer, onClose } = makeDrawer();
		call<void>(drawer, "onKeydown", {
			key: "Escape",
			defaultPrevented: false,
		} as never);
		expect(onClose).toHaveBeenCalled();
	});

	it("onKeydown：Escape 但存在嵌套 modal → 不触发 onCloseCb", () => {
		const { drawer, onClose } = makeDrawer();
		const m = document.createElement("div");
		m.className = "modal-container";
		m.getClientRects = () => [{ width: 1, height: 1 } as DOMRect] as unknown as DOMRectList;
		document.body.appendChild(m);
		call<void>(drawer, "onKeydown", {
			key: "Escape",
			defaultPrevented: false,
		} as never);
		expect(onClose).not.toHaveBeenCalled();
	});

	it("setSimilar：仅更新内部状态（骨架分支跳过渲染）不崩", () => {
		const { drawer } = makeDrawer();
		expect(() => drawer.setSimilar([{ id: "y", name: "Y" }] as never[])).not.toThrow();
	});

	it("close：drawerEl/backdropEl 为 null 时仍安全且触发 onCloseCb", () => {
		const { drawer, onClose } = makeDrawer();
		drawer.close();
		expect(onClose).toHaveBeenCalled();
	});

	it("dispose：renderComp 为 null 时不崩", () => {
		const { drawer } = makeDrawer();
		expect(() => drawer.dispose()).not.toThrow();
	});

	it("focusJournalArea：drawerEl 为 null 时不崩", () => {
		const { drawer } = makeDrawer();
		expect(() => drawer.focusJournalArea()).not.toThrow();
	});
});
