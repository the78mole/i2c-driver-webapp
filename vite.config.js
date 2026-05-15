import { defineConfig } from 'vite';

export default defineConfig({
  // BASE_PATH is set by CI for GitHub Pages (/i2c-driver-webapp/); defaults to / for local dev.
  base: process.env.BASE_PATH || '/',
  build: {
    target:  'es2022',
    outDir:  'dist',
    sourcemap: true,
  },
});
