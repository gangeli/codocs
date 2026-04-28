import React from 'react';
import type { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { render, type Instance as InkInstance } from 'ink';
import {
  CodocsClient,
  createAuth,
  ensureSubscription,
  renewSubscription,
  listenForComments,
  ReplyTracker,
  AgentOrchestrator,
  ClaudeRunner,
  CodexRunner,
  CursorRunner,
  OpenCodeRunner,
  generateAgentName,
  type AgentType,
  type AgentRunner,
  type CommentEvent,
  type CommentListenerHandle,
  type SubscriptionInfo,
  type PermissionMode,
} from '@codocs/core';
import { openDatabase, saveDatabase, SessionStore, AgentNameStore, QueueStore, SettingsStore, CodeTaskStore, CodocsSessionStore, type CodocsSession } from '@codocs/db';
import { readConfig, readTokens, readGitHubTokens } from '../auth/token-store.js';
import { withErrorHandler } from '../util.js';
import { renderExit } from '../exit.js';
import { buildRepairContext, runStartupChecks, runRepairUi } from '../repair/index.js';
import { metaRestartShutdown, captureCodeBaseline, hasCodeChanged, type MetaRestartShutdownCtx, type CodeBaseline } from './meta-restart.js';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir, homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

/** How long before a heartbeat is considered stale (45s = 3 missed beats). */
const HEARTBEAT_STALE_MS = 45_000;
/** How often to refresh the heartbeat. */
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Check if Claude Code's auto permission mode is available.
 * Auto mode requires a paid plan. We detect this by checking
 * the cached account info in ~/.claude.json.
 */
function isAutoModeAvailable(): boolean {
  try {
    const raw = readFileSync(join(homedir(), '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);
    const billing = config?.oauthAccount?.billingType;
    return typeof billing === 'string' && billing.includes('subscription');
  } catch {
    return false;
  }
}
import { App, Welcome, Generating, GenerateFromRepo, createInitialState, getStandalonePermissions, type TuiStateRef, type ActivityEvent, type WelcomeChoice } from '../tui/index.js';

export function isAgentType(value: string): value is AgentType {
  return value in AGENT_RUNNERS;
}

/** Registry of available agent runners. */
const AGENT_RUNNERS: Record<AgentType, () => AgentRunner> = {
  claude: () => new ClaudeRunner(),
  codex: () => new CodexRunner(),
  cursor: () => new CursorRunner(),
  opencode: () => new OpenCodeRunner(),
};

/**
 * Grab a bounded slice of the repo's source text for the rain animation
 * background. Best-effort: if the cwd isn't a git repo, or no source
 * files are tracked, the rain falls back to a built-in sample.
 */
function gatherCodeSamples(cwd: string): string {
  try {
    const listed = spawnSync('git', ['ls-files'], {
      cwd,
      encoding: 'utf-8',
      timeout: 1500,
    });
    if (listed.status !== 0 || !listed.stdout) return '';
    const files = listed.stdout
      .split('\n')
      .filter((f) => /\.(ts|tsx|js|jsx|py|go|rs|java|kt|rb|swift|c|h|cpp|cs|php|sql|md|json|ya?ml)$/i.test(f))
      .slice(0, 20);
    let out = '';
    for (const f of files) {
      try {
        const content = readFileSync(join(cwd, f), 'utf-8');
        out += content + '\n';
        if (out.length > 20_000) break;
      } catch {}
    }
    return out;
  } catch {
    return '';
  }
}

export function fallbackDocName(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  return `Codocs ${date}`;
}

async function generateDocName(
  description: string,
  agentType: AgentType,
): Promise<string> {
  if (!description.trim()) return fallbackDocName();

  const runnerFactory = AGENT_RUNNERS[agentType];
  if (!runnerFactory) return fallbackDocName();

  try {
    const runner = runnerFactory();
    const result = await runner.run(
      `Generate a short, descriptive document title (max 6 words, no quotes, no punctuation at the end) for a collaborative document about: ${description.trim()}\n\nRespond with ONLY the title, nothing else.`,
      null,
      { timeout: 15_000 },
    );

    const name = result.stdout.trim().replace(/^["']|["']$/g, '').trim();
    if (name && name.length > 0 && name.length < 80) return name;
  } catch {
    // Agent failed — fall back silently
  }

  return fallbackDocName();
}

/** How often to renew subscriptions (6 days, well before 7-day expiry). */
const RENEWAL_INTERVAL_MS = 6 * 24 * 60 * 60 * 1000;

function printServerAlreadyRunning(docId: string): void {
  const dim = '\x1b[2m';
  const bold = '\x1b[1m';
  const red = '\x1b[31m';
  const yellow = '\x1b[33m';
  const reset = '\x1b[0m';

  process.stderr.write(
    `\n` +
    `  ${red}${bold}Another codocs server is already running${reset}\n` +
    `\n` +
    `  ${dim}Document:${reset} ${docId.slice(0, 20)}...\n` +
    `\n` +
    `  ${yellow}Only one server can be active per document at a time.${reset}\n` +
    `  ${dim}If the other server crashed, wait ~45 seconds for the lock to expire.${reset}\n` +
    `\n`,
  );
}

function printAuthRequired(): void {
  const dim = '\x1b[2m';
  const bold = '\x1b[1m';
  const cyan = '\x1b[36m';
  const red = '\x1b[31m';
  const reset = '\x1b[0m';

  process.stderr.write(
    `\n` +
    `  ${red}${bold}Not authenticated${reset}\n` +
    `\n` +
    `  ${dim}No OAuth tokens found. Sign in to connect your Google account:${reset}\n` +
    `\n` +
    `    ${cyan}codocs login${reset}\n` +
    `\n`,
  );
}

export function formatCommentEvent(event: CommentEvent): string {
  const parts: string[] = [];
  const time = event.eventTime
    ? new Date(event.eventTime).toLocaleTimeString()
    : 'unknown time';
  const author = event.comment.author ?? 'Unknown';
  const docId = event.documentId;

  parts.push(`[${time}] Comment on ${docId}`);
  parts.push(`  Author: ${author}`);
  if (event.comment.quotedText) parts.push(`  On: "${event.comment.quotedText}"`);
  if (event.comment.content) parts.push(`  Content: ${event.comment.content}`);
  if (event.comment.mentions.length > 0) parts.push(`  Mentions: ${event.comment.mentions.join(', ')}`);
  return parts.join('\n');
}

/**
 * Unified event emitter that works in both TUI and plain-text mode.
 */
function createEventEmitter(tuiRef: TuiStateRef | null) {
  return (event: Omit<ActivityEvent, 'id'> & { id?: string }) => {
    const fullEvent = {
      ...event,
      id: event.id ?? `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    } as ActivityEvent;

    if (tuiRef) {
      tuiRef.addEvent(fullEvent);
    } else {
      const time = event.time.toLocaleTimeString();
      if (event.type === 'comment') {
        console.log(`[${time}] ${event.author ?? 'Unknown'}: ${event.content}`);
        if (event.quotedText) console.log(`  On: "${event.quotedText}"`);
      } else if (event.type === 'error') {
        console.error(`[${time}] ERROR: ${event.content}`);
      } else {
        console.error(`[${time}] ${event.content}`);
      }
    }
  };
}

// ── Idle hooks ──────────────────────────────────────────────

type EventEmitter = ReturnType<typeof createEventEmitter>;

function handleSilenceHook(command: string, emit: EventEmitter): void {
  emit({ time: new Date(), type: 'system', content: `Running silence hook: ${command}` });
  try {
    const result = spawnSync('sh', ['-c', command], { stdio: 'inherit', timeout: 300_000 });
    if (result.status !== 0) {
      emit({ time: new Date(), type: 'error', content: `Silence hook exited with code ${result.status}` });
    } else {
      emit({ time: new Date(), type: 'system', content: 'Silence hook completed' });
    }
  } catch (err: any) {
    emit({ time: new Date(), type: 'error', content: `Silence hook failed: ${err.message}` });
  }
}

function handleMetaRestart(
  sessionId: string,
  baseline: { current: CodeBaseline },
  ctx: MetaRestartShutdownCtx & { emit: EventEmitter },
): void {
  if (!hasCodeChanged(baseline.current)) {
    ctx.emit({
      time: new Date(),
      type: 'system',
      content: 'All agents idle — no code changes since last build, skipping meta rebuild.',
    });
    return;
  }
  // Refresh the baseline so a follow-up reply that doesn't touch code
  // doesn't trigger another rebuild after the child restarts. (The child
  // captures its own baseline at startup, but we update ours too in case
  // the restart never happens for any reason.)
  baseline.current = captureCodeBaseline();
  ctx.emit({ time: new Date(), type: 'system', content: 'All agents idle — meta rebuild starting...' });

  (async () => {
    // 1. Graceful shutdown (without process.exit)
    try {
      await metaRestartShutdown(ctx);
    } catch (err: any) {
      console.error(`[meta] Shutdown error (continuing): ${err.message}`);
    }

    // 2. Rebuild
    console.error('[meta] Running make...');
    const makeResult = spawnSync('make', [], { stdio: 'inherit', timeout: 120_000 });
    if (makeResult.status !== 0) {
      console.error(`[meta] Build failed with exit code ${makeResult.status}. Exiting.`);
      process.exit(1);
    }

    // 3. Re-exec with --resume
    console.error('[meta] Build succeeded, restarting...');
    const restartArgs = buildRestartArgs(process.argv.slice(2), sessionId);
    const child = spawn(process.execPath, [process.argv[1], ...restartArgs], {
      stdio: 'inherit',
      detached: true,
    });
    child.unref();
    process.exit(0);
  })();
}

/**
 * Build restart args: take the original args, strip any existing --resume,
 * and add --resume <sessionId>. Preserves all other flags including --meta.
 */
export function buildRestartArgs(originalArgs: string[], sessionId: string): string[] {
  const args: string[] = [];
  let skipNext = false;

  for (let i = 0; i < originalArgs.length; i++) {
    if (skipNext) { skipNext = false; continue; }

    if (originalArgs[i] === '--resume') {
      // Check if next arg is a value (not another flag)
      if (i + 1 < originalArgs.length && !originalArgs[i + 1].startsWith('--')) {
        skipNext = true;
      }
      continue;
    }
    if (originalArgs[i].startsWith('--resume=')) continue;

    args.push(originalArgs[i]);
  }

  args.push('--resume', sessionId);
  return args;
}

/**
 * Show the welcome screen and return the user's choice.
 */
async function showWelcome(useTui: boolean, recentSessions: CodocsSession[]): Promise<WelcomeChoice> {
  if (useTui) {
    return new Promise<WelcomeChoice>((resolve) => {
      const { unmount } = render(
        React.createElement(Welcome, {
          cwd: process.cwd(),
          recentSessions,
          onChoice: (choice: WelcomeChoice) => { unmount(); resolve(choice); },
        }),
        { exitOnCtrlC: true },
      );
    });
  }

  // Plain text fallback
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  if (recentSessions.length > 0) {
    console.error('Recent sessions:');
    for (let i = 0; i < recentSessions.length; i++) {
      const s = recentSessions[i];
      const label = s.docTitle ?? s.docIds[0].slice(0, 16) + '...';
      console.error(`  ${i + 1}) ${label} [${s.id}]`);
    }
    console.error('');
    const answer = await rl.question('Enter a number to resume, a Doc URL/ID, or press Enter to create new: ');
    rl.close();
    const trimmed = answer.trim();
    if (!trimmed) return { type: 'from-repo' };
    const num = parseInt(trimmed, 10);
    if (num >= 1 && num <= recentSessions.length) {
      const s = recentSessions[num - 1];
      return { type: 'resume', sessionId: s.id, docIds: s.docIds, agentType: s.agentType };
    }
    return { type: 'open', docId: trimmed };
  }
  const answer = await rl.question('Enter a Doc URL/ID, or press Enter to create new: ');
  rl.close();
  if (answer.trim()) {
    return { type: 'open', docId: answer.trim() };
  }
  return { type: 'from-repo' };
}

/**
 * Resolve a welcome choice into either an existing doc ID or markdown content.
 */
async function resolveWelcomeChoice(
  choice: WelcomeChoice,
  agentType: AgentType,
  standalonePermissions?: import('@codocs/core').PermissionMode,
): Promise<{ docId?: string; content?: string }> {
  switch (choice.type) {
    case 'resume':
      // Handled before resolveWelcomeChoice is called
      return { docId: choice.docIds[0] };

    case 'quit':
      // Handled before resolveWelcomeChoice is called
      process.exit(0);

    case 'open':
      return { docId: choice.docId };

    case 'from-repo': {
      const runnerFactory = AGENT_RUNNERS[agentType];
      if (!runnerFactory) {
        console.error(`Unknown agent type "${agentType}".`);
        process.exit(1);
      }
      const runner = runnerFactory();

      // The agent writes to .codocs/design-doc.md instead of stdout.
      // This is more reliable — Claude is better at writing files than
      // producing clean stdout-only output.
      const outputPath = join(process.cwd(), '.codocs', 'design-doc.md');

      const codeSamples = gatherCodeSamples(process.cwd());
      // Clear the welcome screen so the animation takes the full terminal.
      if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');
      const { unmount } = render(
        React.createElement(GenerateFromRepo, {
          message: 'Generating document from codebase',
          codeSamples,
        }),
      );

      try {
        const fromRepoPrompt = readFileSync(new URL('./prompts/from-repo.txt', import.meta.url), 'utf-8');
        const result = await runner.run(
          fromRepoPrompt,
          null,
          { timeout: 1_200_000, permissionMode: standalonePermissions },
        );
        unmount();
        if (result.exitCode !== 0) {
          console.error(`Agent exited with code ${result.exitCode}.`);
          if (result.stderr) console.error(result.stderr.slice(0, 500));
          process.exit(1);
        }

        // Read the file the agent wrote
        try {
          const content = readFileSync(outputPath, 'utf-8').trim();
          if (!content) {
            console.error('Agent did not write any content to .codocs/design-doc.md');
            process.exit(1);
          }
          // Clean up the temp file
          try { unlinkSync(outputPath); } catch {}
          return { content };
        } catch {
          // Fallback: if the agent didn't write the file, try stdout
          const stdout = result.stdout.trim();
          if (stdout) {
            return { content: stdout };
          }
          console.error('Agent did not write .codocs/design-doc.md and produced no stdout.');
          process.exit(1);
        }
      } catch (err: any) {
        unmount();
        console.error(`Agent failed: ${err.message}`);
        process.exit(1);
      }
    }

    case 'import-file': {
      try {
        const content = readFileSync(choice.path, 'utf-8');
        return { content };
      } catch (err: any) {
        console.error(`Failed to read ${choice.path}: ${err.message}`);
        process.exit(1);
      }
    }

    case 'write-new': {
      const editor = process.env.VISUAL || process.env.EDITOR || 'vim';
      const tmpFile = join(tmpdir(), `codocs-${Date.now()}.md`);
      writeFileSync(tmpFile, '# \n\n', 'utf-8');

      console.error(`Opening ${editor}...`);
      const result = spawnSync(editor, [tmpFile], { stdio: 'inherit' });

      if (result.status !== 0) {
        console.error(`Editor exited with code ${result.status}.`);
        try { unlinkSync(tmpFile); } catch {}
        process.exit(1);
      }

      try {
        const content = readFileSync(tmpFile, 'utf-8');
        unlinkSync(tmpFile);
        if (!content.trim() || content.trim() === '#') {
          console.error('Empty document, creating blank doc.');
          return {};
        }
        return { content };
      } catch {
        return {};
      }
    }

    case 'from-prompt': {
      const runnerFactory = AGENT_RUNNERS[agentType];
      if (!runnerFactory) {
        console.error(`Unknown agent type "${agentType}".`);
        process.exit(1);
      }
      const runner = runnerFactory();
      const outputPath = join(process.cwd(), '.codocs', 'design-doc.md');

      const { unmount } = render(
        React.createElement(Generating, { message: 'Generating document from prompt...' }),
      );

      try {
        const result = await runner.run(
          `Write a document in markdown based on the following description. ` +
          `Be concise but thorough. Write the document to .codocs/design-doc.md — ` +
          `do not output it to stdout.\n\n${choice.prompt}`,
          null,
          { timeout: 1_200_000, permissionMode: standalonePermissions },
        );
        unmount();
        if (result.exitCode !== 0) {
          console.error(`Agent exited with code ${result.exitCode}.`);
          if (result.stderr) console.error(result.stderr.slice(0, 500));
          process.exit(1);
        }

        try {
          const content = readFileSync(outputPath, 'utf-8').trim();
          if (!content) {
            console.error('Agent did not write any content to .codocs/design-doc.md');
            process.exit(1);
          }
          try { unlinkSync(outputPath); } catch {}
          return { content };
        } catch {
          const stdout = result.stdout.trim();
          if (stdout) return { content: stdout };
          console.error('Agent did not write .codocs/design-doc.md and produced no stdout.');
          process.exit(1);
        }
      } catch (err: any) {
        unmount();
        console.error(`Agent failed: ${err.message}`);
        process.exit(1);
      }
    }
  }
}

export function registerServeCommand(program: Command) {
  program
    .command('serve', { isDefault: true })
    .description('Start the codocs server to listen for comment events')
    .argument('[docIds...]', 'Google Doc IDs or URLs to watch')
    .option('--debug', 'Enable verbose debug logging')
    .option('--no-tui', 'Disable the terminal UI (plain text output)')
    .option('--agent-type <type>', 'Agent runner type (e.g., claude)', 'claude')
    .option('--db-path <path>', 'SQLite database path')
    .option('--fallback-agent <name>', 'Default agent for unattributed text (auto-generated if omitted)')
    .option('--service-account [path]', 'Post replies from a service account instead of your own identity. Optional path; defaults to ~/.local/share/codocs/service-account.json')
    .option('--resume [id]', 'Resume a previous session (optionally by ID)')
    .option('--silence-hook <command>', 'Shell command to run when all agents are idle')
    .option('--meta', 'Auto-rebuild and restart when idle (for self-development)')
    .action(
      withErrorHandler(async (docIds: string[], opts: {
        debug?: boolean;
        tui?: boolean;
        agentType?: string;
        dbPath?: string;
        fallbackAgent?: string;
        serviceAccount?: string | boolean;
        resume?: string | boolean;
        silenceHook?: string;
        meta?: boolean;
      }) => {
        const debugMode = opts.debug ?? false;
        const useTui = opts.tui !== false;

        // ── Pre-TUI: interactive doc selection ────────────────────
        // Clear screen for a fresh start
        process.stderr.write('\x1b[2J\x1b[H');

        // Handle --resume: load session from DB before anything else
        if (opts.resume) {
          const tempDb = await openDatabase(opts.dbPath);
          const tempSessions = new CodocsSessionStore(tempDb);
          let session: CodocsSession | null;
          if (typeof opts.resume === 'string') {
            session = tempSessions.get(opts.resume);
          } else {
            const recent = tempSessions.listByDirectory(process.cwd(), 1);
            session = recent[0] ?? null;
          }
          tempDb.close();
          if (!session) {
            renderExit({
              clearScreen: false,
              error: typeof opts.resume === 'string'
                ? `No session found with ID "${opts.resume}".`
                : 'No previous session found for this directory.',
            });
            process.exit(1);
          }
          docIds = session.docIds;
          if (!opts.agentType || opts.agentType === 'claude') {
            opts.agentType = session.agentType;
          }
        }

        if (docIds.length === 0) {
          // Load recent sessions for the Welcome screen
          let recentSessions: CodocsSession[] = [];
          {
            const tempDb = await openDatabase(opts.dbPath);
            const tempSessions = new CodocsSessionStore(tempDb);
            recentSessions = tempSessions.listByDirectory(process.cwd(), 3);
            tempDb.close();
          }

          const choice = await showWelcome(useTui, recentSessions);

          if (choice.type === 'quit') {
            renderExit();
            process.exit(0);
          }

          // Handle resume choice from Welcome screen
          if (choice.type === 'resume') {
            docIds = choice.docIds;
            opts.agentType = choice.agentType;
          } else {
          const agentTypeRaw = opts.agentType ?? 'claude';
          if (!isAgentType(agentTypeRaw)) {
            console.error(`Unknown agent type "${agentTypeRaw}". Available: ${Object.keys(AGENT_RUNNERS).join(', ')}`);
            process.exit(1);
          }
          const agentTypeForWelcome: AgentType = agentTypeRaw;
          const standalonePerms = getStandalonePermissions({
            autoModeAvailable: agentTypeForWelcome === 'claude' && isAutoModeAvailable(),
          });
          const initialMarkdown = await resolveWelcomeChoice(choice, agentTypeForWelcome, standalonePerms);

          if (initialMarkdown.docId) {
            // Existing doc
            docIds = [initialMarkdown.docId];
          } else {
            // Create new doc from content — show progress in TUI
            const config = readConfig();
            const tokens = readTokens();
            if (!tokens) { printAuthRequired(); process.exit(1); }
            const client = new CodocsClient({
              oauth2: { clientId: config.client_id, clientSecret: config.client_secret, refreshToken: tokens.refresh_token },
            });
            const agentType = agentTypeForWelcome;

            // Step state for the Generating component
            let stepMessage = 'Generating document name';
            let stepSub = '';
            const stepEl = () => React.createElement(Generating, { message: stepMessage, subMessage: stepSub });
            const { unmount: unmountStep, rerender } = render(stepEl());
            const updateStep = (msg: string, sub?: string) => {
              stepMessage = msg;
              stepSub = sub ?? '';
              rerender(stepEl());
            };

            const docName = await generateDocName(initialMarkdown.content ?? '', agentType);

            updateStep('Creating document', `"${docName}" in Codocs/ folder`);
            const { docId } = await client.createDocInFolder(docName);

            if (initialMarkdown.content) {
              updateStep('Writing content to document', `${initialMarkdown.content.length} characters`);
              await client.writeMarkdown(docId, initialMarkdown.content);
            }

            unmountStep();
            const docUrl = `https://docs.google.com/document/d/${docId}/edit`;
            console.error(`Created: ${docUrl}`);
            console.error(`Location: My Drive > Codocs > ${docName}\n`);
            docIds = [docId];
          }
          } // end else (non-resume choice)
        }

        // ── Auth & config ─────────────────────────────────────────
        const config = readConfig();
        const tokens = readTokens();
        if (!tokens) { printAuthRequired(); process.exit(1); }
        if (!config.gcp_project_id || !config.pubsub_topic) {
          console.error('GCP Pub/Sub not configured. Run `codocs login` to set up.');
          process.exit(1);
        }

        const auth = createAuth({
          oauth2: { clientId: config.client_id, clientSecret: config.client_secret, refreshToken: tokens.refresh_token },
        });

        const gcpProjectId = config.gcp_project_id;
        const fullTopic = `projects/${gcpProjectId}/topics/${config.pubsub_topic}`;
        const subscriptionName = `${config.pubsub_topic}-sub`;
        const normalizedDocIds = docIds.map(extractDocId);
        const primaryDocId = normalizedDocIds[0];

        // ── Server lock (prevent duplicate servers per doc) ──────
        const lockClient = new CodocsClient({
          oauth2: { clientId: config.client_id, clientSecret: config.client_secret, refreshToken: tokens.refresh_token },
        });
        const serverHash = createHash('sha256')
          .update(`${hostname()}\0${process.pid}\0${Date.now()}`)
          .digest('base64url')
          .slice(0, 16);

        for (const docId of normalizedDocIds) {
          // Skip lock check for malformed doc IDs — the repair screen will flag them.
          if (!/^[a-zA-Z0-9_-]{40,44}$/.test(docId)) continue;
          try {
            const heartbeat = await lockClient.getServerHeartbeat(docId);
            if (heartbeat) {
              const age = Date.now() - heartbeat.timestamp;
              if (age < HEARTBEAT_STALE_MS) {
                printServerAlreadyRunning(docId);
                process.exit(1);
              }
            }
            // Claim the lock
            await lockClient.setServerHeartbeat(docId, serverHash);
          } catch (err: any) {
            // Non-fatal: don't block startup if appProperties fails
            console.error(`Warning: could not check server lock for ${docId.slice(0, 12)}...: ${err.message}`);
          }
        }

        // Heartbeat refresh
        const heartbeatTimer = setInterval(async () => {
          for (const docId of normalizedDocIds) {
            try {
              await lockClient.setServerHeartbeat(docId, serverHash);
            } catch { /* best-effort */ }
          }
        }, HEARTBEAT_INTERVAL_MS);

        // ── Database ──────────────────────────────────────────────
        const db = await openDatabase(opts.dbPath);
        const settingsStore = new SettingsStore(db);
        const cwd = process.cwd();

        // ── Startup validation (see packages/cli/src/repair) ─────
        // Catches bad state (malformed doc IDs, missing auth, unreachable
        // docs) before we commit to subscription setup — which exits on
        // failure. Opens a Repair screen if anything's broken so the user
        // can fix it without hand-editing the sqlite DB.
        {
          const repairCtx = await buildRepairContext({
            db,
            dbPath: opts.dbPath,
            cwd,
            targetDocIds: normalizedDocIds,
          });
          const startupIssues = await runStartupChecks(repairCtx);
          const hasErrors = startupIssues.some((i) => i.severity === 'error');
          if (hasErrors) {
            const outcome = await runRepairUi(startupIssues, repairCtx, {
              auto: false,
              useTui,
              headerMessage: 'Codocs found issues during startup',
              rerunChecks: runStartupChecks,
            });
            if (!outcome.resolved) {
              db.close();
              const remaining = outcome.remaining.filter((i) => i.severity === 'error').length;
              renderExit({ note: `${remaining} unresolved issue${remaining === 1 ? '' : 's'} remain — codocs can't start until they're fixed.` });
              process.exit(1);
            }
            // Something was fixed — docIds may no longer reflect reality
            // (e.g. user stripped a doc from a resumed session). Safest
            // path: exit cleanly and ask the user to re-run.
            db.close();
            renderExit({ note: 'Issues resolved. Re-run `codocs` to continue.' });
            process.exit(0);
          }
        }

        // ── TUI or plain mode ─────────────────────────────────────
        // Use a mutable container so callbacks can access the ref
        const tui: { ref: TuiStateRef | null } = { ref: null };
        let listener: CommentListenerHandle | null = null;
        let renewalTimer: ReturnType<typeof setInterval> | null = null;
        let orchestrator: AgentOrchestrator | null = null;
        let sessionInfo: { id: string; docArgs: string } | null = null;
        let inkInstance: InkInstance | null = null;

        const shutdown = async () => {
          try {
            // Kill any active agent processes first
            if (orchestrator) {
              const killed = orchestrator.killAll();
              if (killed.length > 0) {
                const msg = `Killed ${killed.length} active agent(s): ${killed.join(', ')}`;
                if (tui.ref) {
                  tui.ref.addEvent({
                    id: `shutdown-${Date.now()}`,
                    time: new Date(),
                    type: 'system',
                    content: msg,
                  });
                } else {
                  console.error(msg);
                }
              }
            }
            if (renewalTimer) clearInterval(renewalTimer);
            clearInterval(heartbeatTimer);
            // Release server lock
            for (const docId of normalizedDocIds) {
              try { await lockClient.clearServerHeartbeat(docId); } catch { /* best-effort */ }
            }
            // Revoke bot commenter access so it doesn't accumulate permissions
            if (botEmail) {
              for (const docId of normalizedDocIds) {
                try { await client.removePermission(docId, botEmail); } catch { /* best-effort */ }
              }
            }
            if (listener) await listener.close();
            db.close();
          } catch { /* best-effort cleanup */ }
          if (!useTui) {
            renderExit({
              clearScreen: false,
              resume: sessionInfo ? { sessionId: sessionInfo.id, docArgs: sessionInfo.docArgs } : undefined,
            });
            process.exit(0);
          }
        };

        // ── Agent runner (needed early for TUI capabilities) ──
        const agentTypeRaw = opts.agentType ?? 'claude';
        if (!isAgentType(agentTypeRaw)) {
          console.error(`Unknown agent type "${agentTypeRaw}". Available: ${Object.keys(AGENT_RUNNERS).join(', ')}`);
          process.exit(1);
        }
        const agentType: AgentType = agentTypeRaw;
        const agentRunner = AGENT_RUNNERS[agentType]();

        // ── Persist session for resume ────────────────────────────
        const codocsSessionStore = new CodocsSessionStore(db);
        const codocsSession = codocsSessionStore.upsert(cwd, normalizedDocIds, agentType);
        saveDatabase(db);
        sessionInfo = { id: codocsSession.id, docArgs: normalizedDocIds.join(' ') };

        // ── GitHub auth (check only — debug logging deferred) ──
        const ghTokens = readGitHubTokens();
        const githubConnected = !!ghTokens;

        if (useTui) {
          const autoModeAvailable = agentType === 'claude' && isAutoModeAvailable();
          const runnerCapabilities = agentRunner.getCapabilities();
          const initialState = createInitialState(primaryDocId, { agentType, autoModeAvailable, githubConnected, runnerCapabilities });
          if (debugMode) initialState.settings.debugMode = true;

          // Restore persisted settings (merge with defaults)
          initialState.settings = settingsStore.loadAll(cwd, initialState.settings);

          inkInstance = render(React.createElement(App, {
            initialState,
            onShutdown: shutdown,
            getActiveAgents: () => orchestrator?.getActiveAgents() ?? [],
            onStateRef: (ref: TuiStateRef) => { tui.ref = ref; },
            onSettingsChange: (settings) => {
              settingsStore.saveAll(cwd, settings);
              saveDatabase(db);
            },
          }), { exitOnCtrlC: false });

          // Wait for ref to be set
          await new Promise((r) => setTimeout(r, 50));
        }

        const emit = createEventEmitter(tui.ref);

        // Debug always emits — the TUI filters based on debugMode setting.
        // In --no-tui mode, only print if --debug was passed.
        const debug = (msg: string) => {
          if (useTui && tui.ref) {
            tui.ref.addEvent({
              id: `dbg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              time: new Date(),
              type: 'debug',
              content: msg,
            });
          } else if (debugMode) {
            console.error(`[debug] ${msg}`);
          }
        };

        debug(githubConnected
          ? 'GitHub connected — code mode with PRs available'
          : 'GitHub not connected — code changes will be direct (no PRs)');
        debug(`GCP Project: ${gcpProjectId}`);
        debug(`Pub/Sub Topic: ${fullTopic}`);

        // ── Subscriptions ─────────────────────────────────────────
        const setStatus = (msg: string) => {
          if (tui.ref) tui.ref.setStatus(msg);
          else console.error(msg);
        };

        setStatus('Setting up subscriptions...');
        const subscriptions: SubscriptionInfo[] = [];

        for (const docId of normalizedDocIds) {
          setStatus(`Setting up subscription for ${docId.slice(0, 12)}...`);
          try {
            // ensureSubscription checks for existing subscriptions, upgrades
            // them if they're missing event types (e.g., reply support), and
            // creates new ones if needed.
            const sub = await ensureSubscription(auth, docId, fullTopic, debug);
            subscriptions.push(sub);
            setStatus('Subscription ready');
          } catch (err: any) {
            emit({ time: new Date(), type: 'error', content: `Subscription failed: ${err.message}` });
            process.exit(1);
          }
        }

        // ── Agent orchestrator ────────────────────────────────────
        debug(`Agent runner: ${agentRunner.name}`);

        const sessionStore = new SessionStore(db);
        const queueStore = new QueueStore(db);
        const agentNameStore = new AgentNameStore(db);
        const codeTaskStore = new CodeTaskStore(db);

        // Resolve fallback agent name: use explicit flag, or generate a
        // cute two-word name (persisted so resumes keep the name).
        //
        // When the doc has zero attributions, give each comment thread its
        // own agent so unrelated threads run in parallel. Replies on the
        // same thread share comment.id and so retain the same agent. Once
        // the doc accumulates attribution spans we fall back to a single
        // per-doc name for "the rest" — the assumption being that those
        // sections share an implicit owner.
        const fallbackAgent = opts.fallbackAgent
          ? opts.fallbackAgent
          : (documentId: string, commentId?: string, hasAttributions?: boolean) => {
              if (commentId && !hasAttributions) {
                return agentNameStore.getOrCreate(
                  documentId, `comment:${commentId}`, generateAgentName,
                );
              }
              return agentNameStore.getOrCreate(documentId, 'fallback', generateAgentName);
            };

        const client = new CodocsClient({
          oauth2: { clientId: config.client_id, clientSecret: config.client_secret, refreshToken: tokens.refresh_token },
        });

        // Fetch document title for the TUI header
        try {
          const doc = await client.getDocument(primaryDocId);
          if (doc.title) {
            if (tui.ref) tui.ref.setDocTitle(doc.title);
            codocsSessionStore.setDocTitle(codocsSession.id, doc.title);
            saveDatabase(db);
          }
        } catch { /* keep truncated ID fallback */ }

        // Reply identity:
        //   • Default — replies come from the user's own OAuth identity with
        //     a bot-indicator prefix prepended to the content, so the user
        //     can tell codocs's replies from their own.
        //   • Opt-in via --service-account [path] — replies come from a
        //     service-account identity (e.g. one provisioned by `make infra`).
        //     The doc is auto-shared with the SA at startup and unshared on
        //     shutdown so the SA does not accumulate permissions.
        //
        // The replyTracker is always on: it records the IDs of replies codocs
        // posts and lets the listener skip the resulting self-triggered
        // events. Critical when replying as the user's own OAuth identity
        // (replies look identical to the user's own human replies).
        const replyTracker = new ReplyTracker();
        let replyClient: CodocsClient | undefined;
        let botEmail: string | null = null;
        let botReplyPrefix = '\u{1F916} '; // default: 🤖 prefix on user-identity replies
        if (opts.serviceAccount) {
          const { loadServiceAccountKey, getBotEmail, defaultServiceAccountKeyPath } =
            await import('../auth/service-account.js');
          const keyPath = typeof opts.serviceAccount === 'string'
            ? opts.serviceAccount
            : defaultServiceAccountKeyPath();
          const saKey = loadServiceAccountKey(keyPath);
          if (saKey) {
            botEmail = getBotEmail(saKey);
            debug(`Using service-account identity for replies (${botEmail ?? keyPath})`);
            replyClient = new CodocsClient({ serviceAccountKey: saKey });
            botReplyPrefix = ''; // SA identity is its own indicator

            // Auto-share each doc with the bot so it has commenter access.
            // Uses the user's OAuth2 client (which owns/has access to the doc).
            if (botEmail) {
              for (const docId of normalizedDocIds) {
                try {
                  await client.ensureShared(docId, botEmail, 'commenter');
                  debug(`Shared ${docId} with ${botEmail}`);
                } catch (err: any) {
                  debug(`Failed to share ${docId} with bot: ${err.message}`);
                }
              }
              emit({ time: new Date(), type: 'system', content: `Bot replies as ${botEmail}` });
            }
          } else {
            console.error(
              `--service-account: no readable key at ${keyPath}. ` +
              `Run \`make infra\` to provision one, or pass an explicit path.`,
            );
            process.exit(1);
          }
        }

        // Snapshot the working tree at startup so the --meta restart hook
        // can skip rebuilding when the agent only posted replies and didn't
        // touch the source. Mutable so a successful rebuild path can refresh
        // it without a re-exec.
        const metaBaseline: { current: CodeBaseline } = { current: opts.meta ? captureCodeBaseline() : '' };

        orchestrator = new AgentOrchestrator({
          client,
          replyClient,
          replyTracker,
          botReplyPrefix,
          sessionStore,
          queueStore,
          agentRunner,
          fallbackAgent,
          permissionMode: () => {
            if (tui.ref) {
              return tui.ref.getSettings().permissionMode;
            }
            return { type: 'auto' };
          },
          codeTaskStore,
          model: () => {
            if (tui.ref) {
              const settings = tui.ref.getSettings();
              return settings.defaultModel[agentType] || undefined;
            }
            return undefined;
          },
          harnessSettings: () => {
            if (tui.ref) {
              // Extract settings for the current agent type from the flat map
              const all = tui.ref.getSettings().harnessSettings;
              const prefix = `${agentType}.`;
              const result: Record<string, string> = {};
              for (const [k, v] of Object.entries(all)) {
                if (k.startsWith(prefix)) {
                  result[k.slice(prefix.length)] = v;
                }
              }
              return result;
            }
            return {};
          },
          codeMode: () => {
            if (tui.ref) {
              return tui.ref.getSettings().codeMode;
            }
            return githubConnected ? 'pr' : 'direct';
          },
          githubToken: () => {
            const gt = readGitHubTokens();
            return gt?.access_token ?? null;
          },
          repoRoot: cwd,
          onAgentAssigned: (agentName, task) => {
            if (tui.ref) {
              tui.ref.updateAgent(agentName, {
                status: 'processing',
                task,
                taskStartTime: new Date(),
              });
            }
          },
          onCommentProcessed: (result) => {
            if (tui.ref) {
              tui.ref.updateAgent(result.agentName, { status: 'idle', task: undefined });
            }
            const preview = result.replyPreview.length > 60
              ? result.replyPreview.slice(0, 60) + '...'
              : result.replyPreview;
            emit({
              time: new Date(),
              type: 'agent-reply',
              content: preview || 'Done',
              agent: result.agentName,
              editSummary: result.editSummary,
              replyPreview: result.replyPreview,
            });
          },
          onCommentFailed: (agentName, error) => {
            if (tui.ref) {
              tui.ref.updateAgent(agentName, { status: 'error', task: error.slice(0, 40) });
            }
            emit({ time: new Date(), type: 'error', content: `Agent error: ${error}` });
          },
          onIdle: opts.meta
            ? () => handleMetaRestart(codocsSession.id, metaBaseline, {
                orchestrator: orchestrator!,
                renewalTimer,
                heartbeatTimer,
                listener,
                db,
                lockClient,
                docIds: normalizedDocIds,
                emit,
              })
            : opts.silenceHook
              ? () => handleSilenceHook(opts.silenceHook!, emit)
              : undefined,
          debug,
        });

        // ── Recover any queued items from a previous crash ──────
        await orchestrator.recoverQueue();

        // ── Pub/Sub listener ──────────────────────────────────────
        if (tui.ref) tui.ref.setConnected(true);
        setStatus('Listening for comments');

        listener = listenForComments(
          gcpProjectId,
          subscriptionName,
          { clientId: config.client_id, clientSecret: config.client_secret, refreshToken: tokens.refresh_token },
          (event: CommentEvent) => {
            if (tui.ref) tui.ref.incrementComments();

            emit({
              time: event.eventTime ? new Date(event.eventTime) : new Date(),
              type: 'comment',
              author: event.comment.author,
              quotedText: event.comment.quotedText,
              content: event.comment.content ?? '(no content)',
            });

            orchestrator.handleComment(event).catch((err) => {
              emit({ time: new Date(), type: 'error', content: `Enqueue error: ${err.message}` });
            });
          },
          (error: Error) => {
            emit({ time: new Date(), type: 'error', content: `Pub/Sub error: ${error.message}` });
          },
          { debug, botEmails: botEmail ? [botEmail] : [], replyTracker },
        );

        // ── Subscription renewal ──────────────────────────────────
        renewalTimer = setInterval(async () => {
          for (const sub of subscriptions) {
            try {
              await renewSubscription(auth, sub.name);
              setStatus('Subscription renewed');
            } catch (err: any) {
              emit({ time: new Date(), type: 'error', content: `Renewal failed: ${err.message}` });
            }
          }
        }, RENEWAL_INTERVAL_MS);

        // Graceful shutdown
        if (useTui) {
          try {
            await inkInstance!.waitUntilExit();
          } catch { /* exit may reject during shutdown */ } finally {
            renderExit({ resume: sessionInfo ? { sessionId: sessionInfo.id, docArgs: sessionInfo.docArgs } : undefined });
            process.exit(0);
          }
        } else {
          process.on('SIGINT', shutdown);
          process.on('SIGTERM', shutdown);
        }
      }),
    );
}

export function extractDocId(input: string): string {
  const match = input.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : input;
}
