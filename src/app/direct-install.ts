/**
 * 直链安装：从「按路径摊开放三件套」的目录 URL 安装另一个插件。
 *
 * 设计取舍（借鉴 notesynchelper/chinabrat，MIT）：
 * - 刻意不走 zip：源站把 manifest.json / main.js / styles.css 按路径摊开放，
 *   客户端就退化成三个 GET，无需任何解压依赖，且每个文件都能被 CDN 分别缓存。
 * - 安装前做完整安全校验，写盘不可逆。
 * - 装完确认 Obsidian 真的加载起来，不假报成功。
 *
 * 仅用半官方 app.plugins 内部 API（loadManifests / disablePlugin / enablePluginAndSave），
 * 与 BRAT / chinabrat 一致；其余皆公开 API（requestUrl / vault.adapter / requireApiVersion）。
 */

import { Modal, Notice, Setting, type App, requestUrl, requireApiVersion } from "obsidian";
import { makeT } from "@shared/i18n";
import { asAppInternals } from "@data/platform/obsidian-internals";

const t = makeT();

/** 一个插件的三件套，顺序固定；styles.css 允许缺失 */
const FILES = ["manifest.json", "main.js", "styles.css"] as const;

interface Manifest {
	id: string;
	name?: string;
	version: string;
	minAppVersion?: string;
}

/**
 * 从目录直链安装：取三件套 → 写盘 → 加载并启用，返回它的 manifest。
 * 不做解压。抛错即代表安装失败（调用方负责 Notice）。
 */
/**
 * 解析安装来源 URL 到三件套所在目录的 URL。
 * 支持：
 *   1) 裸目录 URL（https://example.com/myplugin/）
 *   2) 指向 manifest.json 的完整链接（自动取父目录）
 *   3) GitHub 仓库 URL（含 /tree/<branch>、/blob/<branch>/...、.git），自动重写到 raw.githubusercontent.com
 */
