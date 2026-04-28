import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { spawn } from 'node:child_process';
import { input } from '@inquirer/prompts';
import { parseAgentFileDetailed } from './parser.js';
import { style, line } from './theme.js';
import { createTimeline } from './timeline.js';
import { C } from './shell.js';
import { getRunner } from './runners/index.js';
import { discoverCodexProjectInstructions } from './runners/codex-instructions.js';

export async function loadPipeline(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  const pipeline = JSON.parse(raw);
  if (!pipeline.steps || !Array.isArray(pipeline.steps)) {
    throw new Error('Invalid pipeline: missing steps[]');
  }
  return pipeline;
}

async function resolveFileGlob(spec, cwd) {
  const pattern = spec.slice('$FILE:'.length).trim();
  const abs = path.isAbsolute(pattern) ? pattern : path.join(cwd, pattern);
  const files = await fg(pattern, { cwd, absolute: true, dot: false });
  if (files.length === 0) {
    try {
      const content = await fs.readFile(abs, 'utf8');
      return [{ path: abs, content }];
    } catch {
      return [];
    }
  }
  const results = [];
  for (const f of files) {
    const content = await fs.readFile(f, 'utf8');
    results.push({ path: f, content });
  }
  return results;
}

function resolvePipeRef(spec, registry) {
  const ref = spec.slice('$PIPE:'.length).trim();
  const [agentId, outName] = ref.split('.');
  const key = outName ? `${agentId}.${outName}` : agentId;
  if (!(key in registry)) {
    throw new Error(`Unresolved $PIPE reference: ${ref}`);
  }
  return registry[key];
}

function parsePipeRef(spec) {
  const ref = String(spec).slice('$PIPE:'.length).trim();
  const [agentId, outName] = ref.split('.');
  return { ref, agentId, outName };
}

async function resolveInput(spec, { registry, cwd, inputValues = {}, inputDefs = [] }) {
  if (typeof spec !== 'string') return String(spec);
  if (spec.startsWith('$INPUT:')) {
    const id = spec.slice('$INPUT:'.length).trim();
    const val = inputValues[id];
    if (!val) return `(input not provided: ${id})`;
    const def = inputDefs.find((i) => i.id === id);
    if (def?.subtype === 'file') {
      return resolveInput(`$FILE:${val}`, { registry, cwd, inputValues, inputDefs });
    }
    return val;
  }
  if (spec.startsWith('$FILE:')) {
    const files = await resolveFileGlob(spec, cwd);
    if (files.length === 0) return `(no files matched: ${spec})`;
    return files.map((f) => `<file path="${path.relative(cwd, f.path)}">\n${f.content}\n</file>`).join('\n\n');
  }
  if (spec.startsWith('$PIPE:')) {
    return resolvePipeRef(spec, registry);
  }
  return spec;
}

async function collectInputValues(pipeline, dryRun, promptFn = null) {
  const defs = (pipeline.nodes || [])
    .filter((n) => n.type === 'input')
    .map((n) => ({ id: n.id, subtype: n.data?.subtype || 'text', label: n.data?.label || n.id, value: n.data?.value || '' }));
  if (defs.length === 0) return {};

  if (!promptFn) console.log(style.heading('\nInputs\n'));

  const askFn = promptFn || ((msg, def) => input({ message: msg, ...(def ? { default: def } : {}) }));

  const values = {};
  for (const def of defs) {
    const label = def.label || def.id;
    if (def.subtype === 'file' && def.value) {
      values[def.id] = def.value;
      if (!promptFn) console.log(style.muted(`  ${label}: ${def.value}`));
    } else if (dryRun) {
      values[def.id] = def.subtype === 'file' ? '(chemin non renseigné)' : 'réponse arbitraire (dry-run)';
      if (!promptFn) console.log(style.muted(`  ${label}: (arbitraire)`));
    } else {
      const msg = def.subtype === 'file' ? `${label} (chemin du fichier)` : label;
      values[def.id] = await askFn(msg, def.value || null);
    }
  }
  return values;
}

