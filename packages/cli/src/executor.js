import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseAgentFileDetailed } from './parser.js';
import { style, line } from './theme.js';
import { createTimeline } from './timeline.js';
import { S } from './shell.js';
import { getRunner } from './runners/index.js';
import {
  loadProjectSecurityConfig,
  resolveSecurityPolicyWithConfig,
} from './security/policy.js';
import {
  detectSnapshotChanges,
  SnapshotManager,
} from './executor/snapshot-manager.js';
import {
  buildUserMessage,
  collectInputValues,
  resolveDebugInputOverridesFromEdit,
  resolveInput,
} from './executor/inputs.js';
import {
  moveAttemptArtifactsToAttemptDir,
} from './executor/outputs.js';
import {
  resolveModel,
  resolvePermissionMode,
  resolveProvider,
  resolveRunnerAgent,
  runPreflightChecks,
} from './executor/preflight.js';
import {
  DEFAULT_MAX_DEBUG_REPLAYS,
  debugToken,
  editDebugInputs,
  formatDebugList,
  logDebugPromptPreview,
  logSnapshotCoverage,
  promptDebugPostStepDecision,
  promptDebugStepDecision,
  pushDebugEvent,
} from './executor/debug-loop.js';
import {
  runStepAttempt,
} from './executor/step-runner.js';
import {
  renderRunSummary,
  writeRunManifest,
} from './executor/run-report.js';

export { detectSnapshotChanges } from './executor/snapshot-manager.js';
export { validatePostRunChanges } from './executor/step-runner.js';

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
function resolveProjectRoot(pipelineDir) {
  const parts = pipelineDir.split(path.sep);
  const idx = parts.indexOf('.singleton');
  if (idx > 0) return parts.slice(0, idx).join(path.sep) || path.sep;
  return pipelineDir;
}

function failStep(timeline, index, shortMessage, fullMessage = shortMessage) {
  timeline.setError(index, String(shortMessage).slice(0, 60));
  throw new Error(fullMessage);
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

function printVerboseBlock(label, content, colorFn = (s) => s) {
  const WIDTH = 72;
  const bar = style.muted('─'.repeat(WIDTH));
  console.log(`\n${bar}`);
  console.log(style.muted(`  ${label}`));
  console.log(bar);
  console.log(colorFn(content));
  console.log(bar + '\n');
}

function stripBlessedTags(s) {
  return String(s || '').replace(/\{[^}]+\}/g, '');
}

async function getViolationDiffPreview(cwd, relPath, { maxLines = 80 } = {}) {
  try {
    const { stdout } = await runCommand('git', ['diff', '--', relPath], { cwd });
    const lines = stdout.trimEnd().split('\n').filter(Boolean);
    if (lines.length === 0) {
      try {
        await runCommand('git', ['ls-files', '--error-unmatch', relPath], { cwd });
        return ['No git diff available for this path.'];
      } catch {
        try {
          const raw = await fs.readFile(path.join(cwd, relPath), 'utf8');
          const preview = raw.split('\n').slice(0, maxLines);
          if (raw.split('\n').length > maxLines) {
            preview.push(`... file preview truncated (${raw.split('\n').length - maxLines} more lines)`);
          }
          return [`new/untracked file: ${relPath}`, ...preview];
        } catch {
          return ['No git diff available for this path.'];
        }
      }
    }
    const clipped = lines.slice(0, maxLines);
    if (lines.length > maxLines) clipped.push(`... diff truncated (${lines.length - maxLines} more lines)`);
    return clipped;
  } catch {
    return ['No git diff available for this path.'];
  }
}

async function logViolationDiffPreviews({ violations, cwd, timeline }) {
  const maxFiles = 5;
  const shown = violations.slice(0, maxFiles);
  for (const violation of shown) {
    timeline.log(`── diff ${violation.path} ──`);
    const preview = await getViolationDiffPreview(cwd, violation.path);
    for (const line of preview) timeline.logDiffLine(line);
  }
  if (violations.length > maxFiles) {
    timeline.logMuted(`... ${violations.length - maxFiles} more violated file(s) not shown`);
  }
}

