import { spawn } from 'node:child_process';
import path from 'node:path';
import { extractText, findCostUsd, findUsage, resolveBinary, safeJsonParse } from './_shared.js';

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

function isAssistantEvent(event) {
  const type = String(event?.type || '').toLowerCase();
  const role = String(event?.role || event?.data?.role || event?.message?.role || '').toLowerCase();
  return role === 'assistant' || type === 'text' || type.includes('assistant') || type.includes('message');
}

export function extractOpenCodeErrorMessage(event) {
  if (!event || typeof event !== 'object') return '';
  if (typeof event.error === 'string') return event.error;
  if (typeof event.message === 'string') return event.message;
  if (typeof event.error?.message === 'string') return event.error.message;
  if (typeof event.error?.data?.message === 'string') return event.error.data.message;
  if (typeof event.data?.message === 'string') return event.data.message;
  return extractText(event);
}

function normalizePermissionPath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function hasGlob(value) {
  return /[*?[\]{}]/.test(value);
}

function looksLikeFile(value) {
  const base = path.posix.basename(value);
  return Boolean(path.posix.extname(value)) || base === '.env';
}

function toOpenCodePathPattern(entry) {
  const normalized = normalizePermissionPath(entry);
  if (!normalized) return null;
  if (hasGlob(normalized) || looksLikeFile(normalized)) return normalized;
  return `${normalized}/**`;
}

function buildEditPermission(securityPolicy) {
  const profile = securityPolicy?.profile || 'workspace-write';
  const blocked = (securityPolicy?.blockedPaths || [])
    .map(toOpenCodePathPattern)
    .filter(Boolean);

  if (profile === 'read-only') return 'deny';
  if (profile === 'dangerous') return 'allow';

  if (profile === 'restricted-write') {
    const edit = { '*': 'deny' };
    for (const entry of securityPolicy?.allowedPaths || []) {
      const pattern = toOpenCodePathPattern(entry);
      if (pattern) edit[pattern] = 'allow';
    }
    for (const pattern of blocked) edit[pattern] = 'deny';
    return edit;
  }

  if (blocked.length) {
    const edit = { '*': 'allow' };
    for (const pattern of blocked) edit[pattern] = 'deny';
    return edit;
  }

  return 'allow';
}

export function buildOpenCodePermissionConfig(securityPolicy = {}) {
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

export function buildOpenCodeConfigContent({ securityPolicy = {}, runnerAgent = '', existingContent = '' } = {}) {
  let config = {};
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

export function buildOpenCodeEnv({ securityPolicy = {}, runnerAgent = '', baseEnv = process.env } = {}) {
  // Note: we deliberately do NOT redirect XDG_DATA_HOME here. OpenCode stores
  // provider auth (anthropic, openai, …) under XDG_DATA_HOME, so isolating
  // it would strip API credentials from the spawned process. Security is
  // enforced via OPENCODE_CONFIG_CONTENT (native permissions injection) and
  // Singleton's post-run snapshot diff — both of which work without isolating
  // OpenCode's data dir.
  return {
    ...baseEnv,
    OPENCODE_CONFIG_CONTENT: buildOpenCodeConfigContent({
      securityPolicy,
      runnerAgent,
      existingContent: baseEnv.OPENCODE_CONFIG_CONTENT || '',
    }),
  };
}

export function buildOpenCodeArgs({ prompt, model, runnerAgent, securityPolicy = {} }) {
  const args = ['run', '--format', 'json'];
  if (model) args.push('--model', model);
  if (runnerAgent) args.push('--agent', runnerAgent);
  if (securityPolicy.profile === 'dangerous') args.push('--dangerously-skip-permissions');
  args.push(prompt);
  return args;
}

export function summarizeOpenCodeEvents(events, stdout = '') {
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

export const opencodeRunner = {
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

    const runResult = await new Promise((resolve, reject) => {
      const child = spawn(resolveBinary('opencode'), args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
