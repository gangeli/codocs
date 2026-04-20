---
description: Bump version, generate release notes, prepare CI-driven GitHub release
argument-hint: [major|minor|patch]
allowed-tools: Read, Edit, Write, Bash(git:*), Bash(node:*), Bash(mkdir:*), Bash(test:*)
---

<!--
Usage:
  /release           → patch bump (0.0.3 → 0.0.4)
  /release patch     → patch bump
  /release minor     → minor bump (0.0.3 → 0.1.0)
  /release major     → major bump (0.0.3 → 1.0.0). Only use if user explicitly asks.
-->

Prepare a new release. Release publication is handled by `.github/workflows/ci.yml` on push to `main`; this command only prepares the artifacts CI needs (version bump + release notes).

## Inputs

Bump type: `$1` (default: `patch`). Only bump major when the user explicitly asks.

## Workflow

1. **Locate version source.** The CI workflow reads the version from `packages/cli/package.json`. Read the current version from that file. Also read `packages/core/package.json` and `packages/db/package.json` — these three stay in lockstep.

2. **Compute the next version** from the current version and bump type:
   - `patch`: increment the third component (0.0.3 → 0.0.4)
   - `minor`: increment the second component, reset patch (0.0.3 → 0.1.0)
   - `major`: increment the first component, reset minor+patch (0.0.3 → 1.0.0) — only when the user explicitly asked for a major bump

3. **Collect commits since the previous version.** Use `git log --oneline v<previous>..HEAD` to list commits. If the tag does not exist (e.g. first release), fall back to `git log --oneline` from the repository root. Do not include merge commits when a linear history is preferred (`--no-merges`). Run `git log v<previous>..HEAD --pretty=format:'%h %s%n%b' --no-merges` when commit bodies are needed for context.

4. **Draft release notes** as a markdown file at `release_notes/<new_version>.md`. Structure:

   ```markdown
   # v<new_version>

   <one-paragraph summary of the release theme — infer from commit clusters>

   ## Highlights

   - <Notable user-facing change, referencing commit hash e.g. `abc1234`>
   - <...>

   ## Fixes

   - <Bug fix with short explanation and commit hash>

   ## Internal

   - <Build/CI/refactor changes that don't affect users>

   **Full changelog:** https://github.com/gangeli/codocs/compare/v<previous>...v<new_version>
   ```

   Guidelines:
   - Group commits into sections (Highlights/Features, Fixes, Internal). Omit empty sections.
   - Rewrite commit subjects into user-facing language — do not just paste the subject line verbatim.
   - Link each bullet to its commit hash (short form) so readers can dig deeper.
   - Keep the summary paragraph honest about scope; if the release is tiny (one commit), say so.
   - If a commit's impact is only "internal plumbing" (CI tweaks, lockfile bumps), collapse it into "Internal" or omit.

5. **Bump `version` in all three package.json files** (`packages/cli`, `packages/core`, `packages/db`) to the new version. Use the Edit tool — do not run `npm version`, which would create tags locally. CI creates the tag.

   Also update the `peerDependencies` and `devDependencies` references to `@codocs/db` in `packages/core/package.json` so the version matches (`"@codocs/db": "^<new_version>"` in both places).

6. **Show the user** a preview: the new version, the release notes, and the list of modified files. Ask them to review before committing. Do **not** commit or push automatically — the user controls when CI runs.

7. **Remind the user** of the path to publish:
   - Commit: `git commit -am "Release v<new_version>"`
   - Push to `main`: CI's `release` job detects the version change, tags `v<new_version>`, creates the GitHub Release reading notes from `release_notes/<new_version>.md`, attaches the compiled binaries, and publishes to npm.
   - If `release_notes/<new_version>.md` is missing at push time, CI falls back to auto-generated notes.

## Notes for future Claude

- Source of truth for the version is `packages/cli/package.json` (see `.github/workflows/ci.yml` step "Check for version bump"). Do not invent a root-level version.
- The three package versions (`cli`, `core`, `db`) must match — npm publishes them together and `@codocs/core` depends on `@codocs/db` by version.
- `packages/homepage/package.json` is private and tracks its own version; leave it alone unless the user specifically asks.
- The CI `release` job only fires on push to `main`. Tags are created by `softprops/action-gh-release@v2`, not by this command.
- Release notes live at `release_notes/<bare-version>.md` (no `v` prefix) — CI prepends the `v` when tagging.