function buildUserMessage(resolvedInputs, outputNames, workspaceInfo) {
  const parts = [];
  if (workspaceInfo) {
    parts.push('<workspace>');
    parts.push(`Racine du projet : ${workspaceInfo.projectRoot}`);
    parts.push(`Dossier de travail de ce step : ${workspaceInfo.stepDirRel}`);
    parts.push('');
    parts.push(`Règles d'écriture de fichiers :`);
    parts.push(`- Livrables du projet (code source : composants, vues, API, services, tests, styles, etc.) : utilise ton outil Write pour les placer à leur emplacement naturel dans le repo (ex: src/components/molecules/X.vue, server/routes/api.js). Chemins relatifs à la racine du projet.`);
    parts.push(`- Fichiers intermédiaires (reviews, plans, logs, notes, debug, scratch) : écris-les dans ton dossier de travail ci-dessus.`);
    parts.push(`- N'écris JAMAIS de code source livrable dans .singleton/ ni dans ton dossier de travail.`);
    parts.push('</workspace>');
    parts.push('');
  }
  for (const [name, value] of Object.entries(resolvedInputs)) {
    parts.push(`<${name}>\n${value}\n</${name}>`);
  }
  parts.push('');
  if (outputNames.length === 1) {
    parts.push(`Provide your response as the <${outputNames[0]}> content directly (no XML wrapper needed).`);
  } else {
    parts.push('Provide your response with each output wrapped in its own XML block:');
    for (const name of outputNames) parts.push(`<${name}>...</${name}>`);
  }
  return parts.join('\n');
}

// Project root = parent of the first `.singleton` segment found in pipelineDir.
// Handles both .singleton/foo.json and .singleton/pipelines/foo.json.
function resolveProjectRoot(pipelineDir) {
  const parts = pipelineDir.split(path.sep);
  const idx = parts.indexOf('.singleton');
  if (idx > 0) return parts.slice(0, idx).join(path.sep) || path.sep;
  return pipelineDir;
}

// If `$FILE:` target lands inside <root>/.singleton/ (but not inside .singleton/runs/),
// redirect it into the current step's workspace, preserving the basename. Paths outside
// .singleton/ are real project deliverables — left untouched.
function rewriteFileSink(sink, { cwd, stepDir }) {
  if (typeof sink !== 'string' || !sink.startsWith('$FILE:')) return sink;
  const raw = sink.slice('$FILE:'.length).trim();
  const absOut = path.isAbsolute(raw) ? raw : path.join(cwd, raw);
  const rel = path.relative(cwd, absOut);
  if (!rel.startsWith('.singleton' + path.sep)) return sink;
  if (rel.startsWith(path.join('.singleton', 'runs') + path.sep)) return sink;
  const basename = path.basename(absOut);
  return `$FILE:${path.join(stepDir, basename)}`;
}

function parseOutputs(text, outputNames) {
  if (outputNames.length === 1) {
    return { [outputNames[0]]: text.trim() };
  }
  const result = {};
  for (const name of outputNames) {
    const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i');
    const m = text.match(re);
    result[name] = m ? m[1].trim() : '';
  }
  return result;
}

function resolveProvider(step, agent) {
  return step.provider || agent.provider || 'claude';
}

function resolveModel(step, agent) {
  return step.model || agent.model || null;
}

function failStep(timeline, index, shortMessage, fullMessage = shortMessage) {
  timeline.setError(index, String(shortMessage).slice(0, 60));
  throw new Error(fullMessage);
}

