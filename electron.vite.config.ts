import { resolve } from 'path';
import { readFileSync } from 'fs';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));

/**
 * explainer electron-vite config — adapted from quiet-que (no extra renderer
 * entries, no per-platform build flags).
 *
 * Dev: sourcemaps, no minify. Prod: minify with keepNames (runtime name
 * checks) and no sourcemaps. The SOURCE .ts/.tsx is never packaged
 * (electron-builder `files` excludes it; the runtime is out/**).
 *
 * The `renderer` block below has to stay a faithful port of
 * `frontend/vite.config.ts`: it builds the same sources against a different
 * host. Anything that config needs to produce a working app — the Tailwind
 * pass, the `/api` proxy — the desktop path needs too, and what it drops
 * (the LAN certificate, the rootCA handler) only exists for the phone.
 */
export default defineConfig(({ mode }) => {
  const isProd = mode === 'production';

  return {
    main: {
      resolve: {
        alias: {
          '@shared': resolve(__dirname, 'src/shared')
        }
      },
      build: {
        sourcemap: !isProd,
        minify: isProd ? 'esbuild' : false,
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'electron/main/index.ts')
          }
        }
      },
      esbuild: { keepNames: true },
      plugins: [externalizeDepsPlugin({ exclude: [] })]
    },
    preload: {
      resolve: {
        alias: {
          '@shared': resolve(__dirname, 'src/shared')
        }
      },
      build: {
        sourcemap: !isProd,
        minify: isProd ? 'esbuild' : false,
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'electron/preload/index.ts')
          }
        }
      },
      esbuild: { keepNames: true },
      plugins: [externalizeDepsPlugin()]
    },
    renderer: {
      root: resolve(__dirname, 'frontend'),
      build: {
        sourcemap: !isProd,
        // electron-vite defaults the renderer to `minify: false` — unlike plain
        // `vite build`, which is what frontend/vite.config.ts gets. Left alone,
        // the packaged desktop app shipped the renderer as raw source while the
        // browser build of the same files was minified, and the header comment
        // above said otherwise. Same value as main/preload so the three agree.
        minify: isProd ? 'esbuild' : false,
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'frontend/index.html')
          }
        }
      },
      // Vite feeds this block to the minifier as well as to the transform, so
      // `keepNames` is what stops esbuild renaming the classes and functions
      // whose `.name` is read at runtime — `classifyMicrophoneError` in
      // frontend/src/hooks/useRealtimeSession.ts matches on `err.name`.
      esbuild: { keepNames: true },
      resolve: {
        alias: {
          '@': resolve(__dirname, 'frontend/src'),
          '@shared': resolve(__dirname, 'src/shared')
        },
        // Two React trees are installed side by side: this package.json pins
        // react 18 for the electron tooling, frontend/package.json pins 19 for
        // the app. Both are real directories on disk, so a bare `react`
        // specifier reached from anywhere outside frontend/ — an alias, a
        // hoisted dependency, a shared module — resolves to the 18 copy and the
        // renderer ends up with two Reacts, which is the "invalid hook call"
        // crash. `dedupe` pins both names to one resolution taken from the
        // renderer root above, i.e. frontend/node_modules, the tree the app was
        // written against.
        //
        // @vitejs/plugin-react currently injects the same two names from its
        // own `config` hook, so today this line changes nothing. It is written
        // out anyway: the guarantee belongs to this config, not to an
        // undocumented internal of a plugin that may drop it in any release.
        dedupe: ['react', 'react-dom']
      },
      define: {
        // RELEASE_VERSION (exported by a release build) wins over the
        // package.json, as in quiet-que.
        __APP_VERSION__: JSON.stringify(process.env.RELEASE_VERSION || pkg.version)
      },
      server: {
        proxy: {
          // The main process spawns the backend on 127.0.0.1:3001, and the
          // renderer calls `/api/...` relative to whatever origin it was served
          // from. In dev that origin is this Vite server, so without the proxy
          // every request lands on the dev server's own 404 handler.
          '/api': {
            target: 'http://localhost:3001',
            changeOrigin: true,
            // Without this the backend cannot tell its owner from a guest.
            // The proxy is resolved by the Node process on the host, so every
            // request it forwards reaches 127.0.0.1:3001 *from* 127.0.0.1 and
            // the real client address is gone. `xfwd` appends
            // `X-Forwarded-For` carrying the address that opened the connection
            // to Vite — the only thing left that still separates them, and it
            // appends rather than replaces, so a client sending its own value
            // cannot overwrite the truth.
            // `backend/src/middleware/access-key.ts` is the consumer:
            // `originIsLoopback` demands every hop in that chain be loopback
            // before it waives the access key. The desktop window is always on
            // the host, so this header is what keeps the app from asking its
            // own owner for a key it was never shown.
            xfwd: true
          }
        }
      },
      // tailwindcss() first, then react() — the order frontend/vite.config.ts
      // uses. Tailwind v4 has no PostCSS step to fall back on: with the plugin
      // absent, `@import "tailwindcss"` in frontend/src/index.css is inlined
      // verbatim and the bundle ships `@theme` blocks plus a bare
      // `@tailwind utilities;` that no browser understands, so the window
      // renders the DOM with no styles at all.
      plugins: [tailwindcss(), react()]
    }
  };
});
