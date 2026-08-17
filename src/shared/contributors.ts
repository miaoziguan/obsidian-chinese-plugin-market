/**
 * 鸣谢清单：为本插件开发做出贡献的人。
 *
 * 维护方式：硬编码常量，发版时手动追加。每个贡献者仅需两项：
 * - name：显示名（通常即 GitHub 用户名）
 * - github：GitHub 用户名，链接拼为 https://github.com/${github}
 *
 * 聚焦「对本插件直接/间接有贡献的人」——提 PR 的贡献者、给建议的用户、帮忙测试的人，
 * 表达项目归属感。不收录泛科技先驱（那超出本清单范围）。
 */
export interface Contributor {
	name: string;
	github: string;
}

export const CONTRIBUTORS: Contributor[] = [
	{ name: "羽鳞君", github: "miaoziguan" },
	{ name: "RavenHogWarts", github: "RavenHogWarts" },
	{ name: "Frank6", github: "frank6com" },
	{ name: "vran", github: "vran-dev" },
];

/** 拼接贡献者的 GitHub 主页 URL（仅用户名，避免拼接外部任意 URL 的安全风险）。 */
export function contributorGitHubUrl(github: string): string {
	return `https://github.com/${github}`;
}
