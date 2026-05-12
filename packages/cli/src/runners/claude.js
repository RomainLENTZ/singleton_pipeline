import { spawn } from 'node:child_process';
import { resolveBinary } from './_shared.js';

const DEFAULT_TIMEOUT_MS = Number(process.env.SINGLETON_RUNNER_TIMEOUT_MS) || 10 * 60 * 1000;
const ALLOWED_PERMISSION_MODES = new Set(['bypassPermissions']);
const READ_ONLY_DENY_TOOLS = ['Write', 'Edit', 'Bash', 'NotebookEdit'];

export function buildClaudePermissionArgs(securityPolicy = {}, permissionMode = '') {
  // Legacy escape hatch: when permission_mode is explicitly set on the agent or
  // step, honor it as-is and skip the security_policy mapping. This preserves
  // backward compatibility with pipelines authored before security_policy
  // support landed.
  if (permissionMode) {
    if (!ALLOWED_PERMISSION_MODES.has(permissionMode)) {
      throw new Error(`unsupported Claude permission_mode: ${permissionMode}`);
    }
    return ['--permission-mode', permissionMode];
  }

  const profile = securityPolicy.profile || 'workspace-write';
  const args = [];

  if (profile === 'dangerous') {
    args.push('--permission-mode', 'bypassPermissions');
    return args;
  }

  if (profile === 'read-only') {
    args.push('--disallowedTools', READ_ONLY_DENY_TOOLS.join(','));
    return args;
  }

  // restricted-write & workspace-write: Claude Code does not support per-path
  // tool filtering, so we let it edit and rely on Singleton's post-run snapshot
  // diff to reject writes outside allowed_paths. acceptEdits avoids interactive
  // prompts in -p mode.
  args.push('--permission-mode', 'acceptEdits');
  return args;
}

export const claudeRunner = {
  id: 'claude',
  command: 'claude',

  async run({
    cwd,
    systemPrompt,
    userPrompt,
    model,
    permissionMode = '',
    securityPolicy,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }) {
    const args = [
      '-p',
      '--output-format',
      'json',
      '--system-prompt',
      systemPrompt,
      ...buildClaudePermissionArgs(securityPolicy, permissionMode),
    ];

    if (model) args.push('--model', model);

    const raw = await new Promise((resolve, reject) => {
      const child = spawn(resolveBinary('claude'), args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }, timeoutMs);

      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`claude timed out after ${Math.round(timeoutMs / 1000)}s`));
          return;
        }
        if (code !== 0) {
          reject(new Error(`claude exited ${code}: ${stderr.trim() || stdout.trim()}`));
          return;
        }

        try {
          resolve(JSON.parse(stdout));
        } catch (err) {
          reject(new Error(`failed to parse claude output: ${err.message}\n${stdout.slice(0, 500)}`));
        }
      });

      child.stdin.write(userPrompt);
      child.stdin.end();
    });

    return {
      text: typeof raw.result === 'string' ? raw.result : JSON.stringify(raw),
      metadata: {
        provider: 'claude',
        model: raw.model ?? model ?? null,
        turns: Number(raw.num_turns || 0) || null,
        costUsd: Number(raw.total_cost_usd || 0) || null,
        tokens: {
          input: raw.usage?.input_tokens ?? null,
          output: raw.usage?.output_tokens ?? null,
        },
        raw,
      },
    };
  },
};
