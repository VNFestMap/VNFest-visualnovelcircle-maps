const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const projectRoot = path.resolve(__dirname, '..');

if (app?.on) app.on('window-all-closed', (event) => event.preventDefault());

function json(response, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

function startFixtureServer() {
  const state = { meRequests: 0, sendCodeRequests: 0 };
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    if (requestUrl.pathname === '/api/auth.php') {
      if (requestUrl.searchParams.get('action') === 'me') state.meRequests += 1;
      if (requestUrl.searchParams.get('action') === 'send_code') state.sendCodeRequests += 1;
      return json(response, {
        logged_in: true,
        user: {
          id: 1,
          username: 'email-ui-test',
          nickname: '邮箱绑定测试',
          role: 'visitor',
          email: '',
          email_verified: false,
          avatar_url: '',
          profile_bio: '',
          qq_bound: false,
          discord_bound: false,
          membership_application_email_enabled: true,
        },
        memberships: [],
        success: true,
        message: requestUrl.searchParams.get('action') === 'send_code' ? '验证码已发送' : undefined,
      });
    }
    if (requestUrl.pathname.startsWith('/api/')) {
      return json(response, { success: true, data: [], memberships: [], notifications: [], events: [], registrations: [], count: 0 });
    }

    const relativePath = requestUrl.pathname.replace(/^\/+/, '') || 'index.html';
    const filePath = path.resolve(projectRoot, relativePath);
    if (!filePath.startsWith(projectRoot + path.sep) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': contentType(filePath), 'Cache-Control': 'no-store' });
    fs.createReadStream(filePath).pipe(response);
  });
  return { server, state };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForState(state, predicate, label) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (predicate(state)) return;
    await wait(100);
  }
  throw new Error(`${label} timed out`);
}

async function execute(window, expression, label) {
  try {
    return await window.webContents.executeJavaScript(expression);
  } catch (error) {
    throw new Error(`${label}: ${error.message}`);
  }
}

async function waitFor(window, expression, label) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await execute(window, expression, label)) return;
    await wait(100);
  }
  throw new Error(`${label} timed out`);
}

async function main() {
  await app.whenReady();
  const { server, state } = startFixtureServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const window = new BrowserWindow({
    show: false,
    width: 1366,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      partition: `email-binding-test-${Date.now()}`,
    },
  });
  const consoleErrors = [];
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) consoleErrors.push(message);
  });

  try {
    await window.loadURL(`${baseUrl}/user.html?tab=account&email_binding_test=1`);
    await waitFor(window, `Boolean(document.querySelector('input[placeholder="name@example.com"]'))`, 'email binding form');
    await waitFor(window, `document.querySelector('input[placeholder="name@example.com"]')?.value === ''`, 'empty email fixture');
    await wait(150);
    const meRequestsBeforeSend = state.meRequests;

    const enteredEmail = 'entered@example.com';
    await execute(window, `(() => {
      const input = document.querySelector('input[placeholder="name@example.com"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(enteredEmail)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`, 'enter email');
    await waitFor(window, `document.querySelector('input[placeholder="name@example.com"]')?.value === ${JSON.stringify(enteredEmail)}`, 'entered email');

    try {
      await execute(window, `(() => {
        const sendLabels = ['发送验证码', '認証コード送信'];
        const button = [...document.querySelectorAll('button')].find((item) => sendLabels.includes(item.textContent.trim()));
        if (!button) throw new Error('send verification button not found');
        button.click();
      })()`, 'click send verification');
    } catch (error) {
      console.error(`Renderer console: ${consoleErrors.join(' | ')}`);
      throw error;
    }
    await waitForState(state, (current) => current.sendCodeRequests === 1, 'send verification request');
    await wait(300);

    const result = await execute(window, `({
      email: document.querySelector('input[placeholder="name@example.com"]')?.value || '',
    })`, 'read email result');

    assert.equal(state.sendCodeRequests, 1, 'the browser should send exactly one verification request');
    assert.equal(state.meRequests, meRequestsBeforeSend, 'sending a verification code should not refresh user data');
    assert.equal(result.email, enteredEmail, 'sending a verification code must keep the entered email in the form');
    console.log('user email binding browser regression passed');
  } finally {
    window.destroy();
    server.close();
    await app.quit();
  }
}

if (app?.whenReady && BrowserWindow) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
} else {
  console.error('Run this browser test with Electron.');
  process.exitCode = 1;
}
