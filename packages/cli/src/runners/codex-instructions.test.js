import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { discoverCodexProjectInstructions } from './codex-instructions.js';

let tmpRoot;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'singleton-codex-instructions-'));
});

afterEach(async () => {
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('discoverCodexProjectInstructions', () => {
  it('collects project instructions from root to deeper directories', async () => {
    await fs.mkdir(path.join(tmpRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, 'AGENTS.md'), 'root guidance');
    await fs.writeFile(path.join(tmpRoot, 'src', 'AGENTS.md'), 'src guidance');

    const result = await discoverCodexProjectInstructions(tmpRoot, path.join(tmpRoot, 'src'));

    expect(result.files).toEqual([
      path.join(tmpRoot, 'AGENTS.md'),
      path.join(tmpRoot, 'src', 'AGENTS.md'),
    ]);
    expect(result.text).toContain('root guidance');
    expect(result.text).toContain('src guidance');
  });

  it('prefers AGENTS.override.md over AGENTS.md in the same directory', async () => {
    await fs.writeFile(path.join(tmpRoot, 'AGENTS.md'), 'base guidance');
    await fs.writeFile(path.join(tmpRoot, 'AGENTS.override.md'), 'override guidance');

    const result = await discoverCodexProjectInstructions(tmpRoot, tmpRoot);

    expect(result.files).toEqual([path.join(tmpRoot, 'AGENTS.override.md')]);
    expect(result.text).toContain('override guidance');
    expect(result.text).not.toContain('base guidance');
  });
});