export function resolveInstallRoot(input: string): URL {
	const trimmed = input.trim();
	let u: URL;
	try {
		u = new URL(trimmed);
	} catch {
		throw new Error(t("directInstall.badUrl"));
	}
	// 装什么就等于执行什么，明文 http 会被同网段的人换掉；只给本机开发放行
	const dev = u.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
	if (u.protocol !== "https:" && !dev) throw new Error(t("directInstall.needHttps"));
	u.hash = "";

	// GitHub：仓库/分支/blob 链接 → 重写到 raw.githubusercontent.com（默认分支用 HEAD）
	if (u.hostname === "github.com") {
		const parts = u.pathname.split("/").filter(Boolean);
		if (parts.length < 2) throw new Error(t("directInstall.badUrl"));
		const owner = parts[0];
		let repo = parts[1];
		if (repo.endsWith(".git")) repo = repo.slice(0, -4);
		if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
			throw new Error(t("directInstall.badUrl"));
		}
		let branch = "HEAD";
		const sub = parts[2];
		if (sub === "tree") {
			const b = parts.slice(3).join("/");
			if (b) branch = b;
		} else if (sub === "blob" && parts[3]) {
			branch = parts[3];
		}
		// branch 里出现 #/?/空白 会让 URL 解析错位，提前拒绝
		if (/[#?\s]/.test(branch)) throw new Error(t("directInstall.badUrl"));
		const raw = new URL(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/`);
		raw.search = u.search; // 保留 query（签名参数等）
		return raw;
	}

	// 其他：目录 URL 或 manifest.json 链接 → 标准化为目录
	u.pathname = u.pathname.replace(/\/manifest\.json$/i, "").replace(/\/+$/, "") + "/";
	return u;
}

export async function installFromUrl(app: App, url: string): Promise<Manifest> {
	const root = resolveInstallRoot(url);

	const fetchText = async (name: string): Promise<string | null> => {
		const u = new URL(root);
		u.pathname += name;
		const r = await requestUrl({ url: u.href, throw: false });
		if (r.status >= 200 && r.status < 300) return r.text;
		// 只有「确实没有」才算可选文件缺失：500/403 当成缺失会误删已装好的旧样式
		if (name === FILES[2] && (r.status === 404 || r.status === 410)) return null;
		throw new Error(`${name} ${t("directInstall.fetchFail")} HTTP ${r.status}`);
	};

	const manText = (await fetchText(FILES[0])) as string;
	const man = JSON.parse(manText) as Manifest;
	const id = man.id;
	// id 会拼进写盘路径，且缺字段的 manifest 写进去会让插件加载不了
	if (
		typeof id !== "string" ||
		!/^[\w.-]+$/.test(id) ||
		id.startsWith(".") ||
		typeof man.version !== "string"
	) {
		throw new Error(t("directInstall.badManifest"));
	}
	// 写盘不可逆，先确认这版跑得起来，别把能用的版本覆盖成装不上的
	if (man.minAppVersion) {
		if (!requireApiVersion(man.minAppVersion)) {
			throw new Error(t("directInstall.minApp", { v: man.minAppVersion }));
		}
	}

	const texts: (string | null)[] = [
		manText,
		...(await Promise.all([fetchText(FILES[1]), fetchText(FILES[2])])),
	];
	if (!(texts[1] as string).trim()) throw new Error(t("directInstall.emptyMain"));

	const ad = app.vault.adapter;
	const dir = app.vault.configDir + "/plugins/" + id;
	if (!(await ad.exists(dir))) await ad.mkdir(dir);
	for (let i = 0; i < FILES.length; i++) {
		const f = dir + "/" + FILES[i];
		// 新版本不再带 styles.css 时要删掉旧的，否则老样式会继续生效
		if (texts[i] != null) await ad.write(f, texts[i] as string);
		else if (await ad.exists(f)) await ad.remove(f);
	}

	const plugins = asAppInternals(app).plugins;
	if (!plugins) throw new Error(t("directInstall.noPluginsApi"));
	await plugins.loadManifests?.();
	// 已在运行的先停掉，否则新代码不会生效（报错不能吞：吞了会留下两个实例）
	if (plugins.manifests?.[id] || plugins.enabledPlugins?.has?.(id)) {
		await plugins.disablePlugin?.(id);
	}
	if (plugins.enablePluginAndSave) {
		await plugins.enablePluginAndSave(id);
	} else if (plugins.enablePlugin) {
		await plugins.enablePlugin(id);
	} else {
		throw new Error(t("directInstall.noPluginsApi"));
	}
	// 启用可能悄悄失败（不兼容、main.js 报错），别把它说成安装成功
	const stillEnabled = plugins.enabledPlugins?.has?.(id) ?? Boolean(plugins.manifests?.[id]);
	if (!stillEnabled) {
		throw new Error(t("directInstall.enableFailed"));
	}
	return man;
}

/** 直链安装模态框：输入目录 URL → 一键安装 */
export class DirectInstallModal extends Modal {
	private url = "";
	private busy = false;

	constructor(app: App) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("pt-direct-install-modal");

		contentEl.createEl("h3", { text: t("directInstall.title") });
		contentEl.createEl("p", {
			cls: "pt-direct-install-desc",
			text: t("directInstall.desc"),
		});

		new Setting(contentEl)
			.setName(t("directInstall.urlLabel"))
			.setDesc(t("directInstall.urlDesc"))
			.addText((text) => {
				text.setPlaceholder("https://example.com/myplugin/")
					.setValue(this.url)
					.onChange((v) => (this.url = v));
				text.inputEl.setCssStyles({ width: "100%" });
			})
			.addButton((btn) =>
				btn
					.setButtonText(t("directInstall.install"))
					.setCta()
					.onClick(() => void this.run(btn))
			);
	}

	private async run(btn: { buttonEl: HTMLElement; setButtonText: (s: string) => unknown; setDisabled: (b: boolean) => unknown }): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		const label = btn.buttonEl.textContent || t("directInstall.install");
		btn.setButtonText(t("directInstall.installing"));
		btn.setDisabled(true);
		try {
			const m = await installFromUrl(this.app, this.url);
			new Notice(t("directInstall.done", { name: m.name || m.id, v: m.version }), 6000);
			this.close();
		} catch (e) {
			new Notice(t("directInstall.failed", { msg: e instanceof Error ? e.message : String(e) }), 8000);
		} finally {
			this.busy = false;
			btn.setButtonText(label);
			btn.setDisabled(false);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
