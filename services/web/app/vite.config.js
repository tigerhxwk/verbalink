import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: proxy API + audio to the backend so the SPA runs at :5173 against a live backend.
// Build: emits static files into dist/, which the web (nginx) image will serve.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',   // localhost only
    // Dev backend = the self-contained mock on :8090 (admin/admin + sample data).
    proxy: {
      '/api': { target: process.env.BACKEND || 'http://localhost:8090', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
