import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'galonly-booth-assets',
    rollupOptions: {
      input: {
        admin: 'admin.html',
        portal: 'portal.html',
      },
    },
  },
});
