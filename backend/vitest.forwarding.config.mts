import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: '.vite-cache',
  test: { include: ['test/project-auth-forwarding.test.ts'], environment: 'node' },
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
