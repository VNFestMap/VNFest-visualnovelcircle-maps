#!/usr/bin/env bash
# ============================================================
# deploy.sh — VNFmap Go 生产预检与发布辅助脚本
# ============================================================
# 默认只执行可审计的预检、备份、容器更新和 migration verify。
# 它不会自动 git pull/stash/reset，不会删除历史备份，也不会修改 Nginx。
# 一次性 upstream 切换必须按 GO_MIGRATION_RUNBOOK.md 人工执行。
#
# 用法:
#   ./scripts/deploy.sh                 # 预检、备份、更新 Go 容器、迁移并验证
#   ./scripts/deploy.sh -n              # 干跑，不写数据库/文件/容器
#   ./scripts/deploy.sh -s              # 明确跳过备份（不建议生产使用）
#   ./scripts/deploy.sh -h              # 显示帮助
# ============================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${CYAN}[deploy]${NC} $*"; }
ok()   { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
fail() { echo -e "${RED}[✗]${NC} $*"; exit 1; }

DRY_RUN=false
SKIP_BACKUP=false
while getopts "nsh" opt; do
  case "$opt" in
    n) DRY_RUN=true ;;
    s) SKIP_BACKUP=true ;;
    h)
      echo "用法: $0 [-n] [-s]"
      echo "  -n  干跑模式"
      echo "  -s  跳过备份（生产环境禁止使用，除非已有可核验的一致性快照）"
      exit 0 ;;
    *) exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_PATH="${DEPLOY_PATH:-$PROJECT_ROOT}"
COMPOSE_BIN="${COMPOSE_BIN:-docker compose}"
BACKUP_ROOT="${BACKUP_ROOT:-$DEPLOY_PATH/../backups/vnfest}"
MYSQLDUMP_BIN="${MYSQLDUMP_BIN:-mysqldump}"

