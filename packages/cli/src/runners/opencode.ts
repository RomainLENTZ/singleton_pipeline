import spawn from 'cross-spawn';
import path from 'node:path';
import { extractText, findCostUsd, findUsage, safeJsonParse, type TokenUsage } from './_shared.js';
import type { ProviderRunner, SecurityPolicy } from '../types.js';

type OpenCodeEvent = {
  type?: string;
  role?: string;
  data?: any;
  message?: any;
  content?: any;
  part?: any;
  error?: any;
  usage?: any;
  [key: string]: unknown;
};

type OpenCodePermission = string | Record<string, unknown>;

type OpenCodeArgsOptions = {
  prompt: string;
  model?: string | null;
  runnerAgent?: string | null;
  securityPolicy?: Partial<SecurityPolicy>;
};

type OpenCodeConfigOptions = {
  securityPolicy?: Partial<SecurityPolicy>;
  runnerAgent?: string | null;
  existingContent?: string;
};

type OpenCodeEnvOptions = {
  securityPolicy?: Partial<SecurityPolicy>;
  runnerAgent?: string | null;
  baseEnv?: NodeJS.ProcessEnv;
};

type OpenCodeSummary = {
  text: string;
  turns: number | null;
  costUsd: number | null;
  tokens: TokenUsage | null;
};

