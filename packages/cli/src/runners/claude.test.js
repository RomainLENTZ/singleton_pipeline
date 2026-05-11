import { describe, expect, it } from 'vitest';
import { buildClaudePermissionArgs } from './claude.js';

describe('buildClaudePermissionArgs', () => {
  it('denies write/edit/bash tools for read-only profile', () => {
    expect(buildClaudePermissionArgs({ profile: 'read-only' })).toEqual([
      '--disallowedTools',
      'Write,Edit,Bash,NotebookEdit',
    ]);
  });

  it('uses acceptEdits for restricted-write so Claude can edit without prompting', () => {
    expect(buildClaudePermissionArgs({
      profile: 'restricted-write',
      allowedPaths: ['src'],
    })).toEqual([
      '--permission-mode',
      'acceptEdits',
    ]);
  });

  it('uses acceptEdits for workspace-write', () => {
    expect(buildClaudePermissionArgs({ profile: 'workspace-write' })).toEqual([
      '--permission-mode',
      'acceptEdits',
    ]);
  });

  it('falls back to workspace-write when no profile is provided', () => {
    expect(buildClaudePermissionArgs({})).toEqual(
      buildClaudePermissionArgs({ profile: 'workspace-write' })
    );
  });

  it('uses bypassPermissions for dangerous profile', () => {
    expect(buildClaudePermissionArgs({ profile: 'dangerous' })).toEqual([
      '--permission-mode',
      'bypassPermissions',
    ]);
  });

  it('honors a legacy bypassPermissions permission_mode override', () => {
    expect(buildClaudePermissionArgs(
      { profile: 'read-only' },
      'bypassPermissions'
    )).toEqual(['--permission-mode', 'bypassPermissions']);
  });

  it('rejects an unsupported legacy permission_mode value', () => {
    expect(() => buildClaudePermissionArgs({}, 'acceptEdits')).toThrow(
      /unsupported Claude permission_mode: acceptEdits/
    );
  });
});
