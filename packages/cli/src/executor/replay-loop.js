import {
  buildUserMessage,
  resolveDebugInputOverridesFromEdit,
} from './inputs.js';
import {
  debugToken,
  editDebugInputs,
  formatDebugList,
  logDebugPromptPreview,
  pushDebugEvent,
} from './debug-loop.js';

/** @typedef {import('../types.js').InputDef} InputDef */
/** @typedef {import('../types.js').FileWrite} FileWrite */
/** @typedef {import('../types.js').PipelineStep} PipelineStep */
/** @typedef {import('../types.js').ProviderId} ProviderId */
/** @typedef {import('../types.js').RunStat} RunStat */
/** @typedef {import('../types.js').SecurityPolicy} SecurityPolicy */
/** @typedef {import('../types.js').SnapshotChange} SnapshotChange */
/** @typedef {import('../types.js').SnapshotManagerLike} SnapshotManagerLike */
/** @typedef {import('../types.js').SnapshotState} SnapshotState */
/** @typedef {import('../types.js').TimelineController} TimelineController */

/**
 * @param {object} options
 * @param {number} options.attempt
 * @param {{ stepChanges?: SnapshotChange[], stepWrites?: FileWrite[] } | null} options.finalAttempt
 * @param {{ snapshotDir: string, captured: Set<string>, skippedLarge: string[], skippedBinary: string[], skippedIgnored: string[] } | null} options.stepSnapshot
 * @param {SnapshotManagerLike & { restore: (options: { snapshot: any, originalPaths: Set<string>, changes: SnapshotChange[] }) => Promise<{ restored: string[], removed: string[], skipped: string[] }> }} options.snapshotManager
 * @param {Set<string>} options.stepOriginalPaths
 * @param {Map<string, string | undefined>} options.stepRegistrySnapshot
 * @param {Record<string, string>} options.registry
 * @param {Record<string, string>} options.replayInputs
 * @param {Record<string, string> | null} options.replayInputOverride
 * @param {PipelineStep} options.step
 * @param {any[]} options.debugEvents
 * @param {InputDef[]} options.inputDefs
 * @param {TimelineController} options.timeline
 * @param {any} options.shell
 * @param {string[]} options.outputNames
 * @param {(attempt: number) => { projectRoot: string, stepDirRel: string } | null} options.workspaceInfoForAttempt
 * @param {string} options.systemPrompt
 * @param {SecurityPolicy} options.securityPolicy
 * @param {Record<string, string>} options.debugInputOverrides
 * @param {SnapshotState | null} options.currentSnapshot
 * @param {RunStat[]} options.stats
 * @param {ProviderId | 'system'} options.provider
 * @param {string | null} options.model
 * @param {string | null} options.runnerAgent
 * @param {string} options.permissionMode
 * @param {number} options.totalAttemptSeconds
 * @param {number} options.totalAttemptTurns
 * @param {number} options.totalAttemptCost
 * @param {number} options.timelineIndex
 * @param {(timeline: TimelineController, timelineIndex: number, info: string, message: string) => never} options.failStep
 */
export async function prepareReplayAttempt({
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
}) {
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
        `Replay restore failed before step "${step.agent}" attempt ${attempt}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  for (const [key, previousValue] of stepRegistrySnapshot) {
    if (previousValue === undefined) delete registry[key];
    else registry[key] = previousValue;
  }

  const editedInputs = new Set();
  const replayBaseInputs = replayInputs;
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

  return {
    attempt,
    replayInputs,
    replayInputOverride,
    currentSnapshot,
  };
}
