import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderUpdatesList } from "./view-updates";
import { createMenuSelect } from "@ui/components/menu-select";
import { openVersionPicker } from "@ui/components/version-picker-modal";
import { createUpdateProgressLayer } from "@ui/components/update-progress";
import { refreshOutdated } from "@ui/view/view-data";
import type { ViewContext } from "./view-context";
import type { PluginInfo } from "@domain/catalog/translator";

vi.mock("@ui/view/view-data", () => ({ refreshOutdated: vi.fn(() => Promise.resolve()) }));
vi.mock("@ui/components/version-picker-modal", () => ({ openVersionPicker: vi.fn() }));
vi.mock("@ui/components/update-progress", () => ({
	createUpdateProgressLayer: vi.fn(() => ({ el: document.createElement("div"), set: vi.fn(), finish: vi.fn() })),
}));
vi.mock("@ui/components/menu-select", () => ({ createMenuSelect: vi.fn() }));

// 局部补齐 Obsidian 对 HTMLElement 的 createEl/createDiv/createSpan/empty/setText/hasClass 增强
type ElOpts =
	| string
	| { cls?: string; text?: string | null; type?: string; attr?: Record<string, string> };
function ensureDomHelpers(): void {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	if (!proto.createEl) {
		proto.createEl = function (this: HTMLElement, tag: string, o?: ElOpts): HTMLElement {
			const el = document.createElement(tag);
			if (typeof o === "string") el.textContent = o;
			else if (o) {
				if (o.cls) el.className = o.cls;
				if (o.text != null) el.textContent = o.text;
				if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, v);
			}
			this.appendChild(el);
			return el;
		};
	}
	if (!proto.createDiv) {
		proto.createDiv = function (this: HTMLElement, o?: ElOpts): HTMLElement {
			return (this as unknown as { createEl: (t: string, o?: ElOpts) => HTMLElement }).createEl("div", o);
		};
	}
	if (!proto.createSpan) {
		proto.createSpan = function (this: HTMLElement, o?: ElOpts): HTMLElement {
			return (this as unknown as { createEl: (t: string, o?: ElOpts) => HTMLElement }).createEl("span", o);
		};
	}
	if (!proto.setText) {
		proto.setText = function (this: HTMLElement, t: string): HTMLElement {
			this.textContent = t;
			return this;
		};
	}
	if (!proto.hasClass) {
		proto.hasClass = function (this: HTMLElement, c: string): boolean {
			return this.classList.contains(c);
		};
	}
}
ensureDomHelpers();

// focus-restore 用 el.instanceOf（Obsidian 增强），jsdom 不存在，补齐
const fproto = HTMLElement.prototype as unknown as { instanceOf?: (c: new (...a: never[]) => unknown) => boolean };
if (!fproto.instanceOf) {
	fproto.instanceOf = function (this: HTMLElement, c: new (...a: never[]) => unknown) {
		return this instanceof c;
	};
}

function plug(id: string, name: string, repo?: string): PluginInfo {
	return { id, name, repo } as unknown as PluginInfo;
}

function makeCtx(over: Record<string, unknown> = {}): ViewContext {
	const base = {
		t: vi.fn((k: string, v?: Record<string, string>) => (v ? `${k}:${JSON.stringify(v)}` : k)),
		updatesListEl: document.createElement("div"),
		outdatedIds: new Set<string>(),
		updatesViewMode: "pending" as "pending" | "installed",
		updateSelection: new Set<string>(),
		outdatedInfo: new Map<string, { local: string; latest: string }>(),
		installedVersions: new Map<string, string>(),
		pluginVersionPins: {} as Record<string, string>,
		installedIds: new Set<string>(),
		enabledIds: new Set<string>(),
		allPlugins: [] as PluginInfo[],
		updatePlugin: vi.fn(() => Promise.resolve()),
		pinPluginVersion: vi.fn(() => Promise.resolve()),
		refreshViewTabsBadge: vi.fn(),
		renderUpdatesList: vi.fn(),
		updateAll: vi.fn(() => Promise.resolve()),
		updateSelected: vi.fn(() => Promise.resolve()),
		app: {},
		listPluginVersions: vi.fn(() => Promise.resolve([])),
		track: vi.fn(),
	};
	return { ...base, ...over } as unknown as ViewContext;
}

