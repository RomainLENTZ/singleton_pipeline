import fs from 'node:fs/promises';
import path from 'node:path';
import { style } from '../theme.js';
import { createPlainTimeline, createTimeline } from '../timeline.js';
import { G, S } from '../shell.js';
import { collectInputValues } from './inputs.js';

/**
 * @param {{ shell?: any, nonInteractive?: boolean | null }} [options]
 * @returns {boolean}
 */
export function isNonInteractiveRuntime({ shell = null, nonInteractive = null } = {}) {
  if (shell) return false;
  if (typeof nonInteractive === 'boolean') return nonInteractive;
  return process.env.CI === 'true' || !process.stdout.isTTY;
}

export async function loadPipeline(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  const pipeline = JSON.parse(raw);
  if (!pipeline.steps || !Array.isArray(pipeline.steps)) {
    throw new Error('Invalid pipeline: missing steps[]');
  }
  return pipeline;
}

// Project root = parent of the first `.singleton` segment found in pipelineDir.
// Handles both .singleton/foo.json and .singleton/pipelines/foo.json.
export function resolveProjectRoot(pipelineDir) {
  const parts = pipelineDir.split(path.sep);
  const idx = parts.indexOf('.singleton');
  if (idx > 0) return parts.slice(0, idx).join(path.sep) || path.sep;
  return pipelineDir;
}

function createSilentTimeline() {
  return {
    log() {},
    logMuted() {},
    logSuccess() {},
    logError() {},
    logDiffLine() {},
    setRunning() {},
    setPaused() {},
    setDone() {},
    setError() {},
    end() {},
  };
}

export async function createRunWorkspace({ cwd, pipeline, dryRun, debug }) {
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const runId = `${debug ? 'DEBUG-' : ''}${ts}-${pipeline.name}`;
  const runDir = dryRun ? null : path.join(cwd, '.singleton', 'runs', runId);
  if (runDir) await fs.mkdir(runDir, { recursive: true });
  return { runId, runDir };
}

export function logRunStart({ pipeline, cwd, runDir, dryRun, debug, shell, quiet }) {
  const runInfo = runDir ? `run: ${path.relative(cwd, runDir)}` : '';
  if (!shell && !quiet) {
    console.log(style.title(`\n${G.pointer} ${pipeline.name}`) + style.muted(`  (${pipeline.steps.length} steps)`));
    if (runInfo) console.log(style.muted(`  ${runInfo}`));
    if (dryRun) console.log(style.warn('  [dry-run] no CLI calls will be made'));
    if (debug) console.log(style.warn('  [debug] pausing before each step'));
  } else if (shell) {
    shell.log(`{bold}${G.pointer} ${pipeline.name}{/}  {${S.muted}-fg}(${pipeline.steps.length} steps){/}`);
    if (runInfo) shell.log(`  {${S.muted}-fg}${runInfo}{/}`);
    if (dryRun) shell.log(`{yellow-fg}  [dry-run] no CLI calls will be made{/}`);
    if (debug) shell.log(`{yellow-fg}  [debug] pausing before each step{/}`);
    shell.setMode?.('running');
  }
}

function getInputDefs(pipeline) {
  return (pipeline.nodes || [])
    .filter((n) => n.type === 'input')
    .map((n) => ({ id: n.id, subtype: n.data?.subtype || 'text', label: n.data?.label || n.id, value: n.data?.value || '' }));
}

export async function collectPipelineInputs({ pipeline, dryRun, shell, nonInteractive = false, quiet = false }) {
  const inputDefs = getInputDefs(pipeline);

  // shell.prompt auto-toggles the frame to awaiting, so this only manages the label.
  const promptFn = shell ? async (msg) => {
    shell.setPipelineLabel?.('input waiting');
    try { return await shell.prompt(msg); }
    finally { shell.clearPipelineLabel?.(); }
  } : null;
  const inputValues = await collectInputValues(pipeline, dryRun, {
    promptFn,
    style: quiet ? null : style,
    nonInteractive,
  });
  return { inputDefs, inputValues };
}

export function createRunTimeline({ pipeline, quiet, shell, nonInteractive = false }) {
  if (shell) shell.enterPipelineMode();
  if (quiet) return createSilentTimeline();
  const stepNames = ['preflight checks', ...pipeline.steps.map((s) => s.agent)];
  return nonInteractive && !shell
    ? createPlainTimeline(stepNames)
    : createTimeline(stepNames, shell ? shell.pipelineWidgets : null);
}
