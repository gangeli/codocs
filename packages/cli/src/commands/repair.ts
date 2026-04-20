import type { Command } from 'commander';
import {
  buildRepairContext,
  runHealthChecks,
  runRepairUi,
} from '../repair/index.js';
import { withErrorHandler } from '../util.js';
import { renderExit } from '../exit.js';

export function registerRepairCommand(program: Command): void {
  program
    .command('repair')
    .description('Check for and fix configuration and data issues')
    .option('--db-path <path>', 'SQLite database path')
    .option('--no-tui', 'Disable the terminal UI (plain text output)')
    .option('--auto', 'Apply non-destructive fixes automatically')
    .action(
      withErrorHandler(async (opts: { dbPath?: string; tui?: boolean; auto?: boolean }) => {
        const useTui = opts.tui !== false;
        const ctx = await buildRepairContext({ dbPath: opts.dbPath });
        try {
          const issues = await runHealthChecks(ctx);
          const outcome = await runRepairUi(issues, ctx, {
            auto: !!opts.auto,
            useTui,
            headerMessage: 'Health check complete',
          });
          if (!outcome.resolved) {
            process.exitCode = 1;
            const errs = outcome.remaining.filter((i) => i.severity === 'error').length;
            renderExit({
              clearScreen: useTui,
              note: `${errs} unresolved issue${errs === 1 ? '' : 's'} remain.`,
            });
          } else {
            renderExit({
              clearScreen: useTui,
              note: issues.length === 0 ? 'Everything looks healthy.' : 'All issues resolved.',
            });
          }
        } finally {
          ctx.db.close();
        }
      }),
    );
}
