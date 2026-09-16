/**
 * 设置页 DOM 扫描机翻（第二通道）。
 *
 * 为什么需要第二通道：第一通道（settings-translator.ts）钩的是 Obsidian 原生
 * `Setting` / `ButtonComponent` / `DropdownComponent` / `TextComponent` 的原型方法，
 * 只覆盖用 `new Setting(containerEl)` 搭出来的设置页。越来越多插件改用 React / Vue 自绘
 * 设置页 —— 典型如 Copilot：`CopilotSettingTab.display()` 里直接
 * `createPluginRoot(div).render(<SettingsMainV2 />)`，36 个自定义组件全程不碰原生
 * `Setting`，第一通道一个字符串都拦不到，这正是「Copilot 设置页还是英文」的根因。
 *
 * 本通道在 DOM 层兜底：观察设置面板内容容器，收集英文文本节点与
 * placeholder / title / aria-label，逐条送翻后原地改写。
 *
 * 关键约束：
 * - 只改文本，不动结构：只写 nodeValue / attribute，绝不碰 innerHTML / outerHTML，
 *   既避免 XSS，也不破坏 React 的 DOM 结构（React 依赖节点身份做 diff）。
 * - 防自激 + 防回退：写入会触发 characterData mutation。用 WeakMap 记「原文→译文」，
 *   回调识别自己的写入并忽略；若发现框架重渲染把文案打回原文，则把译文贴回去。
 * - 快：文案按 MAX_BLOCK_ITEMS 条 / MAX_BLOCK_CHARS 字符切成块，一块一次请求（免费通道保留
 *   换行行数，实测 20 条 ≈ 1.4s，而逐条「detect + translate」要 9s），块级并发 + 每块译完即
 *   写入，用户看到的是从上到下快速刷出中文，而不是等全部翻完一次性跳变。
 * - 限流：单轮最多 MAX_TEXTS_PER_SCAN 条、并发 BLOCK_CONCURRENCY 个块，翻不完的下一轮继续，
 *   避免首屏几百条瞬时打爆免费通道。
 * - 幂等：译文含中文，下次扫描被 shouldSkip 拦下；翻译失败的串累计到 MAX_FAIL_RETRIES 后
 *   本会话不再重试（网络抖动可自愈，不会一抖就永久不翻；清空缓存时一并复位）。
 */

import { logger } from "@shared/logger";

/** 文本节点专用槽位名（属性槽位直接用属性名，两者共存于同一 Map） */
const TEXT_SLOT = "";
/** 单条文本长度下限：低于此值多为图标 / 单字符，翻译噪音大于收益 */
const MIN_TEXT_LEN = 2;
/** 单条文本长度上限：对齐免费通道单段 500 字上限；超长整段跳过，避免截断出半截译文 */
const MAX_TEXT_LEN = 500;
/** 单轮扫描收集的节点上限（防超大设置页卡住主线程） */
const MAX_NODES_PER_SCAN = 400;
/** 单轮最多送翻的唯一文本条数 */
const MAX_TEXTS_PER_SCAN = 300;
/** 单个批量块的条数上限（与下面的字符上限共同约束，先到先切） */
const MAX_BLOCK_ITEMS = 40;
/** 单个批量块的字符上限：实测 2000 字符仍严格保留行数，留 100 余量 */
const MAX_BLOCK_CHARS = 1900;
/** 批量块的并发数 */
const BLOCK_CONCURRENCY = 4;
/** mutation 合流 debounce（ms）：React 一次渲染会产生成百条 mutation */
const SCAN_DEBOUNCE_MS = 120;
/** 根容器轮询间隔（ms）：设置面板打开 / 切 Tab 后才拿得到容器 */
const ROOT_POLL_MS = 250;
/** 同一条文本最多重试次数：网络抖动仍可自愈，连败到上限后本会话不再打扰 */
const MAX_FAIL_RETRIES = 3;
/** 失败表上限，超出整体清空（避免长期运行无限增长） */
const FAILED_CAP = 1000;
/** 不参与翻译的元素标签（代码 / 用户输入 / 样式脚本 / 矢量图标 / 公式） */
const EXCLUDED_TAGS = new Set([
	"SCRIPT",
	"STYLE",
	"NOSCRIPT",
	"CODE",
	"PRE",
	"TEXTAREA",
	"INPUT",
	"SVG",
	"MATH",
]);
/** 不参与翻译的子树（本插件注入物 / 可编辑区 / 代码编辑器） */
const EXCLUDED_SELECTOR =
	'svg, [contenteditable="true"], [data-cpm-owned], [data-cpm-no-translate], .cm-editor, .CodeMirror';
