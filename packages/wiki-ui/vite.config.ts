import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/ai/',
  plugins: [react()],
  resolve: {
    alias: {
      '@wikiai/mw-assistant': fileURLToPath(new URL('../mw-extension/resources/ai-assistant/src', import.meta.url)),
    },
  },
  server: {
    fs: {
      allow: ['.', '../mw-extension/resources/ai-assistant/src'],
    },
    proxy: {
      '/api': {
        target: process.env.WIKIAI_GATEWAY_DEV_URL ?? 'http://127.0.0.1:3000',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
