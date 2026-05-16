#!/usr/bin/env node
/**
 * End-to-end AUTH flow test (interactive).
 *
 * Verifies that `codocs login` drives the Google + GitHub OAuth flows
 * to completion and persists tokens to disk. Interactive because both
 * flows require a human in the loop:
 *   - Google: click through the consent screen in the browser.
 *   - GitHub: enter the device code in the browser and authorize.
 *
 * Isolation: the test creates a throwaway XDG_CONFIG_HOME and
 * XDG_DATA_HOME under a temp dir and sets them in the child env. That
 * makes `auth` provably unset at the start (independent of the
 * developer's real ~/.local/share/codocs/auth.json) and confines any
 * tokens minted during the test to the temp dir. The developer's real
 * auth is never read or overwritten.
 *
 * Phases:
 *   1. Preflight: dump environment + network reachability to Google /
 *      GitHub OAuth endpoints. Assert no auth.json / github-auth.json
 *      in the isolated XDG_DATA_HOME.
 *   2. Run `codocs login` (stdin inherited so the GitHub Y/n prompt
 *      works; stdout/stderr piped, teed to both the terminal AND a
 *      per-step log file so post-mortem is deterministic). Wait for
 *      exit 0.
 *   3. Assert auth.json exists with a non-empty refresh_token, and
 *      github-auth.json exists with a non-empty access_token (the
 *      user is expected to opt-in to GitHub at the prompt).
 *   4. Run `codocs auth status` and assert it reports Google and
 *      GitHub as authenticated.
 *   5. Run `codocs auth logout` and assert both token files are gone.
 *
 * Diagnostics on failure: the sandbox (logs, tokens, env snapshot) is
 * preserved when any check fails so you can inspect after the fact.
 * On a clean pass the sandbox is removed. Every child invocation has
 * its own log file under <sandbox>/logs/. On any failed assertion the
 * script dumps:
 *   - the sandbox tree
 *   - the captured stdout / stderr tail
 *   - any matched OAuth error patterns with explanations
 *   - token-file contents (with secrets truncated to the first 8 chars)
 *
 * Usage:
 *   make e2e/auth
 *   npx tsx scripts/e2e-auth.ts
 *   npx tsx scripts/e2e-auth.ts --skip-github   # decline GitHub at the prompt
 */

import { spawn } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir, platform, release, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..');
const CLI_ENTRY = join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js');

const args = process.argv.slice(2);
const skipGitHub = args.includes('--skip-github');

if (!existsSync(CLI_ENTRY)) {
  console.error(
    `CLI bundle not found at ${CLI_ENTRY}. Run \`make build\` first ` +
      `(or use \`make e2e/auth\`, which builds before running).`,
  );
  process.exit(1);
}

const sandbox = mkdtempSync(join(tmpdir(), 'codocs-e2e-auth-'));
const xdgConfig = join(sandbox, 'config');
const xdgData = join(sandbox, 'data');
const logsDir = join(sandbox, 'logs');
mkdirSync(logsDir, { recursive: true });

const tokensPath = join(xdgData, 'codocs', 'auth.json');
const githubTokensPath = join(xdgData, 'codocs', 'github-auth.json');

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  XDG_CONFIG_HOME: xdgConfig,
  XDG_DATA_HOME: xdgData,
};

// ── Logging / diagnostics ────────────────────────────────────

interface CliInvocation {
  label: string;
  argv: readonly string[];
  status: number;
  stdout: string;
  stderr: string;
  logPath: string;
  startedAt: string;
  durationMs: number;
}

const invocations: CliInvocation[] = [];
const failureLog: string[] = [];

