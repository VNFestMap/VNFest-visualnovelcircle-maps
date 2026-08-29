/* ===========================================================================
 * 每日日报 · 数据与结构契约测试（零依赖，可直接进 npm run check）
 * 运行：node scripts/test-daily-notion-contract.mjs
 *   或：npm run wiki:daily:test
 * 校验：reports.json 数据契约、daily 页面 DOM 挂载点、首页入口、feature-slot。
 * =========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let failed = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
  if (!cond) failed++
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const META_DATE_RE = /^(?:约)?\d{4}-\d{2}-\d{2}/

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
