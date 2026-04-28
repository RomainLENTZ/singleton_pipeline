import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createShell, C } from '../shell.js';
import { scanAgents } from '../scanner.js';
import { runPipeline } from '../executor.js';
import { newAgentShellCommand } from './new.js';

const PIPELINES_DIRS = ['.singleton/pipelines'];

const HELP = [
  '',
  `{bold}Commandes{/}`,
  '',
  `  {${C.violet}-fg}/run <name>{/}               exécuter une pipeline`,
  `  {${C.violet}-fg}/run <name> --dry{/}         dry-run (plan sans appel API)`,
  `  {${C.violet}-fg}/run <name> --verbose{/}     afficher prompts et outputs`,
  `  {${C.blue}-fg}/scan{/}                     scanner les agents .md`,
  `  {${C.blue}-fg}/new{/}                      créer un nouvel agent`,
  `  {${C.blue}-fg}/serve{/}                    démarrer le serveur web`,
  `  {${C.blue}-fg}/stop{/}                     arrêter le serveur web`,
  `  {${C.blue}-fg}/commit-last{/}              commit les livrables du dernier run`,
  `  {${C.pink}-fg}/ls{/}                       lister les pipelines`,
  `  {${C.pink}-fg}/help{/}                     cette aide`,
  `  {${C.pink}-fg}/quit{/}                     quitter  {${C.dimV}-fg}(ou Ctrl+C){/}`,
  '',
].join('\n');

const COMMANDS = [
  { label: '/run', value: '/run ', description: 'exécuter une pipeline' },
  { label: '/scan', value: '/scan ', description: 'scanner les agents .md' },
  { label: '/new', value: '/new ', description: 'créer un nouvel agent' },
  { label: '/serve', value: '/serve ', description: 'démarrer le serveur web' },
  { label: '/stop', value: '/stop', description: 'arrêter le serveur web' },
  { label: '/commit-last', value: '/commit-last', description: 'commit le dernier run' },
  { label: '/ls', value: '/ls', description: 'lister les pipelines' },
  { label: '/help', value: '/help', description: 'afficher l’aide' },
  { label: '/quit', value: '/quit', description: 'quitter' },
];

const RUN_FLAGS = [
  { label: '--dry', description: 'plan sans appel API' },
  { label: '--verbose', description: 'afficher prompts et outputs' },
  { label: '-v', description: 'alias de --verbose' },
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

// Strip blessed tags to get visible string length
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
    `${dateStr}  ${timeStr}`,
    '',
    `${pipelines.length} pipeline${pipelines.length !== 1 ? 's' : ''}`,
    `${agentCount} agent${agentCount !== 1 ? 's' : ''}`,
    '',
    `Currently running on: {${C.peach}-fg}Claude Code{/}`,
    `{${C.dimV}-fg}type /cli to set your preference{/}`,
    '',
  ];
  const TAGLINE  = 'one to rule them all';
  const bottomBlockHeight = 2 + SINGLETON_RAW.length;
  const spacerLines = Math.max(0, contentHeight - headerLines.length - bottomBlockHeight);

  // Track shimmer positions
  const welcomeRow = CONTENT_PAD_TOP + 2;
  const taglineRow = CONTENT_PAD_TOP + headerLines.length + spacerLines;

  for (const line of headerLines) {
    shell.log(line);
  }
  for (let i = 0; i < spacerLines; i += 1) {
    shell.log('');
  }

  shell.log(' '.repeat(TAGLINE.length));
  shell.log('');
  for (const line of SINGLETON_RAW) {
    shell.log(plainBrightLine(line));
  }

  const stopWelcome = shell.createShimmer('Welcome back', welcomeRow, CONTENT_PAD_LEFT);
  const stopTagline = shell.createShimmer(TAGLINE, taglineRow, CONTENT_PAD_LEFT);

  return () => { stopWelcome(); stopTagline(); };
  shell.log('');
  shell.log(`{bold}${pipelines.length}{/} pipelines`);
  shell.log(`{bold}${agentCount}{/} agents`);
  shell.log('');
  shell.log(`Currently running on: {${C.peach}-fg}Claude Code{/}`);
  shell.log(`{${C.dimV}-fg}type /cli to set your preference{/}`);
  shell.log('');
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
          shell.log('{#676498-fg}À bientôt.{/}');
          setTimeout(() => { shell.destroy(); process.exit(0); }, 300);
          return;
        default:
          shell.log(`{${C.peach}-fg}!{/} Commande inconnue : {bold}${cmd}{/}  — tape /help`);
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
  const name    = args.filter((a) => !['--dry', '--verbose', '-v'].includes(a))[0];

  if (!name) {
    const pipelines = await listPipelines(root);
    if (pipelines.length === 0) {
      shell.log(`{${C.peach}-fg}!{/} Aucune pipeline trouvée.`);
      return;
    }
    shell.log(`{${C.dimV}-fg}  Pipelines : ${pipelines.join(', ')}{/}`);
    shell.log(`{${C.dimV}-fg}  Usage : /run <name> [--dry]{/}`);
    return;
  }

  const filePath = await resolvePipelinePath(name, root);
  if (!filePath) {
    shell.log(`{${C.salmon}-fg}✕{/} Pipeline "{bold}${name}{/}" introuvable.`);
    const pipelines = await listPipelines(root);
    if (pipelines.length) shell.log(`{${C.dimV}-fg}  Disponibles : ${pipelines.join(', ')}{/}`);
    return;
  }

  await runPipeline(filePath, { dryRun: dry, verbose, shell });
}