type OpenCodeProcessResult = {
  events: OpenCodeEvent[];
  stdout: string;
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

function isAssistantEvent(event: OpenCodeEvent): boolean {
  const type = String(event?.type || '').toLowerCase();
  const role = String(event?.role || event?.data?.role || event?.message?.role || '').toLowerCase();
  return role === 'assistant' || type === 'text' || type.includes('assistant') || type.includes('message');
}

export function extractOpenCodeErrorMessage(event: unknown): string {
  if (!event || typeof event !== 'object') return '';
  const item = event as any;
  if (typeof item.error === 'string') return item.error;
  if (typeof item.message === 'string') return item.message;
  if (typeof item.error?.message === 'string') return item.error.message;
  if (typeof item.error?.data?.message === 'string') return item.error.data.message;
  if (typeof item.data?.message === 'string') return item.data.message;
  return extractText(item);
}

function normalizePermissionPath(value: unknown): string {
  return String(value || '').replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function hasGlob(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}

function looksLikeFile(value: string): boolean {
  const base = path.posix.basename(value);
  return Boolean(path.posix.extname(value)) || base === '.env';
}

function toOpenCodePathPattern(entry: string): string | null {
  const normalized = normalizePermissionPath(entry);
  if (!normalized) return null;
  if (hasGlob(normalized) || looksLikeFile(normalized)) return normalized;
  return `${normalized}/**`;
}

function buildEditPermission(securityPolicy: Partial<SecurityPolicy>): string | Record<string, string> {
  const profile = securityPolicy?.profile || 'workspace-write';
  const blocked = (securityPolicy?.blockedPaths || [])
    .map(toOpenCodePathPattern)
    .filter((pattern): pattern is string => typeof pattern === 'string');

  if (profile === 'read-only') return 'deny';
  if (profile === 'dangerous') return 'allow';

  if (profile === 'restricted-write') {
    const edit: Record<string, string> = { '*': 'deny' };
    for (const entry of securityPolicy?.allowedPaths || []) {
      const pattern = toOpenCodePathPattern(entry);
      if (pattern) edit[pattern] = 'allow';
    }
    for (const pattern of blocked) edit[pattern] = 'deny';
    return edit;
  }

  if (blocked.length) {
    const edit: Record<string, string> = { '*': 'allow' };
    for (const pattern of blocked) edit[pattern] = 'deny';
    return edit;
  }

  return 'allow';
}

export function buildOpenCodePermissionConfig(securityPolicy: Partial<SecurityPolicy> = {}): { permission: OpenCodePermission } {
  const profile = securityPolicy.profile || 'workspace-write';

  if (profile === 'dangerous') {
    return { permission: 'allow' };
  }

  const permission = {
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    edit: buildEditPermission(securityPolicy),
    bash: profile === 'read-only' ? 'deny' : 'ask',
    task: 'deny',
    webfetch: 'deny',
    websearch: 'deny',
    external_directory: 'deny',
    doom_loop: 'ask',
  };

  return { permission };
}

export function buildOpenCodeConfigContent({
  securityPolicy = {},
  runnerAgent = '',
  existingContent = '',
}: OpenCodeConfigOptions = {}): string {
  let config: Record<string, any> = {};
  if (existingContent) {
    try {
      config = JSON.parse(existingContent);
    } catch {
      config = {};
    }
  }

  const permissionConfig = buildOpenCodePermissionConfig(securityPolicy);
  config = {
    ...config,
    ...permissionConfig,
  };

  if (runnerAgent && permissionConfig.permission && typeof permissionConfig.permission === 'object') {
    config.agent = {
      ...(config.agent || {}),
      [runnerAgent]: {
        ...(config.agent?.[runnerAgent] || {}),
        permission: permissionConfig.permission,
      },
    };
  }

  return JSON.stringify(config);
}

export function buildOpenCodeEnv({
  securityPolicy = {},
  runnerAgent = '',
  baseEnv = process.env,
}: OpenCodeEnvOptions = {}): NodeJS.ProcessEnv {
  // Note: we deliberately do NOT redirect XDG_DATA_HOME here. OpenCode stores
  // provider auth under XDG_DATA_HOME, so isolating it strips API credentials
  // from the spawned process. Security is enforced via OPENCODE_CONFIG_CONTENT
  // and Singleton's post-run snapshot diff.
  return {
    ...baseEnv,
    OPENCODE_CONFIG_CONTENT: buildOpenCodeConfigContent({
      securityPolicy,
      runnerAgent: runnerAgent || '',
      existingContent: baseEnv.OPENCODE_CONFIG_CONTENT || '',
    }),
  };
}

export function buildOpenCodeArgs({ prompt, model, runnerAgent, securityPolicy = {} }: OpenCodeArgsOptions): string[] {
  const args = ['run', '--format', 'json'];
  if (model) args.push('--model', model);
  if (runnerAgent) args.push('--agent', runnerAgent);
  if (securityPolicy.profile === 'dangerous') args.push('--dangerously-skip-permissions');
  args.push(prompt);
  return args;
}

export function summarizeOpenCodeEvents(events: OpenCodeEvent[], stdout = ''): OpenCodeSummary {
  const assistantText = events
    .filter(isAssistantEvent)
    .map((event) => extractText(event))
    .filter(Boolean)
    .join('\n')
    .trim();
  const usage = [...events].reverse().map(findUsage).find(Boolean) || null;
  const costUsd = [...events].reverse().map(findCostUsd).find((value) => value !== null) ?? null;
  const turns = events.filter(isAssistantEvent).length || null;

  return {
    text: assistantText || stdout.trim(),
    turns,
    costUsd,
    tokens: usage,
  };
}

export const opencodeRunner: ProviderRunner = {
  id: 'opencode',
  command: 'opencode',

  async run({
    cwd,
    systemPrompt,
    userPrompt,
    model,
    runnerAgent,
    securityPolicy,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }) {
    const prompt = buildPrompt(systemPrompt, userPrompt);
    const args = buildOpenCodeArgs({ prompt, model, runnerAgent, securityPolicy });
    const env = buildOpenCodeEnv({
      securityPolicy,
      runnerAgent,
    });

    const runResult = await new Promise<OpenCodeProcessResult>((resolve, reject) => {
      const child = spawn('opencode', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
          .filter(Boolean) as OpenCodeEvent[];

        if (timedOut) {
          reject(new Error(`opencode timed out after ${Math.round(timeoutMs / 1000)}s`));
          return;
        }
        const errorEvent = [...events].reverse().find((event) => event.type === 'error' || event.error);
        if (errorEvent) {
          const message = extractOpenCodeErrorMessage(errorEvent) || stderrText.trim() || stdout.trim() || 'unknown error';
          reject(new Error(`opencode error: ${message}`));
          return;
        }
        if (code !== 0) {
          const result = [...events].reverse().find((event) => event.type === 'result' || event.error || event.message);
          const message = extractOpenCodeErrorMessage(result) || stderrText.trim() || stdout.trim() || 'unknown error';
          reject(new Error(`opencode exited ${code}: ${message}`));
          return;
        }

        resolve({ events, stdout, stderr: stderrText });
      });
    });

    const { events, stdout, stderr } = runResult;
    const summary = summarizeOpenCodeEvents(events, stdout);
    return {
      text: summary.text,
      metadata: {
        provider: 'opencode',
        model: model || null,
        runnerAgent: runnerAgent || null,
        turns: summary.turns,
        costUsd: summary.costUsd,
        tokens: summary.tokens,
        raw: { events, stdout, stderr },
      },
    };
  },
};