function logFailureNote(note: string): void {
  failureLog.push(note);
}

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function runCli(label: string, cliArgs: string[]): Promise<CliInvocation> {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const logPath = join(logsDir, `${nowStamp()}-${label}.log`);
  const logStream = createWriteStream(logPath);
  const header = [
    `# label: ${label}`,
    `# started: ${startedAt}`,
    `# argv:   node ${CLI_ENTRY} ${cliArgs.join(' ')}`,
    `# XDG_CONFIG_HOME=${xdgConfig}`,
    `# XDG_DATA_HOME=${xdgData}`,
    `# cwd: ${process.cwd()}`,
    '',
    '',
  ].join('\n');
  logStream.write(header);

  return new Promise<CliInvocation>((resolveInvocation, reject) => {
    const child = spawn('node', [CLI_ENTRY, ...cliArgs], {
      env: childEnv,
      // Inherit stdin so interactive prompts (Y/n for GitHub) still work;
      // pipe stdout/stderr so we can tee them to a log file while also
      // streaming to the user's terminal.
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrBuf = '';

    child.stdout!.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      logStream.write(chunk);
      stdoutBuf += chunk.toString('utf-8');
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      logStream.write(chunk);
      stderrBuf += chunk.toString('utf-8');
    });

    child.once('error', (err) => {
      logStream.write(`\n# spawn error: ${err.stack ?? err.message}\n`);
      logStream.end(() => reject(err));
    });

    child.once('close', (code, signal) => {
      const durationMs = Date.now() - start;
      const footer = [
        '',
        '',
        `# exit: code=${code ?? 'null'} signal=${signal ?? 'null'} duration=${durationMs}ms`,
        '',
      ].join('\n');
      logStream.write(footer);
      logStream.end(() => {
        const inv: CliInvocation = {
          label,
          argv: ['node', CLI_ENTRY, ...cliArgs],
          status: code ?? -1,
          stdout: stdoutBuf,
          stderr: stderrBuf,
          logPath,
          startedAt,
          durationMs,
        };
        invocations.push(inv);
        resolveInvocation(inv);
      });
    });
  });
}

// ── Error pattern recognition ────────────────────────────────

interface ErrorPattern {
  pattern: RegExp;
  name: string;
  explanation: string;
}

const ERROR_PATTERNS: readonly ErrorPattern[] = [
  {
    pattern: /access_denied/i,
    name: 'OAuth access_denied',
    explanation:
      'User clicked "Cancel" / "Deny" on the Google consent screen, ' +
      'or the GitHub device-flow authorization was declined. Re-run and ' +
      'click "Allow" / "Authorize".',
  },
  {
    pattern: /redirect_uri_mismatch/i,
    name: 'OAuth redirect_uri_mismatch',
    explanation:
      'Google rejected the redirect URI. The CLI uses http://127.0.0.1:<port>/callback. ' +
      'The OAuth client (client_id in DEFAULT_CONFIG) must allow 127.0.0.1 redirects — ' +
      'check the GCP Console > APIs & Services > Credentials.',
  },
  {
    pattern: /invalid_grant/i,
    name: 'OAuth invalid_grant',
    explanation:
      'The auth code was rejected during exchange. Usually means the code was ' +
      'consumed twice (e.g. browser refresh re-fired the callback) or the system ' +
      'clock is skewed. Check `date` and re-run.',
  },
  {
    pattern: /invalid_client|unauthorized_client/i,
    name: 'OAuth invalid_client / unauthorized_client',
    explanation:
      'Google rejected the client_id / client_secret pair. The baked-in client ' +
      'in DEFAULT_CONFIG may have been revoked. Check token-store.ts and the ' +
      'GCP Console.',
  },
  {
    pattern: /No refresh token received/i,
    name: 'No refresh token returned',
    explanation:
      'Google returned an access token but no refresh token. This happens when ' +
      'the user has previously consented to this client without revoking access. ' +
      'Revoke at https://myaccount.google.com/permissions and re-run.',
  },
  {
    pattern: /Authentication timed out/i,
    name: 'OAuth callback timeout',
    explanation:
      'The local callback server never received the redirect. Browser may have ' +
      'failed to reach 127.0.0.1:<port> (firewall, VPN, or browser extension), ' +
      'or the user closed the tab before authorizing.',
  },
  {
    pattern: /EADDRINUSE/i,
    name: 'Callback port collision (EADDRINUSE)',
    explanation:
      'The local callback server failed to bind. Unexpected because the CLI ' +
      'requests port 0 (OS-assigned). Suggests a low-level networking issue.',
  },
  {
    pattern: /ENETUNREACH|ECONNREFUSED|getaddrinfo/i,
    name: 'Network error reaching Google/GitHub',
    explanation:
      'DNS or TCP failure talking to oauth2.googleapis.com / github.com. Check ' +
      'connectivity, proxies (HTTP_PROXY/HTTPS_PROXY), and DNS.',
  },
  {
    pattern: /expired_token|expired/i,
    name: 'GitHub device code expired',
    explanation:
      'The GitHub device-flow code expired (default 15 min). Re-run `codocs login`.',
  },
  {
    pattern: /incorrect_client_credentials/i,
    name: 'GitHub incorrect_client_credentials',
    explanation:
      'GitHub rejected GITHUB_CLIENT_ID. The baked-in OAuth App may have been ' +
      'deleted or renamed. Check packages/cli/src/auth/github-oauth.ts.',
  },
];

