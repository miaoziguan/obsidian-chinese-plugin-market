/**
 * SnippetListEnhancer 测试：对标 PluginListEnhancer，但行 key 为 snippet 基名，
 * 行识别靠 listSnippets 已知基名集合过滤外观页 .setting-item。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Menu } from "../../../test/mocks/obsidian";
import { SnippetListEnhancer } from "./snippet-list-enhancer";
import type { CssStorePort } from "./snippet-manage-store";
import { addGroup, createDefaultManageSettings } from "@domain/manage/group";
import { setMeta } from "@domain/manage/plugin-meta";
import type { ManageSettings, PluginMetaEntry } from "@domain/manage/types";
import type { SnippetInfo } from "@data/platform/snippet";

/** 构造外观页 CSS 片段行的 DOM 结构（.setting-item-name 文本带 .css 后缀） */
function buildDom(): HTMLElement {
	const root = document.createElement("div");
	root.innerHTML = `
		<div class="setting-item">
			<div class="setting-item-info">
				<div class="setting-item-name">alpha.css</div>
				<div class="setting-item-description">片段</div>
			</div>
			<div class="setting-item-control">
				<div class="checkbox-container is-enabled"></div>
				<button>删除</button>
			</div>
		</div>
		<div class="setting-item">
			<div class="setting-item-info">
				<div class="setting-item-name">beta.css</div>
			</div>
			<div class="setting-item-control">
				<div class="checkbox-container"></div>
				<button>删除</button>
			</div>
		</div>
	`;
	document.body.appendChild(root);
	return root;
}

function createStore(opts: {
	snippets?: string[];
	meta?: Record<string, PluginMetaEntry>;
} = {}): CssStorePort {
	let settings: ManageSettings = {
		...createDefaultManageSettings(),
		cssMeta: opts.meta ?? {},
	};
	const snippets: SnippetInfo[] = (opts.snippets ?? ["alpha", "beta"]).map((b) => ({
		name: `${b}.css`,
		baseName: b,
		enabled: true,
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
		refreshSnippets: async () => {},
		listSnippets: () => snippets,
		setSnippetEnabled: async () => {},
		renameSnippet: async () => {},
		openSnippet: () => {},
		replaceCssMeta(m) {
			settings.cssMeta = m;
		},
	};
}

function rows(root: HTMLElement): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>(".setting-item"));
}

let lastRename: string | null = null;

beforeEach(() => {
	Menu.lastShown = null;
	lastRename = null;
});

afterEach(() => {
	document.body.innerHTML = "";
});

