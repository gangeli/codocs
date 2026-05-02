// Root workspace config so `vitest` invoked from the repo root picks up
// each package's local config (test globals, build-time `define`, etc.)
// Without this, `__BUILD_VERSION__` and other per-package compile-time
// values are undefined when tests are run from the root.
export default [
  'packages/core/vitest.config.ts',
  'packages/cli/vitest.config.ts',
  'packages/db/vitest.config.ts',
];
