/* 每日日报条目解析的纯函数，供抓取脚本和契约测试共用。 */

// Notion 来源日期既支持精确日，也支持“上旬 / 中旬 / 下旬”这种模糊日期。
export const META_DATE_RE = /^(?:约)?\d{4}-\d{2}-(?:\d{2}|上旬|中旬|下旬)(?=\s|｜|$)/
const DATE_TOKEN_RE = /(?:约)?\d{4}-\d{2}-(?:\d{2}|上旬|中旬|下旬)/
const HEADING_LEVEL_RE = /^heading_(\d)$/
const SOURCE_LABEL_RE = /^(?:来源|主体|制作|制作组|开发者|开发|发行|发行商)：/

export function metaLineOf(lines) {
  return lines.find((line) => META_DATE_RE.test(String(line).trim())) ?? ''
}

function blockText(block) {
  const value = block?.[block?.type] || {}
  return (value.rich_text || []).map((part) => part.plain_text || '').join('').trim()
}

function headingLevel(type) {
  return Number(String(type || '').match(HEADING_LEVEL_RE)?.[1] || 0)
}

function urlsOf(text) {
  return [...String(text).matchAll(/https?:\/\/\S+/g)]
    .map((match) => match[0].replace(/[，。；）)]+$/, ''))
}

function organizationOf(sourceLine) {
  const source = String(sourceLine)
    .replace(/^(?:来源|主体)：\s*/, '')
    .split('｜')[0]
    .replace(/[。；]+$/, '')
    .trim()
  if (!source) return ''
  if (/(工作室|制作组|独立开发者)/.test(source)) {
    return `${source.split(/[（(]/)[0].trim()}（同人社团）`
  }
  return source
}

function enrichedHeadline(headline, sourceLine, factLine) {
  const title = String(headline)
    .replace(/^\d+\.\s*/, '')
    .replace(/【[^】]+】\s*$/, '')
    .trim()
  const facts = String(factLine).replace(/^(?:事实内容：|【事实】)\s*/, '').trim()
  const source = String(sourceLine).replace(/^(?:来源|主体)：\s*/, '').split('｜')[0].trim()
  const descriptors = []

  if (/(工作室|制作组)/.test(source)) {
    descriptors.push(`${source.split(/[（(]/)[0].trim()}工作室`)
  }
  if (facts.includes('国产视觉小说')) descriptors.push('国产视觉小说')
  if (facts.includes('双结局') && facts.includes('隐藏式开放结局')) {
    descriptors.push('双结局+隐藏开放结局')
  }
  const engine = facts.match(/([A-Za-z][A-Za-z0-9-]*)\s*引擎/)
  if (engine) descriptors.push(`${engine[1]}引擎`)

  if (!descriptors.length) return title
  const head = descriptors.slice(0, 2).join('')
  const tail = descriptors.slice(2)
  return `${title}（${head}${tail.length ? `，${tail.join('，')}` : ''}）`
}

function sourceLineOf(lines) {
  // “主体”通常包含稳定的机构名称；只有没有主体时才退回“来源”。
  return lines.find((line) => line.startsWith('主体：')) ||
    lines.find((line) => SOURCE_LABEL_RE.test(line)) || ''
}

function factLineOf(lines) {
  return lines.find((line) => line.startsWith('事实内容：') || line.startsWith('【事实】')) || ''
}

function summaryOf(lines, factLine) {
  const fact = String(factLine).replace(/^(?:事实内容：|【事实】)\s*/, '').trim()
  if (fact) return fact
  return lines.find((line) => /^(?:官方状态|为什么重要)：/.test(line)) ||
    lines.find((line) => line && !/^(?:来源|主体|发布时间|分类|证据状态|配图|X 核验)：/.test(line)) || ''
}

function preferredUrlOf(lines) {
  const urls = urlsOf(lines.join(' '))
  return urls.find((item) => /store\.steampowered\.com/.test(item)) || urls[0] || ''
}

