import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  main: {
    build: {
      outDir: 'dist-electron',
      emptyOutDir: true,
      lib: {
        entry: resolve(aqui, 'electron/main.ts'),
        formats: ['es'],
        fileName: () => 'main.js',
      },
      rollupOptions: {
        external: ['electron', 'electron-updater', 'embedded-postgres', 'pg'],
      },
    },
  },
  preload: {
    build: {
      outDir: 'dist-electron',
      emptyOutDir: false,
      rollupOptions: {
        input: {
          preload: resolve(aqui, 'electron/preload.ts'),
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve(aqui, 'src/renderer'),
    build: {
      outDir: resolve(aqui, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: resolve(aqui, 'src/renderer/index.html'),
      },
    },
  },
});
