/**
 * 中文区插件市场 / Chinese Plugin Market — 插件入口（Plugin 子类）
 *
 * 负责 onload/onunload、命令与图标注册，以及各类数据的加载与持久化
 * （离线词典 / 分类索引 / 推荐清单 / stats 缓存 / 向量索引）。
 * 视图本身由 translator-view.ts 的 ChinesePluginMarketView 承载。
 */

import { Plugin, Notice, TFile, TFolder, Platform, normalizePath } from "obsidian";
import { logger } from "@shared/logger";
import { Translator, type PluginInfo, type CoverageSnapshot } from "@domain/catalog/translator";
import { type PluginStat } from "@domain/catalog/stats";
import { PluginStorage, CREDENTIAL_KEYS, type PluginCredentials } from "@data/storage/plugin-storage";
import { setHttpClient } from "@data/net/http-port";
import { setPlatformCapability } from "@translation/platform/macos-shortcuts";
import type { NoteStoragePort } from "@translation/memory/note-port";
import {
	ObsidianHttpClient,
	ObsidianStoragePort,
	ObsidianNoteStorage,
	obsidianPlatformCapability,
} from "@app/obsidian-adapters";
import { makeT } from "@shared/i18n";
import { setScrollDebug } from "@ui/view/view-render";
import { TranslatorSettingTab } from "@app/settings-tab";
import { debounce, mapWithConcurrency, contentHash } from "@shared/utils";
import { LocalEmbeddingProvider, buildVectorIndex, DEFAULT_LOCAL_MODEL, type EmbeddingProvider, type IndexPlugin } from "@semantic/embedding";
import { setWorkerSourceLoader } from "@semantic/workers/worker-backend";
import { ChinesePluginMarketView, ChinesePluginMarketSettings, DEFAULT_SETTINGS, getDefaultSettings } from "@ui/view/translator-view";
import { VIEW_TYPE } from "@shared/constants";
import { writeTMNote, removeTMNote, TM_FOLDER, parseTMNote, type TMEntry } from "@translation/memory/translation-memory";
import { SqliteVectorStore, initSqlJsStatic, type PersistAdapter } from "@semantic/vec-store";
import type { TrendSnapshot } from "@domain/recommend/trending";
import type { DrawerHostPlugin } from "@ui/components/detail-drawer";
/** Translator.loadData 的入参结构（避免导入未导出的内部类型） */
type LoadDataRaw = NonNullable<Parameters<Translator["loadData"]>[0]>;
/** Translator.setPluginTags 的入参结构 */
type PluginTagMap = NonNullable<Parameters<Translator["setPluginTags"]>[0]>;
export default class ChinesePluginMarketPlugin extends Plugin {
	settings: ChinesePluginMarketSettings = getDefaultSettings();
	translator: Translator = new Translator();
	/** 落盘 stats 缓存（onload 时恢复，供视图首屏合并，产品改进 #1 #6） */
	cachedStats: Map<string, PluginStat> | null = null;
	/** 趋势采样历史（onload 时恢复，视图的 TrendingEngine 从此水合；跨会话才有真实增速） */
	cachedTrendingHistory: Record<string, TrendSnapshot[]> | null = null;
	/** SQLite 向量库（P3+：真 SQLite，sql.js/WASM）。null 表示未初始化（sql-wasm 缺失或加载失败）。 */
	private vectorStore: SqliteVectorStore | null = null;
	/** SQLite 初始化失败记忆：true 后本会话不再重试（Obsidian 沙箱可能无法加载 sql.js，避免反复报错刷屏）。 */
	private vectorStoreInitFailed = false;
	/** 本地向量索引后台预建状态（A+B：设置页手动预建 / 数据就绪后自动预建共用） */
	localIndexState: {
		status: "idle" | "building" | "done" | "error";
		progress: number;
		total: number;
		message?: string;
		error?: string;
	} = { status: "idle", progress: 0, total: 0 };
	/** 当前构建的 Promise（并发去重用：让多次调用共享同一次构建，而非直接 return） */
	private buildLocalIndexPromise: Promise<void> | null = null;
	/** 已「见过」的插件 id 集合（产品改进 #16，跨会话落盘，增量提示在重启后仍准确） */
	seenPluginIds: Set<string> = new Set();
	/** 上次落盘 translator-cache 的内容指纹（PERF-5：相同内容跳过全量序列化+写盘） */
	private _lastTranslatorFingerprint = "";
	/**
	 * TM 回灌就绪信号：scanVaultTM 把 vault 翻译记忆笔记灌入 tmApproved 后 resolve。
	 * 视图首屏 mergeOffline 必须 await 它，否则会在回灌完成前用「空 tmApproved」兜底，
	 * 导致命中不到已采纳译名（表现为「卡片没加载库里的翻译数据」）。
	 */
	tmApprovedReady: Promise<void> = new Promise((resolve) => {
		this._resolveTmApprovedReady = resolve;
	});
	// 注意：不能写成 `_resolveTmApprovedReady: () => void = () => {}` —— 类字段按声明顺序初始化，
	// 该默认赋值会在 tmApprovedReady 的 executor 之后执行，把上面捕获的真正 resolve 覆盖成 no-op，
	// 导致 tmApprovedReady 永远不被 resolve（首屏视图只能等 15s 安全阀兜底）。
	private _resolveTmApprovedReady!: () => void;
	/** TM 回灌实时进度（供加载页展示）。 */
	tmProgress: DrawerHostPlugin["tmProgress"] = null;
	/** 官方推荐插件 id 集合（由 plugin-recommend.json 加载，推荐 feature） */
	recommendedIds: Set<string> = new Set();
	/** 独立缓存文件存储层（stats / trending / 插件列表），见 plugin-storage.ts */
	storage!: PluginStorage;
	/** TM 笔记存储端口（Obsidian Vault 适配器），供 writeTMNote / removeTMNote 注入 */
	private noteStorage!: NoteStoragePort;
	/** 官方推荐区标题（由 plugin-recommend.json 的 title 字段提供，缺省回退 i18n） */
	recommendedTitle: string = "官方推荐";
	/**
	 * 持久化权威对象：onload 时一次性加载，之后所有保存（settings / translator）
	 * 直接 mutate 各自字段后整体写盘，不再每次保存都整读 data.json。
	 * 这样 settings 与 translator 数据共存同一文件也无需反复 read+merge，并消除
	 * 两个独立防抖 saver 间的「后写覆盖先写」竞态。
	 */
	private _data: Record<string, unknown> = {};
	/** 上次成功拉取社区插件列表的时间戳（ms），持久化以跨会话 TTL 判断。
	 * 之前是视图内存字段，重启归零导致 isListStale(0,now,6h) 恒真 → 每次启动都重拉+重译。 */
	lastListFetchAt = 0;
	/** 插件 id→分类映射缓存，避免每次过滤全量重建 */
	pluginTagMap: Map<string, string> = new Map();
	/**
	 * 内置兜底推荐清单：随包编译进 main.js，保证即使 plugin-recommend.json
	 * 因权限/路径等问题读取失败，首页「官方推荐」区依然可用（种子为羽鳞君插件）。
	 */
	static readonly FALLBACK_RECOMMENDED_IDS: string[] = [
		"atomic-notes-extractor",
		"bamboo-immortals",
		"bamboo-walking",
	];
	static readonly FALLBACK_RECOMMENDED_TITLE = "官方推荐 · 羽鳞君";
	/** 官方推荐插件 id 集合（供视图打标与过滤） */
	getRecommendedIds(): Set<string> {
		return this.recommendedIds;
	}

	/** 读插件列表缓存（委托 PluginStorage，传入主 data.json 用于旧版迁移回退） */
	loadPluginListCache(): Promise<unknown[] | null> {
		return this.storage.loadPluginListCache(this._data);
	}

	/** 更新插件 id→分类映射缓存（从 translator.pluginTags 提取） */
	buildPluginTagMap(): void {
		this.pluginTagMap.clear();
		for (const [id, tag] of Object.entries(this.translator.getAllPluginTags())) {
			if (tag?.category) this.pluginTagMap.set(id, tag.category);
		}
	}

	/**
	 * 分类标签后台加载完成后的回调（由视图注册）。
	 * 标签数据可能晚于首屏 facet 渲染就绪，完成后通知视图刷新分类 chips，避免残留空态（T4/#7）。
	 */
	onPluginTagsLoaded: (() => void) | null = null;