async function handlePostRunViolations({ violations, step, securityPolicy, timeline, timelineIndex, shell, cwd }) {
  if (violations.length === 0) return;

  timeline.log(`── post-run security violation ──`);
  timeline.logMuted(`Step "${step.agent}" changed files outside its security policy.`);
  timeline.logMuted(`security_profile: ${securityPolicy.profile}`);
  for (const violation of violations) {
    timeline.logMuted(`- ${violation.path}`);
  }
  await logViolationDiffPreviews({ violations, cwd, timeline });

  if (!shell) {
    failStep(
      timeline,
      timelineIndex,
      `${violations.length} security violation${violations.length > 1 ? 's' : ''}`,
      `Post-run security validation failed for "${step.agent}":\n- ${violations.map((v) => v.path).join('\n- ')}`
    );
  }

  while (true) {
    const answer = (await shell.prompt('Security violation: continue, stop, or diff? (c/s/d)')).trim().toLowerCase();
    if (answer === 'd' || answer === 'diff') {
      await logViolationDiffPreviews({ violations, cwd, timeline });
      continue;
    }
    if (answer === 'c' || answer === 'continue' || answer === 'y' || answer === 'yes') {
      timeline.log(`{${S.warning}-fg}!{/} Continued after security violation for ${step.agent}.`);
      return;
    }
    if (!answer || answer === 's' || answer === 'stop' || answer === 'n' || answer === 'no') {
      break;
    }
    timeline.logMuted('Choose c/continue, s/stop, or d/diff.');
  }

  {
    failStep(
      timeline,
      timelineIndex,
      'stopped by security review',
      `Pipeline stopped after post-run security validation for "${step.agent}".`
    );
  }
}

