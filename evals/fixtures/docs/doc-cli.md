# CLI UX Spec

## Overview

`cb-cli` is the command-line front-end for Project Alpha's developer workflows. It ships as a Node ESM binary with no third-party dependencies so it can be vendored anywhere.

## Commands

| Command | Behavior |
|---|---|
| `cb-cli greet <name>` | Prints `Hello, <name>!` to stdout. |
| `cb-cli deploy --env <env>` | Deploys to `<env>`. Refuses to run (exit 2) if `--env` is missing. |
| `cb-cli serve [--port <port>]` | Starts the dev server. `--port` defaults to 3000. |

## Error Handling

Unknown commands print a one-line error and exit 2. Missing required flags print a one-line error naming the flag and exit 2. No command should ever crash with an unhandled exception — wrap risky calls at the command entry.

## Telemetry

Telemetry is not yet implemented. The plan is an opt-in `CB_TELEMETRY=1` environment variable that emits a single JSON line per invocation to `stderr`, but no code has landed.

## Future Work

- Add a `doctor` subcommand that checks the host environment (Node version, disk space, network).
- Add shell completion scripts for bash and zsh.
- Ship prebuilt binaries via `bun build --compile`.
