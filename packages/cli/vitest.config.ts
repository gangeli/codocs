import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __BUILD_VERSION__: JSON.stringify('test'),
  },
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
  },
});
