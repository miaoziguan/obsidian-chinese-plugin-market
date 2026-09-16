/**
 * snippet 平台层测试。
 * 构造最小 fake app（vault.adapter + customCss），验证列表 / 启用判定 / 切换 /
 * 重命名 / 系统打开的行为，全程不依赖真实 Obsidian 运行时。
 */

import { describe, it, expect } from "vitest";
import {
	listSnippets,
	isSnippetEnabled,
	setSnippetEnabled,
	renameSnippet,
	openSnippetInDefaultApp,
} from "./snippet";

interface FakeApp {
	__writes: string[];
	__removes: string[];
	__enabled: Set<string>;
	customCss: { snippets: string[]; setCssEnabled?: (e: boolean, n: string, t: string) => void };
	vault: {
		getFiles: () => Array<{ path: string; name: string }>;
		adapter: {
			read: (p: string) => Promise<string>;
			write: (p: string) => Promise<void>;
			exists: (p: string) => Promise<boolean>;
			remove: (p: string) => Promise<void>;
		};
	};
	openWithDefaultApp?: (p: string) => void;
}

function makeApp(opts: {
	enabled?: string[];
	files?: Array<{ path: string; name: string }>;
} = {}): FakeApp {
	const enabled = new Set(opts.enabled ?? []);
	const files = (opts.files ?? []).map((f) => ({ path: f.path, name: f.name }));
	const writes: string[] = [];
	const removes: string[] = [];
	const app: FakeApp = {
		__writes: writes,
		__removes: removes,
		__enabled: enabled,
		customCss: {
			snippets: [...enabled] as string[],
			setCssEnabled: (e: boolean, n: string) => {
				if (e) enabled.add(n);
				else enabled.delete(n);
			},
		},
		vault: {
			getFiles: () => files,
			adapter: {
				read: async (p: string) => `content-of-${p}`,
				write: async (p: string) => {
					writes.push(p);
				},
				exists: async (p: string) => files.some((f) => f.path === p),
				remove: async (p: string) => {
					removes.push(p);
				},
			},
		},
	};
	return app;
}

describe("snippet 平台层", () => {
	it("listSnippets 仅列 snippets 目录下的 .css，标记启用并按基名排序", () => {
		const app = makeApp({
			enabled: ["b"],
			files: [
				{ path: ".obsidian/snippets/a.css", name: "a.css" },
				{ path: ".obsidian/snippets/b.css", name: "b.css" },
				{ path: "styles.css", name: "styles.css" },
			],
		});
		const list = listSnippets(app as never);
		expect(list.map((s) => s.baseName)).toEqual(["a", "b"]);
		expect(list[0].enabled).toBe(false);
		expect(list[1].enabled).toBe(true);
		expect(list[1].path).toBe(".obsidian/snippets/b.css");
	});

	it("isSnippetEnabled 按 customCss.snippets 判定", () => {
		const app = makeApp({ enabled: ["x"] });
		expect(isSnippetEnabled(app as never, "x")).toBe(true);
		expect(isSnippetEnabled(app as never, "y")).toBe(false);
	});

	it("setSnippetEnabled 调用 customCss.setCssEnabled（三参签名）", async () => {
		const calls: unknown[][] = [];
		const app = makeApp();
		app.customCss.setCssEnabled = (e: boolean, n: string, t: string) => {
			calls.push([e, n, t]);
		};
		await setSnippetEnabled(app as never, "foo", true);
		expect(calls).toEqual([[true, "foo", "snippet"]]);
	});

	it("setSnippetEnabled 旧版两参签名回退（三参抛错时）", async () => {
		const calls: unknown[][] = [];
		const app = makeApp();
		app.customCss.setCssEnabled = ((...args: unknown[]) => {
			calls.push(args);
			if (calls.length === 1) throw new Error("old api");
		}) as never;
		await setSnippetEnabled(app as never, "foo", true);
		expect(calls[0].length).toBe(3); // 先试三参
		expect(calls[1].length).toBe(2); // 回退两参
	});

	it("renameSnippet 复制内容到新文件、删旧文件、同步启用状态", async () => {
		const app = makeApp({
			enabled: ["old"],
			files: [{ path: ".obsidian/snippets/old.css", name: "old.css" }],
		});
		await renameSnippet(app as never, "old", "new");
		expect(app.__writes).toContain(".obsidian/snippets/new.css");
		expect(app.__removes).toContain(".obsidian/snippets/old.css");
		expect(app.__enabled.has("new")).toBe(true);
		expect(app.__enabled.has("old")).toBe(false);
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
