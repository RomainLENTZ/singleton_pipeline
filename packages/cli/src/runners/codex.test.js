import { describe, expect, it } from 'vitest';
import { buildCodexArgs, buildCodexSandboxArgs } from './codex.js';

describe('buildCodexSandboxArgs', () => {
  it('maps read-only to the Codex read-only sandbox', () => {
    expect(buildCodexSandboxArgs({ profile: 'read-only' })).toEqual([
      '--sandbox',
      'read-only',
    ]);
  });

  it('maps restricted-write to workspace-write (Codex has no per-path filter — Singleton post-run diff enforces allowed_paths)', () => {
    expect(buildCodexSandboxArgs({
      profile: 'restricted-write',
      allowedPaths: ['src'],
    })).toEqual([
      '--sandbox',
      'workspace-write',
    ]);
  });

  it('maps workspace-write to the Codex workspace-write sandbox', () => {
    expect(buildCodexSandboxArgs({ profile: 'workspace-write' })).toEqual([
      '--sandbox',
      'workspace-write',
    ]);
  });

  it('maps dangerous to danger-full-access', () => {
    expect(buildCodexSandboxArgs({ profile: 'dangerous' })).toEqual([
      '--sandbox',
      'danger-full-access',
    ]);
  });

  it('falls back to workspace-write when no profile is provided', () => {
    expect(buildCodexSandboxArgs({})).toEqual(
      buildCodexSandboxArgs({ profile: 'workspace-write' })
    );
  });
});

describe('buildCodexArgs', () => {
  it('builds the Codex exec command with the sandbox flag from securityPolicy', () => {
    const args = buildCodexArgs({
      prompt: 'hello',
      model: 'gpt-5',
      outputFile: '/tmp/out.txt',
      securityPolicy: { profile: 'read-only' },
    });

    expect(args).toEqual([
      'exec',
      '--json',
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--output-last-message',
      '/tmp/out.txt',
      '--model',
      'gpt-5',
      '-',
    ]);
  });

  it('omits --model when no model is configured', () => {
    const args = buildCodexArgs({
      prompt: 'hello',
      outputFile: '/tmp/out.txt',
      securityPolicy: { profile: 'workspace-write' },
    });
    expect(args).not.toContain('--model');
    expect(args[args.length - 1]).toBe('-');
  });

  it('places --model before the trailing stdin marker', () => {
    const args = buildCodexArgs({
      prompt: 'hello',
      model: 'gpt-5',
      outputFile: '/tmp/out.txt',
    });
    const modelIdx = args.indexOf('--model');
    const dashIdx = args.indexOf('-');
    expect(modelIdx).toBeGreaterThan(-1);
    expect(modelIdx).toBeLessThan(dashIdx);
  });
});
