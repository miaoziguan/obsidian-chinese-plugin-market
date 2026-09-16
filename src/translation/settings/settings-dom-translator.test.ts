import { describe, it, expect, vi, afterEach } from "vitest";
import { SettingsDomTranslator } from "./settings-dom-translator";

/** 已 start 的实例，统一在 afterEach 里 stop，避免定时器泄漏 */
const started: SettingsDomTranslator[] = [];

afterEach(() => {
	while (started.length > 0) started.pop()?.stop();
	document.body.innerHTML = "";
});

function makeRoot(): HTMLElement {
	const root = document.createElement("div");
	document.body.appendChild(root);
	return root;
}

function addText(parent: HTMLElement, tag: string, text: string): HTMLElement {
	const el = document.createElement(tag);
	el.textContent = text;
	parent.appendChild(el);
	return el;
}

function makeT(
	map: Record<string, string>,
	root: HTMLElement,
	options?: { shouldSkip?: (text: string) => boolean },
) {
	const translate = vi.fn(async (text: string) => map[text] ?? null);
	// 批量通道：模拟「一块一次请求」，只返回有译文的条目
	const translateBatch = vi.fn(async (texts: string[]) => {
		const out = new Map<string, string>();
		for (const t of texts) {
			const dst = map[t];
			if (dst) out.set(t, dst);
		}
		return out;
	});
	const t = new SettingsDomTranslator({
		shouldSkip: options?.shouldSkip ?? (() => false),
		translate,
		translateBatch,
		getRoot: () => root,
	});
	started.push(t);
	return { t, translate, translateBatch };
}

/** 等 MutationObserver 回调（jsdom 里按微任务/宏任务派发） */
function flushMutations(): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, 0));
}

/** 取批量通道实际收到的全部文本（mock.calls 形如 [[texts]]） */
function sentTexts(spy: { mock: { calls: unknown[][] } }): string[] {
	return spy.mock.calls.flatMap((args) => (Array.isArray(args[0]) ? (args[0] as string[]) : []));
}

