/**
 * 构建期脚本：解析每个 Obsidian 社区插件「首次进入市场」的真实日期。
 *
 * 数据源：obsidianmd/obsidian-releases 仓库的 community-plugins.json 文件历史
 *   （每个插件 id 第一次出现在该文件中的 commit 时间 = 其在官方市场「上线」的真实时间）。
 *
 * 输出：plugin-release-dates.json —— `{ "<plugin-id>": <首次上线 Unix 秒>, ... }`
 *   随插件分发（与 plugin-tags.json 同目录），运行时按 firstListedAt 筛选「上线」维度。
 *
 * 用法：
 *   node scripts/gen-release-dates.mjs [--repo <path>] [--out <path>]
 *   - 不传 --repo：脚本临时克隆 obsidian-releases 到系统临时目录（需网络，走 HTTPS_PROXY）
 *   - 传 --repo <path>：复用已克隆的本地仓库（离线构建，CI 缓存友好）
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_URL = "https://github.com/obsidianmd/obsidian-releases.git";
const FILE = "community-plugins.json";

function parseArgs(argv) {
  let repo = null;
  let out = "plugin-release-dates.json";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo") repo = argv[++i];
    else if (argv[i] === "--out") out = argv[++i];
  }
  return { repo, out: resolve(process.cwd(), out) };
}

/** 运行 git 命令，返回 stdout 字符串 */
function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** 取某 commit 时刻的 community-plugins.json 内容（不 checkout 工作区） */
function showFileAt(cwd, hash) {
  try {
    return git(cwd, ["show", `${hash}:${FILE}`]);
  } catch {
    return null;
  }
}

/** 从 community-plugins.json 文本解析插件 id 列表 */
function parseIds(text) {
  try {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) return [];
    return arr.map((e) => (e && typeof e.id === "string" ? e.id : "")).filter(Boolean);
  } catch {
    return [];
  }
}

function ensureLocalRepo(repoArg) {
  if (repoArg) {
    if (!existsSync(repoArg)) throw new Error(`--repo 指定的路径不存在：${repoArg}`);
    return { cwd: repoArg, cleanup: () => {} };
  }
  const dir = mkdtempSync(join(tmpdir(), "or-releases-"));
  console.log(`[gen-release-dates] 临时克隆 obsidian-releases → ${dir}`);
  git(dir, ["clone", "--filter=blob:none", REPO_URL, "."]);
  return { cwd: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function main() {
  const { repo, out } = parseArgs(process.argv.slice(2));
  const { cwd, cleanup } = ensureLocalRepo(repo);
  try {
    // 最老 → 最新 遍历所有改动 community-plugins.json 的 commit（含重命名历史 --follow）
    const log = git(cwd, [
      "log",
      "--all",
      "--follow",
      "--reverse",
      "--format=%H %ct",
      "--",
      FILE,
    ]).trim();

    const commits = log
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const sp = line.indexOf(" ");
        return { hash: line.slice(0, sp), ts: Number(line.slice(sp + 1)) };
      })
      .filter((c) => c.hash && Number.isFinite(c.ts));

    console.log(`[gen-release-dates] 共 ${commits.length} 个提交改动 ${FILE}`);

    const firstSeen = new Map(); // id → Unix 秒
    let processed = 0;

    for (const { hash, ts } of commits) {
      const text = showFileAt(cwd, hash);
      if (text == null) continue;
      const ids = parseIds(text);
      for (const id of ids) {
        if (!firstSeen.has(id)) firstSeen.set(id, ts); // 首次出现 → 记录上线时间
      }
      processed++;
      if (processed % 500 === 0) {
        console.log(`  …已处理 ${processed}/${commits.length}，已记录 ${firstSeen.size} 个插件`);
      }
    }

    const outObj = {};
    for (const [id, ts] of firstSeen) outObj[id] = ts;

    writeFileSync(out, JSON.stringify(outObj));
    console.log(
      `[gen-release-dates] ✅ 写出 ${Object.keys(outObj).length} 个插件上线日期 → ${out}`,
    );
  } finally {
    cleanup();
  }
}

main();
