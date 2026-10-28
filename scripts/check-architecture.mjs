#!/usr/bin/env node
/**
 * 架构守护装置 / Architecture Guard
 * ---------------------------------------------------------------------------
 * 把 `docs/ARCHITECTURE.md` 里写在文档中的七层单向依赖规则，变成可被 CI 判决的硬约束。
 * 在此之前，那条规则只存在于 markdown 里，违反它不会有任何信号。
 *
 * 判定三类违规：
 *   1. 分层方向违规 —— 下层 import 了上层（回指 / upward reference）
 *   2. 循环依赖    —— 模块之间存在 import 环（含经由同层的多跳环）
 *   3. 孤儿文件    —— 生产源文件从未被任何模块 import，且不是已知入口/测试目标
 *
 * 设计取舍：
 * - 零外部依赖（仅 Node 内建模块）：本机/无网络/无 pnpm 环境亦可运行，不增加依赖面。
 * - 静态解析 TypeScript 的 import 语句（含别名 @layer/* 与相对路径），不执行类型检查，
 *   因此是"快速粗筛"而非"编译器级精确"。误判面见文末 `--help`。
 * - 孤儿文件是候选清单而非错误：动态 import、模板字符串 import、esbuild entry
 *   都可能让它误报。故默认只 WARN，且支持在 ALLOWED_ORPHANS 白名单登记。
 *
 * 用法：
 *   node scripts/check-architecture.mjs           # 人类可读报告
 *   node scripts/check-architecture.mjs --json    # 机器可读
 *   node scripts/check-architecture.mjs --strict  # 孤儿也判失败（默认只警告）
 *
 * 退出码：0 = 无分层违规且无循环依赖；1 = 存在违规。
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const SRC = join(ROOT, "src");

/**
 * 层级位阶：数字越大越靠上。规则「只能向下依赖」= 目标位阶不得高于来源位阶。
 * 同层之间允许互相依赖（这是现状，ACCEPTED），只有"向上"才违规。
 * 依据 docs/ARCHITECTURE.md §一 的依赖方向图。
 */
const RANK = {
  shared: 1,
  data: 2,
  semantic: 3,
  translation: 3,
  domain: 4,
  ui: 5,
  app: 6,
};

/** 别名前缀 -> 层（与 tsconfig paths / vitest alias 保持一致） */
const ALIAS_TO_LAYER = {
  "@shared": "shared",
  "@data": "data",
  "@semantic": "semantic",
  "@translation": "translation",
  "@domain": "domain",
  "@ui": "ui",
  "@app": "app",
};

/** 已知入口 / 被 Obsidian 反射加载 / 由测试以非 import 方式消费的文件，豁免孤儿判定 */
const ALLOWED_ORPHANS = [
  "src/app/main.ts", // esbuild 打包入口
  "src/semantic/workers/embedding-worker.ts", // 独立 worker bundle 入口
  "src/shared/i18n.ts", // 若被大量引用则自动不算孤儿，列出仅为兜底
];

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const strict = args.includes("--strict");
const updateBaseline = args.includes("--update-baseline");

// ─────────────────────────────────────────────────────────────────────────────
// 1. 收集所有 TypeScript 源文件（生产代码，排除 *.test.ts）
// ─────────────────────────────────────────────────────────────────────────────
function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) acc.push(p);
  }
  return acc;
}

const allFiles = walk(SRC);
const prodFiles = allFiles.filter((f) => !f.endsWith(".test.ts"));
const testFiles = allFiles.filter((f) => f.endsWith(".test.ts"));

/** 模块所属的层 */
function layerOfFile(abs) {
  const rel = relative(SRC, abs);
  const layer = rel.split(sep)[0];
  return layer in RANK ? layer : null;
}

