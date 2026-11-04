import { describe, it, expect } from "vitest";
import { getMeta, setMeta, pruneOrphanedMeta } from "./plugin-meta";
import { GROUP_OTHER } from "./types";

describe("getMeta", () => {
	it("未登记 → 其他分组 + 空备注", () => {
		expect(getMeta({}, "x")).toEqual({ group: GROUP_OTHER, remark: "" });
	});
	it("已登记且字段合法 → 原样返回", () => {
		const meta = { x: { group: "g1", remark: "备注" } };
		expect(getMeta(meta, "x")).toEqual({ group: "g1", remark: "备注" });
	});
	it("group 为假值 → 回退 OTHER", () => {
		expect(getMeta({ x: { group: "", remark: "r" } }, "x").group).toBe(GROUP_OTHER);
	});
	it("remark 非字符串 → 回退空串", () => {
		expect(getMeta({ x: { group: "g1", remark: 123 as unknown as string } }, "x").remark).toBe("");
	});
});

describe("setMeta", () => {
	it("仅 patch group → 保留原 remark", () => {
		const meta = { x: { group: "g1", remark: "原备注" } };
		const out = setMeta(meta, "x", { group: "g2" });
		expect(out.x).toEqual({ group: "g2", remark: "原备注" });
		expect(meta.x.group).toBe("g1"); // 不可变
	});
	it("仅 patch remark → 保留原 group", () => {
		const out = setMeta({ x: { group: "g1", remark: "" } }, "x", { remark: "新" });
		expect(out.x).toEqual({ group: "g1", remark: "新" });
	});
	it("patch 两者 + 未登记项也能写入", () => {
		const out = setMeta({}, "y", { group: "g2", remark: "r2" });
		expect(out.y).toEqual({ group: "g2", remark: "r2" });
	});
});

describe("pruneOrphanedMeta", () => {
	it("validIds 为 Set → 剔除孤儿", () => {
		const meta = { a: { group: "g", remark: "" }, b: { group: "g", remark: "" }, c: { group: "g", remark: "" } };
		const out = pruneOrphanedMeta(meta, new Set(["a", "c"]));
		expect(Object.keys(out).sort()).toEqual(["a", "c"]);
		expect(out).not.toBe(meta);
	});
	it("validIds 为可迭代数组（非 Set）→ 同样生效", () => {
		const meta = { a: { group: "g", remark: "" }, b: { group: "g", remark: "" } };
		const out = pruneOrphanedMeta(meta, ["a"]);
		expect(Object.keys(out)).toEqual(["a"]);
	});
	it("无孤儿 → 返回原引用（跳过写盘）", () => {
		const meta = { a: { group: "g", remark: "" } };
		expect(pruneOrphanedMeta(meta, new Set(["a"]))).toBe(meta);
	});
});
