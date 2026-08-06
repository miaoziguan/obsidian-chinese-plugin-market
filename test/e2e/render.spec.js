const { test, expect } = require("@playwright/test");

async function loadHarness(page) {
	await page.goto("/test/e2e/harness.html");
	await page.waitForFunction(() => !!window.__e2e);
}

test.beforeEach(async ({ page }) => {
	await loadHarness(page);
});

test("插件卡片渲染出正确结构（含中文译名 / 操作区 / aria）", async ({ page }) => {
	const html = await page.evaluate(() => window.__e2e.renderCard());
	expect(html).toContain("pt-card");
	expect(html).toContain('data-plugin-id="dataview"');
	expect(html).toContain("数据视图"); // 注入的中文译名
	expect(html).toContain("pt-card-actions-row"); // 对比/收藏/翻译操作按钮
	expect(html).toContain("pt-card-install-btn");
	// aria-label 应包含插件名（无障碍读英文原名；中文译名显示在标题 span）
	expect(html).toMatch(/aria-label="[^"]*Dataview/);
});

test("对比页渲染出导航与多张对比卡片（含中文译名）", async ({ page }) => {
	const html = await page.evaluate(() => window.__e2e.renderCompare());
	expect(html).toContain("pt-compare-nav");
	expect(html).toContain("pt-compare-back-btn");
	expect(html).toContain("阿尔法插件");
	expect(html).toContain("贝塔插件");
});