function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn('which', [command], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

async function runPreflightChecks({ pipeline, cwd, inputDefs, inputValues, dryRun }) {
  const errors = [];
  const warnings = [];
  const infos = [];
  const stepAgents = new Map();
  const availablePipeOutputs = new Set();

  for (const def of inputDefs) {
    const value = inputValues[def.id];
    if (!dryRun && !String(value || '').trim()) {
      errors.push(`Missing input "${def.id}".`);
      continue;
    }
    if (!dryRun && def.subtype === 'file' && String(value || '').trim()) {
      const files = await resolveFileGlob(`$FILE:${value}`, cwd);
      if (files.length === 0) {
        errors.push(`Input file "${def.id}" does not resolve to any file: ${value}`);
      }
    }
  }

  const parsedAgents = [];
  for (let i = 0; i < pipeline.steps.length; i += 1) {
    const step = pipeline.steps[i];
    const label = `Step ${i + 1} "${step.agent}"`;

    if (!step.agent_file) {
      errors.push(`${label} is missing agent_file.`);
      continue;
    }

    const agentFilePath = path.isAbsolute(step.agent_file)
      ? step.agent_file
      : path.resolve(cwd, step.agent_file);

    let raw;
    try {
      raw = await fs.readFile(agentFilePath, 'utf8');
    } catch {
      errors.push(`${label} agent file not found: ${step.agent_file}`);
      continue;
    }

    const { agent, error } = parseAgentFileDetailed(raw, agentFilePath);
    if (!agent) {
      errors.push(`${label} agent file is invalid: ${step.agent_file}${error ? ` (${error})` : ''}`);
      continue;
    }

    parsedAgents.push({ step, agent });
    stepAgents.set(step.agent, agent);

    let provider;
    try {
      provider = resolveProvider(step, agent);
      getRunner(provider);
    } catch (err) {
      errors.push(`${label} uses unknown provider "${step.provider || agent.provider || ''}".`);
      continue;
    }

    const model = resolveModel(step, agent);
    if (!model) warnings.push(`${label} has no model configured for provider "${provider}".`);

    for (const [name, spec] of Object.entries(step.inputs || {})) {
      if (typeof spec !== 'string') continue;

      if (spec.startsWith('$INPUT:')) {
        const id = spec.slice('$INPUT:'.length).trim();
        if (!inputDefs.some((def) => def.id === id)) {
          errors.push(`${label} input "${name}" references unknown $INPUT:${id}.`);
        }
      } else if (spec.startsWith('$PIPE:')) {
        const { ref, agentId, outName } = parsePipeRef(spec);
        if (!stepAgents.has(agentId)) {
          errors.push(`${label} input "${name}" references future or unknown $PIPE:${ref}.`);
        } else if (outName && !availablePipeOutputs.has(`${agentId}.${outName}`)) {
          errors.push(`${label} input "${name}" references missing $PIPE output: ${ref}.`);
        }
      } else if (spec.startsWith('$FILE:')) {
        const files = await resolveFileGlob(spec, cwd);
        if (files.length === 0) {
          errors.push(`${label} input "${name}" matched no files for ${spec}.`);
        }
      }
    }

    for (const outputName of Object.keys(step.outputs || {})) {
      availablePipeOutputs.add(`${step.agent}.${outputName}`);
    }
  }

  const usedProviders = [...new Set(parsedAgents.map(({ step, agent }) => resolveProvider(step, agent)))];
  for (const provider of usedProviders) {
    try {
      const runner = getRunner(provider);
      if (runner.command) {
        const exists = await commandExists(runner.command);
        if (!exists) errors.push(`Provider "${provider}" requires missing CLI binary: ${runner.command}`);
      }
    } catch {
      // already captured above
    }
  }

  if (usedProviders.includes('codex')) {
    const projectInstructions = await discoverCodexProjectInstructions(cwd, cwd);
    infos.push(
      `Codex project instructions: ${projectInstructions.files.length} file${projectInstructions.files.length !== 1 ? 's' : ''} detected.`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    infos,
    providerCount: usedProviders.length,
  };
}

function printVerboseBlock(label, content, colorFn = (s) => s) {
  const WIDTH = 72;
  const bar = style.muted('─'.repeat(WIDTH));
  console.log(`\n${bar}`);
  console.log(style.muted(`  ${label}`));
  console.log(bar);
  console.log(colorFn(content));
  console.log(bar + '\n');
}

function visibleLength(s) {
  return String(s || '').replace(/\{[^}]+\}/g, '').length;
}

function stripBlessedTags(s) {
  return String(s || '').replace(/\{[^}]+\}/g, '');
}

function padVisible(s, width, align = 'left') {
  const str = String(s ?? '');
  const pad = Math.max(0, width - visibleLength(str));
  return align === 'right' ? `${' '.repeat(pad)}${str}` : `${str}${' '.repeat(pad)}`;
}

function formatSeconds(value) {
  return `${Number(value || 0).toFixed(1)}s`;
}

function formatCost(value) {
  return value > 0 ? `$${value.toFixed(4)}` : '—';
}

function formatTurns(value) {
  return value > 0 ? String(value) : '—';
}

