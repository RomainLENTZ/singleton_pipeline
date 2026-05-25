import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** @typedef {import('../types.js').CommandResult} CommandResult */
/** @typedef {import('../types.js').SnapshotChange} SnapshotChange */
/** @typedef {import('../types.js').SnapshotState} SnapshotState */

export const SNAPSHOT_SKIP_DIRS = new Set([
  '.git',
  '.singleton',
  '.opencode',
  '.idea',
  '.vscode',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.cache',
  'coverage',
]);

export const SNAPSHOT_MAX_FILE_BYTES = 1024 * 1024;
const SNAPSHOT_BINARY_PROBE_BYTES = 8192;

// All relPaths exposed by this module use POSIX separators ('/'), so that
// run manifests, restore reports and diffs stay portable across OSes.
// path.join still accepts '/' on win32, so fs operations remain correct.
/**
 * @param {unknown} p
 * @returns {string}
 */
function toPosix(p) {
  return String(p || '').split(path.sep).join('/');
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd: string }} options
 * @returns {Promise<CommandResult>}
 */
function runCommand(cmd, args, { cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `${cmd} exited ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * @param {string} root
 * @param {string} [rel]
 * @param {SnapshotState} [out]
 * @returns {Promise<SnapshotState>}
 */
export async function snapshotProjectFiles(root, rel = '', out = /** @type {SnapshotState} */ (new Map())) {
  const abs = path.join(root, rel);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SNAPSHOT_SKIP_DIRS.has(entry.name)) continue;
      await snapshotProjectFiles(root, path.join(rel, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    const entryRel = path.join(rel, entry.name);
    const entryAbs = path.join(root, entryRel);
    const stat = await fs.stat(entryAbs);
    out.set(toPosix(entryRel), `${stat.size}:${Math.floor(stat.mtimeMs)}`);
  }
  return out;
}

export async function detectGitRepo(cwd) {
  try {
    await runCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
    return true;
  } catch {
    return false;
  }
}

export async function gitFilterIgnoredPaths(root, relPaths) {
  if (!relPaths.length) return new Set();
  const posix = relPaths.map((p) => p.split(path.sep).join('/'));
  const ignored = new Set();
  await new Promise((resolve) => {
    const child = spawn('git', ['check-ignore', '--stdin'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.on('error', () => resolve(undefined));
    child.on('close', () => {
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) ignored.add(trimmed);
      }
      resolve(undefined);
    });
    child.stdin.write(posix.join('\n'));
    child.stdin.end();
  });
  if (!ignored.size) return new Set();
  const result = new Set();
  for (let i = 0; i < relPaths.length; i++) {
    if (ignored.has(posix[i])) result.add(relPaths[i]);
  }
  return result;
}

function parseGitStatusPorcelain(raw) {
  const files = new Map();
  const records = String(raw || '').split('\0').filter(Boolean);
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    // git porcelain always emits forward slashes; keep them as the canonical form.
    const relPath = record.slice(3);
    const topLevel = relPath.split('/')[0];
    if (SNAPSHOT_SKIP_DIRS.has(topLevel)) {
      if (status[0] === 'R' || status[0] === 'C') i += 1;
      continue;
    }
    if (relPath) files.set(relPath, status);
    if (status[0] === 'R' || status[0] === 'C') i += 1;
  }
  return files;
}

async function captureGitStatus(root, gitRepo) {
  if (!gitRepo) return null;
  try {
    const { stdout } = await runCommand('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root });
    return parseGitStatusPorcelain(stdout);
  } catch {
    return null;
  }
}

function detectGitStatusChanges(beforeStatus, afterStatus, root) {
  if (!beforeStatus || !afterStatus) return [];
  const changed = [];
  const paths = new Set([...beforeStatus.keys(), ...afterStatus.keys()]);
  for (const relPath of paths) {
    if (beforeStatus.get(relPath) === afterStatus.get(relPath)) continue;
    changed.push({
      relPath,
      absPath: path.join(root, relPath),
      kind: 'deliverable',
    });
  }
  return changed;
}

async function isProbablyBinaryFile(absPath) {
  let fd;
  try {
    fd = await fs.open(absPath, 'r');
    const buf = Buffer.alloc(SNAPSHOT_BINARY_PROBE_BYTES);
    const { bytesRead } = await fd.read(buf, 0, SNAPSHOT_BINARY_PROBE_BYTES, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd) await fd.close().catch(() => {});
  }
}

async function collectSnapshotCandidates(root, rel = '', out = []) {
  const abs = path.join(root, rel);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SNAPSHOT_SKIP_DIRS.has(entry.name)) continue;
      await collectSnapshotCandidates(root, path.join(rel, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    const entryRel = path.join(rel, entry.name);
    const entryAbs = path.join(root, entryRel);
    let size = 0;
    try {
      const stat = await fs.stat(entryAbs);
      size = stat.size;
    } catch {
      continue;
    }
    out.push({ relPath: toPosix(entryRel), absPath: entryAbs, size });
  }
  return out;
}

export async function createStepSnapshot({ root, snapshotDir, gitRepo, maxFileBytes = SNAPSHOT_MAX_FILE_BYTES }) {
  await fs.mkdir(snapshotDir, { recursive: true });
  const candidates = await collectSnapshotCandidates(root);
  const ignored = gitRepo
    ? await gitFilterIgnoredPaths(root, candidates.map((c) => c.relPath))
    : new Set();

  const captured = new Set();
  const skippedLarge = [];
  const skippedBinary = [];
  const skippedIgnored = [];

  for (const { relPath, absPath, size } of candidates) {
    if (ignored.has(relPath)) {
      skippedIgnored.push(relPath);
      continue;
    }
    if (size > maxFileBytes) {
      skippedLarge.push(relPath);
      continue;
    }
    if (await isProbablyBinaryFile(absPath)) {
      skippedBinary.push(relPath);
      continue;
    }
    const dest = path.join(snapshotDir, relPath);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fs.copyFile(absPath, dest, fsConstants.COPYFILE_FICLONE);
    } catch {
      try {
        await fs.copyFile(absPath, dest);
      } catch {
        continue;
      }
    }
    captured.add(relPath);
  }

  return { snapshotDir, captured, skippedLarge, skippedBinary, skippedIgnored };
}

export function summarizeSnapshotCoverage(snapshot) {
  if (!snapshot) return null;
  return {
    captured: snapshot.captured?.size || 0,
    skippedLarge: snapshot.skippedLarge?.length || 0,
    skippedBinary: snapshot.skippedBinary?.length || 0,
    skippedIgnored: snapshot.skippedIgnored?.length || 0,
    restorable: !(
      snapshot.skippedLarge?.length ||
      snapshot.skippedBinary?.length ||
      snapshot.skippedIgnored?.length
    ),
  };
}

export function formatSnapshotCoverage(snapshot) {
  const coverage = summarizeSnapshotCoverage(snapshot);
  if (!coverage) return [];
  return [
    `captured ${coverage.captured} file${coverage.captured === 1 ? '' : 's'}`,
    `skipped large ${coverage.skippedLarge}`,
    `skipped binary ${coverage.skippedBinary}`,
    `skipped gitignored ${coverage.skippedIgnored}`,
  ];
}

export class SnapshotManager {
  /**
   * @param {{ root: string, gitRepo?: boolean }} options
   */
  constructor({ root, gitRepo = false }) {
    this.root = root;
    this.gitRepo = gitRepo;
  }

  /**
   * @param {{ root: string, gitRepo?: boolean | null }} options
   * @returns {Promise<SnapshotManager>}
   */
  static async create({ root, gitRepo = null }) {
    return new SnapshotManager({
      root,
      gitRepo: gitRepo ?? await detectGitRepo(root),
    });
  }

  async captureState() {
    const state = await snapshotProjectFiles(this.root);
    state.gitStatus = await captureGitStatus(this.root, this.gitRepo);
    return state;
  }

  async createRestoreSnapshot({ snapshotDir, maxFileBytes = SNAPSHOT_MAX_FILE_BYTES }) {
    return createStepSnapshot({
      root: this.root,
      snapshotDir,
      gitRepo: this.gitRepo,
      maxFileBytes,
    });
  }

  detectChanges(before, after) {
    const localChanges = detectSnapshotChanges(before, after, this.root);
    const changesByPath = new Map(localChanges.map((change) => [change.relPath, change]));
    for (const change of detectGitStatusChanges(before.gitStatus, after.gitStatus, this.root)) {
      if (!changesByPath.has(change.relPath)) changesByPath.set(change.relPath, change);
    }
    return [...changesByPath.values()];
  }

  async restore({ snapshot, originalPaths, changes }) {
    return restoreStepSnapshot({
      root: this.root,
      snapshot,
      originalPaths,
      changes,
    });
  }
}

export function detectSnapshotChanges(before, after, root) {
  const changed = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const relPath of paths) {
    const beforeSig = before.get(relPath);
    const afterSig = after.get(relPath);
    if (beforeSig === afterSig) continue;
    changed.push({
      relPath,
      absPath: path.join(root, relPath),
      kind: 'deliverable',
    });
  }
  return changed;
}

export async function restoreStepSnapshot({ root, snapshot, originalPaths, changes }) {
  const restored = [];
  const removed = [];
  const skipped = [];
  for (const change of changes) {
    const relPath = change?.relPath;
    if (!relPath) continue;
    const absPath = path.join(root, relPath);
    if (snapshot.captured.has(relPath)) {
      const src = path.join(snapshot.snapshotDir, relPath);
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.copyFile(src, absPath);
      restored.push(relPath);
    } else if (originalPaths.has(relPath)) {
      skipped.push(relPath);
    } else {
      await fs.rm(absPath, { recursive: true, force: true });
      removed.push(relPath);
    }
  }
  return { restored, removed, skipped };
}