/** 需要翻译的属性（控件占位符与无障碍标签） */
const TRANSLATABLE_ATTRS = ["placeholder", "title", "aria-label"] as const;

export interface SettingsDomTranslatorDeps {
	/** 是否跳过该文本（中文 / 未启用 / 黑名单插件等，由上层统一判定） */
	shouldSkip: (text: string) => boolean;
	/** 翻译单条文本；失败或无译文返回 null（批量降级时用） */
	translate: (text: string) => Promise<string | null>;
	/**
	 * 批量翻译一整块文案，返回「原文 → 译文」（未译出的不出现在 Map 里）。
	 * 这是首屏速度的关键：一块一次请求，而非每条两次往返。
	 */
	translateBatch: (texts: string[]) => Promise<Map<string, string>>;
	/** 取当前应扫描的根元素（设置页内容容器）；取不到返回 null */
	getRoot: () => HTMLElement | null;
}

interface Candidate {
	node: Node;
	/** 文本节点为 TEXT_SLOT，元素为属性名 */
	slot: string;
	text: string;
}

interface SlotRecord {
	src: string;
	dst: string;
}

interface ScanOutcome {
	/** 本轮因超出上限而没翻的候选数 */
	remaining: number;
	/** 本轮成功写入的条数 */
	translated: number;
}

export class SettingsDomTranslator {
	private readonly deps: SettingsDomTranslatorDeps;
	private observer: MutationObserver | null = null;
	private root: HTMLElement | null = null;
	private rootTimer: number | null = null;
	private scanTimer: number | null = null;
	private scanning = false;
	/** 节点 → 槽位 → 已应用的「原文→译文」（防自激 / 防回退的凭据） */
	private readonly applied = new WeakMap<Node, Map<string, SlotRecord>>();
	/** 翻译失败的串 → 已尝试次数：连败到上限后不再每轮重试，避免死循环扫描 */
	private readonly failed = new Map<string, number>();

	constructor(deps: SettingsDomTranslatorDeps) {
		this.deps = deps;
	}

	/**
	 * 启动。设置面板未打开时拿不到容器，故常驻一个低频轮询：
	 * 拿到容器就挂载 observer 并立即扫一次（覆盖挂载前已渲染的 DOM）。
	 */
	start(): void {
		if (this.rootTimer !== null) return;
		this.syncRoot();
		this.rootTimer = window.setInterval(() => this.syncRoot(), ROOT_POLL_MS);
	}

	stop(): void {
		if (this.rootTimer !== null) {
			window.clearInterval(this.rootTimer);
			this.rootTimer = null;
		}
		if (this.scanTimer !== null) {
			window.clearTimeout(this.scanTimer);
			this.scanTimer = null;
		}
		this.detachObserver();
		this.failed.clear();
	}

	/** 清空「翻译失败」记忆（用户清空缓存后应允许重新尝试） */
	reset(): void {
		this.failed.clear();
	}

	/** 外部已知 DOM 变化时请求一次扫描（内部已合流防抖） */
	scheduleScan(): void {
		this.schedule(SCAN_DEBOUNCE_MS);
	}

	/** 立即扫描一次（启动后同步挂载完成即可调用；测试与显式触发用） */
	async scanNow(): Promise<void> {
		await this.runScan();
	}

	// ── 容器挂载 ──

	private syncRoot(): void {
		const next = this.deps.getRoot();
		if (next && next.isConnected) {
			if (next === this.root && this.observer) return;
			this.detachObserver();
			this.root = next;
			this.observer = new MutationObserver((records) => this.onMutations(records));
			this.observer.observe(next, { childList: true, subtree: true, characterData: true });
			// 挂载前可能已渲染完（React 同步 render），立刻补扫一次
			this.schedule(0);
			return;
		}
		// 容器失效（设置面板未打开 / 已销毁 / 切到别的 Tab）：等下次轮询重新挂载
		if (this.root) this.detachObserver();
	}

	private detachObserver(): void {
		this.observer?.disconnect();
		this.observer = null;
		this.root = null;
	}

	// ── 变更处理 ──