function renderRunSummary({ stats, fileWrites, dryRun, runDir, cwd }) {
  const totalSeconds = stats.reduce((sum, s) => sum + (s.seconds || 0), 0);
  const totalCost = stats.reduce((sum, s) => sum + (s.cost || 0), 0);
  const totalTurns = stats.reduce((sum, s) => sum + (s.turns || 0), 0);

  const rows = stats.map((s, i) => ({
    step: String(i + 1),
    agent: s.agent,
    provider: s.provider || '—',
    model: s.model || '—',
    status: s.status,
    time: s.status === 'dry-run' || s.status === 'skipped' ? '—' : formatSeconds(s.seconds),
    turns: formatTurns(s.turns),
    cost: formatCost(s.cost),
  }));

  const totalRow = {
    step: '',
    agent: 'TOTAL',
    provider: '—',
    model: '—',
    status: dryRun ? 'dry-run' : 'done',
    time: formatSeconds(totalSeconds),
    turns: formatTurns(totalTurns),
    cost: formatCost(totalCost),
  };

  const allRows = [...rows, totalRow];
  const widths = {
    step: Math.max(1, ...allRows.map((r) => visibleLength(r.step))),
    agent: Math.max(5, ...allRows.map((r) => visibleLength(r.agent))),
    provider: Math.max(8, ...allRows.map((r) => visibleLength(r.provider))),
    model: Math.max(5, ...allRows.map((r) => visibleLength(r.model))),
    status: Math.max(6, ...allRows.map((r) => visibleLength(r.status))),
    time: Math.max(4, ...allRows.map((r) => visibleLength(r.time))),
    turns: Math.max(5, ...allRows.map((r) => visibleLength(r.turns))),
    cost: Math.max(4, ...allRows.map((r) => visibleLength(r.cost))),
  };

  const hr = [
    '─'.repeat(widths.step + 2),
    '─'.repeat(widths.agent + 2),
    '─'.repeat(widths.provider + 2),
    '─'.repeat(widths.model + 2),
    '─'.repeat(widths.status + 2),
    '─'.repeat(widths.time + 2),
    '─'.repeat(widths.turns + 2),
    '─'.repeat(widths.cost + 2),
  ].join('┼');

  function row(r) {
    return [
      ` ${padVisible(r.step, widths.step, 'right')} `,
      ` ${padVisible(r.agent, widths.agent)} `,
      ` ${padVisible(r.provider, widths.provider)} `,
      ` ${padVisible(r.model, widths.model)} `,
      ` ${padVisible(r.status, widths.status)} `,
      ` ${padVisible(r.time, widths.time, 'right')} `,
      ` ${padVisible(r.turns, widths.turns, 'right')} `,
      ` ${padVisible(r.cost, widths.cost, 'right')} `,
    ].join('│');
  }

  const lines = [
    '',
    '{bold}Récapitulatif{/}',
    '',
    row({ step: '#', agent: 'Agent', provider: 'Provider', model: 'Model', status: 'Statut', time: 'Temps', turns: 'Tours', cost: 'Coût' }),
    hr,
    ...rows.map(row),
    hr,
    row(totalRow),
    '',
  ];

  if (runDir) {
    lines.push(`Run: {${C.dimV}-fg}${path.relative(cwd, runDir)}{/}`);
  }

  if (fileWrites.length) {
    lines.push('', '{bold}Généré{/}');
    for (const f of fileWrites) lines.push(`  {${C.dimV}-fg}·{/} ${f}`);
  } else {
    lines.push('', `{${C.dimV}-fg}Aucun fichier généré.{/}`);
  }

  return lines;
}

const SNAPSHOT_SKIP_DIRS = new Set(['.git', '.singleton', 'node_modules', 'dist', 'build', '.next', '.cache', 'coverage']);

async function snapshotProjectFiles(root, rel = '', out = new Map()) {
  const abs = path.join(root, rel);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SNAPSHOT_SKIP_DIRS.has(entry.name)) continue;
      await snapshotProjectFiles(root, path.join(rel, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    const entryRel = path.join(rel, entry.name);
    const entryAbs = path.join(root, entryRel);
    const stat = await fs.stat(entryAbs);
    out.set(entryRel, `${stat.size}:${Math.floor(stat.mtimeMs)}`);
  }
  return out;
}

function detectSnapshotChanges(before, after, root) {
  const changed = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const relPath of paths) {
    const beforeSig = before.get(relPath);
    const afterSig = after.get(relPath);
    if (beforeSig === afterSig) continue;
    changed.push({
      relPath,
      absPath: path.join(root, relPath),
      kind: 'deliverable',
    });
  }
  return changed;
}

