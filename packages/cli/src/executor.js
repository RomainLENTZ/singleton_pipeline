import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { input } from '@inquirer/prompts';
import { parseAgentFileDetailed } from './parser.js';
import { style, line } from './theme.js';
import { createTimeline } from './timeline.js';
import { S } from './shell.js';
import { getRunner } from './runners/index.js';
import {
  assertWriteAllowed,
  loadProjectSecurityConfig,
  resolveSecurityPolicyWithConfig,
} from './security/policy.js';
import {
  detectSnapshotChanges,
  formatSnapshotCoverage,
  SnapshotManager,
} from './executor/snapshot-manager.js';
import {
  buildUserMessage,
  collectInputValues,
  resolveDebugInputOverridesFromEdit,
  resolveInput,
} from './executor/inputs.js';
import {
  assertRunArtifactWriteAllowed,
  isInsidePath,
  moveAttemptArtifactsToAttemptDir,
  parseOutputs,
  rewriteInternalSink,
  summarizeParsedOutputs,
  writeRawOutputArtifact,
} from './executor/outputs.js';
import {
  resolveModel,
  resolvePermissionMode,
  resolveProvider,
  resolveRunnerAgent,
  runPreflightChecks,
} from './executor/preflight.js';

export { detectSnapshotChanges } from './executor/snapshot-manager.js';

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
    setRunning() {},
    setPaused() {},
    setDone() {},
    setError() {},
    end() {},
  };
}

function formatStepRuntimeMeta({ provider, model, permissionMode, securityProfile }) {
  const parts = [];
  if (provider) parts.push(provider);
  if (model) parts.push(model);
  if (securityProfile) parts.push(`security:${securityProfile}`);
  if (permissionMode) parts.push(`perm:${permissionMode}`);
  return parts.join(' · ');
}

function previewValue(value, max = 140) {
  const compact = String(value || '').replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact || '—';
  return `${compact.slice(0, max - 1)}…`;
}

// Semantic tokens for debug field formatting.
//   key       — labels ("inputs:", "system prompt:")
//   identity  — positive resolved values ("found", chars/lines counts)
//   text      — neutral readable values
//   path      — file paths and URIs
//   policy    — attention values ("missing", security notes)
//   muted     — fallback or secondary info
const debugToken = {
  key: (value) => `{${S.accent}-fg}{bold}${value}:{/}`,
  identity: (value) => `{${S.success}-fg}${value || '—'}{/}`,
  text: (value) => `{${S.text}-fg}${value || '—'}{/}`,
  path: (value) => `{${S.string}-fg}${value || '—'}{/}`,
  policy: (value) => `{${S.warning}-fg}${value || '—'}{/}`,
  muted: (value) => `{${S.muted}-fg}${value || '—'}{/}`,
};

// Action semantics for debug toolbars:
//   continue → success | inspect/output → keyword (observe)
//   edit/diff → warning (modifies)  | skip/replay → accent (neutral action)
//   abort → error
const DEBUG_ACTION_PROMPT = [
  `{${S.text}-fg}{bold}Debug action{/}`,
  `{${S.success}-fg}▶ continue{/}{${S.subtle}-fg}(c){/}`,
  `{${S.keyword}-fg}? inspect{/}{${S.subtle}-fg}(i){/}`,
  `{${S.warning}-fg}✎ edit{/}{${S.subtle}-fg}(e){/}`,
  `{${S.accent}-fg}→ skip{/}{${S.subtle}-fg}(s){/}`,
  `{${S.error}-fg}■ abort{/}{${S.subtle}-fg}(a){/}`,
].join(` {${S.subtle}-fg}·{/} `);

const DEBUG_ACTION_HELP = [
  `{${S.text}-fg}Choose{/}`,
  `{${S.success}-fg}▶ continue{/}`,
  `{${S.keyword}-fg}? inspect{/}`,
  `{${S.warning}-fg}✎ edit{/}`,
  `{${S.accent}-fg}→ skip{/}`,
  `{${S.error}-fg}■ abort{/}`,
].join(` {${S.subtle}-fg}·{/} `);

const DEBUG_POST_ACTION_PROMPT = [
  `{${S.text}-fg}{bold}Debug output{/}`,
  `{${S.success}-fg}▶ continue{/}{${S.subtle}-fg}(c){/}`,
  `{${S.keyword}-fg}? output{/}{${S.subtle}-fg}(o){/}`,
  `{${S.keyword}-fg}raw output{/}{${S.subtle}-fg}(r){/}`,
  `{${S.warning}-fg}± diff{/}{${S.subtle}-fg}(d){/}`,
  `{${S.accent}-fg}↻ replay{/}{${S.subtle}-fg}(p){/}`,
  `{${S.error}-fg}■ abort{/}{${S.subtle}-fg}(a){/}`,
].join(` {${S.subtle}-fg}·{/} `);