	private onMutations(records: MutationRecord[]): void {
		let needScan = false;
		for (const record of records) {
			if (record.type !== "characterData") {
				needScan = true;
				continue;
			}
			const node = record.target;
			if (node.nodeType !== Node.TEXT_NODE) {
				needScan = true;
				continue;
			}
			const rec = this.applied.get(node)?.get(TEXT_SLOT);
			if (!rec) {
				needScan = true;
				continue;
			}
			const now = node.nodeValue ?? "";
			if (now === rec.dst) continue; // 自己的写入 → 忽略，防自激
			if (now === rec.src) {
				node.nodeValue = rec.dst; // 框架重渲染把文案打回原文 → 贴回译文
				continue;
			}
			this.applied.get(node)?.delete(TEXT_SLOT); // 内容已被别处改写，作废记录下轮重扫
			needScan = true;
		}
		if (needScan) this.schedule(SCAN_DEBOUNCE_MS);
	}

	private schedule(delay: number): void {
		if (this.rootTimer === null) return; // 已 stop
		if (this.scanTimer !== null) return;
		this.scanTimer = window.setTimeout(() => {
			this.scanTimer = null;
			void this.runScan();
		}, delay);
	}

	private async runScan(): Promise<void> {
		if (this.rootTimer === null) return; // 已 stop
		// 容器可能刚就绪（设置面板刚打开 / 刚切 Tab）：先同步挂载再扫，
		// 否则要等下一次轮询才开工。
		if (!this.root || !this.root.isConnected) this.syncRoot();
		const root = this.root;
		if (!root || !root.isConnected || this.scanning) return;
		this.scanning = true;
		try {
			const outcome = await this.scanOnce(root);
			// 还有候选没翻完且本轮确有产出 → 续扫，避免停在「半翻译」状态
			if (outcome.remaining > 0 && outcome.translated > 0) this.schedule(SCAN_DEBOUNCE_MS);
		} catch (error) {
			logger.warn("[Chinese Plugin Market] 设置页 DOM 扫描翻译失败:", error);
		} finally {
			this.scanning = false;
		}
	}

	// ── 扫描与写入 ──

	private async scanOnce(root: HTMLElement): Promise<ScanOutcome> {
		const candidates = this.collect(root);
		if (candidates.length === 0) return { remaining: 0, translated: 0 };

		const groups = new Map<string, Candidate[]>();
		let remaining = 0;
		for (const c of candidates) {
			const group = groups.get(c.text);
			if (group) {
				group.push(c);
				continue;
			}
			if (groups.size >= MAX_TEXTS_PER_SCAN) {
				remaining++;
				continue;
			}
			groups.set(c.text, [c]);
		}

		return await this.translateGroups(groups, remaining);
	}

	/**
	 * 分块批量翻译 + 每块译完即写入（用户看到的是从上到下逐段刷出中文，而非最后一次性跳变）。
	 * 块内未译出的串降级逐条，仍失败才记入 failed。
	 */
	private async translateGroups(
		groups: Map<string, Candidate[]>,
		remaining: number,
	): Promise<ScanOutcome> {
		const blocks = this.chunk(Array.from(groups.keys()));
		let cursor = 0;
		let translated = 0;

		const write = (text: string, dst: string): void => {
			translated++;
			for (const c of groups.get(text) ?? []) this.apply(c, text, dst);
		};

		const worker = async (): Promise<void> => {
			while (cursor < blocks.length) {
				const index = cursor++;
				const block = blocks[index];
				if (!block || block.length === 0) continue;
				let results: Map<string, string>;
				try {
					results = await this.deps.translateBatch(block);
				} catch {
					results = new Map();
				}
				for (const text of block) {
					const dst = results.get(text);
					if (dst) write(text, dst);
				}
				// 块级批量没译出的（块请求失败 / 部分回显）→ 逐条兜底
				for (const text of block) {
					if (results.has(text)) continue;
					const dst = await this.fallbackOne(text);
					if (dst) write(text, dst);
				}
			}
		};

		const workers: Promise<void>[] = [];
		for (let i = 0; i < Math.min(BLOCK_CONCURRENCY, blocks.length); i++) workers.push(worker());
		await Promise.all(workers);
		return { remaining, translated };
	}

	/** 单条兜底翻译：失败累计，连败到上限后本会话不再重试 */
	private async fallbackOne(text: string): Promise<string | null> {
		try {
			const dst = await this.deps.translate(text);
			if (dst && dst !== text) return dst;
		} catch {
			// 忽略，统一走失败计数
		}
		this.rememberFailure(text);
		return null;
	}

