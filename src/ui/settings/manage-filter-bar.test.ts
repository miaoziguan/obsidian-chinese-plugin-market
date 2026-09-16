import { describe, it, expect, afterEach } from "vitest";
import { ManageFilterBar } from "./manage-filter-bar";
import { GROUP_ALL } from "@domain/manage/types";

function mount(): ManageFilterBar {
	const fb = new ManageFilterBar({ onChange: () => {}, onManageGroups: () => {} });
	document.body.appendChild(fb.containerEl);
	return fb;
}

afterEach(() => {
	document.body.innerHTML = "";
});

describe("ManageFilterBar", () => {
	it("分组下拉默认含全部并选中全部", () => {
		const fb = mount();
		fb.updateGroups(
			[
				{ key: GROUP_ALL, name: "全部" },
				{ key: "1", name: "写作" },
			],
			{ [GROUP_ALL]: 3, "1": 1 },
		);
		const options = Array.from(
			fb.containerEl.querySelectorAll("select.cpm-filter-group option")
		) as HTMLOptionElement[];
		expect(options.map((o) => o.value)).toEqual([GROUP_ALL, "1"]);
		expect(fb.getState().group).toBe(GROUP_ALL);
	});

	it("选择分组后 getState 反映选择", () => {
		const fb = mount();
		fb.updateGroups(
			[
				{ key: GROUP_ALL, name: "全部" },
				{ key: "1", name: "写作" },
			],
			{}
		);
		const select = fb.containerEl.querySelector("select.cpm-filter-group") as HTMLSelectElement;
		select.value = "1";
		select.dispatchEvent(new Event("change"));
		expect(fb.getState().group).toBe("1");
	});

	it("状态下拉切换生效", () => {
		const fb = mount();
		const select = fb.containerEl.querySelector("select.cpm-filter-status") as HTMLSelectElement;
		select.value = "enabled";
		select.dispatchEvent(new Event("change"));
		expect(fb.getState().status).toBe("enabled");
	});

	it("管理分组图标按钮触发 onManageGroups", () => {
		let called = false;
		const fb = new ManageFilterBar({ onChange: () => {}, onManageGroups: () => (called = true) });
		document.body.appendChild(fb.containerEl);
		const btn = fb.containerEl.querySelector(".cpm-icon-tags") as HTMLButtonElement;
		expect(btn).not.toBeNull();
		btn.click();
		expect(called).toBe(true);
	});

	it("setCount 渲染中文计数", () => {
		const fb = mount();
		fb.setCount(5);
		expect(fb.containerEl.querySelector(".cpm-filter-count")?.textContent).toBe("5 个插件");
		fb.setCount(0);
		expect(fb.containerEl.querySelector(".cpm-filter-count")?.textContent).toBe("");
	});
});
