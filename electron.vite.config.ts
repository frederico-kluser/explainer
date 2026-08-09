import { resolve } from 'path';
import { readFileSync } from 'fs';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));

/**
 * explainer electron-vite config — adapted from quiet-que (no extra renderer
 * entries, no per-platform build flags).
 *
 * Dev: sourcemaps, no minify. Prod: minify with keepNames (runtime name
 * checks) and no sourcemaps. The SOURCE .ts/.tsx is never packaged
 * (electron-builder `files` excludes it; the runtime is out/**).
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
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'frontend/index.html')
          }
        }
      },
      resolve: {
        alias: {
          '@': resolve(__dirname, 'frontend/src'),
          '@shared': resolve(__dirname, 'src/shared')
        }
      },
      define: {
        // RELEASE_VERSION (exported by a release build) wins over the
        // package.json, as in quiet-que.
        __APP_VERSION__: JSON.stringify(process.env.RELEASE_VERSION || pkg.version)
      },
      plugins: [react()]
    }
  };
});