const DEBUG_POST_ACTION_HELP = [
  `{${S.text}-fg}Choose{/}`,
  `{${S.success}-fg}▶ continue{/}`,
  `{${S.keyword}-fg}? output{/}`,
  `{${S.keyword}-fg}raw output{/}`,
  `{${S.warning}-fg}± diff{/}`,
  `{${S.accent}-fg}↻ replay{/}`,
  `{${S.error}-fg}■ abort{/}`,
].join(` {${S.subtle}-fg}·{/} `);

const DEFAULT_MAX_DEBUG_REPLAYS = 3;

function logDebugSection(title, timeline) {
  const width = 72;
  const text = ` ${title} `;
  const left = Math.max(0, Math.floor((width - text.length) / 2));
  const right = Math.max(0, width - text.length - left);
  timeline.logMuted(' ');
  timeline.logMuted(' ');
  timeline.log(`{${S.subtle}-fg}${'─'.repeat(left)}{/}{${S.accent}-fg}{bold}${text}{/}{${S.subtle}-fg}${'─'.repeat(right)}{/}`);
  timeline.logMuted(' ');
  timeline.logMuted(' ');
}

function formatDebugList(values, fallback = 'none') {
  if (!values.length) return debugToken.muted(fallback);
  return values.map((value) => debugToken.identity(value)).join(` ${debugToken.muted('·')} `);
}

function pushDebugEvent(events, event) {
  if (!Array.isArray(events)) return;
  const { systemPrompt: _systemPrompt, workspaceInfo: _workspaceInfo, ...safeEvent } = event || {};
  events.push({
    timestamp: new Date().toISOString(),
    ...safeEvent,
  });
}

function looksLikePath(value) {
  const text = String(value || '').trim();
  return /^\.{0,2}\//.test(text) || /^[\w.-]+\/[\w./-]+$/.test(text) || /\.[a-z0-9]{1,8}$/i.test(text);
}

function debugValue(value, kind = 'text') {
  if (!value || value === '—') return debugToken.muted('—');
  if (kind === 'identity') return debugToken.identity(value);
  if (kind === 'path') return debugToken.path(value);
  if (kind === 'policy') return debugToken.policy(value);
  return debugToken.text(value);
}

function debugLine(label, value, kind = 'text') {
  return `${debugToken.key(label)} ${debugValue(value, kind)}`;
}

function isPromptCancelled(value) {
  return value === '__SINGLETON_ESC__';
}

function logDebugInputs(resolvedInputs, timeline) {
  const entries = Object.entries(resolvedInputs);
  if (entries.length) {
    timeline.logMuted(debugToken.key('inputs'));
    for (const [name, value] of entries) {
      const preview = previewValue(value);
      timeline.logMuted(
        `  ${debugToken.muted('·')} ${debugToken.key(name)} ` +
        `${debugValue(preview, looksLikePath(preview) ? 'path' : 'text')}`
      );
    }
  } else {
    timeline.logMuted(`${debugToken.key('inputs')} ${debugToken.muted('none')}`);
  }
}

function markEditedInputTags(line, editedInputs = new Set()) {
  let text = String(line || ' ');
  for (const name of editedInputs) {
    const open = new RegExp(`<${name}>`, 'g');
    text = text.replace(open, `<${name} debug-edited="true">`);
  }
  return text;
}

function debugPromptTextLine(line, { editedInputs = new Set() } = {}) {
  const text = markEditedInputTags(line || ' ', editedInputs);
  const tagPattern = /(<\/?[A-Za-z_][\w.-]*(?:\s+[^>]*)?>)/g;
  const parts = text.split(tagPattern);
  return parts.map((part) => {
    if (!part) return '';
    const isTag = tagPattern.test(part);
    tagPattern.lastIndex = 0;
    if (isTag) {
      const isVariableTag = /^<\/?(workspace|security_policy|file)\b/i.test(part) === false;
      // Variable tags = interpolated user data (warning-toned, watch what gets in).
      // System tags = structural (workspace, security_policy, file) keyword-toned.
      const color = isVariableTag ? S.warning : S.keyword;
      tagPattern.lastIndex = 0;
      return `{${color}-fg}{bold}${part}{/}`;
    }
    return `{${S.text}-fg}${part}{/}`;
  }).join('');
}

function logDebugPromptPreview({ systemPrompt, userMessage, timeline, editedInputs = new Set() }) {
  logDebugSection('Debug prompt preview', timeline);
  if (editedInputs.size) {
    timeline.logMuted(`${debugToken.key('edited inputs')} ${formatDebugList([...editedInputs])}`);
    timeline.logMuted(`${debugToken.policy('Editing one input may not override other inputs or the agent prompt. Inspect the final prompt before continuing.')}`);
    timeline.logMuted(' ');
  }
  timeline.logMuted(debugToken.key('system prompt'));
  for (const line of systemPrompt.split('\n')) {
    timeline.logMuted(`  ${debugPromptTextLine(line, { editedInputs })}`);
  }
  timeline.logMuted(' ');
  timeline.logMuted(' ');
  timeline.logMuted(debugToken.key('user message'));
  for (const line of userMessage.split('\n')) {
    timeline.logMuted(`  ${debugPromptTextLine(line, { editedInputs })}`);
  }
}

