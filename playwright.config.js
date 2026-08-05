const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
	testDir: "test/e2e",
	testMatch: "**/*.spec.js",
	timeout: 20000,
	expect: { timeout: 5000 },
	webServer: {
		command: "node scripts/serve-e2e.mjs",
		port: 4173,
		reuseExistingServer: true,
		timeout: 15000,
	},
	use: {
		baseURL: "http://localhost:4173",
		headless: true,
	},
});
