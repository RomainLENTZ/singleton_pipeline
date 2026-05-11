import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createShell, C } from '../shell.js';
import { scanAgents } from '../scanner.js';
import { runPipeline } from '../executor.js';
import { newAgentShellCommand } from './new.js';
import { loadProjectSecurityConfig } from '../security/policy.js';

const PIPELINES_DIRS = ['.singleton/pipelines'];

const HELP = [
  '',
  `{bold}Commands{/}`,
  '',
  `  {${C.violet}-fg}/run <name>{/}               run a pipeline`,
  `  {${C.violet}-fg}/run <name> --dry{/}         dry-run (plan without API calls)`,
  `  {${C.violet}-fg}/run <name> --verbose{/}     show prompts and outputs`,
  `  {${C.violet}-fg}/run <name> --debug{/}       pause before each step`,
  `  {${C.blue}-fg}/scan{/}                     scan .md agents`,
  `  {${C.blue}-fg}/new{/}                      create a new agent`,
  `  {${C.blue}-fg}/serve{/}                    start the web server`,
  `  {${C.blue}-fg}/stop{/}                     stop the web server`,
  `  {${C.blue}-fg}/commit-last{/}              commit deliverables from the last run`,
  `  {${C.pink}-fg}/ls{/}                       list pipelines`,
  `  {${C.pink}-fg}/help{/}                     show help`,
  `  {${C.pink}-fg}/quit{/}                     quit  {${C.dimV}-fg}(or Ctrl+C){/}`,
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

// Violet → peach gradient (4 interpolated steps)
const SINGLETON_GRAD = ['#C084FC', '#D499E8', '#EBB0D8', '#F9A8D4'];

// Gradient by column position so all rows share the same color mapping
function gradientLine(text, totalWidth, colors = SINGLETON_GRAD) {
  return text.split('').map((ch, i) => {
    if (ch === ' ') return ch;
    const color = colors[Math.min(Math.floor((i / totalWidth) * colors.length), colors.length - 1)];
    return `{${color}-fg}${ch}{/}`;
  }).join('');
}

function plainBrightLine(text) {
  return text.split('').map((ch) => (ch === ' ' ? ch : `{#FFFFFF-fg}${ch}{/}`)).join('');
}

const SINGLETON_RAW = [
  '▄█████ ▄▄ ▄▄  ▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄▄▄ ▄▄▄  ▄▄  ▄▄ ',
  '▀▀▀▄▄▄ ██ ███▄██ ██ ▄▄ ██     ▄▄██   ██  ██▀██ ███▄██ ',
  '█████▀ ██ ██ ▀██ ▀███▀ ██▄▄▄ ▄▄▄██   ██  ▀███▀ ██ ▀██ ',
];

const ART_WIDTH = Math.max(...SINGLETON_RAW.map((l) => l.length));
const APP_VERSION = 'v0.4.0-beta.0';

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
    `${dateStr}  ${timeStr}  {${C.ghost}-fg}${APP_VERSION}{/}`,
    '',
    `${pipelines.length} pipeline${pipelines.length !== 1 ? 's' : ''}`,
    `${agentCount} agent${agentCount !== 1 ? 's' : ''}`,
    '',
    `{${C.peach}-fg}{bold}New{/} {#FFFFFF-fg}you can now debug pipeline runs{/}`,
    `{${C.ghost}-fg}·{/} {${C.mint}-fg}pause steps{/}  {${C.ghost}-fg}·{/} {${C.blue}-fg}inspect prompts{/}  {${C.ghost}-fg}·{/} {${C.peach}-fg}edit inputs{/}  {${C.ghost}-fg}·{/} {${C.violet}-fg}review diffs{/}`,
    `{${C.peach}-fg}{bold}New{/} {#FFFFFF-fg}Copilot runner support{/}`,
    `{${C.ghost}-fg}·{/} {${C.mint}-fg}provider copilot{/}  {${C.ghost}-fg}·{/} {${C.blue}-fg}runner_agent optional{/}  {${C.ghost}-fg}·{/} {${C.peach}-fg}native tool permissions{/}`,
    `{${C.peach}-fg}{bold}New{/} {#FFFFFF-fg}experimental OpenCode runner support{/}`,
    `{${C.ghost}-fg}·{/} {${C.mint}-fg}provider opencode{/}  {${C.ghost}-fg}·{/} {${C.blue}-fg}runner_agent optional{/}  {${C.ghost}-fg}·{/} {${C.peach}-fg}post-run security{/}`,
    '',
  ];
  const TAGLINE  = 'one to rule them all';
  const CREDIT = 'Developed by Romain LENTZ';
  const bottomBlockHeight = 3 + SINGLETON_RAW.length;
  const spacerLines = Math.max(0, contentHeight - headerLines.length - bottomBlockHeight);

  // Track shimmer positions.
  const welcomeRow = CONTENT_PAD_TOP + 2;
  const creditRow = CONTENT_PAD_TOP + headerLines.length + spacerLines;
  const taglineRow = creditRow + 1;

  for (const line of headerLines) {
    shell.log(line);
  }
  for (let i = 0; i < spacerLines; i += 1) {
    shell.log('');
  }

  shell.log(`{${C.dimV}-fg}${CREDIT}{/}`);
  shell.log(' '.repeat(TAGLINE.length));
  shell.log('');
  for (const line of SINGLETON_RAW) {
    shell.log(plainBrightLine(line));
  }

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
          shell.log('{#676498-fg}See you soon.{/}');
          setTimeout(() => { shell.destroy(); process.exit(0); }, 300);
          return;
        default:
          shell.log(`{${C.peach}-fg}!{/} Unknown command: {bold}${cmd}{/}  — type /help`);
      }
    } catch (err) {
      shell.log(`{${C.salmon}-fg}✕{/} ${err.message}`);
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
      shell.log(`{${C.peach}-fg}!{/} No pipelines found.`);
      return;
    }
    shell.log(`{${C.dimV}-fg}  Pipelines: ${pipelines.join(', ')}{/}`);
    shell.log(`{${C.dimV}-fg}  Usage: /run <name> [--dry] [--verbose] [--debug]{/}`);
    return;
  }

  const filePath = await resolvePipelinePath(name, root);
  if (!filePath) {
    shell.log(`{${C.salmon}-fg}✕{/} Pipeline "{bold}${name}{/}" not found.`);
    const pipelines = await listPipelines(root);
    if (pipelines.length) shell.log(`{${C.dimV}-fg}  Available: ${pipelines.join(', ')}{/}`);
    return;
  }

  await runPipeline(filePath, { dryRun: dry, verbose, debug, shell });
}