describe("SnippetListEnhancer", () => {
	it("为每行注入备注 / 分组按钮 / 打开按钮", () => {
		const root = buildDom();
		const enhancer = new SnippetListEnhancer(createStore(), {
			onManageGroups: () => {},
			requestRenameSnippet: () => {},
		});
		enhancer.enhance(root);

		for (const row of rows(root)) {
			expect(row.querySelector(".cpm-note-field")).not.toBeNull();
			expect(row.querySelector(".cpm-group-btn")).not.toBeNull();
			expect(row.querySelector(".cpm-open-btn")).not.toBeNull();
		}
	});

	it("重复增强保持幂等", () => {
		const root = buildDom();
		const enhancer = new SnippetListEnhancer(createStore(), {
			onManageGroups: () => {},
			requestRenameSnippet: () => {},
		});
		enhancer.enhance(root);
		enhancer.enhance(root);
		enhancer.enhance(root);

		const first = rows(root)[0];
		expect(first.querySelectorAll(".cpm-note-field").length).toBe(1);
		expect(first.querySelectorAll(".cpm-group-btn").length).toBe(1);
		expect(first.querySelectorAll(".cpm-open-btn").length).toBe(1);
	});

	it("已有分组的片段显示徽标，且不污染片段名", () => {
		const groups = addGroup(createDefaultManageSettings().cssGroups, "暗色")!.groups;
		const store = createStore({
			snippets: ["alpha"],
			meta: { alpha: { group: "1", remark: "" } },
		});
		store.settings.cssGroups = groups;
		const root = buildDom();
		const enhancer = new SnippetListEnhancer(store, {
			onManageGroups: () => {},
			requestRenameSnippet: () => {},
		});
		enhancer.enhance(root);

		const name = rows(root)[0].querySelector<HTMLElement>(".setting-item-name")!;
		expect(name.querySelector(".cpm-group-badge")?.textContent).toBe("暗色");
		expect(name.textContent).toContain("alpha.css");
	});

	it("关键词筛选隐藏不匹配的行", () => {
		const root = buildDom();
		const enhancer = new SnippetListEnhancer(createStore(), {
			onManageGroups: () => {},
			requestRenameSnippet: () => {},
		});
		enhancer.enhance(root);

		const input = root.querySelector<HTMLInputElement>(".cpm-filter-keyword")!;
		input.value = "alpha";
		input.dispatchEvent(new Event("input"));

		const [alpha, beta] = rows(root);
		expect(alpha.classList.contains("cpm-filtered-out")).toBe(false);
		expect(beta.classList.contains("cpm-filtered-out")).toBe(true);
	});

	it("打开按钮点击调用 openSnippet（传入 path）", () => {
		const store = createStore();
		let opened = "";
		store.openSnippet = (p: string) => {
			opened = p;
		};
		const root = buildDom();
		const enhancer = new SnippetListEnhancer(store, {
			onManageGroups: () => {},
			requestRenameSnippet: () => {},
		});
		enhancer.enhance(root);

		const btn = rows(root)[0].querySelector<HTMLButtonElement>(".cpm-open-btn")!;
		btn.click();
		expect(opened).toBe(".obsidian/snippets/alpha.css");
	});

	it("分组菜单含「重命名片段」项，点击调用 requestRenameSnippet", () => {
		const root = buildDom();
		const enhancer = new SnippetListEnhancer(createStore(), {
			onManageGroups: () => {},
			requestRenameSnippet: (b) => {
				lastRename = b;
			},
		});
		enhancer.enhance(root);

		const btn = rows(root)[0].querySelector<HTMLButtonElement>(".cpm-group-btn")!;
		btn.click();

		const menu = Menu.lastShown!;
		const renameItem = menu.items.find((i) => i.title === "重命名片段");
		expect(renameItem).toBeTruthy();
		renameItem!.cb!();
		expect(lastRename).toBe("alpha");
	});

	it("cleanup 后不留任何注入痕迹", () => {
		const root = buildDom();
		const enhancer = new SnippetListEnhancer(createStore(), {
			onManageGroups: () => {},
			requestRenameSnippet: () => {},
		});
		enhancer.enhance(root);
		enhancer.cleanup();

		expect(root.querySelectorAll("[data-cpm-owned]").length).toBe(0);
		expect(root.querySelectorAll(".cpm-filtered-out").length).toBe(0);
	});

	it("无 CSS 片段时仍渲染工具栏与空状态提示", () => {
		const root = buildDom();
		const enhancer = new SnippetListEnhancer(createStore({ snippets: [] }), {
			onManageGroups: () => {},
			requestRenameSnippet: () => {},
		});
		enhancer.enhance(root);

		expect(root.querySelector(".cpm-css-toolbar")).not.toBeNull();
		const empty = root.querySelector(".cpm-css-empty-state");
		expect(empty).not.toBeNull();
		expect(empty!.textContent).toContain("暂无 CSS 片段");
		// 无片段时不应有任何行增强
		expect(root.querySelector(".cpm-group-btn")).toBeNull();
	});

	it("原生页只给「已启用 N 个」汇总行（不再逐行列出）时，自渲染片段行且计数一致", () => {
		// 1.10+ 形态：外观页只剩下标题 + 右侧「已启用 N 个 ›」，没有逐片段的 .setting-item
		const root = document.createElement("div");
		root.innerHTML = `
			<div class="setting-item">
				<div class="setting-item-info">
					<div class="setting-item-name">CSS 代码片段</div>
					<div class="setting-item-description">管理用于调整应用外观的 CSS 文件集合。</div>
				</div>
				<div class="setting-item-control">已启用 1 个</div>
			</div>
		`;
		document.body.appendChild(root);
		const enhancer = new SnippetListEnhancer(createStore(), {
			onManageGroups: () => {},
			requestRenameSnippet: () => {},
		});
		enhancer.enhance(root);

		const ownList = root.querySelector<HTMLElement>('[data-cpm-owned="css-rows"]')!;
		expect(ownList.querySelectorAll(".cpm-css-settings-row").length).toBe(2);
		// 每行都带全套控件（备注 / 分组按钮 / 打开）
		for (const row of Array.from(ownList.querySelectorAll<HTMLElement>(".cpm-css-settings-row"))) {
			expect(row.querySelector(".cpm-note-field")).not.toBeNull();
			expect(row.querySelector(".cpm-group-btn")).not.toBeNull();
			expect(row.querySelector(".cpm-open-btn")).not.toBeNull();
		}
		// 有数据源却显示空态 = 数据对不上，必须不成立
		expect(root.querySelector(".cpm-css-empty-state")).toBeNull();
		expect(root.querySelector(".cpm-filter-count")?.textContent).toBe("2 个片段");
	});

	it("工具栏锚定到「CSS 代码片段」区块标题之后", () => {
		const root = document.createElement("div");
		root.innerHTML = `
			<div class="setting-item"><div class="setting-item-name">CSS 代码片段</div></div>
			<div class="setting-item">
				<div class="setting-item-info"><div class="setting-item-name">alpha.css</div></div>
				<div class="setting-item-control"><div class="checkbox-container is-enabled"></div></div>
			</div>
		`;
		document.body.appendChild(root);
		const enhancer = new SnippetListEnhancer(createStore({ snippets: ["alpha"] }), {
			onManageGroups: () => {},
			requestRenameSnippet: () => {},
		});
		enhancer.enhance(root);

		const heading = root.querySelector<HTMLElement>(".setting-item")!;
		const toolbar = root.querySelector<HTMLElement>(".cpm-css-toolbar")!;
		// 工具栏应紧跟在标题元素之后
		expect(heading.compareDocumentPosition(toolbar)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
		expect(heading.nextElementSibling).toBe(toolbar);
	});
});
