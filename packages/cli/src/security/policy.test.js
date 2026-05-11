import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertWriteAllowed, resolveSecurityPolicyWithConfig } from './policy.js';

const ROOT = '/repo';

function policy({ profile = 'workspace-write', allowedPaths = [], blockedPaths = [] } = {}) {
  return { profile, allowedPaths, blockedPaths };
}

function callAssert(absTarget, policyObj) {
  return assertWriteAllowed(absTarget, {
    root: ROOT,
    agentName: 'test-agent',
    outputName: 'unit-test',
    policy: policyObj,
  });
}

describe('resolveSecurityPolicyWithConfig', () => {
  it('uses project defaults when step and agent do not define a profile', () => {
    const result = resolveSecurityPolicyWithConfig({}, {}, {
      defaultProfile: 'read-only',
      allowedPaths: ['src'],
      blockedPaths: ['dist'],
    });

    expect(result.profile).toBe('read-only');
    expect(result.allowedPaths).toEqual(['src']);
    expect(result.blockedPaths).toContain('dist');
  });

  it('lets agent config override project defaults', () => {
    const result = resolveSecurityPolicyWithConfig({}, {
      security_profile: 'restricted-write',
      allowed_paths: ['tests'],
    }, {
      defaultProfile: 'read-only',
      allowedPaths: ['src'],
    });

    expect(result.profile).toBe('restricted-write');
    expect(result.allowedPaths).toEqual(['tests']);
  });

  it('lets step config override agent config', () => {
    const result = resolveSecurityPolicyWithConfig({
      security_profile: 'dangerous',
      blocked_paths: ['tmp'],
    }, {
      security_profile: 'read-only',
      blocked_paths: ['dist'],
    }, {
      defaultProfile: 'workspace-write',
      blockedPaths: ['coverage'],
    });

    expect(result.profile).toBe('dangerous');
    expect(result.blockedPaths).toContain('coverage');
    expect(result.blockedPaths).toContain('tmp');
    expect(result.blockedPaths).not.toContain('dist');
  });
});

describe('assertWriteAllowed — Layer 3 atomic predicate', () => {
  it('rejects any write under the read-only profile', () => {
    expect(() => callAssert('/repo/src/foo.js', policy({ profile: 'read-only' })))
      .toThrow(/blocked by read-only security_profile/);
  });

  it('rejects writes that resolve outside the project root', () => {
    expect(() => callAssert('/etc/passwd', policy({ profile: 'workspace-write' })))
      .toThrow(/resolves outside the project root/);
  });

  it('rejects writes outside allowed_paths under restricted-write', () => {
    expect(() => callAssert(
      '/repo/secrets/api-keys.txt',
      policy({ profile: 'restricted-write', allowedPaths: ['src/landing.js'] })
    )).toThrow(/is outside allowed_paths/);
  });

  it('allows writes inside allowed_paths under restricted-write', () => {
    expect(() => callAssert(
      '/repo/src/landing.js',
      policy({ profile: 'restricted-write', allowedPaths: ['src/landing.js'] })
    )).not.toThrow();
  });

  it('allows writes inside a directory listed in allowed_paths', () => {
    expect(() => callAssert(
      '/repo/src/components/Button.vue',
      policy({ profile: 'restricted-write', allowedPaths: ['src'] })
    )).not.toThrow();
  });

  it('blocks DEFAULT_BLOCKED_PATHS (.git, .env, .ssh, node_modules) under workspace-write', () => {
    const wp = policy({ profile: 'workspace-write', blockedPaths: ['.git', '.env', '.env.*', '.ssh', 'node_modules'] });
    expect(() => callAssert('/repo/.git/config', wp)).toThrow(/blocked by security policy ".git"/);
    expect(() => callAssert('/repo/.env', wp)).toThrow(/blocked by security policy ".env"/);
    expect(() => callAssert('/repo/.env.production', wp)).toThrow(/blocked by security policy ".env.\*"/);
    expect(() => callAssert('/repo/.ssh/id_rsa', wp)).toThrow(/blocked by security policy ".ssh"/);
    expect(() => callAssert('/repo/node_modules/foo/index.js', wp))
      .toThrow(/blocked by security policy "node_modules"/);
  });

  it('allows arbitrary writes under workspace-write when no blocked path matches', () => {
    expect(() => callAssert(
      '/repo/src/anywhere.js',
      policy({ profile: 'workspace-write', blockedPaths: ['.git', '.env'] })
    )).not.toThrow();
  });

  it('still blocks paths outside the project root under dangerous profile', () => {
    expect(() => callAssert('/etc/passwd', policy({ profile: 'dangerous' })))
      .toThrow(/resolves outside the project root/);
  });

  it('allows blocked_paths under dangerous profile (escape hatch by design)', () => {
    expect(() => callAssert(
      '/repo/.env',
      policy({ profile: 'dangerous', blockedPaths: ['.env'] })
    )).not.toThrow();
  });

  it('rejects a malicious "../" traversal that lands inside a blocked dir', () => {
    // path resolution flattens .., so /repo/src/../.git/config → /repo/.git/config
    const traversal = path.resolve(ROOT, 'src/../.git/config');
    expect(() => callAssert(traversal, policy({
      profile: 'restricted-write',
      allowedPaths: ['src'],
      blockedPaths: ['.git'],
    }))).toThrow(/blocked by security policy ".git"/);
  });

  it('rejects a "../" traversal that escapes the project root', () => {
    const escape = path.resolve(ROOT, '../outside.txt');
    expect(() => callAssert(escape, policy({ profile: 'workspace-write' })))
      .toThrow(/resolves outside the project root/);
  });
});