function validateParsedOutputs(parsed, outputNames) {
  const warnings = [];
  for (const name of outputNames) {
    const value = String(parsed[name] || '').trim();
    if (!value) warnings.push(`output "${name}" is empty`);
  }
  return warnings;
}

function logDebugOutputs(parsed, outputNames, timeline) {
  logDebugSection('Debug parsed outputs', timeline);
  const summaries = summarizeParsedOutputs(parsed, outputNames);
  for (const summary of summaries) {
    const status = summary.found ? debugToken.identity('found') : debugToken.policy('missing');
    timeline.logMuted(
      `${debugToken.key(summary.name)} ${status} ` +
      `${debugToken.muted('·')} ${debugValue(`${summary.chars} chars`, 'identity')} ` +
      `${debugToken.muted('·')} ${debugValue(`${summary.lines} lines`, 'identity')}`
    );
    const name = summary.name;
    const lines = String(parsed[name] || '').split('\n');
    for (const line of lines) {
      timeline.logMuted(`  ${debugPromptTextLine(line)}`);
    }
    timeline.logMuted(' ');
  }
}

function uniqueDebugPaths(entries) {
  const out = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!entry?.relPath || seen.has(entry.relPath)) continue;
    seen.add(entry.relPath);
    out.push(entry);
  }
  return out;
}

async function logDebugDiffs({ changes, writes = [], cwd, timeline }) {
  logDebugSection('Debug step diff', timeline);
  const entries = uniqueDebugPaths([...changes, ...writes]);
  if (!entries.length) {
    timeline.logMuted(`${debugToken.key('changes')} ${debugToken.muted('none')}`);
    return;
  }

  for (const change of entries.slice(0, 8)) {
    timeline.log(`${debugToken.key(change.relPath)}`);
    const preview = await getViolationDiffPreview(cwd, change.relPath);
    for (const line of preview) timeline.logMuted(`  ${line}`);
  }
  if (entries.length > 8) {
    timeline.logMuted(`${debugToken.muted(`... ${entries.length - 8} more changed file(s)`)}`);
  }
}

function logSnapshotCoverage({ snapshot, timeline }) {
  if (!snapshot) return;
  const details = formatSnapshotCoverage(snapshot);
  if (!details.length) return;
  timeline.logMuted(`${debugToken.key('replay snapshot coverage')} ${formatDebugList(details, 'none')}`);
  if (snapshot.skippedLarge.length || snapshot.skippedBinary.length || snapshot.skippedIgnored.length) {
    timeline.logMuted(debugToken.policy('Replay rollback is not fully guaranteed if a skipped file is modified.'));
  }
}