	async onload() {
		// 依赖倒置装配点：把 Obsidian 具体 API 适配成端口实现注入下层。
		// 必须在任何下层逻辑（网络 / 缓存 / TM / 平台判断）执行之前完成，
		// 否则未注入的 HttpClient 会显式抛错。
		setHttpClient(new ObsidianHttpClient());
		setPlatformCapability(obsidianPlatformCapability());
		this.noteStorage = new ObsidianNoteStorage(this.app);
		// PERF-3：注入 worker 源码加载器——运行时按需从插件目录读 embedding-worker.bundle.js
		// 独立文件（不再构建期内联进 main.js），首次本地语义搜索时才付出读取成本。
		const workerBundlePath = `.obsidian/plugins/${this.manifest.id}/embedding-worker.bundle.js`;
		setWorkerSourceLoader(() => this.app.vault.adapter.read(workerBundlePath));

		// 防御：data.json 若因中断写盘而损坏（存在但 JSON 解析失败），
		// Obsidian 的 loadData() 会从 JSON.parse 直接抛出，导致整个 onload 中止、
		// 插件彻底无法加载。此处兜底为空白状态，保证插件始终能启动（数据可重建）。
		let loaded: Record<string, unknown> = {};
		try {
			loaded = ((await this.loadData()) as Record<string, unknown>) ?? {};
		} catch (e: unknown) {
			logger.warn(
				"[Chinese Plugin Market] data.json 解析失败，已回退空白状态（原文件可能损坏）：",
				e,
			);
			loaded = {};
		}
		this._data = loaded;
		const allData = this._data;
		// 独立缓存存储层（stats / trending / 插件列表），先行初始化以供后续加载使用
		this.storage = new PluginStorage(new ObsidianStoragePort(this.app), this.manifest.id);
		await this.loadSettings(allData);
		await this.loadTranslatorData(allData);

		// 注意：不再清理非 online 缓存。原「内存缓存治理」假设懒翻译/单卡按钮会在会话内
		// 自动重算 bulk/custom/tm 等非 online 译文并重新写回 cache；但这些入口均已废弃，
		// 清理后无人补回 → 大量插件重启后变回英文原文。
		// 现在保留全部落盘缓存（含 bulk/custom/tm/ai），mergeOffline 直接使用。

		// 启动双向回灌 + 向量索引 + 缓存恢复等重 IO 工作整体后移至 onLayoutReady：
		// scanVaultTM 仅遍历 TM 文件夹子树（不枚举全 vault）+ 读快照，含最长 2000ms 的
		// waitMetadataResolved 超时；loadVectorIndex 初始化 sql.js WASM 并读出数千条向量；
		// stats/trending 读盘恢复，
		// 若串行阻塞在 onload 里会拖慢整个 Obsidian 启动并连累后续插件。
		// 注册视图/命令/ribbon/设置面板不依赖它们，故先同步完成，再在布局就绪后异步补完。
		// 内部顺序（TM → 剔除遮蔽缓存 → 向量 → 预热 → stats → trending → 推荐）必须保持原子，
		// 否则会出现「重启后部分插件短暂英文、随后跳变中文」的闪烁。
		// 安全阀：极少数情况下 scanVaultTM 可能在重 IO（写快照大 JSON / 重扫）时
		// 卡住未返回，导致 tmApprovedReady 永远不 resolve、首屏视图永久停在加载页。
		// 这里兜底在 30s 后强制 resolve，保证视图不会无限死等（超时后视图降级为
		// 无 vault 译名兜底，数据仍可用；下个 reload 会重新尝试回灌）。
		// 注意：仅在 tmApprovedReady 尚未 resolve 时才报警并兜底（用闭包标志位判定，
		// 而非重复 resolve——Promise 重复 resolve 是 no-op），避免回灌正常完成时
		// 仍到点打印「兜底超时」假报警，误导排查。
		let tmApprovedSettled = false;
		const origResolve = this._resolveTmApprovedReady;
		this._resolveTmApprovedReady = (...args: []) => {
			tmApprovedSettled = true;
			origResolve(...args);
		};
		window.setTimeout(() => {
			if (tmApprovedSettled) return; // 回灌已正常完成，不误报
			logger.warn(
				"[Chinese Plugin Market] tmApprovedReady 兜底超时（30s）：视图已降级继续，vault 译名可能未回灌。",
			);
			this._resolveTmApprovedReady();
		}, 30_000);

		// 官方推荐清单（体量小，同步加载以保推荐区首屏完整；不依赖 initDeferredLoad 的异步时序）
		await this.loadPluginRecommend();

		this.app.workspace.onLayoutReady(() => {
			void this.initDeferredLoad().catch((e) =>
				logger.error("[Chinese Plugin Market] 延迟初始化失败：", e),
			);
		});

		// 注册视图
		this.registerView(VIEW_TYPE, (leaf) => new ChinesePluginMarketView(leaf, this));

		const t = makeT();

		// 命令：打开搜索视图
		this.addCommand({
			id: "open-translator-view",
			name: t("app.search"),
			callback: () => {
				void this.openTranslatorView();
			},
		});

		// 左侧栏图标
		this.addRibbonIcon("languages", "插件搜索", () => {
			void this.openTranslatorView();
		});

		this.addCommand({
			id: "scroll-layout-debug",
			name: "诊断滚动布局（开发者）",
			callback: () => {
				const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
				const view = leaves[0]?.view as ChinesePluginMarketView | undefined;
				if (!(view instanceof ChinesePluginMarketView)) {
					new Notice("请先打开插件搜索视图");
					return;
				}
				const vp = view.scrollViewport;
				if (!vp) {
					new Notice("scrollViewport 不存在");
					return;
				}
				const cs = getComputedStyle(vp);
				const root = vp.parentElement;
				const rcs = root ? getComputedStyle(root) : null;
				const info = {
					viewportClientH: vp.clientHeight,
					viewportScrollH: vp.scrollHeight,
					viewportScrollTop: vp.scrollTop,
					viewportDisplay: cs.display,
					viewportPosition: cs.position,
					viewportHeight: cs.height,
					viewportOverflowY: cs.overflowY,
					rootClass: root?.className ?? "(无)",
					rootDisplay: rcs?.display ?? "(无)",
					rootPosition: rcs?.position ?? "(无)",
					rootHeight: rcs?.height ?? "(无)",
					canScroll: vp.scrollHeight > vp.clientHeight + 1,
				};
				logger.debug(info);
				const msg =
					`列表高度=${info.viewportClientH}px | 内容总高=${info.viewportScrollH}px | 可滚动=${info.canScroll}\n` +
					`viewport: display=${info.viewportDisplay} position=${info.viewportPosition} overflowY=${info.viewportOverflowY}\n` +
					`root(.${info.rootClass}): display=${info.rootDisplay} position=${info.rootPosition} height=${info.rootHeight}`;
				new Notice(msg, 15000);
			},
		});

		this.addCommand({
			id: "scroll-debug-on",
			name: "开启滚动实时诊断（开发者）",
			callback: () => {
				setScrollDebug(true);
				new Notice("滚动诊断已开启，滚动列表看控制台 [scroll-debug]");
			},
		});
		this.addCommand({
			id: "scroll-debug-off",
			name: "关闭滚动实时诊断（开发者）",
			callback: () => {
				setScrollDebug(false);
				new Notice("滚动诊断已关闭");
			},
		});

		// 翻译记忆库（TM）命令
		this.addCommand({
			id: "tm-clear-approved",
			name: t("tm.clear.command"),
			callback: () => void this.clearApprovedTM(),
		});

		// 注册 TM 文件夹的 vault 事件：用 create/delete 事件增量发现笔记，
		// 而非启动时枚举全 vault（避免 Vault Enumeration）。collectTMFiles 已只遍历子树。
		this.registerTMVaultEvents();

		// 设置面板
		this.addSettingTab(new TranslatorSettingTab(this.app, this));
	}

