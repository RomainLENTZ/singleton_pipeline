import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createShell, S } from '../shell.js';
import { scanAgents } from '../scanner.js';
import { runPipeline } from '../executor.js';
import { newAgentShellCommand } from './new.js';
import { loadProjectSecurityConfig } from '../security/policy.js';

const PIPELINES_DIRS = ['.singleton/pipelines'];

const HELP = [
  '',
  `{bold}Commands{/}`,
  '',
  `  {${S.accent}-fg}{bold}/run <name>{/}               run a pipeline`,
  `  {${S.accent}-fg}{bold}/run <name> --dry{/}         dry-run (plan without API calls)`,
  `  {${S.accent}-fg}{bold}/run <name> --verbose{/}     show prompts and outputs`,
  `  {${S.accent}-fg}{bold}/run <name> --debug{/}       pause before each step`,
  `  {${S.accent}-fg}{bold}/scan{/}                     scan .md agents`,
  `  {${S.accent}-fg}{bold}/new{/}                      create a new agent`,
  `  {${S.accent}-fg}{bold}/serve{/}                    start the web server`,
  `  {${S.accent}-fg}{bold}/stop{/}                     stop the web server`,
  `  {${S.accent}-fg}{bold}/commit-last{/}              commit deliverables from the last run`,
  `  {${S.accent}-fg}{bold}/ls{/}                       list pipelines`,
  `  {${S.accent}-fg}{bold}/help{/}                     show help`,
  `  {${S.accent}-fg}{bold}/quit{/}                     quit  {${S.muted}-fg}(or Ctrl+C){/}`,
  '',
].join('\n');

const COMMANDS = [
  { label: '/run', value: '/run ', description: 'run a pipeline' },
  { label: '/scan', value: '/scan ', description: 'scan .md agents' },
  { label: '/new', value: '/new ', description: 'create a new agent' },
  { label: '/serve', value: '/serve ', description: 'start the web server' },
  { label: '/stop', value: '/stop', description: 'stop the web server' },
  { label: '/commit-last', value: '/commit-last', description: 'commit the last run' },
  { label: '/ls', value: '/ls', description: 'list pipelines' },
  { label: '/help', value: '/help', description: 'show help' },
  { label: '/quit', value: '/quit', description: 'quit' },
];

const RUN_FLAGS = [
  { label: '--dry', description: 'plan without API calls' },
  { label: '--verbose', description: 'show prompts and outputs' },
  { label: '--debug', description: 'pause before each step' },
  { label: '-v', description: 'alias for --verbose' },
];

async function listPipelines(root) {
  const names = [];
  for (const dir of PIPELINES_DIRS) {
    try {
      const files = (await fs.readdir(path.resolve(root, dir)))
        .filter((f) => f.endsWith('.json') && f !== 'agents.json');
      names.push(...files.map((f) => f.replace(/\.json$/, '')));
    } catch { /* dir doesn't exist */ }
  }
  return [...new Set(names)];
}

async function resolvePipelinePath(name, root) {
  const candidates = [
    ...PIPELINES_DIRS.map((d) => path.resolve(root, d, `${name}.json`)),
    path.resolve(root, `${name}.json`),
    path.resolve(name),
  ];
  for (const c of candidates) {
    try { await fs.access(c); return c; } catch { /* skip */ }
  }
  return null;
}

