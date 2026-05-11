import { describe, expect, it } from 'vitest';
import { buildOpenCodeArgs, buildOpenCodeConfigContent, buildOpenCodeEnv, buildOpenCodePermissionConfig, extractOpenCodeErrorMessage, summarizeOpenCodeEvents } from './opencode.js';

describe('buildOpenCodeArgs', () => {
  it('builds a non-interactive OpenCode command without broad permissions by default', () => {
    expect(buildOpenCodeArgs({
      prompt: 'hello',
      model: 'ollama/qwen2.5-coder:14b',
      runnerAgent: 'reviewer',
      securityPolicy: { profile: 'read-only' },
    })).toEqual([
      'run',
      '--format',
      'json',
      '--model',
      'ollama/qwen2.5-coder:14b',
      '--agent',
      'reviewer',
      'hello',
    ]);
  });

  it('only skips OpenCode permissions for dangerous policies', () => {
    expect(buildOpenCodeArgs({
      prompt: 'hello',
      model: 'ollama/qwen2.5-coder:14b',
      runnerAgent: '',
      securityPolicy: { profile: 'dangerous' },
    })).toContain('--dangerously-skip-permissions');
  });
});

describe('buildOpenCodePermissionConfig', () => {
  it('maps read-only to native OpenCode denies', () => {
    expect(buildOpenCodePermissionConfig({ profile: 'read-only' })).toEqual({
      permission: {
        read: 'allow',
        glob: 'allow',
        grep: 'allow',
        edit: 'deny',
        bash: 'deny',
        task: 'deny',
        webfetch: 'deny',
        websearch: 'deny',
        external_directory: 'deny',
        doom_loop: 'ask',
      },
    });
  });

  it('maps restricted-write allowed paths to OpenCode edit patterns', () => {
    expect(buildOpenCodePermissionConfig({
      profile: 'restricted-write',
      allowedPaths: ['src', 'vite.config.ts'],
      blockedPaths: ['.env.*'],
    }).permission.edit).toEqual({
      '*': 'deny',
      'src/**': 'allow',
      'vite.config.ts': 'allow',
      '.env.*': 'deny',
    });
  });

  it('injects runner-agent permissions through OPENCODE_CONFIG_CONTENT payload', () => {
    const config = JSON.parse(buildOpenCodeConfigContent({
      runnerAgent: 'reviewer',
      securityPolicy: { profile: 'read-only' },
      existingContent: JSON.stringify({ model: 'ollama/test' }),
    }));

    expect(config.model).toBe('ollama/test');
    expect(config.permission.edit).toBe('deny');
    expect(config.agent.reviewer.permission.edit).toBe('deny');
  });

  it('injects per-agent permissions through OPENCODE_CONFIG_CONTENT without isolating the data dir', () => {
    const env = buildOpenCodeEnv({
      runnerAgent: 'reviewer',
      securityPolicy: { profile: 'read-only' },
      baseEnv: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'ollama/test' }) },
    });

    // We deliberately do NOT redirect XDG_DATA_HOME — OpenCode stores provider
    // auth there, so isolating it strips API credentials from the spawned
    // process.
    expect(env.XDG_DATA_HOME).toBeUndefined();
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT).agent.reviewer.permission.edit).toBe('deny');
  });
});

describe('summarizeOpenCodeEvents', () => {
  it('extracts assistant text and usage from JSON events', () => {
    const summary = summarizeOpenCodeEvents([
      { type: 'message', role: 'assistant', content: 'final answer' },
      { type: 'result', usage: { input_tokens: 10, output_tokens: 4 }, cost_usd: 0.01 },
    ]);

    expect(summary.text).toContain('final answer');
    expect(summary.tokens).toEqual({ input: 10, output: 4 });
    expect(summary.costUsd).toBe(0.01);
  });

  it('extracts OpenCode JSONL text and token metadata from part objects', () => {
    const summary = summarizeOpenCodeEvents([
      { type: 'step_start', part: { type: 'step-start' } },
      { type: 'text', part: { type: 'text', text: 'review body' } },
      {
        type: 'step_finish',
        part: {
          type: 'step-finish',
          tokens: { input: 12, output: 5, total: 17 },
          cost: 0,
        },
      },
    ]);

    expect(summary.text).toBe('review body');
    expect(summary.tokens).toEqual({ input: 12, output: 5 });
  });

  it('falls back to stdout when JSON events do not expose text', () => {
    const summary = summarizeOpenCodeEvents([], 'plain output\n');
    expect(summary.text).toBe('plain output');
  });
});

describe('extractOpenCodeErrorMessage', () => {
  it('extracts nested OpenCode JSON error messages', () => {
    expect(extractOpenCodeErrorMessage({
      type: 'error',
      error: {
        name: 'UnknownError',
        data: { message: 'Model not found: ollama/missing.' },
      },
    })).toBe('Model not found: ollama/missing.');
  });
});
