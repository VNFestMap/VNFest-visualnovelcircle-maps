# 每日日报模块 · 交付报告（Handoff to Codex）

> 交付日期：2026-08-27　｜　目标仓库：`VNFmap2.1`（galgame-map）
> 用途：把「每日 Galgame 行业日报」作为一个 WIKI 节点交付，后续在 Codex 中继续迭代。
> 阅读对象：接手的工程 Agent / 开发者。可据此独立完成运维、更新数据与二次开发。

---

## 1. 一句话目标

在 VNFest WIKI 中新增「每日日报」节点：每天从 Notion 抓取日本 Galgame 行业情报，以 **readhub.cn/daily 同款编号信息流**呈现，顶层框架复用 WIKI 现有样式；支持本期关键词搜索，并可**查询往期、按天跳转**。

## 2. 本次交付的最终形态

**已实现（可直接使用）**
- WIKI 首页 `wiki/index.html` 出现「每日日报」入口区块 + 侧栏目录锚点 `#daily-report`。
- WIKI 扩展位注册：`wiki/feature-slots.json` 新增 `daily` 节点（`status: active`，`url: ./daily/index.html`），维护中心会自动渲染入口。
- 日报今日页 `wiki/daily/index.html`：顶层为 WIKI 三栏百科布局与顶栏，中间为编号情报流（真实数据）。
- 往期查询页 `wiki/daily/archive.html`：跨日期检索 + 每期卡片跳转到对应日期。
- 逐期翻阅：今日页顶部「← 上一期 / 查看往期 / 回到最新 / 下一期 →」。
- 数据抓取脚本：官方 Notion API → 按日期累积合并写回 `data/reports.json`。
- 测试：零依赖契约测试已纳入 `npm run check`；可选浏览器级验证脚本。
- 已用真实数据端到端验证通过（见 §8）。

**未做（刻意为之，按需再做）**
- 未接入 WIKI 的日/英 i18n（`VNFLanguage`）——日报正文目前是中文。
- 未加定时抓取（cron / CI）；更新为手动命令。
- 未改动任何后端 PHP / 数据库；纯静态前端 + JSON。
- 未自动提交 git（见 §9，仓库存在无关的历史未提交改动，需你甄别后提交）。

## 3. 文件清单

### 3.1 本次新增
```
wiki/daily/index.html                     今日日报页（读者页）
wiki/daily/archive.html                   往期查询页
wiki/daily/daily.css                      日报专属样式（仅中间内容 + .wiki-button 补定义）
wiki/daily/daily.js                       日报逻辑（读者页 + 往期页共用，按 body[data-daily-mode] 分支）
wiki/daily/data/reports.json              真实数据快照（当前 1 期 / 9 条，2026-08-27）
scripts/fetch-daily-notion.mjs            Notion 抓取脚本（写 reports.json）
scripts/test-daily-notion-contract.mjs    零依赖契约测试
scripts/test-daily-browser.mjs            可选浏览器级验证（需 jsdom + 本地静态服务器）
```
### 3.2 本次修改
```
wiki/index.html          + 每日日报入口区块、侧栏目录锚点
wiki/feature-slots.json  + daily 节点（active）
package.json             + 3 个 npm 脚本；把契约测试并入 check 链
```
### 3.3 与本次无关、但工作区里已存在的未提交改动（勿混入！）
```
wiki/index.json          （mtime 08-18，日文页面 url 字段补全，非本次）
wiki/package.json        （未跟踪，08-15，非本次）
wiki/guide/index.html    等大量 M 文件        （历史改动，非本次）
```

## 4. 架构与数据流