function runCommand(cmd, args, { cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `${cmd} exited ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function loadLastRunManifest(root) {
  const latestDir = path.join(root, '.singleton', 'runs', 'latest');
  const manifestPath = path.join(latestDir, 'run-manifest.json');
  const raw = await fs.readFile(manifestPath, 'utf8');
  return JSON.parse(raw);
}

function splitInput(buffer) {
  const leadingTrimmed = buffer.trimStart();
  const parts = leadingTrimmed.length ? leadingTrimmed.split(/\s+/) : [];
  const endsWithSpace = /\s$/.test(buffer);
  const current = endsWithSpace ? '' : (parts.at(-1) || '');
  return { parts, current, endsWithSpace };
}

function replaceCurrentToken(buffer, replacement) {
  if (/\s$/.test(buffer)) return `${buffer}${replacement}`;
  const idx = buffer.search(/\S+$/);
  if (idx === -1) return replacement;
  return `${buffer.slice(0, idx)}${replacement}`;
}

function matchesPrefix(value, prefix) {
  return value.toLowerCase().startsWith(prefix.toLowerCase());
}

function matchesCommitExclude(relPath, pattern) {
  const rel = String(relPath || '').replaceAll('\\', '/').replace(/^\/+/, '');
  const pat = String(pattern || '').replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '');
  return pat && (rel === pat || rel.startsWith(`${pat}/`));
}

async function completeRepl(buffer, root) {
  const { parts, current } = splitInput(buffer);

  if (parts.length <= 1 && !/\s$/.test(buffer)) {
    return COMMANDS
      .filter((cmd) => matchesPrefix(cmd.label, current || buffer.trim()))
      .map((cmd) => ({ ...cmd, value: cmd.value }));
  }

  const cmd = parts[0];

  if (cmd === '/run') {
    const args = parts.slice(1).filter(Boolean);
    const used = new Set(args);
    const hasPipelineArg = args.some((arg) => !arg.startsWith('-'));
    const pipelines = await listPipelines(root);
    const pipelineItems = pipelines
      .filter((name) => !current || matchesPrefix(name, current))
      .map((name) => ({
        label: name,
        value: replaceCurrentToken(buffer, name),
        description: 'pipeline',
      }));

    const flagItems = RUN_FLAGS
      .filter((flag) => !used.has(flag.label))
      .filter((flag) => !current || matchesPrefix(flag.label, current))
      .map((flag) => ({
        label: flag.label,
        value: replaceCurrentToken(buffer, flag.label),
        description: flag.description,
      }));

    if (hasPipelineArg && current === '') return flagItems;

    return current.startsWith('--') || current.startsWith('-')
      ? flagItems
      : [...pipelineItems, ...flagItems];
  }

  return [];
}

// Strip blessed tags to get the visible string length.
function tw(s) { return s.replace(/\{[^}]+\}/g, '').length; }

function layoutRow(left, right, width) {
  const spaces = Math.max(2, width - tw(left) - tw(right));
  return left + ' '.repeat(spaces) + right;
}

async function countAgents(root) {
  try {
    const raw = await fs.readFile(path.resolve(root, '.singleton', 'agents.json'), 'utf8');
    return JSON.parse(raw).agents?.length ?? 0;
  } catch { return 0; }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = path.join(__dirname, '..', 'assets', 'singleton-logo.txt');
function loadLogoLines() {
  try {
    const raw = fsSync.readFileSync(LOGO_PATH, 'utf8');
    return raw
      .replace(/\x1b\[\?25[lh]/g, '')
      .split('\n')
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

const SINGLETON_LOGO = loadLogoLines();
const APP_VERSION = 'v0.4.0-beta.12';

async function showWelcome(root, shell) {
  const now     = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

  const [pipelines, agentCount] = await Promise.all([
    listPipelines(root),
    countAgents(root),
  ]);

  const CONTENT_PAD_LEFT = 2;
  const CONTENT_PAD_TOP  = 1;
  const contentHeight = Math.max(12, (shell.screen.height ?? 24) - 4);
  const headerLines = [
    '',
    ' '.repeat(tw('Welcome back')),
    `${dateStr}  ${timeStr}  {${S.muted}-fg}${APP_VERSION}{/}`,
    '',
    `${pipelines.length} pipeline${pipelines.length !== 1 ? 's' : ''}`,
    `${agentCount} agent${agentCount !== 1 ? 's' : ''}`,
    '',
    `{${S.warning}-fg}{bold}New{/} {${S.text}-fg}redesigned /new agent flow{/}`,
    `{${S.subtle}-fg}·{/} {${S.keyword}-fg}sectioned form{/}  {${S.subtle}-fg}·{/} {${S.keyword}-fg}field autocomplete{/}  {${S.subtle}-fg}·{/} {${S.keyword}-fg}review + :back{/}`,
    `{${S.warning}-fg}{bold}New{/} {${S.text}-fg}safer replay and prompt inputs{/}`,
    `{${S.subtle}-fg}·{/} {${S.keyword}-fg}snapshot restore{/}  {${S.subtle}-fg}·{/} {${S.keyword}-fg}escaped user XML{/}  {${S.subtle}-fg}·{/} {${S.keyword}-fg}loud rollback limits{/}`,
    `{${S.warning}-fg}{bold}New{/} {${S.text}-fg}cleaner run UI and output{/}`,
    `{${S.subtle}-fg}·{/} {${S.keyword}-fg}framed logs{/}  {${S.subtle}-fg}·{/} {${S.keyword}-fg}step reviews{/}  {${S.subtle}-fg}·{/} {${S.keyword}-fg}final Copilot output{/}`,
    '',
  ];
  const TAGLINE  = 'one to rule them all';
  const CREDIT = 'Developed by Romain LENTZ';
  const bottomBlockHeight = 3 + SINGLETON_LOGO.length;
  const spacerLines = Math.max(0, contentHeight - headerLines.length - bottomBlockHeight);

  // Track shimmer positions.
  const welcomeRow = CONTENT_PAD_TOP + 2;
  const creditRow = CONTENT_PAD_TOP + headerLines.length + spacerLines + SINGLETON_LOGO.length;
  const taglineRow = creditRow + 1;

  for (const line of headerLines) {
    shell.log(line);
  }
  for (let i = 0; i < spacerLines; i += 1) {
    shell.log('');
  }

  for (const logoLine of SINGLETON_LOGO) {
    shell.log(logoLine);
  }

  shell.log(`{${S.muted}-fg}${CREDIT}{/}`);
  shell.log(' '.repeat(TAGLINE.length));
  shell.log('');

  const stopWelcome = shell.createShimmer('Welcome back', welcomeRow, CONTENT_PAD_LEFT);
  const stopTagline = shell.createShimmer(TAGLINE, taglineRow, CONTENT_PAD_LEFT);

  return () => { stopWelcome(); stopTagline(); };
}

async function refreshFooter(root, shell) {
  const [pipelines, agentCount] = await Promise.all([
    listPipelines(root),
    countAgents(root),
  ]);
  shell.setFooter(
    `${agentCount} agent${agentCount !== 1 ? 's' : ''}  /scan to refresh`,
    `${pipelines.length} pipeline${pipelines.length !== 1 ? 's' : ''}`
  );
}

function createServeState(shell) {
  return {
    server: null,
    url: '',
    suppressCloseLog: false,
    clear() {
      this.server = null;
      this.url = '';
      this.suppressCloseLog = false;
      shell.setFooterCenter('');
    },
  };
}

export async function replCommand(opts) {
  const root  = path.resolve(opts.root || process.cwd());
  const shell = createShell();
  const serveState = createServeState(shell);

  let stopShimmer = await showWelcome(root, shell);
  await refreshFooter(root, shell);

  shell.setCompleter(({ buffer }) => completeRepl(buffer, root));

  shell.onCommand(async (raw) => {
    if (stopShimmer) { stopShimmer(); stopShimmer = null; shell.clear(); }
    const [cmd, ...args] = raw.trim().split(/\s+/);
    shell.disableInput();
    try {
      switch (cmd) {
        case '/run':   await cmdRun(args, root, shell); break;
        case '/ls':    await cmdLs(root, shell); break;
        case '/scan':  await cmdScan(root, shell); await refreshFooter(root, shell); break;
        case '/new':   await cmdNew(root, shell); await refreshFooter(root, shell); break;
        case '/serve': await cmdServe(root, shell, serveState); break;
        case '/stop':  await cmdStop(shell, serveState); break;
        case '/commit-last': await cmdCommitLast(root, shell); break;
        case '/help':  shell.log(HELP); break;
        case '/quit':
        case '/exit':
          if (serveState.server) {
            await closeServer(serveState.server);
            serveState.clear();
          }
          shell.log(`{${S.muted}-fg}See you soon.{/}`);
          setTimeout(() => { shell.destroy(); process.exit(0); }, 300);
          return;
        default:
          shell.log(`{${S.warning}-fg}!{/} Unknown command: {bold}${cmd}{/}  — type /help`);
      }
    } catch (err) {
      // Safety: if a command (typically /run) threw before resetting the border, reflect the error.
      shell.setMode?.('error');
      shell.log(`{${S.error}-fg}✕{/} ${err.message}`);
    }
    shell.enableInput();
  });
}

async function cmdRun(args, root, shell) {
  const dry     = args.includes('--dry');
  const verbose = args.includes('--verbose') || args.includes('-v');
  const debug   = args.includes('--debug');
  const name    = args.filter((a) => !['--dry', '--verbose', '--debug', '-v'].includes(a))[0];

  if (!name) {
    const pipelines = await listPipelines(root);
    if (pipelines.length === 0) {
      shell.log(`{${S.warning}-fg}!{/} No pipelines found.`);
      return;
    }
    shell.log(`{${S.muted}-fg}  Pipelines: ${pipelines.join(', ')}{/}`);
    shell.log(`{${S.muted}-fg}  Usage: /run <name> [--dry] [--verbose] [--debug]{/}`);
    return;
  }

  const filePath = await resolvePipelinePath(name, root);
  if (!filePath) {
    shell.log(`{${S.error}-fg}✕{/} Pipeline "{bold}${name}{/}" not found.`);
    const pipelines = await listPipelines(root);
    if (pipelines.length) shell.log(`{${S.muted}-fg}  Available: ${pipelines.join(', ')}{/}`);
    return;
  }

  await runPipeline(filePath, { dryRun: dry, verbose, debug, shell });
}

async function cmdLs(root, shell) {
  const pipelines = await listPipelines(root);
  if (pipelines.length === 0) {
    shell.log(`{${S.warning}-fg}!{/} No pipelines found.`);
    return;
  }
  shell.log(`{bold}Pipelines (${pipelines.length}){/}`);
  shell.log('');
  for (const p of pipelines) shell.log(`  {${S.subtle}-fg}·{/} {${S.string}-fg}${p}{/}`);
  shell.log('');
}

function groupAgentsByProvider(agents) {
  return agents.reduce((groups, agent) => {
    const provider = agent.provider || 'unknown';
    if (!groups.has(provider)) groups.set(provider, []);
    groups.get(provider).push(agent);
    return groups;
  }, new Map());
}

async function cmdScan(root, shell) {
  shell.log(`{${S.muted}-fg}Scanning ${root}…{/}`);
  const agents = await scanAgents(root);
  if (agents.length === 0) {
    shell.log(`{${S.warning}-fg}!{/} No agents found (no .md files with ## Config).`);
    return;
  }
  shell.log(`{bold}Agents (${agents.length}){/}`);
  shell.log('');
  const groups = groupAgentsByProvider(agents);
  [...groups.entries()].forEach(([provider, providerAgents]) => {
    shell.log(`  {${S.muted}-fg}════════════════════════════════════════{/}`);
    shell.log(`  {bold}${provider}{/} {${S.muted}-fg}(${providerAgents.length}){/}`);
    shell.log(`  {${S.muted}-fg}════════════════════════════════════════{/}`);
    shell.log('');

    providerAgents.forEach((a, index) => {
      shell.log(`    {${S.accent}-fg}{bold}${a.id}{/}  {${S.muted}-fg}${a.description || '(no description)'}{/}`);
      shell.log(`    {${S.keyword}-fg}{bold}source{/}: {${S.text}-fg}${a.source || 'repo'}{/}${a.permission_mode ? `   {${S.keyword}-fg}{bold}permission{/}: {${S.text}-fg}${a.permission_mode}{/}` : ''}`);
      shell.log(`    {${S.keyword}-fg}{bold}in{/}: {${S.text}-fg}${a.inputs.join(', ') || '—'}{/}   {${S.keyword}-fg}{bold}out{/}: {${S.text}-fg}${a.outputs.join(', ') || '—'}{/}`);
      if (index < providerAgents.length - 1) shell.log(`    {${S.muted}-fg}──────────────────────────────────────{/}`);
    });
    shell.log('');
  });
  const outPath = path.resolve(root, '.singleton', 'agents.json');
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify({ scannedAt: new Date().toISOString(), root, agents }, null, 2));
  shell.log('');
  shell.log(`{${S.success}-fg}✓{/} Cache → {${S.string}-fg}.singleton/agents.json{/}`);
}

