import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginInfo } from "@domain/catalog/translator";
import type { LLMClient } from "@translation/api/api";
import { netRequest } from "@data/net/net";
import type { MirrorConfig } from "@domain/catalog/mirror";
import {
	buildManifestUrl,
	buildMainJsUrl,
	fetchManifest,
	fetchReadmeText,
	fetchMainSignals,
	extractMainSignals,
	buildInsightPrompt,
	generateInsight,
	gatherInsightSources,
} from "./plugin-insight";

// 依赖替身：netRequest 抛错风险由业务层 try/catch 兜底，这里仅供我们编排响应；
// resolveUrl 用恒等实现，buildReadmeUrl 仅在 repo 非空时返回固定地址。
vi.mock("@data/net/net", () => ({ netRequest: vi.fn() }));
vi.mock("@domain/catalog/mirror", () => ({
	resolveUrl: vi.fn((u: string) => u),
	buildReadmeUrl: vi.fn((repo: string | undefined) => (repo ? "https://readme.url" : "")),
}));

const netReq = vi.mocked(netRequest);

const mkPlugin = (over: Partial<PluginInfo> = {}): PluginInfo =>
	({ id: "p1", name: "P1", description: "官方描述", author: "a", downloads: 10, updated: 1_600_000_000_000 } as PluginInfo) as PluginInfo & typeof over;
const mirror = {} as unknown as MirrorConfig;

beforeEach(() => {
	vi.clearAllMocks();
});

describe("buildManifestUrl（55-63）", () => {
	it("repo 未定义 → 空串", () => expect(buildManifestUrl(undefined, mirror)).toBe(""));
	it("标准 owner/name → raw HEAD 源", () =>
		expect(buildManifestUrl("a/b", mirror)).toBe(
			"https://raw.githubusercontent.com/a/b/HEAD/manifest.json",
		));
	it("前后斜杠被清理", () => expect(buildManifestUrl("/a/b/", mirror)).toBe(buildManifestUrl("a/b", mirror)));
	it("非两段 → 空串", () => {
		expect(buildManifestUrl("a", mirror)).toBe("");
		expect(buildManifestUrl("a/b/c", mirror)).toBe("");
	});
});

describe("buildMainJsUrl（66-79）", () => {
	it("repo 未定义 → 空串", () => expect(buildMainJsUrl(undefined, "main.js", mirror)).toBe(""));
	it("main 未定义 → main.js", () =>
		expect(buildMainJsUrl("a/b", undefined, mirror)).toBe(
			"https://raw.githubusercontent.com/a/b/HEAD/main.js",
		));
	it("main 指定入口", () =>
		expect(buildMainJsUrl("a/b", "custom.js", mirror)).toBe(
			"https://raw.githubusercontent.com/a/b/HEAD/custom.js",
		));
	it("main 仅空白 → 回退 main.js", () =>
		expect(buildMainJsUrl("a/b", "   ", mirror)).toBe(
			"https://raw.githubusercontent.com/a/b/HEAD/main.js",
		));
	it("非两段 → 空串", () => expect(buildMainJsUrl("a", "main.js", mirror)).toBe(""));
});

describe("fetchManifest（82-107）", () => {
	it("repo 空 → 立即返回空对象", async () => {
		expect(await fetchManifest("", mirror)).toEqual({});
		expect(netReq).not.toHaveBeenCalled();
	});
	it("200 + 合法 json → 字段整形（含 tags/dependencies 过滤）", async () => {
		netReq.mockResolvedValue({
			status: 200,
			json: { description: "d", author: "o", version: "1.0", tags: ["x", 1, "y"], dependencies: { dep: "^1" }, main: "main.js" },
			text: "",
		} as never);
		const m = await fetchManifest("a/b", mirror);
		expect(m.description).toBe("d");
		expect(m.tags).toEqual(["x", "y"]);
		expect(m.dependencies).toEqual({ dep: "^1" });
		expect(m.main).toBe("main.js");
	});
	it("非 2xx → 空对象", async () => {
		netReq.mockResolvedValue({ status: 404, json: null, text: "" } as never);
		expect(await fetchManifest("a/b", mirror)).toEqual({});
	});
	it("json 非对象 → 空对象", async () => {
		netReq.mockResolvedValue({ status: 200, json: "notobject", text: "" } as never);
		expect(await fetchManifest("a/b", mirror)).toEqual({});
	});
	it("字段类型不符 → 对应字段为 undefined", async () => {
		netReq.mockResolvedValue({
			status: 200,
			json: { tags: 5, dependencies: "notobject", main: 5 },
			text: "",
		} as never);
		const m = await fetchManifest("a/b", mirror);
		expect(m.tags).toBeUndefined();
		expect(m.dependencies).toBeUndefined();
		expect(m.main).toBeUndefined();
	});
	it("请求抛错 → 空对象", async () => {
		netReq.mockRejectedValue(new Error("network"));
		expect(await fetchManifest("a/b", mirror)).toEqual({});
	});
});