async function cmdLs(root, shell) {
  const pipelines = await listPipelines(root);
  if (pipelines.length === 0) {
    shell.log('{yellow-fg}!{/} No pipelines found.');
    return;
  }
  shell.log(`{bold}Pipelines (${pipelines.length}){/}`);
  shell.log('');
  for (const p of pipelines) shell.log(`  {${C.dimV}-fg}·{/} {${C.pink}-fg}${p}{/}`);
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
  shell.log(`{${C.dimV}-fg}Scanning ${root}…{/}`);
  const agents = await scanAgents(root);
  if (agents.length === 0) {
    shell.log(`{${C.peach}-fg}!{/} No agents found (no .md files with ## Config).`);
    return;
  }
  shell.log(`{bold}Agents (${agents.length}){/}`);
  shell.log('');
  const groups = groupAgentsByProvider(agents);
  [...groups.entries()].forEach(([provider, providerAgents]) => {
    shell.log(`  {${C.dimV}-fg}════════════════════════════════════════{/}`);
    shell.log(`  {bold}${provider}{/} {${C.dimV}-fg}(${providerAgents.length}){/}`);
    shell.log(`  {${C.dimV}-fg}════════════════════════════════════════{/}`);
    shell.log('');

    providerAgents.forEach((a, index) => {
      shell.log(`    {${C.violet}-fg}{bold}${a.id}{/}  {${C.dimV}-fg}${a.description || '(no description)'}{/}`);
      shell.log(`    {${C.blue}-fg}{bold}source{/}: {${C.dimV}-fg}${a.source || 'repo'}{/}${a.permission_mode ? `   {${C.peach}-fg}{bold}permission{/}: {${C.dimV}-fg}${a.permission_mode}{/}` : ''}`);
      shell.log(`    {${C.mint}-fg}{bold}in{/}: {${C.dimV}-fg}${a.inputs.join(', ') || '—'}{/}   {${C.pink}-fg}{bold}out{/}: {${C.dimV}-fg}${a.outputs.join(', ') || '—'}{/}`);
      if (index < providerAgents.length - 1) shell.log(`    {${C.dimV}-fg}──────────────────────────────────────{/}`);
    });
    shell.log('');
  });
  const outPath = path.resolve(root, '.singleton', 'agents.json');
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify({ scannedAt: new Date().toISOString(), root, agents }, null, 2));
  shell.log('');
  shell.log(`{${C.mint}-fg}✓{/} Cache → .singleton/agents.json`);
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
    shell.log(`{${C.peach}-fg}!{/} The server is already running on {${C.blue}-fg}${serveState.url}{/}.`);
    return;
  }
  const { startServer } = await import('../../../server/src/index.js');
  const serverUrl = 'http://localhost:4317';
  shell.log('{#676498-fg}Starting server… (/stop to stop){/}');
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
        shell.log(`{#FFFFFF-fg}{bold}${prefix}{/}{${C.blue}-fg}${url}{/}{${C.dimV}-fg}${suffix}{/}`);
        return;
      }
      shell.log(`{${C.dimV}-fg}${message}{/}`);
    },
  });
  serveState.server = server;
  serveState.url = serverUrl;
  server.on('close', () => {
    const shouldLog = !serveState.suppressCloseLog;
    serveState.clear();
    if (shouldLog) shell.log(`{${C.dimV}-fg}Serve stopped.{/}`);
  });
  shell.setFooterCenter(
    `{${C.dimV}-fg}serve running{/} {${C.blue}-fg}${serverUrl}{/}`
  );
}

