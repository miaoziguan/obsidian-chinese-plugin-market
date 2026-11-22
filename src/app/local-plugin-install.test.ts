import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as url from "node:url";
import type { App } from "obsidian";
import { Platform, requireApiVersion } from "obsidian";
import { installLocalPlugin, isLocalPluginPath } from "./local-plugin-install";
import { installFromUrlResolved, updateBetaPlugin } from "./direct-install";

vi.mock("obsidian", async (original) => ({
	...await original<typeof import("obsidian")>(),
	requireApiVersion: vi.fn(() => true),
}));

let temp: string;
let source: string;
let vault: string;
const disk = fs.promises;
const target = () => path.join(vault, ".obsidian/plugins/sample");

async function seed(id = "sample", version = "1.0.0") {
	await disk.mkdir(source, { recursive: true });
	await disk.writeFile(path.join(source, "manifest.json"), JSON.stringify({ id, name: "Sample", version }));
	await disk.writeFile(path.join(source, "main.js"), "/* test fixture; never executed */");
}

function makeApp() {
	const enabled = new Set<string>();
	const plugins = {
		enabledPlugins: enabled,
		loadManifests: vi.fn(async () => {}),
		disablePlugin: vi.fn(async (id: string) => { enabled.delete(id); }),
		enablePluginAndSave: vi.fn(async (id: string) => { enabled.add(id); }),
	};
	const adapter = {
		getBasePath: () => vault,
		exists: async (p: string) => disk.access(path.join(vault, p)).then(() => true, () => false),
		mkdir: async (p: string) => { await disk.mkdir(path.join(vault, p)); },
		writeBinary: vi.fn(async (p: string, bytes: ArrayBuffer) => { await disk.writeFile(path.join(vault, p), new Uint8Array(bytes)); }),
		remove: async (p: string) => { await disk.unlink(path.join(vault, p)); },
	};
	return { app: { vault: { configDir: ".obsidian", adapter }, plugins } as unknown as App, plugins, adapter };
}

beforeEach(async () => {
	vi.clearAllMocks();
	vi.mocked(requireApiVersion).mockReturnValue(true);
	temp = await disk.realpath(await disk.mkdtemp(path.join(os.tmpdir(), "cpm-local-install-")));
	source = path.join(temp, "下载 插件");
	vault = path.join(temp, "vault");
	await disk.mkdir(vault);
	await seed();
	const modules: Record<string, unknown> = { fs, path, os, url };
	vi.stubGlobal("require", (name: string) => modules[name]);
});

afterEach(async () => {
	vi.unstubAllGlobals();
	Platform.isMobile = false;
	await disk.rm(temp, { recursive: true, force: true });
});

