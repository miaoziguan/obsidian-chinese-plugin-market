const { test, expect } = require("@playwright/test");

async function loadPluginHarness(page) {
	await page.goto("/test/e2e/harness-plugin.html");
	await page.waitForFunction(() => !!window.__e2ePlugin);
}

test.beforeEach(async ({ page }) => {
	await loadPluginHarness(page);
});

test("onload 注册命令 / 设置页 / 视图，并加载推荐清单", async ({ page }) => {
	const info = await page.evaluate(async () => {
		return await window.__e2ePlugin.startPlugin({});
	});
	// 命令注册（关键路径）
	expect(info.commandIds).toContain("open-translator-view");
	expect(info.commandIds).toContain("scroll-debug-on");
	expect(info.commandIds).toContain("scroll-debug-off");
	expect(info.commandNames.length).toBe(info.commandIds.length);
	info.commandNames.forEach((n) => expect(typeof n).toBe("string") && expect(n.length).toBeGreaterThan(0));
	// 设置页 + 视图注册
	expect(info.settingTabs).toBe(1);
	expect(info.viewTypes).toContain("chinese-plugin-market-view");
	// 推荐清单加载（adapater 读取真实 plugin-recommend.json，或降级到内置清单）
	expect(info.recommendedIdsSize).toBeGreaterThan(0);
	// 默认设置水合（未预置时应取 DEFAULT_SETTINGS 的 useMyMemory）
	expect(info.defaultUseMyMemory).toBe(true);
});

test("设置读写：预置 → onload 水合 → 修改 → flush 落盘", async ({ page }) => {
	const result = await page.evaluate(async () => {
		const preset = { sortBy: "downloads" };
		const info = await window.__e2ePlugin.startPlugin(preset);
		const hydrated = info.defaultSortBy; // 应等于预置的 "downloads"，证明读取生效
		// 修改设置并立即落盘
		window.__e2ePlugin.getInstance().settings.sortBy = "name";
		await window.__e2ePlugin.getInstance().flushSaveSettings();
		const stored = window.__e2ePlugin.getData();
		return { hydrated, storedSortBy: stored.sortBy };
	});
	expect(result.hydrated).toBe("downloads");
	expect(result.storedSortBy).toBe("name");
});

test("命令回调可触发：打开视图命令不抛错", async ({ page }) => {
	const ok = await page.evaluate(async () => {
		await window.__e2ePlugin.startPlugin({});
		const openCmd = window.__e2ePlugin.getInstance().commands.find(
			(c) => c.id === "open-translator-view"
		);
		if (!openCmd || typeof openCmd.callback !== "function") return false;
		try {
			openCmd.callback();
			return true;
		} catch (e) {
			console.error(e);
			return false;
		}
	});
	expect(ok).toBe(true);
});
