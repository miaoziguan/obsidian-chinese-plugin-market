import { describe, it, expect, vi, beforeEach } from "vitest";
import * as groupDomain from "@domain/manage/group";
import { GroupManagementModal } from "./group-management-modal";
import type { GroupManageStore } from "./group-manage-store";
import type { PluginMetaEntry } from "@domain/manage/types";

// @domain/manage/group 是纯函数，这里整体 mock 以便单独驱动模态框分支。
vi.mock("@domain/manage/group", () => ({
	listGroups: vi.fn((g: Record<string, string>) =>
		Object.entries(g ?? {}).map(([key, name]) => ({ key, name })),
	),
	isBuiltinGroup: vi.fn(() => false),
	addGroup: vi.fn(),
	renameGroup: vi.fn(),
	removeGroup: vi.fn(),
	countMembersByGroup: vi.fn(() => ({})),
	reassignMetaGroup: vi.fn((m: unknown) => m),
	getGroupColor: vi.fn(),
}));

function makeStore(initialGroups: Record<string, string> = {}, type: "css" | "plugin" = "css") {
	const s: GroupManageStore & {
		groups: Record<string, string>;
		colors: Record<string, string>;
		meta: Record<string, PluginMetaEntry>;
	} = {
		type,
		groups: { ...initialGroups },
		colors: {},
		meta: {},
		getGroups: vi.fn(() => s.groups),
		getGroupColors: vi.fn(() => s.colors),
		getMeta: vi.fn(() => s.meta),
		saveGroups: vi.fn((g: Record<string, string>, c: Record<string, string>) => {
			s.groups = g;
			s.colors = c;
		}),
		saveMeta: vi.fn(),
		replaceMeta: vi.fn((m: Record<string, PluginMetaEntry>) => {
			s.meta = m;
		}),
	};
	return s;
}

// 触发 composer 的「添加分组」按钮
function clickAdd(modal: GroupManagementModal) {
	const composer = modal.contentEl.querySelector<HTMLElement>(".cpm-group-composer")!;
	const input = composer.querySelector<HTMLInputElement>("input")!;
	const btn = composer.querySelector<HTMLButtonElement>("button")!;
	return { input, btn };
}

// 把重命名输入框设为新值（模拟用户输入：同步内部 value 后再触发 Enter/Esc/blur）
function setRenameValue(modal: GroupManagementModal, value: string): HTMLInputElement {
	const input = modal.contentEl.querySelector<HTMLInputElement>(".cpm-group-row input")!;
	input.value = value;
	input.dispatchEvent(new Event("input"));
	return input;
}

beforeEach(() => {
	vi.clearAllMocks();
	document.body.innerHTML = "";
});

