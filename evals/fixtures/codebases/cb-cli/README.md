# cb-cli

Tiny CLI used as an eval fixture. Subcommands:

- `greet <name>` — prints `Hello, <name>!`
- `deploy --env <env>` — deploys to `<env>`. Refuses to run without `--env`.
- `serve [--port <port>]` — starts the dev server. `--port` defaults to 3000.

Run: `node src/cli.mjs greet alice`.
