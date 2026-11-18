import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

/**
 * Dev-only: serve the Godot port's FMOD runtime and banks to dev/sfx.html for
 * side-by-side listening. The banks are original game audio owned by its
 * rights holders, so they are read from the local arkevo-games checkout and
 * never copied into this repository or any build output.
 */
const GODOT_AUDIO_DIR = resolve(
  process.env.GODOT_AUDIO_DIR ??
    fileURLToPath(new URL('../arkevo-games/games/boomerangfu/web/audio', import.meta.url)),
);
const GODOT_AUDIO_FILES: Record<string, string> = {
  'fmodstudio.js': 'text/javascript',
  'fmodstudio.wasm': 'application/wasm',
  'Master Bank.bank': 'application/octet-stream',
  'Master Bank.strings.bank': 'application/octet-stream',
};
function godotAudio(): Plugin {
  return {
    name: 'godot-audio-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__godot-audio', (req, res, next) => {
        const name = decodeURIComponent((req.url ?? '/').split('?')[0].slice(1));
        if (name === 'status') {
          const missing = Object.keys(GODOT_AUDIO_FILES).filter(
            (file) => !existsSync(resolve(GODOT_AUDIO_DIR, file)),
          );
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({ available: missing.length === 0, dir: GODOT_AUDIO_DIR, missing }),
          );
          return;
        }
        const type = GODOT_AUDIO_FILES[name];
        if (!type) return next();
        const file = resolve(GODOT_AUDIO_DIR, name);
        if (!existsSync(file)) {
          res.statusCode = 404;
          res.end(`missing ${name}`);
          return;
        }
        res.setHeader('content-type', type);
        res.setHeader('content-length', String(statSync(file).size));
        res.setHeader('cache-control', 'no-store');
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [godotAudio()],
  server: { port: 5173, strictPort: true },
  build: {
    target: 'es2022',
    rollupOptions: {
      // dev/*.html (sound and effects galleries) are served by the dev server only.
      input: { game: 'index.html', sdk: 'sdk-demo.html', maps: 'maps.html' },
      output: { manualChunks: { three: ['three'] } },
    },
  },
});
