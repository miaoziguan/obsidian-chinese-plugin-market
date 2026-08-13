/**
 * 数据源镜像解析 + 网络错误分类（产品改进 #10）
 * 纯函数，零依赖，便于单元测试。
 */

/** 镜像源类型 */
export type MirrorSource = "github" | "jsdelivr" | "ghproxy" | "custom";

/** 镜像配置 */
export interface MirrorConfig {
	source: MirrorSource;
	/** custom 模式下的自定义基础 URL（替换 https://raw.githubusercontent.com 部分） */
	customBase?: string;
}

/**
 * 把 raw.githubusercontent.com 原始 URL 映射到指定镜像。
 *
 * - github：原样返回
 * - jsdelivr：`https://cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>/<path>`
 * - ghproxy：在原始 URL 前拼 `https://gh-proxy.com/`（原 ghproxy.com 已停服）
 * - custom：用 customBase 替换 `https://raw.githubusercontent.com`
 */
export function resolveUrl(rawUrl: string, mirror: MirrorConfig): string {
	if (!rawUrl) return rawUrl;
	const m = rawUrl.match(
		/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/
	);
	// 不是 raw.githubusercontent 结构（如已映射过的 jsdelivr），原样返回避免重复处理
	if (!m) return rawUrl;

	const [, owner, repo, ref, path] = m;

	switch (mirror.source) {
		case "jsdelivr":
			return `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}/${path}`;
		case "ghproxy":
			return `https://gh-proxy.com/${rawUrl}`;
		case "custom":
			if (!mirror.customBase) return rawUrl;
			return `${mirror.customBase.replace(/\/$/, "")}/${owner}/${repo}/${ref}/${path}`;
		case "github":
		default:
			return rawUrl;
	}
}

/**
 * 由插件 repo（形如 `owner/name`）构造 README 的 raw 拉取 URL，并按镜像映射（产品改进 #8）。
 * 默认取 `HEAD` 分支的 `README.md`；repo 非法（空 / 无斜杠）时返回空串。
 * @param fileName 可选：README 文件名（大小写 fallback 时传 "readme.md" / "Readme.md"）
 */
export function buildReadmeUrl(
	repo: string | undefined,
	mirror: MirrorConfig,
	fileName: string = "README.md"
): string {
	if (!repo) return "";
	const cleaned = repo.replace(/^\/+|\/+$/g, "");
	const parts = cleaned.split("/");
	if (parts.length !== 2 || !parts[0] || !parts[1]) return "";
	const [owner, name] = parts;
	const rawUrl = `https://raw.githubusercontent.com/${owner}/${name}/HEAD/${fileName}`;
	return resolveUrl(rawUrl, mirror);
}

/**
 * 把 GitHub README 中的相对路径 URL 重写为绝对地址（对齐 better-store readme.ts）：
 * - Markdown 图片 → raw.githubusercontent.com（否则 MarkdownRenderer 的 sourcePath 只给出
 *   github blob 网页地址，图片显示成页面而非图片）
 * - Markdown 链接 → github blob 视图
 * - HTML `<img src>` → raw.githubusercontent.com
 * 绝对地址（http(s)://、//、#、mailto:、data:、obsidian:）与锚点原样保留。
 * 纯函数，零依赖，可单测。
 */
export function rewriteReadmeUrls(markdown: string, repo: string): string {
	const rawBase = `https://raw.githubusercontent.com/${repo}/HEAD/`;
	const blobBase = `https://github.com/${repo}/blob/HEAD/`;
	const ABSOLUTE = /^(?:https?:)?\/\/|^#|^mailto:|^data:|^obsidian:/i;
	const stripLeadingDot = (url: string): string => url.replace(/^\.?\//, "");
	return markdown
		// Markdown 图片: ![alt](url)
		.replace(/(!\[[^\]]*\]\()([^)\s]+)(\))/g, (m, pre: string, url: string, post: string) =>
			ABSOLUTE.test(url) ? m : pre + rawBase + stripLeadingDot(url) + post
		)
		// Markdown 链接: [text](url)，负向后视排除图片
		.replace(/((?<!!)\[[^\]]*\]\()([^)\s]+)(\))/g, (m, pre: string, url: string, post: string) =>
			ABSOLUTE.test(url) ? m : pre + blobBase + stripLeadingDot(url) + post
		)
		// 内联 HTML 图片: <img src="url">
		.replace(/(<img[^>]*\ssrc=")([^"]+)(")/gi, (m, pre: string, url: string, post: string) =>
			ABSOLUTE.test(url) ? m : pre + rawBase + stripLeadingDot(url) + post
		);
}

/** 网络错误分类结果 */
export interface NetworkErrorInfo {
	kind: "timeout" | "dns" | "blocked" | "json" | "http" | "unknown";
	message: string;
	/** 是否建议切换镜像（被墙/访问受限场景） */
	suggestMirror?: boolean;
}

/**
 * 把未知错误归一化为可识别的网络错误类别，便于 UI 给出针对性文案与建议。
 */
export function classifyNetworkError(err: unknown): NetworkErrorInfo {
	const raw =
		err instanceof Error
			? err.message
			: typeof err === "string"
				? err
				: JSON.stringify(err);
	const msg = raw.toLowerCase();

	if (/timeout|etimedout|超时/.test(msg)) {
		return { kind: "timeout", message: "请求超时，请检查网络后重试" };
	}
	if (/enotfound|eai_again|dns|getaddrinfo/.test(msg)) {
		return { kind: "dns", message: "无法解析域名（DNS 失败），请检查网络连接" };
	}
	if (/403|404|blocked|被墙|network|raw\.githubusercontent/.test(msg)) {
		return {
			kind: "blocked",
			message: "无法访问 GitHub，可能是网络受限。建议切换到 jsDelivr 镜像后重试",
			suggestMirror: true,
		};
	}
	if (/json|unexpected token|syntaxerror/.test(msg)) {
		return { kind: "json", message: "数据解析失败（返回内容不是合法 JSON）" };
	}
	if (/http\s*\d{3}|status\s*\d{3}/.test(msg)) {
		return { kind: "http", message: raw };
	}
	return { kind: "unknown", message: raw || "未知网络错误" };
}

/**
 * 计算镜像容错探测顺序：当前设置源排在最前，其余候选源按默认优先级补足。
 * 纯函数，便于单测；fetchPluginsWithFallback 依此顺序逐个探测。
 * @param current 用户当前设置的镜像源
 * @param candidates 候选源全集（默认 jsdelivr → github，ghproxy 已停服不参与默认顺序）
 * @returns 探测顺序（current 在前，其余按 candidates 原序过滤掉 current）
 */
export function buildMirrorOrder(
	current: MirrorSource,
	candidates: MirrorSource[] = ["jsdelivr", "github"]
): MirrorSource[] {
	const rest = candidates.filter((m) => m !== current);
	return [current, ...rest];
}
