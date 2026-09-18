/**
 * 打包评测 harness 入口：scripts/eval/entry.ts → eval.bundle.cjs（node 可 require）。
 * obsidian/transformers/worker 走 e2e 桩（harness 注入向量分数，不碰模型与 UI）。
 * 跑法：node scripts/eval/build-bundle.mjs && node scripts/eval/run-eval.mjs
 */
import { build } from "esbuild";
import { resolve } from "path";

const alias = {
	obsidian: resolve("test/e2e/obsidian-mock.ts"),
	"@xenova/transformers": resolve("test/e2e/transformers-stub.ts"),
	"@huggingface/transformers": resolve("test/e2e/transformers-stub.ts"),
	"@inline-worker": resolve("test/e2e/inline-worker-stub.ts"),
};

await build({
	entryPoints: [resolve("scripts/eval/entry.ts")],
	outfile: resolve("scripts/eval/eval.bundle.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs",
	target: ["node18"],
	tsconfig: "tsconfig.json",
	alias,
	loader: { ".css": "empty", ".json": "json", ".wasm": "binary" },
	logLevel: "warning",
});
console.log("[eval] eval.bundle.cjs 构建完成");
