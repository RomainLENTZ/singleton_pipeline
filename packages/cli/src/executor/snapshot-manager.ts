import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { CommandResult, SnapshotChange, SnapshotState } from '../types.js';

export type StepSnapshot = {
  snapshotDir: string;
  captured: Set<string>;
  skippedLarge: string[];
  skippedBinary: string[];
  skippedIgnored: string[];
};

export type SnapshotCoverage = {
  captured: number;
  skippedLarge: number;
  skippedBinary: number;
  skippedIgnored: number;
  restorable: boolean;
};

type SnapshotCandidate = {
  relPath: string;
  absPath: string;
  size: number;
};

type RestoreSnapshotOptions = {
  root: string;
  snapshot: StepSnapshot;
  originalPaths: Set<string>;
  changes: SnapshotChange[];
};

type RestoreSnapshotResult = {
  restored: string[];
  removed: string[];
  skipped: string[];
};

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
function toPosix(value: unknown): string {
  return String(value || '').split(path.sep).join('/');
}

function runCommand(cmd: string, args: string[], { cwd }: { cwd: string }): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
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

export async function snapshotProjectFiles(
  root: string,
  rel = '',
  out: SnapshotState = new Map() as SnapshotState
): Promise<SnapshotState> {
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

export async function detectGitRepo(cwd: string): Promise<boolean> {
  try {
    await runCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
    return true;
  } catch {
    return false;
  }
}

export async function gitFilterIgnoredPaths(root: string, relPaths: string[]): Promise<Set<string>> {
  if (!relPaths.length) return new Set();
  const posix = relPaths.map((entry) => entry.split(path.sep).join('/'));
  const ignored = new Set<string>();
  await new Promise<void>((resolve) => {
    const child = spawn('git', ['check-ignore', '--stdin'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.on('error', () => resolve());
    child.on('close', () => {
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) ignored.add(trimmed);
      }
      resolve();
    });
    child.stdin.write(posix.join('\n'));
    child.stdin.end();
  });
  if (!ignored.size) return new Set();
  const result = new Set<string>();
  for (let i = 0; i < relPaths.length; i += 1) {
    const relPath = relPaths[i];
    if (relPath && ignored.has(posix[i] as string)) result.add(relPath);
  }
  return result;
}

function parseGitStatusPorcelain(raw: string): Map<string, string> {
  const files = new Map<string, string>();
  const records = String(raw || '').split('\0').filter(Boolean);
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i] as string;
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    // git porcelain always emits forward slashes; keep them as the canonical form.
    const relPath = record.slice(3);
    const topLevel = relPath.split('/')[0] || '';
    if (SNAPSHOT_SKIP_DIRS.has(topLevel)) {
      if (status[0] === 'R' || status[0] === 'C') i += 1;
      continue;
    }
    if (relPath) files.set(relPath, status);
    if (status[0] === 'R' || status[0] === 'C') i += 1;
  }
  return files;
}

async function captureGitStatus(root: string, gitRepo: boolean): Promise<Map<string, string> | null> {
  if (!gitRepo) return null;
  try {
    const { stdout } = await runCommand('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root });
    return parseGitStatusPorcelain(stdout);
  } catch {
    return null;
  }
}

function detectGitStatusChanges(
  beforeStatus: Map<string, string> | null | undefined,
  afterStatus: Map<string, string> | null | undefined,
  root: string
): SnapshotChange[] {
  if (!beforeStatus || !afterStatus) return [];
  const changed: SnapshotChange[] = [];
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

async function isProbablyBinaryFile(absPath: string): Promise<boolean> {
  let fd: fs.FileHandle | undefined;
  try {
    fd = await fs.open(absPath, 'r');
    const buf = Buffer.alloc(SNAPSHOT_BINARY_PROBE_BYTES);
    const { bytesRead } = await fd.read(buf, 0, SNAPSHOT_BINARY_PROBE_BYTES, 0);
    for (let i = 0; i < bytesRead; i += 1) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd) await fd.close().catch(() => {});
  }
}

async function collectSnapshotCandidates(
  root: string,
  rel = '',
  out: SnapshotCandidate[] = []
): Promise<SnapshotCandidate[]> {
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

export async function createStepSnapshot({
  root,
  snapshotDir,
  gitRepo,
  maxFileBytes = SNAPSHOT_MAX_FILE_BYTES,
}: {
  root: string;
  snapshotDir: string;
  gitRepo: boolean;
  maxFileBytes?: number;
}): Promise<StepSnapshot> {
  await fs.mkdir(snapshotDir, { recursive: true });
  const candidates = await collectSnapshotCandidates(root);
  const ignored = gitRepo
    ? await gitFilterIgnoredPaths(root, candidates.map((candidate) => candidate.relPath))
    : new Set<string>();

  const captured = new Set<string>();
  const skippedLarge: string[] = [];
  const skippedBinary: string[] = [];
  const skippedIgnored: string[] = [];

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

export function summarizeSnapshotCoverage(snapshot: StepSnapshot | null | undefined): SnapshotCoverage | null {
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

export function formatSnapshotCoverage(snapshot: StepSnapshot | null | undefined): string[] {
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
  root: string;
  gitRepo: boolean;

  constructor({ root, gitRepo = false }: { root: string, gitRepo?: boolean }) {
    this.root = root;
    this.gitRepo = gitRepo;
  }

  static async create({ root, gitRepo = null }: { root: string, gitRepo?: boolean | null }): Promise<SnapshotManager> {
    return new SnapshotManager({
      root,
      gitRepo: gitRepo ?? await detectGitRepo(root),
    });
  }

  async captureState(): Promise<SnapshotState> {
    const state = await snapshotProjectFiles(this.root);
    state.gitStatus = await captureGitStatus(this.root, this.gitRepo);
    return state;
  }

  async createRestoreSnapshot({
    snapshotDir,
    maxFileBytes = SNAPSHOT_MAX_FILE_BYTES,
  }: {
    snapshotDir: string;
    maxFileBytes?: number;
  }): Promise<StepSnapshot> {
    return createStepSnapshot({
      root: this.root,
      snapshotDir,
      gitRepo: this.gitRepo,
      maxFileBytes,
    });
  }

  detectChanges(before: SnapshotState, after: SnapshotState): SnapshotChange[] {
    const localChanges = detectSnapshotChanges(before, after, this.root);
    const changesByPath = new Map(localChanges.map((change) => [change.relPath, change]));
    for (const change of detectGitStatusChanges(before.gitStatus, after.gitStatus, this.root)) {
      if (!changesByPath.has(change.relPath)) changesByPath.set(change.relPath, change);
    }
    return [...changesByPath.values()];
  }

  async restore({
    snapshot,
    originalPaths,
    changes,
  }: {
    snapshot: StepSnapshot;
    originalPaths: Set<string>;
    changes: SnapshotChange[];
  }): Promise<RestoreSnapshotResult> {
    return restoreStepSnapshot({
      root: this.root,
      snapshot,
      originalPaths,
      changes,
    });
  }
}

export function detectSnapshotChanges(before: SnapshotState, after: SnapshotState, root: string): SnapshotChange[] {
  const changed: SnapshotChange[] = [];
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

export async function restoreStepSnapshot({
  root,
  snapshot,
  originalPaths,
  changes,
}: RestoreSnapshotOptions): Promise<RestoreSnapshotResult> {
  const restored: string[] = [];
  const removed: string[] = [];
  const skipped: string[] = [];
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