const rows = (ctx: any) => Array.from((ctx.updatesListEl as HTMLElement).querySelectorAll<HTMLElement>(".pt-updates-row"));
const rowActions = (row: HTMLElement) =>
	Array.from(row.querySelectorAll<HTMLElement>("button"));

beforeEach(() => {
	vi.clearAllMocks();
});

describe("renderUpdatesList：pending 模式", () => {
	it("updatesListEl 缺失 → 安全返回（168-169）", () => {
		const c = makeCtx({ updatesListEl: null }) as unknown as ViewContext;
		expect(() => renderUpdatesList(c)).not.toThrow();
	});

	it("无待更 + 无固定 → 空态（标题/提示）+ restoreFocus（263-271）", () => {
		const c = makeCtx({ outdatedIds: new Set(), allPlugins: [] }) as any;
		renderUpdatesList(c);
		expect(c.updatesListEl.querySelector(".pt-updates-empty-title")?.textContent).toBe("updates.empty");
		expect(c.updatesListEl.querySelector(".pt-updates-empty-hint")?.textContent).toBe("updates.empty.hint");
		expect(rows(c).length).toBe(0);
	});

	it("有待更 → 行列表 + 计数 + 每行 勾选/名称/版本差/固定/更新 按钮（174-285）", () => {
		const c = makeCtx({
			outdatedIds: new Set(["a", "b"]),
			allPlugins: [plug("a", "Alpha", "o/a"), plug("b", "Beta", "o/b")],
			outdatedInfo: new Map([["a", { local: "1.0", latest: "2.0" }]]),
		}) as any;
		renderUpdatesList(c);
		expect(rows(c).length).toBe(2);
		const r = rows(c)[0];
		expect(r.querySelector(".pt-updates-name")?.textContent).toBe("Alpha");
		expect(r.querySelector(".pt-updates-diff")?.textContent).toBe('updates.versionDiff:{"local":"1.0","latest":"2.0"}');
		const btns = rowActions(r);
		expect(btns.some((b) => b.classList.contains("pt-updates-row-pin"))).toBe(true);
		expect(btns.some((b) => b.classList.contains("pt-updates-row-update"))).toBe(true);
		// 计数文案
		expect(c.updatesListEl.querySelector(".pt-updates-count")?.textContent).toBe('updates.count:{"n":"0","m":"2"}');
	});

	it("勾选框变化 → updateSelection 增删 + 计数同步（95-100、252-255）", () => {
		const c = makeCtx({
			outdatedIds: new Set(["a"]),
			allPlugins: [plug("a", "Alpha", "o/a")],
		}) as any;
		renderUpdatesList(c);
		const cb = rows(c)[0].querySelector(".pt-updates-check") as HTMLInputElement;
		cb.checked = true;
		cb.dispatchEvent(new Event("change"));
		expect(c.updateSelection.has("a")).toBe(true);
		expect(c.updatesListEl.querySelector(".pt-updates-count")?.textContent).toBe('updates.count:{"n":"1","m":"1"}');
		cb.checked = false;
		cb.dispatchEvent(new Event("change"));
		expect(c.updateSelection.has("a")).toBe(false);
	});

	it("固定按钮 → openVersionPicker（42-51）", () => {
		const c = makeCtx({
			outdatedIds: new Set(["a"]),
			allPlugins: [plug("a", "Alpha", "o/a")],
			pluginVersionPins: {},
		}) as any;
		renderUpdatesList(c);
		const pin = rows(c)[0].querySelector(".pt-updates-row-pin") as HTMLElement;
		pin.click();
		expect(openVersionPicker).toHaveBeenCalledWith(
			expect.objectContaining({ pluginName: "Alpha", repo: "o/a", onPick: expect.any(Function) }),
		);
	});

	it("更新按钮：成功 → pt-spin 复位 + refreshViewTabsBadge + 重绘（53-80）", async () => {
		const c = makeCtx({
			outdatedIds: new Set(["a"]),
			allPlugins: [plug("a", "Alpha", "o/a")],
		}) as any;
		renderUpdatesList(c);
		const upd = rows(c)[0].querySelector(".pt-updates-row-update") as HTMLElement;
		upd.click();
		expect(upd.classList.contains("pt-spin")).toBe(true);
		expect(c.updatePlugin).toHaveBeenCalledWith("a");
		await vi.waitFor(() => {
			expect(upd.classList.contains("pt-spin")).toBe(false);
			expect(c.renderUpdatesList).toHaveBeenCalled();
		});
	});

	it("更新按钮：失败 → 仍撤掉旋转态 + 重绘（66-78）", async () => {
		const c = makeCtx({
			outdatedIds: new Set(["a"]),
			allPlugins: [plug("a", "Alpha", "o/a")],
		}) as any;
		c.updatePlugin.mockReturnValue(Promise.reject(new Error("boom")));
		renderUpdatesList(c);
		(rows(c)[0].querySelector(".pt-updates-row-update") as HTMLElement).click();
		await vi.waitFor(() => {
			expect((rows(c)[0].querySelector(".pt-updates-row-update") as HTMLElement).classList.contains("pt-spin")).toBe(false);
			expect(c.renderUpdatesList).toHaveBeenCalled();
		});
	});

	it("更新按钮：pt-spin 守卫，连点只更新一次（60-62）", () => {
		let resolveUpd!: () => void;
		const c = makeCtx({
			outdatedIds: new Set(["a"]),
			allPlugins: [plug("a", "Alpha", "o/a")],
		}) as any;
		c.updatePlugin.mockReturnValue(new Promise<void>((res) => (resolveUpd = res)));
		renderUpdatesList(c);
		const upd = rows(c)[0].querySelector(".pt-updates-row-update") as HTMLElement;
		upd.click();
		upd.click();
		expect(c.updatePlugin).toHaveBeenCalledTimes(1);
		resolveUpd();
	});
});

