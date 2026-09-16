/**
 * GroupManagementModal 测试：验证「管理分组」模态框（对齐参考插件交互）。
 */

import { describe, it, expect, afterEach } from "vitest";
import { GroupManagementModal } from "./group-management-modal";
import type { App } from "obsidian";
import type { GroupManageStore } from "./group-manage-store";
import type { PluginMetaEntry } from "@domain/manage/types";

function createStore(
	initial: {
		groups?: Record<string, string>;
		colors?: Record<string, string>;
		meta?: Record<string, PluginMetaEntry>;
	} = {},
) {
	let groups = initial.groups ?? { all: "全部", other: "其他" };
	let colors = initial.colors ?? {};
	let meta = initial.meta ?? {};
	const store: GroupManageStore = {
		type: "plugin",
		getGroups: () => groups,
		getGroupColors: () => colors,
		getMeta: () => meta,
		saveGroups: (g, c) => {
			groups = g;
			colors = c;
		},
		saveMeta: () => {},
		replaceMeta: (m) => {
			meta = m;
		},
	};
	return { store, snapshot: () => ({ groups, colors, meta }) };
}

function openWith(store: GroupManageStore): GroupManagementModal {
	const modal = new GroupManagementModal({} as App, store);
	modal.open();
	return modal;
}

afterEach(() => {
	document.body.innerHTML = "";
});

describe("GroupManagementModal", () => {
	it("无自定义分组时显示空状态与添加输入", () => {
		const { store } = createStore();
		const modal = openWith(store);
		expect(modal.contentEl.querySelector(".cpm-group-composer input")).not.toBeNull();
		expect(modal.contentEl.querySelector(".cpm-group-empty")).not.toBeNull();
	});

	it("添加分组写入 store 并刷新列表", () => {
		const { store, snapshot } = createStore();
		const modal = openWith(store);
		const input = modal.contentEl.querySelector<HTMLInputElement>(
			".cpm-group-composer input",
		)!;
		input.value = "设计";
		modal.contentEl
			.querySelector<HTMLButtonElement>(".cpm-group-composer button")!
			.click();
		expect(Object.values(snapshot().groups)).toContain("设计");
		expect(modal.contentEl.querySelector(".cpm-group-row")).not.toBeNull();
	});

	it("重名分组不写入 store", () => {
		const { store, snapshot } = createStore();
		const modal = openWith(store);
		const input = modal.contentEl.querySelector<HTMLInputElement>(
			".cpm-group-composer input",
		)!;
		input.value = "全部";
		modal.contentEl
			.querySelector<HTMLButtonElement>(".cpm-group-composer button")!
			.click();
		expect(Object.keys(snapshot().groups).length).toBe(2);
	});

	it("删除分组把成员归位「其他」并清理颜色", () => {
		const { store, snapshot } = createStore({
			groups: { all: "全部", other: "其他", "1": "设计" },
			colors: { "1": "#ff0000" },
			meta: { "some-plugin": { group: "1", remark: "" } },
		});
		const modal = openWith(store);
		const del = modal.contentEl.querySelector<HTMLButtonElement>(
			'button[aria-label="删除"]',
		)!;
		del.click();
		expect(Object.keys(snapshot().groups)).not.toContain("1");
		expect(snapshot().meta["some-plugin"]?.group).toBe("other");
		expect(Object.keys(snapshot().colors)).not.toContain("1");
	});

	it("空名不写入 store", () => {
		const { store, snapshot } = createStore();
		const modal = openWith(store);
		const input = modal.contentEl.querySelector<HTMLInputElement>(
			".cpm-group-composer input",
		)!;
		input.value = "   ";
		modal.contentEl
			.querySelector<HTMLButtonElement>(".cpm-group-composer button")!
			.click();
		expect(Object.keys(snapshot().groups).length).toBe(2);
	});
});