async function cmdStop(shell, serveState) {
  if (!serveState.server) {
    shell.log(`{${C.peach}-fg}!{/} No running server.`);
    return;
  }
  const url = serveState.url;
  const server = serveState.server;
  serveState.suppressCloseLog = true;
  serveState.server = null;
  serveState.url = '';
  shell.setFooterCenter('');
  await closeServer(server);
  shell.log(`{${C.mint}-fg}✓{/} Serve stopped {${C.dimV}-fg}${url}{/}`);
}

async function cmdCommitLast(root, shell) {
  let manifest;
  try {
    manifest = await loadLastRunManifest(root);
  } catch {
    shell.log(`{${C.peach}-fg}!{/} No usable latest run found in .singleton/runs/latest.`);
    return;
  }

  let securityConfig;
  try {
    securityConfig = await loadProjectSecurityConfig(root);
  } catch (err) {
    shell.log(`{${C.salmon}-fg}✕{/} ${err.message}`);
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
    shell.log(`{${C.peach}-fg}!{/} The last run produced no deliverables to commit.`);
    if (excluded.length) {
      shell.log(`{${C.dimV}-fg}All deliverables were excluded by .singleton/security.json commit rules.{/}`);
    }
    return;
  }

  try {
    await runCommand('git', ['rev-parse', '--show-toplevel'], { cwd: root });
  } catch {
    shell.log(`{${C.salmon}-fg}✕{/} This project is not inside a Git repository.`);
    return;
  }

  shell.log(`{bold}Commit last preview{/}  {${C.dimV}-fg}${manifest.pipeline || 'unknown pipeline'}{/}`);
  shell.log('');
  shell.log(`{${C.blue}-fg}Files to stage{/}`);
  for (const file of files) shell.log(`  {${C.dimV}-fg}·{/} ${file.path}`);
  if (excluded.length) {
    shell.log('');
    shell.log(`{${C.peach}-fg}Excluded by security config{/}`);
    for (const { file, excludedBy } of excluded) shell.log(`  {${C.dimV}-fg}·{/} ${file.path} {${C.dimV}-fg}(${excludedBy}){/}`);
  }
  shell.log('');
  shell.log(`{${C.dimV}-fg}.singleton artifacts are not committed by /commit-last.{/}`);
  shell.log('');

  if (securityConfig.commit.requireConfirmation) {
    const confirmation = (await shell.prompt('Stage and commit these files? (y/N)')).trim().toLowerCase();
    if (confirmation !== 'y' && confirmation !== 'yes') {
      shell.log(`{${C.peach}-fg}!{/} Commit cancelled.`);
      return;
    }
  }

  const defaultMessage = `Update files from ${manifest.pipeline || 'last pipeline'}`;
  const message = (await shell.prompt(`Commit message (default: ${defaultMessage})`)).trim() || defaultMessage;

  const relFiles = files.map((file) => file.path);
  await runCommand('git', ['add', '--', ...relFiles], { cwd: root });
  await runCommand('git', ['commit', '-m', message], { cwd: root });

  shell.log(`{${C.mint}-fg}✓{/} Commit created: {${C.dimV}-fg}${message}{/}`);
}
