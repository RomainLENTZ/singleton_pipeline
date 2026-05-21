import { input } from '@inquirer/prompts';
import { S } from '../shell.js';
import { buildUserMessage } from './inputs.js';
import { summarizeParsedOutputs } from './outputs.js';
import { formatSnapshotCoverage } from './snapshot-manager.js';

export const DEFAULT_MAX_DEBUG_REPLAYS = 3;

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
export const debugToken = {
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

export function formatDebugList(values, fallback = 'none') {
  if (!values.length) return debugToken.muted(fallback);
  return values.map((value) => debugToken.identity(value)).join(` ${debugToken.muted('·')} `);
}

export function pushDebugEvent(events, event) {
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

export function logDebugPromptPreview({ systemPrompt, userMessage, timeline, editedInputs = new Set() }) {
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

async function logDebugDiffs({ changes, writes = [], cwd, timeline, getDiffPreview }) {
  logDebugSection('Debug step diff', timeline);
  const entries = uniqueDebugPaths([...changes, ...writes]);
  if (!entries.length) {
    timeline.logMuted(`${debugToken.key('changes')} ${debugToken.muted('none')}`);
    return;
  }

  for (const change of entries.slice(0, 8)) {
    timeline.log(`${debugToken.key(change.relPath)}`);
    const preview = await getDiffPreview(cwd, change.relPath);
    for (const line of preview) timeline.logMuted(`  ${line}`);
  }
  if (entries.length > 8) {
    timeline.logMuted(`${debugToken.muted(`... ${entries.length - 8} more changed file(s)`)}`);
  }
}

export function logSnapshotCoverage({ snapshot, timeline }) {
  if (!snapshot) return;
  const details = formatSnapshotCoverage(snapshot);
  if (!details.length) return;
  timeline.logMuted(`${debugToken.key('replay snapshot coverage')} ${formatDebugList(details, 'none')}`);
  if (snapshot.skippedLarge.length || snapshot.skippedBinary.length || snapshot.skippedIgnored.length) {
    timeline.logMuted(debugToken.policy('Replay rollback is not fully guaranteed if a skipped file is modified.'));
  }
}

export async function promptDebugPostStepDecision({
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
  getDiffPreview,
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
      await logDebugDiffs({ changes: stepChanges, writes: stepWrites, cwd, timeline, getDiffPreview });
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

export async function editDebugInputs({ resolvedInputs, shell, timeline, step, debugEvents, editedInputs }) {
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

export async function promptDebugStepDecision({
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
