import { defineConfig } from 'vitest/config';

// Tests run from the project root, not the Vite src/ root, so the top-level
// tests/ folder resolves. Vitest prefers this file over vite.config.js.
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.test.js'],
    // Early phases have no tests yet; an empty suite must not fail the Stop
    // hook test gate. Real suites land in later phases.
    passWithNoTests: true,
  },
});
