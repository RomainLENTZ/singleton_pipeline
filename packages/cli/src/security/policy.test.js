import { describe, expect, it } from 'vitest';
import { resolveSecurityPolicyWithConfig } from './policy.js';

describe('resolveSecurityPolicyWithConfig', () => {
  it('uses project defaults when step and agent do not define a profile', () => {
    const policy = resolveSecurityPolicyWithConfig({}, {}, {
      defaultProfile: 'read-only',
      allowedPaths: ['src'],
      blockedPaths: ['dist'],
    });

    expect(policy.profile).toBe('read-only');
    expect(policy.allowedPaths).toEqual(['src']);
    expect(policy.blockedPaths).toContain('dist');
  });

  it('lets agent config override project defaults', () => {
    const policy = resolveSecurityPolicyWithConfig({}, {
      security_profile: 'restricted-write',
      allowed_paths: ['tests'],
    }, {
      defaultProfile: 'read-only',
      allowedPaths: ['src'],
    });

    expect(policy.profile).toBe('restricted-write');
    expect(policy.allowedPaths).toEqual(['tests']);
  });

  it('lets step config override agent config', () => {
    const policy = resolveSecurityPolicyWithConfig({
      security_profile: 'dangerous',
      blocked_paths: ['tmp'],
    }, {
      security_profile: 'read-only',
      blocked_paths: ['dist'],
    }, {
      defaultProfile: 'workspace-write',
      blockedPaths: ['coverage'],
    });

    expect(policy.profile).toBe('dangerous');
    expect(policy.blockedPaths).toContain('coverage');
    expect(policy.blockedPaths).toContain('tmp');
    expect(policy.blockedPaths).not.toContain('dist');
  });
});
