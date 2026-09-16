/**
 * CssSnippetSettingsList 测试：验证插件设置页内的 CSS 片段列表。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Menu } from "../../../test/mocks/obsidian";
import { CssSnippetSettingsList } from "./css-snippet-settings-list";
import type { CssStorePort } from "./snippet-manage-store";
import { createDefaultManageSettings } from "@domain/manage/group";
import { setMeta } from "@domain/manage/plugin-meta";
import type { ManageSettings, PluginMetaEntry } from "@domain/manage/types";
import type { SnippetInfo } from "@data/platform/snippet";
import type { App } from "obsidian";

function createStore(opts: {
	snippets?: string[];
	meta?: Record<string, PluginMetaEntry>;
} = {}): CssStorePort {
	let settings: ManageSettings = {
		...createDefaultManageSettings(),
		cssMeta: opts.meta ?? {},
	};
	const snippets: SnippetInfo[] = (opts.snippets ?? ["alpha", "beta"]).map((b, i) => ({
		name: `${b}.css`,
		baseName: b,
		enabled: i === 0,
		path: `.obsidian/snippets/${b}.css`,
	}));
	return {
		get settings() {
			return settings;
		},
		saveCssGroups(g, c) {
			settings.cssGroups = g;
			settings.cssGroupColors = c;
		},
		saveCssMeta(id, patch) {
			settings.cssMeta = setMeta(settings.cssMeta, id, patch);
		},
		saveCssFilterState() {},
		listSnippets: () => snippets,
		setSnippetEnabled: async () => {},
		renameSnippet: async () => {},
		openSnippet: () => {},
		replaceCssMeta(m) {
			settings.cssMeta = m;
		},
	};
}

beforeEach(() => {
	Menu.lastShown = null;
});

afterEach(() => {
	document.body.innerHTML = "";
});

describe("CssSnippetSettingsList", () => {
	it("渲染片段行：名称、启用开关、分组按钮、打开、重命名", () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const list = new CssSnippetSettingsList({} as unknown as App, createStore(), {
			openPluginSettings: () => {},
			openManageGroups: () => {},
		});
		list.render(container);

		const rows = container.querySelectorAll(".cpm-css-settings-row");
		expect(rows.length).toBe(2);
		expect(rows[0].querySelector(".setting-item-name")?.textContent).toContain("alpha.css");
		expect(rows[0].querySelector(".checkbox-container.is-enabled")).not.toBeNull();
		expect(rows[0].querySelector(".cpm-group-btn")).not.toBeNull();
	});

	it("无片段时显示工具栏与空状态", () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const list = new CssSnippetSettingsList({} as unknown as App, createStore({ snippets: [] }), {
			openPluginSettings: () => {},
			openManageGroups: () => {},
		});
		list.render(container);

		expect(container.querySelector(".cpm-filter-bar")).not.toBeNull();
		expect(container.querySelector(".cpm-css-empty-state")).not.toBeNull();
		expect(container.querySelector(".cpm-css-empty-state")!.textContent).toContain("暂无 CSS 片段");
	});

	it("分组徽标显示自定义分组", () => {
		const settings = createDefaultManageSettings();
		const next = { ...settings.cssGroups, "1": "暗色" };
		const store = createStore({ snippets: ["alpha"], meta: { alpha: { group: "1", remark: "" } } });
		store.settings.cssGroups = next;

		const container = document.createElement("div");
		document.body.appendChild(container);
		const list = new CssSnippetSettingsList({} as unknown as App, store, {
			openPluginSettings: () => {},
			openManageGroups: () => {},
		});
		list.render(container);

		const badge = container.querySelector(".cpm-group-badge");
		expect(badge?.textContent).toBe("暗色");
	});

	it("点击启用开关调用 setSnippetEnabled", async () => {
		const store = createStore({ snippets: ["alpha"] });
		let toggled: { baseName: string; enabled: boolean } | null = null;
		store.setSnippetEnabled = async (baseName, enabled) => {
			toggled = { baseName, enabled };
		};

		const container = document.createElement("div");
		document.body.appendChild(container);
		const list = new CssSnippetSettingsList({} as unknown as App, store, {
			openPluginSettings: () => {},
			openManageGroups: () => {},
		});
		list.render(container);

		const toggleEl = container.querySelector<HTMLElement>(".checkbox-container")!;
		toggleEl.click();
		expect(toggled).toEqual({ baseName: "alpha", enabled: false });
	});

	it("关键词筛选隐藏不匹配行", () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const list = new CssSnippetSettingsList({} as unknown as App, createStore(), {
			openPluginSettings: () => {},
			openManageGroups: () => {},
		});
		list.render(container);

		const input = container.querySelector<HTMLInputElement>(".cpm-filter-keyword")!;
		input.value = "beta";
		input.dispatchEvent(new Event("input"));

		const rows = container.querySelectorAll<HTMLElement>(".cpm-css-settings-row");
		expect(rows[0].classList.contains("cpm-filtered-out")).toBe(true);
		expect(rows[1].classList.contains("cpm-filtered-out")).toBe(false);
	});
});