function scanForKnownErrors(text: string): ErrorPattern[] {
  return ERROR_PATTERNS.filter((p) => p.pattern.test(text));
}

// ── Network preflight ────────────────────────────────────────

interface ReachabilityResult {
  url: string;
  ok: boolean;
  status?: number;
  error?: string;
  ms: number;
}

async function checkReachable(url: string, timeoutMs = 5000): Promise<ReachabilityResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'HEAD', signal: controller.signal });
    return { url, ok: res.ok || (res.status >= 200 && res.status < 500), status: res.status, ms: Date.now() - start };
  } catch (err: any) {
    return { url, ok: false, error: err?.message ?? String(err), ms: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

async function networkPreflight(): Promise<ReachabilityResult[]> {
  const urls = [
    'https://accounts.google.com/.well-known/openid-configuration',
    'https://oauth2.googleapis.com/',
    'https://github.com/login/device/code',
    'https://api.github.com/',
  ];
  return Promise.all(urls.map((u) => checkReachable(u)));
}

// ── Dump helpers ─────────────────────────────────────────────

function listSandbox(): string[] {
  const lines: string[] = [];
  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch (err: any) {
      lines.push(`  <unreadable: ${err.message ?? err}>`);
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      const rel = relative(sandbox, full);
      let st;
      try {
        st = statSync(full);
      } catch (err: any) {
        lines.push(`  ${rel}  <unreadable: ${err.message ?? err}>`);
        continue;
      }
      if (st.isDirectory()) {
        lines.push(`  ${rel}/`);
        walk(full);
      } else {
        lines.push(`  ${rel}  (${st.size}B, mode=${(st.mode & 0o777).toString(8)})`);
      }
    }
  }
  walk(sandbox);
  return lines;
}

function tail(s: string, n = 80): string {
  const lines = s.split(/\r?\n/);
  const out = lines.length <= n ? lines : ['  ... (earlier output truncated)', ...lines.slice(-n)];
  return out.join('\n');
}

function truncSecret(s: unknown): string {
  if (typeof s !== 'string') return `<${typeof s}>`;
  if (s.length <= 8) return `<${s.length} chars>`;
  return `${s.slice(0, 8)}…<${s.length - 8} more chars>`;
}

function safeReadTokens(path: string): string {
  try {
    const raw = readFileSync(path, 'utf-8');
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return `RAW (unparseable, first 200 chars):\n${raw.slice(0, 200)}`;
    }
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (k === 'access_token' || k === 'refresh_token' || k === 'id_token') {
        safe[k] = truncSecret(v);
      } else {
        safe[k] = v;
      }
    }
    return JSON.stringify(safe, null, 2);
  } catch (err: any) {
    return `<read failed: ${err.message ?? err}>`;
  }
}

function dumpInvocation(inv: CliInvocation): void {
  console.log(`\n── Invocation: ${inv.label} ──`);
  console.log(`  argv:     ${inv.argv.join(' ')}`);
  console.log(`  started:  ${inv.startedAt}`);
  console.log(`  duration: ${inv.durationMs}ms`);
  console.log(`  exit:     ${inv.status}`);
  console.log(`  log:      ${inv.logPath}`);
  if (inv.stdout.trim()) {
    console.log(`  stdout tail:\n${indent(tail(inv.stdout))}`);
  }
  if (inv.stderr.trim()) {
    console.log(`  stderr tail:\n${indent(tail(inv.stderr))}`);
  }
  const matches = scanForKnownErrors(inv.stdout + '\n' + inv.stderr);
  if (matches.length > 0) {
    console.log('  matched error patterns:');
    for (const m of matches) {
      console.log(`    • ${m.name}`);
      console.log(`      ${m.explanation}`);
    }
  }
}

function indent(s: string, prefix = '    '): string {
  return s
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
}

// ── Assertions ───────────────────────────────────────────────

