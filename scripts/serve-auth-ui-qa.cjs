const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

function homepageFixture() {
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
  const forms = index.slice(index.indexOf('<div id="accountLoginForm"'), index.indexOf('<!-- 个人设置主页'));
  const handlers = app.slice(app.indexOf('function openAccountModal(view)'), app.indexOf('// 账号弹窗 — 退出登录'));
  return `<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>VNFest 登录界面 · 本地预览</title>
    <link rel="stylesheet" href="css/styles.css"><link rel="stylesheet" href="css/theme-tokens.css">
    <link rel="stylesheet" href="css/auth-shared.css"><script defer src="js/auth-ui.js"></script>
    <style>body{margin:0;background:var(--vn-bg);font-family:inherit}.preview-controls{padding:24px;display:flex;gap:12px;flex-wrap:wrap}.preview-controls button{padding:12px;border-radius:12px;border:1px solid var(--vn-border);background:var(--vn-surface);color:var(--vn-text)}.preview-caption{padding:0 24px;color:var(--vn-text-muted);font-size:14px}</style>
    </head><body><div class="preview-controls">
    <button id="previewLogin" onclick="openAccountModal('login')">预览登录</button>
    <button onclick="openAccountModal('register')">预览注册</button>
    <button onclick="document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark'">切换主题</button>
    <a href="login.html">独立登录页</a></div>
    <p class="preview-caption">本地认证界面预览。使用首页真实表单和认证处理函数，接口仅返回模拟结果。</p>
    <div id="accountModal" class="calendar-modal" aria-hidden="true"><div class="calendar-modal-card" role="dialog" aria-modal="true" style="max-width:480px">
    <button id="accountModalClose" class="calendar-modal-close" type="button" aria-label="关闭账号弹窗">×</button>
    <div class="calendar-modal-scroll">${forms}<div id="accountSettings" hidden></div><div id="accountChangePasswordForm" hidden></div><div id="accountBindEmailForm" hidden></div></div></div></div>
    <div id="avatarCropModal" hidden></div>
    <script>let currentUser={logged_in:false};function checkAuth(){}function destroyCropper(){}
    function checkOAuthConfig(){document.getElementById('accSocialLogin').style.display='block'}
    ${handlers}
    document.addEventListener('DOMContentLoaded',()=>{document.getElementById('previewLogin').focus();openAccountModal('login')});</script></body></html>`;
}

function createServer() {
  const state = { mode: 'error', delay: 250, calls: {} };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) {
      const action = url.searchParams.get('action');
      state.calls[action] = (state.calls[action] || 0) + 1;
      const json = data => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (action === 'me') return json({ logged_in: false });
      if (url.pathname === '/api/backgrounds.php') return json({ images: [
        { name: '默认壁纸', file: 'Defaultwallpaper.jpg', url: 'image/background/Defaultwallpaper.jpg' },
        { name: '其他壁纸', file: 'other.jpg', url: 'images/other.jpg' }
      ] });
      if (action === 'oauth_config') return json({ success: true, qq_configured: true, discord_configured: true });
      if (['login_local', 'register_local', 'reset_password'].includes(action)) {
        return setTimeout(() => {
          if (state.mode === 'network') { req.socket.destroy(); return; }
          json(state.mode === 'success' ? { success: true, user: { id: 1, username: 'fixture' }, memberships: [] }
            : { success: false, message: '模拟：请检查输入信息后重试。'.repeat(4) });
        }, state.delay);
      }
      if (action === 'send_register_code') return json({ success: true, message: '模拟验证码已发送' });
      return json({ success: true, data: [], wallpapers: [], enabled: true });
    }
    if (url.pathname === '/auth-preview.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(homepageFixture());
    }
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/auth-preview.html' : url.pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime + (['.html','.js','.css'].includes(path.extname(file)) ? '; charset=utf-8' : '') });
    fs.createReadStream(file).pipe(res);
  });
  return { server, state };
}
module.exports = { createServer, homepageFixture };
if (require.main === module) {
  const { server } = createServer();
  server.listen(18743, '127.0.0.1', () => console.log('Auth UI preview: http://127.0.0.1:18743/auth-preview.html'));
}