```
Notion（每日一个页面，标题以 ｜YYYY-MM-DD 结尾）
        │  scripts/fetch-daily-notion.mjs（官方 API，blocks/children 解析）
        ▼
wiki/daily/data/reports.json      ← 按 date 累积合并（新抓取代覆盖同日旧值，旧日期保留）
        │  fetch('./data/reports.json')
        ▼
wiki/daily/daily.js（原生 JS，无构建）
        ├─ reader 模式：渲染今日/ ?date= 指定日期情报流 + 期号导航 + 本期搜索
        └─ archive 模式：往期列表 + 跨期搜索 + 跳转 ./index.html?date=YYYY-MM-DD
        ▲
wiki/daily/index.html、archive.html（顶层复用 ../wiki.css 的 wiki-* 布局类与 --wiki-* 变量）
入口：wiki/index.html #daily-report 区块 / feature-slots(daily) 维护中心
```
- 页面为**静态 HTML + 运行时 fetch JSON**（与 WIKI 其它页面一致，无打包步骤）。
- 因此**必须经 HTTP 访问**；`file://` 下 `fetch` 被拦，日报会显示「加载失败」（脚本已给出该提示）。

## 5. 数据契约（`wiki/daily/data/reports.json`）

```jsonc
{
  "source": { "name": "Notion · 日本 Galgame 行业日报", "url": "https://app.notion.com/p/<id>?v=<view>" },
  "updated": "2026-08-27",                 // = 最新一期 date，供首页/侧栏展示
  "reports": [                             // 按 date 倒序（新在前）
    {
      "date": "2026-08-27",                // YYYY-MM-DD，唯一键
      "title": "日本 Galgame 行业日报",
      "pageId": "3c9007db-6a17-816c-9201-cb99ad1b336e",  // Notion 页面 id（非分享链接的 view id）
      "pageTitle": "日本 Galgame 行业日报 文案版｜2026-08-27",
      "items": [
        {
          "title": "《COCORO》今日发售",     // 纯文本，页面不渲染成链接
          "summary": "Frontwing 与 …",       // 正文摘要
          "meta": "2026-08-27 ｜ Frontwing / GOOD SMILE COMPANY（《COCORO》）", // 固定以 YYYY-MM-DD + 全角｜开头
          "url": "https://cocoro.frontwing.co.jp/"  // 每条唯一可点的来源链接
        }
      ]
    }
  ]
}
```
约束（契约测试会校验）：`date` 与各条 `meta` 前缀均为 `YYYY-MM-DD`；`url` 以 `http(s)://` 开头；`reports` 非空且 `items` 非空。`meta` 用**全角 `｜`** 分隔日期与品牌（`splitMeta` 依赖它）。

## 6. URL 与 DOM 契约（二次开发必读）

**路由**
| 目的 | URL |
|---|---|
| 最新一期 | `wiki/daily/index.html` |
| 指定日期 | `wiki/daily/index.html?date=YYYY-MM-DD` |
| 往期查询 | `wiki/daily/archive.html` |

**模式开关**：页面 `<body data-daily-mode="reader|archive">`，`daily.js` 据此分支。

**挂载点 ID（daily.js 依赖，改名需同步脚本）**
- reader：`digestDate` `digestSub` `digestNav` `digestSearch` `digestStatus` `digestList` `statReportCount` `statItemCount` `sourceLink` `sourceUpdated`
- archive：`archiveSearch` `archiveList` `archiveStatus` `statArchiveCount`

**样式约定**：中间内容类前缀 `vn-daily-*` / `vn-archive-*`，配色只用 `var(--wiki-*)`，跟随 WIKI 浅色/纸色/暗色主题。`.wiki-button` 因共享 `wiki.css` 未定义，已在 `daily.css` 内补充（`publications.html` 也有各自内联版，属既有重复，见 §10）。

## 7. 运行 / 预览 / 更新

```bash
# 本地预览（项目根，任选其一）
php -S 127.0.0.1:8123
python -m http.server 8123
# 然后浏览器打开：
#   http://127.0.0.1:8123/wiki/index.html      看首页入口
#   http://127.0.0.1:8123/wiki/daily/index.html 看今日日报

# 更新数据（需要 Notion 集成 token，见 §10，不要写进代码/仓库）
#   bash:
NOTION_TOKEN=ntn_xxx npm run wiki:daily:fetch
#   Windows CMD:
set NOTION_TOKEN=ntn_xxx && npm run wiki:daily:fetch
#   一次抓多期（往期）：
NOTION_TOKEN=ntn_xxx node scripts/fetch-daily-notion.mjs <pageId1>,<pageId2>
```
`wiki:daily:fetch` 会**累积合并**，不会覆盖历史日期；`updated` 与排序自动刷新。