describe("本地插件目录安装", () => {
	it("区分目录路径和远程仓库简写", () => {
		for (const input of ["/tmp/plugin", '"/tmp/my plugin"', "~/plugins/p", "file:///tmp/plugin", "C:\\plugins\\p", "\\\\server\\p"]) {
			expect(isLocalPluginPath(input)).toBe(true);
		}
		for (const input of ["owner/repo", "https://github.com/o/r", "o/r@dev"]) expect(isLocalPluginPath(input)).toBe(false);
	});

	it("公共安装入口复制本地文件和二进制资源，保留源文件和现有配置", async () => {
		const { app, adapter, plugins } = makeApp();
		await disk.mkdir(target(), { recursive: true });
		await disk.writeFile(path.join(target(), "data.json"), '{"keep":true}');
		await disk.writeFile(path.join(target(), "styles.css"), "stale css");
		await disk.writeFile(path.join(source, "data.json"), '{"keep":false}');
		await disk.mkdir(path.join(source, "assets"));
		await disk.writeFile(path.join(source, "assets/model.bin"), new Uint8Array([0, 255, 1, 128]));
		await disk.mkdir(path.join(source, "node_modules"));
		await disk.writeFile(path.join(source, "node_modules/unused.js"), "skip");
		plugins.enabledPlugins.add("sample");
		await expect(installFromUrlResolved(app, `"${source}"`)).resolves.toMatchObject({ man: { id: "sample" }, release: false });
		expect(await disk.readFile(path.join(target(), "assets/model.bin"))).toEqual(Buffer.from([0, 255, 1, 128]));
		expect(await disk.readFile(path.join(target(), "data.json"), "utf8")).toBe('{"keep":true}');
		expect(await adapter.exists(".obsidian/plugins/sample/styles.css")).toBe(false);
		expect(await adapter.exists(".obsidian/plugins/sample/node_modules")).toBe(false);
		expect(await disk.readFile(path.join(source, "main.js"), "utf8")).toContain("test fixture");
		expect(plugins.disablePlugin).toHaveBeenCalledWith("sample");
		expect(plugins.enablePluginAndSave).toHaveBeenCalledWith("sample");
	});

	it("接受 manifest 路径及含中文空格的 file URL", async () => {
		const { app } = makeApp();
		const r = await installLocalPlugin(app, url.pathToFileURL(path.join(source, "manifest.json")).href);
		expect(r.sourceUrl).toBe(url.pathToFileURL(source + path.sep).href);
		expect(r.updated).toBe(true);
	});

	it("直链更新保留本地来源，同版本不写盘或重载，新版本才更新", async () => {
		const { app, adapter, plugins } = makeApp();
		const entry = { id: "sample", name: "Sample", rootUrl: url.pathToFileURL(source).href, installedVersion: "1.0.0", frozen: false };
		expect((await updateBetaPlugin(app, entry)).updated).toBe(false);
		expect(adapter.writeBinary).not.toHaveBeenCalled();
		expect(plugins.enablePluginAndSave).not.toHaveBeenCalled();
		await seed("sample", "2.0.0");
		expect(await updateBetaPlugin(app, entry)).toMatchObject({ updated: true, manifest: { version: "2.0.0" } });
		await expect(installLocalPlugin(app, source, "other")).rejects.toThrow();
	});

	it.each(["../escape", ".hidden", "bad/id", "chinese-plugin-market"])("拒绝无效或当前市场的 id %s，且不写盘", async (id) => {
		await seed(id);
		const { app, adapter } = makeApp();
		await expect(installLocalPlugin(app, source)).rejects.toThrow();
		expect(adapter.writeBinary).not.toHaveBeenCalled();
	});

	it("缺少构建文件或 main.js 为空时不写盘、不禁用旧插件", async () => {
		const { app, adapter, plugins } = makeApp();
		await disk.unlink(path.join(source, "main.js"));
		await expect(installLocalPlugin(app, source)).rejects.toThrow();
		await disk.writeFile(path.join(source, "main.js"), " ");
		await expect(installLocalPlugin(app, source)).rejects.toThrow("main.js");
		expect(adapter.writeBinary).not.toHaveBeenCalled();
		expect(plugins.disablePlugin).not.toHaveBeenCalled();
	});

	it("拒绝符号链接资源和目标目录、父子目录重叠", async () => {
		const { app, adapter } = makeApp();
		await disk.symlink(path.join(source, "main.js"), path.join(source, "link.js"));
		await expect(installLocalPlugin(app, source)).rejects.toThrow("符号链接");
		await disk.unlink(path.join(source, "link.js"));
		await disk.mkdir(path.dirname(target()), { recursive: true });
		await disk.symlink(source, target());
		await expect(installLocalPlugin(app, source)).rejects.toThrow("符号链接");
		await disk.unlink(target());
		await disk.cp(source, path.join(target(), "nested"), { recursive: true });
		await expect(installLocalPlugin(app, path.join(target(), "nested"))).rejects.toThrow("互相包含");
		expect(adapter.writeBinary).not.toHaveBeenCalled();
	});

	it("移动端、缺桌面 API、应用版本不兼容时给出明确失败", async () => {
		const { app } = makeApp();
		Platform.isMobile = true;
		await expect(installLocalPlugin(app, source)).rejects.toThrow("桌面端");
		Platform.isMobile = false;
		vi.stubGlobal("require", undefined);
		await expect(installLocalPlugin(app, source)).rejects.toThrow("桌面端");
	});
});


it("更新前拒绝目标资源符号链接，保持外部文件和旧插件状态", async () => {
	const { app, adapter, plugins } = makeApp();
	await disk.mkdir(target(), { recursive: true });
	const external = path.join(temp, "external.txt");
	await disk.writeFile(external, "keep");
	await disk.symlink(external, path.join(target(), "main.js"));
	plugins.enabledPlugins.add("sample");
	await expect(installLocalPlugin(app, source)).rejects.toThrow("符号链接");
	expect(adapter.writeBinary).not.toHaveBeenCalled();
	expect(plugins.disablePlugin).not.toHaveBeenCalled();
	expect(await disk.readFile(external, "utf8")).toBe("keep");
});

it("应用最低版本不满足时拒绝安装", async () => {
	const { app, adapter } = makeApp();
	await disk.writeFile(path.join(source, "manifest.json"), JSON.stringify({ id: "sample", version: "1.0", minAppVersion: "99.0.0" }));
	vi.mocked(requireApiVersion).mockReturnValue(false);
	await expect(installLocalPlugin(app, source)).rejects.toThrow("99.0.0");
	expect(adapter.writeBinary).not.toHaveBeenCalled();
});