describe("fetchReadmeText（110-125）", () => {
	it("repo 空 → 空串", async () => {
		expect(await fetchReadmeText("", mirror)).toBe("");
		expect(netReq).not.toHaveBeenCalled();
	});
	it("200 → 原文；截断到 5000", async () => {
		netReq.mockResolvedValue({ status: 200, json: null, text: "A".repeat(6000) } as never);
		const r = await fetchReadmeText("a/b", mirror);
		expect(r.length).toBe(5000);
	});
	it("非 2xx → 空串", async () => {
		netReq.mockResolvedValue({ status: 403, json: null, text: "x" } as never);
		expect(await fetchReadmeText("a/b", mirror)).toBe("");
	});
	it("请求抛错 → 空串", async () => {
		netReq.mockRejectedValue(new Error("x"));
		expect(await fetchReadmeText("a/b", mirror)).toBe("");
	});
});

describe("fetchMainSignals（128-142）", () => {
	it("repo 空 → 默认空信号", async () => {
		expect(await fetchMainSignals("", undefined, mirror)).toEqual({ commands: [], hasSettings: false });
		expect(netReq).not.toHaveBeenCalled();
	});
	it("200 → 抽取信号", async () => {
		netReq.mockResolvedValue({
			status: 200,
			json: null,
			text: 'this.addCommand({ id:"x", name:"X" });',
		} as never);
		const s = await fetchMainSignals("a/b", "main.js", mirror);
		expect(s.commands).toEqual([{ id: "x", name: "X" }]);
	});
	it("非 2xx → 默认空信号", async () => {
		netReq.mockResolvedValue({ status: 500, json: null, text: "" } as never);
		expect(await fetchMainSignals("a/b", "main.js", mirror)).toEqual({ commands: [], hasSettings: false });
	});
	it("请求抛错 → 默认空信号", async () => {
		netReq.mockRejectedValue(new Error("x"));
		expect(await fetchMainSignals("a/b", "main.js", mirror)).toEqual({ commands: [], hasSettings: false });
	});
});

describe("extractMainSignals（149-162）", () => {
	it("抽取 addCommand 的 id/name", () => {
		const s = extractMainSignals('this.addCommand({ id:"a", name:"A" }); this.addCommand({ id:"b", name:"B" });');
		expect(s.commands).toEqual([{ id: "a", name: "A" }, { id: "b", name: "B" }]);
	});
	it("无 addCommand → 空命令", () => {
		expect(extractMainSignals("nothing here").commands).toEqual([]);
	});
	it("id 与 name 缺一 → 跳过", () => {
		expect(extractMainSignals('this.addCommand({ id:"x" });').commands).toEqual([]);
	});
	it("检测到设置页 → hasSettings true", () => {
		expect(extractMainSignals('this.addSettingTab(new S(this));').hasSettings).toBe(true);
	});
	it("无设置页 → hasSettings false", () => {
		expect(extractMainSignals('this.addCommand({ id:"a", name:"A" });').hasSettings).toBe(false);
	});
	it("命令数封顶 40", () => {
		const code = Array.from({ length: 60 }, (_, i) => `this.addCommand({ id:"c${i}", name:"C${i}" });`).join("\n");
		expect(extractMainSignals(code).commands.length).toBe(40);
	});
});

