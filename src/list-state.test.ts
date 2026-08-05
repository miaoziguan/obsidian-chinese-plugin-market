import { describe, it, expect } from "vitest";
import { setListState, type ListStateHost } from "./list-state";

function makeHost(): ListStateHost {
	return {
		listState: "guide",
		resultCountEl: document.createElement("div"),
	};
}

describe("listState 状态机", () => {
	it("list 态显示计数，其余态一律隐藏", () => {
		const host = makeHost();

		setListState(host, "list");
		expect(host.listState).toBe("list");
		expect(host.resultCountEl!.style.display).toBe("");

		for (const s of ["guide", "loading", "error", "aiPending", "aiConfig"] as const) {
			setListState(host, s);
			expect(host.listState).toBe(s);
			expect(host.resultCountEl!.style.display).toBe("none");
		}
	});

	it("resultCountEl 未挂载时不抛错，状态照常落地", () => {
		const host: ListStateHost = { listState: "guide", resultCountEl: null };
		expect(() => setListState(host, "error")).not.toThrow();
		expect(host.listState).toBe("error");
	});
});
