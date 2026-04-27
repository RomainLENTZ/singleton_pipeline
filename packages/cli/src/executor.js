import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import fg from 'fast-glob';
import { input } from '@inquirer/prompts';
import { parseAgentFile } from './parser.js';
import { style, line } from './theme.js';
import { createTimeline } from './timeline.js';
import { C } from './shell.js';

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

function runClaudeCLI({ systemPrompt, userMessage, model, cwd }) {
  const args = ['-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--system-prompt', systemPrompt];
  if (model) args.push('--model', model);

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`claude exited ${code}: ${stderr.trim() || stdout.trim()}`));
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed);
      } catch (err) {
        reject(new Error(`failed to parse claude output: ${err.message}\n${stdout.slice(0, 500)}`));
      }
    });
    child.stdin.write(userMessage);
    child.stdin.end();
  });
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
    status: s.status,
    time: s.status === 'dry-run' || s.status === 'skipped' ? '—' : formatSeconds(s.seconds),
    turns: formatTurns(s.turns),
    cost: formatCost(s.cost),
  }));

  const totalRow = {
    step: '',
    agent: 'TOTAL',
    status: dryRun ? 'dry-run' : 'done',
    time: formatSeconds(totalSeconds),
    turns: formatTurns(totalTurns),
    cost: formatCost(totalCost),
  };

  const allRows = [...rows, totalRow];
  const widths = {
    step: Math.max(1, ...allRows.map((r) => visibleLength(r.step))),
    agent: Math.max(5, ...allRows.map((r) => visibleLength(r.agent))),
    status: Math.max(6, ...allRows.map((r) => visibleLength(r.status))),
    time: Math.max(4, ...allRows.map((r) => visibleLength(r.time))),
    turns: Math.max(5, ...allRows.map((r) => visibleLength(r.turns))),
    cost: Math.max(4, ...allRows.map((r) => visibleLength(r.cost))),
  };

  const hr = [
    '─'.repeat(widths.step + 2),
    '─'.repeat(widths.agent + 2),
    '─'.repeat(widths.status + 2),
    '─'.repeat(widths.time + 2),
    '─'.repeat(widths.turns + 2),
    '─'.repeat(widths.cost + 2),
  ].join('┼');

  function row(r) {
    return [
      ` ${padVisible(r.step, widths.step, 'right')} `,
      ` ${padVisible(r.agent, widths.agent)} `,
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
    row({ step: '#', agent: 'Agent', status: 'Statut', time: 'Temps', turns: 'Tours', cost: 'Coût' }),
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
    pipeline.steps.map((s) => s.agent),
    shell ? shell.pipelineWidgets : null
  );

  const registry = {};
  const fileWrites = [];
  const verboseLog = [];
  const stats = [];

  for (let i = 0; i < pipeline.steps.length; i++) {
    const step = pipeline.steps[i];
    timeline.setRunning(i);

    if (!step.agent_file) {
      timeline.setError(i, `no agent_file`);
      process.exit(1);
    }

    const agentFilePath = path.isAbsolute(step.agent_file)
      ? step.agent_file
      : path.resolve(cwd, step.agent_file);
    const raw = await fs.readFile(agentFilePath, 'utf8');
    const agent = parseAgentFile(raw, agentFilePath);
    if (!agent) {
      timeline.setError(i, `failed to parse ${step.agent_file}`);
      process.exit(1);
    }

    const outputNames = Object.keys(step.outputs || {});
    if (outputNames.length === 0) {
      timeline.setDone(i, 'skipped (no outputs)');
      stats.push({
        agent: step.agent,
        status: 'skipped',
        seconds: 0,
        turns: 0,
        cost: 0,
      });
      continue;
    }

    if (dryRun) {
      timeline.setDone(i, `dry-run · ${outputNames.join(', ')}`);
      for (const name of outputNames) registry[`${step.agent}.${name}`] = `(dry-run:${step.agent}.${name})`;
      stats.push({
        agent: step.agent,
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

    if (verbose) {
      timeline.log(`── system prompt ──`);
      for (const l of systemPrompt.split('\n').slice(0, 8)) timeline.logMuted(l);
      timeline.log(`── user message ──`);
      for (const l of userMessage.split('\n').slice(0, 8)) timeline.logMuted(l);
    }

    const started = Date.now();
    let result;
    try {
      result = await runClaudeCLI({ systemPrompt, userMessage, model: agent.model, cwd });
    } catch (err) {
      timeline.setError(i, err.message.slice(0, 60));
      timeline.end();
      process.exit(1);
    }
    const elapsedSeconds = (Date.now() - started) / 1000;
    const elapsed = elapsedSeconds.toFixed(1);
    const text = typeof result.result === 'string' ? result.result : JSON.stringify(result);

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
          timeline.setError(i, `$FILES: JSON invalide`);
          continue;
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

    const costInfo = result.total_cost_usd ? ` · $${result.total_cost_usd.toFixed(4)}` : '';
    const turnInfo = result.num_turns ? ` · ${result.num_turns}t` : '';
    timeline.setDone(i, `${elapsed}s${turnInfo}${costInfo}`);
    timeline.log(`✓ ${step.agent} — ${elapsed}s${turnInfo}${costInfo}`);
    stats.push({
      agent: step.agent,
      status: 'done',
      seconds: elapsedSeconds,
      turns: Number(result.num_turns || 0),
      cost: Number(result.total_cost_usd || 0),
    });
  }

  timeline.end();
  if (shell) shell.exitPipelineMode();

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
