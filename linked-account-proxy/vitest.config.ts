import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: '.vite-cache',
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    hookTimeout: 20_000,
  },
});
