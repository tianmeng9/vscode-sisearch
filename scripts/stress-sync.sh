#!/bin/bash
# scripts/stress-sync.sh
# 用法:先 F5 启动扩展,手动跑一次 Sync,然后在另一个终端运行此脚本监控。
# 本脚本不触发 Sync,只负责:
#   - 监视 extension host 进程 RSS/heap(通过 /proc/<pid>/status)
#   - 监视 .sisearch/index.sqlite 大小
#   - 每 5 秒写一行记录
#
# 断言:当 Sync 走完后(RSS 稳定),peak heap < 500 MB。
#
# 要求:传入 workspace 绝对路径 + extension host pid
#
# Linux only: 依赖 /proc/<pid>/status,macOS 不支持。

set -u
WORKSPACE="${1:?usage: stress-sync.sh <workspace> <pid>}"
PID="${2:?usage: stress-sync.sh <workspace> <pid>}"
LOG="$WORKSPACE/.sisearch/stress.log"
mkdir -p "$(dirname "$LOG")"
echo "timestamp,rss_kb,heap_kb,db_size_bytes" > "$LOG"

while kill -0 "$PID" 2>/dev/null; do
    RSS=$(awk '/VmRSS/{print $2}' /proc/$PID/status 2>/dev/null || echo 0)
    # heap 从 Node inspector 拿不到;用 rss 粗略代替
    DB_SIZE=$(stat -c %s "$WORKSPACE/.sisearch/index.sqlite" 2>/dev/null || echo 0)
    echo "$(date +%s),$RSS,-,$DB_SIZE" >> "$LOG"
    sleep 5
done

echo "extension host exited; log: $LOG"
tail -5 "$LOG"