# Read a small allowlist from the dotenv file without sourcing arbitrary shell
# code. Values are kept in memory and are never echoed. Explicitly exported
# environment variables win over values from .env.
dotenv_value() {
  local key="$1" line value
  line="$(grep -E "^${key}=" .env | tail -n 1 || true)"
  [ -n "$line" ] || return 0
  value="${line#*=}"
  value="${value%$'\r'}"
  case "$value" in
    \"*\") value="${value:1:${#value}-2}" ;;
    \'*\') value="${value:1:${#value}-2}" ;;
  esac
  printf '%s' "$value"
}

configured_value() {
  local key="$1" value="${!1-}"
  if [ -n "$value" ]; then
    printf '%s' "$value"
  else
    dotenv_value "$key"
  fi
}

run_compose() {
  local -a compose_files=(-f docker-compose.yml)
  if [ "$(configured_value APP_ENV)" = "production" ] && [ -f docker-compose.production.yml ]; then
    compose_files+=(-f docker-compose.production.yml)
  fi
  # shellcheck disable=SC2086
  $COMPOSE_BIN "${compose_files[@]}" "$@"
}

phase_preflight() {
  log "阶段 1/5: Go 发布前置检查..."
  cd "$DEPLOY_PATH"
  [ -f .env ] || fail ".env 不存在；请按 .env.example 配置服务器 Secret"
  [ -d data ] || fail "data/ 目录不存在"
  [ -d uploads ] || fail "uploads/ 目录不存在"
  [ -d wiki/uploads ] || fail "wiki/uploads/ 目录不存在"
  command -v docker >/dev/null 2>&1 || fail "docker 不可用"
  run_compose config --quiet || fail "docker compose 配置无效"
  if grep -Eq '(^|[[:space:]])php([[:space:]]|$)|php-fpm|apache2|httpd' docker-compose.yml .github/workflows/deploy.yml; then
    fail "Go 正式发布配置仍包含 PHP/Apache 启动依赖"
  fi
  ok "Go compose/CI 配置和持久化目录检查通过"
}

phase_backup() {
  log "阶段 2/5: 生成数据库、JSON 和上传文件快照..."
  if [ "$SKIP_BACKUP" = true ]; then
    warn "已明确跳过备份；生产零丢失门禁由操作者自行提供外部快照证明"
    return
  fi
  local stamp backup_dir
  stamp="$(date +%Y%m%d%H%M%S)"
  backup_dir="$BACKUP_ROOT/$stamp"
  if [ "$DRY_RUN" = true ]; then
    log "[干跑] 将写入 $backup_dir"
    return
  fi
  mkdir -p "$backup_dir"
  run_compose run --rm app vnfest-migrate --snapshot > "$backup_dir/snapshot.before.json"
  sha256sum "$backup_dir/snapshot.before.json" > "$backup_dir/snapshot.before.json.sha256"
  tar -czf "$backup_dir/files.before.tar.gz" data uploads wiki/uploads
  sha256sum "$backup_dir/files.before.tar.gz" > "$backup_dir/files.before.tar.gz.sha256"

  local app_env db_driver
  app_env="$(configured_value APP_ENV)"
  db_driver="$(configured_value DB_DRIVER)"
  app_env="${app_env:-development}"
  db_driver="${db_driver:-sqlite}"

  if [ "$app_env" = "production" ] && [ "$db_driver" != "mysql" ]; then
    fail "APP_ENV=production 必须使用 DB_DRIVER=mysql；拒绝在未确认数据库类型时继续"
  fi

  # 使用临时 defaults 文件，避免把 DB 密码放进命令行或日志。生产
  # MySQL 备份失败时立即停止，不允许用不完整快照继续迁移。
  if [ "$db_driver" = "mysql" ]; then
    command -v "$MYSQLDUMP_BIN" >/dev/null 2>&1 || fail "MySQL 环境缺少 mysqldump: $MYSQLDUMP_BIN"
    local defaults_file
    local db_host db_port db_name db_user db_pass
    db_host="$(configured_value DB_HOST)"; db_host="${db_host:-127.0.0.1}"
    db_port="$(configured_value DB_PORT)"; db_port="${db_port:-3306}"
    db_name="$(configured_value DB_NAME)"
    db_user="$(configured_value DB_USER)"
    db_pass="$(configured_value DB_PASS)"
    [ -n "$db_name" ] || fail "MySQL 备份缺少 DB_NAME（仅从环境变量或 .env 读取）"
    [ -n "$db_user" ] || fail "MySQL 备份缺少 DB_USER（仅从环境变量或 .env 读取）"
    defaults_file="$(mktemp "$backup_dir/mysql-defaults.XXXXXX")"
    chmod 600 "$defaults_file"
    trap 'rm -f "$defaults_file"' RETURN
    printf '[client]\nhost=%s\nport=%s\nuser=%s\npassword=%s\n' \
      "$db_host" "$db_port" "$db_user" "$db_pass" > "$defaults_file"
    "$MYSQLDUMP_BIN" --defaults-extra-file="$defaults_file" --single-transaction --routines --triggers \
      "$db_name" > "$backup_dir/mysql.before.sql"
    sha256sum "$backup_dir/mysql.before.sql" > "$backup_dir/mysql.before.sql.sha256"
    rm -f "$defaults_file"
    trap - RETURN
  else
    warn "未执行 mysqldump；请确认这是 SQLite 隔离环境或外部已完成 MySQL 快照"
  fi
  ok "快照完成: $backup_dir（不自动清理历史备份）"
}

phase_release() {
  log "阶段 3/5: 构建/更新 Go 容器..."
  if [ "$DRY_RUN" = true ]; then
    log "[干跑] 将执行 docker compose build app && docker compose up -d app"
    return
  fi
  run_compose build app
  run_compose up -d app
  ok "Go 容器已启动；Nginx upstream 仍需按 runbook 人工确认后切换"
}

phase_migrate() {
  log "阶段 4/5: 执行版本化 migration 并验证..."
  if [ "$DRY_RUN" = true ]; then
    log "[干跑] 将执行 vnfest-migrate --dry-run/--apply/--verify"
    return
  fi
  run_compose run --rm --entrypoint /usr/local/bin/vnfest-migrate app --config-check
  run_compose run --rm --entrypoint /usr/local/bin/vnfest-migrate app --dry-run
  run_compose run --rm --entrypoint /usr/local/bin/vnfest-migrate app --apply
  run_compose run --rm --entrypoint /usr/local/bin/vnfest-migrate app --verify
  ok "migration 和生产配置检查通过"
}

phase_finish() {
  log "阶段 5/5: 健康检查和发布摘要..."
  if [ "$DRY_RUN" = true ]; then
    log "[干跑] 跳过 HTTP 验证"
    return
  fi
  local health_url
  health_url="${HEALTH_URL:-http://127.0.0.1:8080/api/health.php}"
  curl --fail --silent --show-error "$health_url" >/dev/null || fail "Go healthcheck 失败: $health_url"
  run_compose ps app
  ok "Go 服务健康；未自动修改 Nginx upstream"
}

phase_preflight
phase_backup
phase_release
phase_migrate
phase_finish
ok "Go 发布辅助流程完成；正式流量切换/回滚请遵循 GO_MIGRATION_RUNBOOK.md"
