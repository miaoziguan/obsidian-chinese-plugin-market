/**
 * macOS 系统翻译（按需按钮专用通道，与自动翻译 fallback 链完全解耦）。
 *
 * 原理：macOS 自带「快捷指令」App 里的「翻译文本」动作底层即系统翻译引擎，
 * 零安装、零常驻进程、数据不出本机。我们约定用户自建一个名为
 * MACOS_TRANSLATE_SHORTCUT 的快捷指令（接收输入 → 翻译文本到中文 → 停止并输出），
 * 插件在卡片/详情页的「🍎 系统翻译」按钮被点击时，按需调用：
 *   shortcuts run "<指令名>" -i <input-file> -o <output-file>
 * 读取输出文件作为译文回填。
 *
 * 注意：macOS `shortcuts run` 的 `-i`/`-o` 只接受文件路径，不接受字符串/stdio，
 * 因此插件侧必须把文本写临时输入文件，再读取临时输出文件。
 *
 * 为何独立成通道而非塞进自动链：Shortcuts 是子进程调用，慢且有首次授权弹窗，
 * 只适合「用户主动点」的按需场景，不适合批量自动翻译。
 *
 * 仅 macOS 桌面端可用；非 Mac 调用 isMacOS() 返回 false，按钮不渲染、不调用。
 */

import { Platform } from "obsidian";
import { logger } from "../logger";

/** 约定快捷指令名（用户需在「快捷指令」App 导入/自建同名指令） */
export const MACOS_TRANSLATE_SHORTCUT = "CPM 系统翻译";

/** 是否运行在 macOS 桌面端（决定按钮是否渲染） */
export function isMacOS(): boolean {
	// 测试 / 非 Obsidian 环境可能无 Platform，做防御性判断
	return Boolean(Platform?.isDesktopApp && Platform?.isMacOS);
}

/** 清洗 shortcuts 输出的多余字符（BOM / 首尾空白 / 尾部换行） */
function cleanOutput(s: string): string {
	return s.replace(/^\uFEFF/, "").trim();
}

/**
 * Markdown 翻译占位保护（方案 A）：
 * 系统翻译会把整段 Markdown 当纯文本，连语法结构（代码块 / 行内代码 / 表格行 /
 * 链接 URL / 图片 / HTML 标签）一起翻译，破坏格式与代码。翻译前把这类结构摘出来，
 * 替换成独特的 ASCII 占位 token（如 ZZCMPLACE0ZZ），翻译回来后再还原。
 *
 * 为什么用 ASCII 乱码 token 而非 NUL 控制符：实测 Apple 翻译服务会剥离/改写不可见
 * 控制符（\u0000），导致索引数字裸奔并被翻译成乱码（如把图片变成「找不到 docs/x.png」）。
 * 全大写 + 数字的怪串（ZZCMPLACE123ZZ）通常被翻译引擎原样保留，token 完整性更高。
 */

/** 占位 token 前缀/后缀（独特乱码，系统翻译一般不改写） */
const PH = "ZZCMPLACE";
const PH_END = "ZZ";

