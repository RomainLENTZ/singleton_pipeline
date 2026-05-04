import { describe, expect, it } from 'vitest';
import { buildCopilotPermissionArgs } from './copilot.js';

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
});
