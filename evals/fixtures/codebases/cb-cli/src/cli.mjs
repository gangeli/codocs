#!/usr/bin/env node
// Tiny zero-dep argument parser — keeps the fixture ~80 LOC.
import { greet } from './commands/greet.mjs';
import { deploy } from './commands/deploy.mjs';
import { serve } from './commands/serve.mjs';

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (rest[i + 1] != null && !rest[i + 1].startsWith('--')) {
        flags[a.slice(2)] = rest[i + 1];
        i += 1;
      } else {
        flags[a.slice(2)] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { cmd, flags, positional };
}

export function run(argv) {
  const { cmd, flags, positional } = parseArgs(argv);
  switch (cmd) {
    case 'greet':
      return greet(positional[0] ?? 'world');
    case 'deploy':
      return deploy(flags);
    case 'serve':
      return serve(flags);
    case undefined:
    case '--help':
    case '-h':
      console.log('Usage: cb-cli <greet|deploy|serve> [...args]');
      return 0;
    default:
      console.error(`unknown command: ${cmd}`);
      return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(run(process.argv.slice(2)));
}
