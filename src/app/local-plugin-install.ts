import { Platform, requireApiVersion, type App } from "obsidian";
import { asAppInternals } from "@data/platform/obsidian-internals";
import { makeT } from "@shared/i18n";

const t = makeT();

function unquote(input: string): string {
	const value = input.trim();
	return /^(".*"|'.*')$/.test(value) ? value.slice(1, -1) : value;
}

export function isLocalPluginPath(input: string): boolean {
	return /^(?:file:\/\/|\/|~[\\/]|[a-z]:[\\/]|\\\\)/i.test(unquote(input));
}

/** 桌面本地安装：读取源目录后复制到 vault，保留源文件和目标插件的 data.json。 */
export async function installLocalPlugin(app: App, input: string, expectedId?: string, installedVersion?: string) {
	const req = (window as unknown as { require?: (id: string) => unknown }).require;
	const adapter = app.vault.adapter;
	const getBasePath = (adapter as typeof adapter & { getBasePath?: () => string }).getBasePath;
	if (Platform.isMobile || !req || !getBasePath) throw new Error(t("directInstall.local.desktop"));
	const fs = (req("fs") as typeof import("node:fs")).promises;
	const path = req("path") as typeof import("node:path");
	const { fileURLToPath, pathToFileURL } = req("url") as typeof import("node:url");
	let source = unquote(input);
	if (/^file:\/\//i.test(source)) source = fileURLToPath(source);
	if (/^~[\\/]/.test(source)) {
		const os = req("os") as typeof import("node:os");
		source = path.join(os.homedir(), source.slice(2));
	}
	if (!path.isAbsolute(source)) throw new Error(t("directInstall.local.path"));
	if (path.basename(source).toLowerCase() === "manifest.json") source = path.dirname(source);
	source = await fs.realpath(source);
	const manText = await fs.readFile(path.join(source, "manifest.json"), "utf8");
	const value: unknown = JSON.parse(manText);
	if (!value || typeof value !== "object") throw new Error(t("directInstall.badManifest"));
	const man = value as { id: string; name?: string; version: string; minAppVersion?: string };
	if (typeof man.id !== "string" || !/^[\w.-]+$/.test(man.id) || man.id.startsWith(".") ||
		typeof man.version !== "string" || !man.version.trim() ||
		(man.name !== undefined && typeof man.name !== "string") ||
		(man.minAppVersion !== undefined && typeof man.minAppVersion !== "string")) throw new Error(t("directInstall.badManifest"));
	if (expectedId && man.id !== expectedId) throw new Error(t("beta.idMismatch", { id: man.id, entry: expectedId }));
	if (man.id === "chinese-plugin-market") throw new Error(t("directInstall.local.self"));
	if (man.minAppVersion && !requireApiVersion(man.minAppVersion)) throw new Error(t("directInstall.minApp", { v: man.minAppVersion }));
	const sourceUrl = pathToFileURL(source + path.sep).href;
	if (installedVersion === man.version) return { man, sourceUrl, updated: false };
	const main = await fs.readFile(path.join(source, "main.js"), "utf8");
	if (!main.trim()) throw new Error(t("directInstall.emptyMain"));
	const plugins = asAppInternals(app).plugins;
	if (!plugins || (!plugins.enablePluginAndSave && !plugins.enablePlugin)) throw new Error(t("directInstall.noPluginsApi"));
	const dir = `${app.vault.configDir}/plugins/${man.id}`;
	const vaultRoot = await fs.realpath(getBasePath.call(adapter));
	const targetPath = path.resolve(vaultRoot, dir);
	const assertNoSymlink = async (file: string): Promise<void> => {
		if (!file.startsWith(vaultRoot + path.sep)) throw new Error(t("directInstall.local.path"));
		for (let current = file; current !== vaultRoot; current = path.dirname(current)) {
			const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return null;
				throw error;
			});
			if (stat?.isSymbolicLink()) throw new Error(t("directInstall.local.symlink"));
		}
	};
	await assertNoSymlink(targetPath);
	const target = await fs.realpath(targetPath).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return targetPath;
		throw error;
	});
	if (target !== targetPath) throw new Error(t("directInstall.local.symlink"));
	// 不允许把一个父目录递归复制进它自己，也不覆盖当前运行的市场插件。
	if (target !== source && (target.startsWith(source + path.sep) || source.startsWith(target + path.sep))) {
		throw new Error(t("directInstall.local.overlap"));
	}
	const files: { relative: string; bytes: ArrayBuffer }[] = [];
	const readDirectory = async (folder: string, prefix = ""): Promise<void> => {
		for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || entry.name === "node_modules" || (!prefix && entry.name === "data.json")) continue;
			const relative = prefix + entry.name;
			const full = path.join(folder, entry.name);
			if (entry.isSymbolicLink()) throw new Error(t("directInstall.local.symlink"));
			if (entry.isDirectory()) await readDirectory(full, relative + "/");
			else if (entry.isFile()) {
				const buffer = await fs.readFile(full);
				files.push({ relative, bytes: Uint8Array.from(buffer).buffer });
			}
		}
	};
	if (source !== target) await readDirectory(source);
	// 写入前检查已有文件及父目录，避免更新时沿目标资源链接覆盖 vault 外的文件。
	for (const file of files) await assertNoSymlink(path.join(targetPath, file.relative));
	if (plugins.enabledPlugins?.has?.(man.id)) {
		if (!plugins.disablePlugin) throw new Error(t("directInstall.noPluginsApi"));
		await plugins.disablePlugin(man.id);
	}
	if (source !== target) {
		for (const file of files) {
			const parts = `${dir}/${file.relative}`.split("/");
			parts.pop();
			let parent = "";
			for (const part of parts) {
				parent = parent ? `${parent}/${part}` : part;
				if (!(await adapter.exists(parent))) await adapter.mkdir(parent);
			}
			await adapter.writeBinary(`${dir}/${file.relative}`, file.bytes);
		}
		if (!files.some((file) => file.relative === "styles.css") && await adapter.exists(`${dir}/styles.css`)) {
			await adapter.remove(`${dir}/styles.css`);
		}
	}
	await plugins.loadManifests?.();
	if (plugins.enablePluginAndSave) await plugins.enablePluginAndSave(man.id);
	else await plugins.enablePlugin?.(man.id);
	if (!(plugins.enabledPlugins?.has?.(man.id) ?? Boolean(plugins.manifests?.[man.id]))) {
		throw new Error(t("directInstall.enableFailed"));
	}
	return { man, sourceUrl, updated: true };
}
