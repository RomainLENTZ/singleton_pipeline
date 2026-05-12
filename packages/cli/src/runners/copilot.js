import spawn from 'cross-spawn';
import path from 'node:path';
import { extractText, safeJsonParse } from './_shared.js';

const DEFAULT_TIMEOUT_MS = Number(process.env.SINGLETON_RUNNER_TIMEOUT_MS) || 10 * 60 * 1000;

function buildPrompt(systemPrompt, userPrompt) {
  return [
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

function normalizeToolPath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function hasGlob(value) {
  return /[*?[\]{}]/.test(value);
}

function looksLikeFile(value) {
  const base = path.posix.basename(value);
  return Boolean(path.posix.extname(value)) || base === '.env';
}

function toWritePattern(entry) {
  const normalized = normalizeToolPath(entry);
  if (!normalized) return null;
  if (hasGlob(normalized) || looksLikeFile(normalized)) return normalized;
  return `${normalized}/**`;
}

export function buildCopilotPermissionArgs(securityPolicy = {}) {
  const profile = securityPolicy.profile || 'workspace-write';
  const args = [];

  if (profile === 'dangerous') {
    args.push('--allow-all-tools');
  } else {
    args.push('--allow-tool=read');
  }

  if (profile === 'restricted-write') {
    for (const entry of securityPolicy.allowedPaths || []) {
      const pattern = toWritePattern(entry);
      if (pattern) args.push(`--allow-tool=write(${pattern})`);
    }
  } else if (profile === 'workspace-write') {
    args.push('--allow-tool=write');
  }

  // Copilot CLI runs in deny-by-default mode as soon as any --allow-tool is
  // present. Agents need shell access to list/grep the codebase even when their
  // write surface is restricted — otherwise the scout can't discover anything.
  // read-only stays shell-less; dangerous is already covered by --allow-all-tools.
  if (profile === 'read-only') {
    args.push('--deny-tool=write');
    args.push('--deny-tool=shell');
  } else {
    if (profile !== 'dangerous') args.push('--allow-tool=shell');
    args.push('--deny-tool=shell(git push)');
  }

  if (profile !== 'dangerous') {
    args.push('--deny-tool=url');
  }

  for (const entry of securityPolicy.blockedPaths || []) {
    const pattern = toWritePattern(entry);
    if (pattern) args.push(`--deny-tool=write(${pattern})`);
  }

  args.push('--deny-tool=memory');
  return args;
}

export function buildCopilotArgs({ model, runnerAgent, securityPolicy = {} } = {}) {
  // Prompt is written to stdin (see copilotRunner.run). We use `-p -` as the
  // marker for "read prompt from stdin". This avoids the Windows command-line
  // length limit (~32KB) when the user message includes large injected context.
  const args = [
    '-p',
    '-',
    '--output-format',
    'json',
    ...buildCopilotPermissionArgs(securityPolicy),
  ];
  if (runnerAgent) args.push('--agent', runnerAgent);
  if (model) args.push('--model', model);
  return args;
}

export function summarizeCopilotEvents(events) {
  const assistantMessages = events
    .filter((event) => event.type === 'assistant.message')
    .map((event) => extractText(event.data))
    .filter(Boolean);
  const deltaText = events
    .filter((event) => event.type === 'assistant.message_delta')
    .map((event) => event.data?.deltaContent || event.data?.delta || '')
    .filter(Boolean)
    .join('');
  const result = [...events].reverse().find((event) => event.type === 'result') || null;
  const outputTokens = events.reduce((total, event) => {
    if (event.type !== 'assistant.message') return total;
    return total + (Number(event.data?.outputTokens || 0) || 0);
  }, 0);

  return {
    text: assistantMessages.join('\n').trim() || deltaText.trim(),
    turns: events.filter((event) => event.type === 'assistant.message').length || null,
    outputTokens: outputTokens || null,
    premiumRequests: Number(result?.usage?.premiumRequests || 0) || null,
    result,
  };
}

export function extractCopilotErrorMessage(event) {
  if (!event || typeof event !== 'object') return '';
  if (typeof event.error === 'string') return event.error;
  if (typeof event.message === 'string') return event.message;
  if (typeof event.error?.message === 'string') return event.error.message;
  if (typeof event.error?.data?.message === 'string') return event.error.data.message;
  if (typeof event.data?.message === 'string') return event.data.message;
  return extractText(event);
}

export const copilotRunner = {
  id: 'copilot',
  command: 'copilot',

  async run({
    cwd,
    systemPrompt,
    userPrompt,
    model,
    runnerAgent,
    securityPolicy,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }) {
    // When --agent is used, Copilot loads the system prompt from .github/agents/<name>.md.
    // We pipe only the user prompt via stdin in that case (to match the bash
    // pattern). When --agent is not used we inline the system prompt with the
    // XML wrappers.
    const prompt = runnerAgent ? userPrompt : buildPrompt(systemPrompt, userPrompt);
    const args = buildCopilotArgs({ model, runnerAgent, securityPolicy });

    const { events, stderr } = await new Promise((resolve, reject) => {
      const child = spawn('copilot', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      const stdoutChunks = [];
      let stderrText = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }, timeoutMs);

      child.stdin.on('error', () => { /* surfaced via close handler */ });
      try {
        child.stdin.write(prompt);
        child.stdin.end();
      } catch { /* same */ }

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
          reject(new Error(`copilot timed out after ${Math.round(timeoutMs / 1000)}s`));
          return;
        }
        if (code !== 0) {
          const result = [...events].reverse().find((event) => event.type === 'result');
          const message = extractCopilotErrorMessage(result) || stderrText.trim() || stdout.trim() || 'unknown error';
          reject(new Error(`copilot exited ${code}: ${message}`));
          return;
        }

        resolve({ events, stderr: stderrText });
      });
    });

    const summary = summarizeCopilotEvents(events);
    return {
      text: summary.text,
      metadata: {
        provider: 'copilot',
        model: model || null,
        runnerAgent: runnerAgent || null,
        turns: summary.turns,
        costUsd: null,
        tokens: {
          input: null,
          output: summary.outputTokens,
        },
        premiumRequests: summary.premiumRequests,
        raw: {
          events,
          stderr,
          result: summary.result,
        },
      },
    };
  },
};
