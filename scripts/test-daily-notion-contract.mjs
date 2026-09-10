/* ===========================================================================
 * 每日日报 · 数据与结构契约测试（零依赖，可直接进 npm run check）
 * 运行：node scripts/test-daily-notion-contract.mjs
 *   或：npm run wiki:daily:test
 * 校验：reports.json 数据契约、daily 页面 DOM 挂载点、首页入口、feature-slot。
 * =========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { META_DATE_RE, parseItems, parseStructuredItems, parseTopItems } from './daily-report-parser.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let failed = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
  if (!cond) failed++
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
// ---- 1. reports.json 数据契约 ----
let data = null
try {
  data = JSON.parse(read('wiki/daily/data/reports.json'))
} catch (e) {
  check('reports.json 可解析', false, e.message)
}
if (data) {
  check('source.url 为 http(s)', /^https?:\/\//.test(data.source?.url || ''))
  check('reports 为非空数组', Array.isArray(data.reports) && data.reports.length > 0, `期数=${data.reports?.length}`)
  const dates = (data.reports || []).map((r) => r.date)
  check('日期格式 YYYY-MM-DD', dates.every((d) => DATE_RE.test(d)), dates.join(','))
  const desc = dates.every((a, i) => i === 0 || dates[i - 1] >= a)
  check('日期倒序排列', desc)
  let itemsOk = true
  let itemBad = ''
  for (const r of data.reports) {
    if (!Array.isArray(r.items) || r.items.length === 0) { itemsOk = false; itemBad = `${r.date} 无条目`; break }
    for (const it of r.items) {
      if (!it.title || !it.summary || !META_DATE_RE.test(it.meta || '') || !/^https?:\/\//.test(it.url || '')) {
        itemsOk = false; itemBad = `${r.date}: ${JSON.stringify(it).slice(0, 80)}`; break
      }
    }
    if (!itemsOk) break
  }
  check('每条含 标题/摘要/日期｜meta/URL', itemsOk, itemBad)
}

// ---- 2. 日报页面挂载点 ----
const reader = read('wiki/daily/index.html')
check('读者页 data-daily-mode=reader', reader.includes('data-daily-mode="reader"'))
for (const id of ['digestDate', 'digestNav', 'digestList', 'digestStatus']) {
  check(`读者页挂载点 #${id}`, reader.includes(`id="${id}"`))
}
check('读者页已移除本期搜索模块', !reader.includes('id="digestSearch"') && !reader.includes('在本期内搜索'))
check('读者页已移除右侧说明板块', !reader.includes('wiki-index-aside') && !reader.includes('数据来源') && !reader.includes('阅读说明'))
check('读者页引用 daily.css/daily.js', reader.includes('./daily.css') && reader.includes('./daily.js'))
check('读者页 WIKI 面包屑', reader.includes('../index.html') && reader.includes('../../index.html'))

const archive = read('wiki/daily/archive.html')
check('往期页 data-daily-mode=archive', archive.includes('data-daily-mode="archive"'))
for (const id of ['archiveSearch', 'archiveList', 'archiveStatus']) {
  check(`往期页挂载点 #${id}`, archive.includes(`id="${id}"`))
}
check('往期页已移除右侧说明板块', !archive.includes('wiki-index-aside') && !archive.includes('怎么用') && !archive.includes('数据维护'))

const logic = read('wiki/daily/daily.js')
check('daily.js 读取 ./data/reports.json', logic.includes('./data/reports.json'))
check('daily.js 支持 ?date= 定位', logic.includes('get(\'date\')') || logic.includes('"date"'))

const fetcher = read('scripts/fetch-daily-notion.mjs')
check('抓取脚本按上海时区确定今天', fetcher.includes("Asia/Shanghai"))
check('抓取脚本自动搜索当天日报页面', fetcher.includes('searchTodayPage') && fetcher.includes("'/search'"))
check('抓取脚本合并自动发现的页面 ID', fetcher.includes('todayPageId') && fetcher.includes('NOTION_AUTO_DISCOVER'))
check(
  '同日多个日报页面优先抓取文案版',
  fetcher.includes("issue.pageTitle.includes('文案版')") && fetcher.includes('同日候选页面'),
)
const approximateItem = parseItems([[
  '国产视觉小说《光与影之恋》',
  '2026-08-下旬 ｜ 琉璃花糖（同人社团）',
  'https://www.cngal.org/articles/index/10210',
]])[0]
check(
  '抓取脚本支持上旬/中旬/下旬来源日期',
  fetcher.includes('parseItems') && approximateItem?.meta === '2026-08-下旬 ｜ 琉璃花糖（同人社团）',
  approximateItem?.meta || '未识别',
)
const pageTitle = '日本 Galgame 行业日报 文案版｜2026-08-29'
const titleJoinedWithFirstItem = parseItems([[
  pageTitle,
  'Frontwing×Bushiroad 新作《ディスディスディスカッション》制作决定',
  '以“自主自律”为宗旨的青春群像剧。',
  '2026-08-28 ｜ Frontwing（Bushiroad）',
  'https://ddd.frontwing.co.jp/',
]], { pageTitle })[0]
check(
  '抓取脚本剥离与首条新闻连在一起的页面标题',
  titleJoinedWithFirstItem?.title === 'Frontwing×Bushiroad 新作《ディスディスディスカッション》制作决定' &&
    titleJoinedWithFirstItem?.meta === '2026-08-28 ｜ Frontwing（Bushiroad）',
  titleJoinedWithFirstItem?.title || '未识别',
)
const structuredItems = parseStructuredItems([
  { type: 'heading_1', heading_1: { rich_text: [{ plain_text: '三、最近动态完整列表' }] } },
  { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: '2026-08-29 ｜ 联结互动 ｜ 交叠之夏 ｜ A/D ｜ 定档 9/1 Steam 发售 ｜ 高 ｜ https://www.cngal.org/entries/index/6510' }] } },
  { type: 'heading_1', heading_1: { rich_text: [{ plain_text: '四、新作与发售情报' }] } },
])
check(
  '抓取脚本解析长报告的最近动态列表',
  fetcher.includes('parseStructuredItems') && structuredItems.length === 1 &&
    structuredItems[0]?.title === '交叠之夏' &&
    structuredItems[0]?.meta === '2026-08-29 ｜ 联结互动',
  structuredItems[0]?.title || '未识别',
)
const topItems = parseTopItems([
  { type: 'heading_1', heading_1: { rich_text: [{ plain_text: '二、重要新闻 TOP10（按实际 7 条）' }] } },
  { type: 'heading_2', heading_2: { rich_text: [{ plain_text: '1. 《交叠之夏》定档 9月1日 Steam 发售【已确认】' }] } },
  { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: '来源：联结互动（国产独立工作室）｜发布时间：2026-08-29｜分类：A 新作发表/D 发售日期' }] } },
  { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: '事实内容：国产视觉小说《交叠之夏》宣布 9 月 1 日正式上线 Steam。含双结局与一种隐藏式开放结局，可自定义主角名，WebGAL 引擎。' }] } },
  { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: '来源链接：https://www.cngal.org/entries/index/6510 ｜ https://store.steampowered.com/app/4251610/' }] } },
  { type: 'heading_1', heading_1: { rich_text: [{ plain_text: '三、最近动态完整列表' }] } },
])
check(
  '抓取脚本优先解析 TOP10 完整标题和官方链接',
  fetcher.includes('parseTopItems') && topItems.length === 1 &&
    topItems[0]?.title === '《交叠之夏》定档 9月1日 Steam 发售（联结互动工作室国产视觉小说，双结局+隐藏开放结局，WebGAL引擎）' &&
    topItems[0]?.meta === '2026-08-29 ｜ 联结互动（同人社团）' &&
    topItems[0]?.url === 'https://store.steampowered.com/app/4251610/',
  topItems[0]?.title || '未识别',
)
const nestedTopItems = parseTopItems([
  { type: 'heading_2', heading_2: { rich_text: [{ plain_text: '重要新闻 TOP' }] } },
  { type: 'heading_3', heading_3: { rich_text: [{ plain_text: '1. 《グリザイアの新果実 -集結の百果-》公布，2027 年发售' }] } },
  { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: '主体：GOOD SMILE COMPANY、Frontwing Lab。' }] } },
  { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: '发布时间：2026-09-01 12:00（日本时间）。' }] } },
  { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: '【事实】《グリザイア》15 周年完全新作 ADV 公布。' }] } },
  { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: '来源：https://www.frontwing.jp/' }] } },
  { type: 'heading_2', heading_2: { rich_text: [{ plain_text: '最近动态完整列表' }] } },
])
check(
  '抓取脚本支持 TOP 章节下的三级新闻标题',
  fetcher.includes('parseTopItems') && nestedTopItems.length === 1 &&
    nestedTopItems[0]?.title === '《グリザイアの新果実 -集結の百果-》公布，2027 年发售' &&
    nestedTopItems[0]?.meta === '2026-09-01 ｜ GOOD SMILE COMPANY、Frontwing Lab' &&
    nestedTopItems[0]?.url === 'https://www.frontwing.jp/',
  nestedTopItems[0]?.title || '未识别',
)
const numberedTopItems = parseTopItems([
  { type: 'heading_1', heading_1: { rich_text: [{ plain_text: '重点新闻精选' }] } },
  { type: 'numbered_list_item', numbered_list_item: { rich_text: [{ plain_text: '1. 编号列表新闻标题' }] } },
  { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: '主体：编号测试机构。' }] } },
  { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: '发布时间：2026-09-02。' }] } },
  { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: '【事实】编号新闻内容。' }] } },
  { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: '来源：https://example.com/numbered' }] } },
  { type: 'heading_1', heading_1: { rich_text: [{ plain_text: '其他内容' }] } },
])
check(
  '抓取脚本支持 TOP 章节中的编号列表新闻',
  numberedTopItems.length === 1 && numberedTopItems[0]?.title === '编号列表新闻标题',
  numberedTopItems[0]?.title || '未识别',
)
const topItemWithoutDirectUrl = parseTopItems([
  { type: 'heading_2', heading_2: { rich_text: [{ plain_text: '重要新闻 TOP' }] } },
  { type: 'heading_3', heading_3: { rich_text: [{ plain_text: '1. 无直接链接的新闻' }] } },
  { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: '主体：测试机构。' }] } },
  { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: '发布时间：2026-09-02。' }] } },
  { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: '【事实】这条新闻在报告中没有直接来源 URL。' }] } },
  { type: 'heading_2', heading_2: { rich_text: [{ plain_text: '最近动态完整列表' }] } },
], { fallbackUrl: 'https://www.notion.so/example-report' })
check(
  '抓取脚本保留无直接链接的 TOP 新闻并回退到原报告页',
  topItemWithoutDirectUrl.length === 1 &&
    topItemWithoutDirectUrl[0]?.title === '无直接链接的新闻' &&
    topItemWithoutDirectUrl[0]?.url === 'https://www.notion.so/example-report' &&
    topItemWithoutDirectUrl[0]?.sourceType === 'report-page',
  topItemWithoutDirectUrl[0]?.url || '未识别',
)
const runner = read('scripts/run-daily-report-cron.sh')
check('定时包装器保留自动发现模式', runner.includes('run_node "$FETCH_SCRIPT"') && !runner.includes('fetch_args+=('))

// ---- 3. 首页入口与节点 ----
const home = read('wiki/index.html')
check('首页含 #daily-report 区块', home.includes('id="daily-report"'))
check('首页链接今日日报', home.includes('./daily/index.html'))
check('首页链接往期页', home.includes('./daily/archive.html'))
check('首页目录锚点', home.includes('href="#daily-report"'))

const slots = JSON.parse(read('wiki/feature-slots.json'))
const dailySlot = (slots.slots || []).find((s) => s.key === 'daily')
check('feature-slot daily 已启用', dailySlot?.status === 'active' && dailySlot?.url === './daily/index.html', JSON.stringify(dailySlot))

console.log(failed ? `\n${failed} FAILURES` : '\nALL PASS')
process.exit(failed ? 1 : 0)
