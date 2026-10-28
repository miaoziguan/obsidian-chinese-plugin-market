import { describe, it, expect, vi, beforeEach } from "vitest";
// 直接引用测试桩：`lastShown` 是 mock 的观测口，真实 obsidian 类型里没有它
import { Menu } from "../../test/mocks/obsidian";
import { makeT } from "@shared/i18n";
import ChinesePluginMarketPlugin from "@app/plugin";
import type { PluginProfile } from "@ui/view/translator-view";

/**
 * showRibbonMenu —— 点击丝带图标弹出的操作菜单。
 *
 * 曾经的问题：组合项用「应用组合：name」+ switch 图标，读起来像分类标题而不是动作，
 * 用户反馈「找不到应用组合的入口」。现在标题改为「应用 name」+ play 图标。
 *
 * 这里锁定菜单结构（顺序、图标、是否出现 profile 段）与各动作的路由，
 * 避免后续加减菜单项时把已有的动作挤掉。
 */
const t = makeT();

const profile = (name: string): PluginProfile =>
	({ name, ids: [], disabledIds: [], settings: {} }) as unknown as PluginProfile;

function makePlugin(profiles: PluginProfile[] = []) {
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	const openTranslatorView = vi.fn(async () => {});
	const applyProfile = vi.fn(async () => {});
	const recordBetaInstall = vi.fn();
	const settingOpen = vi.fn();
	Object.assign(plugin, {
		settings: { profiles },
		openTranslatorView,
		applyProfile,
		recordBetaInstall,
		app: { setting: { open: settingOpen } },
	});
	return { plugin, openTranslatorView, applyProfile, recordBetaInstall, settingOpen };
}

const showMenu = (plugin: unknown) =>
	(plugin as { showRibbonMenu(ev: MouseEvent): void }).showRibbonMenu({} as MouseEvent);

beforeEach(() => {
	Menu.lastShown = null;
	vi.clearAllMocks();
});

describe("showRibbonMenu：结构与顺序", () => {
	it("没有组合时不含组合段（不渲染空分组）", () => {
		const { plugin } = makePlugin();
		showMenu(plugin);

		const titles = Menu.lastShown!.items.map((i) => i.title);
		expect(titles).toEqual([t("app.search"), t("directInstall.menu"), t("beta.title.theme"), t("settings.profiles")]);
	});

	it("有组合时在搜索与直装之间插入组合项", () => {
		const { plugin } = makePlugin([profile("写作"), profile("开发")]);
		showMenu(plugin);

		const titles = Menu.lastShown!.items.map((i) => i.title);
		expect(titles[0]).toBe(t("app.search"));
		expect(titles[1]).toBe(t("ribbon.applyProfile", { name: "写作" }));
		expect(titles[2]).toBe(t("ribbon.applyProfile", { name: "开发" }));
		expect(titles[3]).toBe(t("directInstall.menu"));
	});

	it("各动作使用稳定图标（避免用户靠文字找人）", () => {
		const { plugin } = makePlugin([profile("写作")]);
		showMenu(plugin);

		const icons = Menu.lastShown!.items.map((i) => i.icon);
		expect(icons).toEqual(["languages", "play", "download", "palette", "gear"]);
	});

	it("菜单确实被弹出（不是只构造了实例）", () => {
		const { plugin } = makePlugin();
		showMenu(plugin);
		expect(Menu.lastShown).not.toBeNull();
		expect(Menu.lastShown!.items.length).toBeGreaterThan(0);
	});
});

describe("showRibbonMenu：动作路由", () => {
	const findByTitle = (title: string) => Menu.lastShown!.items.find((i) => i.title === title);

	it("「搜索」打开市场视图", () => {
		const { plugin, openTranslatorView } = makePlugin();
		showMenu(plugin);

		findByTitle(t("app.search"))!.cb!();

		expect(openTranslatorView).toHaveBeenCalledTimes(1);
	});

	it("组合项应用到对应的组合（不是第一个组合）", () => {
		const profiles = [profile("写作"), profile("开发")];
		const { plugin, applyProfile } = makePlugin(profiles);
		showMenu(plugin);

		findByTitle(t("ribbon.applyProfile", { name: "开发" }))!.cb!();

		expect(applyProfile).toHaveBeenCalledWith(profiles[1]);
	});

	it("「设置」跳转到插件设置页（内部 API 缺失时静默）", () => {
		const { plugin, settingOpen } = makePlugin();
		showMenu(plugin);

		findByTitle(t("settings.profiles"))!.cb!();

		expect(settingOpen).toHaveBeenCalled();
	});

	it("app.setting 不存在时点击设置不抛错（半官方 API 可能缺失）", () => {
		const { plugin } = makePlugin();
		Object.assign(plugin, { app: {} });
		showMenu(plugin);

		expect(() => findByTitle(t("settings.profiles"))!.cb!()).not.toThrow();
	});

	it("直装项存在且绑定了点击回调（点击会弹直装模态，这里不断言其内部）", () => {
		const { plugin } = makePlugin();
		showMenu(plugin);

		expect(findByTitle(t("directInstall.menu"))!.cb).toBeTypeOf("function");
		expect(findByTitle(t("beta.title.theme"))!.cb).toBeTypeOf("function");
	});
});