async function writeRunManifest({ runDir, runId, pipeline, cwd, stats, fileWrites, detectedDeliverables = [] }) {
  if (!runDir) return;

  const uniqueWrites = [];
  const seen = new Set();
  for (const entry of [...fileWrites, ...detectedDeliverables]) {
    if (seen.has(entry.absPath)) continue;
    seen.add(entry.absPath);
    uniqueWrites.push(entry);
  }

  const deliverables = uniqueWrites.filter((entry) => entry.kind === 'deliverable');
  const intermediates = uniqueWrites.filter((entry) => entry.kind === 'intermediate');

  const manifest = {
    runId,
    pipeline: pipeline.name,
    projectRoot: cwd,
    createdAt: new Date().toISOString(),
    deliverables: deliverables.map((entry) => ({
      path: entry.relPath,
      absPath: entry.absPath,
    })),
    intermediates: intermediates.map((entry) => ({
      path: entry.relPath,
      absPath: entry.absPath,
    })),
    stats: stats.map((s) => ({
      agent: s.agent,
      status: s.status,
      seconds: s.seconds,
      turns: s.turns,
      cost: s.cost,
    })),
  };

  await fs.writeFile(path.join(runDir, 'run-manifest.json'), JSON.stringify(manifest, null, 2));
}

export async function runPipeline(filePath, opts = {}) {
  const abs = path.resolve(filePath);
  const pipeline = await loadPipeline(abs);
  const pipelineDir = path.dirname(abs);
  const cwd = resolveProjectRoot(pipelineDir);
  const dryRun  = !!opts.dryRun;
  const verbose = !!opts.verbose;
  const shell   = opts.shell || null;
  const beforeSnapshot = dryRun ? null : await snapshotProjectFiles(cwd);

  // Versioned workspace for this run — intermediate artifacts land here.
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const runId = `${ts}-${pipeline.name}`;
  const runDir = dryRun ? null : path.join(cwd, '.singleton', 'runs', runId);
  if (runDir) await fs.mkdir(runDir, { recursive: true });

  const runInfo = runDir ? `run: ${path.relative(cwd, runDir)}` : '';
  if (!shell) {
    console.log(style.title(`\n▸ ${pipeline.name}`) + style.muted(`  (${pipeline.steps.length} steps)`));
    if (runInfo) console.log(style.muted(`  ${runInfo}`));
    if (dryRun) console.log(style.warn('  [dry-run] no CLI calls will be made'));
  } else {
    shell.log(`{bold}▸ ${pipeline.name}{/}  {${C.dimV}-fg}(${pipeline.steps.length} steps){/}`);
    if (runInfo) shell.log(`  {${C.dimV}-fg}${runInfo}{/}`);
    if (dryRun) shell.log(`{yellow-fg}  [dry-run] no CLI calls will be made{/}`);
  }

  const inputDefs = (pipeline.nodes || [])
    .filter((n) => n.type === 'input')
    .map((n) => ({ id: n.id, subtype: n.data?.subtype || 'text', label: n.data?.label || n.id, value: n.data?.value || '' }));

  const promptFn = shell ? (msg) => shell.prompt(msg) : null;
  const inputValues = await collectInputValues(pipeline, dryRun, promptFn);

  if (shell) shell.enterPipelineMode();
  const timeline = createTimeline(
    ['preflight checks', ...pipeline.steps.map((s) => s.agent)],
    shell ? shell.pipelineWidgets : null
  );

  const registry = {};
  const fileWrites = [];
  const verboseLog = [];
  const stats = [];

  try {
    timeline.setRunning(0);
    const preflightStarted = Date.now();
    const preflight = await runPreflightChecks({ pipeline, cwd, inputDefs, inputValues, dryRun });
    const preflightSeconds = (Date.now() - preflightStarted) / 1000;

    if (preflight.infos.length) {
      timeline.log(`── preflight info ──`);
      for (const info of preflight.infos) timeline.logMuted(info);
    }

    if (preflight.warnings.length) {
      timeline.log(`── preflight warnings ──`);
      for (const warning of preflight.warnings) timeline.logMuted(warning);
    }

    if (!preflight.ok) {
      timeline.log(`── preflight errors ──`);
      for (const error of preflight.errors) timeline.logMuted(error);
      failStep(
        timeline,
        0,
        `${preflight.errors.length} error${preflight.errors.length > 1 ? 's' : ''}`,
        `Preflight checks failed:\n- ${preflight.errors.join('\n- ')}`
      );
    }

    timeline.setDone(0, `${preflightSeconds.toFixed(1)}s · ${preflight.providerCount} provider${preflight.providerCount > 1 ? 's' : ''}`);
    timeline.log(`✓ preflight checks — ${preflight.providerCount} provider${preflight.providerCount > 1 ? 's' : ''}`);
    stats.push({
      agent: 'preflight checks',
      provider: 'system',
      model: '—',
      status: 'done',
      seconds: preflightSeconds,
      turns: 0,
      cost: 0,
    });

    for (let i = 0; i < pipeline.steps.length; i++) {
      const step = pipeline.steps[i];
      const timelineIndex = i + 1;
      timeline.setRunning(timelineIndex);

      if (!step.agent_file) {
        failStep(timeline, timelineIndex, 'no agent_file', `Step "${step.agent}" is missing agent_file.`);
      }

      const agentFilePath = path.isAbsolute(step.agent_file)
        ? step.agent_file
        : path.resolve(cwd, step.agent_file);
      const raw = await fs.readFile(agentFilePath, 'utf8');
      const { agent, error } = parseAgentFileDetailed(raw, agentFilePath);
      if (!agent) {
        failStep(
          timeline,
          timelineIndex,
          `failed to parse ${step.agent_file}`,
          `Failed to parse agent file: ${step.agent_file}${error ? ` (${error})` : ''}`
        );
      }

      const outputNames = Object.keys(step.outputs || {});
      if (outputNames.length === 0) {
        timeline.setDone(timelineIndex, 'skipped (no outputs)');
        stats.push({
          agent: step.agent,
          provider: step.provider || 'claude',
          model: step.model || '—',
          status: 'skipped',
          seconds: 0,
          turns: 0,
          cost: 0,
        });
        continue;
      }

      if (dryRun) {
        const provider = resolveProvider(step, agent);
        const model = resolveModel(step, agent);
        timeline.setDone(timelineIndex, `dry-run · ${outputNames.join(', ')}`);
        for (const name of outputNames) registry[`${step.agent}.${name}`] = `(dry-run:${step.agent}.${name})`;
        stats.push({
          agent: step.agent,
          provider,
          model: model || '—',
          status: 'dry-run',
          seconds: 0,
          turns: 0,
          cost: 0,
        });
        continue;
      }

      const stepIndex = String(i + 1).padStart(2, '0');
      const stepDir = runDir ? path.join(runDir, `${stepIndex}-${step.agent}`) : null;
      if (stepDir) await fs.mkdir(stepDir, { recursive: true });

      const resolvedInputs = {};
      for (const [name, spec] of Object.entries(step.inputs || {})) {
        resolvedInputs[name] = await resolveInput(spec, { registry, cwd, inputValues, inputDefs });
      }

      const systemPrompt = agent.prompt || agent.description;
      const workspaceInfo = stepDir ? { projectRoot: cwd, stepDirRel: path.relative(cwd, stepDir) } : null;
      const userMessage = buildUserMessage(resolvedInputs, outputNames, workspaceInfo);
      const provider = resolveProvider(step, agent);
      const model = resolveModel(step, agent);
      const runner = getRunner(provider);

      if (verbose) {
        timeline.log(`── system prompt ──`);
        for (const l of systemPrompt.split('\n').slice(0, 8)) timeline.logMuted(l);
        timeline.log(`── user message ──`);
        for (const l of userMessage.split('\n').slice(0, 8)) timeline.logMuted(l);
      }

      const started = Date.now();
      let result;
      try {
        result = await runner.run({
          cwd,
          projectRoot: cwd,
          currentDir: cwd,
          systemPrompt,
          userPrompt: userMessage,
          model,
          verbose,
        });
      } catch (err) {
        failStep(timeline, timelineIndex, err.message, `Step "${step.agent}" failed: ${err.message}`);
      }
      const elapsedSeconds = (Date.now() - started) / 1000;
      const elapsed = elapsedSeconds.toFixed(1);
      const text = result.text;

      if (verbose) {
        timeline.log(`── output ──`);
        for (const l of text.split('\n').slice(0, 20)) timeline.logMuted(l);
      }

      const parsed = parseOutputs(text, outputNames);

      for (const name of outputNames) {
        registry[`${step.agent}.${name}`] = parsed[name];
        let sink = step.outputs[name];

        if (typeof sink === 'string') {
          for (const [id, val] of Object.entries(inputValues)) {
            sink = sink.replaceAll(`$INPUT:${id}`, val);
          }
        }

        if (stepDir) sink = rewriteFileSink(sink, { cwd, stepDir });

        if (typeof sink === 'string' && sink.startsWith('$FILES:')) {
          const baseDir = sink.slice('$FILES:'.length).trim();
          const absBase = path.isAbsolute(baseDir) ? baseDir : path.join(cwd, baseDir);
          const rawJson = parsed[name].replace(/^```[a-z]*\n?/m, '').replace(/```\s*$/m, '').trim();
          let manifest;
          try { manifest = JSON.parse(rawJson); } catch (e) {
            failStep(timeline, timelineIndex, '$FILES: JSON invalide', `Step "${step.agent}" returned invalid JSON for $FILES output "${name}".`);
          }
          for (const entry of (Array.isArray(manifest) ? manifest : [])) {
            const absOut = path.join(absBase, entry.path);
            await fs.mkdir(path.dirname(absOut), { recursive: true });
            await fs.writeFile(absOut, entry.content);
            fileWrites.push({
              absPath: absOut,
              relPath: path.relative(cwd, absOut),
              kind: path.relative(cwd, absOut).startsWith('.singleton' + path.sep) ? 'intermediate' : 'deliverable',
            });
          }
        } else if (typeof sink === 'string' && sink.startsWith('$FILE:')) {
          const outPath = sink.slice('$FILE:'.length).trim();
          const absOut = path.isAbsolute(outPath) ? outPath : path.join(cwd, outPath);
          await fs.mkdir(path.dirname(absOut), { recursive: true });
          await fs.writeFile(absOut, parsed[name]);
          fileWrites.push({
            absPath: absOut,
            relPath: path.relative(cwd, absOut),
            kind: path.relative(cwd, absOut).startsWith('.singleton' + path.sep) ? 'intermediate' : 'deliverable',
          });
        }
      }

      const costInfo = result.metadata.costUsd ? ` · $${result.metadata.costUsd.toFixed(4)}` : '';
      const turnInfo = result.metadata.turns ? ` · ${result.metadata.turns}t` : '';
      timeline.setDone(timelineIndex, `${elapsed}s${turnInfo}${costInfo}`);
      timeline.log(`✓ ${step.agent} — ${elapsed}s${turnInfo}${costInfo}`);
      stats.push({
        agent: step.agent,
        provider,
        model: model || '—',
        status: 'done',
        seconds: elapsedSeconds,
        turns: Number(result.metadata.turns || 0),
        cost: Number(result.metadata.costUsd || 0),
      });
    }
  } finally {
    timeline.end();
    if (shell) shell.exitPipelineMode();
  }

  const detectedDeliverables = dryRun ? [] : detectSnapshotChanges(beforeSnapshot, await snapshotProjectFiles(cwd), cwd);

  if (runDir) {
    await writeRunManifest({ runDir, runId, pipeline, cwd, stats, fileWrites, detectedDeliverables });
    const latest = path.join(cwd, '.singleton', 'runs', 'latest');
    try { await fs.unlink(latest); } catch { /* missing is fine */ }
    try { await fs.symlink(runId, latest, 'dir'); } catch { /* non-critical */ }
  }

  const combinedWrites = [];
  const seenWrites = new Set();
  for (const entry of [...fileWrites, ...detectedDeliverables]) {
    if (seenWrites.has(entry.absPath)) continue;
    seenWrites.add(entry.absPath);
    combinedWrites.push(entry);
  }

  const out = shell
    ? (t) => shell.log(t)
    : (t) => console.log(stripBlessedTags(t));

  for (const line of renderRunSummary({ stats, fileWrites: combinedWrites.map((f) => f.relPath), dryRun, runDir, cwd })) out(line);
  out(dryRun ? `{${C.mint}-fg}✓ dry-run terminé{/}` : `{${C.mint}-fg}✓ pipeline terminée{/}`);
}
