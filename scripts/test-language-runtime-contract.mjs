import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('js/language-runtime.js', 'utf8');

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    dump: () => Object.fromEntries(values),
  };
}

async function createRuntime({ href = 'https://example.test/index.html', languages = ['zh-CN'], local = {}, me = { logged_in: false, user: null }, updateOk = true } = {}) {
  const localStorage = storage(local);
  const sessionStorage = storage();
  const events = new Map();
  const requests = [];
  const documentElement = { setAttribute() {}, lang: '' };
  const document = {
    documentElement,
    body: null,
    currentScript: { src: 'https://example.test/js/language-runtime.js' },
    scripts: [],
    querySelectorAll: () => [],
  };
  const window = {
    location: new URL(href), document, localStorage, sessionStorage,
    addEventListener(type, callback) { events.set(type, callback); },
    dispatchEvent() {},
  };
  const context = {
    window, document, localStorage, sessionStorage,
    navigator: { languages, language: languages[0] },
    URL, URLSearchParams, Set, Map, Array, Number, Object, String, Boolean, Promise,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    console,
    fetch: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).includes('update_language_preference')) {
        return { ok: updateOk, status: updateOk ? 200 : 500, json: async () => updateOk ? { success: true } : { success: false, message: '语言设置保存失败' } };
      }
      return { ok: true, status: 200, json: async () => me };
    },
    setTimeout, clearTimeout,
  };
  Object.assign(window, context);
  vm.runInNewContext(source, context, { filename: 'language-runtime.js' });
  await window.VNFLanguage.ready;
  return { runtime: window.VNFLanguage, localStorage, sessionStorage, requests, documentElement };
}

{
  const { runtime, documentElement } = await createRuntime({ languages: ['zh-CN'] });
  assert.equal(runtime.getLanguage(), 'zh');
  assert.equal(documentElement.lang, 'zh-CN');
}

{
  const { runtime, documentElement } = await createRuntime({ languages: ['zh-CN', 'ja-JP', 'en-US'] });
  assert.equal(runtime.getLanguage(), 'zh', 'secondary Japanese browser preferences must not override the primary Chinese preference');
  assert.equal(documentElement.lang, 'zh-CN');
}

{
  const { runtime, documentElement } = await createRuntime({ languages: ['ja-JP', 'en-US'] });
  assert.equal(runtime.getLanguage(), 'ja');
  assert.equal(documentElement.lang, 'ja');
}

for (const value of ['zh', 'zh-CN', 'ja', 'ja-JP']) {
  const expected = value.startsWith('ja') ? 'ja' : 'zh';
  const { runtime, localStorage, sessionStorage } = await createRuntime({ href: `https://example.test/?lang=${value}`, languages: ['ja-JP'] });
  assert.equal(runtime.getLanguage(), expected, `${value} URL override should normalize`);
  assert.equal(sessionStorage.dump().vnfestLanguageOverride, expected);
  assert.equal(localStorage.dump().language, undefined, 'URL override must not persist to localStorage');
}

{
  const { runtime, localStorage } = await createRuntime({
    languages: ['zh-CN'],
    local: { language: 'zh', vnfestLanguageAccountId: '7' },
    me: { logged_in: true, user: { id: 7, language_preference: 'ja' } },
  });
  assert.equal(runtime.getLanguage(), 'ja', 'account preference must override local cache');
  assert.equal(localStorage.dump().language, 'ja', 'account preference must refresh the local mirror');
}

{
  const { runtime, requests, localStorage } = await createRuntime({
    local: { language: 'ja' },
    me: { logged_in: true, user: { id: 8, language_preference: null } },
  });
  assert.equal(runtime.getLanguage(), 'ja');
  assert.equal(requests.filter((item) => item.url.includes('update_language_preference')).length, 1, 'unowned legacy cache should migrate once');
  assert.equal(localStorage.dump().vnfestLanguageAccountId, '8');
}

{
  const { runtime, requests } = await createRuntime({
    languages: ['zh-CN'],
    local: { language: 'ja', vnfestLanguageAccountId: '8' },
    me: { logged_in: true, user: { id: 9, language_preference: null } },
  });
  assert.equal(runtime.getLanguage(), 'zh', 'another account must not inherit the previous account cache');
  assert.equal(requests.filter((item) => item.url.includes('update_language_preference')).length, 0);
}

{
  const { runtime } = await createRuntime({
    me: { logged_in: true, user: { id: 10, language_preference: 'zh' } },
    updateOk: false,
  });
  const result = await runtime.setPreference('ja');
  assert.equal(result.success, false);
  assert.equal(runtime.getLanguage(), 'zh', 'failed save must restore the previous language');
}

console.log('language runtime contract tests passed');
