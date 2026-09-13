# VNFmap PHP → Go 无感迁移 Runbook

这份 runbook 是生产切换前的操作门禁，不代表当前工作区已经执行过生产
迁移。正式切换前必须由值班人员在生产服务器上逐项记录输出、操作者、时间
和发布版本；真实密钥、Cookie、Session ID、OAuth state 和用户资料不得写入
报告或聊天记录。

## 1. 预备条件

- Go 镜像已在隔离环境启动，`/api/health.php` 返回 HTTP 200 且数据库为
  `connected`。
- 生产 PHP 容器和上一版 PHP 镜像均保留，PHP 版本已发布 Session bridge
  兼容补丁。
- PHP 与 Go 使用同一 MySQL、`data/`、`uploads/` 和 `wiki/uploads/` 卷；Go
  备用容器只读验证期间不得运行会写业务数据的回归脚本。
- `LEGACY_PHP_UPSTREAM` 只指向隔离的 PHP 回滚容器；正式 Go-only 运行时应
  为空。
- 生产 `.env` 只存在服务器 Secret 管理位置，仓库只维护 `.env.example`。

## 2. 备份与不可变基线

在停止写入窗口或由 DBA 认可的一致性快照窗口执行：

```bash
release="$(date +%Y%m%d%H%M%S)"
mkdir -p "/var/backups/vnfest/$release"

# MySQL：使用生产 Secret 管理器提供密码，不把密码写入 shell history。
mysqldump --single-transaction --routines --triggers \
  -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$DB_NAME" \
  > "/var/backups/vnfest/$release/mysql.sql"
sha256sum "/var/backups/vnfest/$release/mysql.sql" \
  > "/var/backups/vnfest/$release/mysql.sql.sha256"

# 迁移工具输出非敏感的表/列/索引/外键、计数和文件 SHA-256 清单。
docker exec vnfest-app vnfest-migrate --snapshot \
  > "/var/backups/vnfest/$release/snapshot.before.json"
sha256sum "/var/backups/vnfest/$release/snapshot.before.json" \
  > "/var/backups/vnfest/$release/snapshot.before.json.sha256"

# SQLite 隔离环境使用文件副本；生产 MySQL 不执行此行。
cp --reflink=auto data/galgame.db \
  "/var/backups/vnfest/$release/galgame.db" 2>/dev/null || true
```

确认备份可读后再继续；备份失败、磁盘空间不足或 hash 不能复核时停止。

## 3. Schema 与 Session bridge

先在维护窗口执行迁移，服务启动不会自动改表：

```bash
docker exec vnfest-app vnfest-migrate --dry-run
docker exec vnfest-app vnfest-migrate --apply
docker exec vnfest-app vnfest-migrate --verify
```

`--verify` 必须通过且版本至少为 17。记录 bridge 的总量、有效量、过期量和
失败量；命令输出不得包含 Session ID 或 payload。切换前抽样验证只能记录
“成功/失败数量”，不能记录令牌内容。

## 4. 图片与文件安全校验

```bash
docker exec vnfest-app vnfest-worker migrate-images --dry-run
docker exec vnfest-app vnfest-worker migrate-images --resume --limit=100
docker exec vnfest-app vnfest-worker migrate-images --resume --rewrite
docker exec vnfest-app vnfest-worker migrate-images --verify
```

先 dry-run，确认清单只包含允许的公开图片；上传失败立即停止批次。每次
rewrite 都必须检查 `data/image-host/manifest.json` 和对应备份目录。Go worker
不会删除本地源文件，数据库只允许改写头像、封面、GalOnly 图片和制品图片
等 allowlist 字段。

## 5. PHP/Go 差异回放与浏览器验收

在隔离环境把同一份脱敏请求分别发给 PHP 和 Go，比较：

