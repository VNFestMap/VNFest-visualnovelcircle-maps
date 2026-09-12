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
  <img alt="Version" src="https://img.shields.io/badge/version-2.1.0-2ecc71?style=flat-square">
  <img alt="PHP" src="https://img.shields.io/badge/PHP-8.x-777bb4?style=flat-square&logo=php&logoColor=white">
  <img alt="React" src="https://img.shields.io/badge/React-18-61dafb?style=flat-square&logo=react&logoColor=white">
  <img alt="D3.js" src="https://img.shields.io/badge/D3.js-7.9-f9a03c?style=flat-square&logo=d3.js&logoColor=white">
  <img alt="License" src="https://img.shields.io/badge/license-GPLv3-355c9b?style=flat-square">
</p>

---

## 这是什么

**VNFest**（Visual Novel Festival）不是一个单纯的社团目录。它是一个为视觉小说同好会量身打造的轻量运营平台，把地图导航、社团资料维护、成员管理、活动日历、刊物征稿、企划协作、投票赛事和 Wiki 百科串联在一条完整的链路上。

无论你是想找组织的同好、维护社团信息的负责人、策划活动的运营者，还是想在百科里写点什么的编辑者——VNFest 都为你准备了对应的入口。

```text
发现同好会 → 查看详情 → 申请加入 → 参与活动 → 投稿刊物 / Wiki → 参与企划赛事
```

