import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During dev the web app proxies realtime + API to @ice/server on :8080.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/sync': { target: 'ws://localhost:8080', ws: true },
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Split the heavy, stable vendor code into its own cacheable chunks.
        // The CodeMirror editor and the Yjs/Hocuspocus realtime stacks are
        // reachable only through the lazy-loaded room route (see App.tsx), so
        // these chunks are fetched on demand — the landing route never pulls
        // them. Keeping them as two chunks also stays under the 500 kB warning.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          // CodeMirror editor UI + its Lezer language/grammar machinery.
          if (/[\\/]node_modules[\\/](@codemirror|codemirror|@lezer)[\\/]/.test(id)) {
            return 'codemirror-vendor';
          }
          // Yjs CRDT, the awareness protocol, the CodeMirror binding, and the
          // Hocuspocus websocket transport — the realtime collaboration layer.
          if (/[\\/]node_modules[\\/](yjs|y-protocols|y-codemirror\.next|lib0|@hocuspocus)[\\/]/.test(id)) {
            return 'yjs-vendor';
          }
          // React runtime — stable and shared by every route.
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return 'react-vendor';
          }
          return undefined;
        },
      },
    },
  },
});
