import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5175, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'club-manager-assets',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/antd') || id.includes('node_modules/@ant-design')) return 'antd';
          if (id.includes('node_modules/qrcode')) return 'qrcode';
          return undefined;
        },
      },
    },
  },
});
