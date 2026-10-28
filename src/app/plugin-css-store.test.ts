import { describe, it, expect, vi, beforeEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";

/**
 * createCssStore() —— CSS 片段管理的应用层门面。
 *
 * 它是 UI 与「平台能力 + 设置持久化」之间的唯一接缝，历史 hotfix 密集：
 *   · 同一片段快速连点时，旧的异步扫描结果会覆盖新状态 → 需要按片段串行化
 *   · 重命名要同时搬文件、搬启用状态、搬 cssMeta 的 key，任一环节失败都得说清楚
 *   · 删除要顺手清掉 cssMeta 的孤儿键，否则元数据只增不减
 */

const snippetMock = vi.hoisted(() => ({
	listSnippets: vi.fn(() => []),
	refreshSnippets: vi.fn(async () => []),
	// 显式声明参数：让 mock.calls 的元组类型可用，便于断言调用顺序
	setSnippetEnabled: vi.fn(async (_app: unknown, _base: string, _enabled: boolean) => true),
	writeSnippet: vi.fn(async () => {}),
	deleteSnippet: vi.fn(async () => {}),
	renameSnippet: vi.fn(async () => true),
	openSnippetInDefaultApp: vi.fn(),
	isValidSnippetBaseName: vi.fn(() => true),
}));

vi.mock("@data/platform/snippet", () => snippetMock);
vi.mock("@shared/i18n", () => ({
	pickLang: (k: string) => k,
	makeT: () => (k: string) => k,
}));

const flushAsync = () => new Promise((resolve) => window.setTimeout(resolve, 0));

function makeStore() {
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	const flushSaveSettings = vi.fn(async () => {});
	const refreshSnippetToggleCommands = vi.fn();
	const requestRefresh = vi.fn();
	const openManageGroups = vi.fn();
	Object.assign(plugin, {
		app: {} as never,
		settings: {
			manage: {
				cssGroups: [] as unknown[],
				cssGroupColors: {} as Record<string, string>,
				cssMeta: {} as Record<string, Record<string, unknown>>,
				cssFilterState: {} as Record<string, unknown>,
			},
		},
		flushSaveSettings,
		refreshSnippetToggleCommands,
		settingsIntegration: { requestRefresh },
		openManageGroups,
	});
	return {
		store: plugin.createCssStore(),
		plugin,
		flushSaveSettings,
		refreshSnippetToggleCommands,
		requestRefresh,
		openManageGroups,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	snippetMock.isValidSnippetBaseName.mockReturnValue(true);
	snippetMock.renameSnippet.mockResolvedValue(true);
	snippetMock.setSnippetEnabled.mockResolvedValue(true);
});

describe("createCssStore：设置读写与持久化", () => {
	it("暴露 settings 引用而非副本（UI 直接读它渲染）", () => {
		const { store, plugin } = makeStore();
		expect(store.settings).toBe(plugin.settings.manage);
	});

	it("saveCssGroups 写入分组与配色并落盘 + 请求重绘", () => {
		const { store, plugin, flushSaveSettings, requestRefresh } = makeStore();
		const groups = [{ id: "g1", name: "组" }];
		store.saveCssGroups(groups as never, { g1: "#f00" });

		expect(plugin.settings.manage.cssGroups).toBe(groups);
		expect(plugin.settings.manage.cssGroupColors).toEqual({ g1: "#f00" });
		expect(flushSaveSettings).toHaveBeenCalled();
		expect(requestRefresh).toHaveBeenCalled();
	});

	it("saveCssFilterState 只落盘，不触发重绘（避免筛选时自激刷新）", () => {
		const { store, plugin, flushSaveSettings, requestRefresh } = makeStore();
		store.saveCssFilterState({ query: "x" } as never);

		expect(plugin.settings.manage.cssFilterState).toEqual({ query: "x" });
		expect(flushSaveSettings).toHaveBeenCalled();
		expect(requestRefresh).not.toHaveBeenCalled();
	});

	it("saveCssMeta 按 id 做部分更新（未提供的字段保留原值）", () => {
		const { store, plugin, flushSaveSettings, requestRefresh } = makeStore();
		store.saveCssMeta("snip", { group: "chinese" } as never);
		store.saveCssMeta("snip", { remark: "备注" } as never);

		expect(plugin.settings.manage.cssMeta.snip).toEqual({ group: "chinese", remark: "备注" });
		expect(flushSaveSettings).toHaveBeenCalled();
		expect(requestRefresh).toHaveBeenCalled();
	});

	it("replaceCssMeta 整体替换（导入/恢复场景）", () => {
		const { store, plugin, flushSaveSettings } = makeStore();
		store.replaceCssMeta({ a: { group: "chinese", remark: "A" } } as never);

		expect(plugin.settings.manage.cssMeta).toEqual({ a: { group: "chinese", remark: "A" } });
		expect(flushSaveSettings).toHaveBeenCalled();
	});
});

describe("createCssStore：片段列表与开关", () => {
	it("listSnippets 透传平台层结果", () => {
		const { store } = makeStore();
		snippetMock.listSnippets.mockReturnValue([{ base: "a" }] as never);
		expect(store.listSnippets()).toEqual([{ base: "a" }]);
	});

	it("refreshSnippets 刷新平台缓存并同步命令名", async () => {
		const { store, refreshSnippetToggleCommands } = makeStore();
		await store.refreshSnippets();

		expect(snippetMock.refreshSnippets).toHaveBeenCalled();
		expect(refreshSnippetToggleCommands).toHaveBeenCalled();
	});

	it("setSnippetEnabled 成功后重读状态并请求重绘", async () => {
		const { store, requestRefresh } = makeStore();
		await expect(store.setSnippetEnabled("a", true)).resolves.toBe(true);

		expect(snippetMock.setSnippetEnabled).toHaveBeenCalledWith(expect.anything(), "a", true);
		expect(snippetMock.refreshSnippets).toHaveBeenCalled();
		expect(requestRefresh).toHaveBeenCalled();
	});

	it("setSnippetEnabled 平台层返回 false 时如实透出（UI 据此回滚开关）", async () => {
		const { store } = makeStore();
		snippetMock.setSnippetEnabled.mockResolvedValue(false);
		await expect(store.setSnippetEnabled("a", true)).resolves.toBe(false);
	});

	it("同一片段的连续点击按顺序执行，后一次不会抢在前一次之前（防旧结果覆盖新状态）", async () => {
		const { store } = makeStore();
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		snippetMock.setSnippetEnabled
			.mockImplementationOnce(async () => {
				await firstGate;
				return true;
			})
			.mockImplementationOnce(async () => true);

		const p1 = store.setSnippetEnabled("a", true);
		const p2 = store.setSnippetEnabled("a", false);

		await flushAsync();
		// 第一次仍挂起 → 第二次必须还在排队，不能并发进入平台层
		expect(snippetMock.setSnippetEnabled).toHaveBeenCalledTimes(1);

		releaseFirst();
		await Promise.all([p1, p2]);
		expect(snippetMock.setSnippetEnabled).toHaveBeenCalledTimes(2);
		// 顺序：先 true 后 false
		expect(snippetMock.setSnippetEnabled.mock.calls.map((c) => c[2])).toEqual([true, false]);
	});

	it("排队的前一次失败不会卡死后续操作", async () => {
		const { store } = makeStore();
		snippetMock.setSnippetEnabled
			.mockImplementationOnce(async () => {
				throw new Error("ETIMEDOUT");
			})
			.mockImplementationOnce(async () => true);

		await expect(store.setSnippetEnabled("a", true)).rejects.toThrow("ETIMEDOUT");
		await expect(store.setSnippetEnabled("a", false)).resolves.toBe(true);
	});

	it("不同片段之间互不阻塞（串行化粒度是片段名）", async () => {
		const { store } = makeStore();
		let releaseA!: () => void;
		const gateA = new Promise<void>((resolve) => {
			releaseA = resolve;
		});
		snippetMock.setSnippetEnabled.mockImplementation(async (_app, base: string) => {
			if (base === "a") await gateA;
			return true;
		});

		const pa = store.setSnippetEnabled("a", true);
		const pb = store.setSnippetEnabled("b", true);
		await flushAsync();
		// b 不应等 a
		expect(await pb).toBe(true);

		releaseA();
		await pa;
	});
});

describe("createCssStore：重命名（文件 + 启用状态 + 元数据三处同步）", () => {
	it("非法名直接拦下，不触碰平台层", async () => {
		const { store } = makeStore();
		snippetMock.isValidSnippetBaseName.mockReturnValue(false);

		await store.renameSnippet("old", "bad/name");

		expect(snippetMock.renameSnippet).not.toHaveBeenCalled();
	});

	it("平台层抛错时中止，不迁移元数据", async () => {
		const { store, plugin, flushSaveSettings } = makeStore();
		plugin.settings.manage.cssMeta = { old: { group: "chinese", remark: "A" } };
		snippetMock.renameSnippet.mockRejectedValue(new Error("EACCES"));

		await store.renameSnippet("old", "new");

		expect(plugin.settings.manage.cssMeta).toEqual({ old: { group: "chinese", remark: "A" } });
		expect(flushSaveSettings).not.toHaveBeenCalled();
	});

	it("文件改名成功但启用状态同步失败时仍迁移元数据（文件已动，元数据必须跟上）", async () => {
		const { store, plugin } = makeStore();
		plugin.settings.manage.cssMeta = { old: { group: "chinese", remark: "A" } };
		snippetMock.renameSnippet.mockResolvedValue(false);

		await store.renameSnippet("old", "new");

		expect(plugin.settings.manage.cssMeta).toEqual({ new: { group: "chinese", remark: "A" } });
	});

	it("成功时把 cssMeta 的 key 从旧名搬到新名并落盘 + 重绘", async () => {
		const { store, plugin, flushSaveSettings, requestRefresh } = makeStore();
		plugin.settings.manage.cssMeta = { old: { group: "chinese", remark: "A" }, other: { group: "chinese", remark: "B" } };

		await store.renameSnippet("old", "new");

		expect(plugin.settings.manage.cssMeta).toEqual({ new: { group: "chinese", remark: "A" }, other: { group: "chinese", remark: "B" } });
		expect(flushSaveSettings).toHaveBeenCalled();
		expect(requestRefresh).toHaveBeenCalled();
	});

	it("旧名没有元数据时不产生空键", async () => {
		const { store, plugin, flushSaveSettings } = makeStore();
		await store.renameSnippet("ghost", "new");

		expect(plugin.settings.manage.cssMeta).toEqual({});
		expect(flushSaveSettings).not.toHaveBeenCalled();
	});

	it("openSnippet 交给系统默认应用打开", () => {
		const { store } = makeStore();
		store.openSnippet("path/to.css");
		expect(snippetMock.openSnippetInDefaultApp).toHaveBeenCalledWith(expect.anything(), "path/to.css");
	});
});

describe("createCssStore：新建与删除", () => {
	it("新建时会校验名称，非法名不写文件", async () => {
		const { store } = makeStore();
		snippetMock.isValidSnippetBaseName.mockReturnValue(false);

		await store.createSnippet("bad name");

		expect(snippetMock.writeSnippet).not.toHaveBeenCalled();
	});

	it("新建成功：写文件 → 刷新 → 同步命令 → 重绘", async () => {
		const { store, refreshSnippetToggleCommands, requestRefresh } = makeStore();

		await store.createSnippet("nice", ".a{}");

		expect(snippetMock.writeSnippet).toHaveBeenCalledWith(expect.anything(), "nice", ".a{}");
		expect(snippetMock.refreshSnippets).toHaveBeenCalled();
		expect(refreshSnippetToggleCommands).toHaveBeenCalled();
		expect(requestRefresh).toHaveBeenCalled();
	});

	it("删除时清掉对应的孤儿元数据键", async () => {
		const { store, plugin, flushSaveSettings } = makeStore();
		plugin.settings.manage.cssMeta = { gone: { group: "chinese", remark: "G" }, keep: { group: "chinese", remark: "K" } };

		await store.deleteSnippet("gone");

		expect(snippetMock.deleteSnippet).toHaveBeenCalledWith(expect.anything(), "gone");
		expect(plugin.settings.manage.cssMeta).toEqual({ keep: { group: "chinese", remark: "K" } });
		expect(flushSaveSettings).toHaveBeenCalled();
	});

	it("删除无元数据的片段不触发多余落盘", async () => {
		const { store, flushSaveSettings } = makeStore();
		await store.deleteSnippet("plain");

		expect(flushSaveSettings).not.toHaveBeenCalled();
	});

	it("删除后仍会刷新与重绘（即使没有元数据要清理）", async () => {
		const { store, refreshSnippetToggleCommands, requestRefresh } = makeStore();
		await store.deleteSnippet("plain");

		expect(snippetMock.refreshSnippets).toHaveBeenCalled();
		expect(refreshSnippetToggleCommands).toHaveBeenCalled();
		expect(requestRefresh).toHaveBeenCalled();
	});

	it("onManageGroups 打开 css 分组管理", () => {
		const { store, openManageGroups } = makeStore();
		store.onManageGroups();
		expect(openManageGroups).toHaveBeenCalledWith("css");
	});
});