/**
 * 把一个文件切分为 import/export 语句块，并识别其中的模块说明符。
 *
 * 关键设计：区分「类型边」与「运行时边」。
 *   - `import type {X} from "y"` / `export type {X} from "y"`  → type-only 边
 *   - `import {type X, Y} from "y"`（混合）                    → 保守判定为运行时边
 *   - `import("y")` 动态导入                                   → 运行时边
 * 类型边在编译后被完全擦除，不产生运行时初始化顺序约束，因此：
 *   · 运行时环 = 真正的循环依赖风险（初始化顺序、TDZ、打包困惑）
 *   · 类型环   = 架构味道，但不是缺陷
 * 把二者混为一谈会大量虚报。故分别统计、分别报告。
 */
function parseImports(src) {
  const out = [];
  // 按语句起点切块：`import` / `export` 位于行首（可含缩进）
  const stmtRe = /(?:^|\n)\s*((?:import|export)\b[\s\S]*?)(?=\n\s*(?:import|export)\b|$)/g;
  let m;
  while ((m = stmtRe.exec(src)) !== null) {
    const block = m[1];
    const spec = /from\s*["']([^"']+)["']/.exec(block) ?? /^import\s*["']([^"']+)["']/.exec(block);
    if (!spec) continue;
    const target = spec[1];
    const isTypeOnly = /^(?:import|export)\s+type\b/.test(block.trim());
    out.push({ target, kind: isTypeOnly ? "type" : "value" });
  }
  // 动态 import(...) 与 require(...) —— 一律视为运行时边
  const dynRe = /import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;
  let d;
  while ((d = dynRe.exec(src)) !== null) {
    out.push({ target: d[1] ?? d[2], kind: "value" });
  }
  return out;
}

