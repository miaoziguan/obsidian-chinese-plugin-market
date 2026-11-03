import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Obsidian from "obsidian";
import * as groupDomain from "@domain/manage/group";
import { renderCssSnippetRow } from "./css-snippet-row";
import type { CssStorePort } from "./snippet-manage-store";
import type { SnippetInfo } from "@data/platform/snippet";
import type { ManageSettings, PluginMetaEntry } from "@domain/manage/types";
import { GROUP_ALL } from "@domain/manage/types";

// inline-note-editor 是独立组件，这里桩成无操作，只验证「被调用」
vi.mock("./inline-note-editor", () => ({
	renderInlineNoteEditor: vi.fn(),
}));
// 仅桩 listGroups 以驱动分组菜单项
vi.mock("@domain/manage/group", () => ({
	listGroups: vi.fn(),
	isBuiltinGroup: vi.fn(),
}));

// jsdom 没有 Obsidian 的 HTMLElement.setCssProps 增强，补齐以便徽标配色分支可达
type WithCssProps = HTMLElement & { setCssProps?: (s: Record<string, string>) => void };
if (!("setCssProps" in HTMLElement.prototype)) {
	(HTMLElement.prototype as WithCssProps).setCssProps = function (
		this: HTMLElement,
		styles: Record<string, string>,
	) {
		for (const k of Object.keys(styles)) this.style.setProperty(k, styles[k]);
	};
}

function makeStore(over: Partial<ManageSettings> = {}) {
	const settings: ManageSettings = {
		cssMeta: {},
		cssGroups: {},
		cssGroupColors: {},
		...over,
	} as ManageSettings;
	return {
		settings,
		setSnippetEnabled: vi.fn(async () => true),
		saveCssMeta: vi.fn(),
		openSnippet: vi.fn(),
		listSnippets: vi.fn(() => [] as SnippetInfo[]),
	} as unknown as CssStorePort & {
		setSnippetEnabled: ReturnType<typeof vi.fn>;
		saveCssMeta: ReturnType<typeof vi.fn>;
		openSnippet: ReturnType<typeof vi.fn>;
		listSnippets: ReturnType<typeof vi.fn>;
	};
}

const flush = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
	await new Promise((r) => window.setTimeout(r, 0));
};

beforeEach(() => {
	vi.clearAllMocks();
	document.body.innerHTML = "";
	// 分组菜单：跳过 ALL，渲染自定义分组项
	vi.mocked(groupDomain.listGroups).mockReturnValue([
		{ key: GROUP_ALL, name: "全部" },
		{ key: "g1", name: "分组一" },
		{ key: "g2", name: "分组二" },
	]);
});