/** 匹配「不应被翻译」的 Markdown 结构（按优先级依次收集） */
const PROTECT_PATTERNS: RegExp[] = [
	// 围栏代码块（含语言标注与内容）：```lang ... ```
	/```[^\n]*[\s\S]*?```/g,
	// 缩进代码块（4 空格 / tab 开头，连续行）：一次性匹配整段，避免逐行拆散
	/(?:^|\n)(?: {4}|\t)[^\n]*(?:\n(?: {4}|\t)[^\n]*)*/g,
	// 行内代码：`code`
	/`[^`\n]+`/g,
	// 表格分隔行：|---|---|---|
	/^\s*\|?[\s:|-]+\|\s*$/gm,
	// 图片：![alt](url "title") —— 整体保护，还原为「[图片]」友好占位
	/!\[[^\]]*\]\([^)]*\)/g,
	// 链接：把 URL 部分单独保护，只留 [text](url) 的 text 可被翻译
	/\[[^\]]*\]\([^)]*\)/g,
	// HTML 标签（自闭合 / 成对 / 注释），如 <img ...>、<div>、<!-- -->、<br/>
	/<\/?[a-zA-Z][^>]*>|<!--[\s\S]*?-->/g,
];

/** 生成唯一占位 token：ZZCMPLACE<idx>ZZ */
function token(idx: number): string {
	return `${PH}${idx}${PH_END}`;
}

/**
 * 把 Markdown 中不应被翻译的结构摘出并替换为占位 token，返回 { text, blocks }。
 * blocks[i] = 原始片段；图片片段还原为「[图片]」避免系统翻译把它变成「找不到…」。
 */
export function protectMarkdown(md: string): { text: string; blocks: string[] } {
	const blocks: string[] = [];
	let out = md;
	for (const re of PROTECT_PATTERNS) {
		re.lastIndex = 0;
		out = out.replace(re, (m) => {
			const idx = blocks.length;
			// 图片：还原为友好「[图片]」占位，避免坏链提示
			const store = m.startsWith("![") ? "[图片]" : m;
			blocks.push(store);
			return token(idx);
		});
	}
	return { text: out, blocks };
}

/**
 * 把占位 token 还原为原始被保护片段。
 *
 * 必须循环还原至不动点：PROTECT_PATTERNS 是按序多轮替换的，靠后的模式（链接 / 图片 /
 * HTML 标签）可能把靠前模式已生成的 token 整体吞进自己的片段里（如
 * "[看 `x` 文档](url)" → 行内代码先变 token，再被链接整体收走）。只做一轮 replace
 * 会导致内层 token 裸奔残留在正文中。这里反复展开直到没有 token 可还原为止。
 *
 * 循环设有上限（blocks.length + 1 轮）：正常嵌套深度不会超过保护模式的层数，
 * 加上限可防御被破坏的输入（如译文里出现自引用 token）造成的死循环。
 */
export function restoreMarkdown(translated: string, blocks: string[]): string {
	const re = new RegExp(`${PH}(\\d+)${PH_END}`, "g");
	let out = translated;
	// 最多展开 blocks.length + 1 轮：每轮至少消解一层嵌套，超出即视为异常输入
	const maxRounds = blocks.length + 1;
	for (let round = 0; round < maxRounds; round++) {
		re.lastIndex = 0;
		if (!re.test(out)) break;
		re.lastIndex = 0;
		out = out.replace(re, (_m, idxStr) => {
			const idx = Number(idxStr);
			return blocks[idx] ?? ""; // 找不到（被破坏）则移除该 token，避免裸奔乱码
		});
	}
	return out;
}

/**
 * 单段（≤BATCH_CHAR_LIMIT 字符）调用系统快捷指令翻译。
 * 内部实现：把文本写临时输入文件 → shortcuts run -i <in> -o <out> → 读输出文件。
 */
function translateOnce(text: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const requireFn = (window as unknown as { require?: NodeJS.Require }).require;
		if (!requireFn) {
			reject(new Error("当前运行环境不支持子进程调用"));
			return;
		}
		let cp: typeof import("child_process");
		let fs: typeof import("fs");
		let path: typeof import("path");
		let os: typeof import("os");
		try {
			cp = requireFn("child_process") as typeof import("child_process");
			fs = requireFn("fs") as typeof import("fs");
			path = requireFn("path") as typeof import("path");
			os = requireFn("os") as typeof import("os");
		} catch {
			reject(new Error("无法加载 Node 模块"));
			return;
		}

		const timeoutMs = 15000;
		const tmpDir = os.tmpdir();
		const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
		const inFile = path.join(tmpDir, `cpm-translate-in-${stamp}.txt`);
		const outFile = path.join(tmpDir, `cpm-translate-out-${stamp}.txt`);

		const cleanup = () => {
			try { fs.unlinkSync(inFile); } catch { /* ignore */ }
			try { fs.unlinkSync(outFile); } catch { /* ignore */ }
		};

		try {
			fs.writeFileSync(inFile, text, "utf8");
		} catch (e) {
			reject(new Error(`写入输入文件失败: ${e}`));
			return;
		}

		const child = cp.spawn("shortcuts", ["run", MACOS_TRANSLATE_SHORTCUT, "-i", inFile, "-o", outFile], {
			timeout: timeoutMs,
		});

		let stderr = "";
		child.stderr?.on("data", (d: unknown) => {
			stderr += String(d);
		});
		child.on("error", (err) => {
			cleanup();
			reject(err);
		});
		child.on("close", (code) => {
			if (code === 0) {
				try {
					const out = cleanOutput(fs.readFileSync(outFile, "utf8"));
					cleanup();
					if (out) resolve(out);
					else reject(new Error("快捷指令输出为空，请确认指令已正确设置「停止并输出」"));
				} catch (e) {
					cleanup();
					reject(new Error(`读取输出文件失败: ${e}`));
				}
			} else {
				cleanup();
				reject(new Error(stderr.trim() || `快捷指令退出码 ${code}`));
			}
		});
	});
}

/** 单段翻译的安全字符上限（macOS 系统翻译单次过长会失败，保守取值） */
export const MACOS_BATCH_CHAR_LIMIT = 900;
/** 分段翻译的并发批次数：Apple 翻译服务对并发敏感，串行最稳 */
const MACOS_CONCURRENCY = 1;
/** 单批重试次数（Apple 翻译偶发「远程服务器故障」，重试能消化大部分瞬时错误） */
const MACOS_RETRY_TIMES = 3;
/** 重试退避基数（ms），第 n 次失败后等 base * 2^(n-1) */
const MACOS_RETRY_BASE_MS = 400;

/**
 * 把长文本按段落拆成 ≤BATCH 字符的批次（尽量在段落边界断开，避免切断句子）。
 * 导出仅供单测。
 */
export function splitBatches(text: string, limit: number): string[] {
	return splitBatchesDetailed(text, limit).batches;
}

/**
 * 分段并记录「批次之间的原始分隔符」，供 joinBatches 无损拼回。
 *
 * 为什么需要它：批次不是都用 "\n\n" 隔开的——超长段落被字符硬切时，相邻两片之间
 * 本来就没有任何分隔符（应当直接相连）；而原文里 "\n\n\n" 这类多空行分隔，若统一
 * 按 "\n\n" 拼回也会被悄悄归一化。两种情况都会篡改用户正文，因此必须逐个记录。
 *
 * separators[i] = batches[i] 与 batches[i+1] 之间的原始分隔文本，长度为 batches.length - 1。
 */
export function splitBatchesDetailed(
	text: string,
	limit: number,
): { batches: string[]; separators: string[] } {
	if (text.length <= limit) return { batches: [text], separators: [] };

	// 按段落（空行）拆分，同时用捕获组保留每个分隔符原文，避免 \n\n\n 被归一化
	const parts = text.split(/(\n\s*\n)/);
	const paragraphs: string[] = [];
	const paraSeps: string[] = []; // paraSeps[i] = paragraphs[i] 与 [i+1] 之间的原始分隔符
	for (let i = 0; i < parts.length; i += 2) {
		paragraphs.push(parts[i]);
		if (i + 1 < parts.length) paraSeps.push(parts[i + 1]);
	}

	const batches: string[] = [];
	const separators: string[] = [];
	let cur = "";
	let curSep = ""; // cur 与「下一个将被推入的批次」之间的分隔符

	// 推入一个已完成的批次，并记录它与下一批次之间的分隔符
	const push = (batch: string, sepAfter: string) => {
		batches.push(batch);
		separators.push(sepAfter);
	};

	for (let i = 0; i < paragraphs.length; i++) {
		const para = paragraphs[i];
		const sepAfterPara = i < paraSeps.length ? paraSeps[i] : "";

		// 单段本身超过 limit：按字符硬切（保底，可能切断句子但保证完整覆盖）
		// 硬切产生的相邻片段之间分隔符为 ""，拼回时必须直接相连，不能插入空行
		if (para.length > limit) {
			if (cur) { push(cur, curSep); cur = ""; }
			for (let j = 0; j < para.length; j += limit) {
				const piece = para.slice(j, j + limit);
				const isLastPiece = j + limit >= para.length;
				if (isLastPiece) {
					// 最后一片留作 cur，可能还能与后续段落合并
					cur = piece;
					curSep = sepAfterPara;
				} else {
					push(piece, ""); // 硬切片段之间无分隔符
				}
			}
			continue;
		}

		if (!cur) {
			cur = para;
			curSep = sepAfterPara;
			continue;
		}
		if ((cur + curSep + para).length <= limit) {
			cur = cur + curSep + para;
			curSep = sepAfterPara;
		} else {
			push(cur, curSep);
			cur = para;
			curSep = sepAfterPara;
		}
	}
	if (cur) { batches.push(cur); }
	// separators 长度须为 batches.length - 1
	while (separators.length >= batches.length) separators.pop();
	return { batches, separators };
}

/**
 * 按原始分隔符把（翻译后的）批次拼回完整文本。
 * translated[i] 与 batches[i] 一一对应；separators 缺省时退化为 "\n\n"（向后兼容）。
 */
export function joinBatches(
	translated: string[],
	originalBatches: string[],
	separators?: string[],
): string {
	const seps = separators ?? inferSeparators(originalBatches);
	let out = "";
	for (let i = 0; i < translated.length; i++) {
		out += translated[i];
		if (i < translated.length - 1) out += seps[i] ?? "\n\n";
	}
	return out;
}

/**
 * 未提供 separators 时的兜底推断：无法还原真实分隔符，只能假定段落分隔 "\n\n"。
 * 仅用于兼容旧调用点；新代码应始终传入 splitBatchesDetailed 给出的 separators。
 */
function inferSeparators(batches: string[]): string[] {
	return new Array(Math.max(0, batches.length - 1)).fill("\n\n");
}

/**
 * 调用系统快捷指令翻译文本（支持分段，完整覆盖长文）。
 * @param onProgress 分段进度回调（done/total），便于 UI 显示「翻译中 N/M」
 * @returns 译文；失败/超时/未配置时抛错（由调用方兜底提示）。
 */
export async function macosSystemTranslate(
	text: string,
	onProgress?: (done: number, total: number) => void,
	onResult?: (failed: number) => void,
): Promise<string> {
	if (!isMacOS()) {
		throw new Error("仅 macOS 桌面端支持系统翻译");
	}
	if (!text || !text.trim()) return "";
	const { batches, separators } = splitBatchesDetailed(text, MACOS_BATCH_CHAR_LIMIT);
	if (batches.length === 1) {
		onProgress?.(0, 1);
		// 短文本也走重试，消化瞬时 Apple 翻译服务端报错
		const r = await translateWithRetry(batches[0]);
		onProgress?.(1, 1);
		if (r === null) throw new Error("系统翻译失败（已重试多次，请稍后再试）");
		return r;
	}

	// 分段 + 串行（CONCURRENCY=1）保持顺序；每批带重试；某批持续失败时保留原文（best-effort）
	const results: (string | null)[] = Array.from(
		{ length: batches.length },
		() => null as string | null
	);
	let failedCount = 0;
	let cursor = 0;
	let done = 0;
	onProgress?.(0, batches.length);
	async function worker() {
		while (true) {
			const idx = cursor++;
			if (idx >= batches.length) return;
			const r = await translateWithRetry(batches[idx]);
			if (r === null) {
				failedCount++;
				results[idx] = null; // 失败：保留原文占位
			} else {
				results[idx] = r;
			}
			done++;
			onProgress?.(done, batches.length);
		}
	}
	const workers = Array.from({ length: Math.min(MACOS_CONCURRENCY, batches.length) }, () => worker());
	await Promise.all(workers);
	// 把失败段落用原文占位，按原始分隔符拼接返回（best-effort，让用户看到大部分翻译结果）
	onResult?.(failedCount);
	return joinBatches(results.map((r, i) => r ?? batches[i]), batches, separators);
}

/** 单批翻译带重试（指数退避）；持续失败返回 null（不抛错，让上层决定是否保留原文） */
async function translateWithRetry(batch: string): Promise<string | null> {
	let lastErr: unknown = null;
	for (let attempt = 1; attempt <= MACOS_RETRY_TIMES; attempt++) {
		try {
			return await translateOnce(batch);
		} catch (e) {
			lastErr = e;
			if (attempt < MACOS_RETRY_TIMES) {
				await sleep(MACOS_RETRY_BASE_MS * Math.pow(2, attempt - 1));
			}
		}
	}
	logger.warn(`[Chinese Plugin Market] 系统翻译单批重试 ${MACOS_RETRY_TIMES} 次仍失败：`, lastErr);
	return null;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => window.setTimeout(r, ms));
}
