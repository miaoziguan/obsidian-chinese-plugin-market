// 评测向量缓存：doc 全量 embed 一次 + 每条 eval query 的 top300 分数（阈值 0.3 同生产）
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { pipeline, env } from "@huggingface/transformers";
env.cacheDir = "/tmp/hf-cache-e5"; env.allowLocalModelAccess = false; env.remoteHost = "https://hf-mirror.com/";
const REPO = process.cwd();
const TASK = path.join(REPO, ".agents/state/tasks/semantic-zh-en");
const VAULT = path.join(os.homedir(), "Library/Mobile Documents/iCloud~md~obsidian/Documents/Agent/.obsidian/plugins/chinese-plugin-market");
const pool = JSON.parse(fs.readFileSync(path.join(TASK, "eval-pool.json"), "utf8"));
const tags = JSON.parse(fs.readFileSync(path.join(REPO, "plugin-tags.json"), "utf8"));
const evalSet = JSON.parse(fs.readFileSync(path.join(TASK, "eval-set.json"), "utf8"));
const zh = JSON.parse(fs.readFileSync(path.join(VAULT, "translator-cache.json"), "utf8")).cache ?? {};
function assemble(p) {
  const parts = []; const t = tags[p.id];
  if (t && t.category) parts.push(`分类：${t.category}`);
  const z = zh[p.id];
  if (z && z.translatedName && z.translatedName.trim()) parts.push(z.translatedName.trim());
  if (z && z.translatedDesc && z.translatedDesc.trim()) parts.push(z.translatedDesc.trim());
  parts.push(p.name); parts.push(p.description || "");
  const tagStr = ((t && t.tags) || []).filter(x => x && x.trim()).join(" ");
  if (tagStr) parts.push(`标签：${tagStr}`);
  return parts.join("\n").slice(0, 512);
}
const ex = await pipeline("feature-extraction", "Xenova/multilingual-e5-small", { dtype: "q8" });
console.log("model ready");
const vecs = []; let dim = 0;
for (let i = 0; i < pool.length; i += 16) {
  const b = pool.slice(i, i + 16).map(p => "passage: " + assemble(p));
  const o = await ex(b, { pooling: "mean", normalize: true });
  dim = o.dims.at(-1);
  for (let r = 0; r < b.length; r++) vecs.push(o.data.subarray(r * dim, (r + 1) * dim));
  if (i % 1024 === 0) console.log(`embed ${i}/${pool.length}`);
}
const perQuery = {};
for (const { q } of evalSet.queries) {
  const qo = await ex(["query: " + q], { pooling: "mean", normalize: true });
  const qv = qo.data;
  const sc = vecs.map((b, i) => { let s = 0; for (let d = 0; d < dim; d++) s += qv[d] * b[d]; return [pool[i].id, s]; });
  perQuery[q] = sc.filter(([, s]) => s >= 0.3).sort((a, b) => b[1] - a[1]).slice(0, 300).map(([id, s]) => [id, +s.toFixed(5)]);
  console.log("q done:", q, perQuery[q].length);
}
fs.writeFileSync(path.join(TASK, "eval-vec-cache.json"), JSON.stringify({ savedAt: new Date().toISOString(), dim, zhSource: "vault-runtime", perQuery }));
console.log("DONE eval-vec-cache.json");
