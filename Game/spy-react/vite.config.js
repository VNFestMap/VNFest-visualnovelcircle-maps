import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/* 站点共享运行时：构建期注入，不写进源码 index.html。
   一是避免 Vite 把 ../../js/ 当仓库外资源去解析，二是保证
   部署产物 Game/spy/index.html 自带这些标签 —— 契约测试
   scripts/test-page-i18n-contract.mjs 读的正是产物。
   Game/spy 深度为 2，../../js/ 才等于站点根 /js/；
   page-background.js 用 new URL('../', script.src) 反推站点根去请
   api/backgrounds.php，少一层就会打到 /Game/api/ 404。 */
const SITE_RUNTIME = [
  { file: 'language-runtime.js', version: '20260813-language', injectTo: 'head-prepend' },
  { file: 'language-catalog.js', version: '20260813-language', injectTo: 'head-prepend' },
  { file: 'language-static-ja.js', version: '20260813-account-language', injectTo: 'head-prepend' },
  { file: 'page-i18n.js', version: '20260813-language', injectTo: 'head-prepend', defer: true },
  { file: 'theme-runtime.js', version: '20260702-theme', injectTo: 'head-prepend' },
  /* head 里也安全：脚本内部用 document.readyState 守过 DOMContentLoaded 才碰 body。 */
  { file: 'page-background.js', version: '20260812-centralized-preferences', injectTo: 'head-prepend' },
];

/* sparkdesign 整包样式自带 @font-face Seti → /qoder-seti.woff，
   该字体只在 Qoder Canvas 宿主里存在，站点上必然 404。 */
const SETI_FONT_FACE = /@font-face\s*\{[^{}]*font-family\s*:\s*["']?Seti\b[^{}]*\}\s*/g;

function vnfestSiteIntegration() {
  return {
    name: 'vnfest-site-integration',
    apply: 'build',
    transformIndexHtml() {
      return {
        tags: SITE_RUNTIME.map(({ file, version, injectTo, defer }) => ({
          tag: 'script',
          attrs: {
            src: `../../js/${file}?v=${version}`,
            ...(defer ? { defer: '' } : {}),
          },
          injectTo,
        })),
      };
    },
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'asset' || !chunk.fileName.endsWith('.css')) continue;
        if (typeof chunk.source !== 'string') continue;
        chunk.source = chunk.source.replace(SETI_FONT_FACE, '');
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), vnfestSiteIntegration()],
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    // 直接产出到站点服务目录 Game/spy/，源码留在 Game/spy-react/，
    // 避免像 galgame_club_sim 那样构建产物覆盖 Vite 入口而无法原地重建。
    outDir: fileURLToPath(new URL('../spy', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
  },
});
