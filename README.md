<p align="right">
  <a href="README.ja.md">日本語</a> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <img src="images/VNF.png" alt="VNFest" width="420">
</p>

<p align="center">
  <b>中日高校 Galgame / 视觉小说同好会导航 · 社团运营 · 活动发布 · 刊物征稿 · 企划赛事 · Wiki 共建</b>
</p>

<p align="center">
  <a href="https://www.map.vnfest.top"><img alt="Website" src="https://img.shields.io/badge/🌐_在线访问-map.vnfest.top-2ecc71?style=flat-square"></a>
  <img alt="Version" src="https://img.shields.io/badge/version-2.3.0-2ecc71?style=flat-square">
  <img alt="Go" src="https://img.shields.io/badge/Go-1.26-00ADD8?style=flat-square&logo=go&logoColor=white">
  <img alt="React" src="https://img.shields.io/badge/React-18-61dafb?style=flat-square&logo=react&logoColor=white">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-7.x-646cff?style=flat-square&logo=vite&logoColor=white">
  <img alt="D3.js" src="https://img.shields.io/badge/D3.js-7.9-f9a03c?style=flat-square&logo=d3.js&logoColor=white">
  <img alt="License" src="https://img.shields.io/badge/license-GPLv3-355c9b?style=flat-square">
</p>

---

## 项目简介

**VNFest**（Visual Novel Festival）是面向视觉小说同好会的社区与运营平台。它把地图导航、同好会资料、成员管理、活动发布、刊物征稿、企划协作、投票赛事和 Wiki 共建放在同一套入口中。

平台服务四类主要用户：想寻找同好的访客，加入同好会并参与活动的注册用户，负责社团运营的负责人，以及维护审核、赛事和站点内容的管理员。

```text
发现同好会 → 查看详情 → 申请加入 → 参与活动 → 投稿刊物 / Wiki → 参与企划与赛事
```

