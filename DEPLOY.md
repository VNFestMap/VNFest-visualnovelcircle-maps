# VNFest 地图 — 部署与多人协作指南

> 生产环境：宝塔面板 + Docker + PHP 8.4 + MySQL

---

## 一、CI/CD 流程（一句话版）

```
开发者合并 PR 到 main 或打 tag
        ↓
GitHub Actions 自动构建 Docker 镜像
        ↓
推送到 ghcr.io（GitHub 容器仓库）
        ↓
服务器 Watchtower 自动检测新版本
        ↓
拉取新镜像 → 重启容器 → 部署完成（约 1-2 分钟）
```

---

## 二、服务器首次配置（一次性的）

### 2.1 在宝塔创建网站

1. 宝塔 → 网站 → 添加站点
2. 填入域名，PHP 版本选 **纯静态**（Docker 管理 PHP）
3. 创建后记下网站根目录（例如 `/www/wwwroot/map.vnfest.top`）

### 2.2 创建项目目录

```bash
# SSH 登录服务器，进入网站目录
cd /www/wwwroot/162.251.93.178

# 克隆代码
git clone https://github.com/VNFestMap/china-visualnovelcircle-maps.git .
git checkout main

# 创建配置文件和持久化目录
cp config.example.php config.php
mkdir -p data/cache uploads wiki/uploads
chmod -R 755 data uploads wiki
```

编辑 `config.php`，填入真实数据库信息（宝塔里先创建好 MySQL 数据库）。

### 2.3 公开图片图床配置

公开头像、同好会图片、Wiki 图片和刊物预览页会由 PHP 服务端代传到 picui。真实 Token 只放服务器的 `.env`，不要写入 Git、前端代码或命令输出：

```bash
PICUI_TOKEN=在服务器环境中填写
PICUI_API_URL=https://picui.cn/api/v1
PICUI_ENABLED=true
PICUI_PERMISSION=1
PICUI_TIMEOUT=30
PICUI_FALLBACK_LOCAL=true
PICUI_ALLOWED_HOSTS=picui.cn,www.picui.cn
```

上传时仍会先保留本地副本。picui 不可用时，公开图片会自动返回本地副本；作品审核图、稿件附件和内部考核图片不会作为公开图床图片上传。

首次迁移前先执行清单检查，确认公开图片数量和排除项：

```bash
docker exec vnfest-app php scripts/migrate-images-to-picui.php --dry-run
```

确认清单后分批上传并保存映射；全部完成后再替换引用：

```bash
docker exec vnfest-app php scripts/migrate-images-to-picui.php --resume --limit=100
docker exec vnfest-app php scripts/migrate-images-to-picui.php --resume --rewrite
docker exec vnfest-app php scripts/migrate-images-to-picui.php --verify
```

默认迁移重要公开图片，不包含刊物预览页面。重要图片完成后，再单独迁移刊物预览：

```bash
docker exec vnfest-app php scripts/migrate-images-to-picui.php --include-publications --resume --limit=100
docker exec vnfest-app php scripts/migrate-images-to-picui.php --include-publications --resume --rewrite
docker exec vnfest-app php scripts/migrate-images-to-picui.php --include-publications --verify
```

迁移清单和备份位于服务器 `data/image-host/`，原 `data/`、`uploads/` 和 `wiki/uploads/` 图片不删除。

### 2.4 首次启动容器

```bash
# 启动
docker compose up -d

# 查看日志
docker compose logs -f

# 运行数据库迁移
docker exec vnfest-app php scripts/migrate.php
```

### 2.5 配置 Nginx 反代

宝塔 → 网站 → 设置 → 反向代理 → 添加：

```
代理名称：vnfest-app
目标 URL：http://127.0.0.1:8080
```

如果已有网站配置，在宝塔网站配置文件中找到 server 块，添加：

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

如已有静态文件配置，替换为上面的反代配置即可。

### 2.6 验证

访问 `https://你的域名/api/health.php`，返回 `status: "ok"` 即成功。

---

## 三、日常开发与更新

从这时开始，日常流程就是自动化了：

```
本地开发 → git push → GitHub Actions 自动构建 → Watchtower 自动更新服务器
```

你什么都不用做。约 1-2 分钟后刷新网站即可看到新版本。

用户中心的 `user.html` 会引用带哈希的 `user-v2-assets/index-*.js` 和 `index-*.css`。每次构建必须把 HTML 与对应的两个静态文件一起提交；只发布 HTML 会让 Nginx 对缺失资源返回 404 HTML，浏览器在 `nosniff` 下会报 `NS_ERROR_CORRUPTED_CONTENT`。在 `user-v2-react` 执行 `npm.cmd run build` 会自动同步这两个文件到根目录。发布后可检查：

```bash
curl -I https://www.map.vnfest.top/user-v2-assets/index-你的哈希.js
curl -I https://www.map.vnfest.top/user-v2-assets/index-你的哈希.css
```

成功时 JS 应为 `application/javascript`，CSS 应为 `text/css`，不能是 `text/html` 或 `404`。

### 手动触发

也可以在 GitHub 仓库页面：
- Actions → 左侧 `构建并推送 Docker 镜像` → Run workflow

### 强制更新

```bash
# 服务器上手动拉取新镜像并重启
docker compose pull
docker compose up -d
```

---

## 四、多人协作工作流

### 4.1 分支规范

| 分支 | 用途 | 谁可以推 |
|------|------|---------|
| `main` | 生产分支，合并即部署 | 负责人合并 PR |
| `feat/xxx` | 新功能 | 开发者 |
| `fix/xxx` | Bug 修复 | 开发者 |
| `refactor/xxx` | 重构 | 开发者 |

### 4.2 本地开发环境