- HTTP 方法限制、状态码、JSON 类型/字段/空值、关键响应头；
- 未登录、普通会员、社团管理者、负责人和超级管理员权限；
- 登录、Session bridge、QQ/Discord OAuth state、邮箱验证码、上传和登出；
- 社团、GalOnly、投稿/Wiki、动态/私信、萌战/十二器、Recognition 和 Spy；
- Bot、MakoQuiz、Narrative、Bangumi、VNDB、PicUI、LLM fake service；
- 4 个视口：`1440x900`、`1024x768`、`768x1024`、`390x844`。

浏览器和契约脚本应以 `BASE_BACKEND=php`、`BASE_BACKEND=go` 各跑一遍；任何
差异都先回到 PHP 基线定位，不能把差异用“兼容层成功响应”掩盖。

## 6. Worker 迁移

把现有 PHP cron 替换为 Go 二进制命令，并保留日志、锁和退出码：

```cron
*/5 * * * * docker exec vnfest-app vnfest-worker recognition >> /var/log/vnfest-recognition.log 2>&1
* * * * * docker exec vnfest-app vnfest-worker spy >> /var/log/vnfest-spy.log 2>&1
0 * * * * docker exec vnfest-app vnfest-worker spy --reap >> /var/log/vnfest-spy-reap.log 2>&1
*/5 * * * * docker exec vnfest-app vnfest-worker settle-moe >> /var/log/vnfest-moe.log 2>&1
```

历史统计补录和图片迁移只在人工批准的窗口执行，不放入常驻 cron。Notion
日报抓取仍是 Node.js 任务，不属于 PHP 后端。

## 7. 切换与观察

1. 启动 Go 容器，执行健康检查、`--verify`、全量回放和 Session 数量校验。
2. 记录切换前 PHP upstream、Go 镜像 digest、数据库 snapshot hash 和文件
   清单 hash。
3. 仅修改 Nginx upstream，从 PHP `127.0.0.1:8080` 切到 Go
   `127.0.0.1:8080`（若并行备用容器使用其它端口，记录实际端口）。
4. 立即验证健康检查、公开首页、已登录页面、OAuth 错误路径、一个写入接口、
   一个上传接口和每类 worker 的计数。
5. 观察至少一个业务高峰或完整发布观察周期：HTTP 5xx/4xx、登录、OAuth、
   上传、数据库写入、outbox、Spy 幂等缓存和磁盘空间。
6. 观察窗口内不删除 PHP 容器、PHP 镜像、数据卷或备份。

## 8. 回滚

出现错误率上升、登录态丢失、OAuth 回调失败、写入/文件 hash 差异、上传
失败或 worker 重复处理时，立即停止 Go worker 并将 Nginx upstream 切回 PHP。
如果 PHP 容器已停止，可使用预先验证过的回滚镜像：

```bash
export PHP_ROLLBACK_IMAGE='ghcr.io/vnfestmap/galgame-community-map:php-rollback-DIGEST'
docker compose -f docker-compose.php-rollback.yml up -d
# 将 Nginx upstream 临时切换到 http://127.0.0.1:8081
```

回滚不执行数据库降级、不删除 Go 写入、不执行 `git reset`。回滚后检查 PHP
健康、已有用户 Session、一次登录态读取、一次受控写入和关键页面。只有
经过数据报告确认单个文件损坏时，才从对应备份恢复该文件；数据库结构不
回滚、不删除新增兼容表。

## 9. PHP 下线门禁

只有以下项目全部有证据后，才可以移除 PHP 生产启动链路：

- Go 镜像 runtime 检查不到 PHP、PHP-FPM、Apache、Composer 和 `vendor/`；
- `docker-compose.yml`、CI 和正式 cron 只启动 Go；
- 87 个 API 路径、Forum 410、portrait API、静态 admin/events.php 均已回放；
- OAuth、邮件、上传、外部服务 fake/真实验收通过；
- 数据库结构/关键计数、JSON SHA-256、上传 SHA-256 和 Session 数量可核对；
- PHP 回滚镜像、数据库备份和文件备份仍按发布保留策略可恢复；
- Nginx、容器启动、readiness/healthcheck 不依赖 PHP。
