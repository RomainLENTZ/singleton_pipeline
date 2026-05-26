import fs from 'node:fs/promises';
import path from 'node:path';
import { style } from '../theme.js';
import { createPlainTimeline, createTimeline } from '../timeline.js';
import { G, S } from '../shell.js';
import { collectInputValues } from './inputs.js';
import type { InputDef, PipelineConfig } from '../types.js';

type ShellLike = any;

type PipelineWithNodes = PipelineConfig & {
  nodes?: Array<{
    id: string;
    type: string;
    data?: {
      subtype?: string;
      label?: string;
      value?: string;
    };
  }>;
};

type RunWorkspace = {
  runId: string;
  runDir: string | null;
};

export function isNonInteractiveRuntime({
  shell = null,
  nonInteractive = null,
}: {
  shell?: ShellLike;
  nonInteractive?: boolean | null;
} = {}): boolean {
  if (shell) return false;
  if (typeof nonInteractive === 'boolean') return nonInteractive;
  return process.env.CI === 'true' || !process.stdout.isTTY;
}

export async function loadPipeline(filePath: string): Promise<PipelineWithNodes> {
  const raw = await fs.readFile(filePath, 'utf8');
  const pipeline = JSON.parse(raw) as PipelineWithNodes;
  if (!pipeline.steps || !Array.isArray(pipeline.steps)) {
    throw new Error('Invalid pipeline: missing steps[]');
  }
  return pipeline;
}

// Project root = parent of the first `.singleton` segment found in pipelineDir.
// Handles both .singleton/foo.json and .singleton/pipelines/foo.json.
export function resolveProjectRoot(pipelineDir: string): string {
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

export async function createRunWorkspace({
  cwd,
  pipeline,
  dryRun,
  debug,
}: {
  cwd: string;
  pipeline: PipelineConfig;
  dryRun: boolean;
  debug: boolean;
}): Promise<RunWorkspace> {
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const runId = `${debug ? 'DEBUG-' : ''}${ts}-${pipeline.name}`;
  const runDir = dryRun ? null : path.join(cwd, '.singleton', 'runs', runId);
  if (runDir) await fs.mkdir(runDir, { recursive: true });
  return { runId, runDir };
}

export function logRunStart({
  pipeline,
  cwd,
  runDir,
  dryRun,
  debug,
  shell,
  quiet,
}: {
  pipeline: PipelineConfig;
  cwd: string;
  runDir: string | null;
  dryRun: boolean;
  debug: boolean;
  shell?: ShellLike;
  quiet?: boolean;
}): void {
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

function getInputDefs(pipeline: PipelineWithNodes): InputDef[] {
  return (pipeline.nodes || [])
    .filter((node) => node.type === 'input')
    .map((node) => ({
      id: node.id,
      subtype: node.data?.subtype || 'text',
      label: node.data?.label || node.id,
      value: node.data?.value || '',
    }));
}

export async function collectPipelineInputs({
  pipeline,
  dryRun,
  shell,
  nonInteractive = false,
  quiet = false,
}: {
  pipeline: PipelineWithNodes;
  dryRun: boolean;
  shell?: ShellLike;
  nonInteractive?: boolean;
  quiet?: boolean;
}): Promise<{ inputDefs: InputDef[], inputValues: Record<string, string> }> {
  const inputDefs = getInputDefs(pipeline);

  // shell.prompt auto-toggles the frame to awaiting, so this only manages the label.
  const promptFn = shell ? async (msg: string) => {
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

export function createRunTimeline({
  pipeline,
  quiet,
  shell,
  nonInteractive = false,
}: {
  pipeline: PipelineConfig;
  quiet?: boolean;
  shell?: ShellLike;
  nonInteractive?: boolean;
}) {
  if (shell) shell.enterPipelineMode();
  if (quiet) return createSilentTimeline();
  const stepNames = ['preflight checks', ...pipeline.steps.map((step) => step.agent)];
  return nonInteractive && !shell
    ? createPlainTimeline(stepNames)
    : createTimeline(stepNames, shell ? shell.pipelineWidgets : null);
}
