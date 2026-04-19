/**
 * Build-time version string, injected by tsup via `define`.
 *
 * The value is computed at build time from:
 *  - The package.json version (if it looks like a real release, e.g. ≥1.0.0)
 *  - The short git hash (if the working tree is clean)
 *  - The git hash + a short hash of the dirty diff (if the working tree is dirty)
 */
declare const __BUILD_VERSION__: string;

export const BUILD_VERSION: string = __BUILD_VERSION__;
