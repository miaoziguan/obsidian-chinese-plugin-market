import { describe, it, expect, afterEach } from "vitest";
import { PluginListEnhancer } from "./plugin-list-enhancer";
import type { ManageStorePort } from "./manage-store";
import { addGroup, createDefaultManageSettings } from "@domain/manage/group";
import { setMeta } from "@domain/manage/plugin-meta";
import type { ManageSettings } from "@domain/manage/types";

/** 构造与 Obsidian「已安装插件」一致的 DOM 结构（选择器来自原生实现） */
function buildDom(): HTMLElement {
	const root = document.createElement("div");
	root.innerHTML = `
		<div class="setting-group mod-list">
			<div class="setting-group-search"></div>
			<div class="setting-item setting-item-heading">
				<div class="setting-item-control"></div>
			</div>
			<div class="setting-items">
				<div class="setting-item" data-plugin-id="alpha">
					<div class="setting-item-info">
						<div class="setting-item-name">Alpha Plugin</div>
						<div class="setting-item-description">by Someone</div>
					</div>
					<div class="setting-item-control">
						<div class="checkbox-container is-enabled"></div>
						<button>更新</button>
					</div>
				</div>
				<div class="setting-item" data-plugin-id="beta">
					<div class="setting-item-info">
						<div class="setting-item-name">Beta Plugin</div>
						<div class="setting-item-description">by Other</div>
					</div>
					<div class="setting-item-control">
						<div class="checkbox-container"></div>
						<button>更新</button>
					</div>
				</div>
			</div>
		</div>
	`;
	document.body.appendChild(root);
	return root;
}

function createStore(initial?: Partial<ManageSettings>): ManageStorePort {
	let settings: ManageSettings = { ...createDefaultManageSettings(), ...initial };
	return {
		get settings() {
			return settings;
		},
		saveGroups(groups, colors) {
			settings.pluginGroups = groups;
			settings.pluginGroupColors = colors;
		},
		saveMeta(id, patch) {
			settings.pluginMeta = setMeta(settings.pluginMeta, id, patch);
		},
		replaceMeta(meta) {
			settings.pluginMeta = meta;
		},
		installedIds: () => ["alpha", "beta"],
	};
}

function rows(root: HTMLElement): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>(".setting-items > .setting-item"));
}

afterEach(() => {
	document.body.innerHTML = "";
});

describe("PluginListEnhancer", () => {
	it("为每行注入备注与分组按钮", () => {
		const root = buildDom();
		const enhancer = new PluginListEnhancer(createStore(), { onManageGroups: () => {} });
		enhancer.enhance(root);

		for (const row of rows(root)) {
			expect(row.querySelector(".cpm-note-field")).not.toBeNull();
			expect(row.querySelector(".cpm-group-btn")).not.toBeNull();
		}
	});

	it("重复增强保持幂等（不重复注入）", () => {
		const root = buildDom();
		const enhancer = new PluginListEnhancer(createStore(), { onManageGroups: () => {} });
		enhancer.enhance(root);
		enhancer.enhance(root);
		enhancer.enhance(root);

		const first = rows(root)[0];
		expect(first.querySelectorAll(".cpm-note-field").length).toBe(1);
		expect(first.querySelectorAll(".cpm-group-btn").length).toBe(1);
	});

	it("已有分组的插件显示徽标，且徽标不污染插件名", () => {
		const groups = addGroup(createDefaultManageSettings().pluginGroups, "写作")!.groups;
		const store = createStore({
			pluginGroups: groups,
			pluginMeta: { alpha: { group: "1", remark: "" } },
		});
		const root = buildDom();
		const enhancer = new PluginListEnhancer(store, { onManageGroups: () => {} });
		enhancer.enhance(root);

		const alphaName = rows(root)[0].querySelector<HTMLElement>(".setting-item-name")!;
		expect(alphaName.querySelector(".cpm-group-badge")?.textContent).toBe("写作");
		// 名称提取会剔除注入元素，避免徽标文字被当成插件名参与搜索
		expect(alphaName.textContent).toContain("Alpha Plugin");
	});

	it("关键词筛选隐藏不匹配的行", () => {
		const root = buildDom();
		const enhancer = new PluginListEnhancer(createStore(), { onManageGroups: () => {} });
		enhancer.enhance(root);

		const input = root.querySelector<HTMLInputElement>(".cpm-filter-keyword")!;
		input.value = "alpha";
		input.dispatchEvent(new Event("input"));

		const [alpha, beta] = rows(root);
		expect(alpha.classList.contains("cpm-filtered-out")).toBe(false);
		expect(beta.classList.contains("cpm-filtered-out")).toBe(true);
	});

	it("状态筛选只显示已启用的插件", () => {
		const root = buildDom();
		const enhancer = new PluginListEnhancer(createStore(), { onManageGroups: () => {} });
		enhancer.enhance(root);

		const statusBtn = root.querySelector<HTMLButtonElement>(".cpm-filter-status")!;
		statusBtn.click(); // all → enabled
		expect(statusBtn.getAttribute("data-status")).toBe("enabled");

		const [alpha, beta] = rows(root);
		expect(alpha.classList.contains("cpm-filtered-out")).toBe(false);
		expect(beta.classList.contains("cpm-filtered-out")).toBe(true);
	});

	it("分组变化后重画，徽标随之更新", () => {
		const groups = addGroup(createDefaultManageSettings().pluginGroups, "写作")!.groups;
		const store = createStore({ pluginGroups: groups });
		const root = buildDom();
		const enhancer = new PluginListEnhancer(store, { onManageGroups: () => {} });
		enhancer.enhance(root);
		expect(rows(root)[0].querySelector(".cpm-group-badge")).toBeNull();

		store.saveMeta("alpha", { group: "1" });
		enhancer.refreshRows();
		expect(rows(root)[0].querySelector(".cpm-group-badge")?.textContent).toBe("写作");
	});

	it("cleanup 后不留任何注入痕迹", () => {
		const root = buildDom();
		const enhancer = new PluginListEnhancer(createStore(), { onManageGroups: () => {} });
		enhancer.enhance(root);
		enhancer.cleanup();

		expect(root.querySelectorAll("[data-cpm-owned]").length).toBe(0);
		expect(root.querySelectorAll(".cpm-filtered-out").length).toBe(0);
	});

	it("目标结构缺失时静默跳过，不抛错", () => {
		const root = document.createElement("div");
		root.innerHTML = "<div>not a settings page</div>";
		const enhancer = new PluginListEnhancer(createStore(), { onManageGroups: () => {} });
		expect(() => enhancer.enhance(root)).not.toThrow();
	});
});