describe("renderCssSnippetRow", () => {
	const snippet: SnippetInfo = {
		baseName: "my-snippet",
		name: "My Snippet",
		path: "/vault/.obsidian/snippets/my-snippet.css",
		enabled: false,
	};

	it("渲染名称 + 备注编辑器 + 开关 + 分组按钮 + 打开 + 重命名（44-148）", () => {
		const store = makeStore();
		const row = document.createElement("div");
		renderCssSnippetRow(row, snippet, {
			store,
			onRowChange: () => {},
			onFilterChange: () => {},
			requestRename: () => {},
		});
		expect(row.querySelector(".setting-item-name")?.textContent).toContain("My Snippet");
		expect(row.querySelector(".cpm-note-field")).toBeTruthy();
		expect(row.querySelector(".checkbox-container")).toBeTruthy();
		expect(row.querySelector(".cpm-group-btn")).toBeTruthy();
		expect(row.querySelector(".cpm-open-btn")).toBeTruthy();
		expect(row.querySelector(".cpm-icon-pencil")).toBeTruthy();
	});

	it("自定义分组 + 有颜色 → 显示徽标并写入配色变量（59-64）", () => {
		const store = makeStore({
			cssMeta: { "my-snippet": { group: "g1", remark: "" } as PluginMetaEntry },
			cssGroups: { g1: "分组一" },
			cssGroupColors: { g1: "#abcdef" },
		});
		const row = document.createElement("div");
		renderCssSnippetRow(row, snippet, {
			store,
			onRowChange: () => {},
			onFilterChange: () => {},
			requestRename: () => {},
		});
		const badge = row.querySelector<HTMLElement>(".cpm-group-badge");
		expect(badge).toBeTruthy();
		expect(badge?.textContent).toBe("分组一");
		expect(badge?.style.getPropertyValue("--cpm-group-color")).toBe("#abcdef");
	});

	it("分组为 ALL/OTHER 或无分组名 → 不显示徽标（36-38、59）", () => {
		const storeAll = makeStore({
			cssMeta: { "my-snippet": { group: GROUP_ALL, remark: "" } as PluginMetaEntry },
			cssGroups: { [GROUP_ALL]: "全部" },
		});
		const row = document.createElement("div");
		renderCssSnippetRow(row, snippet, {
			store: storeAll,
			onRowChange: () => {},
			onFilterChange: () => {},
			requestRename: () => {},
		});
		expect(row.querySelector(".cpm-group-badge")).toBeNull();
	});

	it("开关：启用成功 → 刷新筛选（87-116）", async () => {
		const store = makeStore();
		store.listSnippets.mockReturnValue([{ ...snippet, enabled: true }]);
		let onFilter = 0;
		const row = document.createElement("div");
		renderCssSnippetRow(row, { ...snippet, enabled: false }, {
			store,
			onRowChange: () => {},
			onFilterChange: () => {
				onFilter++;
			},
			requestRename: () => {},
		});
		const toggle = row.querySelector<HTMLElement>(".checkbox-container")!;
		toggle.click();
		await flush();
		expect(store.setSnippetEnabled).toHaveBeenCalledWith("my-snippet", true);
		expect(onFilter).toBeGreaterThan(0);
	});

	it("开关：平台返回 false → 回滚并提示（100-106）", async () => {
		const store = makeStore();
		store.setSnippetEnabled.mockResolvedValue(false);
		store.listSnippets.mockReturnValue([{ ...snippet, enabled: false }]);
		const row = document.createElement("div");
		renderCssSnippetRow(row, { ...snippet, enabled: true }, {
			store,
			onRowChange: () => {},
			onFilterChange: () => {},
			requestRename: () => {},
		});
		const toggle = row.querySelector<HTMLElement>(".checkbox-container")!;
		toggle.click();
		await flush();
		expect(store.setSnippetEnabled).toHaveBeenCalled();
	});

	it("开关：pending 期间重复点击 → 不二次提交（90-93）", async () => {
		const store = makeStore();
		let resolve!: (v: boolean) => void;
		store.setSnippetEnabled.mockReturnValue(new Promise<boolean>((r) => (resolve = r)));
		const row = document.createElement("div");
		renderCssSnippetRow(row, { ...snippet, enabled: false }, {
			store,
			onRowChange: () => {},
			onFilterChange: () => {},
			requestRename: () => {},
		});
		const toggle = row.querySelector<HTMLElement>(".checkbox-container")!;
		toggle.click();
		toggle.click(); // pending 中
		expect(store.setSnippetEnabled).toHaveBeenCalledTimes(1);
		resolve(true);
		await flush();
	});

	it("开关：异常 → 回滚 + 提示（108-112）", async () => {
		const store = makeStore();
		store.setSnippetEnabled.mockRejectedValue(new Error("boom"));
		const row = document.createElement("div");
		renderCssSnippetRow(row, { ...snippet, enabled: true }, {
			store,
			onRowChange: () => {},
			onFilterChange: () => {},
			requestRename: () => {},
		});
		const toggle = row.querySelector<HTMLElement>(".checkbox-container")!;
		toggle.click();
		await flush();
		expect(store.setSnippetEnabled).toHaveBeenCalled();
	});

	it("分组按钮 → 打开菜单，选中项写入 meta + 重画 + 筛选（118-128、151-179）", () => {
		const store = makeStore({
			cssMeta: { "my-snippet": { group: "g1", remark: "" } as PluginMetaEntry },
			cssGroups: { g1: "分组一", g2: "分组二" },
		});
		let rowChanged = 0;
		let filtered = 0;
		const row = document.createElement("div");
		renderCssSnippetRow(row, snippet, {
			store,
			onRowChange: () => {
				rowChanged++;
			},
			onFilterChange: () => {
				filtered++;
			},
			requestRename: () => {},
		});
		const groupBtn = row.querySelector<HTMLElement>(".cpm-group-btn")!;
		groupBtn.click();
		type MenuSnapshot = { items: Array<{ title: string; cb: (() => void) | null }> };
		const menu = (Obsidian.Menu as unknown as { lastShown: MenuSnapshot | null }).lastShown!;
		// 跳过 ALL 后应有 g1、g2 两个可选项
		const titles = menu.items.map((i) => i.title);
		expect(titles).not.toContain("全部");
		expect(titles).toContain("分组二");
		const g2 = menu.items.find((i) => i.title === "分组二")!;
		g2.cb?.();
		expect(store.saveCssMeta).toHaveBeenCalledWith("my-snippet", { group: "g2" });
		expect(rowChanged).toBe(1);
		expect(filtered).toBe(1);
	});

	it("打开按钮 → store.openSnippet（137-142）", () => {
		const store = makeStore();
		const row = document.createElement("div");
		renderCssSnippetRow(row, snippet, {
			store,
			onRowChange: () => {},
			onFilterChange: () => {},
			requestRename: () => {},
		});
		row.querySelector<HTMLElement>(".cpm-open-btn")!.click();
		expect(store.openSnippet).toHaveBeenCalledWith(snippet.path);
	});

	it("重命名按钮 → ctx.requestRename(baseName)（144-148）", () => {
		const store = makeStore();
		let r = "";
		const row = document.createElement("div");
		renderCssSnippetRow(row, snippet, {
			store,
			onRowChange: () => {},
			onFilterChange: () => {},
			requestRename: (b) => {
				r = b;
			},
		});
		row.querySelector<HTMLElement>(".cpm-icon-pencil")!.click();
		expect(r).toBe("my-snippet");
	});
});
