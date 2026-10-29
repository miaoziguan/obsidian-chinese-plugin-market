/**
 * SnippetListEnhancer 测试：对标 PluginListEnhancer，但行 key 为 snippet 基名，
 * 行识别靠 listSnippets 已知基名集合过滤外观页 .setting-item。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Menu } from "../../../test/mocks/obsidian";
import { SnippetListEnhancer } from "./snippet-list-enhancer";
import { CssSnippetSettingsList } from "./css-snippet-settings-list";
import type { App } from "obsidian";
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
	enabled?: string[];
	failToggle?: boolean;
} = {}): CssStorePort {
	let settings: ManageSettings = {
		...createDefaultManageSettings(),
		cssMeta: opts.meta ?? {},
	};
	const enabled = new Set(opts.enabled ?? [opts.snippets?.[0] ?? "alpha"]);
	const snippets: SnippetInfo[] = (opts.snippets ?? ["alpha", "beta"]).map((b) => ({
		name: `${b}.css`,
		baseName: b,
		enabled: enabled.has(b),
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
		setSnippetEnabled: async (baseName, value) => {
			if (opts.failToggle) return false;
			enabled[value ? "add" : "delete"](baseName);
			const item = snippets.find((s) => s.baseName === baseName);
			if (item) item.enabled = value;
			return true;
		},
		renameSnippet: async () => {},
		createSnippet: async () => {},
		deleteSnippet: async () => {},
		onManageGroups: () => {},
		openSnippet: () => {},
		replaceCssMeta(m) {
			settings.cssMeta = m;
		},
	};
}

function rows(root: HTMLElement): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>(".setting-item"));
}

async function flushToggle(): Promise<void> {
	// ToggleComponent 的回调是 fire-and-forget；让平台层 Promise 链和重绘回调完成。
	await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
	await Promise.resolve();
}

beforeEach(() => {
	Menu.lastShown = null;
});

afterEach(() => {
	document.body.innerHTML = "";
});

describe("SnippetListEnhancer", () => {
	it.each(["native", "fallback", "settings"])("%s 列表修改分组后同步徽标、筛选与分组计数", (mode) => {
		const root = mode === "native" ? buildDom() : document.body.appendChild(document.createElement("div"));
		const store = createStore();
		store.settings.cssGroups["1"] = "暗色";
		if (mode === "settings") {
			new CssSnippetSettingsList({} as App, store, { openPluginSettings() {}, openManageGroups() {} }).render(root);
		} else {
			new SnippetListEnhancer(store, { onManageGroups() {}, requestRenameSnippet() {} }).enhance(root);
		}
		const group = root.querySelector<HTMLSelectElement>(".cpm-filter-group")!;
		group.value = "1";
		group.dispatchEvent(new Event("change"));
		const row = root.querySelector<HTMLElement>('[data-cpm-snippet="alpha"]')!;
		expect(row.classList.contains("cpm-filtered-out")).toBe(true);
		row.querySelector<HTMLButtonElement>(".cpm-group-btn")!.click();
		expect(Menu.lastShown!.items.map((item) => item.title)).toEqual(["暗色", "其他"]);
		Menu.lastShown!.items.find((item) => item.title === "暗色")!.cb!();
		expect(store.settings.cssMeta.alpha.group).toBe("1");
		expect(row.querySelector(".cpm-group-badge")?.textContent).toBe("暗色");
		expect(row.classList.contains("cpm-filtered-out")).toBe(false);
		expect(group.selectedOptions[0].textContent).toBe("暗色（1）");
		expect(store.listSnippets().filter((snippet) => snippet.enabled).map((snippet) => snippet.baseName)).toEqual(["alpha"]);
	});

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

	it("分组菜单不含「重命名片段」项（重命名使用专门的铅笔按钮）", () => {
		const root = buildDom();
		const enhancer = new SnippetListEnhancer(createStore(), {
			onManageGroups: () => {},
			requestRenameSnippet: () => {},
		});
		enhancer.enhance(root);

		const btn = rows(root)[0].querySelector<HTMLButtonElement>(".cpm-group-btn")!;
		btn.click();

		const menu = Menu.lastShown!;
		const renameItem = menu.items.find((i) => i.title === "重命名片段");
		expect(renameItem).toBeFalsy();
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

	it("初始部分启用时开关、状态筛选和刷新后的行状态保持一致", async () => {
		const root = document.createElement("div");
		root.innerHTML = `
			<div class="setting-item">
				<div class="setting-item-info"><div class="setting-item-name">CSS 代码片段</div></div>
				<div class="setting-item-control">已启用 1 个</div>
			</div>
		`;
		document.body.appendChild(root);
		const store = createStore({ snippets: ["alpha", "beta"], enabled: ["alpha"] });
		const enhancer = new SnippetListEnhancer(store, {
			onManageGroups: () => {},
			requestRenameSnippet: () => {},
		});
		enhancer.enhance(root);

		const ownList = root.querySelector<HTMLElement>('[data-cpm-owned="css-rows"]')!;
		const betaRow = ownList.querySelector<HTMLElement>('[data-cpm-snippet="beta"]')!;
		expect(betaRow.querySelector(".checkbox-container.is-enabled")).toBeNull();

		const status = root.querySelector<HTMLSelectElement>(".cpm-filter-status")!;
		status.value = "enabled";
		status.dispatchEvent(new Event("change"));
		expect(betaRow.classList.contains("cpm-filtered-out")).toBe(true);

		const toggle = betaRow.querySelector<HTMLElement>(".checkbox-container")!;
		toggle.click();
		await flushToggle();
		expect(store.listSnippets().find((s) => s.baseName === "beta")?.enabled).toBe(true);
		expect(betaRow.querySelector(".checkbox-container.is-enabled")).not.toBeNull();
		expect(betaRow.classList.contains("cpm-filtered-out")).toBe(false);

		// 与原生页刷新等价：增强器重新读取同一份 store 快照，开关不能回到旧值。
		enhancer.refreshRows();
		const refreshedBeta = root.querySelector<HTMLElement>('[data-cpm-snippet="beta"]')!;
		expect(refreshedBeta.querySelector(".checkbox-container.is-enabled")).not.toBeNull();

		// 第二次点击必须真正关闭，而不是再次把旧的开启状态写回。
		refreshedBeta.querySelector<HTMLElement>(".checkbox-container")!.click();
		await flushToggle();
		expect(store.listSnippets().find((s) => s.baseName === "beta")?.enabled).toBe(false);
		enhancer.refreshRows();
		const closedBeta = root.querySelector<HTMLElement>('[data-cpm-snippet="beta"]')!;
		expect(closedBeta.querySelector(".checkbox-container.is-enabled")).toBeNull();
		expect(closedBeta.classList.contains("cpm-filtered-out")).toBe(true);
	});

	it("筛选与重复增强只改变可见行，不写入片段启用状态", () => {
		const root = document.createElement("div");
		root.innerHTML = `
			<div class="setting-item">
				<div class="setting-item-info"><div class="setting-item-name">CSS 代码片段</div></div>
				<div class="setting-item-control">已启用 3 个</div>
			</div>
		`;
		document.body.appendChild(root);
		const original = ["alpha", "beta", "gamma"];
		const disabled = ["delta", "epsilon", "zeta", "eta"];
		const store = createStore({ snippets: [...original, ...disabled], enabled: original });
		let toggleWrites = 0;
		const setEnabled = store.setSnippetEnabled;
		store.setSnippetEnabled = (...args) => {
			toggleWrites += 1;
			return setEnabled(...args);
		};
		const enhancer = new SnippetListEnhancer(store, {
			onManageGroups: () => {},
			requestRenameSnippet: () => {},
		});
		enhancer.enhance(root);

		for (const [status, expected] of [
			["enabled", original],
			["disabled", disabled],
			["all", [...original, ...disabled]],
		] as const) {
			const select = root.querySelector<HTMLSelectElement>(".cpm-filter-status")!;
			select.click();
			select.value = status;
			select.dispatchEvent(new Event("change"));
			enhancer.enhance(root);
			enhancer.refreshRows();
			const visible = Array.from(root.querySelectorAll<HTMLElement>(".cpm-css-settings-row"))
				.filter((row) => !row.classList.contains("cpm-filtered-out"))
				.map((row) => row.dataset.cpmSnippet);
			expect(visible).toEqual(expected);
			expect(store.listSnippets().filter((s) => s.enabled).map((s) => s.baseName)).toEqual(original);
			expect(toggleWrites).toBe(0);
		}

		// 重开设置页会重建 ToggleComponent，同样不能触发启用写入。
		enhancer.cleanup();
		enhancer.enhance(root);
		expect(root.querySelectorAll(".checkbox-container.is-enabled")).toHaveLength(3);
		expect(toggleWrites).toBe(0);
	});

	it("切换失败时开关回滚到真实状态并保留筛选结果", async () => {
		const root = document.createElement("div");
		root.innerHTML = `
			<div class="setting-item"><div class="setting-item-name">CSS 代码片段</div></div>
		`;
		document.body.appendChild(root);
		const store = createStore({ snippets: ["alpha"], enabled: [], failToggle: true });
		const enhancer = new SnippetListEnhancer(store, {
			onManageGroups: () => {},
			requestRenameSnippet: () => {},
		});
		enhancer.enhance(root);
		const row = root.querySelector<HTMLElement>('[data-cpm-snippet="alpha"]')!;
		row.querySelector<HTMLElement>(".checkbox-container")!.click();
		await flushToggle();
		expect(row.querySelector(".checkbox-container.is-enabled")).toBeNull();
		expect(store.listSnippets().find((s) => s.baseName === "alpha")?.enabled).toBe(false);
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

	it("工具栏位于原生可点击汇总行内时，搜索与筛选不会跳进原生子页", () => {
		const root = document.createElement("div");
		root.innerHTML = `
			<div class="setting-item is-clickable">
				<div class="setting-item-info"><div class="setting-item-name">CSS 代码片段</div></div>
				<div class="setting-item-control">已启用 1 个</div>
			</div>
		`;
		document.body.appendChild(root);
		const summary = root.querySelector<HTMLElement>(".setting-item")!;
		let nativePageOpens = 0;
		summary.addEventListener("click", () => { nativePageOpens += 1; });
		const enhancer = new SnippetListEnhancer(createStore(), {
			onManageGroups: () => {},
			requestRenameSnippet: () => {},
		});
		enhancer.enhance(root);

		const keyword = root.querySelector<HTMLInputElement>(".cpm-filter-keyword")!;
		keyword.click();
		keyword.value = "beta";
		keyword.dispatchEvent(new Event("input"));
		root.querySelector<HTMLElement>(".cpm-filter-group")!.click();
		root.querySelector<HTMLElement>(".cpm-filter-status")!.click();
		expect(nativePageOpens).toBe(0);
		expect(root.querySelector('[data-cpm-snippet="alpha"]')?.classList.contains("cpm-filtered-out")).toBe(true);
		expect(root.querySelector('[data-cpm-snippet="beta"]')?.classList.contains("cpm-filtered-out")).toBe(false);

		// 原生汇总行本身仍可打开 Obsidian 的片段子页。
		summary.click();
		expect(nativePageOpens).toBe(1);
	});
});
