import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In development the API runs at :8787 (apps/api dev-server). Proxying it
    // under the same origin means the app needs no environment config and no
    // CORS negotiation -- it just calls /v1/... in both dev and production.
    proxy: {
      '/v1': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
});