describe("SettingsDomTranslator 扫描", () => {
	it("翻译 React 自绘设置页里的英文文本节点（不走原生 Setting 组件也生效）", async () => {
		const root = makeRoot();
		const name = addText(root, "div", "Enable Autocomplete");
		const desc = addText(root, "p", "Suggest completions while you type.");
		const { t, translateBatch } = makeT(
			{ "Enable Autocomplete": "启用自动补全", "Suggest completions while you type.": "输入时给出补全建议。" },
			root,
		);
		t.start();
		await t.scanNow();

		expect(name.textContent).toBe("启用自动补全");
		expect(desc.textContent).toBe("输入时给出补全建议。");
		// 两条合并进同一块 → 一次请求（逐条要 4 个请求：每条 detect + translate）
		expect(translateBatch).toHaveBeenCalledTimes(1);
		expect(translateBatch.mock.calls[0]?.[0]).toHaveLength(2);
		t.stop();
	});

	it("只改文本不改结构：保留 <a> 的 href 与元素层级", async () => {
		const root = makeRoot();
		const a = document.createElement("a");
		a.setAttribute("href", "https://example.com");
		a.textContent = "Read the docs";
		root.appendChild(a);
		const { t } = makeT({ "Read the docs": "阅读文档" }, root);
		t.start();
		await t.scanNow();

		expect(a.textContent).toBe("阅读文档");
		expect(a.getAttribute("href")).toBe("https://example.com");
		expect(root.firstElementChild).toBe(a);
		t.stop();
	});

	it("翻译 placeholder / title / aria-label 属性", async () => {
		const root = makeRoot();
		const input = document.createElement("input");
		input.setAttribute("placeholder", "Enter your API key");
		const btn = document.createElement("button");
		btn.setAttribute("aria-label", "Add new model");
		btn.setAttribute("title", "Add a model");
		root.append(input, btn);
		const { t } = makeT(
			{
				"Enter your API key": "输入你的 API 密钥",
				"Add new model": "添加新模型",
				"Add a model": "添加一个模型",
			},
			root,
		);
		t.start();
		await t.scanNow();

		expect(input.getAttribute("placeholder")).toBe("输入你的 API 密钥");
		expect(btn.getAttribute("aria-label")).toBe("添加新模型");
		expect(btn.getAttribute("title")).toBe("添加一个模型");
		t.stop();
	});

	it("跳过代码/输入/图标区域与 URL、纯符号文本", async () => {
		const root = makeRoot();
		const code = addText(root, "code", "npm install copilot");
		const pre = addText(root, "pre", "SELECT * FROM docs");
		const ta = document.createElement("textarea");
		ta.textContent = "User note content";
		root.appendChild(ta);
		const url = addText(root, "div", "https://example.com/docs");
		const symbol = addText(root, "div", "→ ★ 123");
		const ok = addText(root, "div", "Model temperature");
		const { t, translateBatch } = makeT({ "Model temperature": "模型温度" }, root);
		t.start();
		await t.scanNow();

		expect(code.textContent).toBe("npm install copilot");
		expect(pre.textContent).toBe("SELECT * FROM docs");
		expect(ta.textContent).toBe("User note content");
		expect(url.textContent).toBe("https://example.com/docs");
		expect(symbol.textContent).toBe("→ ★ 123");
		expect(ok.textContent).toBe("模型温度");
		expect(sentTexts(translateBatch)).toEqual(["Model temperature"]);
		t.stop();
	});

	it("上层判定跳过（未启用 / 黑名单 / 已中文）时不送翻", async () => {
		const root = makeRoot();
		const en = addText(root, "div", "Enable");
		const zh = addText(root, "div", "已启用");
		const { t, translateBatch } = makeT({ Enable: "启用" }, root, {
			shouldSkip: (text) => !/[A-Za-z]/.test(text),
		});
		t.start();
		await t.scanNow();

		expect(en.textContent).toBe("启用");
		expect(zh.textContent).toBe("已启用");
		expect(sentTexts(translateBatch)).not.toContain("已启用");
		t.stop();
	});

	it("同一文本多个节点只请求一次并全部写入", async () => {
		const root = makeRoot();
		const a = addText(root, "div", "Save");
		const b = addText(root, "div", "Save");
		const { t, translateBatch } = makeT({ Save: "保存" }, root);
		t.start();
		await t.scanNow();

		expect(a.textContent).toBe("保存");
		expect(b.textContent).toBe("保存");
		expect(sentTexts(translateBatch)).toEqual(["Save"]);
		t.stop();
	});

	it("翻译失败保留原文；重试到上限后不再反复打扰", async () => {
		const root = makeRoot();
		const el = addText(root, "div", "Unknown phrase");
		const { t, translate } = makeT({}, root);
		t.start();
		for (let i = 0; i < 4; i++) await t.scanNow();
		expect(el.textContent).toBe("Unknown phrase");
		// 首次 + 2 次重试（网络抖动可自愈），第 4 轮起不再请求
		expect(translate).toHaveBeenCalledTimes(3);
		t.stop();
	});

	it("按条数 / 字符数切块：40 条或 1900 字符一块", async () => {
		const root = makeRoot();
		const map: Record<string, string> = {};
		for (let i = 0; i < 45; i++) {
			const text = `Phrase ${i}`;
			map[text] = `短语 ${i}`;
			addText(root, "div", text);
		}
		const { t, translateBatch } = makeT(map, root);
		t.start();
		await t.scanNow();

		expect(translateBatch).toHaveBeenCalledTimes(2); // 45 条 → 40 / 5
		for (const call of translateBatch.mock.calls) {
			expect((call[0] ?? []).length).toBeLessThanOrEqual(40);
		}
		expect(root.children[0]?.textContent).toBe("短语 0");
		expect(root.children[44]?.textContent).toBe("短语 44");
		t.stop();
	});

	it("单轮超出上限的文本留到后续轮次（不一次性打爆免费通道）", async () => {
		const root = makeRoot();
		const map: Record<string, string> = {};
		for (let i = 0; i < 400; i++) {
			const text = `Phrase number ${i}`;
			map[text] = `短语 ${i}`;
			addText(root, "div", text);
		}
		const { t, translateBatch } = makeT(map, root);
		t.start();
		await t.scanNow();

		expect(sentTexts(translateBatch)).toHaveLength(300); // 单轮上限
		expect(root.children[0]?.textContent).toBe("短语 0");
		// 第 300 条之后尚未翻（下一轮继续）
		expect(root.children[350]?.textContent).toBe("Phrase number 350");
		t.stop();
	});
});

