import { defineConfig } from 'vite';

// Vite serves and builds from src/, so src/index.html is the app entry.
// Build output is written back to dist/ at the project root.
// Test config lives in vitest.config.js so the root-level tests/ folder
// resolves against the project root rather than this src/ root.
export default defineConfig({
  root: 'src',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
