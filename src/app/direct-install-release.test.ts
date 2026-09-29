import { describe, it, expect, vi, beforeEach } from "vitest";
import { requestUrl } from "obsidian";
import type { App } from "obsidian";
import {
	installFromUrlResolved,
	isFloatingGithubRef,
	parseSourceSpec,
	resolveRemoteManifest,
} from "@app/direct-install";

vi.mock("obsidian", async () => {
	const actual = await vi.importActual<typeof import("obsidian")>("obsidian");
	return { ...actual, requestUrl: vi.fn() };
});

/**
 * 回归：真实用户反馈「CM 直链更新检查不到最新版，得手贴 releases/tag 链接」。
 *
 * 成因（实测 AlbusGuo/albus-editing-suite）：作者发 Release 时没把默认分支的
 * manifest.json 一起 bump —— main = 1.2.2，Release latest = 1.3.0。
 * 直链更新原先只读默认分支源码树，于是永远判定「已最新」。
 * 修复后：跟默认分支（HEAD）的 GitHub 源会与最新 Release 对照，取版本更高者。
 */

const REPO = "AlbusGuo/albus-editing-suite";
const RAW_HEAD = `https://raw.githubusercontent.com/${REPO}/HEAD/`;
const REL_LATEST = `https://github.com/${REPO}/releases/latest/download/`;
const REL_TAG = `https://github.com/${REPO}/releases/download/1.3.0/`;

const manifest = (version: string) =>
	JSON.stringify({ id: "albus-editing-suite", name: "Editing Suite", version });

function mockFetch(map: Record<string, { status: number; text: string }>) {
	const fn = requestUrl as unknown as ReturnType<typeof vi.fn>;
	fn.mockImplementation(({ url }: { url: string }) =>
		Promise.resolve(map[url] ?? { status: 404, text: "" }),
	);
}

beforeEach(() => {
	(requestUrl as unknown as ReturnType<typeof vi.fn>).mockReset();
});

describe("isFloatingGithubRef — 只有跟默认分支的源才做 Release 对照", () => {
	it("HEAD（默认分支）→ 漂浮", () => {
		expect(isFloatingGithubRef(new URL(`${RAW_HEAD}`))).toBe(true);
	});
	it("钉了分支/标签/commit → 不漂浮", () => {
		expect(isFloatingGithubRef(new URL(`https://raw.githubusercontent.com/${REPO}/dev/`))).toBe(
			false,
		);
		expect(
			isFloatingGithubRef(new URL(`https://raw.githubusercontent.com/${REPO}/1.2.2/`)),
		).toBe(false);
	});
	it("非 raw 域名 → 不漂浮", () => {
		expect(isFloatingGithubRef(new URL("https://example.com/plugin/"))).toBe(false);
	});
});