```bash
# 克隆
git clone https://github.com/VNFestMap/china-visualnovelcircle-maps.git
cd china-visualnovelcircle-maps

# 配置（本地用 SQLite，不用配 MySQL）
cp config.example.php config.php
# config.php 里 DB_DRIVER 保持 sqlite 即可

# 启动开发服务器
php -S 127.0.0.1:8000
# 浏览器访问 http://127.0.0.1:8000
```

### 4.3 开发流程

```bash
# 拉取最新 main
git checkout main
git pull origin main

# 创建功能分支
git checkout -b feat/你的功能

# 开发、提交、推送
git add .
git commit -m "feat: 你的功能描述"
git push origin feat/你的功能

# 在 GitHub 创建 Pull Request → main
# 至少一人 Review → 负责人合并
```

### 4.4 提交信息规范

```
feat      新功能        feat: add club search
fix       Bug 修复      fix: login redirect loop
refactor  重构          refactor: extract api helper
style     样式/UI       style: unify button padding
docs      文档          docs: add deployment guide
chore     杂项          chore: bump version to 1.7.1
```

### 4.5 Code Review 关注点

- 有没有破坏已有功能（JS 和 API 改动要特别注意）
- 有没有在 `data/*.json` 里加字段（确认前后端一致）
- 有没有新增数据库字段（确认 `scripts/migrate.php` 已更新）
- 有没有引入调试代码（`console.log`、`var_dump` 等）
- 不要在 `config.php` 里提交真实密钥

### 4.6 数据库变更

1. 修改 `scripts/migrate.php` 添加 `CREATE TABLE IF NOT EXISTS`
2. PR 中注明有数据库变更（同好会考核相关表均以 `recognition_` 前缀命名，需同时维护 MySQL 与 SQLite 两个分支）
3. 合并后第一次构建的镜像运行时会自动执行（首次启动后手动跑）
4. 发布顺序固定为：合并 → 容器更新 → `docker exec vnfest-app php scripts/migrate.php` → 访问 `api/health.php` 验证，顺序颠倒会导致新代码访问不到新表而 500

---

## 五、发布新版本

```bash
# 本地打标签并推送
git tag v1.8.0
git push origin v1.8.0
```

GitHub Actions 会自动构建并推送到 ghcr.io，Watchtower 检测到新 tag 后会在 5 分钟内自动更新。

---

## 六、备份与恢复

### 自动备份

`docker-compose.yml` 已配置数据卷持久化，主机目录：
- `./data/` — 同好会数据、提交、出版物等 JSON
- `./uploads/` — 用户上传文件
- `./wiki/uploads/` — Wiki 图片

### 手动备份

```bash
# 备份 JSON 数据
tar -czf backup-data-$(date +%Y%m%d).tar.gz data/*.json

# 备份 MySQL
mysqldump -u用户名 -p密码 数据库名 > backup-db-$(date +%Y%m%d).sql

# 备份上传文件
tar -czf backup-uploads-$(date +%Y%m%d).tar.gz uploads/
```

### 迁移到新服务器

```bash
# 新服务器上
git clone ...
cp config.example.php config.php   # 填入新数据库信息
docker compose up -d
docker exec vnfest-app php scripts/migrate.php

# 从旧服务器复制 data/、uploads/、wiki/uploads/
rsync -avz root@旧IP:/www/wwwroot/旧目录/data/ ./data/
rsync -avz root@旧IP:/www/wwwroot/旧目录/uploads/ ./uploads/
```

---

## 六之二、同好会考核（Recognition）运维事项

- **配置**：`config.php` 需新增 `RECOGNITION_HMAC_SECRET`（外部 Connector 签名校验）与 `RECOGNITION_CRED_PREFIX`（凭证编号前缀，见 `config.example.php`）。
- **cron 补偿任务**：凭证过期扫描与通知重试由 `scripts/recognition_worker.php` 消费 `recognition_outbox`，需在宿主机配置：
  ```bash
  */5 * * * * docker exec vnfest-app php scripts/recognition_worker.php >> /tmp/recog_worker.log 2>&1
  ```
  未配置 cron 时，签发通知会滞留在 outbox 中（不丢失，配置后自动补发）。
- **上传目录**：考核徽章图片存放在 `data/badge_images/`（由 `api/badge_image.php` 写入）。容器部署时确保该目录存在且 Web 用户可写（`chown -R www-data:www-data data/badge_images`）；仓库中仅保留 `.gitkeep`，图片本身不入库。
- **旧链接兼容**：`trial/index.html` 与 `achievements.html` 为重定向 stub（分别指向 `exam/` 与 `user.html?tab=achievements`），兼容存量二维码与通知链接；至少保留一个发布周期后再删除。
- **验证**：访问 `api/recognition_programs.php?action=list` 应返回 `{"success":true,...}`。

---

## 七、健康检查与监控

访问 `https://你的域名/api/health.php`：

```json
{
  "status": "ok",
  "checks": {
    "database": "connected",
    "git_commit": "a1b2c3d",
    "disk_free_gb": 50.2
  }
}
```

可在宝塔 → 监控 或 Uptime Kuma 等工具定期检查此地址。

---

## 八、常见问题

**Q: 容器启动失败？**
```bash
docker compose logs app    # 查看错误日志
```

**Q: 更新后没看到变化？**
```bash
docker compose logs watchtower   # 查看 Watchtower 是否检测到新版本
```

**Q: 图片上传 403？**
```bash
chown -R www-data:www-data uploads/ wiki/uploads/
```

**Q: 本地开发需要完整数据？**
找负责人拷贝 `data/` 目录，放到项目根目录即可。这些文件不会被 git 跟踪。

**Q: 构建的镜像在哪？**
https://github.com/VNFestMap/galgame-community-map/pkgs/container/galgame-community-map