describe("renderUpdatesList：工具条批量操作", () => {
	it("全部选择 → updateSelection 含所有待更 + 重绘（206-210）", () => {
		const c = makeCtx({
			outdatedIds: new Set(["a", "b"]),
			allPlugins: [plug("a", "Alpha"), plug("b", "Beta")],
		}) as any;
		renderUpdatesList(c);
		c.updatesListEl.querySelector(".pt-updates-selectall")!.click();
		expect(c.updateSelection.has("a")).toBe(true);
		expect(c.updateSelection.has("b")).toBe(true);
		expect(c.renderUpdatesList).toHaveBeenCalled();
	});

	it("取消全选 → updateSelection 清空（211-215）", () => {
		const c = makeCtx({
			outdatedIds: new Set(["a"]),
			allPlugins: [plug("a", "Alpha")],
			updateSelection: new Set(["a"]),
		}) as any;
		renderUpdatesList(c);
		c.updatesListEl.querySelector(".pt-updates-deselect")!.click();
		expect(c.updateSelection.size).toBe(0);
	});

	it("更新所选：有选中 → 批量更新（runBatchUpdate）（221-225）", () => {
		const c = makeCtx({
			outdatedIds: new Set(["a", "b"]),
			allPlugins: [plug("a", "Alpha"), plug("b", "Beta")],
			updateSelection: new Set(["a"]),
		}) as any;
		renderUpdatesList(c);
		c.updatesListEl.querySelector(".pt-updates-update-sel")!.click();
		expect(createUpdateProgressLayer).toHaveBeenCalled();
		expect(c.track).toHaveBeenCalledWith("action:updateSelected");
		expect(c.updateSelected).toHaveBeenCalledWith(["a"], expect.any(Function));
	});

	it("更新全部：有待更 → 批量更新（227-235）", () => {
		const c = makeCtx({
			outdatedIds: new Set(["a", "b"]),
			allPlugins: [plug("a", "Alpha"), plug("b", "Beta")],
		}) as any;
		renderUpdatesList(c);
		c.updatesListEl.querySelector(".pt-updates-update-all")!.click();
		expect(c.track).toHaveBeenCalledWith("action:updateAll");
		expect(c.updateAll).toHaveBeenCalledWith(expect.any(Function));
	});

	it("更新全部：无待更 → 仅提示不启动批量（230-233）", () => {
		const c = makeCtx({ outdatedIds: new Set(), allPlugins: [] }) as any;
		renderUpdatesList(c);
		c.updatesListEl.querySelector(".pt-updates-update-all")!.click();
		expect(createUpdateProgressLayer).not.toHaveBeenCalled();
		expect(c.updateAll).not.toHaveBeenCalled();
	});

	it("检查更新按钮：refreshOutdated + 结果提示 + 复位（185-204）", async () => {
		const c = makeCtx({
			outdatedIds: new Set(["a", "b"]),
			allPlugins: [plug("a", "Alpha")],
		}) as any;
		renderUpdatesList(c);
		const btn = c.updatesListEl.querySelector(".pt-updates-checkbtn")!;
		btn.click();
		expect(btn.classList.contains("pt-spin")).toBe(true);
		expect(refreshOutdated).toHaveBeenCalledWith(c);
		await vi.waitFor(() => {
			expect(btn.classList.contains("pt-spin")).toBe(false);
			expect(c.renderUpdatesList).toHaveBeenCalled();
		});
	});

	it("视图切换 → onPick 改 updatesViewMode + 重绘（239-250）", () => {
		const c = makeCtx({ outdatedIds: new Set(["a"]), allPlugins: [plug("a", "Alpha")] }) as any;
		renderUpdatesList(c);
		const opts = vi.mocked(createMenuSelect).mock.calls[0][1] as { onPick: (v: string) => void };
		opts.onPick("installed");
		expect(c.updatesViewMode).toBe("installed");
		expect(c.renderUpdatesList).toHaveBeenCalled();
	});
});