	/**
	 * 注册 TM 文件夹的 vault 事件，替代「枚举全 vault 来发现 TM 笔记」。
	 *
	 * - create：若新文件落在 TM 文件夹子树且为 approved 笔记，增量回灌进 tmApproved；
	 * - delete：若删除的是已记录 TM 笔记，从 tmApproved 移除。
	 * 这样即使 collectTMFiles 在极端环境下取不到文件夹（返回空），用户在运行时新建/
	 * 手编的 TM 笔记仍能被实时发现，无需重启后全量扫描。
	 */
	private registerTMVaultEvents(): void {
		const prefix = normalizePath(TM_FOLDER) + "/";
		const isTMFile = (path: string) =>
			path === normalizePath(TM_FOLDER) || path.startsWith(prefix);

		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (!(file instanceof TFile) || !isTMFile(file.path)) return;
				if (!file.path.endsWith(".md")) return;
				// 延迟到 metadataCache 就绪后读 frontmatter（新建笔记瞬时可能未建索引）
				void this.resolveTMFileIntoIndex(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (!(file instanceof TFile) || !isTMFile(file.path)) return;
				// 删除检测：快照里记录过、且本次删除的正是该 path → 从 tmApproved 移除
				const id = this._lastTMIdsByPath[file.path];
				if (id) {
					delete this.translator.tmApproved[id];
					delete this._lastTMIdsByPath[file.path];
				}
			}),
		);
	}

	/** 单文件解析并回灌进 tmApproved（供 create 事件与增量重扫复用） */
	private async resolveTMFileIntoIndex(file: TFile): Promise<void> {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		let e: TMEntry | null = null;
		if (fm && fm.id) {
			e = this.entryFromFrontmatter(fm);
		} else {
			e = parseTMNote(await this.app.vault.cachedRead(file));
		}
		if (e && e.id) {
			this._lastTMIdsByPath[file.path] = e.id;
			if (e.status === "approved") {
				this.translator.tmApproved[e.id] = e;
			} else {
				delete this.translator.tmApproved[e.id];
			}
		}
	}

	// 防抖：避免数据加载阶段 12+ 次连续 saveTranslatorData I/O
	private _saveTranslatorDataTimer: number | null = null;
	// 防抖：避免 track() 每次交互都触发全量 data.json 写入（收敛自手写的 setTimeout/clearTimeout，审计 P1-1）
	private _saveSettingsDebounce = debounce(() => {
		void this._saveSettingsImmediate();
	}, 300);

	/**
	 * 延迟初始化：从 onload 剥离的重 IO 工作，整体在 workspace.onLayoutReady 后异步执行。
	 * 保持原内部原子顺序（TM 回灌 → 剔除被 tmApproved 遮蔽的缓存 → 向量索引 → 本地 embedding 预热
	 * → stats/trending 缓存恢复 → 官方推荐清单 → 分类索引），完成后通知已打开的视图重渲染，
	 * 使视图用最终数据呈现（消除「重启后短暂英文、随后跳变中文」的闪烁）。
	 */
	private async initDeferredLoad() {
		// 预热本地 embedding（local 模式）：提前启动 worker + 加载 bge 模型（~110MB），
		// 让首次本地语义搜索免冷启动。放在延迟初始化最前面（本方法已在 onLayoutReady 后
		// 执行，Worker 创建时序已安全），使模型下载与下方 scanVaultTM / loadVectorIndex
		// 的重 IO 并行，而非等它们串行完成后再开始——缩短首次搜索的实际等待。
		// 小延迟仅用于让布局先稳定，避免与首屏渲染抢资源；warmup 本身幂等且 fire-and-forget。
		if (this.settings.embeddingSource === "local") {
			window.setTimeout(() => this.warmupLocalEmbedding(), 3000);
		}
		// 启动双向回灌：vault 手编笔记 → tmApproved 索引（必须完成后再 mergeOffline）
		try {
			await this.scanVaultTM();
		} finally {
			// 无论回灌成功/失败都放行，避免视图永久挂起在 await 上，
			// 失败也只是少了 vault 译名兜底（降级到原在线/cache 逻辑）。
			this._resolveTmApprovedReady();
		}
		for (const id of Object.keys(this.translator.cache)) {
			if (this.translator.tmApproved[id]) {
				delete this.translator.cache[id];
			}
		}
		// 恢复落盘向量索引（跨会话复用，无则下次搜索时重建）
		// PERF-7：向量索引与 stats/trending/分类索引彼此无依赖，并行加载缩短延迟初始化耗时。
		// loadVectorIndex 走 SQLite（反量化数千向量）最慢，与后三者并行可让 stats/trending 提前就绪。
		const [, stats, trending] = await Promise.all([
			this.loadVectorIndex(),
			this.storage.loadStatsCache(),
			this.storage.loadTrendingHistory(),
		]);
		// 注：本地 embedding 预热已在上方并行启动，无需在此再次触发。
		// 恢复 stats 缓存（带 TTL，超期返回 null 由视图重新拉取）
		this.cachedStats = stats;
		// 恢复趋势采样历史（跨会话累积才能算出真实下载增速，H1/H2 修复）
		this.cachedTrendingHistory = trending;
		// 后台异步加载插件分类索引（不阻塞视图启动，加载完成后同步更新 pluginTagMap）
		this.loadPluginTags().catch((e) =>
			logger.warn("[Chinese Plugin Market] 后台加载分类索引失败：", e),
		);

		// TM/索引就绪：通知已打开的视图用最终数据重渲染一次。
		// 视图尚未创建时无需处理——其 onOpen 会自然读到已就绪的数据。
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof ChinesePluginMarketView) {
				view.invalidateAndRender(false);
			}
		}
	}

	onunload() {
		// 防抖窗口内的未落盘变更不能直接丢弃（曾只 clearTimeout，导致刚编辑的
		// 词典 / TM 脏条目 / 埋点在禁用或更新插件时静默丢失）：
		// 取消定时器后立即启动一次落盘（onunload 不能 await，fire-and-forget）。
		const pendingSettings = this._saveSettingsDebounce.pending();
		const pendingTranslator = this._saveTranslatorDataTimer != null;
		if (this._saveTranslatorDataTimer) {
			window.clearTimeout(this._saveTranslatorDataTimer);
			this._saveTranslatorDataTimer = null;
		}
		this._saveSettingsDebounce.cancel();
		if (pendingSettings || pendingTranslator) {
			void (async () => {
				// 串行执行，避免两次 saveData 并发写同一文件
				if (pendingSettings) await this._saveSettingsImmediate();
				// 卸载时序不可靠：跳过依赖 vault adapter 的 flushTMVault，
			// 仅写进程内 data.json（translator 内存数据已含 TM 缓存），保证兜底落盘成功（#31）
			if (pendingTranslator) await this._saveTranslatorDataImmediate(false);
			})().catch((e) =>
				logger.warn("[Chinese Plugin Market] 卸载时落盘失败：", e)
			);
		}
		// 关闭所有翻译视图
		this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => leaf.detach());
		// 释放 SQLite 向量库（会冲刷未落盘的变更）
		void this.vectorStore?.dispose();
	}

	/** 打开翻译视图 */
	private async openTranslatorView() {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (existing.length > 0) {
			// 已有视图，直接切换过去
			this.app.workspace.setActiveLeaf(existing[0], { focus: true });
			return;
		}

		// 创建新视图
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({
			type: VIEW_TYPE,
			active: true,
		});
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
	}



	// ──────────────────────────────────────────
	// 设置持久化
	// ──────────────────────────────────────────

	private async loadSettings(allData?: Record<string, unknown>) {
		const data: Record<string, unknown> = allData ?? ((await this.loadData()) as Record<string, unknown>) ?? {};
		// 清理已移除的 locale 字段（旧版本遗留，避免脏数据残留在 data.json）
		if ("locale" in data) delete data.locale;
		// 来源筛选已移除「自定义」选项，旧设置迁移回「全部」
		const legacyData = data as Record<string, unknown> & { sourceFilter?: string };
		if (legacyData.sourceFilter === "custom") {
			legacyData.sourceFilter = "all";
		}
		// 批量/在线/AI 三个来源已合并为「已翻译」，旧设置迁移
		if (["bulk", "online", "ai"].includes(legacyData.sourceFilter ?? "")) {
			legacyData.sourceFilter = "translated";
		}
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		// PERF-7：credentials 与 favorites 两个独立文件无依赖，并行读取缩短启动耗时。
		const [creds, loadedFavorites] = await Promise.all([
			this.storage.loadCredentials(),
			this.storage.loadFavorites(data),
		]);
		// 账号/密钥分离：敏感字段优先从独立 credentials.json 加载并覆盖 data.json 中的同名
		// 字段（旧版把密钥内联在主 data.json，升级后首次保存即迁移到 credentials.json）。
		if (creds) {
			for (const k of CREDENTIAL_KEYS) {
				(this.settings as unknown as Record<string, unknown>)[k] = creds[k];
			}
		}
		// 无论 credentials 是否存在，均剔除 data.json 内联的敏感字段，避免反复写回/泄露
		for (const k of CREDENTIAL_KEYS) {
			if (k in data) delete data[k];
		}
		// 个人收藏分离：优先从独立 favorites.json 加载并覆盖主 data.json 中的 favorites。
		// 旧版把 favorites 内联在主 data.json，升级后首次保存即迁移到 favorites.json。
		if (loadedFavorites) {
			this.settings.favorites = loadedFavorites;
		}
		// 无论 favorites.json 是否存在，均剔除 data.json 内联的 favorites 字段，避免反复写回
		if ("favorites" in data) delete data["favorites"];
		// 迁移清理：翻译缓存已移至独立文件 translator-cache.json（见 loadTranslatorData /
		// saveTranslatorCache），旧主 data.json 内联字段在此剔除，避免残留被反复写回。
		for (const k of [
			"_translatorCache", "_translatorAiDict", "_translatorTMQueue",
			"_translatorTMApproved", "_translatorPluginInsights", "_translatorCompareInsights",
			"_translatorCoverageSnapshots", "_myMemoryBlockedDate", "_seenPluginIds",
			"_lastListFetchAt", "_pluginListCache",
		]) {
			if (k in data) delete data[k];
		}
		// 本地模型名迁移：旧默认值（all-MiniLM-L6-v2，面向通用中英）已升级为
		// bge-small-zh（面向中文，vault-curate 同款）。用户 data.json 可能仍存旧默认值，
		// 自动迁移到新默认；仅当用户主动改成了其它模型名时才保留。
		if (
			typeof this.settings.embeddingLocalModel === "string" &&
			this.settings.embeddingLocalModel.trim().toLowerCase().includes("all-minilm-l6-v2")
		) {
			this.settings.embeddingLocalModel = DEFAULT_LOCAL_MODEL;
		}
		// embeddingSource 默认值迁移：旧默认是 "keyword"（无本地向量），新默认是
		// "local"（vault-curate 同款，默认走本地 bge 向量）。已有用户存了 "keyword" 时
		// 自动迁移到 "local"，让本地语义/本地向量能力真正生效。
		if (this.settings.embeddingSource === "keyword") {
			this.settings.embeddingSource = "local";
		}
		// #6: 移动端语义搜索降级。上面 keyword→local 的迁移只针对「曾存储 keyword 的桌面老用户」，
		// 会把本地向量能力打开；但移动端全新安装（data 里根本没有 embeddingSource 键）应默认
		// "keyword"（零 WASM），避免 26MB WASM 弱网下载慢 + 模型推理吃内存拖垮 Obsidian。
		// 判定条件：移动端 && data 未显式存过 embeddingSource（即用户从未主动选择过）。
		if (!("embeddingSource" in data)) {
			let isMobile = false;
			try {
				isMobile = typeof Platform !== "undefined" && Platform.isMobile === true;
			} catch {
				isMobile = false;
			}
			if (isMobile) this.settings.embeddingSource = "keyword";
		}
	}

	/**
	 * 保存设置（带 300ms 防抖）。
	 * 视图交互（排序/筛选/搜索/埋点）会高频调用此方法，防抖将其合并。
	 * 设置页中修改配置时，请用 flushSaveSettings() 保证即时落盘。
	 */
	saveSettings() {
		this._saveSettingsDebounce();
	}

	/** 内部实际写盘 */
	private async _saveSettingsImmediate() {
		// 性能：直接复用内存权威对象 _data，不再每次保存整读 data.json
		const allData = this._data;
		Object.assign(allData, this.settings);
		// 账号/密钥分离：从主 data.json 抽离敏感字段，单独写入 credentials.json。
		// 内存中 this.settings 仍保留这些值供设置页读取；落盘时主 data.json 不含密钥。
		const creds = {} as Record<string, unknown>;
		for (const k of CREDENTIAL_KEYS) {
			creds[k] = (this.settings as unknown as Record<string, unknown>)[k];
			delete allData[k];
		}
		await this.storage.saveCredentials(creds as unknown as PluginCredentials);
		// 个人收藏分离：favorites 从主 data.json 抽离，单独写入 favorites.json。
		// 内存中 this.settings 仍保留该值供视图/卡片读取；落盘时主 data.json 不含收藏。
		const favorites = (this.settings as unknown as Record<string, unknown>).favorites;
		if (Array.isArray(favorites)) {
			await this.storage.saveFavorites(favorites as string[]);
			delete allData["favorites"];
		}
		await this.saveData(allData);
	}

	/** 立即落盘设置（设置页/收藏/对比等关键变更点调用） */
	async flushSaveSettings() {
		this._saveSettingsDebounce.cancel();
		await this._saveSettingsImmediate();
	}

	private async loadTranslatorData(allData?: Record<string, unknown>) {
		const data: Record<string, unknown> = allData ?? ((await this.loadData()) as Record<string, unknown>) ?? {};
		// 翻译缓存优先从独立文件 translator-cache.json 读取；缺失时回退到旧版
		// 主 data.json 内联字段（兼容老用户升级，首次加载后由保存逻辑迁移到独立文件）。
		let cacheData = await this.storage.loadTranslatorCache();
		const legacy: LoadDataRaw = {
			cache: data._translatorCache as LoadDataRaw["cache"],
			aiDict: data._translatorAiDict as LoadDataRaw["aiDict"],
			tmQueue: data._translatorTMQueue as LoadDataRaw["tmQueue"],
			tmApproved: data._translatorTMApproved as LoadDataRaw["tmApproved"],
			myMemoryBlockedDate: data._myMemoryBlockedDate as LoadDataRaw["myMemoryBlockedDate"],
			pluginInsights: data._translatorPluginInsights as LoadDataRaw["pluginInsights"],
			compareInsights: data._translatorCompareInsights as LoadDataRaw["compareInsights"],
			coverageSnapshots: data._translatorCoverageSnapshots as LoadDataRaw["coverageSnapshots"],
		};
		if (!cacheData) {
			cacheData = {
				cache: (legacy.cache as Record<string, unknown>) ?? {},
				aiDict: (legacy.aiDict as Record<string, unknown>) ?? {},
				pluginInsights: (legacy.pluginInsights as Record<string, unknown>) ?? {},
				compareInsights: (legacy.compareInsights as Record<string, unknown>) ?? {},
				coverageSnapshots: (legacy.coverageSnapshots as CoverageSnapshot[]) ?? [],
				myMemoryBlockedDate: (legacy.myMemoryBlockedDate as string) ?? "",
				seenPluginIds: Array.isArray(data._seenPluginIds) ? (data._seenPluginIds as string[]) : [],
				lastListFetchAt: typeof data._lastListFetchAt === "number" ? data._lastListFetchAt : 0,
			};
		}
		this.translator.loadData({
			cache: cacheData.cache as unknown as LoadDataRaw["cache"],
			aiDict: cacheData.aiDict as unknown as LoadDataRaw["aiDict"],
			tmQueue: legacy.tmQueue,
			tmApproved: legacy.tmApproved,
			myMemoryBlockedDate: cacheData.myMemoryBlockedDate as LoadDataRaw["myMemoryBlockedDate"],
			pluginInsights: cacheData.pluginInsights as unknown as LoadDataRaw["pluginInsights"],
			compareInsights: cacheData.compareInsights as unknown as LoadDataRaw["compareInsights"],
			coverageSnapshots: cacheData.coverageSnapshots as LoadDataRaw["coverageSnapshots"],
		});
		// 跨会话恢复列表拉取时间（修复：原 lastListFetchAt 是视图内存字段，重启归零
		// 导致 isListStale(0, now, 6h) 恒真 → 每次启动都强制重拉列表 + 重译可见项）
		this.lastListFetchAt = cacheData.lastListFetchAt;
		// 已「见过」的插件 id 集合（产品改进 #16 跨会话落盘，避免重启后误报全量新插件）
		this.seenPluginIds = new Set(cacheData.seenPluginIds);
		if (this.settings.secretId && this.settings.secretKey) {
			this.translator.setApiConfig({
				secretId: this.settings.secretId,
				secretKey: this.settings.secretKey,
				region: this.settings.region,
			});
		}
		this.translator.setUseMyMemory(this.settings.useMyMemory);
		// 同步自托管翻译源（DeepLX / LibreTranslate）；空列表清空，行为完全不变
		this.translator.setSelfHostedTranslators(this.settings.selfHostedTranslators);
		// 从 settings 同步 AI 配置（与腾讯配置同款处理）。
		// 若不在此同步，translator.aiConfig 冷启动为 null，hasAI() 为假，
		// 导致已配置 API Key 的用户重启后 AI 翻译/搜索静默失效，直至打开设置页才恢复。
		if (this.settings.aiSearchEnabled && this.settings.aiSearchApiKey) {
			this.translator.setAIConfig({
				baseURL: this.settings.aiSearchBaseURL,
				apiKey: this.settings.aiSearchApiKey,
				model: this.settings.aiSearchModel,
			});
		}
	}

	/**
	 * 加载随插件分发的离线分类索引 plugin-tags.json（方案 A）。
	 * 与批量词典同目录（插件根）。缺失/解析失败时静默降级（分类 Tab 显示空提示）。
	 */
	private async loadPluginTags() {
		const fileName = "plugin-tags.json";
		try {
			const adapter = this.app.vault.adapter;
			const fullPath = `.obsidian/plugins/${this.manifest.id}/${fileName}`;
			if (!(await adapter.exists(fullPath))) {
				return;
			}
			const text = await adapter.read(fullPath);
			const parsed = JSON.parse(text) as Record<string, unknown>;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				this.translator.setPluginTags(parsed as PluginTagMap);
				this.buildPluginTagMap();
				// T4(#7): 分类标签就绪，通知视图刷新 facet（首屏可能早于标签加载完成）
				this.onPluginTagsLoaded?.();
			}
		} catch (e: unknown) {
			logger.warn(`[Chinese Plugin Market] 加载分类索引失败，已跳过：`, e);
		}
	}

	/** 加载官方推荐清单（plugin-recommend.json），种子为羽鳞君的全部插件 */
	private async loadPluginRecommend() {
		const fileName = "plugin-recommend.json";
		try {
			const adapter = this.app.vault.adapter;
			const fullPath = `.obsidian/plugins/${this.manifest.id}/${fileName}`;
			// 不依赖 adapter.exists（部分环境下对 .obsidian 目录探测不稳定），
			// 直接尝试读取，失败（含文件不存在）再走兜底。
			const text = await adapter.read(fullPath);
			const parsed = JSON.parse(text) as Record<string, unknown>;
			if (parsed && typeof parsed === "object") {
				if (typeof parsed.title === "string" && parsed.title.trim()) {
					this.recommendedTitle = parsed.title.trim();
				}
				const ids: string[] = Array.isArray(parsed.ids)
					? parsed.ids.filter((id: unknown) => typeof id === "string")
					: [];
				if (ids.length > 0) {
					this.recommendedIds = new Set(ids);
					return;
				}
			}
		} catch (e: unknown) {
			logger.warn(`[Chinese Plugin Market] 读取推荐清单失败，回退内置清单：`, e);
		}
		// 兜底：用编译进包的清单，保证首页「官方推荐」区始终可用
		this.recommendedIds = new Set(ChinesePluginMarketPlugin.FALLBACK_RECOMMENDED_IDS);
		if (this.recommendedTitle === "官方推荐") {
			this.recommendedTitle = ChinesePluginMarketPlugin.FALLBACK_RECOMMENDED_TITLE;
		}
	}


	/** 内部实际写盘（不做防抖）。flushVault=true 时同步写 TM 笔记（依赖 vault adapter）；卸载路径传 false 跳过，避免 onunload 时序不可靠导致落盘失败（#31）。 */
	private async _saveTranslatorDataImmediate(flushVault = true) {
		// 先把内存中变更的 TM 条目写盘到 vault 笔记（human 校正/反馈标记等同步来源）
		if (flushVault) await this.flushTMVault();
		// 翻译缓存独立成 translator-cache.json，避免大对象随主 data.json 整体重写
		//（缩小写盘频率与损坏面；升级/迁移互不污染用户态设置）。
		const translatorData = this.translator.getData();
		const persistCache: Record<string, (typeof translatorData.cache)[string]> = {};
		const fingerprintParts: string[] = [];
		for (const [id, r] of Object.entries(translatorData.cache)) {
			if (r.source !== "original") {
				persistCache[id] = r;
				// 指纹纳入影响落盘内容的关键字段（id/source/译文），捕捉内容变化
				fingerprintParts.push(id, r.source, r.translatedName, r.translatedDesc);
			}
		}
		// 其它字段用「计数 + 长度」近似指纹（避免全量 stringify）
		fingerprintParts.push(
			String(Object.keys(translatorData.aiDict).length),
			String(Object.keys(translatorData.pluginInsights).length),
			String(Object.keys(translatorData.compareInsights).length),
			String(translatorData.coverageSnapshots.length),
			translatorData.myMemoryBlockedDate ?? "",
			String(this.seenPluginIds.size),
			String(this.lastListFetchAt),
		);
		// PERF-5：内容与上次落盘一致则跳过序列化+写盘（防抖只合并频率，不降单次成本）
		const fingerprint = contentHash(fingerprintParts);
		if (fingerprint === this._lastTranslatorFingerprint) return;
		await this.storage.saveTranslatorCache({
			cache: persistCache,
			aiDict: translatorData.aiDict,
			pluginInsights: translatorData.pluginInsights,
			compareInsights: translatorData.compareInsights,
			coverageSnapshots: translatorData.coverageSnapshots,
			myMemoryBlockedDate: translatorData.myMemoryBlockedDate ?? "",
			seenPluginIds: Array.from(this.seenPluginIds),
			lastListFetchAt: this.lastListFetchAt,
		});
		// 仅写盘成功后更新指纹（失败则下次仍会重试写盘）
		this._lastTranslatorFingerprint = fingerprint;
	}

	/**
	 * 保存翻译缓存数据（带 800ms 防抖）。
	 * 数据加载阶段会被连续调用 12+ 次，防抖合并为一次 I/O。
	 */
	saveTranslatorData() {
		if (this._saveTranslatorDataTimer) window.clearTimeout(this._saveTranslatorDataTimer);
		this._saveTranslatorDataTimer = window.setTimeout(() => {
			this._saveTranslatorDataTimer = null;
			void this._saveTranslatorDataImmediate();
		}, 800);
	}

	/** 立即落盘翻译缓存（关闭插件或关键节点时调用） */
	async flushTranslatorData() {
		if (this._saveTranslatorDataTimer) {
			window.clearTimeout(this._saveTranslatorDataTimer);
			this._saveTranslatorDataTimer = null;
		}
		await this._saveTranslatorDataImmediate();
	}

	/** 清除已采纳（approved）TM：同时删除索引与对应 vault 笔记 */
	async clearApprovedTM() {
		const t = makeT();
		const ids = Object.keys(this.translator.tmApproved);
		if (ids.length === 0) {
			new Notice(t("notice.tmNoApproved"));
			return;
		}
		// 性能：分批并发删（与 seed 对称）
		const BATCH = 20;
		for (let i = 0; i < ids.length; i += BATCH) {
			await Promise.all(
				ids.slice(i, i + BATCH).map(async (id) => {
					await removeTMNote(this.noteStorage, id);
					this.translator.removeTMApproved(id);
				})
			);
		}
		await this.flushTranslatorData();
		new Notice(t("notice.tmCleared", { n: String(ids.length) }));
	}

	/**
	 * 把内存中变更的 TM 条目写盘到 vault 笔记（human 校正/反馈标记等同步来源）。
	 * 在 _saveTranslatorDataImmediate 中调用，覆盖所有 translator 保存路径。
	 * 注意：tm-review 弹窗的晋升与 seed/clear 命令已直接写/删 vault，不依赖此机制。
	 */
	private async flushTMVault(): Promise<void> {
		// 写成功才从脏标记清除：若 vault 写入因锁定/卸载竞态失败，标记保留到下次 flush 重试，
		// 避免「脏标记已清空但笔记未落盘」导致的人工校正/flagged 标记静默丢失（T2/#2）。
		// 并发批量写盘（BATCH=20）：晋升/校正大批量时提速数倍；writeTMNote 的 createFolder
		// 已有并发竞态容错（translation-memory.ts 注释），worker 内独立 try/catch 保证单条失败不中断池。
		const dirty = this.translator.peekTMDirty();
		await mapWithConcurrency(dirty, 20, async (id) => {
			const e = this.translator.tmApproved[id];
			if (!e) {
				this.translator.clearTMDirty(id);
				return;
			}
			try {
				await writeTMNote(this.noteStorage, e);
				this.translator.clearTMDirty(id);
			} catch (err: unknown) {
				logger.warn("[Chinese Plugin Market] 写入 TM 笔记失败，已保留待重试：", id, err);
			}
		});
		const removed = this.translator.peekTMRemoved();
		await mapWithConcurrency(removed, 20, async (id) => {
			try {
				await removeTMNote(this.noteStorage, id);
				this.translator.clearTMRemoved(id);
			} catch (err: unknown) {
				logger.warn("[Chinese Plugin Market] 删除 TM 笔记失败，已保留待重试：", id, err);
			}
		});
	}

	/**
	 * 收集 TM 文件夹下的 markdown 文件。
	 *
	 * 只遍历目标文件夹的「子树」（`TFolder.children`），不调用 vault.getFiles /
	 * getMarkdownFiles 等会枚举整个 vault 的 API——避免 Vault Enumeration 权限审查告警。
	 *
	 * 路径先经 normalizePath 规范化（处理中文/分隔符编码），绝大多数环境可命中文件夹对象；
	 * 仅在极端环境下 getAbstractFileByPath 仍返回 null 时返回空集合，此时 TM 笔记发现改由
	 * vault 的 create 事件增量捕获（见 registerTMVaultEvents），不回退到全 vault 枚举。
	 */
	private collectTMFiles(folder: string): TFile[] {
		const normalized = this.app.vault.getAbstractFileByPath(normalizePath(folder));
		if (normalized instanceof TFolder) {
			return this.collectMarkdownRecursive(normalized);
		}
		return [];
	}

	/** 递归收集 TFolder 下的所有 markdown 文件（按路径后缀判断，兼容 TFile 无 extension 的环境） */
	private collectMarkdownRecursive(folder: TFolder): TFile[] {
		const out: TFile[] = [];
		for (const child of folder.children) {
			if (child instanceof TFile) {
				if (child.path.endsWith(".md")) out.push(child);
			} else if (child instanceof TFolder) {
				out.push(...this.collectMarkdownRecursive(child));
			}
		}
		return out;
	}

	/**
	 * 启动双向回灌：把「插件翻译记忆库/」里 status=approved 的笔记解析回 tmApproved 索引。
	 * vault 笔记是权威，用户手编更新以笔记为准覆盖内存索引。
	 *
	 * 性能：快照 + 增量。
	 * - 首次（无快照）：全量扫描并落盘快照（含每条笔记的 mtime 与解析结果）。
	 * - 之后启动：先同步灌入快照（毫秒级、零文件 IO），再只核对「mtime 变化 / 新增 / 删除」
	 *   的少量笔记，未变的 6372 条直接信任快照，避免每次 reload 都重扫全 vault。
	 */
		private async scanVaultTM(): Promise<void> {
		const folder = TM_FOLDER; // "插件翻译记忆库"（vault 根相对路径）
		// 只遍历 TM 文件夹子树（collectTMFiles 内部用 getAbstractFileByPath + 子树遍历，
		// 不调用 vault.getFiles/getMarkdownFiles 等枚举全 vault 的 API，避免 Vault Enumeration）。
		// 若极端环境下取不到文件夹对象，返回空集合；运行期新增/手编的 TM 笔记由
		// registerTMVaultEvents 的 create/delete 事件增量捕获，无需枚举全 vault。
		const files = this.collectTMFiles(folder);
		// 进度：准备阶段（即使空文件夹也标记 done，避免加载页永远停在旧文案）
		this.tmProgress = { phase: "resolving", current: 0, total: files.length };
		if (files.length === 0) {
			this.tmProgress = { phase: "done", current: 0, total: 0 };
			return;
		}

		// ── 快速路径：同步灌入上次快照 ──
		const snapshot = await this.loadTMApprovedSnapshot();
		if (snapshot) {
			for (const id of Object.keys(snapshot.entries)) {
				this.translator.tmApproved[id] = snapshot.entries[id];
			}
			// 用快照记录的 path→id 映射初始化，供本次删除检测与写回快照使用
			this._lastTMIdsByPath = { ...snapshot.idsByPath };
		} else {
			this._lastTMIdsByPath = {};
		}
		this.tmProgress = { phase: "scanning", current: 0, total: files.length };

		// ── 增量核对：只处理变化的文件 ──
		const snapMtimes = snapshot?.mtimes ?? {};
		const pending: TFile[] = [];
		let unchangedCount = 0;
		for (const f of files) {
			const prev = snapMtimes[f.path];
			if (prev !== undefined && prev === f.stat?.mtime) {
				// mtime 未变：信任快照，跳过（占绝大多数）
				unchangedCount++;
			} else {
				pending.push(f); // 新增 / 修改 → 需重扫
			}
		}
		// 删除检测：快照里记录过、但当前文件列表已不存在的笔记 → 从 tmApproved 移除
		if (snapshot) {
			const currentPaths = new Set(files.map((f) => f.path));
			for (const p of Object.keys(snapMtimes)) {
				if (!currentPaths.has(p)) {
					const id = snapshot.idsByPath[p];
					if (id) delete this.translator.tmApproved[id];
				}
			}
		}

		// 快照已同步灌入 tmApproved，首屏译名已可用 → 立即解锁视图，避免重扫/写快照
		// 的大 IO 阻塞首屏（曾导致加载页停留很久）。增量重扫若有变化则放后台执行，
		// 完成后自动写回快照；首屏用已灌入的译名即可，不等待后台结果。
		this.tmProgress = { phase: "done", current: files.length, total: files.length };
		if (pending.length > 0) {
			const rescan = this.runIncrementalRescan(pending, snapMtimes, snapshot);
			if (snapshot) {
				// 有快照：译名已灌入 tmApproved，重扫放后台，不阻塞首屏（避免加载页久留）
				void rescan
					.catch((e) =>
						logger.error("[Chinese Plugin Market] TM 增量重扫失败（不影响已灌入译名）：", e),
					);
			} else {
				// 首次无快照：必须同步等重扫完成，否则 tmApproved 为空（无兜底译名）
				await rescan;
			}
		}
		logger.debug(`[Chinese Plugin Market] TM 快速路径：信任快照跳过 ${unchangedCount} 个未变文件`);
		return;
	}

	/**
	 * 后台增量重扫变化文件并更新快照（不阻塞首屏 tmApprovedReady）。
	 * 仅处理 mtime 变化/新增/删除的少量笔记；未变的信任快照。
	 */
	private async runIncrementalRescan(
		pending: TFile[],
		snapMtimes: Record<string, number>,
		snapshot: { version: 1; mtimes: Record<string, number>; idsByPath: Record<string, string>; entries: Record<string, TMEntry> } | null,
	): Promise<void> {
		// 若变化较多（metadataCache 可能尚未就绪），先短等让多数走内存路径
		const snapCount = snapshot ? Object.keys(snapshot.mtimes).length : 0;
		if (pending.length > snapCount * 0.1 || pending.length > 600) {
			await this.waitMetadataResolved(1500);
		}
		this.tmProgress = { phase: "indexing", current: 0, total: pending.length };
		const BATCH = 200; // 提高并发批次，加快回退读盘
		const newMtimes: Record<string, number> = { ...snapMtimes };
		let diskReads = 0;
		for (let i = 0; i < pending.length; i += BATCH) {
			const batch = pending.slice(i, i + BATCH);
			await Promise.all(
				batch.map(async (f) => {
					// 优先内存路径（metadataCache 多半已就绪）；否则回退 cachedRead
					const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
					let e: TMEntry | null = null;
					if (fm && fm.id) {
						if (fm.status !== "approved") {
							newMtimes[f.path] = f.stat?.mtime ?? 0;
							delete this._lastTMIdsByPath[f.path];
							return;
						}
						e = this.entryFromFrontmatter(fm);
					} else {
						diskReads++;
						e = parseTMNote(await this.app.vault.cachedRead(f));
					}
					newMtimes[f.path] = f.stat?.mtime ?? 0;
					if (e && e.id) {
						this._lastTMIdsByPath[f.path] = e.id;
					}
					if (e && e.status === "approved") {
						// vault 笔记权威：以笔记为准覆盖内存索引（用户手编更新）
						this.translator.tmApproved[e.id] = e;
					} else if (e && e.status !== "approved") {
						// 状态变化（如改为 suggested）：从已采纳层移除
						delete this.translator.tmApproved[e.id];
					}
				})
			);
			this.tmProgress = {
				phase: "indexing",
				current: Math.min(i + batch.length, pending.length),
				total: pending.length,
			};
		}

		logger.debug(
			`[Chinese Plugin Market] TM 增量重扫：回退读盘 ${diskReads} 篇、待处理 ${pending.length} 篇`
		);

		// 落盘新快照（后台，不阻塞首屏）
		await this.saveTMApprovedSnapshot(newMtimes);
	}

	/** 从 frontmatter 构造 TMEntry（复用回灌解析逻辑） */
	private entryFromFrontmatter(fm: Record<string, unknown>): TMEntry | null {
		// 脏 frontmatter 防护：缺 id 时 fm.id 为 undefined，String(undefined)==="undefined"
		// 会绕过空值判断污染 tmApproved 索引（语义召回/去重失真，#27）。
		// 必须是非空字符串，非法值直接丢弃。
		const rawId = fm.id;
		if (typeof rawId !== "string" || !rawId.trim()) return null;
		const id = rawId.trim();
		return {
			id,
			name: String(fm.name ?? id),
			description: String(fm.description ?? ""),
			source: (fm.source as TMEntry["source"]) ?? "human",
			status: (fm.status as TMEntry["status"]) ?? "approved",
			confidence: Number(fm.confidence) || 0,
			created: Number(fm.created) || Date.now(),
			promoted: fm.promoted ? Number(fm.promoted) : undefined,
			flagged: fm.flagged === true || fm.flagged === "true",
		};
	}

	/** TM 已采纳快照（基线）：path→mtime 映射 + 解析结果，热启动免重扫全 vault */
	private get tmSnapshotFilePath(): string {
		const id = this.manifest?.id ?? "chinese-plugin-market";
		return `.obsidian/plugins/${id}/tm-approved-snapshot.json`;
	}
	/** TM 已采纳快照（增量）：仅记录自基线以来的少量变化，避免每次整库序列化 6372 条 */
	private get tmDeltaFilePath(): string {
		const id = this.manifest?.id ?? "chinese-plugin-market";
		return `.obsidian/plugins/${id}/tm-approved-delta.json`;
	}
	/** 已载入的基线 entries/mtimes/idsByPath，供增量落盘时计算 diff（无需再次读盘） */
	private _snapshotBaselineEntries: Record<string, TMEntry> | null = null;
	private _snapshotBaselineMtimes: Record<string, number> | null = null;
	private _snapshotBaselineIdsByPath: Record<string, string> | null = null;

	private async loadTMApprovedSnapshot(): Promise<{
		version: 1;
		mtimes: Record<string, number>;
		idsByPath: Record<string, string>;
		entries: Record<string, TMEntry>;
	} | null> {
		try {
			const baseline = await this.loadTMBaseline();
			if (!baseline) return null;
			// 缓存基线供落盘 diff 使用
			this._snapshotBaselineEntries = baseline.entries;
			this._snapshotBaselineMtimes = baseline.mtimes;
			this._snapshotBaselineIdsByPath = baseline.idsByPath;
			// 合并增量 delta（若有），得到完整快照
			const delta = await this.loadTMDelta();
			const entries = { ...baseline.entries };
			const mtimes = { ...baseline.mtimes };
			const idsByPath = { ...baseline.idsByPath };
			if (delta) {
				for (const k of Object.keys(delta.mtimesPatch)) mtimes[k] = delta.mtimesPatch[k];
				for (const k of Object.keys(delta.idsByPathPatch)) {
					if (delta.idsByPathPatch[k]) idsByPath[k] = delta.idsByPathPatch[k];
					else delete idsByPath[k];
				}
				for (const k of Object.keys(delta.entriesPatch)) entries[k] = delta.entriesPatch[k];
				for (const id of delta.removed) delete entries[id];
			}
			return { version: 1, mtimes, idsByPath, entries };
		} catch (e: unknown) {
			logger.warn("[Chinese Plugin Market] 读取 TM 快照失败，将全量重扫：", e);
			return null;
		}
	}

	private async loadTMBaseline(): Promise<{
		version: 1;
		mtimes: Record<string, number>;
		idsByPath: Record<string, string>;
		entries: Record<string, TMEntry>;
	} | null> {
		try {
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(this.tmSnapshotFilePath))) return null;
			const raw = await adapter.read(this.tmSnapshotFilePath);
			const data = JSON.parse(raw) as {
				version: 1;
				mtimes: Record<string, number>;
				idsByPath: Record<string, string>;
				entries: Record<string, TMEntry>;
			} | null;
			if (data?.version !== 1 || !data.entries) return null;
			return data;
		} catch {
			return null;
		}
	}

	private async loadTMDelta(): Promise<{
		mtimesPatch: Record<string, number>;
		idsByPathPatch: Record<string, string | null>;
		entriesPatch: Record<string, TMEntry>;
		removed: string[];
	} | null> {
		try {
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(this.tmDeltaFilePath))) return null;
			const raw = await adapter.read(this.tmDeltaFilePath);
			const data = JSON.parse(raw) as {
				mtimesPatch?: Record<string, number>;
				idsByPathPatch?: Record<string, string | null>;
				entriesPatch?: Record<string, TMEntry>;
				removed?: string[];
			} | null;
			if (!data || typeof data !== "object") return null;
			return {
				mtimesPatch: data.mtimesPatch ?? {},
				idsByPathPatch: data.idsByPathPatch ?? {},
				entriesPatch: data.entriesPatch ?? {},
				removed: data.removed ?? [],
			};
		} catch {
			return null;
		}
	}

	/**
	 * 增量落盘 TM 快照：
	 * - 无基线（首次/快照损坏）→ 写整库基线，清 delta。
	 * - 有基线 → 仅计算与基线的 diff，写出极小 delta 文件（变化的 entries/mtimes/idsByPath + 删除的 id），
	 *   不再整库序列化 6372 条 entries。delta 累积到阈值时折叠回基线（仍整库写，但极少触发）。
	 */
	private async saveTMApprovedSnapshot(mtimes: Record<string, number>): Promise<void> {
		try {
			const adapter = this.app?.vault?.adapter;
			// 插件已卸载（后台重扫在测试 teardown 后回调）时静默跳过，不告警
			if (!adapter || !this.translator) return;
			const entries = this.translator.tmApproved;
			const idsByPath = this._lastTMIdsByPath;
			if (!this._snapshotBaselineEntries || !this._snapshotBaselineMtimes) {
				// 首次：写整库基线并清空 delta
				await adapter.write(
					this.tmSnapshotFilePath,
					JSON.stringify({ version: 1, mtimes, idsByPath, entries })
				);
				await adapter.remove(this.tmDeltaFilePath).catch(() => {});
				// 深拷贝切断与实时 tmApproved 的引用共享：否则后续 mutate tmApproved
				// 会同步污染 baseline，使增量 diff 的 entriesPatch 恒为空、delta 机制失效。
				this._snapshotBaselineEntries = JSON.parse(JSON.stringify(entries)) as Record<string, TMEntry>;
				this._snapshotBaselineMtimes = { ...mtimes };
				this._snapshotBaselineIdsByPath = { ...idsByPath };
				return;
			}
			// 增量：计算与基线的 diff
			const baseEntries = this._snapshotBaselineEntries;
			const baseMtimes = this._snapshotBaselineMtimes;
			const baseIds = this._snapshotBaselineIdsByPath ?? {};
			const mtimesPatch: Record<string, number> = {};
			const idsByPathPatch: Record<string, string | null> = {};
			const entriesPatch: Record<string, TMEntry> = {};
			const removed: string[] = [];
			for (const k of Object.keys(mtimes)) {
				if (baseMtimes[k] !== mtimes[k]) mtimesPatch[k] = mtimes[k];
			}
			for (const k of Object.keys(idsByPath)) {
				if (baseIds[k] !== idsByPath[k]) idsByPathPatch[k] = idsByPath[k] ?? null;
			}
			for (const id of Object.keys(entries)) {
				// 内容比对（非引用比对）：避免条目被克隆后误判为变化而写入冗余 delta
				if (JSON.stringify(baseEntries[id]) !== JSON.stringify(entries[id])) {
					entriesPatch[id] = entries[id];
				}
			}
			for (const id of Object.keys(baseEntries)) {
				if (!(id in entries)) removed.push(id);
			}
			const deltaSize = Object.keys(mtimesPatch).length + Object.keys(idsByPathPatch).length +
				Object.keys(entriesPatch).length + removed.length;
			// 折叠阈值：delta 累积过大时重写基线并清空 delta（真实场景 6372 条，少量变动远不到此阈值）
			if (deltaSize > 2000) {
				await adapter.write(
					this.tmSnapshotFilePath,
					JSON.stringify({ version: 1, mtimes, idsByPath, entries })
				);
				await adapter.remove(this.tmDeltaFilePath).catch(() => {});
				// 深拷贝切断与实时 tmApproved 的引用共享（同首次保存路径，避免 delta 失效）
				this._snapshotBaselineEntries = JSON.parse(JSON.stringify(entries)) as Record<string, TMEntry>;
				this._snapshotBaselineMtimes = { ...mtimes };
				this._snapshotBaselineIdsByPath = { ...idsByPath };
				return;
			}
			// 写出极小 delta
			await adapter.write(
				this.tmDeltaFilePath,
				JSON.stringify({ mtimesPatch, idsByPathPatch, entriesPatch, removed })
			);
		} catch (e: unknown) {
			logger.warn("[Chinese Plugin Market] 写入 TM 快照失败（不影响翻译，下次全量重扫）：", e);
		}
	}

	/** 最近一次 TM 扫描重建的 path→id 映射，供快照删除检测用 */
	private _lastTMIdsByPath: Record<string, string> = {};

	/** 等待 Obsidian 元数据缓存就绪；未就绪时 scanVaultTM 会退化成逐文件磁盘读（启动卡顿） */
	private waitMetadataResolved(timeoutMs = 2000): Promise<void> {
		const mc = this.app.metadataCache as unknown as {
			resolved?: boolean;
			on?: (e: string, cb: () => void) => void;
		};
		if (mc.resolved === true) return Promise.resolve();
		const on = mc.on;
		if (typeof on !== "function") return Promise.resolve();
		return new Promise((resolve) => {
			const timer = window.setTimeout(() => resolve(), timeoutMs);
			on.call(mc, "resolved", () => {
				window.clearTimeout(timer);
				resolve();
			});
		});
	}

	/** SQLite 向量库文件路径 */
	private get vectorStoreFilePath(): string {
		return `.obsidian/plugins/${this.manifest.id}/vector-index.sqlite`;
	}

	/** sql.js 的 WASM 运行时文件路径（随插件分发到插件目录） */
	private get sqlWasmFilePath(): string {
		return `.obsidian/plugins/${this.manifest.id}/sql-wasm.wasm`;
	}

	/** 旧版二进制索引路径（P3 格式，仅做一次性兼容读取迁移） */
	private get legacyVectorBinFilePath(): string {
		return `.obsidian/plugins/${this.manifest.id}/vector-index.bin`;
	}

	/** 旧版 JSON 索引路径（P3 之前格式，仅做一次性兼容读取迁移） */
	private get legacyVectorJsonFilePath(): string {
		return `.obsidian/plugins/${this.manifest.id}/vector-index.json`;
	}

	// ── 插件统计 / 趋势 / 列表缓存读写已抽离至 PluginStorage（plugin-storage.ts）──

	/** 初始化 SQLite 向量库（懒加载 sql-wasm，失败则禁用并降级重建）。 */
	private async ensureVectorStore(): Promise<SqliteVectorStore | null> {
		if (this.vectorStore) return this.vectorStore;
		if (this.vectorStoreInitFailed) return null; // 已失败过：本会话不再重试/刷屏
		const tEnsureVec = Date.now();
		const tWasmLoad = Date.now();
		try {
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(this.sqlWasmFilePath))) {
				this.vectorStoreInitFailed = true;
				logger.debug(`[Chinese Plugin Market] ensureVectorStore 总耗时 ${Date.now() - tEnsureVec}ms`);
				logger.warn(
					"[Chinese Plugin Market] SQLite WASM 缺失（sql-wasm.wasm 未随插件分发），向量库禁用，回退内存索引。"
				);
				return null;
			}
			// 用 Obsidian adapter 读 wasm 字节（app:// 下无法直接 fetch 本地文件，绕开 CORS）
			const wasmBuf = await adapter.readBinary(this.sqlWasmFilePath);
			const wasm = new Uint8Array(wasmBuf);
			logger.debug(`[Chinese Plugin Market] 探针：wasm 字节读取 ${wasm.length}B，耗时 ${Date.now() - tWasmLoad}ms`);
			// Obsidian 沙箱可能无法 `import("sql.js")`（CJS 包无 ESM 导出）。失败即降级，
			// 不阻塞主功能；本会话不再重试。
			const tInit = Date.now();
			const sqlMod = await import("sql.js");
			const sql = await initSqlJsStatic(wasm, sqlMod);
			logger.debug(`[Chinese Plugin Market] 探针：initSqlJs 实例化耗时 ${Date.now() - tInit}ms`);
			const persist: PersistAdapter = {
				exists: (p) => adapter.exists(p),
				read: async (p) => new Uint8Array(await adapter.readBinary(p)),
				write: async (p, bytes) => {
					const ab = new ArrayBuffer(bytes.byteLength);
					new Uint8Array(ab).set(bytes);
					await adapter.writeBinary(p, ab);
				},
			};
			const tOpen = Date.now();
			this.vectorStore = await SqliteVectorStore.open(persist, this.vectorStoreFilePath, sql);
			logger.debug(`[Chinese Plugin Market] 探针：SqliteVectorStore.open（读库+建表）耗时 ${Date.now() - tOpen}ms`);
			logger.debug(`[Chinese Plugin Market] ensureVectorStore 总耗时 ${Date.now() - tEnsureVec}ms`);
			return this.vectorStore;
		} catch (e: unknown) {
			this.vectorStoreInitFailed = true;
			// 明确提示这是沙箱/打包限制（不是同步遗漏），且只提示一次
			logger.warn(
				"[Chinese Plugin Market] 初始化 SQLite 向量库失败，回退内存索引（本地语义搜索将降级；" +
					"这是 Obsidian 沙箱无法加载 sql.js 所致，非同步遗漏）：",
				(e as Error)?.message || e
			);
			this.vectorStore = null;
			return null;
		}
	}

	/**
	 * 查询本地向量能力就绪状态（供设置页提示）：
	 *   sqlWasm: sql-wasm.wasm 是否随插件分发
	 *   sqliteReady: SQLite 向量库是否已成功初始化
	 *   transformReady: 本地 embedding 运行时（@huggingface/transformers）是否可加载
	 */
	async getLocalVectorStatus(): Promise<{ sqlWasm: boolean; sqliteReady: boolean; transformReady: boolean }> {
		const adapter = this.app.vault.adapter;
		let sqlWasm = false;
		try {
			sqlWasm = await adapter.exists(this.sqlWasmFilePath);
		} catch {
			sqlWasm = false;
		}
		const store = await this.ensureVectorStore();
		// transformers 已打包进 main.js（A 阶段），本地 embedding 能力恒定可用；
		// transformReady 反映「本地模型是否已成功预热」（localWarmupDone 且未失败）
		return { sqlWasm, sqliteReady: !!store, transformReady: this.localWarmupDone };
	}

	/** 本地 embedding worker 是否已预热（避免重复预热）。 */
	private localWarmupDone = false;

	/**
	 * 预热本地 embedding worker（对齐 vault-curate 的 warmup）：
	 * 提前启动 worker + 加载 bge 模型，让首次本地语义搜索免于冷启动等待。
	 * 后台 fire-and-forget，失败静默；幂等（同会话只预热一次）。
	 */
	warmupLocalEmbedding(): void {
		if (this.localWarmupDone) return;
		this.localWarmupDone = true;
		const model = this.settings.embeddingLocalModel || DEFAULT_LOCAL_MODEL;
		void (async () => {
			try {
				// getShared 复用：与搜索共用同一 worker，预热后搜索直接命中
				const provider = new LocalEmbeddingProvider(undefined, model, this.settings.embeddingLocalWasmPaths || undefined);
				await provider.warmup();
				logger.debug("[Chinese Plugin Market] 本地 embedding 已预热（worker + 模型就绪）");
			} catch (e: unknown) {
				// 预热失败：重置标记，允许下次再试（不永久禁用）
				this.localWarmupDone = false;
				logger.debug("[Chinese Plugin Market] 本地 embedding 预热跳过：", (e as Error)?.message || e);
			}
		})();
	}

	/** 获取当前视图已加载的插件列表（视图未打开 / 数据未就绪时返回空）。 */
	private getViewPlugins(): PluginInfo[] {
		try {
			const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
			for (const leaf of leaves) {
				const view = leaf.view as ChinesePluginMarketView | null;
				if (view && view.plugins.length > 0) return view.plugins;
			}
		} catch {
			/* ignore */
		}
		return [];
	}

	/**
	 * 后台预建本地向量索引（A+B：设置页手动 / 数据就绪后自动共用）。
	 *
	 * 用本地 bge 模型对当前插件列表 embed → 构建 VectorIndex（含分类注入）→
	 * 写入 SQLite。已构建则直接返回（幂等）。正在构建时并发调用复用同一次。
	 * 进度写到 this.localIndexState，供设置页/视图轮询展示。
	 */
	async buildLocalIndex(force = false): Promise<void> {
		// 并发去重：复用同一次构建的 Promise，让重复调用等待结果而非直接 return（#26）
		if (this.localIndexState.status === "building" && this.buildLocalIndexPromise) {
			return this.buildLocalIndexPromise;
		}
		const plugins = this.getViewPlugins();
		if (plugins.length === 0) {
			// 无插件数据：保持 idle（不设 error 以免反复提示），仅在控制台提示一次
			if (this.localIndexState.status !== "done") {
				this.localIndexState = { status: "idle", progress: 0, total: 0 };
			}
			logger.warn("[Chinese Plugin Market] 预建本地索引：暂无插件数据（需先打开插件市场视图加载列表）。");
			return;
		}
		if (!force && this.translator.getVectorIndex()?.ids.length === plugins.length) return; // 幂等

		const total = plugins.length;
		let doneCount = 0; // 真实已 embed 计数（增量构建时为增量条目数，分母对齐 total）
		const model = this.settings.embeddingLocalModel || DEFAULT_LOCAL_MODEL;
		this.localIndexState = { status: "building", progress: 0, total };
		const done = (s: "done" | "error", error?: string) => {
			this.localIndexState = {
				status: s,
				progress: total,
				total,
				message: s === "done" ? "本地向量索引构建完成" : undefined,
				error,
			};
		};

		const run = async (): Promise<void> => {
		try {
			const base = new LocalEmbeddingProvider(undefined, model, this.settings.embeddingLocalWasmPaths || undefined);
			// 时间片渐进构建（对齐 vault-curate 的 buildBM25Sliced）：每批 embed 后
			// yield 一次主线程，让 UI 能重绘并实时显示进度，避免一次性大任务冻结界面。
			const BATCH = 32;
			const YIELD_EVERY = 2; // 每 N 批 yield 一次，减少频繁调度开销
			const provider: EmbeddingProvider = {
				name: "local-progress",
				embed: async (texts) => {
					const out: number[][] = [];
					for (let i = 0; i < texts.length; i += BATCH) {
						const chunk = texts.slice(i, i + BATCH);
						const vecs = await base.embed(chunk);
						out.push(...vecs);
						doneCount += chunk.length;
						this.localIndexState.progress = Math.min(total, doneCount);
						// 时间片让位：批量推进时 UI 保持响应、进度实时刷新
						if ((i / BATCH) % YIELD_EVERY === 0) {
							await new Promise<void>((r) => window.setTimeout(r, 0));
						}
					}
					return out;
				},
			};

			const indexPlugins: IndexPlugin[] = plugins.map((p) => {
				const tag = this.translator.getAllPluginTags()[p.id];
				return { id: p.id, name: p.name, description: p.description, category: tag?.category, tags: tag?.tags };
			});
			// categorySchemaVersion 必须与 vectorRecallScores 的 needBuild 判断一致
			// （用 tagService.getSchemaVersion()），否则每次搜索都因版本不匹配而全量重建索引 → 慢。
			const schemaVer = this.translator.getCategorySchemaVersion();
			// 把当前索引作为 prevIndex 传入，启用增量 embed（只 embed 新增/内容变化的 id，
			// 未变的复用旧向量），与 saveVectorIndex 的增量写盘配合，避免每次全量重建。
			const index = await buildVectorIndex(provider, indexPlugins, model, this.translator.getVectorIndex(), schemaVer);
			this.translator.setVectorIndex(index);
			await this.saveVectorIndex();
			done("done");
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			logger.warn("[Chinese Plugin Market] 预建本地向量索引失败：", e);
			done("error", msg);
		} finally {
			this.buildLocalIndexPromise = null;
		}
		};
		this.buildLocalIndexPromise = run();
		return this.buildLocalIndexPromise;
	}

	/** 从旧版文件（.bin / .json）读取 VectorIndex，用于一次性迁移到 SQLite。 */
	private async loadLegacyVectorIndex(): Promise<import("@semantic/embedding").VectorIndex | null> {
		const adapter = this.app.vault.adapter;
		try {
			if (await adapter.exists(this.legacyVectorBinFilePath)) {
				const buf = await adapter.readBinary(this.legacyVectorBinFilePath);
				const { decodeVectorIndex } = await import("@semantic/vec-codec");
				return decodeVectorIndex(buf);
			}
			if (await adapter.exists(this.legacyVectorJsonFilePath)) {
				const parsed = JSON.parse(await adapter.read(this.legacyVectorJsonFilePath)) as import("@semantic/embedding").VectorIndex;
				if (parsed && Array.isArray(parsed.ids) && Array.isArray(parsed.vectors)) {
					return parsed;
				}
			}
		} catch (e: unknown) {
			logger.warn("[Chinese Plugin Market] 读取旧版向量索引失败，将重建：", e);
		}
		return null;
	}

	async loadVectorIndex() {
		const tLoadVec = Date.now();
		try {
			const store = await this.ensureVectorStore();
			if (store) {
				const vecs = store.getAllVecs();
				logger.debug(`[Chinese Plugin Market] loadVectorIndex 反量化 ${vecs.size} 条向量`);
				if (vecs.size > 0) {
					const ids = Array.from(vecs.keys());
					// 直接复用 Float32Array，不再 Array.from 转 number[]（消除二次转换，节省 6000×512 次分配）
					// 量化仿射映射非保范：反量化后模长偏离 1，召回侧 topKBySimilarity 假定
					// norm=1 做纯点积（余弦≈dot）。此处加载时归一化一次，保证召回打分正确（#28）
					const vectors = ids.map((id) => {
						const v = vecs.get(id)!;
						const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
						if (n === 0 || n === 1) return v; // 零向量原样返回；已是单位向量免拷贝
						const inv = 1 / n;
						return new Float32Array(v.length).map((_, i) => v[i] * inv);
					});
					const model = store.getMeta("model") || "";
					const hash = store.getMeta("hash") || "";
					let schema = store.getMeta("categorySchemaVersion") || undefined;
					// 旧脏值校正：早期 buildLocalIndex 误存了 "local"，与 needBuild 判断的
					// tagService.getSchemaVersion() 不一致，导致每次搜索全量重建索引 → 慢。
					// 向量实际是 bge 建的，分类 schema 标记对齐当前即可，无需重建。
					if (schema === "local") {
						schema = this.translator.getCategorySchemaVersion();
					}
					// 恢复每条内容指纹（增量更新依据），缺失则下次全量重建
					let perIdHash: Record<string, string> | undefined;
					const rawHash = store.getMeta("perIdHash");
					if (rawHash) {
						try {
							perIdHash = JSON.parse(rawHash) as Record<string, string>;
						} catch {
							perIdHash = undefined;
						}
					}
					this.translator.setVectorIndex({ ids, vectors, hash, model, categorySchemaVersion: schema, perIdHash });
					return;
				}
				// 空库：尝试从旧版文件一次性迁移
				const legacy = await this.loadLegacyVectorIndex();
				if (legacy && legacy.ids.length > 0) {
					this.translator.setVectorIndex(legacy);
					await this.saveVectorIndex(); // 迁移进 SQLite
				} else {
					this.translator.setVectorIndex(null);
				}
				return;
			}
			// SQLite 不可用：退化为旧版内存索引
			const legacy = await this.loadLegacyVectorIndex();
			this.translator.setVectorIndex(legacy);
		} catch (e: unknown) {
			logger.warn("[Chinese Plugin Market] 加载向量索引失败，将重建：", e);
			this.translator.setVectorIndex(null);
		} finally {
			logger.debug(`[Chinese Plugin Market] loadVectorIndex 总耗时 ${Date.now() - tLoadVec}ms`);
		}
	}

	async saveVectorIndex() {
		const index = this.translator.getVectorIndex();
		if (!index || index.ids.length === 0) return; // 无索引不写盘
		try {
			const store = await this.ensureVectorStore();
			if (!store) return; // SQLite 不可用，放弃持久化（搜索功能不受影响）
			const tags = index.ids.map((id) => {
				const t = this.pluginTagMap.get(id);
				return t ? [t] : null;
			});

			// 增量写盘：比对旧 perIdHash，仅写「新增 / 内容指纹变化」的行，移除「已删除」的行。
			const oldRaw = store.getMeta("perIdHash");
			let oldHash: Record<string, string> | null = null;
			if (oldRaw) {
				try { oldHash = JSON.parse(oldRaw) as Record<string, string>; } catch { oldHash = null; }
			}
			const newHash = index.perIdHash ?? {};

			if (oldHash && Object.keys(oldHash).length > 0) {
				// 计算差异集合
				const changed: { id: string; vec: number[] | Float32Array; category?: string | null }[] = [];
				const seen = new Set<string>();
				for (let i = 0; i < index.ids.length; i++) {
					const id = index.ids[i];
					seen.add(id);
					if (oldHash[id] !== newHash[id]) {
						changed.push({ id, vec: index.vectors[i], category: tags[i]?.[0] });
					}
				}
				const removed = Object.keys(oldHash).filter((id) => !seen.has(id));
				if (changed.length > 0) store.upsertMany(changed);
				if (removed.length > 0) store.deleteMany(removed);
				// 完全无变化：changed 与 removed 皆空 → 零写盘，仅刷新 meta
			} else {
				// 首次 / 无旧指纹 / 空库：退化为全量重建
				store.replaceAll(
					index.ids.map((id, i) => ({ id, vec: index.vectors[i], category: tags[i]?.[0] }))
				);
			}

			store.setMeta("model", index.model);
			store.setMeta("hash", index.hash);
			if (index.categorySchemaVersion) store.setMeta("categorySchemaVersion", index.categorySchemaVersion);
			if (index.perIdHash) store.setMeta("perIdHash", JSON.stringify(index.perIdHash));
			await store.flush();
		} catch (e: unknown) {
			// 写盘失败不影响搜索功能，仅无法跨会话复用
			logger.warn("[Chinese Plugin Market] 保存向量索引失败：", e);
		}
	}

}