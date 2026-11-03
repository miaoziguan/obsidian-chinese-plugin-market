import { describe, it, expect, vi, beforeEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";

/**
 * 补 app/plugin.ts 的 showRibbonMenu（1291-1335），重点是右侧 ribbon 长按菜单里两个
 * 「从直链安装」入口的 onClick（1319-1321 / 1329-1331）。既有 plugin*.test.ts 从没触发过
 * 这个方法——错误模式是「桌面端右键 ribbon 图标，菜单里『从直链装插件 / 装主题』点了没反应」。
 *
 * 手法：obsidian 的 Menu 换成可控哑类——addItem(cb) 立即以 FakeItem 调 cb，FakeItem 的 onClick
 * 捕获回调供测试触发；@app/direct-install 的 DirectInstallModal 换成「构造即记录、open() 触发传入的
 * onRename/安装回调」的桩；openTranslatorView/applyProfile/recordBetaInstall/openJournalView 经
 * Object.assign 打桩；私人方法经 AnyPlugin 转型访问。
 */

const menuState = vi.hoisted(() => ({ clicks: [] as Array<() => void> }));
vi.mock("obsidian", async (importOriginal) => {
	class FakeItem {
		onClick(fn: () => void): this {
			menuState.clicks.push(fn);
			return this;
		}
		setTitle(): this {
			return this;
		}
		setIcon(): this {
			return this;
		}
	}
	const MenuMock = class {
		addItem(cb: (item: FakeItem) => void): this {
			cb(new FakeItem() as never);
			return this;
		}
		addSeparator(): this {
			return this;
		}
		showAtMouseEvent(): this {
			return this;
		}
	};
	return { ...(await importOriginal<Record<string, unknown>>()), Menu: MenuMock };
});

const directInstall = vi.hoisted(() => {
	const cls = vi.fn(function (this: { open: ReturnType<typeof vi.fn> }, _app: unknown, _kind: unknown, cb: () => void) {
		this.open = vi.fn(() => cb());
	});
	return { cls };
});
vi.mock("@app/direct-install", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	DirectInstallModal: directInstall.cls,
}));

type AnyPlugin = Record<string, any>;

function makePlugin(extra: Record<string, any> = {}) {
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		app: { workspace: { getLeavesOfType: vi.fn(() => []) } },
		settings: { profiles: [{ name: "p1" }], manage: { enabled: true } },
		openTranslatorView: vi.fn(),
		applyProfile: vi.fn(),
		recordBetaInstall: vi.fn(),
		openJournalView: vi.fn(),
		...extra,
	});
	return plugin;
}

beforeEach(() => {
	vi.clearAllMocks();
	menuState.clicks = [];
});

describe("showRibbonMenu：ribbon 长按菜单（1291-1335）", () => {
	it("构建菜单并触发各 onClick（含两个直链安装入口 1319-1331）", () => {
		const plugin = makePlugin();
		(plugin as AnyPlugin).showRibbonMenu(new MouseEvent("contextmenu"));
		expect(menuState.clicks.length).toBeGreaterThan(0);
		for (const c of menuState.clicks) c();
		expect((plugin as AnyPlugin).openTranslatorView).toHaveBeenCalled();
		expect((plugin as AnyPlugin).applyProfile).toHaveBeenCalledWith({ name: "p1" });
		expect(directInstall.cls).toHaveBeenCalled();
		expect((plugin as AnyPlugin).recordBetaInstall).toHaveBeenCalled();
	});
});
