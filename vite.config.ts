import { defineConfig } from 'vite';
import dns from 'node:dns';

dns.setDefaultResultOrder('ipv4first');

export default defineConfig({
  server: {
    port: 3000,
    open: true,
    proxy: {
      '/api/osudirect': {
        target: 'https://osu.direct',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/osudirect/, ''),
        headers: {
          'User-Agent': 'OSRA/1.0 (osu-replay-analyzer)'
        }
      },
      '/api/hinamizawa': {
        target: 'https://mirror.hinamizawa.ai',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/hinamizawa/, ''),
        headers: {
          'User-Agent': 'OSRA/1.0 (osu-replay-analyzer)'
        }
      },
      '/api/mirror': {
        target: 'https://catboy.best',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/mirror/, ''),
        headers: {
          'User-Agent': 'OSRA/1.0 (osu-replay-analyzer)'
        }
      }
    }
  },
  build: {
    rollupOptions: {
      output: {
        sanitizeFileName(name) {
          return name.replace(/@/g, '_');
        },
        assetFileNames(assetInfo) {
          const rawName = assetInfo.name || 'asset';
          const cleanName = rawName.replace(/@/g, '-');
          const ext = cleanName.slice(cleanName.lastIndexOf('.'));
          const base = cleanName.slice(0, cleanName.lastIndexOf('.'));
          return `assets/${base}-[hash]${ext}`;
        }
      }
    }
  },
  worker: {
    format: 'es'
  }
});
