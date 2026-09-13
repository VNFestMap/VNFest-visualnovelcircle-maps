# VNFest 2.3.0

## 版本摘要

VNFest 2.3 将 VNFmap 的生产后端运行时迁移到 Go，同时保持现有前端不改 API URL、现有 `/api/*.php` 路径、Cookie 名称、OAuth 回调和公开页面地址。PHP 仅作为独立回滚镜像保留，不进入正常 Go runtime。

## 主要内容

### Go 后端与兼容层

- 新增 `backend/` 服务、Worker 和迁移工具。
- 使用标准库 `net/http` 与 `database/sql`，支持 MySQL 生产库和纯 Go SQLite 本地测试。
- 保留现有 API 路径和 HTTP 兼容行为，包括认证、地图、社团、会员、动态、私信、GalOnly、投票、Recognition、Spy、Wiki、上传、Bot、OAuth 和健康检查。
- 保留 Forum 归档兼容响应，以及 `club-operation-portrait` API。
- 增加配置校验、健康检查、文件存储、SQL store、Session store、上传校验、权限中间件和外部服务客户端。

### 登录态、OAuth 与回滚

- 保留 `PHPSESSID`，通过共享 Session bridge 支持 PHP 创建的登录态由 Go 继续使用。
- Go 创建的登录态也能交给 PHP 回滚版本读取。
- OAuth state、邮件验证码、上传、外部服务 Token 均不写入前端或 Git。
- `Dockerfile.php-rollback` 和 `docker-compose.php-rollback.yml` 只用于发布周期内的回滚，不被正常 Go 镜像和 CI 启动。
- 回滚只切换 Nginx upstream，不执行数据库降级，不删除 Go 写入的数据。

### 图片和图床

- 保留 PICUI 服务端代传、可信主机校验和本地文件兜底。
- Go 图片代理支持 Bangumi、VNDB、CnGal 包装图和 CnGal 原图。
- 支持 CnGal 返回的 Steam CDN 图片，但仅允许固定的 `/steam/apps/<数字>/` 图片路径。
- 不删除旧上传文件、历史本地副本或运行时图片。

### 履历书和加载性能

- 履历书的账户检查与云端履历读取改为并行请求，减少首次打开等待。
- 修复履历书 CnGal 搜索结果没有进入图片代理白名单的问题。
- 兼容 CnGal 包装地址中的原图回退和旧 Bangumi HTTP 图片升级到 HTTPS。
- 宝塔 Nginx 启用文本资源 gzip；HTML、JavaScript、CSS 和地图 JSON 的公网传输体积显著降低。
- HTML 脚本版本号已更新，避免浏览器继续使用旧的履历书脚本缓存。

## 验证结果

本版本已执行：

```text
go test ./...
node --check tools/GalgameTool/galgame-tool.js
node scripts/test-galgame-resume-contract.mjs
node scripts/test-go-api-route-inventory.mjs
git diff --check
nginx -t
```

生产服务器 `162.251.93.178` 的 Go 服务本机和公网健康检查均为 `status: ok`，MySQL 连接正常，文件完整性正常，PHP upstream 为 disabled。

真实浏览器验证履历书 CnGal 搜索结果 3/3 图片加载成功；CnGal、Steam CDN 和旧 Bangumi 图片代理请求均返回 HTTP 200。

关键 gzip 传输体积抽样：

| 资源 | 原始 | gzip 后 |
|---|---:|---:|
| 首页 HTML | 136.8 KB | 25.3 KB |
| `app.js` | 412.1 KB | 93.5 KB |
| `styles.css` | 289.2 KB | 48.4 KB |
| `api/clubs.php` JSON | 249.3 KB | 30.7 KB |

## 发布边界

- 仓库不包含生产 `.env`、`config.php`、数据库文件、Session ID、OAuth state、Token、上传文件、JSON 运行时数据或服务器备份。
- 生产数据库迁移仍必须遵循备份、dry-run、apply、verify、差异回放和回滚门禁。
- CnGal 如果未来返回新的第三方图片域名，需要在安全白名单中单独评估，不能直接放开任意外站。

## 相关文档

- [部署与多人协作指南](DEPLOY.md)
- [PHP → Go 无感迁移 Runbook](GO_MIGRATION_RUNBOOK.md)
- [项目结构](PROJECT_STRUCTURE.md)