export async function runPipeline(filePath, opts = {}) {
  const abs = path.resolve(filePath);
  const pipeline = await loadPipeline(abs);
  const pipelineDir = path.dirname(abs);
  const cwd = resolveProjectRoot(pipelineDir);
  const dryRun  = !!opts.dryRun;
  const verbose = !!opts.verbose;
  const debug   = !!opts.debug;
  const shell   = opts.shell || null;
  const quiet   = !!opts.quiet;
  const maxDebugReplays = Number.isInteger(opts.maxDebugReplays)
    ? Math.max(0, opts.maxDebugReplays)
    : DEFAULT_MAX_DEBUG_REPLAYS;
  const securityConfig = await loadProjectSecurityConfig(cwd);
  const snapshotManager = dryRun ? null : await SnapshotManager.create({ root: cwd });
  const beforeSnapshot = dryRun ? null : await snapshotManager.captureState();
  let currentSnapshot = beforeSnapshot;

  // Versioned workspace for this run — intermediate artifacts land here.
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const runId = `${debug ? 'DEBUG-' : ''}${ts}-${pipeline.name}`;
  const runDir = dryRun ? null : path.join(cwd, '.singleton', 'runs', runId);
  if (runDir) await fs.mkdir(runDir, { recursive: true });

  const runInfo = runDir ? `run: ${path.relative(cwd, runDir)}` : '';
  if (!shell && !quiet) {
    console.log(style.title(`\n▸ ${pipeline.name}`) + style.muted(`  (${pipeline.steps.length} steps)`));
    if (runInfo) console.log(style.muted(`  ${runInfo}`));
    if (dryRun) console.log(style.warn('  [dry-run] no CLI calls will be made'));
    if (debug) console.log(style.warn('  [debug] pausing before each step'));
  } else if (shell) {
    shell.log(`{bold}▸ ${pipeline.name}{/}  {${S.muted}-fg}(${pipeline.steps.length} steps){/}`);
    if (runInfo) shell.log(`  {${S.muted}-fg}${runInfo}{/}`);
    if (dryRun) shell.log(`{yellow-fg}  [dry-run] no CLI calls will be made{/}`);
    if (debug) shell.log(`{yellow-fg}  [debug] pausing before each step{/}`);
    shell.setMode?.('running');
  }

  const inputDefs = (pipeline.nodes || [])
    .filter((n) => n.type === 'input')
    .map((n) => ({ id: n.id, subtype: n.data?.subtype || 'text', label: n.data?.label || n.id, value: n.data?.value || '' }));

  // shell.prompt now auto-toggles the cadre to 'awaiting' (orange) for any prompt,
  // so we only need to manage the pipeline label override here (input collection runs
  // before enterPipelineMode, so label changes are no-ops then — they apply once we're inside).
  const promptFn = shell ? async (msg) => {
    shell.setPipelineLabel?.('input waiting');
    try { return await shell.prompt(msg); }
    finally { shell.clearPipelineLabel?.(); }
  } : null;
  const inputValues = await collectInputValues(pipeline, dryRun, { promptFn, style });

  if (shell) shell.enterPipelineMode();
  const timeline = quiet
    ? createSilentTimeline()
    : createTimeline(
        ['preflight checks', ...pipeline.steps.map((s) => s.agent)],
        shell ? shell.pipelineWidgets : null
      );

  const registry = {};
  const fileWrites = [];
  const verboseLog = [];
  const stats = [];
  const debugEvents = [];
  const debugInputOverrides = {};
  let runError = null;

  try {
    timeline.setRunning(0);
    const preflightStarted = Date.now();
    const preflight = await runPreflightChecks({ pipeline, cwd, inputDefs, inputValues, dryRun, securityConfig });
    const preflightSeconds = (Date.now() - preflightStarted) / 1000;

    if (preflight.infos.length) {
      timeline.log(`── preflight info ──`);
      for (const info of preflight.infos) timeline.logMuted(info);
    }

    if (preflight.securityHighlights.length) {
      timeline.log(`── security profile preview ──`);
      for (const item of preflight.securityHighlights) timeline.logMuted(item);
    }

    if (preflight.warnings.length) {
      timeline.log(`── preflight warnings ──`);
      for (const warning of preflight.warnings) timeline.logMuted(warning);
    }

      if (!preflight.ok) {
        timeline.log(`── preflight errors ──`);
        for (const error of preflight.errors) timeline.logMuted(error);
        stats.push({
          agent: 'preflight checks',
          provider: 'system',
          model: '—',
          securityProfile: '—',
          permissionMode: '—',
          status: 'failed',
          seconds: preflightSeconds,
          turns: 0,
          cost: 0,
        });
        failStep(
          timeline,
          0,
        `${preflight.errors.length} error${preflight.errors.length > 1 ? 's' : ''}`,
        `Preflight checks failed:\n- ${preflight.errors.join('\n- ')}`
      );
    }

    timeline.setDone(0, `${preflightSeconds.toFixed(1)}s · ${preflight.providerCount} provider${preflight.providerCount > 1 ? 's' : ''}`);
    timeline.logSuccess(`✓ preflight checks — ${preflight.providerCount} provider${preflight.providerCount > 1 ? 's' : ''}`);
    stats.push({
      agent: 'preflight checks',
      provider: 'system',
      model: '—',
      securityProfile: '—',
      permissionMode: '—',
      status: 'done',
      seconds: preflightSeconds,
      turns: 0,
      cost: 0,
    });

    for (let i = 0; i < pipeline.steps.length; i++) {
      const step = pipeline.steps[i];
      const timelineIndex = i + 1;
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
        const provider = resolveProvider(step, agent);
        const model = resolveModel(step, agent);
        const runnerAgent = resolveRunnerAgent(step, agent);
        timeline.setDone(timelineIndex, 'skipped (no outputs)');
        stats.push({
          agent: step.agent,
          provider,
          model: model || '—',
          runnerAgent: runnerAgent || '—',
          securityProfile: resolveSecurityPolicyWithConfig(step, agent, securityConfig).profile,
          permissionMode: step.permission_mode || agent.permission_mode || '—',
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
        const runnerAgent = resolveRunnerAgent(step, agent);
        const permissionMode = resolvePermissionMode(step, agent);
        const securityPolicy = resolveSecurityPolicyWithConfig(step, agent, securityConfig);
        timeline.setDone(timelineIndex, `dry-run · ${outputNames.join(', ')}`);
        for (const name of outputNames) registry[`${step.agent}.${name}`] = `(dry-run:${step.agent}.${name})`;
        stats.push({
          agent: step.agent,
          provider,
          model: model || '—',
          runnerAgent: runnerAgent || '—',
          securityProfile: securityPolicy.profile,
          permissionMode: permissionMode || '—',
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

      let resolvedInputs = {};
      const runtimeInputValues = debug
        ? { ...inputValues, ...debugInputOverrides }
        : inputValues;
      for (const [name, spec] of Object.entries(step.inputs || {})) {
        resolvedInputs[name] = await resolveInput(spec, { registry, cwd, inputValues: runtimeInputValues, inputDefs });
      }

      const provider = resolveProvider(step, agent);
      const model = resolveModel(step, agent);
      const runnerAgent = resolveRunnerAgent(step, agent);
      const permissionMode = resolvePermissionMode(step, agent);
      const securityPolicy = resolveSecurityPolicyWithConfig(step, agent, securityConfig);
      const systemPrompt = agent.prompt || agent.description;
      const workspaceInfoForAttempt = (attemptNumber) => {
        if (!stepDir) return null;
        const attemptDir = debug && attemptNumber > 1 ? path.join(stepDir, `attempt-${attemptNumber}`) : stepDir;
        return { projectRoot: cwd, stepDirRel: path.relative(cwd, attemptDir) };
      };
      const workspaceInfo = workspaceInfoForAttempt(1);

      if (debug) {
        timeline.setPaused(timelineIndex, 'debug review');
        const decision = await promptDebugStepDecision({
          step,
          stepNumber: i + 1,
          totalSteps: pipeline.steps.length,
          provider,
          model,
          runnerAgent,
          permissionMode,
          securityPolicy,
          resolvedInputs,
          outputNames,
          systemPrompt,
          workspaceInfo,
          timeline,
          shell,
          quiet,
          decisionFn: opts.debugDecision,
          debugEvents,
        });

        if (decision.inputs) {
          const overrides = resolveDebugInputOverridesFromEdit(step, resolvedInputs, decision.inputs, inputDefs);
          for (const [id, value] of Object.entries(overrides)) {
            debugInputOverrides[id] = value;
          }
          if (Object.keys(overrides).length) {
            pushDebugEvent(debugEvents, {
              step: step.agent,
              phase: 'pre-step',
              action: 'set-runtime-input-overrides',
              inputIds: Object.keys(overrides),
            });
          }
          resolvedInputs = decision.inputs;
        }

        if (decision.action === 'skip') {
          for (const name of outputNames) {
            registry[`${step.agent}.${name}`] = `(debug-skipped:${step.agent}.${name})`;
          }
          timeline.setDone(timelineIndex, 'skipped by debug');
          timeline.log(`↷ ${step.agent} — skipped by debug`);
          stats.push({
            agent: step.agent,
            provider,
            model: model || '—',
            runnerAgent: runnerAgent || '—',
            securityProfile: securityPolicy.profile,
            permissionMode: permissionMode || '—',
            status: 'skipped',
            seconds: 0,
            turns: 0,
            cost: 0,
          });
          continue;
        }

        if (decision.action === 'abort') {
          stats.push({
            agent: step.agent,
            provider,
            model: model || '—',
            runnerAgent: runnerAgent || '—',
            securityProfile: securityPolicy.profile,
            permissionMode: permissionMode || '—',
            status: 'failed',
            seconds: 0,
            turns: 0,
            cost: 0,
          });
          failStep(timeline, timelineIndex, 'aborted by debug', `Pipeline aborted before step "${step.agent}".`);
        }
      }

      const runner = getRunner(provider);
      let attempt = 1;
      let finalAttempt = null;
      let shouldReplay = false;
      let replayInputs = resolvedInputs;
      let replayInputOverride = null;
      let replayBaseInputs = resolvedInputs;
      let totalAttemptSeconds = 0;
      let totalAttemptTurns = 0;
      let totalAttemptCost = 0;
      const stepRegistrySnapshot = new Map(
        outputNames.map((name) => {
          const key = `${step.agent}.${name}`;
          return [key, Object.prototype.hasOwnProperty.call(registry, key) ? registry[key] : undefined];
        })
      );
      const stepSnapshotDir = debug && stepDir ? path.join(stepDir, '.snapshot') : null;
      const stepSnapshot = stepSnapshotDir
        ? await snapshotManager.createRestoreSnapshot({ snapshotDir: stepSnapshotDir })
        : null;
      logSnapshotCoverage({ snapshot: stepSnapshot, timeline });
      const stepOriginalPaths = currentSnapshot ? new Set(currentSnapshot.keys()) : new Set();

      do {
        if (shouldReplay) {
          attempt += 1;
          if (finalAttempt?.stepChanges?.length || finalAttempt?.stepWrites?.length) {
            timeline.logMuted(`${debugToken.policy('Replay is restoring project files touched by the previous attempt. Previous run artifacts are kept under their attempt folder.')}`);
            timeline.logMuted(`${debugToken.key('pending restore')} ${formatDebugList((finalAttempt.stepChanges || []).map((entry) => entry.relPath))}`);
            timeline.logMuted(`${debugToken.key('previous artifacts')} ${formatDebugList((finalAttempt.stepWrites || []).map((entry) => entry.relPath))}`);
          }
          if (stepSnapshot && finalAttempt?.stepChanges?.length) {
            try {
              const result = await snapshotManager.restore({
                snapshot: stepSnapshot,
                originalPaths: stepOriginalPaths,
                changes: finalAttempt.stepChanges,
              });
              timeline.logMuted(`${debugToken.key('restore result')} ` +
                `${debugToken.key('restored')} ${formatDebugList(result.restored)} ` +
                `${debugToken.muted('·')} ${debugToken.key('removed')} ${formatDebugList(result.removed)} ` +
                `${debugToken.muted('·')} ${debugToken.key('skipped')} ${formatDebugList(result.skipped)}`);
              if (result.skipped.length) {
                timeline.logMuted(`${debugToken.policy('Could not restore (filtered out of snapshot):')} ${formatDebugList(result.skipped)}`);
                stats.push({
                  agent: step.agent,
                  provider,
                  model: model || '—',
                  runnerAgent: runnerAgent || '—',
                  securityProfile: securityPolicy.profile,
                  permissionMode: permissionMode || '—',
                  status: 'failed',
                  seconds: totalAttemptSeconds,
                  turns: totalAttemptTurns,
                  cost: totalAttemptCost,
                  attempts: attempt,
                });
                failStep(
                  timeline,
                  timelineIndex,
                  'replay restore incomplete',
                  `Replay restore incomplete before step "${step.agent}" attempt ${attempt}. These changed files were excluded from the snapshot:\n- ${result.skipped.join('\n- ')}`
                );
              }
              currentSnapshot = await snapshotManager.captureState();
            } catch (err) {
              stats.push({
                agent: step.agent,
                provider,
                model: model || '—',
                runnerAgent: runnerAgent || '—',
                securityProfile: securityPolicy.profile,
                permissionMode: permissionMode || '—',
                status: 'failed',
                seconds: totalAttemptSeconds,
                turns: totalAttemptTurns,
                cost: totalAttemptCost,
                attempts: attempt,
              });
              failStep(
                timeline,
                timelineIndex,
                'replay restore failed',
                `Replay restore failed before step "${step.agent}" attempt ${attempt}: ${err.message}`
              );
            }
          }
          for (const [key, previousValue] of stepRegistrySnapshot) {
            if (previousValue === undefined) delete registry[key];
            else registry[key] = previousValue;
          }
          const editedInputs = new Set();
          replayBaseInputs = replayInputs;
          if (replayInputOverride) {
            const nextInputs = { ...replayInputs };
            for (const [name, value] of Object.entries(replayInputOverride)) {
              if (Object.prototype.hasOwnProperty.call(nextInputs, name)) {
                nextInputs[name] = value;
                editedInputs.add(name);
              }
            }
            replayInputs = nextInputs;
            replayInputOverride = null;
          } else {
            replayInputs = await editDebugInputs({
              resolvedInputs: replayInputs,
              shell,
              timeline,
              step,
              debugEvents,
              editedInputs,
            });
          }
          const runtimeOverrides = resolveDebugInputOverridesFromEdit(step, replayBaseInputs, replayInputs, inputDefs);
          for (const [id, value] of Object.entries(runtimeOverrides)) {
            debugInputOverrides[id] = value;
          }
          if (Object.keys(runtimeOverrides).length) {
            pushDebugEvent(debugEvents, {
              step: step.agent,
              phase: 'post-step',
              action: 'set-runtime-input-overrides',
              inputIds: Object.keys(runtimeOverrides),
              attempt,
            });
          }
          if (editedInputs.size) {
            logDebugPromptPreview({
              systemPrompt,
              userMessage: buildUserMessage(replayInputs, outputNames, workspaceInfoForAttempt(attempt), securityPolicy),
              timeline,
              editedInputs,
            });
          }
          pushDebugEvent(debugEvents, {
            step: step.agent,
            phase: 'post-step',
            action: 'replay-start',
            attempt,
            editedInputs: [...editedInputs],
          });
        }

        const attemptWorkspaceInfo = workspaceInfoForAttempt(attempt);
        const attemptResult = await runStepAttempt({
          attempt,
          debug,
          stepDir,
          cwd,
          step,
          outputNames,
          inputs: replayInputs,
          securityPolicy,
          systemPrompt,
          workspaceInfo: attemptWorkspaceInfo,
          timeline,
          timelineIndex,
          verbose,
          runner,
          provider,
          model,
          runnerAgent,
          permissionMode,
          inputValues,
          registry,
          fileWrites,
          snapshotManager,
          currentSnapshot,
          shell,
          handlePostRunViolations,
          failStep,
        });
        if (attemptResult.failed) {
          stats.push({
            agent: step.agent,
            provider,
            model: model || '—',
            runnerAgent: runnerAgent || '—',
            securityProfile: securityPolicy.profile,
            permissionMode: permissionMode || '—',
            status: 'failed',
            seconds: totalAttemptSeconds + attemptResult.elapsedSeconds,
            turns: 0,
            cost: totalAttemptCost,
            attempts: attempt,
          });
          failStep(timeline, timelineIndex, attemptResult.error.message, `Step "${step.agent}" failed: ${attemptResult.error.message}`);
        }
        totalAttemptSeconds += attemptResult.elapsedSeconds;
        totalAttemptTurns += attemptResult.attemptTurns;
        totalAttemptCost += attemptResult.attemptCost;
        currentSnapshot = attemptResult.stepAfterSnapshot || currentSnapshot;

        const {
          stepWritesStart,
          attemptWrites,
          stepChanges,
          outputWarnings,
          parsedOutputSummary,
          rawOutputPath,
          parsed,
          text,
        } = attemptResult;

        if (step.require_changes && stepChanges.length === 0) {
          stats.push({
            agent: step.agent,
            provider,
            model: model || '—',
            runnerAgent: runnerAgent || '—',
            securityProfile: securityPolicy.profile,
            permissionMode: permissionMode || '—',
            status: 'failed',
            seconds: totalAttemptSeconds,
            turns: totalAttemptTurns,
            cost: totalAttemptCost,
            attempts: attempt,
            outputWarnings,
            parsedOutputs: parsedOutputSummary,
            rawOutputPath: rawOutputPath ? path.relative(cwd, rawOutputPath) : null,
          });
          failStep(
            timeline,
            timelineIndex,
            'no project changes',
            `Step "${step.agent}" requires project file changes but did not modify any tracked project file.`
          );
        }

        if (debug) {
          timeline.setPaused(timelineIndex, 'output review');
          const postDecision = await promptDebugPostStepDecision({
            step,
            stepNumber: i + 1,
            totalSteps: pipeline.steps.length,
            parsed,
            outputNames,
            stepWrites: attemptWrites,
            stepChanges,
            outputWarnings,
            rawText: text,
            rawOutputPath: rawOutputPath ? path.relative(cwd, rawOutputPath) : null,
            attempt,
            maxDebugReplays,
            cwd,
            timeline,
            shell,
            quiet,
            decisionFn: opts.debugPostDecision,
            debugEvents,
            getDiffPreview: getViolationDiffPreview,
          });

          const postAction = typeof postDecision === 'object' && postDecision
            ? postDecision.action
            : postDecision;

          if (postAction === 'abort') {
            stats.push({
              agent: step.agent,
              provider,
              model: model || '—',
              runnerAgent: runnerAgent || '—',
              securityProfile: securityPolicy.profile,
              permissionMode: permissionMode || '—',
              status: 'failed',
              seconds: totalAttemptSeconds,
              turns: totalAttemptTurns,
              cost: totalAttemptCost,
              attempts: attempt,
              outputWarnings,
              parsedOutputs: parsedOutputSummary,
              rawOutputPath: rawOutputPath ? path.relative(cwd, rawOutputPath) : null,
            });
            failStep(timeline, timelineIndex, 'aborted after output review', `Pipeline aborted after step "${step.agent}" output review.`);
          }
          if (postAction === 'replay') {
            if (attempt - 1 >= maxDebugReplays) {
              stats.push({
                agent: step.agent,
                provider,
                model: model || '—',
                runnerAgent: runnerAgent || '—',
                securityProfile: securityPolicy.profile,
                permissionMode: permissionMode || '—',
                status: 'failed',
                seconds: totalAttemptSeconds,
                turns: totalAttemptTurns,
                cost: totalAttemptCost,
                attempts: attempt,
                outputWarnings,
                parsedOutputs: parsedOutputSummary,
                rawOutputPath: rawOutputPath ? path.relative(cwd, rawOutputPath) : null,
              });
              failStep(
                timeline,
                timelineIndex,
                'replay limit reached',
                `Replay limit reached for step "${step.agent}" (${maxDebugReplays} per step).`
              );
            }
            const movedAttempt = await moveAttemptArtifactsToAttemptDir({
              cwd,
              stepDir,
              attempt,
              writes: attemptWrites,
              rawOutputPath: rawOutputPath ? path.relative(cwd, rawOutputPath) : null,
            });
            finalAttempt = { stepChanges, stepWrites: movedAttempt.writes };
            fileWrites.splice(stepWritesStart);
            replayInputOverride = typeof postDecision === 'object' && postDecision?.inputs
              ? postDecision.inputs
              : null;
            shouldReplay = true;
            continue;
          }
        }

      const totalElapsed = totalAttemptSeconds.toFixed(1);
      const costInfo = totalAttemptCost ? ` · $${totalAttemptCost.toFixed(4)}` : '';
      const turnInfo = totalAttemptTurns ? ` · ${totalAttemptTurns}t` : '';
      const attemptInfo = attempt > 1 ? ` · ${attempt} attempts` : '';
      timeline.setDone(timelineIndex, `${totalElapsed}s${attemptInfo}${turnInfo}${costInfo}`);
      timeline.logSuccess(`✓ ${step.agent} — ${totalElapsed}s${attemptInfo}${turnInfo}${costInfo}`);
      stats.push({
        agent: step.agent,
        provider,
        model: model || '—',
        runnerAgent: runnerAgent || '—',
        securityProfile: securityPolicy.profile,
        permissionMode: permissionMode || '—',
        status: 'done',
        seconds: totalAttemptSeconds,
        turns: totalAttemptTurns,
        cost: totalAttemptCost,
        attempts: attempt,
        outputWarnings,
        parsedOutputs: parsedOutputSummary,
        rawOutputPath: rawOutputPath ? path.relative(cwd, rawOutputPath) : null,
      });
      shouldReplay = false;
    } while (shouldReplay);
    }
  } catch (err) {
    runError = err;
  } finally {
    timeline.end();
    if (shell) shell.exitPipelineMode();
  }

  const finalSnapshot = dryRun ? null : await snapshotManager.captureState();
  const detectedDeliverables = dryRun ? [] : snapshotManager.detectChanges(beforeSnapshot, finalSnapshot);
  currentSnapshot = finalSnapshot || currentSnapshot;
  const runStatus = runError ? 'failed' : (dryRun ? 'dry-run' : 'done');

  if (runDir) {
    await writeRunManifest({
      runDir,
      runId,
      pipeline,
      cwd,
      stats,
      fileWrites,
      detectedDeliverables,
      status: runStatus,
      error: runError,
      debugEvents,
    });
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

  const out = quiet
    ? () => {}
    : shell
    ? (t) => shell.log(t)
    : (t) => console.log(stripBlessedTags(t));

  for (const line of renderRunSummary({
    stats,
    fileWrites: combinedWrites.map((f) => f.relPath),
    dryRun,
    runDir,
    cwd,
    runStatus,
  })) out(line);
  if (runError) {
    shell?.setMode?.('error');
    // One-line outcome banner: bold red marker + reason inline (instead of two stacked × lines).
    const reason = String(runError.message || 'unknown error').split('\n')[0];
    out(`{${S.error}-fg}{bold}✕ Pipeline failed{/}{${S.muted}-fg}  —  {/}{${S.error}-fg}${reason}{/}`);
    out('');
    throw runError;
  }
  shell?.setMode?.(null);
  out(dryRun
    ? `{${S.success}-fg}{bold}✓ Dry-run complete{/}`
    : `{${S.success}-fg}{bold}✓ Pipeline complete{/}`);
  out('');
}