> **在线体验：** [https://www.map.vnfest.top](https://www.map.vnfest.top)
> 无需注册即可进入访客模式浏览地图和同好会信息。

---

## 功能详解

### 🗺️ 地图与发现

VNFest 的核心体验从一张交互式地图开始。

中国地图覆盖全部省份，日本地图精确到都道府县级别，每个地区上标注了当地已注册的视觉小说同好会。点击任意区域即可查看该地区的同好会列表，也可以在地图模式和列表模式之间自由切换。

除了地图浏览，还提供省份索引、关键词搜索、类型筛选（学校社团 / 民间组织 / 线上社群）和多维排序等发现手段。同一个同好会可以绑定多个省份，方便跨地区组织被正确展示。

访客无需登录即可浏览全部地图数据和同好会详情；登录后则获得管理入口，可以编辑自己负责的社团信息。

### 📋 同好会资料

每个同好会都有完整的资料页面，包含名称、地区、所属学校、组织类型、联系方式和详细介绍。

负责人可以上传并裁剪社团头像、维护社团简介和联系方式。系统支持三级权限体系：普通成员、同好会负责人和超级管理员，不同角色看到不同的操作入口。

成员管理方面，支持申请加入、负责人审核、绑定码快速加入等流程。同好会详情页还集成了推荐榜（其他用户可以推荐喜欢的社团）和留言板（成员和访客可以留言互动），让社团页面不只是静态信息，而是一个活的社区页面。

### 📅 活动与刊物

**活动系统** 提供日历视图和列表视图两种浏览方式。同好会负责人可以发布活动、管理投稿、审核内容和追踪报名数据。用户可以直接在活动页面报名参加。

**刊物征稿** 允许负责人发布征稿启事，追踪投稿状态（待审核 / 已录用 / 已发布），并将刊物关联到发起的同好会。

**GalOnly 活动** 拥有独立的专题入口和审核面板，还配备了完整的 **Staff 招募系统**——用户可以在线提交工作人员申请，管理员通过投票和审核流程筛选，最终锁定排班名单。

### 🏗️ 企划枢纽

企划枢纽是同好会协作的中心。

负责人可以创建企划项目，邀请其他成员加入并分配角色（策划 / 美术 / 文案 / 技术）。每个项目都有清晰的状态追踪——从筹备中、进行中、已完成到搁置，一目了然。项目还支持文件关联，方便团队共享素材和文档。

所有企划都汇集在活动中心公开展示，让更多人看到正在进行的社区项目。

### 🏆 投票赛事

VNFest 拥有一套统一的投票底座系统，支持多阶段、多轮次的灵活配置。在此之上构建了两个特色赛事：

**十二器（Twelve）** — 面向作品的评选系统。流程为提名 → 海选 → 分组评分/投票，最终沉淀出年度 Top 12 视觉小说。数据源优先从 Bangumi 搜索，补充 VNDB 数据，同时保留手动提名入口。

**萌战（Moe）** — 面向角色的对决系统。流程为提名 → 海选 → 2 的幂人数 1v1 淘汰赛，最终选出萌王。淘汰赛阶段有独立的对阵图可视化组件，支持缩放、平移、拖拽交互，并实时显示每场比赛的投票状态和票数。

两个赛事都配备了独立的 Hub 页面、详情页和赛事管理后台，从提名到决赛的完整流程都可以在线完成。

### 👤 用户中心

v2.0 全新重写的用户中心，从原来的单体 HTML 页面迁移到了基于 React 18 的 SPA 架构。

提供个人资料编辑、社团管理、消息通知、成长体系等一站式操作体验。页面加载更快、交互更流畅，并且为未来的功能扩展打下了良好的架构基础。

支持本地账号注册/登录、邮箱验证码、密码找回，以及 QQ 和 Discord 第三方 OAuth 登录。

账号可以从自己的正式活跃会籍中选择一个“代表同好会”公开展示，或保持“不展示”。选择结果会出现在账号总览与专栏文章作者身份中，并随当前会籍角色动态更新；退出、被踢、重新申请或会籍失效后会自动清除，不会公开账号的其他会籍。

### 📖 Wiki 百科

VNFest Wiki 采用百科式布局——左侧导航栏 + 右侧内容区，和传统 Wiki 站点的体验一致。

编辑器支持可视化操作，可以在页面中插入图片、信息卡（infobox）、时间线、外部链接和结构化段落。内容支持中文和日文双语，满足不同用户群体的编辑需求。

编辑完成后，Wiki 页面可以直接生成并发布为静态 HTML，无需额外的构建步骤。Wiki 首页提供「最近更新」和「资料公开库」等快捷入口，方便浏览和维护。

### 📚 资料公开库

面向同好会刊物的数字存档系统。支持 PDF 和图片格式上传，管理员可以维护刊物的元数据（标题、作者、发布日期、关联同好会等）。

内置 PDF 阅读器工具，支持 3D 翻页效果预览，让用户无需下载即可在线浏览刊物内容。

### 🌌 活动中心

活动中心是整个平台的信息汇聚点，集中展示所有公开的赛事、企划和活动。

采用深邃宇宙主题设计，配合五色活动卡片进行分类标识，视觉上一眼就能区分不同类型的社区动态。支持中日双语切换，让不同语言的用户都能无障碍浏览。

### 🌟 联合星图

联合星图是一个视觉沉浸式的探索入口。

页面采用 Cinematic Frontend v2 设计——径向渐变背景、雷达扫描动效和暗角效果，营造出太空探索的氛围。支持沉浸式模式，隐藏 HUD 元素，让用户完全沉浸在星图浏览中。

---

## 谁在使用

| 角色 | 能做什么 |
|------|---------|
| **访客** | 浏览地图、查看同好会详情、阅读 Wiki、观看赛事 |
| **注册用户** | 加入同好会、报名参加活动、投稿刊物、编辑 Wiki、参与投票 |
| **同好会负责人** | 维护社团资料、发布活动和征稿、管理成员、创建企划、发起赛事 |
| **管理员** | 审核同好会、管理 GalOnly 活动、运营萌战/十二器赛事、全站通知 |

---

## v2.1 更新亮点

> 从 v2.0 到 v2.1，VNFest 完成了社区互动与运营治理的全链路升级。

| 亮点 | 说明 |
|------|------|
| **独立专栏** | 专题文章、系列、富文本写作、评论与同好会归属 |
| **超级管理控制台** | 审核趋势、同好会地区分布 Top 12、操作日志等运营仪表盘 |
| **北京 GalOnly 第二届** | 高校摊位申请与 Staff 招募双流程，独立审核与活动 Logo |
| **MakoQuiz 答题连携** | 答题战绩回传 + HMAC 绑定令牌，跨站安全共享账号 |
| **偏好集中化** | 语言、主题、地图操作统一收口，账号语言跨设备同步 |
| **Wiki 使用文档** | 中日双语、分组导航、站内检索的完整使用文档 |
| **江苏子地图** | 13 地级市自包含离线 SVG，不依赖外部地图请求 |
| **AstrBot beta0.5** | 机器人查询与同步插件发布，含插件下载入口 |

---

## 技术架构

```text
┌──────────────────────────────────────────────────────┐
│                    浏览器 / 客户端                      │
│   HTML + CSS + Vanilla JS    │    React 18 SPA       │
│   D3.js 7 (地图可视化)        │   (用户中心)            │
└────────────────┬─────────────┴───────────┬───────────┘
                 │  fetch() / REST         │
┌────────────────┴─────────────────────────┴───────────┐
│                   PHP 8.x 后端                         │
│   api/*.php (端点)  │  includes/*.php (公共模块)        │
│   __DIR__ 相对路径引用，无框架依赖                        │
└────────────────┬─────────────────────────────────────┘
                 │
┌────────────────┴─────────────────────────────────────┐
│                     数据层                             │
│   JSON 运行时文件  │  SQLite / MySQL via PDO            │
│   data/*.json     │  data/galgame.db                  │
└──────────────────────────────────────────────────────┘
```

| 层 | 技术 |
|---|---|
| 前端 | HTML · CSS · Vanilla JavaScript · React 18 · D3.js 7 |
| 后端 | PHP 8.x（`__DIR__` 相对路径，零框架依赖） |
| 数据 | JSON 运行时文件 · SQLite / MySQL via PDO |
| 构建 | Vite（用户中心 SPA）|
| 测试 | Node.js 契约测试（39+ 测试脚本） |
| 部署 | Docker · GitHub Actions CI/CD · Watchtower 自动滚动更新 |
| 国际化 | 中文 / 日本語 双语支持 |

---

## 项目结构

```text
.
├─ admin/                  管理后台（审核、赛事管理、Wiki 编辑）
├─ api/                    PHP API 端点（60+ 接口）
├─ css/                    全站样式
├─ data/                   运行时数据目录（不进入 Git）
├─ Galgame_events/         GalOnly 活动页面与素材
├─ Game/                   Galgame 同好会模拟器
├─ image/background/       本地壁纸投放目录
├─ images/                 站点内置图片资源
├─ includes/               PHP 公共模块（认证、邮件、通知、OAuth…）
├─ js/                     前端脚本（地图、投票、项目管理…）
├─ JUYOU/                  友游活动页
├─ moe/                    萌战系统（含淘汰赛可视化组件）
├─ scripts/                测试、迁移、构建脚本
├─ tools/                  公开工具页（PDF 阅读器等）
├─ twelve/                 十二器赛事页面
├─ user-v2-react/          用户中心 React 源码
├─ wiki/                   Wiki 页面、编辑器与内容数据
│
├─ index.html              主地图入口
├─ login.html              登录 / 注册入口
├─ user.html               用户中心（React SPA）
├─ star_map.html           联合星图
├─ club_square.html        活动中心（原同好会广场）
├─ vote.html               投票活动入口
├─ submit*.html            投稿入口（活动 / 刊物 / 通用）
│
├─ Dockerfile              容器镜像定义
├─ docker-compose.yml      服务编排配置
├─ PROJECT_STRUCTURE.md    目录边界与整理规则
└─ README.md
```

> 根目录的 HTML 文件是公开 URL 路由入口，为兼容现有链接保留在 Web 根。
> 完整的目录边界和整理规则见 [`PROJECT_STRUCTURE.md`](PROJECT_STRUCTURE.md)。

---

## 快速开始

### 环境要求

- PHP 8.0+（含 `mbstring`、`pdo_sqlite` 扩展）
- Node.js 18+（用于测试和构建）
- Git

### 本地运行

```bash
# 1. 克隆仓库
git clone https://github.com/VNFestMap/china-visualnovelcircle-maps.git
cd china-visualnovelcircle-maps

# 2. 安装依赖
npm install

# 3. 准备配置文件
cp config.example.php config.php
# 编辑 config.php，设置数据库路径和站点 URL

# 4. 启动 PHP 开发服务器
php -S 127.0.0.1:8000
```

打开浏览器访问：

| 页面 | 地址 |
|------|------|
| 登录 / 注册 | `http://127.0.0.1:8000/login.html` |
| 访客模式浏览 | `http://127.0.0.1:8000/index.html?guest=1` |

### 运行测试

```bash
npm run check
```

该命令会运行全部 40+ 个契约测试，覆盖前端交互、Wiki 生成、上传契约、同好会编辑、后端隐私、成长系统、用户页面、国际化、性能优化、投票流程、机器人同步和项目整体健康状态。

---

## 部署

项目支持 Docker 容器化部署，通过 GitHub Actions 自动构建镜像并推送至 GHCR，服务器端的 Watchtower 负责自动拉取和滚动更新。

```bash
# 使用 Docker Compose 一键部署
docker compose up -d

# 或使用部署脚本（含数据备份和权限设置）
bash scripts/deploy.sh
```

详细的部署配置、环境变量说明和运维指南见 [`DEPLOY.md`](DEPLOY.md)。

---

## 版本历史

| 版本 | 核心主题 |
|------|---------|
| **v2.2.0** | 同好会动态 React 化、独立搜索、互关私信、管理员 React 工作台、OAuth 凭证升级、GalgameTool Tier/MEME 与后端迁移 |
| **v2.1.0** | 独立专栏、超级管理控制台、北京 GalOnly、MakoQuiz 连携、偏好集中化、Wiki 使用文档 |
| **v2.0.0** | 用户中心 SPA 化、Staff 招募、资料公开库、淘汰赛可视化、设计系统统一 |
| v1.7.x | 企划枢纽、十二器、萌战引擎、投票活动、同好会广场、Docker CI/CD |
| v1.6.x | Wiki 子系统、同好会绑定码、通知公告、多端发布（桌面 / Android） |
| v1.5.0 | 用户面板重设计、GalOnly 高校通道、活动日历报名 |
| v1.0 | 全国同好会地图首发、日本扩展、用户系统 |

---

## 参与贡献

欢迎提交 Issue 报告问题，或通过 Pull Request 贡献代码。

提交前请确认：

```bash
# 1. 运行契约测试
npm run check

# 2. 检查提交内容
git status --short
git status --ignored --short
```

确保本地配置文件（`config.php`、`.env`）、运行时数据（`data/*.json`、`data/cache/`）、用户上传文件（`uploads/`）和构建产物（`node_modules/`、`dist/`）不进入提交列表。

多人协作规范见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

---

## License

本项目基于 [GNU General Public License v3.0](LICENSE) 发布。

---

<p align="center">
  <sub>VNFest — Visual Novel Festival</sub><br>
  <sub>Made with ❤️ for the visual novel community</sub>
</p>
