import { availableParallelism } from 'node:os';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const maxWorkers = Math.max(2, Math.min(8, availableParallelism() - 2));

export default defineConfig({
  cacheDir: '.vite-cache',
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['test/setup/global-setup.ts'],
    setupFiles: ['test/setup/env.ts'],
    pool: 'forks',
    maxWorkers,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2023',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
});
