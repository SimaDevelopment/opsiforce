import { defineConfig } from 'vitest/config';

// Pod manifest tests do not need a database or Kubernetes cluster.
export default defineConfig({
  cacheDir: '.vite-cache',
  test: { include: ['test/pod-runtime.test.ts'], environment: 'node' },
});
