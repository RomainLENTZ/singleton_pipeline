import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function buildPrompt(systemPrompt, userPrompt) {
  return [
    'Follow the system instructions exactly.',
    '',
    '<system>',
    systemPrompt,
    '</system>',
    '',
    '<user>',
    userPrompt,
    '</user>',
    '',
  ].join('\n');
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function findUsage(value) {
  if (!value || typeof value !== 'object') return null;

  if (
    Object.prototype.hasOwnProperty.call(value, 'input_tokens') ||
    Object.prototype.hasOwnProperty.call(value, 'output_tokens')
  ) {
    return {
      input: value.input_tokens ?? null,
      output: value.output_tokens ?? null,
    };
  }

  if (
    Object.prototype.hasOwnProperty.call(value, 'input') ||
    Object.prototype.hasOwnProperty.call(value, 'output')
  ) {
    return {
      input: value.input ?? null,
      output: value.output ?? null,
    };
  }

  for (const nested of Object.values(value)) {
    const usage = findUsage(nested);
    if (usage) return usage;
  }

  return null;
}

export const codexRunner = {
  id: 'codex',

  async run({ cwd, systemPrompt, userPrompt, model }) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'singleton-codex-'));
    const outputFile = path.join(tempDir, 'last-message.txt');
    const prompt = buildPrompt(systemPrompt, userPrompt);

    const args = [
      'exec',
      '--json',
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox',
      'workspace-write',
      '--output-last-message',
      outputFile,
      '-',
    ];

    if (model) args.splice(args.length - 1, 0, '--model', model);

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

      child.stdout.on('data', (d) => stdoutChunks.push(d.toString()));
      child.stderr.on('data', (d) => (stderrText += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        const stdout = stdoutChunks.join('');
        const events = stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map(safeJsonParse)
          .filter(Boolean);

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
        raw: { events, stderr },
      },
    };
  },
};
