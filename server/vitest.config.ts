import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 40_000,
    hookTimeout: 40_000,
    // PGlite instances are WASM-heavy; keep suites sequential and isolated.
    fileParallelism: false,
    isolate: true,
    reporters: ['default'],
  },
});
