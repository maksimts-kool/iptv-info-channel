import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The built assets are served by the backend under /admin/static/ (see
// http/admin.js), so production uses that base. In dev the app is served from
// the root and API calls are proxied to the running backend.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' ? '/admin/static/' : '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/admin/api': 'http://localhost:9222',
      '/admin/login': 'http://localhost:9222',
      '/admin/logout': 'http://localhost:9222',
    },
  },
}));
