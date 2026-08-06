import { describe, it, expect } from "vitest";
import { TMDirtyTracker } from "@translation/memory/tm-dirty";

describe("TMDirtyTracker (P2-1: TM 脏标记从 translator 下沉)", () => {
	it("markDirty + peekDirty 不清除，takeDirty 取走后清空", () => {
		const t = new TMDirtyTracker();
		t.markDirty("p1");
		t.markDirty("p2");
		expect(t.peekDirty()).toEqual(["p1", "p2"]);
		expect(t.takeDirty()).toEqual(["p1", "p2"]);
		expect(t.peekDirty()).toEqual([]);
	});

	it("clearDirty 仅移除单条", () => {
		const t = new TMDirtyTracker();
		t.markDirty("p1");
		t.markDirty("p2");
		t.clearDirty("p1");
		expect(t.peekDirty()).toEqual(["p2"]);
	});

	it("markRemoved + peekRemoved 不清除，takeRemoved 取走后清空", () => {
		const t = new TMDirtyTracker();
		t.markRemoved("p1");
		expect(t.peekRemoved()).toEqual(["p1"]);
		expect(t.takeRemoved()).toEqual(["p1"]);
		expect(t.peekRemoved()).toEqual([]);
	});

	it("dirty 与 removed 互不干扰", () => {
		const t = new TMDirtyTracker();
		t.markDirty("p1");
		t.markRemoved("p2");
		expect(t.peekDirty()).toEqual(["p1"]);
		expect(t.peekRemoved()).toEqual(["p2"]);
	});
});
