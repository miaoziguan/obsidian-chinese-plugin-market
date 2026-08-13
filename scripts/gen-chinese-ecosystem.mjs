/**
 * 构建期脚本：生成「中文生态」插件清单（plugin-chinese-ecosystem.json）。
 *
 * 数据源：obsidian-releases 的 community-plugins.json（官方清单）。
 * 判定（C 方案，先粗后精的粗层，与 src/domain/recommend/chinese-ecosystem.ts 同逻辑）：
 *   1. author/name 含汉字
 *   2. description 含中文
 *   3. author 首 token 命中常见中文姓氏拼音
 * 人工精修：产出文件后人工核对，把漏网/误判以 `{ id: true }` 直接补进 JSON。
 *
 * 用法：
 *   node scripts/gen-chinese-ecosystem.mjs [--out <path>]
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const PLUGINS_URL = "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json";
const OUT = process.argv.includes("--out")
  ? resolve(process.cwd(), process.argv[process.argv.indexOf("--out") + 1])
  : resolve(process.cwd(), "plugin-chinese-ecosystem.json");

const SURNAME = new Set(
  "li wang zhang chen liu yang zhao huang wu zhou xu sun ma zhu hu guo lin he gao luo zheng liang xie song tang han deng feng ceng peng cao yuan ding pan jiang du ye su wei cheng lu ren cui shen fan fang shi yao tan liao zou xiong jin qin hao ran fu bai xiao qiu chao neng jiao yu".split(" ")
);

const containsHan = (s) => /[\u4e00-\u9fff]/.test(s ?? "");
const isPinyin = (author) => {
  const first = String(author ?? "").split(/[\s\-_]+/)[0]?.toLowerCase();
  return SURNAME.has(first);
};
const isEco = (p) =>
  containsHan(p.author) || containsHan(p.name) || containsHan(p.description) || isPinyin(p.author);

// 本机直连 GitHub 常超时：优先走系统代理（Clash 类 127.0.0.1:7890），可被 env 覆盖
const PROXY = process.env.HTTPS_PROXY || "http://127.0.0.1:7890";
const args = ["-fsSL", "--connect-timeout", "10"];
try {
  args.push("-x", PROXY);
  execFileSync("curl", ["-fsSL", "--connect-timeout", "5", "-x", PROXY, "-o", "/dev/null", PLUGINS_URL]);
} catch {
  // 代理不可达时退化为直连（部分网络环境直连可通）
  args.splice(0, args.length, "-fsSL", "--connect-timeout", "10");
}
const raw = execFileSync("curl", [...args, PLUGINS_URL], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const list = JSON.parse(raw);

const out = {};
let hit = 0;
for (const p of list) {
  if (!p?.id) continue;
  if (isEco(p)) {
    out[p.id] = true;
    hit++;
  }
}
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`✅ 生成 ${OUT}：${hit}/${list.length} 个插件命中中文生态信号`);
