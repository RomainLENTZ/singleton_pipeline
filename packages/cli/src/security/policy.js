import path from 'node:path';
import fs from 'node:fs/promises';

const VALID_PROFILES = new Set(['read-only', 'workspace-write', 'restricted-write', 'dangerous']);
const DEFAULT_PROFILE = 'workspace-write';
const DEFAULT_BLOCKED_PATHS = ['.git', 'node_modules', '.env', '.env.*', '.ssh'];
const DEFAULT_COMMIT_EXCLUDE_PATHS = ['.singleton'];

function asList(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function normalizeRel(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function matchesPattern(relPath, pattern) {
  const rel = normalizeRel(relPath);
  const pat = normalizeRel(pattern);
  if (!pat) return false;
  if (pat.endsWith('.*')) {
    const prefix = pat.slice(0, -1);
    return rel === pat.slice(0, -2) || rel.startsWith(prefix);
  }
  return rel === pat || rel.startsWith(`${pat}/`);
}

function resolvePath(root, value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
}

export function resolveSecurityPolicy(step = {}, agent = {}) {
  return resolveSecurityPolicyWithConfig(step, agent);
}

export async function loadProjectSecurityConfig(root) {
  const file = path.join(root, '.singleton', 'security.json');
  try {
    const raw = await fs.readFile(file, 'utf8');
    const config = JSON.parse(raw);
    return {
      file,
      defaultProfile: config.default_profile || DEFAULT_PROFILE,
      allowedPaths: asList(config.allowed_paths),
      blockedPaths: asList(config.blocked_paths),
      commit: {
        excludePaths: [
          ...DEFAULT_COMMIT_EXCLUDE_PATHS,
          ...asList(config.commit?.exclude_paths),
        ],
        requireConfirmation: config.commit?.require_confirmation !== false,
      },
    };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`Invalid project security config: ${file} (${err.message})`);
    }
    return {
      file,
      defaultProfile: DEFAULT_PROFILE,
      allowedPaths: [],
      blockedPaths: [],
      commit: {
        excludePaths: DEFAULT_COMMIT_EXCLUDE_PATHS,
        requireConfirmation: true,
      },
    };
  }
}

export function resolveSecurityPolicyWithConfig(step = {}, agent = {}, projectConfig = {}) {
  const profile = step.security_profile || agent.security_profile || projectConfig.defaultProfile || DEFAULT_PROFILE;
  return {
    profile,
    allowedPaths: asList(step.allowed_paths ?? agent.allowed_paths ?? projectConfig.allowedPaths),
    blockedPaths: [
      ...DEFAULT_BLOCKED_PATHS,
      ...asList(projectConfig.blockedPaths),
      ...asList(step.blocked_paths ?? agent.blocked_paths),
    ],
  };
}

export function validateSecurityPolicy(policy) {
  const errors = [];
  if (!VALID_PROFILES.has(policy.profile)) {
    errors.push(`unknown security_profile "${policy.profile}"`);
  }
  if (policy.profile === 'restricted-write' && policy.allowedPaths.length === 0) {
    errors.push('restricted-write requires at least one allowed_paths entry');
  }
  return errors;
}

export function assertWriteAllowed(absTarget, { root, agentName, outputName, policy }) {
  const absRoot = path.resolve(root);
  const absPath = path.resolve(absTarget);
  const rel = path.relative(absRoot, absPath);

  if (!isInside(absRoot, absPath)) {
    throw new Error(`Step "${agentName}" output "${outputName}" resolves outside the project root: ${absPath}`);
  }

  if (policy.profile === 'read-only') {
    throw new Error(`Step "${agentName}" output "${outputName}" is blocked by read-only security_profile: ${rel}`);
  }

  if (policy.profile !== 'dangerous') {
    const blocked = policy.blockedPaths.find((pattern) => matchesPattern(rel, pattern));
    if (blocked) {
      throw new Error(`Step "${agentName}" output "${outputName}" is blocked by security policy "${blocked}": ${rel}`);
    }
  }

  if (policy.profile === 'restricted-write') {
    const allowed = policy.allowedPaths.some((entry) => isInside(resolvePath(absRoot, entry), absPath));
    if (!allowed) {
      throw new Error(`Step "${agentName}" output "${outputName}" is outside allowed_paths: ${rel}`);
    }
  }
}
