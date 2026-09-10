# Galgame履历书 (Galgame Resume)

对 [bishogedb.com/profile](https://bishogedb.com/profile) 的逆向工程复刻，适配 VNFmap 前端风格，支持 **Bangumi + VNDB + CnGal + 鲲Gal + 月暮Gal** 五 API 数据源（CnGal 始终启用，其余四个可在作品搜索时自选启用）。角色搜索使用 Bangumi + CnGal，VNDB 角色接口已停用。

## 功能特性

### 核心功能
- **履历书模式 (Resume Mode)** — 传统履历书网格布局，完美复刻原版设计
- **卡片模式 (Card Mode)** — 现代卡片式个人资料布局
- **可编辑文本** — 点击任意文本字段即可编辑，实时保存
- **拖拽排序** — 同一板块内的作品缩略图/列表项可拖拽重新排序
- **VNFest 统一风格** — 接入 VNFest 顶层顶栏、主题运行时和页面背景偏好；工具 tab 固定在顶栏下方
- **图片导出预览** — 长履历按板块边界分割成独立图片，可单张保存、全部保存，也可合并成一张长图
- **账号履历同步** — 登录 VNFmap 账号后自动带入头像、昵称和 ID，并将履历同步到账号；游客仍使用本机草稿
- **Bangumi 一键导入** — 绑定 Bangumi 后预览并勾选已看过的游戏，追加到喜欢的作品并按 Bangumi ID 去重

### 数据搜索
- **CnGal API** (`api.cngal.org`) — 中文 Galgame 资料站，始终启用
- **Bangumi API** (`api.bgm.tv/v0`) — 中文/日文游戏、角色数据，可自选启用
- **VNDB API** (`api.vndb.org/kana`) — 英文视觉小说数据库，仅用于作品搜索；角色搜索不调用 VNDB
- **鲲Gal API** (`www.kungal.com/api`) — 中文 Galgame 数据库，可自选启用
- **月暮Gal API** (`www.ymgal.games/open`) — 中文 Galgame 资料库，可自选启用
- 搜索弹窗中可切换 API 源（CnGal 显示为"始终启用"不可取消）
- 搜索结果标注来源（Bangumi 红 / VNDB 紫 / CnGal 蓝 / 鲲Gal 青 / 月暮Gal 深紫）
- 支持按发售年份筛选
- 多选添加（默认最多15件，"更多项目"模式最多30件）
- 不支持 CORS 的 API（鲲Gal、月暮Gal）自动通过 CORS 代理访问

### 履历书项目
- 姓名（昵称）+ X(Twitter) / Bangumi 账号切换
- 喜欢的类型（四选多多选：角色作 / 剧情作 / 拔作 / 其他）
- 喜欢的厂商（可编辑列表项，支持拖拽排序）
- 喜欢的作品（封面图缩略图，支持拖拽排序）
- 喜欢的女主角（角色图缩略图，支持拖拽排序）
- Galgame履历（游玩年数）
- 游玩数量（游戏数量）
- 喜欢的声优（可编辑列表项，支持拖拽排序）
- 喜欢的原画家（可编辑列表项，支持拖拽排序）
- 喜欢的剧本家（可编辑列表项，支持拖拽排序）
- 喜欢的Galgame歌曲（可编辑列表项，支持拖拽排序）
- 喜欢的属性（可编辑列表项，支持回车确认和拖拽排序）
- 其他（自由文本）

### 头像功能
- 上传自定义头像
- 圆形 / 正方形形状切换
- 拖动调整图片显示位置（剪裁）
- 与履历书边框完美重叠

### 其他功能
- **保存图片** — 使用 html2canvas 导出高清 PNG（2x 缩放）
- **X 分享** — 一键生成分享推文
- **重置** — 清空所有数据
- **履历持久化** — 登录用户使用 VNFmap 履历 API + 按账号隔离的本机缓存，游客使用本机缓存
- **自定义图片上传** — 支持上传本地图片+自定义标签
- **可选中文装饰字体** — 字体二进制不随本仓库分发，未提供时自动使用系统回退字体
- **全 SVG 图标** — 无 emoji，全部使用内联 SVG 图标

## 使用方法

### 直接打开
直接用浏览器打开 `index.html` 即可使用，无需服务器。

### 本地服务器（推荐，避免 CORS 问题）
```bash
# Python
python -m http.server 8080

# Node.js
npx serve .
```
然后访问 `http://localhost:8080`

## API 说明

### Bangumi API
- 基础 URL: `https://api.bgm.tv/v0/`
- 作品搜索: `POST /search/subjects` (type=4 for games)
- 角色搜索: `POST /search/characters`
- 无需认证即可使用（有速率限制）
- 已绑定账号的私有收藏通过 VNFmap `/api/bangumi_account.php?action=collections` 读取，只导入 `subject_type=4` 且 `type=2` 的已看过游戏
- OAuth Access Token 和 Refresh Token 只保存在服务器，不进入浏览器履历数据
- 文档: https://github.com/bangumi/api

### VNDB API
- 基础 URL: `https://api.vndb.org/kana/`
- 视觉小说搜索: `POST /vn`
- 角色搜索：GalgameTool 不调用该接口
- 作品搜索无需认证即可使用
- 文档: https://api.vndb.org/kana

### CnGal API
- 基础 URL: `https://api.cngal.org/`
- 搜索: `GET /api/home/Search?Page=1&Types=Game|Role&Text=关键词`
- 词条详情: `GET /api/entries/GetEntryView/{id}`
- 无需认证即可使用
- 文档: https://api.cngal.org/swagger/index.html
- 源码: https://github.com/CnGal/CnGalWebSite

### 鲲Gal API
- 基础 URL: `https://www.kungal.com/api/`
- 搜索: `GET /search?Keywords=关键词&Type=galgame|character&Page=1&Limit=15`
- 无需认证即可使用
- 不支持 CORS，通过 CORS 代理访问

### 月暮Gal API
- 基础 URL: `https://www.ymgal.games/open/`
- OAuth Token: `GET /oauth/token?grant_type=client_credentials&client_id=ymgal&client_secret=<按月暮Gal开发者文档配置>&scope=public`
- 游戏搜索: `GET /archive/search-game?mode=list&keyword=关键词&pageNum=1&pageSize=15`
- 需 OAuth Bearer Token（凭证按月暮Gal开发者文档配置，token 缓存1小时）
- 仅支持游戏搜索，无角色搜索 API
- 不支持 CORS，通过 CORS 代理访问
- 文档: https://www.ymgal.games/developer

## 技术栈
- 纯 HTML/CSS/JavaScript（零构建依赖）
- html2canvas（图片导出）
- Google Fonts（ZCOOL KuaiLe / Noto Sans SC / Noto Sans JP）
- Fetch API + LocalStorage（游客草稿与登录用户本机缓存）
- VNFmap 履历 API（登录用户云端同步）
- 原生 Drag and Drop API（拖拽排序）

## 与原版的差异
1. **数据源**: 原版使用自建数据库（DLsite/FANZA/批評空間数据），本版本使用 Bangumi + VNDB + CnGal + 鲲Gal + 月暮Gal 公开 API
2. **前端风格**: 适配 VNFmap 浅色红色主题，原版为深色主题
3. **侧边栏导航**: 仅保留履历书功能，原版有更多页面
4. **用户系统**: 支持 VNFmap 登录用户云端履历同步，未登录时保留本机模式
5. **价格追踪**: 原版有价格变动追踪功能，本版本聚焦履历书功能

## CORS 说明
- Bangumi、VNDB、CnGal API 支持 CORS，可直接从浏览器调用；Bangumi 私有收藏通过同源 VNFmap API 读取
- 鲲Gal、月暮Gal API 不支持 CORS，应用会自动通过 CORS 代理（allorigins.win）访问
- CORS 代理服务可能不稳定或有速率限制，如遇搜索失败可稍后重试
- 通过本地服务器（http://localhost）访问可改善部分 CORS 问题，但不支持 CORS 的 API 仍需代理

## 项目结构
```
GalgameTool/
├── index.html      # 页面骨架、弹窗容器和资源引用
├── galgame-tool.css # 工具页样式、响应式布局和主题适配
├── galgame-tool.js  # 履历编辑、搜索、导入和导出逻辑
├── README.md       # 本文件
├── assets/          # 账号平台等工具资源
└── fonts/
    └── README.md               # 字体说明；二进制字体按授权另行提供
```

## 许可证
仅供学习和研究使用。原版网站 © びしょげDB。原版站点的代码、数据、品牌和第三方资源不因本项目复刻而自动获得再分发授权。
