import { describe, it, expect } from "vitest";
import {
	addGroup,
	countMembersByGroup,
	createDefaultManageSettings,
	isBuiltinGroup,
	listGroups,
	nextGroupKey,
	normalizeManageSettings,
	removeGroup,
	renameGroup,
	reassignMetaGroup,
} from "./group";
import { GROUP_ALL, GROUP_OTHER } from "./types";

describe("createDefaultManageSettings", () => {
	it("内置「全部」与「其他」分组", () => {
		const settings = createDefaultManageSettings();
		expect(settings.pluginGroups[GROUP_ALL]).toBe("全部");
		expect(settings.pluginGroups[GROUP_OTHER]).toBe("其他");
		expect(settings.pluginMeta).toEqual({});
	});

	it("每次返回全新对象（避免调用方共享默认常量）", () => {
		const a = createDefaultManageSettings();
		const b = createDefaultManageSettings();
		expect(a).not.toBe(b);
		expect(a.pluginGroups).not.toBe(b.pluginGroups);
	});
});

describe("normalizeManageSettings", () => {
	it("空输入也能得到完整形状", () => {
		const settings = normalizeManageSettings(undefined);
		expect(settings.enabled).toBe(true);
		expect(settings.pluginGroups[GROUP_ALL]).toBe("全部");
		expect(settings.pluginGroups[GROUP_OTHER]).toBe("其他");
		expect(settings.pluginMeta).toEqual({});
	});

	it("保留显式关闭的开关", () => {
		expect(normalizeManageSettings({ enabled: false }).enabled).toBe(false);
	});

	it("悬空的分组引用回落到「其他」", () => {
		const settings = normalizeManageSettings({
			pluginMeta: { foo: { group: "999", remark: "hi" } },
		});
		expect(settings.pluginMeta.foo.group).toBe(GROUP_OTHER);
		expect(settings.pluginMeta.foo.remark).toBe("hi");
	});

	it("丢弃非对象条目并清理脏字段", () => {
		const settings = normalizeManageSettings({
			pluginMeta: { a: "bad", b: { group: 1, remark: 2 } },
		});
		expect(settings.pluginMeta.a).toBeUndefined();
		expect(settings.pluginMeta.b.remark).toBe("");
		expect(settings.pluginMeta.b.group).toBe(GROUP_OTHER);
	});

	it("颜色只保留存在的分组", () => {
		const settings = normalizeManageSettings({
			pluginGroups: { "1": "写作" },
			pluginGroupColors: { "1": "#fff", "404": "#000" },
		});
		expect(settings.pluginGroupColors["1"]).toBe("#fff");
		expect(settings.pluginGroupColors["404"]).toBeUndefined();
	});
});

describe("listGroups", () => {
	it("全部在最前、其他在最后，自定义按创建顺序居中", () => {
		const groups = { ...createDefaultManageSettings().pluginGroups, "2": "阅读", "1": "写作" };
		expect(listGroups(groups).map((g) => g.key)).toEqual([GROUP_ALL, "1", "2", GROUP_OTHER]);
	});
});

describe("addGroup", () => {
	it("按递增序号生成 key", () => {
		const result = addGroup(createDefaultManageSettings().pluginGroups, "写作");
		expect(result).not.toBeNull();
		expect(result?.key).toBe("1");
		expect(result?.groups["1"]).toBe("写作");
		expect(nextGroupKey(result!.groups)).toBe("2");
	});

	it("空名与重名均返回 null", () => {
		const groups = createDefaultManageSettings().pluginGroups;
		expect(addGroup(groups, "   ")).toBeNull();
		expect(addGroup(groups, "其他")).toBeNull();
	});
});

describe("renameGroup", () => {
	it("重命名成功", () => {
		const groups = addGroup(createDefaultManageSettings().pluginGroups, "写作")!.groups;
		expect(renameGroup(groups, "1", "写")?.["1"]).toBe("写");
	});

	it("重名或空名返回 null", () => {
		const groups = addGroup(createDefaultManageSettings().pluginGroups, "写作")!.groups;
		expect(renameGroup(groups, "1", "其他")).toBeNull();
		expect(renameGroup(groups, "1", " ")).toBeNull();
	});
});

describe("removeGroup", () => {
	it("内置分组不可删除", () => {
		const groups = createDefaultManageSettings().pluginGroups;
		expect(isBuiltinGroup(GROUP_ALL)).toBe(true);
		expect(removeGroup(groups, GROUP_ALL)).toBeNull();
		expect(removeGroup(groups, GROUP_OTHER)).toBeNull();
	});

	it("自定义分组可删除", () => {
		const groups = addGroup(createDefaultManageSettings().pluginGroups, "写作")!.groups;
		expect(removeGroup(groups, "1")?.["1"]).toBeUndefined();
	});
});

describe("reassignMetaGroup", () => {
	it("把成员迁移到目标分组，且不改其它条目", () => {
		const meta = {
			a: { group: "1", remark: "x" },
			b: { group: "2", remark: "y" },
		};
		const next = reassignMetaGroup(meta, "1", GROUP_OTHER);
		expect(next.a.group).toBe(GROUP_OTHER);
		expect(next.b.group).toBe("2");
	});

	it("无成员时返回原引用（便于调用方跳过写盘）", () => {
		const meta = { b: { group: "2", remark: "y" } };
		expect(reassignMetaGroup(meta, "1", GROUP_OTHER)).toBe(meta);
	});
});

describe("filterState 默认与规范化", () => {
	it("默认搜索词空、分组全部、状态全部", () => {
		const s = createDefaultManageSettings();
		expect(s.filterState).toEqual({ keyword: "", group: GROUP_ALL, status: "all" });
	});

	it("规范化剔除脏字段并兜底", () => {
		const s = normalizeManageSettings({
			pluginGroups: { "1": "写作" },
			filterState: { keyword: 123 as unknown as string, group: "404", status: "weird" },
		});
		expect(s.filterState).toEqual({ keyword: "", group: GROUP_ALL, status: "all" });
	});

	it("规范化保留有效筛选状态", () => {
		const s = normalizeManageSettings({
			pluginGroups: { "1": "写作" },
			filterState: { keyword: "k", group: "1", status: "enabled" },
		});
		expect(s.filterState).toEqual({ keyword: "k", group: "1", status: "enabled" });
	});
});

describe("countMembersByGroup", () => {
	it("GROUP_ALL 计总数，其余按 group 累加", () => {
		const meta = {
			a: { group: "1", remark: "" },
			b: { group: "1", remark: "" },
			c: { group: "2", remark: "" },
			d: { group: GROUP_OTHER, remark: "" },
		};
		const counts = countMembersByGroup(meta);
		expect(counts[GROUP_ALL]).toBe(4);
		expect(counts["1"]).toBe(2);
		expect(counts["2"]).toBe(1);
		expect(counts[GROUP_OTHER]).toBe(1);
	});

	it("空元数据仅全部为 0", () => {
		const counts = countMembersByGroup({});
		expect(counts[GROUP_ALL]).toBe(0);
	});
});