async function promptDebugPostStepDecision({
  step,
  parsed,
  outputNames,
  stepWrites,
  stepChanges,
  outputWarnings,
  rawText,
  rawOutputPath,
  attempt,
  maxDebugReplays,
  cwd,
  timeline,
  shell,
  quiet,
  decisionFn,
  debugEvents,
}) {
  const summary = {
    agent: step.agent,
    outputs: outputNames,
    parsedOutputs: summarizeParsedOutputs(parsed, outputNames),
    outputWarnings,
    rawOutputPath: rawOutputPath || null,
    writtenFiles: stepWrites.map((entry) => entry.relPath),
    changedFiles: stepChanges.map((entry) => entry.relPath),
  };

  if (decisionFn) {
    const decision = await decisionFn(summary);
    if (typeof decision === 'object' && decision) {
      const action = String(decision.action || 'continue').trim().toLowerCase() || 'continue';
      pushDebugEvent(debugEvents, { step: step.agent, phase: 'post-step', action, ...summary });
      return {
        action,
        inputs: decision.inputs && typeof decision.inputs === 'object' ? decision.inputs : null,
      };
    }
    const action = String(decision || 'continue').trim().toLowerCase() || 'continue';
    pushDebugEvent(debugEvents, { step: step.agent, phase: 'post-step', action, ...summary });
    return action;
  }
  if (quiet) {
    pushDebugEvent(debugEvents, { step: step.agent, phase: 'post-step', action: 'continue', ...summary });
    return 'continue';
  }

  logDebugSection('Debug output review', timeline);
  timeline.logMuted(debugLine('agent', step.agent, 'identity'));
  timeline.logMuted(`${debugToken.key('outputs')} ${formatDebugList(outputNames)}`);
  timeline.logMuted(`${debugToken.key('written files')} ${formatDebugList(stepWrites.map((entry) => entry.relPath))}`);
  timeline.logMuted(`${debugToken.key('changed files')} ${formatDebugList(stepChanges.map((entry) => entry.relPath))}`);
  if (outputWarnings.length) {
    timeline.logMuted(`${debugToken.key('warnings')} ${debugToken.policy(outputWarnings.join(' · '))}`);
  } else {
    timeline.logMuted(`${debugToken.key('warnings')} ${debugToken.muted('none')}`);
  }

  while (true) {
    const raw = shell
      ? await shell.prompt(DEBUG_POST_ACTION_PROMPT)
      : await input({ message: 'Debug output: continue, output, raw output, diff, replay, or abort? (c/o/r/d/p/a)', default: 'c' });
    if (isPromptCancelled(raw)) {
      timeline.logMuted(`${debugToken.muted('Cancelled. Back to debug output menu.')}`);
      continue;
    }
    const answer = String(raw || '').trim().toLowerCase();
    if (!answer || answer === 'c' || answer === 'continue') {
      pushDebugEvent(debugEvents, { step: step.agent, phase: 'post-step', action: 'continue', ...summary });
      return 'continue';
    }
    if (answer === 'a' || answer === 'abort' || answer === 'stop') {
      pushDebugEvent(debugEvents, { step: step.agent, phase: 'post-step', action: 'abort', ...summary });
      return 'abort';
    }
    if (answer === 'o' || answer === 'output' || answer === 'inspect') {
      pushDebugEvent(debugEvents, { step: step.agent, phase: 'post-step', action: 'inspect-output', ...summary });
      logDebugOutputs(parsed, outputNames, timeline);
      continue;
    }
    if (answer === 'r' || answer === 'raw' || answer === 'raw output') {
      pushDebugEvent(debugEvents, { step: step.agent, phase: 'post-step', action: 'inspect-raw-output', ...summary });
      logDebugSection('Debug raw output', timeline);
      if (rawOutputPath) timeline.logMuted(`${debugToken.key('saved')} ${debugValue(rawOutputPath, 'path')}`);
      const lines = String(rawText || '').split('\n');
      for (const line of lines.slice(0, 120)) timeline.logMuted(`  ${debugPromptTextLine(line)}`);
      if (lines.length > 120) timeline.logMuted(`${debugToken.muted(`... ${lines.length - 120} more line(s)`)}`);
      continue;
    }
    if (answer === 'd' || answer === 'diff') {
      pushDebugEvent(debugEvents, { step: step.agent, phase: 'post-step', action: 'inspect-diff', ...summary });
      await logDebugDiffs({ changes: stepChanges, writes: stepWrites, cwd, timeline });
      continue;
    }
    if (answer === 'p' || answer === 'replay' || answer === 'retry') {
      const usedReplays = Math.max(0, Number(attempt || 1) - 1);
      if (usedReplays >= maxDebugReplays) {
        timeline.logMuted(`${debugToken.policy(`Replay limit reached (${maxDebugReplays} per step).`)}`);
        continue;
      }
      if (stepWrites.length || stepChanges.length) {
        logDebugSection('Replay soft warning', timeline);
        timeline.logMuted(`${debugToken.policy('Replay restores detected project file changes only.')}`);
        const written = stepWrites.map((entry) => entry.relPath);
        const changed = stepChanges.map((entry) => entry.relPath);
        timeline.logMuted(`${debugToken.key('already written')} ${formatDebugList(written)}`);
        timeline.logMuted(`${debugToken.key('already changed')} ${formatDebugList(changed)}`);
        timeline.logMuted(`${debugToken.muted('Previous run artifacts stay in their attempt folder for traceability.')}`);
        timeline.logMuted(`${debugToken.muted('Skipped folders such as .git, node_modules, dist, build, and .next are not restored.')}`);
        timeline.logMuted(`${debugToken.muted('External side effects such as commits, pushes, PRs, shell state, or network calls are not rolled back.')}`);
      }
      pushDebugEvent(debugEvents, { step: step.agent, phase: 'post-step', action: 'replay', ...summary });
      return 'replay';
    }
    timeline.logMuted(DEBUG_POST_ACTION_HELP);
  }
}