describe("SettingsDomTranslator 防自激 / 防回退", () => {
	it("写入译文后不会触发重复扫描", async () => {
		const root = makeRoot();
		const el = addText(root, "div", "Enable");
		const { t, translateBatch } = makeT({ Enable: "启用" }, root);
		t.start();
		await t.scanNow();
		expect(el.textContent).toBe("启用");
		await flushMutations();
		await t.scanNow();
		expect(translateBatch).toHaveBeenCalledTimes(1);
		t.stop();
	});

	it("框架重渲染把文案打回原文时自动贴回译文", async () => {
		const root = makeRoot();
		const el = addText(root, "div", "Enable");
		const { t } = makeT({ Enable: "启用" }, root);
		t.start();
		await t.scanNow();
		expect(el.textContent).toBe("启用");

		// 模拟 React 重渲染：把文本节点值改回原文
		const textNode = el.firstChild;
		expect(textNode).not.toBeNull();
		textNode!.nodeValue = "Enable";
		expect(el.textContent).toBe("Enable");

		await flushMutations();
		expect(el.textContent).toBe("启用");
		t.stop();
	});

	it("新增节点（React 异步渲染的 Tab 内容）会被扫描到", async () => {
		const root = makeRoot();
		addText(root, "div", "General");
		const { t } = makeT({ General: "通用", Advanced: "高级" }, root);
		t.start();
		await t.scanNow();
		expect(root.children[0]?.textContent).toBe("通用");

		addText(root, "div", "Advanced");
		await flushMutations();
		await t.scanNow();
		expect(root.children[1]?.textContent).toBe("高级");
		t.stop();
	});
});

describe("SettingsDomTranslator 生命周期", () => {
	it("容器不可用时不扫描，容器就绪后自动挂载并补扫", async () => {
		let root: HTMLElement | null = null;
		const translate = vi.fn(async () => null);
		const translateBatch = vi.fn(async (texts: string[]) => new Map(texts.map((t) => [t, "译:" + t])));
		const t = new SettingsDomTranslator({
			shouldSkip: () => false,
			translate,
			translateBatch,
			getRoot: () => root,
		});
		started.push(t);
		t.start();
		await t.scanNow();
		expect(translateBatch).not.toHaveBeenCalled();

		root = makeRoot();
		addText(root, "div", "Enable");
		t.scheduleScan();
		await new Promise((resolve) => window.setTimeout(resolve, 200));
		expect(sentTexts(translateBatch)).toContain("Enable");
		t.stop();
	});

	it("stop 后不再响应变更", async () => {
		const root = makeRoot();
		const el = addText(root, "div", "Enable");
		const { t, translateBatch } = makeT({ Enable: "启用" }, root);
		t.start();
		await t.scanNow();
		expect(el.textContent).toBe("启用");
		t.stop();

		addText(root, "div", "Advanced");
		await flushMutations();
		await t.scanNow();
		expect(translateBatch).toHaveBeenCalledTimes(1);
	});
});

describe("SettingsDomTranslator 批量降级", () => {
	it("批量没译出的串会降级为逐条翻译", async () => {
		const root = makeRoot();
		const el = addText(root, "div", "Only single works");
		const translateBatch = vi.fn(async () => new Map<string, string>()); // 批量整块失败
		const translate = vi.fn(async (text: string) =>
			text === "Only single works" ? "只有逐条能译" : null,
		);
		const t = new SettingsDomTranslator({
			shouldSkip: () => false,
			translate,
			translateBatch,
			getRoot: () => root,
		});
		started.push(t);
		t.start();
		await t.scanNow();

		expect(el.textContent).toBe("只有逐条能译");
		expect(translate).toHaveBeenCalledWith("Only single works");
		t.stop();
	});
});
