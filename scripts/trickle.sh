#!/bin/bash
# 切香肠 trickle：把剩余插件分块连续扫描，单个后台进程自主推进。
# 依赖 gen-plugin-deps.mjs 的「已处理旁路 + 周期性落盘」，任意中断后重跑同块即可续。
set -u
cd /Users/pokerhu/Downloads/obsidian-plugin-translator
export HTTPS_PROXY=http://127.0.0.1:7890
LOG=/tmp/trickle.log
START=4500
STEP=200
END=7200
L=$START
echo "=== trickle start $(date), L from $START to $END ===" | tee -a "$LOG"
while [ "$L" -le "$END" ]; do
  echo "=== chunk limit=$L $(date) ===" | tee -a "$LOG"
  node scripts/gen-plugin-deps.mjs --only-new --limit "$L" 2>&1 \
    | grep -v -e ExperimentalWarning -e trace-warnings | tee -a "$LOG"
  SIDE=$(wc -l < plugin-deps-processed.json 2>/dev/null || echo 0)
  echo "=== done limit=$L sidecar=$SIDE $(date) ===" | tee -a "$LOG"
  L=$((L + STEP))
  sleep 10
done
echo "=== TRICKLE COMPLETE $(date) ===" | tee -a "$LOG"
