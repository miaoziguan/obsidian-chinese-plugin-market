/**
 * snippet 平台层测试。
 * 构造最小 fake app（vault.adapter + customCss），验证列表 / 启用判定 / 切换 /
 * 重命名 / 系统打开的行为，全程不依赖真实 Obsidian 运行时。
 */

import { describe, it, expect } from "vitest";
import {
	listSnippets,
	refreshSnippets,
	snippetDir,
	isSnippetEnabled,
	setSnippetEnabled,
	renameSnippet,
	openSnippetInDefaultApp,
} from "./snippet";

interface FakeApp {
	__writes: string[];
	__removes: string[];
	__enabled: Set<string>;
	configDir: string;
	/** adapter.list 是否抛错（模拟目录不可读） */
	listThrows?: boolean;
	customCss: {
		snippets: string[];
		enabledSnippets?: Set<string>;
		setCssEnabledStatus?: (n: string, e: boolean) => void;
	};
	vault: {
		configDir: string;
		getFiles: () => Array<{ path: string; name: string }>;
		adapter: {
			list: (p: string) => Promise<{ files: string[] }>;
			read: (p: string) => Promise<string>;
			write: (p: string) => Promise<void>;
			exists: (p: string) => Promise<boolean>;
			remove: (p: string) => Promise<void>;
		};
	};
	openWithDefaultApp?: (p: string) => void;
}

function makeApp(
	opts: {
		enabled?: string[];
		/** vault 内的文件（用于 adapter.list 与 getFiles 兜底） */
		files?: Array<{ path: string; name: string }>;
		configDir?: string;
		listThrows?: boolean;
	} = {},
): FakeApp {
	const enabled = new Set(opts.enabled ?? []);
	const files = (opts.files ?? []).map((f) => ({ path: f.path, name: f.name }));
	const writes: string[] = [];
	const removes: string[] = [];
	const configDir = opts.configDir ?? ".obsidian";
	const app: FakeApp = {
		__writes: writes,
		__removes: removes,
		__enabled: enabled,
		configDir,
		listThrows: opts.listThrows,
		customCss: {
			// 真实 Obsidian 的 customCss.snippets 是活的新动数组，必须实时反映启用集合
			get snippets() {
				return [...enabled] as string[];
			},
			enabledSnippets: enabled,
			setCssEnabledStatus: (n: string, e: boolean) => {
				if (e) enabled.add(n);
				else enabled.delete(n);
			},
		},
		vault: {
			configDir,
			getFiles: () => files,
			adapter: {
				list: async (p: string) => {
					if (app.listThrows) throw new Error("ENOENT");
					return {
						files: files.filter((f) => f.path.startsWith(`${p}/`)).map((f) => f.path),
					};
				},
				read: async (p: string) => `content-of-${p}`,
				write: async (p: string) => {
					writes.push(p);
					files.push({ path: p, name: p.split("/").pop() ?? "" });
				},
				exists: async (p: string) => files.some((f) => f.path === p),
				remove: async (p: string) => {
					removes.push(p);
					const idx = files.findIndex((f) => f.path === p);
					if (idx >= 0) files.splice(idx, 1);
				},
			},
		},
	};
	return app;
}

describe("snippet 平台层", () => {
	it("refreshSnippets 用 adapter 扫 snippets 目录，标记启用并按基名排序", async () => {
		const app = makeApp({
			enabled: ["b"],
			files: [
				{ path: ".obsidian/snippets/a.css", name: "a.css" },
				{ path: ".obsidian/snippets/b.css", name: "b.css" },
				{ path: "styles.css", name: "styles.css" },
			],
		});
		const list = await refreshSnippets(app as never);
		expect(list.map((s) => s.baseName)).toEqual(["a", "b"]);
		expect(list[0].enabled).toBe(false);
		expect(list[1].enabled).toBe(true);
		expect(list[1].path).toBe(".obsidian/snippets/b.css");
	});

	it("listSnippets 是同步缓存快照：未扫描过为空，扫描后可读", async () => {
		const app = makeApp({
			files: [{ path: ".obsidian/snippets/a.css", name: "a.css" }],
		});
		expect(listSnippets(app as never)).toEqual([]);
		await refreshSnippets(app as never);
		expect(listSnippets(app as never).map((s) => s.baseName)).toEqual(["a"]);
	});

	it("跟随用户自定义的配置目录，不写死 .obsidian", async () => {
		const app = makeApp({
			configDir: ".myconf",
			files: [{ path: ".myconf/snippets/x.css", name: "x.css" }],
		});
		expect(snippetDir(app as never)).toBe(".myconf/snippets");
		const list = await refreshSnippets(app as never);
		expect(list.map((s) => s.baseName)).toEqual(["x"]);
		expect(list[0].path).toBe(".myconf/snippets/x.css");
	});

	it("adapter.list 失败时兜底：vault 文件树 + customCss 已启用名单", async () => {
		const app = makeApp({
			enabled: ["enabled-only"],
			files: [{ path: ".obsidian/snippets/on-disk.css", name: "on-disk.css" }],
			listThrows: true,
		});
		const list = await refreshSnippets(app as never);
		const names = list.map((s) => s.baseName);
		expect(names).toContain("enabled-only");
		expect(names).toContain("on-disk");
	});

	it("isSnippetEnabled 按 customCss.enabledSnippets 判定", () => {
		const app = makeApp({ enabled: ["x"] });
		expect(isSnippetEnabled(app as never, "x")).toBe(true);
		expect(isSnippetEnabled(app as never, "y")).toBe(false);
	});

	it("isSnippetEnabled 旧版 customCss.snippets 数组回退", () => {
		const app = makeApp({ enabled: ["x"] });
		delete (app.customCss as { enabledSnippets?: Set<string> }).enabledSnippets;
		expect(isSnippetEnabled(app as never, "x")).toBe(true);
		expect(isSnippetEnabled(app as never, "y")).toBe(false);
	});

	it("setSnippetEnabled 调用 customCss.setCssEnabledStatus(name, enabled)", async () => {
		const calls: unknown[][] = [];
		const app = makeApp();
		app.customCss.setCssEnabledStatus = (n: string, e: boolean) => {
			calls.push([n, e]);
		};
		await setSnippetEnabled(app as never, "foo", true);
		expect(calls).toEqual([["foo", true]]);
	});

	it("renameSnippet 复制内容到新文件、删旧文件、同步启用状态，并刷新清单", async () => {
		const app = makeApp({
			enabled: ["old"],
			files: [{ path: ".obsidian/snippets/old.css", name: "old.css" }],
		});
		await renameSnippet(app as never, "old", "new");
		expect(app.__writes).toContain(".obsidian/snippets/new.css");
		expect(app.__removes).toContain(".obsidian/snippets/old.css");
		expect(app.__enabled.has("new")).toBe(true);
		expect(app.__enabled.has("old")).toBe(false);
		// 重命名后立即重扫：缓存里应是新名
		expect(listSnippets(app as never).map((s) => s.baseName)).toEqual(["new"]);
	});

	it("openSnippetInDefaultApp 调 openWithDefaultApp", () => {
		let opened = "";
		const app = { openWithDefaultApp: (p: string) => (opened = p) } as never;
		openSnippetInDefaultApp(app, "x.css");
		expect(opened).toBe("x.css");
	});

	it("openSnippetInDefaultApp 无 API 时静默失败", () => {
		expect(() => openSnippetInDefaultApp({} as never, "x.css")).not.toThrow();
	});
});
