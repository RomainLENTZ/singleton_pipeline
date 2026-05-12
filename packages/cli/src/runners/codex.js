import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import spawn from 'cross-spawn';
import { discoverCodexProjectInstructions } from './codex-instructions.js';
import { findUsage, safeJsonParse } from './_shared.js';

const DEFAULT_TIMEOUT_MS = Number(process.env.SINGLETON_RUNNER_TIMEOUT_MS) || 10 * 60 * 1000;

function buildPrompt(systemPrompt, userPrompt, projectInstructions = '') {
  const parts = ['Follow the system instructions exactly.', ''];

  if (projectInstructions) {
    parts.push('<codex_project_instructions>');
    parts.push(projectInstructions);
    parts.push('</codex_project_instructions>');
    parts.push('');
  }

  parts.push('<system>');
  parts.push(systemPrompt);
  parts.push('</system>');
  parts.push('');
  parts.push('<user>');
  parts.push(userPrompt);
  parts.push('</user>');
  parts.push('');

  return parts.join('\n');
}

export function buildCodexSandboxArgs(securityPolicy = {}) {
  const profile = securityPolicy.profile || 'workspace-write';

  // Codex CLI sandbox modes: read-only, workspace-write,
  // workspace-write-with-network, danger-full-access. Codex has no per-path
  // filter, so restricted-write maps to workspace-write at the runner level
  // and Singleton's post-run snapshot diff enforces the allowed_paths.
  if (profile === 'read-only') return ['--sandbox', 'read-only'];
  if (profile === 'dangerous') return ['--sandbox', 'danger-full-access'];
  return ['--sandbox', 'workspace-write'];
}

export function buildCodexArgs({ prompt, model, outputFile, securityPolicy } = {}) {
  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    ...buildCodexSandboxArgs(securityPolicy),
    '--output-last-message',
    outputFile,
  ];

  if (model) args.push('--model', model);
  args.push('-');
  return args;
}

export const codexRunner = {
  id: 'codex',
  command: 'codex',

  async run({
    cwd,
    projectRoot = cwd,
    currentDir = cwd,
    systemPrompt,
    userPrompt,
    model,
    securityPolicy,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'singleton-codex-'));
    const outputFile = path.join(tempDir, 'last-message.txt');
    const projectInstructions = await discoverCodexProjectInstructions(projectRoot, currentDir);
    const prompt = buildPrompt(systemPrompt, userPrompt, projectInstructions.text);

    const args = buildCodexArgs({ prompt, model, outputFile, securityPolicy });

    const { events, stderr } = await new Promise((resolve, reject) => {
      const child = spawn('codex', args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          CODEX_HOME: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
        },
      });

      const stdoutChunks = [];
      let stderrText = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }, timeoutMs);

      child.stdout.on('data', (d) => stdoutChunks.push(d.toString()));
      child.stderr.on('data', (d) => (stderrText += d.toString()));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const stdout = stdoutChunks.join('');
        const events = stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map(safeJsonParse)
          .filter(Boolean);

        if (timedOut) {
          reject(new Error(`codex timed out after ${Math.round(timeoutMs / 1000)}s`));
          return;
        }
        if (code !== 0) {
          const eventError = events.findLast?.((event) => event.type === 'error')?.message
            || [...events].reverse().find((event) => event.type === 'error')?.message;
          reject(new Error(`codex exited ${code}: ${eventError || stderrText.trim() || 'unknown error'}`));
          return;
        }

        resolve({ events, stderr: stderrText });
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });

    let text = '';
    try {
      text = (await fs.readFile(outputFile, 'utf8')).trim();
    } catch {
      text = '';
    }

    const turns = events.filter((event) => event.type === 'turn.started').length || null;
    const usage = [...events]
      .reverse()
      .map(findUsage)
      .find(Boolean) || null;

    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }

    return {
      text,
      metadata: {
        provider: 'codex',
        model: model || null,
        turns,
        costUsd: null,
        tokens: usage,
        raw: { events, stderr, projectInstructionFiles: projectInstructions.files },
      },
    };
  },
};
