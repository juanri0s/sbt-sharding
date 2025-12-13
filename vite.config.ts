import { defineConfig } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  build: {
    rollupOptions: {
      input: resolve(__dirname, 'src/index.ts'),
      output: {
        dir: resolve(__dirname, 'dist'),
        entryFileNames: 'index.js',
        format: 'es',
        inlineDynamicImports: true,
      },
      external: [],
    },
    outDir: 'dist',
    sourcemap: true,
    minify: false,
    target: 'node24',
    ssr: true,
  },
  ssr: {
    noExternal: true,
  },
});
