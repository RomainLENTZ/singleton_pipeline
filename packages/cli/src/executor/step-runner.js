import fs from 'node:fs/promises';
import path from 'node:path';
import { assertWriteAllowed } from '../security/policy.js';
import { buildUserMessage } from './inputs.js';
import {
  assertRunArtifactWriteAllowed,
  isInsidePath,
  parseOutputs,
  rewriteInternalSink,
  summarizeParsedOutputs,
  writeRawOutputArtifact,
} from './outputs.js';

function formatStepRuntimeMeta({ provider, model, permissionMode, securityProfile }) {
  const parts = [];
  if (provider) parts.push(provider);
  if (model) parts.push(model);
  if (securityProfile) parts.push(`security:${securityProfile}`);
  if (permissionMode) parts.push(`perm:${permissionMode}`);
  return parts.join(' · ');
}

export function validateParsedOutputs(parsed, outputNames) {
  const warnings = [];
  for (const name of outputNames) {
    const value = String(parsed[name] || '').trim();
    if (!value) warnings.push(`output "${name}" is empty`);
  }
  return warnings;
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

export async function runStepAttempt({
  attempt,
  debug,
  stepDir,
  cwd,
  step,
  outputNames,
  inputs,
  securityPolicy,
  systemPrompt,
  workspaceInfo,
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
}) {
  const attemptDir = debug && stepDir && attempt > 1 ? path.join(stepDir, `attempt-${attempt}`) : stepDir;
  if (attemptDir) await fs.mkdir(attemptDir, { recursive: true });
  const userMessage = buildUserMessage(inputs, outputNames, workspaceInfo, securityPolicy);
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
    return {
      failed: true,
      error: err,
      elapsedSeconds: failedSeconds,
      attemptTurns: 0,
      attemptCost: 0,
    };
  }

  const elapsedSeconds = (Date.now() - started) / 1000;
  const text = result.text;
  const metadata = result.metadata || {};
  const attemptTurns = Number(metadata.turns || 0);
  const attemptCost = Number(metadata.costUsd || 0);
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
      try { manifest = JSON.parse(rawJson); } catch {
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
  let stepAfterSnapshot = currentSnapshot;
  if (stepBeforeSnapshot) {
    stepAfterSnapshot = await snapshotManager.captureState();
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
      failStep,
    });
  }

  return {
    failed: false,
    attemptDir,
    text,
    elapsedSeconds,
    attemptTurns,
    attemptCost,
    stepWritesStart,
    attemptWrites,
    parsed,
    outputWarnings,
    parsedOutputSummary,
    rawOutputPath,
    stepChanges,
    stepAfterSnapshot,
  };
}