describe("resolveRemoteManifest — 源码树与 Release 取更高版本", () => {
	it("用户反馈场景：源码树 1.2.2、Release 1.3.0 → 选 Release 并改道", async () => {
		mockFetch({
			[`${RAW_HEAD}manifest.json`]: { status: 200, text: manifest("1.2.2") },
			[`${REL_LATEST}manifest.json`]: { status: 200, text: manifest("1.3.0") },
		});
		const spec = parseSourceSpec(`https://github.com/${REPO}`);
		const r = await resolveRemoteManifest(spec);
		expect(r.man.version).toBe("1.3.0");
		expect(r.release).toBe(true);
	});

	it("源码树更高（作者只改源码树没发 Release）→ 沿用源码树", async () => {
		mockFetch({
			[`${RAW_HEAD}manifest.json`]: { status: 200, text: manifest("1.4.0") },
			[`${REL_LATEST}manifest.json`]: { status: 200, text: manifest("1.3.0") },
		});
		const spec = parseSourceSpec(`https://github.com/${REPO}`);
		const r = await resolveRemoteManifest(spec);
		expect(r.man.version).toBe("1.4.0");
		expect(r.release).toBe(false);
	});

	it("仓库没发 Release / 资产没挂 manifest → 沿用源码树", async () => {
		mockFetch({
			[`${RAW_HEAD}manifest.json`]: { status: 200, text: manifest("1.2.2") },
		});
		const spec = parseSourceSpec(`https://github.com/${REPO}`);
		const r = await resolveRemoteManifest(spec);
		expect(r.man.version).toBe("1.2.2");
		expect(r.release).toBe(false);
	});

	it("id 不同（不是同一个插件）→ 不越过源码树", async () => {
		mockFetch({
			[`${RAW_HEAD}manifest.json`]: {
				status: 200,
				text: JSON.stringify({ id: "other", version: "1.2.2" }),
			},
			[`${REL_LATEST}manifest.json`]: { status: 200, text: manifest("1.3.0") },
		});
		const spec = parseSourceSpec(`https://github.com/${REPO}`);
		const r = await resolveRemoteManifest(spec);
		expect(r.man.id).toBe("other");
		expect(r.release).toBe(false);
	});

	it("钉了分支（@dev）→ 根本不请求 Release", async () => {
		mockFetch({
			[`https://raw.githubusercontent.com/${REPO}/dev/manifest.json`]: {
				status: 200,
				text: manifest("1.2.2"),
			},
			[`${REL_LATEST}manifest.json`]: { status: 200, text: manifest("1.3.0") },
		});
		const spec = parseSourceSpec(`${REPO}@dev`);
		const r = await resolveRemoteManifest(spec);
		expect(r.man.version).toBe("1.2.2");
		expect(r.release).toBe(false);
		const called = (requestUrl as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
			([a]: [{ url: string }]) => a.url,
		);
		expect(called.some((u: string) => u.includes("/releases/"))).toBe(false);
	});

	it("release 模式（@latest）→ 只取 Release 资产", async () => {
		mockFetch({ [`${REL_LATEST}manifest.json`]: { status: 200, text: manifest("1.3.0") } });
		const spec = parseSourceSpec(`${REPO}@latest`);
		const r = await resolveRemoteManifest(spec);
		expect(r.man.version).toBe("1.3.0");
		expect(r.release).toBe(true);
	});
});

describe("installFromUrlResolved — 改道后三件套必须来自 Release 资产", () => {
	function makeApp() {
		const writes = new Map<string, string>();
		const enabled = new Set<string>();
		const adapter = {
			exists: async (p: string) => writes.has(p),
			mkdir: async () => {},
			write: async (p: string, data: string) => {
				writes.set(p, data);
			},
			remove: async (p: string) => {
				writes.delete(p);
			},
		};
		const plugins = {
			manifests: {} as Record<string, unknown>,
			enabledPlugins: { has: (id: string) => enabled.has(id) },
			loadManifests: async () => {},
			disablePlugin: async () => {},
			enablePluginAndSave: async (id: string) => {
				enabled.add(id);
			},
		};
		const app = { vault: { configDir: ".obsidian", adapter }, plugins } as unknown as App;
		return { app, writes };
	}

	it("源码树 1.2.2 + Release 1.3.0 → 装 1.3.0，main.js 取自 1.3.0 资产", async () => {
		mockFetch({
			[`${RAW_HEAD}manifest.json`]: { status: 200, text: manifest("1.2.2") },
			[`${REL_LATEST}manifest.json`]: { status: 200, text: manifest("1.3.0") },
			[`${REL_TAG}main.js`]: { status: 200, text: "MAIN-1.3.0" },
			[`${REL_TAG}styles.css`]: { status: 200, text: "CSS-1.3.0" },
		});
		const { app, writes } = makeApp();
		const r = await installFromUrlResolved(app, `https://github.com/${REPO}`);
		expect(r.man.version).toBe("1.3.0");
		expect(r.release).toBe(true);
		expect(writes.get(".obsidian/plugins/albus-editing-suite/main.js")).toBe("MAIN-1.3.0");
		expect(writes.get(".obsidian/plugins/albus-editing-suite/styles.css")).toBe("CSS-1.3.0");
	});

	it("改道但 Release 资产缺 main.js → 报错且不写盘（不混装旧构建产物）", async () => {
		mockFetch({
			[`${RAW_HEAD}manifest.json`]: { status: 200, text: manifest("1.2.2") },
			[`${RAW_HEAD}main.js`]: { status: 200, text: "MAIN-1.2.2" },
			[`${REL_LATEST}manifest.json`]: { status: 200, text: manifest("1.3.0") },
		});
		const { app, writes } = makeApp();
		await expect(installFromUrlResolved(app, `https://github.com/${REPO}`)).rejects.toThrow();
		expect(writes.size).toBe(0);
	});
});
