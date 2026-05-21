import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SnapshotManager, summarizeSnapshotCoverage } from './snapshot-manager.js';

const execFileAsync = promisify(execFile);

async function makeRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'singleton-snapshot-test-'));
}

async function git(root, args) {
  return execFileAsync('git', args, { cwd: root });
}

describe('SnapshotManager', () => {
  it('restores a modified file to its pre-step dirty state', async () => {
    const root = await makeRoot();
    try {
      const file = path.join(root, 'src', 'dirty.js');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, 'user dirty state\n');

      const manager = await SnapshotManager.create({ root, gitRepo: false });
      const before = await manager.captureState();
      const snapshot = await manager.createRestoreSnapshot({ snapshotDir: path.join(root, '.singleton', 'runs', 'test', '.snapshot') });

      await fs.writeFile(file, 'agent changed state\n');
      const after = await manager.captureState();
      const changes = manager.detectChanges(before, after);

      const result = await manager.restore({
        snapshot,
        originalPaths: new Set(before.keys()),
        changes,
      });

      await expect(fs.readFile(file, 'utf8')).resolves.toBe('user dirty state\n');
      expect(result).toMatchObject({ restored: ['src/dirty.js'], removed: [], skipped: [] });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('removes files created after the snapshot', async () => {
    const root = await makeRoot();
    try {
      const manager = await SnapshotManager.create({ root, gitRepo: false });
      const before = await manager.captureState();
      const snapshot = await manager.createRestoreSnapshot({ snapshotDir: path.join(root, '.singleton', 'runs', 'test', '.snapshot') });
      const created = path.join(root, 'src', 'created.js');
      await fs.mkdir(path.dirname(created), { recursive: true });
      await fs.writeFile(created, 'created by agent\n');

      const after = await manager.captureState();
      const changes = manager.detectChanges(before, after);
      const result = await manager.restore({
        snapshot,
        originalPaths: new Set(before.keys()),
        changes,
      });

      await expect(fs.access(created)).rejects.toThrow();
      expect(result).toMatchObject({ restored: [], removed: ['src/created.js'], skipped: [] });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('reports non-restorable coverage for files above the snapshot size limit', async () => {
    const root = await makeRoot();
    try {
      const file = path.join(root, 'large.txt');
      await fs.writeFile(file, 'large but tiny in test\n');
      const manager = await SnapshotManager.create({ root, gitRepo: false });
      const snapshot = await manager.createRestoreSnapshot({
        snapshotDir: path.join(root, '.singleton', 'runs', 'test', '.snapshot'),
        maxFileBytes: 1,
      });

      expect(summarizeSnapshotCoverage(snapshot)).toMatchObject({
        captured: 0,
        skippedLarge: 1,
        skippedBinary: 0,
        skippedIgnored: 0,
        restorable: false,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('cross-checks local snapshots with git status changes without restoring to HEAD', async () => {
    const root = await makeRoot();
    try {
      await git(root, ['init']);
      await fs.writeFile(path.join(root, 'tracked.txt'), 'committed\n');
      await git(root, ['add', 'tracked.txt']);
      await git(root, ['-c', 'user.name=Singleton Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial']);

      await fs.writeFile(path.join(root, 'tracked.txt'), 'user dirty\n');
      const manager = await SnapshotManager.create({ root, gitRepo: true });
      const before = await manager.captureState();
      const snapshot = await manager.createRestoreSnapshot({ snapshotDir: path.join(root, '.singleton', 'runs', 'test', '.snapshot') });

      await fs.writeFile(path.join(root, 'tracked.txt'), 'agent dirty\n');
      await fs.writeFile(path.join(root, 'new.txt'), 'agent new\n');
      const after = await manager.captureState();
      const changes = manager.detectChanges(before, after);

      expect(changes.map((change) => change.relPath).sort()).toEqual(['new.txt', 'tracked.txt']);

      await manager.restore({
        snapshot,
        originalPaths: new Set(before.keys()),
        changes,
      });

      await expect(fs.readFile(path.join(root, 'tracked.txt'), 'utf8')).resolves.toBe('user dirty\n');
      await expect(fs.access(path.join(root, 'new.txt'))).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