async function editDebugInputs({ resolvedInputs, shell, timeline, step, debugEvents, editedInputs }) {
  const names = Object.keys(resolvedInputs);
  if (names.length === 0) {
    timeline.logMuted('No inputs to edit.');
    return resolvedInputs;
  }

  logDebugSection('Debug edit inputs', timeline);
  timeline.logMuted(`Type an input name to override it. Empty input name returns to debug review.`);
  timeline.logMuted(`${debugToken.policy('Warning: editing one input may not override other inputs or the agent prompt.')}`);
  timeline.logMuted(`${debugToken.policy('Use inspect after editing to verify the final prompt.')}`);
  timeline.logMuted(' ');
  const nextInputs = { ...resolvedInputs };

  while (true) {
    const rawName = shell
      ? await shell.prompt(`Input to edit (${names.join(', ')})`)
      : await input({ message: `Input to edit (${names.join(', ')})` });
    if (isPromptCancelled(rawName)) {
      timeline.logMuted(`${debugToken.muted('Edit cancelled. Back to debug menu.')}`);
      return nextInputs;
    }
    const name = String(rawName || '').trim();
    if (!name) return nextInputs;
    if (!Object.hasOwn(nextInputs, name)) {
      timeline.logMuted(`Unknown input "${name}".`);
      continue;
    }

    const current = previewValue(nextInputs[name], 220);
    timeline.logMuted(`${debugToken.key(name)} current: ${debugValue(current, looksLikePath(current) ? 'path' : 'text')}`);
    const value = shell
      ? await shell.prompt(`New value for ${name}`)
      : await input({ message: `New value for ${name}`, default: String(nextInputs[name] || '') });
    if (isPromptCancelled(value)) {
      timeline.logMuted(`${debugToken.muted('Value edit cancelled. Back to input selection.')}`);
      continue;
    }
    nextInputs[name] = String(value || '');
    if (editedInputs) editedInputs.add(name);
    pushDebugEvent(debugEvents, {
      step: step?.agent,
      phase: 'pre-step',
      action: 'edit-input',
      input: name,
      previousPreview: previewValue(current, 120),
      nextPreview: previewValue(nextInputs[name], 120),
    });
    timeline.logMuted(`${debugToken.key(name)} updated.`);
  }
}