在线访问：[https://www.map.vnfest.top](https://www.map.vnfest.top)

访客无需注册即可浏览地图、同好会信息、Wiki 和公开活动。需要发布内容、加入同好会、发送私信或执行管理操作时，再使用对应账号登录。

## v2.3.0 更新日志

本版本完成 VNFmap 后端从 PHP 运行时到 Go 服务的生产迁移基础建设，并保留现有前端 URL、API 路径、Cookie 和回滚边界。

- 新增 `backend/` Go 服务、Worker、迁移工具、MySQL/SQLite 双驱动、版本化迁移、文件存储、Session bridge、OAuth/邮件/图床和状态机模块。
- Go 直接提供静态页面、现有 `/api/*.php` 兼容路径、OAuth 回调、上传、健康检查，以及 Forum 归档和 club-operation-portrait 兼容接口。
- 保留 `PHPSESSID` 共享会话桥接，支持已有登录态继续使用；生产配置只从服务器环境读取，仓库不包含真实密钥和运行时数据。
- 新增 Go Docker/CI/宝塔部署说明、健康检查、数据快照、差异回放和 PHP 独立回滚镜像，回滚不依赖数据库降级。
- 统一图片代理的安全白名单和本地缓存；兼容 CnGal 包装图、CnGal 原图、限定路径 Steam CDN、旧 Bangumi HTTP 图片，并保留本地文件兜底。
- 优化履历书初始化请求并行化；修复 CnGal 搜索结果图片无法加载；生产 Nginx 开启文本资源 gzip，降低首页、脚本、样式和地图 JSON 的公网传输体积。
- 完成 Go 单元测试、图片代理回归、履历书契约、API 路由清单、真实健康检查和公网图片/静态资源验证。

详细迁移门禁和回滚流程见 [`GO_MIGRATION_RUNBOOK.md`](GO_MIGRATION_RUNBOOK.md)，部署协作说明见 [`DEPLOY.md`](DEPLOY.md)。

## v2.2.0 更新日志

本节整理 2026-09-03 至 2026-09-13 的 2.2.0 更新。网站使用文档中的中日双语历史记录位于：[历史更新记录](https://www.map.vnfest.top/wiki/guide/#/updates/2-2-0)。

### 同好会动态与搜索

- 同好会动态首页、搜索、个人空间、消息和动态详情统一使用 React/Vite 路由与响应式布局。
- 旧论坛入口改为归档提示，引导内容发布回到同好会动态。
- 新增独立“搜索”入口，可以分别搜索动态和用户；桌面左侧导航与移动端底部导航保持一致。
- 发布动态支持多图片预览、网格展示、自由比例手动裁剪和上传失败提示。
- 个人资料横幅支持 3:1 裁剪，并输出 1200×400 图片。
- 关联同好会改为居中弹层，支持本地搜索、成员身份、取消关联和选中反馈。

### 好友与私信

- 双方互相关注后形成好友关系，个人空间只对好友显示“发私信”入口。
- 新增会话列表、好友入口、按日期分组的聊天气泡、已读状态和未读数量。
- 未读数量每 8 秒刷新，会话内容每 5 秒增量拉取。
- 消息正文最长 1000 字，发送频率限制为每 10 分钟 30 次。
- 支持图片附件、发送前预览和点击放大查看。
- 修复 `/column/messages` 图片灯箱被用户名信息条和底部 sticky 输入框遮挡的问题。灯箱现在挂载到页面顶层，覆盖完整视口并居中显示，图片最大宽度约为 82vw/680px，最大高度为 72vh。

### 同好会管理后台

- 同好会管理后台迁移为 React/Vite 工作台。
- 保留待审核、外交、已通过、成员、设置、绑定码、机器人 Token、推荐位、企划、认可凭证、江苏和用户等权限边界。
- 桌面端提高信息密度，移动端使用抽屉导航。
- 推荐位继续固定为 12 个位置，桌面端使用拖拽排序，移动端使用点击换位。
- 成员、企划、推荐位和认可凭证补充契约测试及高数据量场景检查。

### 登录与账号安全

- QQ/Discord 登录补充账号凭证升级流程。
- 第三方登录用户可以完成邮箱验证码、设置密码、凭证完成状态和账号提供商转移。
- 数据库结构增加 `credentials_completed_at` 与 `oauth_account_challenges`。
- 邮箱唯一性、`PHPSESSID` 共享 Session、登录注册和 OAuth 回调继续遵循现有 API 契约。
- 用户中心同步整理账号安全、通知筛选和同好会动态入口。

### GalgameTool 与其它前端

- GalgameTool 扩展为履历书、MEME 看板和 Tier 表三个视图。
- Tier 表支持卡片搜索、拖拽排序、行与颜色编辑、本地图片卡、JSON 导入导出和 PNG 导出。
- 登录用户获得云同步入口，MEME/Tier 生成结果可以转发到同好会动态。
- 导出流程补充进度提示、图片预加载和颜色兼容处理；Bangumi、VNDB、CnGal 等数据源与移动端编辑入口继续保留。
- 新增间谍游戏 React 桌面/移动端界面原型和静态构建，当前仍是独立原型，不表示已经接入主站业务流程。

### 接口、数据结构与工程

- 新增或整理动态、动态图片、用户横幅、私信和 Tier 表接口。
- Posts/DM schema 接入统一迁移脚本，私信会话按用户 ID 规范化为唯一组合，消息、附件和未读索引分别维护。
- 清理旧专栏 API、旧论坛/专栏辅助文件和重复构建资源，保留归档入口与现行 Column 构建产物。
- 补充 OAuth、管理后台、同好会动态、Wiki 更新记录和图片灯箱的契约或浏览器回归检查。
- GitHub Pull Request 镜像检查补充 Buildx 初始化，修复 GitHub Actions 缓存无法由 Docker 默认驱动导出的问题。

### 验证与发布边界

- Column React 构建、动态契约测试、Wiki 指南种子同步、OAuth 账户流程检查和管理员 React 契约检查通过。
- Electron 浏览器检查覆盖 4 个视口 × 9 个路由，共 36 个场景。
- 私信图片灯箱专项回归确认灯箱直接位于 `document.body`，使用固定定位和 `z-index: 1000`，可以覆盖顶部信息条与底部输入区并保持居中。
- 2.2.0 源码与更新记录已发布到 GitHub；图片灯箱对应的 `/column/` 入口及哈希 JS/CSS 已通过受控 SSH 流程发布到生产环境，并完成服务器哈希、权限、引用和公网 HTTP 200 回读。
- 文档和 GitHub 发布不会自动执行生产数据库迁移。其余 2.2 数据库变更仍须在目标服务器先备份数据，再运行迁移并核对 `posts`、`dm_conversations`、`dm_messages` 和 OAuth 挑战表等结构。
- QQ/Discord 实际授权、邮件实际投递、两个互关账号之间的线上收发，以及登录管理员的真实业务操作需要相应账号或运营授权，不能由静态检查代替。

## 功能总览

### 地图与同好会发现

中国地图覆盖省级区域，日本地图细化至都道府县。访客可以通过地图、列表、省份索引、关键词搜索、类型筛选和多维排序发现同好会。

同好会详情包含名称、地区、所属学校、组织类型、联系方式和介绍。负责人可以维护资料、上传头像、管理成员和处理加入申请；一个同好会也可以关联多个地区。

### 活动、刊物与企划

负责人可以发布活动、管理报名、发布刊物征稿和追踪投稿状态。企划枢纽支持创建项目、邀请成员、分配策划/美术/文案/技术角色，并追踪筹备中、进行中、已完成和搁置状态。

GalOnly 活动拥有独立的专题入口、Staff 招募和审核流程。活动中心集中展示公开的赛事、企划和活动。

### 投票赛事

VNFest 提供统一的多阶段、多轮次投票底座，并支持十二器和萌战两类赛事。

- 十二器面向视觉小说作品，支持提名、海选、分组评分和年度 Top 12 结果沉淀。
- 萌战面向角色，支持提名、海选、1v1 淘汰赛和可缩放的对阵图。

### 用户中心与账号

用户中心基于 React 18 SPA，支持个人资料、同好会、通知、成长体系和同好会动态入口。账号支持注册、登录、邮箱验证码、密码找回，以及 QQ 和 Discord OAuth 登录。

用户可以从有效会籍中选择一个代表同好会公开展示。会籍失效、退出或被踢后，代表关系会自动清除。

### Wiki 与资料公开库

Wiki 提供中文/日文双语文档、分组导航、站内检索、可视化编辑器、图片、信息卡、时间线和外部链接。编辑后的页面可以生成并发布为静态 HTML。

资料公开库用于存档同好会刊物，支持 PDF 与图片上传、元数据维护和在线阅读；配套 PDF 阅读器提供 3D 翻页预览。

## 使用入口

| 场景 | 入口 |
|------|------|
| 主地图 | `https://www.map.vnfest.top/` |
| 登录与注册 | `https://www.map.vnfest.top/login.html` |
| 同好会动态 | `https://www.map.vnfest.top/column/` |
| 同好会动态消息 | `https://www.map.vnfest.top/column/messages/` |
| 用户中心 | `https://www.map.vnfest.top/user.html` |
| 活动中心 | `https://www.map.vnfest.top/club_square.html` |
| Wiki 使用文档 | `https://www.map.vnfest.top/wiki/guide/` |
| GalgameTool | `https://www.map.vnfest.top/tools/GalgameTool/` |

### 按角色使用

| 角色 | 主要操作 |
|------|---------|
| 访客 | 浏览地图、同好会详情、Wiki、公开活动和赛事 |
| 注册用户 | 加入同好会、报名活动、投稿刊物、编辑 Wiki、参与投票、与好友私信 |
| 同好会负责人 | 维护资料、审核成员、发布活动和征稿、管理企划、运营同好会动态 |
| 管理员 | 审核同好会、管理 GalOnly、运营赛事、维护 Wiki 和站点通知 |

## 技术架构

```text
┌────────────────────────────────────────────────────────────┐
│                         浏览器 / 客户端                      │
│  HTML + CSS + Vanilla JS  │ React 18 + Vite                │
│  地图、Wiki、活动页        │ 用户中心、Column、管理工作台   │
└───────────────────────────┬────────────────────────────────┘
                            │ fetch() / REST / PHPSESSID 共享 Session
┌───────────────────────────┴────────────────────────────────┐
│                         Go 后端                             │
│ backend/ · 兼容现有 /api/*.php URL · OAuth · Worker         │
└───────────────────────────┬────────────────────────────────┘
                            │ PDO
┌───────────────────────────┴────────────────────────────────┐
│                           数据层                              │
│                  SQLite / MySQL · JSON 运行时文件            │
└────────────────────────────────────────────────────────────┘
```

| 层 | 技术 |
|---|---|
| 前端 | HTML、CSS、Vanilla JavaScript、React 18、Vite、D3.js 7 |
| 后端 | Go 1.26，`net/http` + `database/sql`，SQLite/MySQL 双驱动 |
| 数据 | SQLite / MySQL via Go 驱动、JSON 运行时文件 |
| 测试 | Go 单元/集成测试、Node.js 契约测试、Electron 浏览器回归 |
| 部署 | Docker、GitHub Actions、GHCR、Watchtower 或受控 SSH 发布 |
| 国际化 | 中文 / 日本語双语运行时与 Wiki 种子 |

## 项目结构

```text
.
├─ admin/                  管理后台、赛事管理、Wiki 编辑
├─ backend/                Go 服务、Worker、迁移工具和领域模块
├─ api/                    历史 PHP URL 名称与行为基线（生产由 Go 响应）
├─ css/                    全站样式
├─ data/                   运行时数据，不进入 Git
├─ Game/                   游戏页面与 React 游戏原型
├─ images/                 站点图片资源
├─ includes/               PHP 历史公共模块（回滚/行为基线，不进入 Go runtime）
├─ js/                     地图、投票、项目和全站运行时脚本
├─ scripts/                构建、迁移、测试和同步脚本
├─ tools/                  GalgameTool、PDF 阅读器等公开工具
├─ user-v2-react/          用户中心 React 源码
├─ column-react/           同好会动态 React 源码
├─ club-manager-react/     同好会管理工作台 React 源码
├─ wiki/                   Wiki 页面、编辑器、指南和内容种子
│
├─ index.html              主地图入口
├─ login.html               登录 / 注册入口
├─ user.html                用户中心入口
├─ club_square.html         活动中心入口
├─ star_map.html            联合星图入口
├─ Dockerfile               容器镜像定义
├─ docker-compose.yml       服务编排配置
├─ PROJECT_STRUCTURE.md     目录边界与整理规则
└─ README.md                项目说明与版本更新记录
```

根目录 HTML 是公开 URL 的路由入口，为兼容现有链接保留在 Web 根。`data/`、用户上传文件、配置文件和依赖目录不应进入提交。

## 快速开始

### 环境要求

- Go 1.26 或更高版本；本地 SQLite 使用纯 Go 驱动，不需要 CGO。
- Node.js 18 或更高版本，用于测试和前端构建。
- Docker（推荐用于本地启动）和 Git。

### 本地运行

```bash
git clone https://github.com/VNFestMap/china-visualnovelcircle-maps.git
cd china-visualnovelcircle-maps
npm install
cp .env.example .env
# 编辑 .env；本地默认使用 SQLite
docker compose up -d app
```

然后访问：

- 访客地图：`http://127.0.0.1:8080/index.html?guest=1`
- 登录/注册：`http://127.0.0.1:8080/login.html`
- Wiki 使用文档：`http://127.0.0.1:8080/wiki/guide/`

### 构建 React 页面

```bash
# 同好会动态
npm run column:build

# 用户中心
npm run build:www

# 同好会管理工作台
npm run club-manager:build
```

构建后必须确认入口 HTML 引用的哈希 JS/CSS 文件存在。不要手动删除仍可能被缓存引用的旧哈希资源。

## 测试

运行完整检查：

```bash
npm run check
```

Go 后端检查：

```bash
cd backend
go test -mod=mod ./... -count=1 -timeout=120s
go vet ./...
cd ..
npm run test:go-route-inventory
```

常用的专项检查：

```bash
npm run column:test
npm run wiki:guide:test
npm run wiki:guide:browser
npm run oauth:test
npm run club-manager:test
```

2.2.0 收尾验证包括 Column 构建、动态契约、4 个视口 × 9 个路由的 Electron 浏览器检查、私信灯箱专项回归、Wiki 双语种子同步、OAuth 账号流程和管理工作台契约检查。

## 部署与数据迁移

项目生产后端由 Go 容器提供静态页面、现有 API URL、OAuth 回调、上传和 Worker；PHP 只作为发布周期内的独立回滚镜像保留。详细环境变量、备份、差异回放、切换和回滚门禁见 [`DEPLOY.md`](DEPLOY.md) 与 [`GO_MIGRATION_RUNBOOK.md`](GO_MIGRATION_RUNBOOK.md)。

```bash
docker compose up -d

# 或使用包含快照、migration 和健康检查的 Go 发布辅助脚本
bash scripts/deploy.sh
```

生产更新的基本顺序：

1. 确认服务器身份、网站根目录和当前文件哈希。
2. 备份数据库、运行时数据和将被替换的文件。
3. 按 runbook 先完成 Go/PHP 差异回放、Session bridge 校验和四视口浏览器回归。
4. 安装后核对数据库/文件 SHA-256、所有者、权限、入口引用和 Go health/readiness。
5. 只在所有门禁通过后切换 Nginx upstream，并保留 PHP 镜像和快照用于回滚。
6. 对需要登录的私信、上传、排序和管理员操作，再进行登录态人工验收。

文档或 GitHub 发布不会自动运行生产数据库迁移。涉及 Posts/DM 或 OAuth 的变更，必须在目标服务器完成数据备份、Go migration、结构检查、差异回放和业务验证；当前工作区不代表生产已经切换。

## 版本历史

| 版本 | 核心主题 |
|------|---------|
| **v2.3.0** | PHP → Go 后端迁移基础设施、共享 Session、兼容 API、Go Worker、部署回滚、图床代理和履历书性能/图片修复 |
| **v2.2.0** | 同好会动态 React 化、独立搜索、互关私信、图片灯箱修复、管理员 React 工作台、OAuth 凭证升级、GalgameTool Tier/MEME 与后端整理 |
| **v2.1.0** | 独立专栏、超级管理控制台、北京 GalOnly、MakoQuiz 连携、偏好集中化、Wiki 使用文档 |
| **v2.0.0** | 用户中心 SPA 化、Staff 招募、资料公开库、淘汰赛可视化、设计系统统一 |
| v1.7.x | 企划枢纽、十二器、萌战引擎、投票活动、同好会广场、Docker CI/CD |
| v1.6.x | Wiki 子系统、同好会绑定码、通知公告、多端发布 |
| v1.5.0 | 用户面板重设计、GalOnly 高校通道、活动日历报名 |
| v1.0 | 全国同好会地图首发、日本扩展、用户系统 |

## 参与贡献

欢迎通过 Issue 报告问题，或通过 Pull Request 贡献代码、文档和测试。

提交前请确认：

```bash
npm run check
git status --short
git diff --check
```

请勿提交以下内容：

- `config.php`、`.env` 等本地配置和凭据。
- `data/*.json`、`data/cache/` 等运行时数据。
- `uploads/` 等用户上传内容。
- `node_modules/`、`dist/` 等依赖和临时构建目录。
- 数据库备份、会话文件、访问令牌、邮件验证码和 OAuth 密钥。

协作流程和分支约定见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## License

本项目基于 [GNU General Public License v3.0](LICENSE) 发布。

<p align="center">
  <sub>VNFest — Visual Novel Festival</sub><br>
  <sub>Made with ❤️ for the visual novel community</sub>
</p>
