/**
 * Shared exit screen. Any clean termination of the CLI — session shutdown,
 * welcome quit, repair quit, resume-not-found, etc. — routes through
 * renderExit() so the farewell line stays consistent across screens.
 *
 * Only the farewell is always shown; everything else (resume hint, note,
 * error message) is optional, so the same helper serves session exits
 * (heavy payload) and homepage exits (farewell only).
 */

const FAREWELLS = [
  'Exiting gracefully, unlike most software.',
  'May your merges be conflict-free.',
  'See you on the other side of the diff.',
  'Thanks for all the comments.',
  'ctrl-c you later.',
  'Process terminated. Feelings intact.',
  "It's not a bug, it's a farewell.",
  'Segfault avoided. Clean exit.',
  'Your uptime was impressive.',
  'All threads joined. All promises resolved.',
  'No memory leaks here. Probably.',
  'Committed to saying goodbye.',
  'LGTM. Ship it. Go home.',
  'This session has been garbage collected.',
];

function pickFarewell(): string {
  return FAREWELLS[Math.floor(Math.random() * FAREWELLS.length)]!;
}

export interface ExitScreenOptions {
  /** Resume hint — shown only when a resumable session exists. */
  resume?: { sessionId: string; docArgs: string };
  /** Free-form note above the farewell (e.g. "Issues resolved. Re-run to continue."). */
  note?: string;
  /** Error message; suppresses the witty farewell in favor of a plain red line. */
  error?: string;
  /**
   * When true (default), clear the screen first. Set false for exits that
   * happened inside a TUI that's already unmounted and already cleared.
   */
  clearScreen?: boolean;
}

/**
 * Render the exit screen to stderr. Safe to call once after any Ink
 * instance has unmounted. Does not call process.exit — the caller owns
 * the exit code.
 */
export function renderExit(opts: ExitScreenOptions = {}): void {
  const dim = '\x1b[2m';
  const reset = '\x1b[0m';
  const cyan = '\x1b[36m';
  const red = '\x1b[31m';

  if (opts.clearScreen !== false) {
    process.stderr.write('\x1b[2J\x1b[H');
  }

  if (opts.error) {
    process.stderr.write(`${red}${opts.error}${reset}\n\n`);
  } else {
    if (opts.note) {
      process.stderr.write(`${opts.note}\n\n`);
    }
    process.stderr.write(`${dim}~ ${pickFarewell()} ~${reset}\n\n`);
  }

  if (opts.resume) {
    process.stderr.write(
      `To resume this session, run either:\n` +
      `  ${cyan}codocs${reset} ${opts.resume.docArgs}\n` +
      `  ${cyan}codocs${reset} --resume ${opts.resume.sessionId}\n\n`,
    );
  }
}
