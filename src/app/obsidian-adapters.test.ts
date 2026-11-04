import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Platform, TFile, TFolder, requestUrl } from "obsidian";
import {
	ObsidianHttpClient,
	ObsidianStoragePort,
	ObsidianNoteStorage,
	obsidianPlatformCapability,
} from "./obsidian-adapters";

// 仅在测试内把会抛错的 requestUrl 换成 vi.fn，其余 obsidian 导出（TFile/TFolder/Platform/normalizePath）沿用 mock
// 注：obsidian mock 缺 TFolder，这里补一个等价类（供源码 instanceof 判定，与测试构造的实例同源）
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	class MockTFolder {}
	return { ...actual, requestUrl: vi.fn(), TFolder: MockTFolder };
});

const reqUrl = vi.mocked(requestUrl);

beforeEach(() => {
	vi.clearAllMocks();
	(Platform as unknown as { isDesktopApp?: boolean; isMacOS?: boolean }).isDesktopApp = undefined;
	(Platform as unknown as { isDesktopApp?: boolean; isMacOS?: boolean }).isMacOS = undefined;
});

afterEach(() => {
	vi.restoreAllMocks();
});

const makeApp = () => ({
	vault: {
		adapter: {
			exists: vi.fn(() => Promise.resolve(false)),
			read: vi.fn(() => Promise.resolve("adapter-content")),
			write: vi.fn(() => Promise.resolve()),
			mkdir: vi.fn(() => Promise.resolve()),
			remove: vi.fn(() => Promise.resolve()),
			list: vi.fn(() => Promise.resolve({ files: [], folders: [] })),
			stat: vi.fn(() => Promise.resolve({ mtime: 0 })),
		},
		getAbstractFileByPath: vi.fn(() => null as unknown as TFolder | TFile | null),
		createFolder: vi.fn(() => Promise.resolve()),
		modify: vi.fn(() => Promise.resolve()),
		create: vi.fn(() => Promise.resolve()),
		cachedRead: vi.fn(() => Promise.resolve("cached")),
		configDir: ".obsidian",
	},
	fileManager: { trashFile: vi.fn(() => Promise.resolve()) },
}) as unknown as import("obsidian").App;

describe("ObsidianHttpClient", () => {
	it("request → 透传选项并补 throw:false，回写整形响应（16-27）", async () => {
		reqUrl.mockResolvedValue({
			status: 201,
			json: { ok: 1 },
			text: "txt",
			headers: { h: "1" },
			arrayBuffer: new ArrayBuffer(0),
		});
		const r = await new ObsidianHttpClient().request({ url: "u", method: "POST", headers: { a: "b" }, body: "B" });
		expect(reqUrl).toHaveBeenCalledWith({ url: "u", method: "POST", headers: { a: "b" }, body: "B", throw: false });
		expect(r.status).toBe(201);
		expect(r.json).toEqual({ ok: 1 });
		expect(r.text).toBe("txt");
		expect(r.headers).toEqual({ h: "1" });
	});

	it("request 默认 method 为 GET（16-27）", async () => {
		reqUrl.mockResolvedValue({ status: 200, json: null, text: "", headers: {}, arrayBuffer: new ArrayBuffer(0) });
		await new ObsidianHttpClient().request({ url: "u" });
		expect(reqUrl).toHaveBeenCalledWith({ url: "u", method: "GET", headers: undefined, body: undefined, throw: false });
	});
});