async function promptDebugStepDecision({
  step,
  stepNumber,
  totalSteps,
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
  decisionFn,
  debugEvents,
}) {
  const summary = {
    agent: step.agent,
    stepNumber,
    totalSteps,
    provider,
    model,
    runnerAgent,
    permissionMode,
    securityProfile: securityPolicy.profile,
    inputs: Object.keys(resolvedInputs),
    outputs: outputNames,
    systemPrompt,
    workspaceInfo,
  };

  if (decisionFn) {
    const decision = await decisionFn(summary);
    if (typeof decision === 'object' && decision) {
      const action = String(decision.action || 'continue').trim().toLowerCase();
      const nextInputs = decision.inputs && typeof decision.inputs === 'object' ? decision.inputs : resolvedInputs;
      const editedInputs = Object.keys(nextInputs).filter((name) => nextInputs[name] !== resolvedInputs[name]);
      pushDebugEvent(debugEvents, { step: step.agent, phase: 'pre-step', action, editedInputs, ...summary });
      return {
        action,
        inputs: nextInputs,
      };
    }
    const action = String(decision || 'continue').trim().toLowerCase() || 'continue';
    pushDebugEvent(debugEvents, { step: step.agent, phase: 'pre-step', action, ...summary });
    return {
      action,
      inputs: resolvedInputs,
    };
  }
  if (quiet) {
    pushDebugEvent(debugEvents, { step: step.agent, phase: 'pre-step', action: 'continue', ...summary });
    return { action: 'continue', inputs: resolvedInputs };
  }

  let currentInputs = { ...resolvedInputs };
  const editedInputs = new Set();

  logDebugSection('Debug step review', timeline);
  timeline.logMuted(debugLine('step', `${stepNumber}/${totalSteps}`));
  timeline.logMuted(debugLine('agent', step.agent, 'identity'));
  timeline.logMuted(debugLine('provider', provider, 'identity'));
  timeline.logMuted(debugLine('model', model || '—', 'identity'));
  if (runnerAgent) timeline.logMuted(debugLine('runner_agent', runnerAgent, 'identity'));
  timeline.logMuted(debugLine('security', securityPolicy.profile, 'policy'));
  timeline.logMuted(debugLine('permission', permissionMode || '—', 'policy'));
  timeline.logMuted(
    `${debugToken.key('outputs')} ${outputNames.length ? outputNames.map((name) => debugToken.identity(name)).join(` ${debugToken.muted('·')} `) : debugToken.muted('none')}`
  );
  logDebugInputs(currentInputs, timeline);

  while (true) {
    const raw = shell
      ? await shell.prompt(DEBUG_ACTION_PROMPT)
      : await input({ message: 'Debug: continue, inspect, edit, skip, or abort? (c/i/e/s/a)', default: 'c' });
    if (isPromptCancelled(raw)) {
      timeline.logMuted(`${debugToken.muted('Cancelled. Back to debug action menu.')}`);
      continue;
    }
    const answer = String(raw || '').trim().toLowerCase();
    if (!answer || answer === 'c' || answer === 'continue') {
      pushDebugEvent(debugEvents, { step: step.agent, phase: 'pre-step', action: 'continue', ...summary });
      return { action: 'continue', inputs: currentInputs };
    }
    if (answer === 's' || answer === 'skip') {
      pushDebugEvent(debugEvents, { step: step.agent, phase: 'pre-step', action: 'skip', ...summary });
      return { action: 'skip', inputs: currentInputs };
    }
    if (answer === 'a' || answer === 'abort' || answer === 'stop') {
      pushDebugEvent(debugEvents, { step: step.agent, phase: 'pre-step', action: 'abort', ...summary });
      return { action: 'abort', inputs: currentInputs };
    }
    if (answer === 'i' || answer === 'inspect') {
      pushDebugEvent(debugEvents, { step: step.agent, phase: 'pre-step', action: 'inspect-prompt', ...summary });
      logDebugPromptPreview({
        systemPrompt: summary.systemPrompt,
        userMessage: buildUserMessage(currentInputs, outputNames, summary.workspaceInfo, securityPolicy),
        timeline,
        editedInputs,
      });
      continue;
    }
    if (answer === 'e' || answer === 'edit') {
      pushDebugEvent(debugEvents, { step: step.agent, phase: 'pre-step', action: 'open-edit-inputs', ...summary });
      currentInputs = await editDebugInputs({ resolvedInputs: currentInputs, shell, timeline, step, debugEvents, editedInputs });
      logDebugInputs(currentInputs, timeline);
      if (editedInputs.size) {
        const inspectAnswer = shell
          ? await shell.prompt(`{${S.text}-fg}Inspect final prompt now?{/} {${S.success}-fg}yes{/}{${S.subtle}-fg}(y){/} {${S.subtle}-fg}or{/} {${S.subtle}-fg}no(n){/}`)
          : await input({ message: 'Inspect final prompt now? (y/N)', default: 'n' });
        if (isPromptCancelled(inspectAnswer)) {
          timeline.logMuted(`${debugToken.muted('Inspect prompt cancelled.')}`);
          continue;
        }
        if (['y', 'yes'].includes(String(inspectAnswer || '').trim().toLowerCase())) {
          pushDebugEvent(debugEvents, { step: step.agent, phase: 'pre-step', action: 'inspect-prompt-after-edit', editedInputs: [...editedInputs], ...summary });
          logDebugPromptPreview({
            systemPrompt: summary.systemPrompt,
            userMessage: buildUserMessage(currentInputs, outputNames, summary.workspaceInfo, securityPolicy),
            timeline,
            editedInputs,
          });
        }
      }
      continue;
    }
    timeline.logMuted(DEBUG_ACTION_HELP);
  }
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

function formatPolicyLabel({ securityProfile, permissionMode }) {
  const policy = securityProfile || '—';
  return permissionMode && permissionMode !== '—' ? `${policy} · perm:${permissionMode}` : policy;
}

function renderRunSummary({ stats, fileWrites, dryRun, runDir, cwd, runStatus = null }) {
  const totalSeconds = stats.reduce((sum, s) => sum + (s.seconds || 0), 0);
  const totalCost = stats.reduce((sum, s) => sum + (s.cost || 0), 0);
  const totalTurns = stats.reduce((sum, s) => sum + (s.turns || 0), 0);

  const rows = stats.map((s, i) => ({
    step: String(i + 1),
    agent: s.agent,
    provider: s.provider || '—',
    model: s.model || '—',
    policy: formatPolicyLabel({ securityProfile: s.securityProfile, permissionMode: s.permissionMode }),
    status: s.status,
    attempts: s.attempts && s.attempts > 1 ? String(s.attempts) : '—',
    time: s.status === 'dry-run' || s.status === 'skipped' ? '—' : formatSeconds(s.seconds),
    turns: formatTurns(s.turns),
    cost: formatCost(s.cost),
  }));

  const totalRow = {
    step: '',
    agent: 'TOTAL',
    provider: '—',
    model: '—',
    policy: '—',
    status: runStatus || (dryRun ? 'dry-run' : 'done'),
    attempts: '—',
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
    policy: Math.max(6, ...allRows.map((r) => visibleLength(r.policy))),
    status: Math.max(6, ...allRows.map((r) => visibleLength(r.status))),
    attempts: Math.max(8, ...allRows.map((r) => visibleLength(r.attempts))),
    time: Math.max(4, ...allRows.map((r) => visibleLength(r.time))),
    turns: Math.max(5, ...allRows.map((r) => visibleLength(r.turns))),
    cost: Math.max(4, ...allRows.map((r) => visibleLength(r.cost))),
  };

  const hr = [
    '─'.repeat(widths.step + 2),
    '─'.repeat(widths.agent + 2),
    '─'.repeat(widths.provider + 2),
    '─'.repeat(widths.model + 2),
    '─'.repeat(widths.policy + 2),
    '─'.repeat(widths.status + 2),
    '─'.repeat(widths.attempts + 2),
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
      ` ${padVisible(r.policy, widths.policy)} `,
      ` ${padVisible(r.status, widths.status)} `,
      ` ${padVisible(r.attempts, widths.attempts, 'right')} `,
      ` ${padVisible(r.time, widths.time, 'right')} `,
      ` ${padVisible(r.turns, widths.turns, 'right')} `,
      ` ${padVisible(r.cost, widths.cost, 'right')} `,
    ].join('│');
  }

  const lines = [
    '',
    '{bold}Summary{/}',
    '',
    row({ step: '#', agent: 'Agent', provider: 'Provider', model: 'Model', policy: 'Policy', status: 'Status', attempts: 'Attempts', time: 'Time', turns: 'Turns', cost: 'Cost' }),
    hr,
    ...rows.map(row),
    hr,
    row(totalRow),
    '',
  ];

  if (runDir) {
    lines.push(`Run: {${S.string}-fg}${path.relative(cwd, runDir)}{/}`);
  }

  if (fileWrites.length) {
    lines.push('', '{bold}Generated{/}');
    for (const f of fileWrites) lines.push(`  {${S.subtle}-fg}·{/} {${S.string}-fg}${f}{/}`);
  } else {
    lines.push('', `{${S.muted}-fg}No files generated.{/}`);
  }

  return lines;
}

