// Local-only synthetic user data. No requests are forwarded to production.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const artifacts = path.resolve(root, '../_codex-user-cards-20261002');
function createServer() {
  const notifications = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, type: 'system', is_read: i > 2, title: i ? '同好会活动与审核进度通知'.repeat(i === 1 ? 8 : 1) : '📢 全站公告：网站调整维护公告', message: '网站将在维护期间调整部分功能，如有特殊情况请加入反馈群进行反馈。'.repeat(i === 1 ? 16 : 2), created_at: '2026-09-06T10:00:00' }));
  const writes = [];
  const json = (res, data) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/fixture-image.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><defs><linearGradient id="g"><stop stop-color="#ebc1b9"/><stop offset="1" stop-color="#7384b8"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><circle cx="480" cy="90" r="50" fill="#fff" opacity=".5"/><path d="M0 360L190 140L360 300L490 170L640 360" fill="#485c7c" opacity=".6"/></svg>');
    }
    if (url.pathname.startsWith('/api/')) {
      const action = url.searchParams.get('action');
      let body = { success: true, data: [], memberships: [], notifications: [], events: [], registrations: [], count: 0 };
      if (req.method === 'POST') {
        let raw = ''; for await (const chunk of req) raw += chunk;
        let data = {}; try { data = JSON.parse(raw); } catch { data = Object.fromEntries(new URLSearchParams(raw)); }
        writes.push({ action, data });
        if (action === 'mark_read') { const item = notifications.find(n => n.id === Number(data.id)); if (item) item.is_read = true; }
        if (action === 'mark_all_read') notifications.forEach(n => { n.is_read = true; });
      }
      const memberships = [{ id: 1, club_id: 1, country: 'china', role: 'member', status: 'active' }];
      if (url.pathname === '/api/auth.php') body = { success: true, logged_in: true, user: { id: 1, username: 'local-layout-fixture', nickname: '本地样式验收', role: 'visitor', email: 'fixture@example.com', email_verified: true }, memberships };
      if (url.pathname === '/api/membership.php' && action === 'my') body = { success: true, memberships, data: memberships };
      if (url.pathname === '/api/notifications.php') body = { success: true, notifications, count: notifications.filter(n => !n.is_read).length };
      if (url.pathname === '/api/backgrounds.php') body = { success: true, images: Array.from({ length: 7 }, (_, i) => ({ name: i === 5 ? '长壁纸名称用于验证两行换行和截断表现'.repeat(5) : `默认风景壁纸 ${i + 1}`, url: i === 6 ? '/missing-fixture.png' : `/fixture-image.svg?v=${i}`, file: `fixture-${i}.svg` })) };
      return json(res, body);
    }
    let file = path.resolve(root, decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'user.html');
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    if (process.env.USER_CARD_QA_RUNTIME_ROOT) {
      const runtimeRoot = path.resolve(process.env.USER_CARD_QA_RUNTIME_ROOT);
      const published = path.resolve(runtimeRoot, decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'user.html');
      if (published.startsWith(runtimeRoot + path.sep) && fs.existsSync(published) && fs.statSync(published).isFile()) file = published;
    }
    if (url.pathname === '/user.html') {
      let html = fs.readFileSync(file, 'utf8');
      if (url.searchParams.has('baseline')) html = html.replace(/user-v2-assets\/index-[^"\s]+\.js/, 'user-v2-assets/index-5k11_Tbh.js').replace(/user-v2-assets\/index-[^"\s]+\.css/, 'user-v2-assets/index-CsejBgby.css');
      if (url.searchParams.has('bundled')) {
        const bundled = fs.readFileSync(path.join(artifacts, 'qa-bundled/index.html'), 'utf8');
        for (const ext of ['js', 'css']) {
          const asset = bundled.match(new RegExp(`user-v2-assets/[^"\\s]+\\.${ext}`))[0];
          html = html.replace(new RegExp(`user-v2-assets/index-[^"\\s]+\\.${ext}`), 'qa-bundled/' + asset);
        }
      }
      const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
      html = html.replace('<head>', `<head><script>localStorage.setItem('themePreference', '${theme}')</script>`);
      if (url.searchParams.has('duplicate')) html = html.replace('</head>', `<style>${fs.readFileSync(path.join(root, 'css/button-shapes.css'), 'utf8')}</style></head>`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html);
    }
    if (/index-(5k11_Tbh\.js|CsejBgby\.css)$/.test(file)) file = path.join(artifacts, 'delivered-baseline/user-v2-assets', path.basename(file));
    if (url.pathname.startsWith('/qa-bundled/user-v2-assets/')) file = path.join(artifacts, 'qa-bundled/user-v2-assets', path.basename(file));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
  });
  server.fixtureWrites = writes;
  return server;
}
module.exports = { createServer, artifacts };
if (require.main === module) createServer().listen(18754, '127.0.0.1', () => console.log('User card preview: http://127.0.0.1:18754/user.html?tab=preferences'));