let failures = 0;
function check(label: string, ok: boolean, detail?: string): boolean {
  if (ok) {
    console.log(`  ✅ ${label}`);
  } else {
    failures++;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
    logFailureNote(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
  }
  return ok;
}

// ── Environment snapshot ─────────────────────────────────────

function dumpEnvironment(): void {
  console.log('── Environment ──');
  console.log(`  node:         ${process.version}`);
  console.log(`  platform:     ${platform()} ${release()}`);
  console.log(`  cwd:          ${process.cwd()}`);
  console.log(`  CLI entry:    ${CLI_ENTRY}`);
  console.log(`  sandbox:      ${sandbox}`);
  console.log(`  XDG_CONFIG_HOME (child): ${xdgConfig}`);
  console.log(`  XDG_DATA_HOME (child):   ${xdgData}`);

  const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];
  const proxies = proxyKeys
    .filter((k) => process.env[k])
    .map((k) => `${k}=${process.env[k]}`);
  console.log(`  proxies:      ${proxies.length ? proxies.join(', ') : '(none set)'}`);

  // Flag (don't read) whether the developer has real auth on this machine —
  // useful when triaging "the test passed for me but fails in CI", or
  // "Google returned no refresh_token because I'd already consented".
  const realAuth = join(homedir(), '.local', 'share', 'codocs', 'auth.json');
  const realGhAuth = join(homedir(), '.local', 'share', 'codocs', 'github-auth.json');
  console.log(`  real Google auth exists:  ${existsSync(realAuth)}  (${realAuth})`);
  console.log(`  real GitHub auth exists:  ${existsSync(realGhAuth)}  (${realGhAuth})`);
  console.log('');
}

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n── codocs auth e2e ──\n`);
  dumpEnvironment();

  console.log('── Network preflight (HEAD with 5s timeout) ──');
  const reach = await networkPreflight();
  for (const r of reach) {
    const tag = r.ok ? '✅' : '⚠️ ';
    const detail = r.ok ? `status=${r.status}` : `error=${r.error}`;
    console.log(`  ${tag} ${r.url}  (${detail}, ${r.ms}ms)`);
  }
  const allReachable = reach.every((r) => r.ok);
  if (!allReachable) {
    logFailureNote(
      'Network preflight saw at least one unreachable OAuth endpoint. ' +
        'A login failure later is likely connectivity-related.',
    );
  }
  console.log('');

  console.log('── Phase 1: auth is unset before login ──');
  check('no Google auth.json at start', !existsSync(tokensPath), tokensPath);
  check(
    'no GitHub github-auth.json at start',
    !existsSync(githubTokensPath),
    githubTokensPath,
  );

  console.log('\n── Phase 2: `codocs login` (interactive) ──');
  if (skipGitHub) {
    console.log('  --skip-github passed: child runs `codocs login --skip-github`, no GitHub prompt.');
  } else {
    console.log('  When prompted "Connect GitHub? (Y/n)", press Y so both halves run.');
  }
  console.log('');

  const loginArgs = skipGitHub ? ['login', '--skip-github'] : ['login'];
  let loginInv: CliInvocation;
  try {
    loginInv = await runCli('login', loginArgs);
  } catch (err: any) {
    failures++;
    console.log(`  ❌ spawn failed: ${err.stack ?? err.message ?? err}`);
    return;
  }
  console.log('');
  check('`codocs login` exited 0', loginInv.status === 0, `exit=${loginInv.status}`);

  console.log('\n── Phase 3: tokens persisted to sandbox ──');
  const googleOk = check('Google auth.json exists', existsSync(tokensPath), tokensPath);
  if (googleOk) {
    let parsed: any = null;
    try {
      parsed = JSON.parse(readFileSync(tokensPath, 'utf-8'));
      check(
        'Google auth.json has non-empty refresh_token',
        typeof parsed.refresh_token === 'string' && parsed.refresh_token.length > 0,
        `keys=${Object.keys(parsed).join(',')}`,
      );
      check(
        'Google auth.json has non-empty access_token',
        typeof parsed.access_token === 'string' && parsed.access_token.length > 0,
        `keys=${Object.keys(parsed).join(',')}`,
      );
    } catch (err: any) {
      check('Google auth.json parses as JSON', false, err.message ?? String(err));
    }
  }

  if (!skipGitHub) {
    const ghOk = check(
      'GitHub github-auth.json exists',
      existsSync(githubTokensPath),
      githubTokensPath,
    );
    if (ghOk) {
      try {
        const gh = JSON.parse(readFileSync(githubTokensPath, 'utf-8'));
        check(
          'GitHub github-auth.json has non-empty access_token',
          typeof gh.access_token === 'string' && gh.access_token.length > 0,
          `keys=${Object.keys(gh).join(',')}`,
        );
        check(
          'GitHub github-auth.json has non-empty scope',
          typeof gh.scope === 'string' && gh.scope.length > 0,
          `scope=${JSON.stringify(gh.scope)}`,
        );
      } catch (err: any) {
        check('GitHub github-auth.json parses as JSON', false, err.message ?? String(err));
      }
    }
  }

  console.log('\n── Phase 4: `codocs auth status` reports authenticated ──');
  let statusInv: CliInvocation;
  try {
    statusInv = await runCli('status', ['auth', 'status']);
  } catch (err: any) {
    failures++;
    console.log(`  ❌ spawn failed: ${err.stack ?? err.message ?? err}`);
    return;
  }
  check('`codocs auth status` exited 0', statusInv.status === 0, `exit=${statusInv.status}`);
  const googleSection = /── Google ──[\s\S]*?(?:── GitHub ──|$)/.exec(statusInv.stdout)?.[0] ?? '';
  const githubSection = /── GitHub ──[\s\S]*$/.exec(statusInv.stdout)?.[0] ?? '';
  check(
    'status output: Google section reports Authenticated',
    /Status:\s+Authenticated/.test(googleSection),
    `Google section: ${JSON.stringify(googleSection.trim() || '(missing)')}`,
  );
  if (!skipGitHub) {
    check(
      'status output: GitHub section reports Connected',
      /Status:\s+Connected/.test(githubSection),
      `GitHub section: ${JSON.stringify(githubSection.trim() || '(missing)')}`,
    );
  }

  console.log('\n── Phase 5: `codocs auth logout` clears tokens ──');
  let logoutInv: CliInvocation;
  try {
    logoutInv = await runCli('logout', ['auth', 'logout']);
  } catch (err: any) {
    failures++;
    console.log(`  ❌ spawn failed: ${err.stack ?? err.message ?? err}`);
    return;
  }
  check('`codocs auth logout` exited 0', logoutInv.status === 0, `exit=${logoutInv.status}`);
  check('Google auth.json removed', !existsSync(tokensPath), tokensPath);
  if (!skipGitHub) {
    check('GitHub github-auth.json removed', !existsSync(githubTokensPath), githubTokensPath);
  }
}

// ── Run ──────────────────────────────────────────────────────

main()
  .catch((err) => {
    failures++;
    console.error('\nFatal:', err.stack ?? err);
  })
  .finally(() => {
    console.log(`\n── Results: ${failures === 0 ? 'PASS' : `${failures} FAIL`} ──\n`);

    if (failures > 0) {
      console.log('── Failure diagnostics ──\n');

      console.log('Failed assertions:');
      for (const note of failureLog) console.log(`  • ${note}`);
      console.log('');

      console.log('CLI invocations (full stdout/stderr in per-invocation log file):');
      for (const inv of invocations) dumpInvocation(inv);
      console.log('');

      console.log('Sandbox tree (preserved for inspection):');
      console.log(`  ${sandbox}`);
      for (const line of listSandbox()) console.log(line);
      console.log('');

      if (existsSync(tokensPath)) {
        console.log('Google auth.json (secrets truncated):');
        console.log(indent(safeReadTokens(tokensPath)));
        console.log('');
      }
      if (existsSync(githubTokensPath)) {
        console.log('GitHub github-auth.json (secrets truncated):');
        console.log(indent(safeReadTokens(githubTokensPath)));
        console.log('');
      }

      console.log('Per-invocation log files:');
      for (const inv of invocations) {
        console.log(`  ${inv.label}: ${inv.logPath}`);
      }
      console.log('');

      console.log(
        `Sandbox NOT cleaned up (failures=${failures}). Inspect ${sandbox}, ` +
          `then \`rm -rf ${sandbox}\` when done.`,
      );
    } else {
      try {
        rmSync(sandbox, { recursive: true, force: true });
      } catch (err: any) {
        console.log(`(sandbox cleanup failed: ${err.message ?? err})`);
      }
    }

    process.exit(failures === 0 ? 0 : 1);
  });