export function validatePostRunChanges({ changes, securityPolicy, step, cwd }) {
  const violations = [];
  for (const change of changes) {
    try {
      assertWriteAllowed(change.absPath, {
        root: cwd,
        agentName: step.agent,
        outputName: 'direct project change',
        policy: securityPolicy,
      });
    } catch (err) {
      violations.push({
        path: change.relPath,
        reason: err.message,
      });
    }
  }
  return violations;
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
    for (const line of preview) timeline.logMuted(line);
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

async function writeRunManifest({ runDir, runId, pipeline, cwd, stats, fileWrites, detectedDeliverables = [], status = 'done', error = null, debugEvents = [] }) {
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
    status,
    error: error ? {
      message: error.message,
    } : null,
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
      provider: s.provider,
      model: s.model,
      runnerAgent: s.runnerAgent,
      securityProfile: s.securityProfile,
      permissionMode: s.permissionMode,
      status: s.status,
      seconds: s.seconds,
      turns: s.turns,
      cost: s.cost,
      attempts: s.attempts || 1,
      outputWarnings: s.outputWarnings || [],
      parsedOutputs: s.parsedOutputs || [],
      rawOutputPath: s.rawOutputPath || null,
    })),
    debugEvents,
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
    shell.setMode?.(debug ? 'debug' : 'running');
  }

  const inputDefs = (pipeline.nodes || [])
    .filter((n) => n.type === 'input')
    .map((n) => ({ id: n.id, subtype: n.data?.subtype || 'text', label: n.data?.label || n.id, value: n.data?.value || '' }));

  const runBorderMode = debug ? 'debug' : 'running';
  const promptFn = shell ? async (msg) => {
    shell.setMode?.('awaiting');
    shell.setPipelineLabel?.('input waiting');
    try { return await shell.prompt(msg); }
    finally {
      shell.setMode?.(runBorderMode);
      shell.clearPipelineLabel?.();
    }
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

        const attemptDir = debug && stepDir && attempt > 1 ? path.join(stepDir, `attempt-${attempt}`) : stepDir;
        if (attemptDir) await fs.mkdir(attemptDir, { recursive: true });
        const attemptWorkspaceInfo = workspaceInfoForAttempt(attempt);
        const userMessage = buildUserMessage(replayInputs, outputNames, attemptWorkspaceInfo, securityPolicy);
        timeline.setRunning(
          timelineIndex,
          formatStepRuntimeMeta({
            provider,
            model: model || '',
            permissionMode,
            securityProfile: securityPolicy.profile,
          })
        );

        if (verbose) {
          timeline.log(`── system prompt ──`);
          for (const l of systemPrompt.split('\n').slice(0, 8)) timeline.logMuted(l);
          timeline.log(`── user message ──`);
          for (const l of userMessage.split('\n').slice(0, 12)) timeline.logMuted(l);
        }

        const started = Date.now();
        const stepBeforeSnapshot = currentSnapshot;
        let result;
        try {
          result = await runner.run({
            cwd,
            projectRoot: cwd,
            currentDir: cwd,
            systemPrompt,
            userPrompt: userMessage,
            model,
            runnerAgent,
            permissionMode,
            securityPolicy,
            verbose,
          });
        } catch (err) {
          const failedSeconds = (Date.now() - started) / 1000;
          stats.push({
            agent: step.agent,
            provider,
            model: model || '—',
            runnerAgent: runnerAgent || '—',
            securityProfile: securityPolicy.profile,
            permissionMode: permissionMode || '—',
            status: 'failed',
            seconds: totalAttemptSeconds + failedSeconds,
            turns: 0,
            cost: totalAttemptCost,
            attempts: attempt,
          });
          failStep(timeline, timelineIndex, err.message, `Step "${step.agent}" failed: ${err.message}`);
        }
        const elapsedSeconds = (Date.now() - started) / 1000;
        const elapsed = elapsedSeconds.toFixed(1);
        const text = result.text;
        const attemptTurns = Number(result.metadata.turns || 0);
        const attemptCost = Number(result.metadata.costUsd || 0);
        totalAttemptSeconds += elapsedSeconds;
        totalAttemptTurns += attemptTurns;
        totalAttemptCost += attemptCost;
        const stepWritesStart = fileWrites.length;

      if (verbose) {
        timeline.log(`── output ──`);
        for (const l of text.split('\n').slice(0, 20)) timeline.logMuted(l);
      }

      const parsed = parseOutputs(text, outputNames);
      const outputWarnings = validateParsedOutputs(parsed, outputNames);
      const parsedOutputSummary = summarizeParsedOutputs(parsed, outputNames);
      let rawOutputPath = null;
      if (debug && (outputWarnings.length || outputNames.length > 1)) {
        rawOutputPath = await writeRawOutputArtifact({
          stepDir: attemptDir,
          step,
          text,
          reason: outputWarnings.length
            ? `Output warning(s): ${outputWarnings.join(', ')}`
            : 'Debug raw output capture',
          timeline,
        });
      }

      for (const name of outputNames) {
        registry[`${step.agent}.${name}`] = parsed[name];
        let sink = step.outputs[name];

        if (typeof sink === 'string') {
          for (const [id, val] of Object.entries(inputValues)) {
            sink = sink.replaceAll(`$INPUT:${id}`, val);
          }
        }

        if (attemptDir) sink = rewriteInternalSink(sink, { cwd, stepDir: attemptDir });

        if (typeof sink === 'string' && sink.startsWith('$FILES:')) {
          const baseDir = sink.slice('$FILES:'.length).trim();
          const absBase = path.isAbsolute(baseDir) ? baseDir : path.join(cwd, baseDir);
          const isRunArtifactSink = attemptDir && isInsidePath(absBase, attemptDir);
          const rawJson = parsed[name].replace(/^```[a-z]*\n?/m, '').replace(/```\s*$/m, '').trim();
          let manifest;
          try { manifest = JSON.parse(rawJson); } catch (e) {
            await writeRawOutputArtifact({
              stepDir: attemptDir,
              step,
              text,
              reason: `Invalid $FILES JSON for output "${name}"`,
              timeline,
            });
            failStep(timeline, timelineIndex, 'invalid $FILES JSON', `Step "${step.agent}" returned invalid JSON for $FILES output "${name}".`);
          }
          for (const entry of (Array.isArray(manifest) ? manifest : [])) {
            const absOut = path.resolve(absBase, entry.path);
            if (isRunArtifactSink) {
              assertRunArtifactWriteAllowed(absOut, absBase, step.agent, name);
            } else {
              assertWriteAllowed(absOut, {
                root: cwd,
                agentName: step.agent,
                outputName: name,
                policy: securityPolicy,
              });
            }
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
          const absOut = path.isAbsolute(outPath) ? outPath : path.resolve(cwd, outPath);
          if (attemptDir && isInsidePath(absOut, attemptDir)) {
            assertRunArtifactWriteAllowed(absOut, attemptDir, step.agent, name);
          } else {
            assertWriteAllowed(absOut, {
              root: cwd,
              agentName: step.agent,
              outputName: name,
              policy: securityPolicy,
            });
          }
          await fs.mkdir(path.dirname(absOut), { recursive: true });
          await fs.writeFile(absOut, parsed[name]);
          fileWrites.push({
            absPath: absOut,
            relPath: path.relative(cwd, absOut),
            kind: path.relative(cwd, absOut).startsWith('.singleton' + path.sep) ? 'intermediate' : 'deliverable',
          });
        }
      }

      const attemptWrites = fileWrites.slice(stepWritesStart);
      let stepChanges = [];
      if (stepBeforeSnapshot) {
        const stepAfterSnapshot = await snapshotManager.captureState();
        stepChanges = snapshotManager.detectChanges(stepBeforeSnapshot, stepAfterSnapshot);
        const violations = validatePostRunChanges({
          changes: stepChanges,
          securityPolicy,
          step,
          cwd,
        });
        await handlePostRunViolations({
          violations,
          step,
          securityPolicy,
          timeline,
          timelineIndex,
          shell,
          cwd,
        });
        currentSnapshot = stepAfterSnapshot;
      }

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
    out(`{${S.error}-fg}✕ pipeline failed{/}`);
    throw runError;
  }
  shell?.setMode?.(null);
  out(dryRun ? `{${S.success}-fg}✓ dry-run complete{/}` : `{${S.success}-fg}✓ pipeline complete{/}`);
}
