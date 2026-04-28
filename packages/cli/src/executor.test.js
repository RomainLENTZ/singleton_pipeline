import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runPipeline } from './executor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_AGENT = path.join(__dirname, '__fixtures__/agents/echo.md');

let tmpRoot;

async function makePipelineRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'singleton-test-'));
  await fs.mkdir(path.join(root, '.singleton', 'pipelines'), { recursive: true });
  await fs.mkdir(path.join(root, 'inputs'), { recursive: true });
  await fs.writeFile(path.join(root, 'inputs', 'sample.md'), '# sample input\n');
  return root;
}

async function writePipeline(root, name, payload) {
  const file = path.join(root, '.singleton', 'pipelines', `${name}.json`);
  await fs.writeFile(file, JSON.stringify(payload, null, 2));
  return file;
}

beforeAll(async () => {
  tmpRoot = await makePipelineRoot();
});

afterAll(async () => {
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('runPipeline preflight', () => {
  it('passes a valid dry-run pipeline', async () => {
    const file = await writePipeline(tmpRoot, 'valid', {
      name: 'valid',
      nodes: [],
      steps: [
        {
          agent: 'echo',
          agent_file: FIXTURE_AGENT,
          inputs: { text: '$FILE:inputs/sample.md' },
          outputs: { result: '$FILE:.singleton/output/result.md' },
        },
      ],
    });

    await expect(runPipeline(file, { dryRun: true, quiet: true })).resolves.toBeUndefined();
  });

  it('rejects sinks that escape the project root', async () => {
    const file = await writePipeline(tmpRoot, 'traversal', {
      name: 'traversal',
      nodes: [],
      steps: [
        {
          agent: 'echo',
          agent_file: FIXTURE_AGENT,
          inputs: { text: '$FILE:inputs/sample.md' },
          outputs: { result: '$FILE:../../tmp/evil.md' },
        },
      ],
    });

    await expect(runPipeline(file, { dryRun: true, quiet: true })).rejects.toThrow(/outside project root/);
  });

  it('rejects unknown $PIPE references', async () => {
    const file = await writePipeline(tmpRoot, 'badpipe', {
      name: 'badpipe',
      nodes: [],
      steps: [
        {
          agent: 'echo',
          agent_file: FIXTURE_AGENT,
          inputs: { text: '$PIPE:nonexistent.value' },
          outputs: { result: '$FILE:.singleton/output/r.md' },
        },
      ],
    });

    await expect(runPipeline(file, { dryRun: true, quiet: true })).rejects.toThrow(/PIPE/);
  });

  it('rejects missing input files', async () => {
    const file = await writePipeline(tmpRoot, 'missingfile', {
      name: 'missingfile',
      nodes: [],
      steps: [
        {
          agent: 'echo',
          agent_file: FIXTURE_AGENT,
          inputs: { text: '$FILE:inputs/does-not-exist.md' },
          outputs: { result: '$FILE:.singleton/output/r.md' },
        },
      ],
    });

    await expect(runPipeline(file, { dryRun: true, quiet: true })).rejects.toThrow(/matched no files/);
  });
});
