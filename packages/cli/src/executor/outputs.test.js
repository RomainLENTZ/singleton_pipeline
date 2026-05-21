import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  assertRunArtifactWriteAllowed,
  moveAttemptArtifactsToAttemptDir,
  parseOutputs,
  rewriteInternalSink,
  summarizeParsedOutputs,
} from './outputs.js';

async function makeRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'singleton-outputs-test-'));
}

describe('pipeline outputs', () => {
  it('parses single and multi-output runner text', () => {
    expect(parseOutputs(' plain result ', ['result'])).toEqual({ result: 'plain result' });
    expect(parseOutputs('<result>ok</result><review>ship</review>', ['result', 'review'])).toEqual({
      result: 'ok',
      review: 'ship',
    });
  });

  it('summarizes parsed outputs', () => {
    expect(summarizeParsedOutputs({ result: 'hello\nworld', empty: '' }, ['result', 'empty'])).toEqual([
      { name: 'result', found: true, chars: 11, lines: 2 },
      { name: 'empty', found: false, chars: 0, lines: 0 },
    ]);
  });

  it('rewrites internal singleton sinks into the step workspace', () => {
    const cwd = '/repo';
    const stepDir = '/repo/.singleton/runs/run/01-agent';
    expect(rewriteInternalSink('$FILE:.singleton/output/result.md', { cwd, stepDir }))
      .toBe(`$FILE:${path.join(stepDir, 'result.md')}`);
    expect(rewriteInternalSink('$FILE:docs/result.md', { cwd, stepDir }))
      .toBe('$FILE:docs/result.md');
  });

  it('rejects run artifact writes outside the artifact root', () => {
    expect(() => assertRunArtifactWriteAllowed('/repo/outside.md', '/repo/.singleton/runs/run/01-agent', 'echo', 'result'))
      .toThrow(/outside the run artifact workspace/);
  });

  it('moves first-attempt artifacts into attempt-1 before replay', async () => {
    const root = await makeRoot();
    try {
      const stepDir = path.join(root, '.singleton', 'runs', 'run', '01-agent');
      const artifact = path.join(stepDir, 'result.md');
      await fs.mkdir(stepDir, { recursive: true });
      await fs.writeFile(artifact, 'first attempt\n');

      const result = await moveAttemptArtifactsToAttemptDir({
        cwd: root,
        stepDir,
        attempt: 1,
        writes: [{ absPath: artifact, relPath: path.relative(root, artifact), kind: 'intermediate' }],
        rawOutputPath: null,
      });

      const moved = path.join(stepDir, 'attempt-1', 'result.md');
      await expect(fs.readFile(moved, 'utf8')).resolves.toBe('first attempt\n');
      expect(result.writes).toEqual([
        { absPath: moved, relPath: path.relative(root, moved), kind: 'intermediate' },
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
