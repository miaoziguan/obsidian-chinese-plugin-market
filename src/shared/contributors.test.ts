import { describe, it, expect } from "vitest";
import { CONTRIBUTORS, contributorGitHubUrl, type Contributor } from "./contributors";

describe("contributors", () => {
	it("CONTRIBUTORS 为硬编码非空数组，每项含昵称 name + github", () => {
		expect(Array.isArray(CONTRIBUTORS)).toBe(true);
		expect(CONTRIBUTORS.length).toBeGreaterThan(0);
		for (const c of CONTRIBUTORS as Contributor[]) {
			expect(typeof c.name).toBe("string");
			expect(c.name.length).toBeGreaterThan(0);
			expect(typeof c.github).toBe("string");
			expect(c.github.length).toBeGreaterThan(0);
		}
		// 确认昵称已按 GitHub 个人资料更新
		expect(CONTRIBUTORS.find((c) => c.github === "miaoziguan")?.name).toBe("羽鳞君");
		expect(CONTRIBUTORS.find((c) => c.github === "frank6com")?.name).toBe("Frank6");
	});

	it("contributorGitHubUrl 拼出标准 GitHub 主页", () => {
		expect(contributorGitHubUrl("frank6com")).toBe("https://github.com/frank6com");
	});

	it("github 用户名不含斜杠时 URL 不被拼接污染", () => {
		// 仅用户名，避免拼接任意路径（防 URL 注入）
		expect(contributorGitHubUrl("miaoziguan")).toBe("https://github.com/miaoziguan");
	});
});