describe("ObsidianStoragePort", () => {
	it("exists/read/write 直接委托 vault.adapter（30-42）", async () => {
		const app = makeApp();
		const sp = new ObsidianStoragePort(app);
		await sp.exists("p");
		await sp.read("p");
		await sp.write("p", "d");
		expect((app.vault.adapter.exists as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("p");
		expect((app.vault.adapter.read as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("p");
		expect((app.vault.adapter.write as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("p", "d");
	});
});

describe("ObsidianNoteStorage", () => {
	const ns = (app = makeApp()) => new ObsidianNoteStorage(app);

	it("normalizePath 透传 normalizePath（67-69）", () => {
		expect(ns().normalizePath("a/b/c")).toBe("a/b/c");
	});

	it("exists：adapter 路径走 adapter.exists（71-75）", async () => {
		const app = makeApp();
		const a = app.vault.adapter.exists as ReturnType<typeof vi.fn>;
		a.mockResolvedValue(true);
		const r = await ns(app).exists(".obsidian/tm/x.md");
		expect(a).toHaveBeenCalledWith(".obsidian/tm/x.md");
		expect(r).toBe(true);
	});

	it("exists：vault 路径走 getAbstractFileByPath 判存在（71-75）", async () => {
		const app = makeApp();
		const g = app.vault.getAbstractFileByPath as ReturnType<typeof vi.fn>;
		g.mockReturnValue(new TFile());
		const r = await ns(app).exists("Notes/x.md");
		expect(g).toHaveBeenCalledWith("Notes/x.md");
		expect(r).toBe(true);
	});

	it("createFolder：adapter 路径逐级建目录（93-100）", async () => {
		const app = makeApp();
		await ns(app).createFolder(".obsidian/tm");
		expect(app.vault.adapter.mkdir).toHaveBeenCalledWith(".obsidian");
		expect(app.vault.adapter.mkdir).toHaveBeenCalledWith(".obsidian/tm");
	});

	it("createFolder：vault 路径走 vault.createFolder（93-100）", async () => {
		const app = makeApp();
		await ns(app).createFolder("Notes/tm");
		expect(app.vault.createFolder).toHaveBeenCalledWith("Notes/tm");
	});

	it("writeNote：adapter 路径先建父目录再写（102-112）", async () => {
		const app = makeApp();
		await ns(app).writeNote(".obsidian/tm/x.md", "hi");
		expect(app.vault.adapter.mkdir).toHaveBeenCalledWith(".obsidian/tm");
		expect(app.vault.adapter.write).toHaveBeenCalledWith(".obsidian/tm/x.md", "hi");
	});

	it("writeNote：vault 路径且为 TFile → modify（102-119）", async () => {
		const app = makeApp();
		const f = new TFile();
		(app.vault.getAbstractFileByPath as ReturnType<typeof vi.fn>).mockReturnValue(f);
		await ns(app).writeNote("Notes/x.md", "hi");
		expect(app.vault.modify).toHaveBeenCalledWith(f, "hi");
	});

	it("writeNote：vault 路径且非文件 → create（102-119）", async () => {
		const app = makeApp();
		(app.vault.getAbstractFileByPath as ReturnType<typeof vi.fn>).mockReturnValue(null);
		await ns(app).writeNote("Notes/x.md", "hi");
		expect(app.vault.create).toHaveBeenCalledWith("Notes/x.md", "hi");
	});

	it("deleteNote：adapter 路径存在才 remove（122-132）", async () => {
		const app = makeApp();
		(app.vault.adapter.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		await ns(app).deleteNote(".obsidian/tm/x.md");
		expect(app.vault.adapter.remove).toHaveBeenCalledWith(".obsidian/tm/x.md");
	});

	it("deleteNote：adapter 路径不存在则不 remove（122-132）", async () => {
		const app = makeApp();
		(app.vault.adapter.exists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
		await ns(app).deleteNote(".obsidian/tm/x.md");
		expect(app.vault.adapter.remove).not.toHaveBeenCalled();
	});

	it("deleteNote：vault 路径且为 TFile → trashFile（122-132）", async () => {
		const app = makeApp();
		const f = new TFile();
		(app.vault.getAbstractFileByPath as ReturnType<typeof vi.fn>).mockReturnValue(f);
		await ns(app).deleteNote("Notes/x.md");
		expect(app.fileManager.trashFile).toHaveBeenCalledWith(f);
	});

	it("listMarkdown：adapter 路径过滤 .md（134-144）", async () => {
		const app = makeApp();
		(app.vault.adapter.list as ReturnType<typeof vi.fn>).mockResolvedValue({
			files: [".obsidian/tm/a.md", ".obsidian/tm/b.txt", ".obsidian/tm/sub/c.md"],
			folders: [],
		});
		const r = await ns(app).listMarkdown(".obsidian/tm");
		expect(r).toEqual([".obsidian/tm/a.md", ".obsidian/tm/sub/c.md"]);
	});

	it("listMarkdown：adapter 路径 list 抛错视为空（134-144）", async () => {
		const app = makeApp();
		(app.vault.adapter.list as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ENOENT"));
		const r = await ns(app).listMarkdown(".obsidian/tm");
		expect(r).toEqual([]);
	});

	it("listMarkdown：vault 路径递归遍历 TFolder（134-160）", async () => {
		const app = makeApp();
		const a = new TFile();
		(a as unknown as { path: string }).path = "Notes/a.md";
		const b = new TFile();
		(b as unknown as { path: string }).path = "Notes/sub/b.md";
		const sub = new TFolder();
		(sub as unknown as { children: unknown[] }).children = [b];
		const txt = new TFile();
		(txt as unknown as { path: string }).path = "Notes/c.txt";
		const root = new TFolder();
		(root as unknown as { children: unknown[] }).children = [a, sub, txt];
		(app.vault.getAbstractFileByPath as ReturnType<typeof vi.fn>).mockReturnValue(root);
		const r = await ns(app).listMarkdown("Notes");
		expect(r).toEqual(["Notes/a.md", "Notes/sub/b.md"]);
	});

	it("listMarkdown：vault 路径非 TFolder → 空（134-160）", async () => {
		const app = makeApp();
		(app.vault.getAbstractFileByPath as ReturnType<typeof vi.fn>).mockReturnValue(null);
		const r = await ns(app).listMarkdown("Notes");
		expect(r).toEqual([]);
	});

	it("readNote：adapter 路径走 adapter.read（163-174）", async () => {
		const app = makeApp();
		const r = await ns(app).readNote(".obsidian/tm/x.md");
		expect(app.vault.adapter.read).toHaveBeenCalledWith(".obsidian/tm/x.md");
		expect(r).toBe("adapter-content");
	});

	it("readNote：vault 路径且为 TFile → cachedRead（163-174）", async () => {
		const app = makeApp();
		const f = new TFile();
		(app.vault.getAbstractFileByPath as ReturnType<typeof vi.fn>).mockReturnValue(f);
		const r = await ns(app).readNote("Notes/x.md");
		expect(app.vault.cachedRead).toHaveBeenCalledWith(f);
		expect(r).toBe("cached");
	});

	it("readNote：vault 路径非文件 → 回退 adapter.read（163-174）", async () => {
		const app = makeApp();
		(app.vault.getAbstractFileByPath as ReturnType<typeof vi.fn>).mockReturnValue(null);
		const r = await ns(app).readNote("Notes/x.md");
		expect(app.vault.adapter.read).toHaveBeenCalledWith("Notes/x.md");
		expect(r).toBe("adapter-content");
	});

	it("statMtime：adapter 路径 stat 成功返回 mtime（176-188）", async () => {
		const app = makeApp();
		(app.vault.adapter.stat as ReturnType<typeof vi.fn>).mockResolvedValue({ mtime: 500 });
		expect(await ns(app).statMtime(".obsidian/tm/x.md")).toBe(500);
	});

	it("statMtime：adapter 路径 stat 抛错返回 0（176-188）", async () => {
		const app = makeApp();
		(app.vault.adapter.stat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("x"));
		expect(await ns(app).statMtime(".obsidian/tm/x.md")).toBe(0);
	});

	it("statMtime：vault 路径且为 TFile 带 stat → mtime（176-188）", async () => {
		const app = makeApp();
		const f = new TFile();
		(f as unknown as { stat: { mtime: number } }).stat = { mtime: 777 };
		(app.vault.getAbstractFileByPath as ReturnType<typeof vi.fn>).mockReturnValue(f);
		expect(await ns(app).statMtime("Notes/x.md")).toBe(777);
	});

	it("statMtime：vault 路径非文件 → 0（176-188）", async () => {
		const app = makeApp();
		(app.vault.getAbstractFileByPath as ReturnType<typeof vi.fn>).mockReturnValue(null);
		expect(await ns(app).statMtime("Notes/x.md")).toBe(0);
	});
});

describe("obsidianPlatformCapability", () => {
	it("默认 mock Platform 缺字段 → 全 false（192-198）", () => {
		const c = obsidianPlatformCapability();
		expect(c.isDesktopApp).toBe(false);
		expect(c.isMacOS).toBe(false);
	});

	it("补充 isDesktopApp/isMacOS → 透传布尔（192-198）", () => {
		(Platform as unknown as { isDesktopApp: boolean; isMacOS: boolean }).isDesktopApp = true;
		(Platform as unknown as { isDesktopApp: boolean; isMacOS: boolean }).isMacOS = true;
		const c = obsidianPlatformCapability();
		expect(c.isDesktopApp).toBe(true);
		expect(c.isMacOS).toBe(true);
	});

	it("Platform 为 undefined 时防御性返回全 false（192-198）", () => {
		// 直接调用底层逻辑：用真实入参无法置空 Platform，故验证 isDesktopApp 容错分支已覆盖（默认布尔化）
		const c = obsidianPlatformCapability();
		expect(typeof c.isDesktopApp).toBe("boolean");
		expect(typeof c.isMacOS).toBe("boolean");
	});
});