	/**
	 * 把待翻文本切成块：一块一次请求。
	 * 含换行的串单独成块（会破坏「按行对齐」的还原依据，由批量实现自行降级逐条）。
	 */
	private chunk(texts: string[]): string[][] {
		const out: string[][] = [];
		let cur: string[] = [];
		let len = 0;
		for (const t of texts) {
			if (t.includes("\n")) {
				if (cur.length > 0) {
					out.push(cur);
					cur = [];
					len = 0;
				}
				out.push([t]);
				continue;
			}
			if (cur.length >= MAX_BLOCK_ITEMS || len + t.length + 1 > MAX_BLOCK_CHARS) {
				out.push(cur);
				cur = [];
				len = 0;
			}
			cur.push(t);
			len += t.length + 1;
		}
		if (cur.length > 0) out.push(cur);
		return out;
	}

	private collect(root: HTMLElement): Candidate[] {
		const out: Candidate[] = [];
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
		while (out.length < MAX_NODES_PER_SCAN && walker.nextNode()) {
			const node = walker.currentNode;
			if (node.nodeType === Node.TEXT_NODE) {
				const host = node.parentElement;
				if (!host || this.isApplied(node, TEXT_SLOT)) continue;
				const text = (node.nodeValue ?? "").trim();
				if (this.accept(text, host, TEXT_SLOT)) out.push({ node, slot: TEXT_SLOT, text });
				continue;
			}
			const el = node as HTMLElement;
			for (const attr of TRANSLATABLE_ATTRS) {
				const raw = el.getAttribute(attr);
				if (raw === null || this.isApplied(el, attr)) continue;
				const text = raw.trim();
				if (this.accept(text, el, attr)) out.push({ node: el, slot: attr, text });
			}
		}
		return out;
	}

	/** 文本是否值得送翻：过滤代码 / URL / 用户输入 / 已处理 / 上层判定跳过的串 */
	private accept(text: string, host: Element, slot: string): boolean {
		if (text.length < MIN_TEXT_LEN || text.length > MAX_TEXT_LEN) return false;
		if (!/[A-Za-z]/.test(text)) return false; // 无拉丁字母（纯数字 / 符号 / 中文）不翻
		if ((this.failed.get(text) ?? 0) >= MAX_FAIL_RETRIES) return false;
		// 无空格的长串多为 URL / 路径 / 变量名，译后反而不可读
		if (!/\s/.test(text) && text.length > 24) return false;
		if (/^https?:\/\//i.test(text)) return false;
		if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(text)) return false; // 域名
		// 路径（vault 文件夹 / 绝对路径）与全大写常量（API_KEY 之类）保持原文
		if (/[\\/]/.test(text) && !/\s/.test(text)) return false;
		if (/^[A-Z0-9_.-]+$/.test(text)) return false;
		if (host.closest(EXCLUDED_SELECTOR)) return false;
		// 文本节点：宿主是代码 / 输入控件 / 图标则不翻。
		// 属性槽位不受此限 —— input 的 placeholder 恰恰是要翻的目标。
		if (slot === TEXT_SLOT && EXCLUDED_TAGS.has(host.tagName.toUpperCase())) return false;
		return !this.deps.shouldSkip(text);
	}

	/** 写入译文：仅在槽位内容仍是原文时落笔，避免覆盖期间被框架 / 用户改过的值 */
	private apply(c: Candidate, src: string, dst: string): void {
		if (this.readSlot(c.node, c.slot) !== src) return;
		this.writeSlot(c.node, c.slot, dst);
		let slots = this.applied.get(c.node);
		if (!slots) {
			slots = new Map();
			this.applied.set(c.node, slots);
		}
		slots.set(c.slot, { src, dst });
	}

	private readSlot(node: Node, slot: string): string | null {
		if (slot === TEXT_SLOT) return node.nodeValue;
		return (node as Element).getAttribute(slot);
	}

	private writeSlot(node: Node, slot: string, value: string): void {
		if (slot === TEXT_SLOT) {
			node.nodeValue = value;
			return;
		}
		(node as Element).setAttribute(slot, value);
	}

	private isApplied(node: Node, slot: string): boolean {
		return this.applied.get(node)?.has(slot) ?? false;
	}

	private rememberFailure(text: string): void {
		if (this.failed.size >= FAILED_CAP) this.failed.clear();
		this.failed.set(text, (this.failed.get(text) ?? 0) + 1);
	}
}