describe("buildInsightPrompt（165-211）", () => {
	const base = mkPlugin();
	it("基础字段（id/name/description）", () => {
		const p = buildInsightPrompt(base, {});
		expect(p).toContain("插件 ID：p1");
		expect(p).toContain("名称：P1");
		expect(p).toContain("官方描述：官方描述");
	});
	it("manifest 描述与官方不同 → 两者都呈现", () => {
		const p = buildInsightPrompt(base, { description: "另一个描述" });
		expect(p).toContain("官方描述：官方描述");
		expect(p).toContain("manifest 描述：另一个描述");
	});
	it("其余 manifest 字段（author/version/tags/dependencies）", () => {
		const p = buildInsightPrompt(base, { author: "o", version: "2.0", tags: ["t1"], dependencies: { d: "1" } });
		expect(p).toContain("作者：o");
		expect(p).toContain("版本：2.0");
		expect(p).toContain("官方标签：t1");
		expect(p).toContain("依赖（暴露技术栈/联动对象）：d");
	});
	it("PluginInfo 的 downloads / updated", () => {
		const p = buildInsightPrompt(base, {});
		expect(p).toContain("下载量：10");
		expect(p).toContain("最近更新：");
	});
	it("extra.mainSignals 命令 + 设置页提示", () => {
		const p = buildInsightPrompt(base, {}, { mainSignals: { commands: [{ id: "c", name: "命令" }], hasSettings: true } });
		expect(p).toContain("命令（最能反映真实功能");
		expect(p).toContain("命令（c）");
		expect(p).toContain("代码包含设置页");
	});
	it("extra.readme 片段", () => {
		const p = buildInsightPrompt(base, {}, { readme: "README 内容" });
		expect(p).toContain("README 原文片段");
		expect(p).toContain("README 内容");
	});
	it("description 缺失 → 不出现官方描述行", () => {
		const p = buildInsightPrompt({ ...base, description: "" }, {});
		expect(p).not.toContain("官方描述：");
	});
});

describe("generateInsight（217-233）", () => {
	const llm = { call: vi.fn() } as unknown as LLMClient;
	it("返回文本（去首尾空白）", async () => {
		(llm.call as ReturnType<typeof vi.fn>).mockResolvedValue("  概述文本  ");
		const r = await generateInsight(llm, mkPlugin(), {});
		expect(r).toBe("概述文本");
	});
	it("AI 空响应 → 抛错（由调用方降级到 description）", async () => {
		(llm.call as ReturnType<typeof vi.fn>).mockResolvedValue("");
		await expect(generateInsight(llm, mkPlugin(), {})).rejects.toThrow();
	});
});

describe("gatherInsightSources（247-262）", () => {
	const LONG = "R".repeat(8000);
	const CODE = 'this.addCommand({ id:"a", name:"A" }); this.addSettingTab(new S(this));';
	beforeEach(() => {
		netReq.mockImplementation((o: { url: string }) => {
			const u = o.url;
			if (u.includes("manifest.json"))
				return Promise.resolve({ status: 200, json: { description: "md", main: "main.js" }, text: "" } as never);
			if (u.includes("readme")) return Promise.resolve({ status: 200, json: null, text: LONG } as never);
			return Promise.resolve({ status: 200, json: null, text: CODE } as never);
		});
	});
	it("聚合 manifest + main.js 信号 + README（默认 limit 5000 截断）", async () => {
		const r = await gatherInsightSources("a/b", mirror);
		expect(r.manifest.description).toBe("md");
		expect(r.mainSignals.commands).toEqual([{ id: "a", name: "A" }]);
		expect(r.mainSignals.hasSettings).toBe(true);
		expect(r.readme.length).toBe(5000);
	});
	it("readmeLimit 小于原文 → 按 limit 截断", async () => {
		const r = await gatherInsightSources("a/b", mirror, 100);
		expect(r.readme.length).toBe(100);
	});
	it("repo 空 → 三路降级为空", async () => {
		const r = await gatherInsightSources("", mirror);
		expect(r.manifest).toEqual({});
		expect(r.mainSignals).toEqual({ commands: [], hasSettings: false });
		expect(r.readme).toBe("");
	});
});
