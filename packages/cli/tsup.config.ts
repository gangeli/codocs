import { defineConfig } from 'tsup';
import { cpSync } from 'node:fs';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: true,
  clean: true,
  noExternal: [],
  // Don't bundle dependencies — they're installed via npm
  external: [/^[^./]/],
  onSuccess: async () => {
    cpSync('src/prompts', 'dist/prompts', { recursive: true });
  },
});