/** 把 import 说明符解析成项目内的绝对路径；非项目内返回 null */
function resolveSpecifier(spec, importer) {
  if (spec.startsWith(".")) return resolve(dirname(importer), spec) + ".ts";
  const alias = spec.split("/")[0];
  if (ALIAS_TO_LAYER[alias]) {
    const rest = spec.slice(alias.length).replace(/^\//, "");
    return join(SRC, ALIAS_TO_LAYER[alias], rest) + ".ts";
  }
  return null; // obsidian / node_modules 等外部依赖，不参与分层判定
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 构建依赖图
// ─────────────────────────────────────────────────────────────────────────────
const graph = new Map(); // abs -> Map<abs, "type" | "value">（全部边）
const runtimeGraph = new Map(); // abs -> Set<abs>（仅运行时边，用于判定真正的循环依赖）
const referenced = new Set(); // 被任何文件 import 的文件集合

for (const f of allFiles) {
  const src = readFileSync(f, "utf8");
  const deps = new Map();
  const rt = new Set();
  for (const { target, kind } of parseImports(src)) {
    const abs = resolveSpecifier(target, f);
    if (!abs) continue;
    // 同一 target 若同时存在类型边与值边，值边优先（更严格的那一方）
    if (kind === "value" || !deps.has(abs)) deps.set(abs, kind);
    if (kind === "value") rt.add(abs);
    referenced.add(abs);
  }
  graph.set(f, deps);
  runtimeGraph.set(f, rt);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 违规判定 A：分层方向（下层不允许 import 上层）
// ─────────────────────────────────────────────────────────────────────────────
const rel = (abs) => relative(ROOT, abs);
const layerViolations = [];

for (const [from, deps] of graph) {
  if (from.endsWith(".test.ts")) continue; // 测试不受层约束（可跨层间接 pénétrate）
  const fromLayer = layerOfFile(from);
  if (!fromLayer) continue;
  for (const [dep, kind] of deps) {
    const toLayer = layerOfFile(dep);
    if (!toLayer || !(toLayer in RANK)) continue;
    if (RANK[toLayer] > RANK[fromLayer]) {
      layerViolations.push({
        from: rel(from),
        fromLayer,
        to: rel(dep),
        toLayer,
        rankFrom: RANK[fromLayer],
        rankTo: RANK[toLayer],
        kind,
      });
    }
  }
}
// 运行时向上依赖是硬缺陷（破坏打包与初始化顺序）；类型向上依赖只是架构味道
const runtimeViolations = layerViolations.filter((v) => v.kind === "value");
const typeViolations = layerViolations.filter((v) => v.kind === "type");

// ─────────────────────────────────────────────────────────────────────────────
// 4. 违规判定 B：循环依赖（Tarjan 强连通分量，>1 节点的 SCC 即为环）
// ─────────────────────────────────────────────────────────────────────────────
function findCycles(g) {
  /** 邻居取值器：兼容 Set / Map 两种图表示 */
  const nb = (v) => {
    const x = g.get(v);
    if (!x) return [];
    return x instanceof Map ? [...x.keys()] : [...x];
  };
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const cycles = [];
  let counter = 0;

  function strongconnect(v) {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);

    for (const w of nb(v)) {
      if (!g.has(w)) continue; // 指向不存在的文件（可能已删除），忽略
      if (!index.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1) {
        // SCC 内部即为互相可达的环；给出环的路径顺序以便定位
        cycles.push(component.map(rel).sort());
      }
    }
  }

  for (const v of g.keys()) if (!index.has(v)) strongconnect(v);
  return cycles;
}

const runtimeCycles = findCycles(runtimeGraph);
const allCycles = findCycles(graph);
// 仅由类型边构成的环：参与与否决定它是不是真正的初始化风险
const key = (c) => c.join("|");
const rtKeys = new Set(runtimeCycles.map(key));
const typeCycles = allCycles.filter((c) => !rtKeys.has(key(c)));

// ─────────────────────────────────────────────────────────────────────────────
// 5. 违规判定 C：孤儿文件（未被任何模块 import 的生产源文件）
// ─────────────────────────────────────────────────────────────────────────────
const orphans = prodFiles
  .filter((f) => !referenced.has(f))
  .filter((f) => !ALLOWED_ORPHANS.includes(rel(f)))
  .map((f) => ({
    file: rel(f),
    layer: layerOfFile(f),
    bytes: statSync(f).size,
  }))
  .sort((a, b) => b.bytes - a.bytes);

// ─────────────────────────────────────────────────────────────────────────────
// 6. 基线棘轮（Baseline Ratchet）
// ---------------------------------------------------------------------------
// 门禁的第一天就必须是绿的，否则团队学到的第一件事就是关掉它。
// 但这里历史违规有 8 处运行时向上依赖 + 1 组运行时环，直接接 CI 会永久红灯。
// 解法是「基线」：把存量违规记录在 scripts/arch-baseline.json，此后——
//   · 基线内的违规：允许存在，不计失败（但会展示，提醒去还债）
//   · 基线外的新增违规：立即 FAIL（这才是门禁真正的作用）
//   · 基线里已消失的项：提示「可缩小基线」，形成只减不增的棘轮
// 这与 vitest.config.ts 中 coverage thresholds 用同一个设计模式。
// ─────────────────────────────────────────────────────────────────────────────
const BASELINE_PATH = join(ROOT, "scripts", "arch-baseline.json");
const vioKey = (v) => `${v.from}->${v.to}`;
const cycKey = (c) => [...c].sort().join("|");

function readBaseline() {
  try {
    const b = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    return {
      runtimeViolations: new Set(b.runtimeViolations ?? []),
      typeViolations: new Set(b.typeViolations ?? []),
      runtimeCycles: new Set(b.runtimeCycles ?? []),
      typeCycles: new Set(b.typeCycles ?? []),
    };
  } catch {
    return null; // 无基线文件：按最严格口径判定
  }
}

if (updateBaseline) {
  const payload = {
    generatedAt: new Date().toISOString(),
    note: "存量违规快照。请逐一修复并从此文件删除对应条目，使棘轮只减不增。",
    runtimeViolations: runtimeViolations.map(vioKey),
    typeViolations: typeViolations.map(vioKey),
    runtimeCycles: runtimeCycles.map(cycKey),
    typeCycles: typeCycles.map(cycKey),
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`✅ 已写入基线 ${relative(ROOT, BASELINE_PATH)}`);
  console.log(
    `   运行时向上 ${payload.runtimeViolations.length} · 类型向上 ${payload.typeViolations.length} · 运行时环 ${payload.runtimeCycles.length} · 类型环 ${payload.typeCycles.length}`,
  );
  process.exit(0);
}

const baseline = readBaseline();
const isKnown = (set, k) => set?.has(k) ?? false;

const newRuntimeViolations = runtimeViolations.filter((v) => !isKnown(baseline?.runtimeViolations, vioKey(v)));
const newTypeViolations = typeViolations.filter((v) => !isKnown(baseline?.typeViolations, vioKey(v)));
const newRuntimeCycles = runtimeCycles.filter((c) => !isKnown(baseline?.runtimeCycles, cycKey(c)));
const newTypeCycles = typeCycles.filter((c) => !isKnown(baseline?.typeCycles, cycKey(c)));

/** 基线中已修复、应当被移除的条目（棘轮收紧的提示） */
const staleRuntime = baseline ? [...baseline.runtimeViolations].filter((k) => !runtimeViolations.some((v) => vioKey(v) === k)) : [];
const staleRuntimeCycles = baseline ? [...baseline.runtimeCycles].filter((k) => !runtimeCycles.some((c) => cycKey(c) === k)) : [];

// ─────────────────────────────────────────────────────────────────────────────
// 7. 报告
// ─────────────────────────────────────────────────────────────────────────────
// 只有「新增」的运行时违规与循环计入失败。类型级违规始终仅告警（加 --strict 才升级）。
// 这样装置在第一天就是绿的，却从此不允许架构继续劣化。
const failed =
  newRuntimeViolations.length > 0 ||
  newRuntimeCycles.length > 0 ||
  (strict && (newTypeViolations.length > 0 || newTypeCycles.length > 0 || orphans.length > 0));

if (asJson) {
  console.log(
    JSON.stringify(
      {
        scannedFiles: allFiles.length,
        prodFiles: prodFiles.length,
        testFiles: testFiles.length,
        hasBaseline: baseline != null,
        runtimeViolations,
        typeViolations,
        runtimeCycles,
        typeCycles,
        newRuntimeViolations: newRuntimeViolations.map(vioKey),
        newRuntimeCycles: newRuntimeCycles.map(cycKey),
        staleBaselineEntries: [...staleRuntime, ...staleRuntimeCycles],
        orphans,
        verdict: failed ? "FAIL" : "PASS",
      },
      null,
      2,
    ),
  );
  process.exit(failed ? 1 : 0);
}

const line = "─".repeat(78);
console.log("\n架构守护装置 / Architecture Guard");
console.log(line);
console.log(`扫描：生产文件 ${prodFiles.length} 个，测试文件 ${testFiles.length} 个`);
console.log(`层级位阶：app(6) > ui(5) > domain(4) > translation|semantic(3) > data(2) > shared(1)\n`);

const tag = (isNew) => (isNew ? "[新增 ✗]" : "[存量 ·]");

console.log(
  `【A】分层方向违规：运行时 ${runtimeViolations.length} 处（其中新增 ${newRuntimeViolations.length}）· 类型级 ${typeViolations.length} 处（新增 ${newTypeViolations.length}）`,
);
console.log(line);
console.log(`  基线：${baseline ? "已加载 scripts/arch-baseline.json" : "⚠️  未找到基线，按最严格口径判定"}`);
console.log("\n  运行时向上依赖（编译后仍存在，影响打包/初始化顺序）：");
if (runtimeViolations.length === 0) console.log("    ✅ 无");
for (const v of runtimeViolations) {
  console.log(`    ${tag(newRuntimeViolations.includes(v))} ${v.from}`);
  console.log(`              → ${v.to}   (${v.fromLayer}[${v.rankFrom}] ↗ ${v.toLayer}[${v.rankTo}])`);
}
console.log("\n  类型级向上依赖（编译后擦除，不改渲染行为，但违反文档声明）：");
if (typeViolations.length === 0) console.log("    ✅ 无");
for (const v of typeViolations) {
  console.log(`    ${tag(newTypeViolations.includes(v))} ${v.from}`);
  console.log(`              → ${v.to}   (${v.fromLayer}[${v.rankFrom}] ↗ ${v.toLayer}[${v.rankTo}]) [type-only]`);
}

console.log(
  `\n【B】循环依赖：运行时环 ${runtimeCycles.length} 组（新增 ${newRuntimeCycles.length}）· 类型环 ${typeCycles.length} 组`,
);
console.log(line);
console.log("  运行时环（真正的初始化顺序风险）：");
if (runtimeCycles.length === 0) {
  console.log("    ✅ 无环");
} else {
  for (const c of runtimeCycles) {
    console.log(`    ${tag(newRuntimeCycles.includes(c))} ${c.length} 个文件成环：`);
    console.log(`        ${c.join("\n        ↔ ")}`);
  }
}
console.log("  类型环（编译后消失，仅作参考）：");
if (typeCycles.length === 0) {
  console.log("    ✅ 无");
} else {
  for (const c of typeCycles) {
    const isNew = newTypeCycles.includes(c);
    console.log(`    ${tag(isNew)} ${c.length} 个文件：${c.join(" ↔ ")}`);
  }
}

if (staleRuntime.length > 0 || staleRuntimeCycles.length > 0) {
  console.log(`\n【B+】棘轮收紧提示：基线中 ${staleRuntime.length + staleRuntimeCycles.length} 项已被修复`);
  console.log(line);
  console.log("  这些条目仍留在基线文件里。请执行 --update-baseline 将其移除，让门禁更严格：");
  for (const k of [...staleRuntime, ...staleRuntimeCycles]) console.log(`    ↘ ${k}`);
}

console.log(`\n【C】孤儿文件（无人 import 的生产源文件）：${orphans.length} 个`);
console.log(line);
if (orphans.length === 0) {
  console.log("  ✅ 无。");
} else {
  console.log("  ⚠️  候选清单（可能含动态 import / 构建 entry 导致的误报，需人工确认后登记白名单）：");
  for (const o of orphans) {
    console.log(`     ${String(Math.round(o.bytes / 1024)).padStart(4)}KB  [${o.layer}]  ${o.file}`);
  }
}

console.log(`\n${line}`);
console.log(`判决：${failed ? "❌ FAIL" : "✅ PASS"}  (退出码 ${failed ? 1 : 0})`);
if (!failed && orphans.length > 0) console.log("注：孤儿文件仅告警，加 --strict 才会计入失败。");
console.log(line);
console.log(
  "\n已知局限（勿据此断言不存在问题）：\n" +
    "  · 只识别字面量 import；动态拼接路径无法解析 → 孤儿与循环都可能漏报。\n" +
    "  · 类型/run-time 的判定基于 import 语句形态（`import type` 前缀），未经 TypeScript\n" +
    "    编译器确认：`import { type A, B }` 这类混合形式按更严格的运行时边处理（保守）。\n" +
    "  · 测试文件不参与分层判定：测试天然允许跨层，此乃刻意为之。\n" +
    "  · 除 WELL-KNOWN 入口外，未排除环境反射加载（如 Obsidian registerView 反射构造），\n" +
    "    若某文件只被反射加载，会在【C】误报——此时请登记 ALLOWED_ORPHANS 而非删除代码。\n",
);

process.exit(failed ? 1 : 0);
