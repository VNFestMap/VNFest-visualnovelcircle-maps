/* ===========================================================================
 * 每日日报 · 浏览器行为验证（可选，需 jsdom + 本地静态服务器）
 *
 * 前置：
 *   1) 项目根起静态服务器：  php -S 127.0.0.1:8123
 *   2) 安装验证依赖（可选）：npm i -D jsdom
 * 运行：
 *   node scripts/test-daily-browser.mjs          # 默认 http://127.0.0.1:8123
 *   DAILY_TEST_BASE=http://127.0.0.1:8000 node scripts/test-daily-browser.mjs
 * 未安装 jsdom 时自动跳过（退出码 0），不影响 npm run check。
 *
 * 断言范围：真实数据渲染条数、标题不可点/来源可点、meta 解析、页面精简、
 * ?date= 跳转、未知日期回退、往期列表、首页入口。
 * =========================================================================== */
const BASE = process.env.DAILY_TEST_BASE || 'http://127.0.0.1:8123'

let JSDOM
try {
  ;({ JSDOM } = await import('jsdom'))
} catch {
  console.log('SKIP  未安装 jsdom（npm i -D jsdom 后重跑可启用浏览器级验证）')
  process.exit(0)
}

const DAILY = BASE + '/wiki/daily'
let jsSrc
try {
  jsSrc = await (await fetch(DAILY + '/daily.js')).text()
} catch (e) {
  console.log('SKIP  本地服务器不可达（' + BASE + '）。请先 php -S 127.0.0.1:8123')
  process.exit(0)
}

let failed = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
  if (!cond) failed++
}

async function render(url) {
  const html = await (await fetch(url)).text()
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true })
  const w = dom.window
  w.fetch = (input, init) =>
    fetch(new URL(typeof input === 'string' ? input : input.url, w.location.href).href, init)
  w.eval(jsSrc)
  await new Promise((r) => setTimeout(r, 400))
  return w.document
}

// 数据规模（供断言用，避免写死 9）
const payload = await (await fetch(DAILY + '/data/reports.json')).json()
const latest = payload.reports[0]
const latestDate = latest.date
const latestDotted = latestDate.replaceAll('-', '.')
const latestCount = latest.items.length

{
  const d = await render(DAILY + '/index.html')
  check(`读者页渲染 ${latestCount} 条`, d.querySelectorAll('#digestList .vn-daily-item').length === latestCount)
  check(`读者页日期 ${latestDotted}`, d.getElementById('digestDate')?.textContent === latestDotted)
  check('标题为纯文本（无 <a>）', !d.querySelector('#digestList .vn-daily-item h3 a'))
  check('每条含来源域名链接', !!d.querySelector('#digestList .vn-daily-item .vn-daily-src'))
  check('导航含「查看往期」', /查看往期/.test(d.getElementById('digestNav')?.textContent || ''))
  check('最新期显示「最新一期」', /最新一期/.test(d.getElementById('digestNav')?.textContent || ''))
  check('日报两栏百科布局存在', !!d.querySelector('main.wiki-index-page.wiki-encyclopedia-layout.vn-daily-layout'))
  check('本期搜索模块已移除', !d.getElementById('digestSearch') && !d.querySelector('[aria-label="本期检索"]'))
  check('读者页右侧说明板块已移除', !d.querySelector('.wiki-index-aside') && !/数据来源|阅读说明/.test(d.body.textContent))
}
{
  const d = await render(DAILY + `/index.html?date=${latestDate}`)
  check('?date= 定位到指定日期', d.getElementById('digestDate')?.textContent === latestDotted)
}
{
  const d = await render(DAILY + '/index.html?date=2000-01-01')
  check('未知日期回退引导', /未找到/.test(d.querySelector('#digestList')?.textContent || ''))
}
{
  const d = await render(DAILY + '/archive.html')
  const cards = d.querySelectorAll('#archiveList .vn-archive-card')
  check('往期页列全部期数', cards.length === payload.reports.length, `count=${cards.length}`)
  check('往期卡片链接到 ?date=', cards[0]?.getAttribute('href') === `./index.html?date=${latestDate}`, cards[0]?.getAttribute('href'))
  check('往期页右侧说明板块已移除', !d.querySelector('.wiki-index-aside') && !/怎么用|数据维护/.test(d.body.textContent))
}
{
  const html = await (await fetch(BASE + '/wiki/index.html')).text()
  const dom = new JSDOM(html)
  const d = dom.window.document
  check('首页 #daily-report 入口', !!d.getElementById('daily-report'))
  check('首页→今日日报链接', !!d.querySelector('#daily-report a[href="./daily/index.html"]'))
  check('首页→往期查询链接', !!d.querySelector('#daily-report a[href="./daily/archive.html"]'))
}

console.log(failed ? `\n${failed} FAILURES` : '\nALL PASS')
process.exit(failed ? 1 : 0)
