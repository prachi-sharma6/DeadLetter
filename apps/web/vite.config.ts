import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// In development Vite proxies /api to the local API so the browser sees one origin, matching production where the API
// serves the built files itself.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: process.env.VITE_API_PROXY ?? 'http://localhost:4000' } },
  },
  // 'hidden' maps are generated for error tracking (Phase 6) but not referenced from the shipped bundle.
  build: { sourcemap: 'hidden', target: 'es2022' },
});
