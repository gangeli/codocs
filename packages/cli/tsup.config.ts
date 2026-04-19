import { defineConfig } from 'tsup';
import { cpSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

function computeBuildVersion(): string {
  const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
  const pkgVersion: string = pkg.version ?? '0.0.0';

  // If the package version looks like a real release (not 0.0.x / 0.x.x), use it.
  const [major, minor] = pkgVersion.split('.').map(Number);
  if (major >= 1 || (major === 0 && minor >= 1)) {
    return pkgVersion;
  }

  // Otherwise, derive a version from git state.
  try {
    const hash = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
    const dirty = execSync('git status --porcelain', { encoding: 'utf-8' }).trim();
    if (!dirty) {
      return hash;
    }
    // Dirty: hash the diff + list of untracked files for a stable fingerprint.
    const diff = execSync('git diff HEAD', { encoding: 'utf-8' });
    const fingerprint = createHash('sha256')
      .update(diff)
      .update(dirty) // includes untracked file names
      .digest('hex')
      .slice(0, 6);
    return `${hash}+${fingerprint}`;
  } catch {
    return pkgVersion;
  }
}

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: true,
  clean: true,
  noExternal: [],
  // Don't bundle dependencies — they're installed via npm
  external: [/^[^./]/],
  define: {
    __BUILD_VERSION__: JSON.stringify(computeBuildVersion()),
  },
  onSuccess: async () => {
    cpSync('src/prompts', 'dist/prompts', { recursive: true });
  },
});
