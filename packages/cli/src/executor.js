import fs from 'node:fs/promises';
import path from 'node:path';
import { parseAgentFileDetailed } from './parser.js';
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
  writeLatestRunPointer,
  writeRunManifest,
} from './executor/run-report.js';
import {
  getViolationDiffPreview,
  handlePostRunViolations,
} from './executor/security-review.js';
import {
  collectPipelineInputs,
  createRunTimeline,
  createRunWorkspace,
  isNonInteractiveRuntime,
  loadPipeline,
  logRunStart,
  resolveProjectRoot,
} from './executor/run-setup.js';
import {
  prepareReplayAttempt,
} from './executor/replay-loop.js';

export { detectSnapshotChanges } from './executor/snapshot-manager.js';
export { validatePostRunChanges } from './executor/step-runner.js';
export { loadPipeline } from './executor/run-setup.js';

function failStep(timeline, index, shortMessage, fullMessage = shortMessage) {
  timeline.setError(index, String(shortMessage).slice(0, 60));
  throw new Error(fullMessage);
}

function stripBlessedTags(s) {
  return String(s || '').replace(/\{[^}]+\}/g, '');
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
  const nonInteractive = isNonInteractiveRuntime({ shell, nonInteractive: opts.nonInteractive });
  const maxDebugReplays = Number.isInteger(opts.maxDebugReplays)
    ? Math.max(0, opts.maxDebugReplays)
    : DEFAULT_MAX_DEBUG_REPLAYS;
  const securityConfig = await loadProjectSecurityConfig(cwd);
  const snapshotManager = dryRun ? null : await SnapshotManager.create({ root: cwd });
  const beforeSnapshot = dryRun ? null : await snapshotManager.captureState();
  let currentSnapshot = beforeSnapshot;

  const { runId, runDir } = await createRunWorkspace({ cwd, pipeline, dryRun, debug });
  logRunStart({ pipeline, cwd, runDir, dryRun, debug, shell, quiet });
  const { inputDefs, inputValues } = await collectPipelineInputs({ pipeline, dryRun, shell, nonInteractive, quiet });
  const timeline = createRunTimeline({ pipeline, quiet, shell, nonInteractive });

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
          const replayState = await prepareReplayAttempt({
            attempt,
            finalAttempt,
            stepSnapshot,
            snapshotManager,
            stepOriginalPaths,
            stepRegistrySnapshot,
            registry,
            replayInputs,
            replayInputOverride,
            step,
            debugEvents,
            inputDefs,
            timeline,
            shell,
            outputNames,
            workspaceInfoForAttempt,
            systemPrompt,
            securityPolicy,
            debugInputOverrides,
            currentSnapshot,
            stats,
            provider,
            model,
            runnerAgent,
            permissionMode,
            totalAttemptSeconds,
            totalAttemptTurns,
            totalAttemptCost,
            timelineIndex,
            failStep,
          });
          attempt = replayState.attempt;
          replayInputs = replayState.replayInputs;
          replayInputOverride = replayState.replayInputOverride;
          currentSnapshot = replayState.currentSnapshot;
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
    await writeLatestRunPointer({ cwd, runId });
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
