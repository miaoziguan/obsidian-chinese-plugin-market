/**
 * E2E 静态服务器：把仓库根目录作为静态根，供 Playwright 加载 harness.html / bundle.js。
 * 仅用于本地 E2E，不对外暴露。
 */
import { createServer } from "http";
import { readFile } from "fs/promises";
import { extname, join, normalize } from "path";

const ROOT = process.cwd();
const PORT = Number(process.env.E2E_PORT || 4173);

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".ts": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".map": "application/json; charset=utf-8",
};

const server = createServer(async (req, res) => {
	try {
		let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
		if (urlPath === "/") urlPath = "/index.html";
		// 防目录穿越
		const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
		const filePath = join(ROOT, safe);
		const data = await readFile(filePath);
		const mime = MIME[extname(filePath)] || "application/octet-stream";
		res.writeHead(200, { "Content-Type": mime });
		res.end(data);
	} catch {
		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("404 Not Found");
	}
});

server.listen(PORT, () => {
	console.log(`[serve-e2e] http://localhost:${PORT}`);
});