async function cmdLs(root, shell) {
  const pipelines = await listPipelines(root);
  if (pipelines.length === 0) {
    shell.log('{yellow-fg}!{/} Aucune pipeline trouvée.');
    return;
  }
  shell.log(`{bold}Pipelines (${pipelines.length}){/}`);
  shell.log('');
  for (const p of pipelines) shell.log(`  {${C.dimV}-fg}·{/} {${C.pink}-fg}${p}{/}`);
  shell.log('');
}

async function cmdScan(root, shell) {
  shell.log(`{${C.dimV}-fg}Scan de ${root}…{/}`);
  const agents = await scanAgents(root);
  if (agents.length === 0) {
    shell.log(`{${C.peach}-fg}!{/} Aucun agent trouvé (aucun .md avec ## Config).`);
    return;
  }
  shell.log(`{bold}Agents (${agents.length}){/}`);
  shell.log('');
  for (const a of agents) {
    shell.log(`  {${C.violet}-fg}{bold}${a.id}{/}  {${C.dimV}-fg}${a.description || '(sans description)'}{/}`);
    shell.log(`  {${C.blue}-fg}{bold}source{/}: {${C.dimV}-fg}${a.source || 'repo'}{/}${a.provider ? `   {${C.peach}-fg}{bold}provider{/}: {${C.dimV}-fg}${a.provider}{/}` : ''}`);
    shell.log(`  {${C.mint}-fg}{bold}in{/}: {${C.dimV}-fg}${a.inputs.join(', ') || '—'}{/}   {${C.pink}-fg}{bold}out{/}: {${C.dimV}-fg}${a.outputs.join(', ') || '—'}{/}`);
  }
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
    shell.log(`{${C.peach}-fg}!{/} Le serveur tourne déjà sur {${C.blue}-fg}${serveState.url}{/}.`);
    return;
  }
  const { startServer } = await import('../../../server/src/index.js');
  const serverUrl = 'http://localhost:4317';
  shell.log('{#676498-fg}Démarrage du serveur… (/stop pour arrêter){/}');
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
    shell.log(`{${C.peach}-fg}!{/} Aucun serveur en cours d'exécution.`);
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
    shell.log(`{${C.peach}-fg}!{/} Aucun dernier run exploitable trouvé dans .singleton/runs/latest.`);
    return;
  }

  const files = Array.isArray(manifest.deliverables) ? manifest.deliverables : [];
  if (files.length === 0) {
    shell.log(`{${C.peach}-fg}!{/} Le dernier run n'a produit aucun livrable à committer.`);
    return;
  }

  try {
    await runCommand('git', ['rev-parse', '--show-toplevel'], { cwd: root });
  } catch {
    shell.log(`{${C.salmon}-fg}✕{/} Ce projet n'est pas dans un dépôt Git.`);
    return;
  }

  shell.log(`{bold}Commit last{/}  {${C.dimV}-fg}${manifest.pipeline || 'unknown pipeline'}{/}`);
  shell.log('');
  for (const file of files) shell.log(`  {${C.dimV}-fg}·{/} ${file.path}`);
  shell.log('');

  const defaultMessage = `Update files from ${manifest.pipeline || 'last pipeline'}`;
  const message = (await shell.prompt(`Commit message (default: ${defaultMessage})`)).trim() || defaultMessage;

  const relFiles = files.map((file) => file.path);
  await runCommand('git', ['add', '--', ...relFiles], { cwd: root });
  await runCommand('git', ['commit', '-m', message], { cwd: root });

  shell.log(`{${C.mint}-fg}✓{/} Commit créé : {${C.dimV}-fg}${message}{/}`);
}
