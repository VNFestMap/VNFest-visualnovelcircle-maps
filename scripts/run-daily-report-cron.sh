#!/usr/bin/env bash
# 每日日报定时抓取包装器
#
# 该脚本供服务器 cron 调用，不把 Notion token 写入仓库。
# 默认从 /etc/vnfest/daily-report.env 读取配置；该文件应由 root 创建，
# 并设置为 root:www 0640，使 www 定时任务可读但不对其他用户开放。
#
# 可选配置：
#   NOTION_TOKEN           Notion 内部集成密钥（必填）
#   NOTION_PAGE_IDS        逗号分隔的页面 ID（可选）
#   DAILY_REPORT_LOG_FILE  日志文件路径（可选）
#   NODE_BIN               Node.js 路径（可选）

set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${DAILY_REPORT_ENV_FILE:-/etc/vnfest/daily-report.env}"

if [ ! -r "$ENV_FILE" ]; then
  printf '[daily-report] ERROR: 配置文件不可读：%s\n' "$ENV_FILE" >&2
  exit 2
fi

# 配置文件由管理员维护，允许其中的变量自动导出给 Node.js。
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

LOG_FILE="${DAILY_REPORT_LOG_FILE:-$PROJECT_ROOT/logs/daily-report-fetch.log}"
LOG_DIR="$(dirname -- "$LOG_FILE")"
mkdir -p -- "$LOG_DIR"
touch -- "$LOG_FILE"
chmod 0640 -- "$LOG_FILE" 2>/dev/null || true
exec >>"$LOG_FILE" 2>&1

timestamp() { date '+%Y-%m-%d %H:%M:%S %z'; }
log() { printf '[%s] %s\n' "$(timestamp)" "$*"; }

if [ -z "${NOTION_TOKEN:-}" ]; then
  log "ERROR: NOTION_TOKEN 未配置，跳过本次抓取。请在 $ENV_FILE 中配置后重试。"
  exit 2
fi

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
FETCH_SCRIPT="$PROJECT_ROOT/scripts/fetch-daily-notion.mjs"
TEST_SCRIPT="$PROJECT_ROOT/scripts/test-daily-notion-contract.mjs"
DATA_FILE="$PROJECT_ROOT/wiki/daily/data/reports.json"
LOCK_FILE="${DAILY_REPORT_LOCK_FILE:-/tmp/vnfest-daily-report.lock}"

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  log "ERROR: 找不到可执行的 Node.js：${NODE_BIN:-未设置}"
  exit 2
fi
for required in "$FETCH_SCRIPT" "$TEST_SCRIPT"; do
  if [ ! -f "$required" ]; then
    log "ERROR: 缺少日报脚本：$required"
    exit 2
  fi
done

# 同一时间只允许一个抓取任务，避免手动执行与 cron 重叠写入 JSON。
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log '已有日报抓取任务运行，本次跳过。'
  exit 0
fi

run_node() {
  if command -v timeout >/dev/null 2>&1; then
    timeout --foreground 15m "$NODE_BIN" "$@"
  else
    "$NODE_BIN" "$@"
  fi
}

backup_file=""
had_data=0
restore_data() {
  if [ "$had_data" -eq 1 ] && [ -n "$backup_file" ] && [ -f "$backup_file" ]; then
    cp -- "$backup_file" "$DATA_FILE"
    chmod 0644 -- "$DATA_FILE" 2>/dev/null || true
    log '检测失败，已恢复抓取前的日报数据。'
  elif [ "$had_data" -eq 0 ]; then
    rm -f -- "$DATA_FILE"
    log '检测失败，已移除本次新建的日报数据。'
  fi
}
cleanup() {
  if [ -n "$backup_file" ]; then
    rm -f -- "$backup_file"
  fi
}
trap cleanup EXIT

if [ -f "$DATA_FILE" ]; then
  backup_file="$(mktemp "${TMPDIR:-/tmp}/vnfest-daily-reports.XXXXXX")"
  cp -- "$DATA_FILE" "$backup_file"
  had_data=1
fi

log '开始从 Notion 抓取日报。'
# 让抓取脚本直接读取 NOTION_PAGE_IDS；不要转成命令行参数，否则会关闭
# 抓取脚本默认的「按上海时区自动发现当天页面」模式。
if ! run_node "$FETCH_SCRIPT"; then
  log 'ERROR: Notion 抓取失败。'
  restore_data
  exit 1
fi

log '开始执行日报数据契约测试。'
if ! run_node "$TEST_SCRIPT"; then
  log 'ERROR: 抓取结果未通过契约测试。'
  restore_data
  exit 1
fi

# Node 写入新文件时使用当前用户（通常是 www），显式保证 Web 进程可读。
chmod 0644 -- "$DATA_FILE"
log '日报抓取和校验完成。'