async function cmdNew(root, shell) {
  await newAgentShellCommand({ root, shell });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function cmdServe(root, shell, serveState) {
  if (serveState.server) {
    shell.log(`{${S.warning}-fg}!{/} The server is already running on {${S.string}-fg}${serveState.url}{/}.`);
    return;
  }
  const { startServer } = await import('../../../server/src/index.js');
  const serverUrl = 'http://localhost:4317';
  shell.log(`{${S.muted}-fg}Starting server… (/stop to stop){/}`);
  shell.enableInput();
  const server = await startServer({
    port: 4317,
    root,
    logger: (message) => {
      const urlMatch = String(message).match(/https?:\/\/\S+/);
      if (urlMatch) {
        const url = urlMatch[0];
        const prefix = message.slice(0, urlMatch.index);
        const suffix = message.slice(urlMatch.index + url.length);
        shell.log(`{${S.text}-fg}{bold}${prefix}{/}{${S.string}-fg}${url}{/}{${S.muted}-fg}${suffix}{/}`);
        return;
      }
      shell.log(`{${S.muted}-fg}${message}{/}`);
    },
  });
  serveState.server = server;
  serveState.url = serverUrl;
  server.on('close', () => {
    const shouldLog = !serveState.suppressCloseLog;
    serveState.clear();
    if (shouldLog) shell.log(`{${S.muted}-fg}Serve stopped.{/}`);
  });
  shell.setFooterCenter(
    `{${S.muted}-fg}serve running{/} {${S.string}-fg}${serverUrl}{/}`
  );
}

async function cmdStop(shell, serveState) {
  if (!serveState.server) {
    shell.log(`{${S.warning}-fg}!{/} No running server.`);
    return;
  }
  const url = serveState.url;
  const server = serveState.server;
  serveState.suppressCloseLog = true;
  serveState.server = null;
  serveState.url = '';
  shell.setFooterCenter('');
  await closeServer(server);
  shell.log(`{${S.success}-fg}✓{/} Serve stopped {${S.string}-fg}${url}{/}`);
}

async function cmdCommitLast(root, shell) {
  let manifest;
  try {
    manifest = await loadLastRunManifest(root);
  } catch {
    shell.log(`{${S.warning}-fg}!{/} No usable latest run found in .singleton/runs/latest.`);
    return;
  }

  let securityConfig;
  try {
    securityConfig = await loadProjectSecurityConfig(root);
  } catch (err) {
    shell.log(`{${S.error}-fg}✕{/} ${err.message}`);
    return;
  }

  const excluded = [];
  const files = (Array.isArray(manifest.deliverables) ? manifest.deliverables : []).filter((file) => {
    const excludedBy = securityConfig.commit.excludePaths.find((pattern) => matchesCommitExclude(file.path, pattern));
    if (excludedBy) {
      excluded.push({ file, excludedBy });
      return false;
    }
    return true;
  });
  if (files.length === 0) {
    shell.log(`{${S.warning}-fg}!{/} The last run produced no deliverables to commit.`);
    if (excluded.length) {
      shell.log(`{${S.muted}-fg}All deliverables were excluded by .singleton/security.json commit rules.{/}`);
    }
    return;
  }

  try {
    await runCommand('git', ['rev-parse', '--show-toplevel'], { cwd: root });
  } catch {
    shell.log(`{${S.error}-fg}✕{/} This project is not inside a Git repository.`);
    return;
  }

  shell.log(`{bold}Commit last preview{/}  {${S.muted}-fg}${manifest.pipeline || 'unknown pipeline'}{/}`);
  shell.log('');
  shell.log(`{${S.keyword}-fg}Files to stage{/}`);
  for (const file of files) shell.log(`  {${S.subtle}-fg}·{/} {${S.string}-fg}${file.path}{/}`);
  if (excluded.length) {
    shell.log('');
    shell.log(`{${S.warning}-fg}Excluded by security config{/}`);
    for (const { file, excludedBy } of excluded) shell.log(`  {${S.subtle}-fg}·{/} {${S.string}-fg}${file.path}{/} {${S.muted}-fg}(${excludedBy}){/}`);
  }
  shell.log('');
  shell.log(`{${S.muted}-fg}.singleton artifacts are not committed by /commit-last.{/}`);
  shell.log('');

  if (securityConfig.commit.requireConfirmation) {
    const confirmation = (await shell.prompt('Stage and commit these files? (y/N)')).trim().toLowerCase();
    if (confirmation !== 'y' && confirmation !== 'yes') {
      shell.log(`{${S.warning}-fg}!{/} Commit cancelled.`);
      return;
    }
  }

  const defaultMessage = `Update files from ${manifest.pipeline || 'last pipeline'}`;
  const message = (await shell.prompt(`Commit message (default: ${defaultMessage})`)).trim() || defaultMessage;

  const relFiles = files.map((file) => file.path);
  await runCommand('git', ['add', '--', ...relFiles], { cwd: root });
  await runCommand('git', ['commit', '-m', message], { cwd: root });

  shell.log(`{${S.success}-fg}✓{/} Commit created: {${S.string}-fg}${message}{/}`);
}
