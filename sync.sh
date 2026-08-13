#!/usr/bin/env bash
#
# sync.sh — 构建插件并同步到 Obsidian vault 的插件目录
#
# 用法:
#   ./sync.sh                    使用默认 vault（DEFAULT_VAULT）
#   ./sync.sh /path/to/vault     指定 vault 根目录（含 .obsidian 的目录）
#   ./sync.sh --no-build /path   跳过构建，只拷贝
#
set -euo pipefail

# ── 配置 ──
PLUGIN_ID="chinese-plugin-market"
DEFAULT_VAULT="/Users/pokerhu/Downloads/CJ/obsidian-vault"

# 需要同步的核心文件
# 注：本地语义/SQLite 的运行时（transformers/sql.js）已打包进 main.js，无需同步 node_modules。
# 仅需分发两个 WASM：sql-wasm（SQLite 引擎）、ort-wasm（本地模型 WASM 回退路径）。
FILES=(
	"main.js"
	"styles.css"
	"manifest.json"
	"plugin-tags.json"
	"plugin-recommend.json"
	"sql-wasm.wasm"
	"ort-wasm-simd-threaded.jsep.wasm"
	"embedding-worker.bundle.js"
	"seeded-translator-cache.json"
	"plugin-release-dates.json"
)

# ── 解析参数 ──
DO_BUILD=1
WITH_ML=0
VAULT=""

for arg in "$@"; do
	case "$arg" in
		--no-build)
			DO_BUILD=0
			;;
		--with-ml)
			# 本地 embedding 的 ML 运行时依赖（@huggingface/transformers + onnxruntime，数百 MB）。
			# 默认不同步（体积大、非必须；仅在需要本地向量搜索时显式启用）。
			WITH_ML=1
			;;
		-h|--help)
			grep '^#' "$0" | sed 's/^# \{0,1\}//'
			exit 0
			;;
		*)
			VAULT="$arg"
			;;
	esac
done

VAULT="${VAULT:-$DEFAULT_VAULT}"

# 脚本所在目录 = 源码根目录
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SRC_DIR"

# ── 校验 vault ──
if [ ! -d "$VAULT/.obsidian" ]; then
	echo "❌ 目标不是有效的 Obsidian vault（缺少 .obsidian 目录）:"
	echo "   $VAULT"
	exit 1
fi

DEST="$VAULT/.obsidian/plugins/$PLUGIN_ID"

# ── 构建 ──
if [ "$DO_BUILD" -eq 1 ]; then
	echo "🔨 构建中 (npm run build)..."
	npm run build
	echo "✅ 构建完成"
else
	echo "⏭  跳过构建 (--no-build)"
fi

# ── 拷贝 ──
mkdir -p "$DEST"
echo "📦 同步到: $DEST"

for f in "${FILES[@]}"; do
	if [ -f "$SRC_DIR/$f" ]; then
		cp "$SRC_DIR/$f" "$DEST/"
		printf "   ✓ %s\n" "$f"
	else
		printf "   ⚠ 跳过（源文件不存在）: %s\n" "$f"
	fi
done

# ── 本地能力说明 ──
# transformers/sql.js 已打包进 main.js（无需同步 node_modules）。
# sql-wasm.wasm / ort-wasm 已在上方 FILES 列表同步。--with-ml 参数保留为兼容旧用法，无实际作用。
if [ "$WITH_ML" -eq 1 ]; then
	echo "   ℹ --with-ml 已不再需要：transformers/sql.js 已打包进 main.js，wasm 随 FILES 同步。"
fi

echo ""
echo "🎉 同步完成！"
echo "   下一步：在 Obsidian 中重载插件（关闭再开启，或 Reload app without saving）以加载新代码。"
