import { describe, expect, it } from 'vitest';
import {
  buildCopilotArgs,
  buildCopilotPermissionArgs,
  extractCopilotErrorMessage,
  summarizeCopilotEvents,
} from './copilot.js';

describe('buildCopilotPermissionArgs', () => {
  it('keeps read-only agents read-only at the Copilot tool layer', () => {
    expect(buildCopilotPermissionArgs({
      profile: 'read-only',
      blockedPaths: ['.env'],
    })).toEqual([
      '--allow-tool=read',
      '--deny-tool=write',
      '--deny-tool=shell',
      '--deny-tool=url',
      '--deny-tool=write(.env)',
      '--deny-tool=memory',
    ]);
  });

  it('maps restricted-write allowed paths to Copilot write patterns', () => {
    expect(buildCopilotPermissionArgs({
      profile: 'restricted-write',
      allowedPaths: ['src', 'vite.config.ts'],
      blockedPaths: ['.env.*'],
    })).toEqual([
      '--allow-tool=read',
      '--allow-tool=write(src/**)',
      '--allow-tool=write(vite.config.ts)',
      '--deny-tool=shell(git push)',
      '--deny-tool=url',
      '--deny-tool=write(.env.*)',
      '--deny-tool=memory',
    ]);
  });

  it('uses the broad Copilot permission mode only for dangerous profiles', () => {
    expect(buildCopilotPermissionArgs({
      profile: 'dangerous',
      blockedPaths: [],
    })).toEqual([
      '--allow-all-tools',
      '--deny-tool=shell(git push)',
      '--deny-tool=memory',
    ]);
  });

  it('grants broad write but still blocks shell(git push) and url for workspace-write', () => {
    const args = buildCopilotPermissionArgs({ profile: 'workspace-write' });
    expect(args).toContain('--allow-tool=read');
    expect(args).toContain('--allow-tool=write');
    expect(args).toContain('--deny-tool=shell(git push)');
    expect(args).toContain('--deny-tool=url');
    expect(args).toContain('--deny-tool=memory');
  });

  it('falls back to workspace-write when no profile is provided', () => {
    expect(buildCopilotPermissionArgs({})).toEqual(
      buildCopilotPermissionArgs({ profile: 'workspace-write' })
    );
  });
});

describe('buildCopilotArgs', () => {
  it('builds a non-interactive Copilot command with permission args', () => {
    const args = buildCopilotArgs({
      model: 'gpt-4.1',
      runnerAgent: 'reviewer',
      securityPolicy: { profile: 'read-only' },
    });

    expect(args.slice(0, 4)).toEqual(['-p', '-', '--output-format', 'json']);
    expect(args).toContain('--agent');
    expect(args).toContain('reviewer');
    expect(args).toContain('--model');
    expect(args).toContain('gpt-4.1');
    expect(args).toContain('--deny-tool=write');
  });

  it('omits agent and model flags when not provided', () => {
    const args = buildCopilotArgs({
      securityPolicy: { profile: 'workspace-write' },
    });
    expect(args).not.toContain('--agent');
    expect(args).not.toContain('--model');
  });
});

describe('summarizeCopilotEvents', () => {
  it('extracts assistant text from assistant.message events', () => {
    const summary = summarizeCopilotEvents([
      { type: 'assistant.message', data: { content: 'first answer', outputTokens: 12 } },
      { type: 'assistant.message', data: { content: 'second answer', outputTokens: 4 } },
    ]);

    expect(summary.text).toBe('first answer\nsecond answer');
    expect(summary.turns).toBe(2);
    expect(summary.outputTokens).toBe(16);
  });

  it('falls back to delta text when only deltas are emitted', () => {
    const summary = summarizeCopilotEvents([
      { type: 'assistant.message_delta', data: { deltaContent: 'hello ' } },
      { type: 'assistant.message_delta', data: { delta: 'world' } },
    ]);
    expect(summary.text).toBe('hello world');
    expect(summary.turns).toBeNull();
  });

  it('extracts premiumRequests from the final result event', () => {
    const summary = summarizeCopilotEvents([
      { type: 'assistant.message', data: { content: 'done', outputTokens: 5 } },
      { type: 'result', usage: { premiumRequests: 2 } },
    ]);
    expect(summary.premiumRequests).toBe(2);
  });

  it('returns empty text and null counters when no relevant events are present', () => {
    const summary = summarizeCopilotEvents([{ type: 'noise' }]);
    expect(summary.text).toBe('');
    expect(summary.turns).toBeNull();
    expect(summary.outputTokens).toBeNull();
    expect(summary.premiumRequests).toBeNull();
  });
});

describe('extractCopilotErrorMessage', () => {
  it('extracts a top-level error string', () => {
    expect(extractCopilotErrorMessage({ error: 'rate limited' })).toBe('rate limited');
  });

  it('extracts a nested error.message', () => {
    expect(extractCopilotErrorMessage({
      error: { message: 'token expired' },
    })).toBe('token expired');
  });

  it('extracts a deeply nested error.data.message', () => {
    expect(extractCopilotErrorMessage({
      error: { data: { message: 'tool not allowed' } },
    })).toBe('tool not allowed');
  });

  it('returns empty string for nullish input', () => {
    expect(extractCopilotErrorMessage(null)).toBe('');
    expect(extractCopilotErrorMessage(undefined)).toBe('');
  });
});
