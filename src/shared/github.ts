/** 解析 owner/name 简写；允许首尾斜杠，拒绝缺段或额外路径。 */
export function parseGithubRepo(repo: string | undefined): { owner: string; repo: string } | null {
	if (!repo) return null;
	const cleaned = repo.replace(/^\/+|\/+$/g, "");
	const parts = cleaned.split("/");
	if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
	return { owner: parts[0], repo: parts[1] };
}
