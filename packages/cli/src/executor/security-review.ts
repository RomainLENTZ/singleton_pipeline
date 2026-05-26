import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { S } from '../shell.js';
import type { CommandResult, PipelineStep, SecurityPolicy, TimelineController } from '../types.js';

type SecurityViolation = {
  path: string;
  reason?: string;
};

type ShellLike = {
  prompt(message: string): Promise<string>;
};

function runCommand(cmd: string, args: string[], { cwd }: { cwd: string }): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
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

export async function getViolationDiffPreview(
  cwd: string,
  relPath: string,
  { maxLines = 80 }: { maxLines?: number } = {}
): Promise<string[]> {
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

async function logViolationDiffPreviews({
  violations,
  cwd,
  timeline,
}: {
  violations: SecurityViolation[];
  cwd: string;
  timeline: TimelineController;
}): Promise<void> {
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

export async function handlePostRunViolations({
  violations,
  step,
  securityPolicy,
  timeline,
  timelineIndex,
  shell,
  cwd,
  failStep,
}: {
  violations: SecurityViolation[];
  step: PipelineStep;
  securityPolicy: SecurityPolicy;
  timeline: TimelineController;
  timelineIndex: number;
  shell: ShellLike | null;
  cwd: string;
  failStep: (timeline: TimelineController, timelineIndex: number, info: string, message: string) => never;
}): Promise<void> {
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
      `Post-run security validation failed for "${step.agent}":\n- ${violations.map((violation) => violation.path).join('\n- ')}`
    );
  }

  const activeShell = shell as ShellLike;
  while (true) {
    const answer = (await activeShell.prompt('Security violation: continue, stop, or diff? (c/s/d)')).trim().toLowerCase();
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

  failStep(
    timeline,
    timelineIndex,
    'stopped by security review',
    `Pipeline stopped after post-run security validation for "${step.agent}".`
  );
}
