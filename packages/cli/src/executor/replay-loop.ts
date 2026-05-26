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
import type {
  DebugEvent,
  FileWrite,
  InputDef,
  PipelineStep,
  ProviderId,
  RunStat,
  SecurityPolicy,
  SnapshotChange,
  SnapshotManagerLike,
  SnapshotState,
  TimelineController,
} from '../types.js';
import type { StepSnapshot } from './snapshot-manager.js';

type FinalAttempt = {
  stepChanges?: SnapshotChange[];
  stepWrites?: FileWrite[];
} | null;

type RestoringSnapshotManager = SnapshotManagerLike & {
  restore(options: {
    snapshot: StepSnapshot;
    originalPaths: Set<string>;
    changes: SnapshotChange[];
  }): Promise<{ restored: string[], removed: string[], skipped: string[] }>;
};

type WorkspaceInfo = {
  projectRoot: string;
  stepDirRel: string;
};

type PrepareReplayAttemptOptions = {
  attempt: number;
  finalAttempt: FinalAttempt;
  stepSnapshot: StepSnapshot | null;
  snapshotManager: RestoringSnapshotManager;
  stepOriginalPaths: Set<string>;
  stepRegistrySnapshot: Map<string, string | undefined>;
  registry: Record<string, string>;
  replayInputs: Record<string, string>;
  replayInputOverride: Record<string, string> | null;
  step: PipelineStep;
  debugEvents: DebugEvent[];
  inputDefs: InputDef[];
  timeline: TimelineController;
  shell: any;
  outputNames: string[];
  workspaceInfoForAttempt(attempt: number): WorkspaceInfo | null;
  systemPrompt: string;
  securityPolicy: SecurityPolicy;
  debugInputOverrides: Record<string, string>;
  currentSnapshot: SnapshotState | null;
  stats: RunStat[];
  provider: ProviderId | 'system';
  model: string | null;
  runnerAgent: string | null;
  permissionMode: string;
  totalAttemptSeconds: number;
  totalAttemptTurns: number;
  totalAttemptCost: number;
  timelineIndex: number;
  failStep(timeline: TimelineController, timelineIndex: number, info: string, message: string): never;
};

type PrepareReplayAttemptResult = {
  attempt: number;
  replayInputs: Record<string, string>;
  replayInputOverride: Record<string, string> | null;
  currentSnapshot: SnapshotState | null;
};

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
}: PrepareReplayAttemptOptions): Promise<PrepareReplayAttemptResult> {
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

  const editedInputs = new Set<string>();
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