## 8. 测试与验收

```bash
npm run wiki:daily:test      # 零依赖契约测试（已纳入 npm run check）
npm run wiki:daily:browser   # 可选：需 npm i -D jsdom 且先起 §7 的静态服务器
```
- 契约测试当前 **25 项全 PASS**（数据 schema、页面挂载点、首页入口、feature-slot）。
- 浏览器级验证在临时环境已跑通 **22 项断言**：真实 9 条渲染、`01` 编号 + 标题为纯文本、来源域名可点、`meta` 拆分、本期搜索「Navel→2 条」、`?date=` 定位、未知日期回退引导、往期列表→详情、首页入口与目录锚点。
- 抓取脚本已用真实 token 实跑成功，写回 1 期 / 9 条。

**给 Codex 的快速验收清单**
1) `npm run wiki:daily:test` 通过；
2) 起静态服务器后 `wiki/daily/index.html` 渲染出当日全部条目且末尾可点来源；
3) 顶部「上一期/下一期/查看往期」与 `?date=` 跳转一致；
4) `archive.html` 搜索能过滤并跳转到对应日期；
5) 从 `wiki/index.html` 的「每日日报」区块可进入两页。

## 9. 提交建议（重要）

工作区存在**与本次无关的既有未提交改动**（`wiki/index.json`、`wiki/package.json`、`wiki/guide/index.html` 等，mtime 早于本次）。建议只暂存本次文件，单独成一个提交：
```bash
git add wiki/daily scripts/fetch-daily-notion.mjs scripts/test-daily-notion-contract.mjs scripts/test-daily-browser.mjs \
        wiki/index.html wiki/feature-slots.json package.json
git commit -m "feat(wiki): 新增每日日报节点（Notion 抓取 + readhub 式简报 + 往期查询）"
```
提交前请自行 `git diff` 确认未混入无关改动。

## 10. 已知限制与后续建议

**数据 / 凭据**
- Notion「视图副本」分享链接（带 `?v=`）**不被官方 API 支持**；抓取用的是集成被授权到的**真实页面 id**（当前 `3c9007db-…cba55` 的父页 `3c9007db-6a17-816c-9201-cb99ad1b336e`）。往期需各自页面单独授权。
- 当前仅有 **1 期真实数据**（2026-08-27）。往期机制已就绪，抓到更多期即自动填充。
- 本轮调试用的集成 token 已在对话中出现，**建议尽快在 Notion 重置该集成密钥**；token 只应经环境变量注入，切勿写入仓库或本文件。

**功能可迭代项**
- i18n：日报正文可接入 `VNFLanguage` / `data-i18n`，与 WIKI 其余页一致（当前中文）。
- `.wiki-button` 定义散落在 `daily.css` 与 `publications.html`，可上收到 `wiki.css` 统一。
- 自动化：把 `wiki:daily:fetch` 挂到定时任务 / CI（配合 `scripts/sync-data.sh` 现有模式）。
- 首页脚本 `updateDynamicSections()` 只重写特定容器（`recentUpdates/wikiCountries/…`），**不覆盖** 我新增的静态 `#daily-report`；若后续把入口改成 JSON 驱动，需仿照 `feature-slots`/`library` 增加独立渲染分支，避免误清空。
- 可选：为往期页做「按日历聚合」或分页；为详情页加上一条「分享/复制链接」。

## 11. 关键标识速查

| 项 | 值 |
|---|---|
| WIKI 节点 key | `daily` |
| 读者页 | `wiki/daily/index.html`（`?date=YYYY-MM-DD`） |
| 往期页 | `wiki/daily/archive.html` |
| 数据文件 | `wiki/daily/data/reports.json` |
| 抓取脚本 | `scripts/fetch-daily-notion.mjs`（`npm run wiki:daily:fetch`） |
| 契约测试 | `scripts/test-daily-notion-contract.mjs`（`npm run wiki:daily:test`） |
| 当前数据 | 1 期 · 9 条 · 2026-08-27 · pageId `3c9007db-6a17-816c-9201-cb99ad1b336e` |
| 数据源 | Notion 分享页（view 副本，仅展示用；抓取走页面 id） |
