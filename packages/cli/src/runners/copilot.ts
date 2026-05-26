import spawn from 'cross-spawn';
import path from 'node:path';
import { extractText, safeJsonParse } from './_shared.js';
import type { ProviderRunner, SecurityPolicy } from '../types.js';

type CopilotEvent = {
  type?: string;
  data?: any;
  usage?: any;
  error?: any;
  message?: unknown;
};

type CopilotArgsOptions = {
  prompt?: string;
  model?: string | null;
  runnerAgent?: string | null;
  securityPolicy?: Partial<SecurityPolicy>;
};

type CopilotSummary = {
  text: string;
  turns: number | null;
  outputTokens: number | null;
  premiumRequests: number | null;
  result: CopilotEvent | null;
};

type CopilotProcessResult = {
  events: CopilotEvent[];
  stderr: string;
};

const DEFAULT_TIMEOUT_MS = Number(process.env.SINGLETON_RUNNER_TIMEOUT_MS) || 10 * 60 * 1000;

function buildPrompt(systemPrompt: string, userPrompt: string): string {
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

function normalizeToolPath(value: unknown): string {
  return String(value || '').replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function hasGlob(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}

function looksLikeFile(value: string): boolean {
  const base = path.posix.basename(value);
  return Boolean(path.posix.extname(value)) || base === '.env';
}

function toWritePattern(entry: string): string | null {
  const normalized = normalizeToolPath(entry);
  if (!normalized) return null;
  if (hasGlob(normalized) || looksLikeFile(normalized)) return normalized;
  return `${normalized}/**`;
}

export function buildCopilotPermissionArgs(securityPolicy: Partial<SecurityPolicy> = {}): string[] {
  const profile = securityPolicy.profile || 'workspace-write';
  const args: string[] = [];

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
  // write surface is restricted - otherwise the scout can't discover anything.
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

export function buildCopilotArgs({ prompt, model, runnerAgent, securityPolicy = {} }: CopilotArgsOptions = {}): string[] {
  // Copilot CLI expects the user prompt as `-p <text>` arg. Passing `-p -` is
  // interpreted as the literal string "-", not as a stdin marker, so we always
  // inline the prompt as an argument here. Callers must keep the prompt under
  // ~32KB on Windows; large blobs should be referenced as files on disk rather
  // than injected inline.
  const args = [
    '-p',
    prompt ?? '',
    '--output-format',
    'json',
    ...buildCopilotPermissionArgs(securityPolicy),
  ];
  if (runnerAgent) args.push('--agent', runnerAgent);
  if (model) args.push('--model', model);
  return args;
}

export function summarizeCopilotEvents(events: CopilotEvent[]): CopilotSummary {
  // Copilot emits intermediate `assistant.message` events between tool calls
  // (the model's "thinking out loud"). The final deliverable is the LAST
  // assistant.message - concatenating them all would prepend narration noise
  // to whatever the agent is supposed to produce as its output.
  const assistantMessages = events.filter((event) => event.type === 'assistant.message');
  const finalMessage = assistantMessages.at(-1);
  const finalText = finalMessage ? extractText(finalMessage.data) : '';
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
    text: (finalText || deltaText).trim(),
    turns: assistantMessages.length || null,
    outputTokens: outputTokens || null,
    premiumRequests: Number(result?.usage?.premiumRequests || 0) || null,
    result,
  };
}

export function extractCopilotErrorMessage(event: unknown): string {
  if (!event || typeof event !== 'object') return '';
  const item = event as any;
  if (typeof item.error === 'string') return item.error;
  if (typeof item.message === 'string') return item.message;
  if (typeof item.error?.message === 'string') return item.error.message;
  if (typeof item.error?.data?.message === 'string') return item.error.data.message;
  if (typeof item.data?.message === 'string') return item.data.message;
  return extractText(item);
}

export const copilotRunner: ProviderRunner = {
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
    // We pass only the user prompt as `-p <text>`. Without --agent we inline the
    // system prompt wrapped in <system>/<user> tags as the user prompt.
    const prompt = runnerAgent ? userPrompt : buildPrompt(systemPrompt, userPrompt);
    const args = buildCopilotArgs({ prompt, model, runnerAgent, securityPolicy });

    const { events, stderr } = await new Promise<CopilotProcessResult>((resolve, reject) => {
      const child = spawn('copilot', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      const stdoutChunks: string[] = [];
      let stderrText = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderrText += chunk.toString()));
      child.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        const stdout = stdoutChunks.join('');
        const events = stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map(safeJsonParse)
          .filter(Boolean) as CopilotEvent[];

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