describe("GroupManagementModal", () => {
	it("onOpen：css 作用域渲染标题 + 顶部添加栏 + 列表（39-60）", () => {
		const store = makeStore({ g1: "分组一" });
		const modal = new GroupManagementModal({} as never, store);
		modal.open();
		expect(modal.contentEl.querySelector("h3")?.textContent).toBeTruthy();
		expect(modal.contentEl.querySelector(".cpm-group-composer")).toBeTruthy();
		expect(modal.contentEl.querySelector(".cpm-group-row")).toBeTruthy();
	});

	it("onOpen：plugin 作用域走另一标题分支（50-52）", () => {
		const cssModal = new GroupManagementModal({} as never, makeStore({}, "css"));
		cssModal.open();
		const pluginModal = new GroupManagementModal({} as never, makeStore({}, "plugin"));
		pluginModal.open();
		const a = cssModal.contentEl.querySelector("h3")?.textContent ?? "";
		const b = pluginModal.contentEl.querySelector("h3")?.textContent ?? "";
		expect(a).not.toEqual(b);
	});

	it("列表为空 → 渲染空态（110-115）", () => {
		const modal = new GroupManagementModal({} as never, makeStore({}));
		modal.open();
		expect(modal.contentEl.querySelector(".cpm-group-empty")).toBeTruthy();
		expect(modal.contentEl.querySelector(".cpm-group-row")).toBeNull();
	});

	it("renderList：自定义分组计数提示（117-122）", () => {
		const modal = new GroupManagementModal({} as never, makeStore({ g1: "G1", g2: "G2" }));
		modal.open();
		expect(modal.contentEl.querySelector(".cpm-group-count-hint")?.textContent).toContain("2");
	});

	it("添加分组：输入为空 → 不落盘（86-90）", () => {
		const store = makeStore({});
		const modal = new GroupManagementModal({} as never, store);
		modal.open();
		const { input, btn } = clickAdd(modal);
		input.value = "";
		btn.click();
		expect(store.saveGroups).not.toHaveBeenCalled();
	});

	it("添加分组：名称已存在 → 不落盘（91-95）", () => {
		const store = makeStore({});
		vi.mocked(groupDomain.addGroup).mockReturnValue(null);
		const modal = new GroupManagementModal({} as never, store);
		modal.open();
		const { input, btn } = clickAdd(modal);
		input.value = "已存在";
		btn.click();
		expect(store.saveGroups).not.toHaveBeenCalled();
	});

	it("添加分组：成功 → 落盘 + 列表出现新行 + 输入框清空（96-100）", () => {
		const store = makeStore({ g1: "G1" });
		vi.mocked(groupDomain.addGroup).mockReturnValue({ key: "g2", groups: { g1: "G1", g2: "G2" } });
		const modal = new GroupManagementModal({} as never, store);
		modal.open();
		const { input, btn } = clickAdd(modal);
		input.value = "G2";
		btn.click();
		expect(store.saveGroups).toHaveBeenCalledWith({ g1: "G1", g2: "G2" }, {});
		const rows = modal.contentEl.querySelectorAll(".cpm-group-row");
		expect(rows.length).toBe(2);
		expect(modal.contentEl.textContent).toContain("G2");
	});

	it("renderRow：有自定义色 → 显示「重置颜色」按钮（155-165）", () => {
		const store = makeStore({ g1: "G1" });
		store.colors = { g1: "#abcdef" };
		vi.mocked(groupDomain.getGroupColor).mockImplementation((colors: Record<string, string>, key: string) => colors?.[key]);
		const modal = new GroupManagementModal({} as never, store);
		modal.open();
		expect(modal.contentEl.querySelector(".cpm-icon-rotate-ccw")).toBeTruthy();
	});

	it("renderRow：无自定义色 → 不显示「重置颜色」按钮（155）", () => {
		const store = makeStore({ g1: "G1" });
		const modal = new GroupManagementModal({} as never, store);
		modal.open();
		expect(modal.contentEl.querySelector(".cpm-icon-rotate-ccw")).toBeNull();
	});

	it("renderRow：用量计数渲染（167-178）", () => {
		const store = makeStore({ g1: "G1" });
		vi.mocked(groupDomain.countMembersByGroup).mockReturnValue({ g1: 3 });
		const modal = new GroupManagementModal({} as never, store);
		modal.open();
		expect(modal.contentEl.querySelector(".cpm-group-usage")?.textContent).toContain("3");
	});

	it("配色变更 → saveGroups 写入新颜色（148-152）", () => {
		const store = makeStore({ g1: "G1" });
		const modal = new GroupManagementModal({} as never, store);
		modal.open();
		const colorInput = modal.contentEl.querySelector<HTMLInputElement>('input[type="color"]')!;
		colorInput.value = "#112233";
		colorInput.dispatchEvent(new Event("input"));
		expect(store.saveGroups).toHaveBeenCalledWith({ g1: "G1" }, { g1: "#112233" });
	});

	it("重置颜色点击 → 删除该 key 并 saveGroups（156-165）", () => {
		const store = makeStore({ g1: "G1" });
		store.colors = { g1: "#abcdef" };
		vi.mocked(groupDomain.getGroupColor).mockImplementation((colors: Record<string, string>, key: string) => colors?.[key]);
		const modal = new GroupManagementModal({} as never, store);
		modal.open();
		const reset = modal.contentEl.querySelector<HTMLElement>(".cpm-icon-rotate-ccw")!;
		reset.click();
		expect(store.saveGroups).toHaveBeenCalledWith({ g1: "G1" }, {});
	});

	it("删除分组：成功 → replaceMeta + saveGroups + 行消失（235-245）", () => {
		const store = makeStore({ g1: "G1", g2: "G2" });
		vi.mocked(groupDomain.removeGroup).mockReturnValue({ g2: "G2" });
		const modal = new GroupManagementModal({} as never, store);
		modal.open();
		// 第一行（g1）的删除按钮
		const trash = modal.contentEl.querySelector<HTMLElement>(".cpm-icon-trash")!;
		trash.click();
		expect(groupDomain.reassignMetaGroup).toHaveBeenCalled();
		expect(store.replaceMeta).toHaveBeenCalled();
		expect(store.saveGroups).toHaveBeenCalledWith({ g2: "G2" }, {});
		// 列表重渲后只剩 g2 一行
		expect(modal.contentEl.querySelectorAll(".cpm-group-row").length).toBe(1);
	});

	it("删除分组：removeGroup 返回 null → 早退不改动（236-237）", () => {
		const store = makeStore({ g1: "G1" });
		vi.mocked(groupDomain.removeGroup).mockReturnValue(null);
		const modal = new GroupManagementModal({} as never, store);
		modal.open();
		const trash = modal.contentEl.querySelector<HTMLElement>(".cpm-icon-trash")!;
		trash.click();
		expect(store.saveGroups).not.toHaveBeenCalled();
	});

	it("内联重命名：输入为空/同名 → 仅重渲不落盘（204-209）", () => {
		const store = makeStore({ g1: "G1" });
		const modal = new GroupManagementModal({} as never, store);
		modal.open();
		modal.contentEl.querySelector<HTMLElement>(".cpm-icon-pencil")!.click();
		const input = setRenameValue(modal, "G1"); // 同名
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		expect(groupDomain.renameGroup).not.toHaveBeenCalled();
	});

	it("内联重命名：Enter 提交新名 → renameGroup + saveGroups（210-219）", () => {
		const store = makeStore({ g1: "G1" });
		vi.mocked(groupDomain.renameGroup).mockReturnValue({ g1: "新名" });
		const modal = new GroupManagementModal({} as never, store);
		modal.open();
		modal.contentEl.querySelector<HTMLElement>(".cpm-icon-pencil")!.click();
		const input = setRenameValue(modal, "新名");
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		expect(groupDomain.renameGroup).toHaveBeenCalledWith({ g1: "G1" }, "g1", "新名");
		expect(store.saveGroups).toHaveBeenCalledWith({ g1: "新名" }, {});
	});

	it("内联重命名：重名冲突 → 不落盘（211-215）", () => {
		const store = makeStore({ g1: "G1" });
		vi.mocked(groupDomain.renameGroup).mockReturnValue(null);
		const modal = new GroupManagementModal({} as never, store);
		modal.open();
		modal.contentEl.querySelector<HTMLElement>(".cpm-icon-pencil")!.click();
		const input = setRenameValue(modal, "冲突名");
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		expect(store.saveGroups).not.toHaveBeenCalled();
	});

	it("内联重命名：Esc → 仅重渲不提交（225-228）", () => {
		const store = makeStore({ g1: "G1" });
		const modal = new GroupManagementModal({} as never, store);
		modal.open();
		modal.contentEl.querySelector<HTMLElement>(".cpm-icon-pencil")!.click();
		const input = setRenameValue(modal, "改一半");
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expect(groupDomain.renameGroup).not.toHaveBeenCalled();
	});

	it("内联重命名：blur → 提交（230）", () => {
		const store = makeStore({ g1: "G1" });
		vi.mocked(groupDomain.renameGroup).mockReturnValue({ g1: "blur名" });
		const modal = new GroupManagementModal({} as never, store);
		modal.open();
		modal.contentEl.querySelector<HTMLElement>(".cpm-icon-pencil")!.click();
		const input = setRenameValue(modal, "blur名");
		input.dispatchEvent(new Event("blur"));
		expect(store.saveGroups).toHaveBeenCalled();
	});

	it("onClose：清空 contentEl（62-64）", () => {
		const modal = new GroupManagementModal({} as never, makeStore({ g1: "G1" }));
		modal.open();
		expect(modal.contentEl.children.length).toBeGreaterThan(0);
		modal.close();
		expect(modal.contentEl.children.length).toBe(0);
	});
});
