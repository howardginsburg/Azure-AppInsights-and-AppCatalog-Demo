import { defineConfig } from 'vite';

// The Express server and every package it imports, bundled into dist-server/server/index.js.
// The deployed package then needs no node_modules: a handful of files instead of thousands.
export default defineConfig({
  build: {
    ssr: 'server/index.ts',
    outDir: 'dist-server',
    emptyOutDir: true,
    target: 'node24',
    sourcemap: true,
    rolldownOptions: {
      output: { entryFileNames: 'server/index.js' },
    },
  },
  ssr: {
    target: 'node',
    noExternal: true,
  },
});
