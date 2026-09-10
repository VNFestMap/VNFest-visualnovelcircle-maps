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
import {
  hasTopSection,
  META_DATE_RE,
  parseItems,
  parseStructuredItems,
  parseTopItems,
} from './daily-report-parser.mjs'

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

  // 同一天可能同时存在“正式日报”和“文案版/草稿版”。不要直接使用
  // Notion 搜索结果的更新时间排序：文案版经常比正式日报更晚编辑。
  return matches.map(({ page }) => page)
}

const parsedIssueCache = new Map()

async function parseIssue(pageId, { announce = true } = {}) {
  if (parsedIssueCache.has(pageId)) return parsedIssueCache.get(pageId)

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

  const topItems = parseTopItems(blocks, { fallbackUrl: page.url || SOURCE_SHARE_URL })
  const structuredItems = parseStructuredItems(blocks)
  let items
  let parser
  if (hasTopSection(blocks)) {
    items = topItems
    parser = 'TOP/重点新闻章节'
  } else if (structuredItems.length) {
    items = structuredItems
    parser = '最近动态列表'
  } else {
    items = parseItems(groups, { pageTitle })
    parser = '空段落分组'
  }
  if (announce) console.log(`解析策略：${parser}；有效条目：${items.length}`)

  const issue = {
    date,
    title: '日本 Galgame 行业日报',
    pageId,
    pageTitle,
    lastEdited: page.last_edited_time,
    parser,
    items,
  }
  parsedIssueCache.set(pageId, issue)
  return issue
}

function issueQuality(issue) {
  // 用户指定抓取“文案版”。同日页面选择先服从页面类型，再比较
  // 页面结构；这样不会因为正式版的 TOP 结构或更新时间更高而误选正式版。
  const editionWeight = issue.pageTitle.includes('文案版') ? 5_000_000 : 0
  // 在同一类页面内，TOP 章节是最稳定的结构，其次是最近动态列表，
  // 最后才使用旧式空段落分组。
  const parserWeight = issue.parser.startsWith('TOP/')
    ? 3_000_000
    : issue.parser === '最近动态列表'
      ? 2_000_000
      : 1_000_000
  const validItems = issue.items.filter((item) =>
    item.title && item.summary && META_DATE_RE.test(item.meta || '') && /^https?:\/\//.test(item.url || ''),
  ).length
  const directItems = issue.items.filter((item) => item.sourceType === 'direct').length
  const itemWeight = Math.min(validItems, 100) * 1_000
  const directWeight = directItems * 10
  return editionWeight + parserWeight + itemWeight + directWeight
}

if (autoDiscoverToday) {
  const today = dateInTimeZone()
  const todayPages = await searchTodayPage(today)
  if (!todayPages.length) {
    throw new Error(`未找到 ${today} 的 Notion 日报页面，请确认页面已创建且集成有权限；如需手动回填可设置 NOTION_AUTO_DISCOVER=0`)
  }
  const candidates = await Promise.all(todayPages.map((page) => parseIssue(page.id, { announce: false })))
  const ranked = candidates
    .map((issue) => ({ issue, quality: issueQuality(issue) }))
    .sort((a, b) => b.quality - a.quality)
  const todayIssue = ranked.find(({ issue }) => issue.items.length > 0)?.issue || ranked[0].issue
  const todayPageId = todayIssue.pageId
  pageIds = [todayPageId, ...pageIds.filter((id) => id !== todayPageId)]
  console.log(`自动发现今日页面：${todayIssue.pageTitle}（${todayPageId}）`)
  if (ranked.length > 1) {
    console.log(`同日候选页面 ${ranked.length} 个，已按页面结构和有效条目数选择：${todayIssue.parser}；${todayIssue.items.length} 条`)
  }
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
