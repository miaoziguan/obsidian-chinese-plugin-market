#!/usr/bin/env node
/**
 * 幂等发布脚本：先判断 GitHub Release（按 tag 名）是否已存在，
 * 已存在则直接跳过，避免 `gh release create` 因同名 tag 重复而报错退出。
 *
 * 用法：
 *   node scripts/release.mjs            # 发布当前 manifest.json 版本
 *   node scripts/release.mjs 2.47.0     # 显式指定版本（仍会读 manifest 校对）
 *
 * 前置：已 `pnpm build` 产出 main.js；且已 `git push` 代码。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const run = (cmd, args, { allowFail = false } = {}) => {
  try {
    return execFileSync(cmd, args, { cwd: root, encoding: "utf8" }).trim();
  } catch (e) {
    if (allowFail) return null;
    console.error(`✗ 命令失败: ${cmd} ${args.join(" ")}`);
    console.error(e.stderr || e.message);
    process.exit(1);
  }
};

// 1. 取版本号
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const argVersion = process.argv[2];
const version = argVersion || manifest.version;
if (argVersion && argVersion !== manifest.version) {
  console.warn(`⚠ 参数版本 ${argVersion} 与 manifest.json 的 ${manifest.version} 不一致，以参数为准。`);
}

const tag = version;
console.log(`→ 目标版本: ${tag}`);

// 2. 判断是否已存在同名 release（幂等核心）
const existing = run("gh", ["release", "view", tag, "--json", "tagName"], { allowFail: true });
if (existing) {
  console.log(`✓ Release ${tag} 已存在，跳过创建（无需重复发布）。`);
  process.exit(0);
}

// 3. 防御：本地/远程 tag 已存在但 release 没有（极端情况），避免 git push 失败中断
const localTag = run("git", ["tag", "-l", tag], { allowFail: true });
if (!localTag) {
  run("git", ["tag", tag]);
  console.log(`→ 已创建本地 tag ${tag}`);
}

// 4. 确认构建产物存在
const assets = ["main.js", "manifest.json", "styles.css", "versions.json"];
for (const f of assets) {
  try {
    readFileSync(join(root, f));
  } catch {
    console.error(`✗ 缺少发布文件: ${f}（请先运行 pnpm build）`);
    process.exit(1);
  }
}

// 5. 推送 tag 并创建 release
run("git", ["push", "origin", tag]);
console.log(`→ 已推送 tag ${tag}`);

run("gh", [
  "release",
  "create",
  tag,
  "--title",
  tag,
  "--notes",
  `Release ${tag}`,
  ...assets,
]);
console.log(`✓ Release ${tag} 创建成功: https://github.com/miaoziguan/obsidian-chinese-plugin-market/releases/tag/${tag}`);
