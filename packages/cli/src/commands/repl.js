import fs from 'node:fs/promises';
import path from 'node:path';
import { createShell, C } from '../shell.js';
import { scanAgents } from '../scanner.js';
import { runPipeline } from '../executor.js';
import { newAgentCommand } from './new.js';
import { editAgentCommand } from './edit.js';

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
  `  {${C.blue}-fg}/edit [id]{/}                éditer un agent existant`,
  `  {${C.blue}-fg}/serve{/}                    démarrer le serveur web`,
  `  {${C.pink}-fg}/ls{/}                       lister les pipelines`,
  `  {${C.pink}-fg}/help{/}                     cette aide`,
  `  {${C.pink}-fg}/quit{/}                     quitter  {${C.dimV}-fg}(ou Ctrl+C){/}`,
  '',
].join('\n');

const COMMANDS = [
  { label: '/run', value: '/run ', description: 'exécuter une pipeline' },
  { label: '/scan', value: '/scan ', description: 'scanner les agents .md' },
  { label: '/new', value: '/new ', description: 'créer un nouvel agent' },
  { label: '/edit', value: '/edit ', description: 'éditer un agent' },
  { label: '/serve', value: '/serve ', description: 'démarrer le serveur web' },
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

  if (cmd === '/edit') {
    const agents = await scanAgents(root);
    return agents
      .map((agent) => ({
        label: agent.id,
        value: replaceCurrentToken(buffer, agent.id),
        description: agent.description || 'agent',
      }))
      .filter((agent) => !current || matchesPrefix(agent.label, current));
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

const FACE_RAW = [
  '    ****                                    ****    ',
  '  ********                                ********  ',
  '************                            ************',
  '****    ****                            ****    ****',
  '**** ** ****                            **** ** ****',
  '**** ** ****                            **** ** ****',
  '****    ****                            ****    ****',
  '****    ****                            ****    ****',
  ' *********                                ********* ',
  '   ******                                  ******   ',
  '                                                    ',
  '                  **             **                 ',
  '                  ****         *****                ',
  '                  *****************                 ',
  '                    *************                   ',
].map((l) => l.replaceAll('*', '█'));

const SINGLETON_RAW = [
  '▄█████ ▄▄ ▄▄  ▄▄  ▄▄▄▄ ▄▄   ▄▄▄▄▄▄ ▄▄▄  ▄▄  ▄▄ ',
  '▀▀▀▄▄▄ ██ ███▄██ ██ ▄▄ ██     ██  ██▀██ ███▄██ ',
  '█████▀ ██ ██ ▀██ ▀███▀ ██▄▄▄  ██  ▀███▀ ██ ▀██ ',
];

const ART_WIDTH = Math.max(
  ...FACE_RAW.map((l) => l.length),
  ...SINGLETON_RAW.map((l) => l.length),
);

async function showWelcome(root, shell) {
  const now     = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  const w       = (shell.screen.width ?? 100) - 6;

  const [pipelines, agentCount] = await Promise.all([
    listPipelines(root),
    countAgents(root),
  ]);

  // Gap between face and SINGLETON
  const GAP        = 2;
  const allLines   = [...FACE_RAW, ...Array(GAP).fill(''), ...SINGLETON_RAW];
  const N          = allLines.length;                   // 15 + 2 + 3 = 20
  const rightArea  = Math.max(20, w - ART_WIDTH - 4);

  // Right column: welcome + date + info block, all left-aligned within the block
  const infoLines = [
    '',
    '◉ Welcome back',
    '',
    `${dateStr}  ${timeStr}`,
    '',
    `${pipelines.length} pipeline${pipelines.length !== 1 ? 's' : ''}`,
    `${agentCount} agent${agentCount !== 1 ? 's' : ''}`,
    '',
    `Claude Code`,
    `{${C.dimV}-fg}type /cli to set your preference{/}`,
    '',
  ];

  // Horizontal: center the block (longest visible line) in the right area
  const maxInfoWidth = Math.max(...infoLines.map(l => tw(l)));
  const blockHPad   = Math.max(0, Math.floor((rightArea - maxInfoWidth) / 2));

  // Vertical: center the block in N lines
  const rightStart  = Math.max(0, Math.floor((N - infoLines.length) / 2));

  const CONTENT_PAD_LEFT = 2;
  const CONTENT_PAD_TOP  = 1;
  const rightCol = CONTENT_PAD_LEFT + ART_WIDTH + 4 + blockHPad;

  // Track shimmer positions
  let welcomeRow = -1;
  let taglineRow = -1;

  shell.log('');

  allLines.forEach((line, i) => {
    const isFace = i < FACE_RAW.length;
    const isGap  = i >= FACE_RAW.length && i < FACE_RAW.length + GAP;

    const colored = (isFace || isGap)
      ? (isFace ? `{${i >= 11 ? C.pink : C.violet}-fg}${line}{/}` : '')
      : gradientLine(line, ART_WIDTH);

    const padRight = ' '.repeat(Math.max(0, ART_WIDTH - line.length) + 4 + blockHPad);

    const rIdx = i - rightStart;
    if (rIdx >= 0 && rIdx < infoLines.length) {
      const rLine = infoLines[rIdx];
      const absRow = CONTENT_PAD_TOP + 1 + i;

      if (rLine.includes('Welcome back')) {
        welcomeRow = absRow;
        shell.log(colored + padRight + ' '.repeat(tw('Welcome back')));
      } else if (rLine.includes('Claude Code')) {
        shell.log(colored + padRight + `Currently running on: {${C.peach}-fg}Claude Code{/}`);
      } else if (rLine) {
        shell.log(colored + padRight + rLine);
      } else {
        shell.log(colored);
      }
    } else {
      shell.log(colored);
    }
  });

  // "one to rule them all" shimmer below art
  const TAGLINE  = 'one to rule them all';
  taglineRow     = CONTENT_PAD_TOP + 1 + N;
  shell.log('');
  shell.log(' '.repeat(TAGLINE.length));

  const stopWelcome = welcomeRow >= 0 ? shell.createShimmer('Welcome back', welcomeRow, rightCol) : () => {};
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

export async function replCommand(opts) {
  const root  = path.resolve(opts.root || process.cwd());
  const shell = createShell();

  let stopShimmer = await showWelcome(root, shell);

  shell.setCompleter(({ buffer }) => completeRepl(buffer, root));

  shell.onCommand(async (raw) => {
    if (stopShimmer) { stopShimmer(); stopShimmer = null; shell.clear(); }
    const [cmd, ...args] = raw.trim().split(/\s+/);
    shell.disableInput();
    try {
      switch (cmd) {
        case '/run':   await cmdRun(args, root, shell); break;
        case '/ls':    await cmdLs(root, shell); break;
        case '/scan':  await cmdScan(root, shell); break;
        case '/new':   await cmdNew(root, shell); break;
        case '/edit':  await cmdEdit(args[0], root, shell); break;
        case '/serve': await cmdServe(root, shell); break;
        case '/help':  shell.log(HELP); break;
        case '/quit':
        case '/exit':
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
    shell.log(`  {${C.dimV}-fg}in: ${a.inputs.join(', ') || '—'}   out: ${a.outputs.join(', ') || '—'}{/}`);
  }
  const outPath = path.resolve(root, '.singleton', 'agents.json');
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify({ scannedAt: new Date().toISOString(), root, agents }, null, 2));
  shell.log('');
  shell.log(`{${C.mint}-fg}✓{/} Cache → .singleton/agents.json`);
}

async function cmdNew(root, shell) {
  // newAgentCommand uses inquirer — destroy shell, run, then restart
  shell.destroy();
  await newAgentCommand({ root });
  process.exit(0);
}

async function cmdEdit(id, root, shell) {
  shell.destroy();
  await editAgentCommand(id, { root });
  process.exit(0);
}

async function cmdServe(root, shell) {
  const { startServer } = await import('../../../server/src/index.js');
  shell.log('{#676498-fg}Démarrage du serveur… (Ctrl+C pour arrêter){/}');
  shell.enableInput();
  await startServer({ port: 4317, root });
}
