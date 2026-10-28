import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// React frontend. Built to dist/public so the Express server can serve it as static.
// During dev, /api is proxied to the local Express server on :8080.
export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    outDir: 'dist/public',
    emptyOutDir: true,
    // Cytoscape and React together exceed Vite's 500 kB default.
    chunkSizeWarningLimit: 1000,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
});
