/* ===========================================================================
 * 每日日报 · Notion 抓取脚本
 * ---------------------------------------------------------------------------
 * 从 Notion 官方 API 拉取「日本 Galgame 行业日报」页面，解析后按日期
 * 合并写入 wiki/daily/data/reports.json（往期会累积，不覆盖旧日期）。
 *
 * 前置：
 *   1) Notion 建一个内部集成，拿到 ntn_ 开头的 token；
 *   2) 在每个日报页面右上角「…」→ 连接(Connections) 里勾选该集成。
 *
 * 用法（在项目根目录）：
 *   Windows CMD :  set NOTION_TOKEN=ntn_xxx && node scripts/fetch-daily-notion.mjs
 *   PowerShell  :  $env:NOTION_TOKEN="ntn_xxx"; node scripts/fetch-daily-notion.mjs
 *   bash        :  NOTION_TOKEN=ntn_xxx node scripts/fetch-daily-notion.mjs
 *
 * 指定页面 id（逗号分隔，可传多个以一次抓多期）：
 *   node scripts/fetch-daily-notion.mjs <pageId1>,<pageId2>
 *   未提供命令行页面 ID 时，会将自动发现的当天页面与 NOTION_PAGE_IDS 合并；
 *   设置 NOTION_AUTO_DISCOVER=0 可关闭自动发现。
 * =========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TOKEN = process.env.NOTION_TOKEN
if (!TOKEN) {
  console.error('缺少环境变量 NOTION_TOKEN（形如 ntn_xxx 的集成密钥）')
  process.exit(1)
}
const VERSION = '2022-06-28'
const API_BASE_URL = process.env.NOTION_API_BASE_URL || 'https://api.notion.com/v1'
const REPORT_TIME_ZONE = process.env.NOTION_REPORT_TIME_ZONE || 'Asia/Shanghai'
const DEFAULT_PAGES = ['3c9007db-6a17-816c-9201-cb99ad1b336e']
const SOURCE_SHARE_URL =
  'https://app.notion.com/p/e622db10061342b4bd31bb7452314803?v=655d15134e244f4e86612fb78a2c07a6'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'wiki', 'daily', 'data', 'reports.json')

const cliPageIds = (process.argv[2] || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const configuredPageIds = (process.env.NOTION_PAGE_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
let pageIds = cliPageIds.length
  ? cliPageIds
  : (configuredPageIds.length ? configuredPageIds : DEFAULT_PAGES)
const hasCliPageIds = Boolean(process.argv[2]?.trim())
const autoDiscoverToday = !hasCliPageIds && process.env.NOTION_AUTO_DISCOVER !== '0'

async function api(pathname, init = {}) {
  const r = await fetch(`${API_BASE_URL}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Notion-Version': VERSION,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  })
  if (!r.ok) throw new Error(`${pathname} -> ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return r.json()
}

async function getBlocks(id) {
  const out = []
  let cursor
  do {
    const res = await api(`/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`)
    out.push(...res.results)
    cursor = res.has_more ? res.next_cursor : undefined
  } while (cursor)
  return out
}

const blockText = (b) => (b[b.type]?.rich_text || []).map((t) => t.plain_text).join('')

function dateInTimeZone(value = new Date(), timeZone = REPORT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function pageTitleOf(page) {
  const titleProperty = Object.values(page.properties || {}).find(
    (property) => property?.type === 'title' || Array.isArray(property?.title),
  )
  return (titleProperty?.title || []).map((t) => t.plain_text || '').join('').trim()
}

async function searchTodayPage(date) {
  const results = []
  let cursor
  do {
    const body = {
      query: date,
      page_size: 100,
      filter: { property: 'object', value: 'page' },
    }
    if (cursor) body.start_cursor = cursor
    const res = await api('/search', { method: 'POST', body: JSON.stringify(body) })
    results.push(...(res.results || []))
    cursor = res.has_more ? res.next_cursor : undefined
  } while (cursor)

  const matches = results
    .map((page) => ({ page, title: pageTitleOf(page) }))
    .filter(({ title }) => title.includes('日本 Galgame 行业日报') && title.endsWith(date))
    .sort((a, b) => String(b.page.last_edited_time || '').localeCompare(String(a.page.last_edited_time || '')))

  return matches[0]?.page || null
}

async function parseIssue(pageId) {
  const [page, blocks] = await Promise.all([api(`/pages/${pageId}`), getBlocks(pageId)])
  const pageTitle = pageTitleOf(page)
  const m = pageTitle.match(/(\d{4})-(\d{2})-(\d{2})\s*$/)
  const date = m ? `${m[1]}-${m[2]}-${m[3]}` : dateInTimeZone(new Date(page.last_edited_time))

  const groups = []
  let cur = []
  for (const b of blocks) {
    const text = blockText(b).trim()
    if (text === '') {
      if (cur.length) groups.push(cur)
      cur = []
    } else cur.push(text)
  }
  if (cur.length) groups.push(cur)

  const items = groups
    .filter((g) => g.length >= 2)
    .map((g) => ({
      title: g[0],
      summary: g[1] ?? '',
      meta: g.find((l) => /^(?:约)?\d{4}-\d{2}-\d{2}/.test(l)) ?? '',
      url: (g.find((l) => /^https?:\/\//.test(l)) ?? '').trim(),
    }))

  return { date, title: '日本 Galgame 行业日报', pageId, pageTitle, lastEdited: page.last_edited_time, items }
}

if (autoDiscoverToday) {
  const today = dateInTimeZone()
  const todayPage = await searchTodayPage(today)
  if (!todayPage) {
    throw new Error(`未找到 ${today} 的 Notion 日报页面，请确认页面已创建且集成有权限；如需手动回填可设置 NOTION_AUTO_DISCOVER=0`)
  }
  const todayPageId = todayPage.id
  pageIds = [todayPageId, ...pageIds.filter((id) => id !== todayPageId)]
  console.log(`自动发现今日页面：${pageTitleOf(todayPage)}（${todayPageId}）`)
}

// 读取已有数据以便按日期累积合并
let existing = { source: { name: 'Notion · 日本 Galgame 行业日报', url: SOURCE_SHARE_URL }, updated: '', reports: [] }
try {
  existing = JSON.parse(fs.readFileSync(OUT, 'utf8'))
} catch {
  /* 首次运行，用默认结构 */
}

const fetched = await Promise.all(pageIds.map(parseIssue))
const map = new Map((existing.reports || []).map((r) => [r.date, r]))
for (const r of fetched) map.set(r.date, r) // 新抓取的覆盖同日旧数据

const reports = [...map.values()].sort((a, b) => (a.date < b.date ? 1 : -1))
const payload = {
  source: existing.source || { name: 'Notion · 日本 Galgame 行业日报', url: SOURCE_SHARE_URL },
  updated: reports[0]?.date || existing.updated || '',
  reports,
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf8')
console.log(`已写入 ${path.relative(ROOT, OUT)}`)
console.log(`共 ${reports.length} 期：` + reports.map((r) => `\n  ${r.date}  ${r.items.length} 条  ${r.pageTitle || ''}`).join(''))
