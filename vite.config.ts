import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, strictPort: true },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: { game: 'index.html', sdk: 'sdk-demo.html' },
      output: { manualChunks: { three: ['three'] } },
    },
  },
});