describe("renderUpdatesList：installed 模式与行类型", () => {
	it("installed 模式空 → installedNone 空态（305-310）", () => {
		const c = makeCtx({ updatesViewMode: "installed", allPlugins: [] }) as any;
		renderUpdatesList(c);
		expect(c.updatesListEl.querySelector(".pt-updates-empty-title")?.textContent).toBe("updates.installedNone");
	});

	it("installed 模式：可更新/固定/停用/最新 四组互斥（301-345）", () => {
		const c = makeCtx({
			updatesViewMode: "installed",
			allPlugins: [
				plug("a", "Alpha", "o/a"),
				plug("b", "Beta", "o/b"),
				plug("c", "Gamma", "o/c"),
				plug("d", "Delta", "o/d"),
			],
			installedIds: new Set(["a", "b", "c", "d"]),
			outdatedIds: new Set(["a"]),
			pluginVersionPins: { b: "1.0" },
			enabledIds: new Set(["a", "b", "d"]),
		}) as any;
		renderUpdatesList(c);
		// 每组标题数量
		const titles = Array.from(c.updatesListEl.querySelectorAll(".pt-updates-group-title")).map(
			(e: HTMLElement) => e.textContent,
		);
		expect(titles.some((t) => t?.startsWith("updates.group.outdated"))).toBe(true);
		expect(titles.some((t) => t?.startsWith("updates.pinned.title"))).toBe(true);
		expect(titles.some((t) => t?.startsWith("updates.group.disabled"))).toBe(true);
		expect(titles.some((t) => t?.startsWith("updates.group.latest"))).toBe(true);
		// 每个插件只出现一次：总共 4 行
		expect(c.updatesListEl.querySelectorAll(".pt-updates-row").length).toBe(4);
	});

	it("固定行：取消固定按钮 → pinPluginVersion(id, null) + 重绘（110-141）", async () => {
		const c = makeCtx({
			updatesViewMode: "installed",
			allPlugins: [plug("b", "Beta", "o/b")],
			installedIds: new Set(["b"]),
			pluginVersionPins: { b: "1.0" },
		}) as any;
		renderUpdatesList(c);
		const unpin = rows(c)[0].querySelector(".pt-updates-unpin") as HTMLElement;
		unpin.click();
		await vi.waitFor(() => {
			expect(c.pinPluginVersion).toHaveBeenCalledWith("b", null);
			expect(c.renderUpdatesList).toHaveBeenCalled();
		});
	});

	it("状态行：名称 + 本地版本 + 状态标签（144-149）", () => {
		const c = makeCtx({
			updatesViewMode: "installed",
			allPlugins: [plug("d", "Delta", "o/d")],
			installedIds: new Set(["d"]),
			enabledIds: new Set([]),
			installedVersions: new Map([["d", "3.0"]]),
		}) as any;
		renderUpdatesList(c);
		const row = rows(c)[0];
		expect(row.classList.contains("pt-updates-row--plain")).toBe(true);
		expect(row.querySelector(".pt-updates-name")?.textContent).toBe("Delta");
		expect(row.querySelector(".pt-updates-diff")?.textContent).toBe("3.0");
		expect(row.querySelector(".pt-updates-tag")?.textContent).toBe("updates.tag.disabled");
	});
});