export function hasTopSection(blocks) {
  return blocks.some((block) => isTopHeading(blockText(block)))
}

function isTopHeading(text) {
  return /(?:重要|核心|重点)新闻/.test(text) &&
    /\bTOP(?:\d+)?\b|头条|精选/i.test(text)
}

export function parseTopItems(blocks, { fallbackUrl = '' } = {}) {
  const start = blocks.findIndex((block) => isTopHeading(blockText(block)))
  if (start === -1) return []
  const startLevel = headingLevel(blocks[start].type) || 1
  const itemLevel = startLevel + 1

  const sections = []
  let current = null
  for (let index = start + 1; index < blocks.length; index += 1) {
    const block = blocks[index]
    const level = headingLevel(block.type)
    if (level && level <= startLevel) break
    if (level === itemLevel) {
      if (current) sections.push(current)
      current = { headline: blockText(block), lines: [] }
    } else if (block.type === 'numbered_list_item' && /^\d+[.、）)]\s*/.test(blockText(block))) {
      if (current) sections.push(current)
      current = { headline: blockText(block), lines: [] }
    } else if (current) {
      current.lines.push(blockText(block))
    }
  }
  if (current) sections.push(current)

  return sections.map(({ headline, lines }) => {
    const sourceLine = sourceLineOf(lines)
    const factLine = factLineOf(lines)
    const date = lines.join(' ').match(DATE_TOKEN_RE)?.[0] || ''
    const directUrl = preferredUrlOf(lines)
    const url = directUrl || fallbackUrl
    const organization = organizationOf(sourceLine)
    return {
      title: enrichedHeadline(headline, sourceLine, factLine),
      summary: summaryOf(lines, factLine),
      meta: [date, organization].filter(Boolean).join(' ｜ '),
      url,
      sourceType: directUrl ? 'direct' : 'report-page',
    }
  }).filter((item) => item.title && item.summary && META_DATE_RE.test(item.meta) && item.url)
}

export function parseStructuredItems(blocks) {
  const start = blocks.findIndex((block) => {
    const text = blockText(block)
    return text.includes('最近动态') && (text.includes('列表') || text.includes('动态'))
  })
  if (start === -1) return []

  const items = []
  const startLevel = headingLevel(blocks[start].type) || 1
  for (let index = start + 1; index < blocks.length; index += 1) {
    const block = blocks[index]
    const level = headingLevel(block.type)
    if (level && level <= startLevel) break
    if (!['bulleted_list_item', 'numbered_list_item'].includes(block.type)) continue

    const text = blockText(block)
    const url = (text.match(/https?:\/\/\S+/)?.[0] || '').replace(/[，。；）)]+$/, '')
    const fields = text.split('｜').map((field) => field.trim())
    if (!META_DATE_RE.test(fields[0] || '') || !url || !fields[2]) continue

    const summary = [fields[4], fields[3] ? `分类：${fields[3]}` : '']
      .filter(Boolean)
      .join(' ｜ ')
    items.push({
      title: fields[2],
      summary: summary || text,
      meta: [fields[0], fields[1]].filter(Boolean).join(' ｜ '),
      url,
    })
  }
  return items
}

export function parseItems(groups, { pageTitle = '' } = {}) {
  const normalizedGroups = groups.slice()
  const firstGroup = normalizedGroups[0] || []
  if (pageTitle && firstGroup[0] === pageTitle) {
    const withoutPageTitle = firstGroup.slice(1)
    if (withoutPageTitle.length) normalizedGroups[0] = withoutPageTitle
    else normalizedGroups.shift()
  }

  return normalizedGroups
    .filter((group) => group.length >= 2)
    .map((group) => ({
      title: group[0],
      summary: group[1] ?? '',
      meta: metaLineOf(group),
      url: (group.find((line) => /^https?:\/\//.test(line)) ?? '').trim(),
    }))
}
