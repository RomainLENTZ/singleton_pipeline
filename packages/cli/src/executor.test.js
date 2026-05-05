import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

vi.mock('./runners/index.js', () => ({
  getRunner: () => ({
    id: 'test-runner',
    command: null,
    async run({ cwd, userPrompt }) {
      if (userPrompt.includes('FAIL_RUNNER')) {
        throw new Error('simulated runner failure');
      }
      if (userPrompt.includes('WRITE_PROJECT_FILE')) {
        const fsMock = await import('node:fs/promises');
        const pathMock = await import('node:path');
        await fsMock.mkdir(pathMock.join(cwd, 'src'), { recursive: true });
        await fsMock.writeFile(pathMock.join(cwd, 'src', 'unexpected.js'), 'export const changed = true;\n');
      }
      if (userPrompt.includes('WRITE_LARGE_PROJECT_FILE')) {
        const fsMock = await import('node:fs/promises');
        const pathMock = await import('node:path');
        await fsMock.mkdir(pathMock.join(cwd, 'src'), { recursive: true });
        await fsMock.writeFile(pathMock.join(cwd, 'src', 'large.txt'), 'changed large file\n');
      }
      if (userPrompt.includes('WRITE_IDEA_FILE')) {
        const fsMock = await import('node:fs/promises');
        const pathMock = await import('node:path');
        await fsMock.mkdir(pathMock.join(cwd, '.idea'), { recursive: true });
        await fsMock.writeFile(pathMock.join(cwd, '.idea', 'workspace.xml'), '<workspace />\n');
      }
      if (userPrompt.includes('INVALID_FILES_JSON')) {
        return {
          text: 'not json',
          metadata: {},
        };
      }
      const metadata = userPrompt.includes('DEBUG_OVERRIDE')
        ? { turns: 3, costUsd: 0.5 }
        : { turns: 2, costUsd: 0.25 };
      return {
        text: userPrompt.includes('DEBUG_OVERRIDE') ? 'debug override seen' : 'generated text',
        metadata,
      };
    },
  }),
}));

import { runPipeline } from './executor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_AGENT = path.join(__dirname, '__fixtures__/agents/echo.md');

let tmpRoot;

async function makePipelineRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'singleton-test-'));
  await fs.mkdir(path.join(root, '.singleton', 'pipelines'), { recursive: true });
  await fs.mkdir(path.join(root, 'inputs'), { recursive: true });
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'inputs', 'sample.md'), '# sample input\n');
  await fs.writeFile(path.join(root, 'src', 'unexpected.js'), 'export const changed = false;\n');
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

    await expect(runPipeline(file, { dryRun: true, quiet: true })).rejects.toThrow(/outside the project root/);
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

  it('rejects unsupported Claude permission_mode values', async () => {
    const file = await writePipeline(tmpRoot, 'badperm', {
      name: 'badperm',
      nodes: [],
      steps: [
        {
          agent: 'echo',
          agent_file: FIXTURE_AGENT,
          permission_mode: 'ask',
          inputs: { text: '$FILE:inputs/sample.md' },
          outputs: { result: '$FILE:.singleton/output/result.md' },
        },
      ],
    });

    await expect(runPipeline(file, { dryRun: true, quiet: true })).rejects.toThrow(/unsupported Claude permission_mode/);
  });

  it('rejects writes to default blocked paths', async () => {
    const file = await writePipeline(tmpRoot, 'blocked-env', {
      name: 'blocked-env',
      nodes: [],
      steps: [
        {
          agent: 'echo',
          agent_file: FIXTURE_AGENT,
          inputs: { text: '$FILE:inputs/sample.md' },
          outputs: { result: '$FILE:.env' },
        },
      ],
    });

    await expect(runPipeline(file, { dryRun: true, quiet: true })).rejects.toThrow(/blocked by security policy/);
  });

  it('rejects restricted-write sinks outside allowed_paths', async () => {
    const file = await writePipeline(tmpRoot, 'restricted-write', {
      name: 'restricted-write',
      nodes: [],
      steps: [
        {
          agent: 'echo',
          agent_file: FIXTURE_AGENT,
          security_profile: 'restricted-write',
          allowed_paths: ['src'],
          inputs: { text: '$FILE:inputs/sample.md' },
          outputs: { result: '$FILE:docs/result.md' },
        },
      ],
    });

    await expect(runPipeline(file, { dryRun: true, quiet: true })).rejects.toThrow(/outside allowed_paths/);
  });

  it('rejects read-only writes to project files', async () => {
    const file = await writePipeline(tmpRoot, 'readonly-project-write', {
      name: 'readonly-project-write',
      nodes: [],
      steps: [
        {
          agent: 'echo',
          agent_file: FIXTURE_AGENT,
          security_profile: 'read-only',
          inputs: { text: '$FILE:inputs/sample.md' },
          outputs: { result: '$FILE:docs/result.md' },
        },
      ],
    });

    await expect(runPipeline(file, { dryRun: true, quiet: true })).rejects.toThrow(/read-only security_profile/);
  });

  it('allows read-only agents to write internal run artifacts', async () => {
    const file = await writePipeline(tmpRoot, 'readonly-artifact', {
      name: 'readonly-artifact',
      nodes: [],
      steps: [
        {
          agent: 'echo',
          agent_file: FIXTURE_AGENT,
          security_profile: 'read-only',
          inputs: { text: '$FILE:inputs/sample.md' },
          outputs: { result: '$FILE:.singleton/output/result.md' },
        },
      ],
    });

    await expect(runPipeline(file, { quiet: true })).resolves.toBeUndefined();

    const latestRun = await fs.realpath(path.join(tmpRoot, '.singleton', 'runs', 'latest'));
    const artifact = await fs.readFile(path.join(latestRun, '01-echo', 'result.md'), 'utf8');
    expect(artifact).toBe('generated text');
  });

  it('fails after a read-only agent modifies project files directly', async () => {
    await fs.writeFile(path.join(tmpRoot, 'inputs', 'write-project.md'), 'WRITE_PROJECT_FILE\n');
    const file = await writePipeline(tmpRoot, 'readonly-direct-write', {
      name: 'readonly-direct-write',
      nodes: [],
      steps: [
        {
          agent: 'echo',
          agent_file: FIXTURE_AGENT,
          security_profile: 'read-only',
          inputs: { text: '$FILE:inputs/write-project.md' },
          outputs: { result: '$FILE:.singleton/output/result.md' },
        },
      ],
    });

    await expect(runPipeline(file, { quiet: true })).rejects.toThrow(/Post-run security validation failed/);
  });

  it('ignores local tooling files during post-run validation', async () => {
    await fs.writeFile(path.join(tmpRoot, 'inputs', 'write-idea.md'), 'WRITE_IDEA_FILE\n');
    const file = await writePipeline(tmpRoot, 'readonly-idea-write', {
      name: 'readonly-idea-write',
      nodes: [],
      steps: [
        {
          agent: 'echo',
          agent_file: FIXTURE_AGENT,
          security_profile: 'read-only',
          inputs: { text: '$FILE:inputs/write-idea.md' },
          outputs: { result: '$FILE:.singleton/output/result.md' },
        },
      ],
    });

    await expect(runPipeline(file, { quiet: true })).resolves.toBeUndefined();
  });

  it('writes a failed run manifest when a step fails', async () => {
    await fs.writeFile(path.join(tmpRoot, 'inputs', 'fail-runner.md'), 'FAIL_RUNNER\n');
    const file = await writePipeline(tmpRoot, 'failed-manifest', {
      name: 'failed-manifest',
      nodes: [],
      steps: [
        {
          agent: 'echo',
          agent_file: FIXTURE_AGENT,
          inputs: { text: '$FILE:inputs/fail-runner.md' },
          outputs: { result: '$FILE:.singleton/output/result.md' },
        },
      ],
    });

    await expect(runPipeline(file, { quiet: true })).rejects.toThrow(/simulated runner failure/);

    const latestRun = await fs.realpath(path.join(tmpRoot, '.singleton', 'runs', 'latest'));
    const manifest = JSON.parse(await fs.readFile(path.join(latestRun, 'run-manifest.json'), 'utf8'));
    expect(manifest.pipeline).toBe('failed-manifest');
    expect(manifest.status).toBe('failed');
    expect(manifest.error.message).toMatch(/simulated runner failure/);
    expect(manifest.stats.at(-1)).toMatchObject({
      agent: 'echo',
      status: 'failed',
    });
  });

  it('can skip a step in debug mode without calling the runner', async () => {
    const file = await writePipeline(tmpRoot, 'debug-skip', {
      name: 'debug-skip',
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

    await expect(runPipeline(file, {
      quiet: true,
      debug: true,
      debugDecision: async () => 'skip',
    })).resolves.toBeUndefined();

    const latestRun = await fs.realpath(path.join(tmpRoot, '.singleton', 'runs', 'latest'));
    const manifest = JSON.parse(await fs.readFile(path.join(latestRun, 'run-manifest.json'), 'utf8'));
    expect(manifest.pipeline).toBe('debug-skip');
    expect(manifest.stats.at(-1)).toMatchObject({
      agent: 'echo',
      status: 'skipped',
    });
    await expect(fs.access(path.join(latestRun, '01-echo', 'result.md'))).rejects.toThrow();
  });

  it('can override resolved inputs in debug mode for the current run', async () => {
    const file = await writePipeline(tmpRoot, 'debug-input-override', {
      name: 'debug-input-override',
      nodes: [],
      steps: [
        {
          agent: 'echo',
          agent_file: FIXTURE_AGENT,
          inputs: { text: 'original input' },
          outputs: { result: '$FILE:.singleton/output/result.md' },
        },
      ],
    });

    await expect(runPipeline(file, {
      quiet: true,
      debug: true,
      debugDecision: async () => ({
        action: 'continue',
        inputs: { text: 'DEBUG_OVERRIDE' },
      }),
    })).resolves.toBeUndefined();

    const latestRun = await fs.realpath(path.join(tmpRoot, '.singleton', 'runs', 'latest'));
    expect(path.basename(latestRun)).toMatch(/^DEBUG-/);
    const artifact = await fs.readFile(path.join(latestRun, '01-echo', 'attempt-1', 'result.md'), 'utf8');
    expect(artifact).toBe('debug override seen');
    const manifest = JSON.parse(await fs.readFile(path.join(latestRun, 'run-manifest.json'), 'utf8'));
    expect(manifest.debugEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        step: 'echo',
        phase: 'pre-step',
        action: 'continue',
        editedInputs: ['text'],
      }),
      expect.objectContaining({
        step: 'echo',
        phase: 'post-step',
        action: 'continue',
      }),
    ]));
    expect(JSON.stringify(manifest.debugEvents)).not.toMatch(/Generate the requested code/);
  });

  it('can abort after a debug output review', async () => {
    const file = await writePipeline(tmpRoot, 'debug-output-abort', {
      name: 'debug-output-abort',
      nodes: [],
      steps: [
        {
          agent: 'echo',
          agent_file: FIXTURE_AGENT,
          inputs: { text: 'normal input' },
          outputs: { result: '$FILE:.singleton/output/result.md' },
        },
      ],
    });

    await expect(runPipeline(file, {
      quiet: true,
      debug: true,
      debugDecision: async () => 'continue',
      debugPostDecision: async () => 'abort',
    })).rejects.toThrow(/output review/);

    const latestRun = await fs.realpath(path.join(tmpRoot, '.singleton', 'runs', 'latest'));
    const manifest = JSON.parse(await fs.readFile(path.join(latestRun, 'run-manifest.json'), 'utf8'));
    expect(manifest.pipeline).toBe('debug-output-abort');
    expect(manifest.status).toBe('failed');
    expect(manifest.error.message).toMatch(/output review/);
    expect(manifest.stats.at(-1)).toMatchObject({
      agent: 'echo',
      status: 'failed',
    });
  });

  it('records parsed output warnings in debug run manifests', async () => {
    const file = await writePipeline(tmpRoot, 'debug-output-warnings', {
      name: 'debug-output-warnings',
      nodes: [],
      steps: [
        {
          agent: 'echo',
          agent_file: FIXTURE_AGENT,
          inputs: { text: 'normal input' },
          outputs: {
            result: '$FILE:.singleton/output/result.md',
            review: '$FILE:.singleton/output/review.md',
          },
        },
      ],
    });

    await expect(runPipeline(file, {
      quiet: true,
      debug: true,
      debugDecision: async () => 'continue',
      debugPostDecision: async () => 'continue',
    })).resolves.toBeUndefined();

    const latestRun = await fs.realpath(path.join(tmpRoot, '.singleton', 'runs', 'latest'));
    const manifest = JSON.parse(await fs.readFile(path.join(latestRun, 'run-manifest.json'), 'utf8'));
    const stepStats = manifest.stats.at(-1);
    expect(stepStats.outputWarnings).toEqual([
      'output "result" is empty',
      'output "review" is empty',
    ]);
    expect(stepStats.parsedOutputs).toEqual([
      { name: 'result', found: false, chars: 0, lines: 0 },
      { name: 'review', found: false, chars: 0, lines: 0 },
    ]);
    expect(stepStats.rawOutputPath).toMatch(/raw-output\.md$/);
    const raw = await fs.readFile(path.join(tmpRoot, stepStats.rawOutputPath), 'utf8');
    expect(raw).toContain('Output warning');
    expect(raw).toContain('generated text');
  });

  it('can replay a debug step with updated inputs', async () => {
    const file = await writePipeline(tmpRoot, 'debug-replay-step', {
      name: 'debug-replay-step',
      nodes: [],
      steps: [
        {
          agent: 'echo',
          agent_file: FIXTURE_AGENT,
          inputs: { text: 'original input' },
          outputs: { result: '$FILE:.singleton/output/result.md' },
        },
      ],
    });
    let postCalls = 0;

    await expect(runPipeline(file, {
      quiet: true,
      debug: true,
      debugDecision: async () => 'continue',
      debugPostDecision: async () => {
        postCalls += 1;
        if (postCalls === 1) {
          return {
            action: 'replay',
            inputs: { text: 'DEBUG_OVERRIDE' },
          };
        }
        return 'continue';
      },
    })).resolves.toBeUndefined();

    const latestRun = await fs.realpath(path.join(tmpRoot, '.singleton', 'runs', 'latest'));
    const artifact = await fs.readFile(path.join(latestRun, '01-echo', 'attempt-2', 'result.md'), 'utf8');
    expect(artifact).toBe('debug override seen');
    await expect(fs.access(path.join(latestRun, '01-echo', 'attempt-1', 'result.md'))).resolves.toBeUndefined();
    const manifest = JSON.parse(await fs.readFile(path.join(latestRun, 'run-manifest.json'), 'utf8'));
    expect(manifest.stats.at(-1)).toMatchObject({
      agent: 'echo',
      attempts: 2,
      turns: 5,
      cost: 0.75,
    });
    expect(manifest.debugEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        step: 'echo',
        phase: 'post-step',
        action: 'replay',
      }),
      expect.objectContaining({
        step: 'echo',
        phase: 'post-step',
        action: 'replay-start',
        editedInputs: ['text'],
      }),
    ]));
  });

  it('stops debug replay after the configured per-step limit', async () => {
    const file = await writePipeline(tmpRoot, 'debug-replay-limit', {
      name: 'debug-replay-limit',
      nodes: [],
      steps: [
        {
          agent: 'echo',
          agent_file: FIXTURE_AGENT,
          inputs: { text: 'original input' },
          outputs: { result: '$FILE:.singleton/output/result.md' },
        },
      ],
    });

    await expect(runPipeline(file, {
      quiet: true,
      debug: true,
      maxDebugReplays: 1,
      debugDecision: async () => 'continue',
      debugPostDecision: async () => ({
        action: 'replay',
        inputs: { text: 'DEBUG_OVERRIDE' },
      }),
    })).rejects.toThrow(/Replay limit reached/);

    const latestRun = await fs.realpath(path.join(tmpRoot, '.singleton', 'runs', 'latest'));
    const manifest = JSON.parse(await fs.readFile(path.join(latestRun, 'run-manifest.json'), 'utf8'));
    expect(manifest.status).toBe('failed');
    expect(manifest.stats.at(-1)).toMatchObject({
      agent: 'echo',
      status: 'failed',
      attempts: 2,
    });
  });

  it('restores project file changes before replaying a debug step', async () => {
    await fs.writeFile(path.join(tmpRoot, 'src', 'unexpected.js'), 'export const changed = false;\n');
    const file = await writePipeline(tmpRoot, 'debug-replay-restore', {
      name: 'debug-replay-restore',
      nodes: [],
      steps: [
        {
          agent: 'echo',
          agent_file: FIXTURE_AGENT,
          security_profile: 'workspace-write',
          inputs: { text: 'WRITE_PROJECT_FILE' },
          outputs: { result: '$FILE:.singleton/output/result.md' },
        },
      ],
    });
    let postCalls = 0;

    await expect(runPipeline(file, {
      quiet: true,
      debug: true,
      debugDecision: async () => 'continue',
      debugPostDecision: async () => {
        postCalls += 1;
        if (postCalls === 1) {
          return {
            action: 'replay',
            inputs: { text: 'DEBUG_OVERRIDE' },
          };
        }
        return 'continue';
      },
    })).resolves.toBeUndefined();

    const latestRun = await fs.realpath(path.join(tmpRoot, '.singleton', 'runs', 'latest'));
    const restoredProjectFile = await fs.readFile(path.join(tmpRoot, 'src', 'unexpected.js'), 'utf8');
    const finalArtifact = await fs.readFile(path.join(latestRun, '01-echo', 'attempt-2', 'result.md'), 'utf8');

    expect(restoredProjectFile).toBe('export const changed = false;\n');
    expect(finalArtifact).toBe('debug override seen');
    await expect(fs.access(path.join(latestRun, '01-echo', 'attempt-1', 'result.md'))).resolves.toBeUndefined();
  });

  it('aborts replay when a changed original file was excluded from the snapshot', async () => {
    await fs.writeFile(path.join(tmpRoot, 'src', 'large.txt'), `${'x'.repeat(1024 * 1024 + 1)}\n`);
    const file = await writePipeline(tmpRoot, 'debug-replay-incomplete-restore', {
      name: 'debug-replay-incomplete-restore',
      nodes: [],
      steps: [
        {
          agent: 'echo',
          agent_file: FIXTURE_AGENT,
          security_profile: 'workspace-write',
          inputs: { text: 'WRITE_LARGE_PROJECT_FILE' },
          outputs: { result: '$FILE:.singleton/output/result.md' },
        },
      ],
    });

    await expect(runPipeline(file, {
      quiet: true,
      debug: true,
      debugDecision: async () => 'continue',
      debugPostDecision: async () => ({
        action: 'replay',
        inputs: { text: 'DEBUG_OVERRIDE' },
      }),
    })).rejects.toThrow(/Replay restore incomplete/);

    const latestRun = await fs.realpath(path.join(tmpRoot, '.singleton', 'runs', 'latest'));
    const manifest = JSON.parse(await fs.readFile(path.join(latestRun, 'run-manifest.json'), 'utf8'));
    expect(manifest.status).toBe('failed');
    expect(manifest.error.message).toMatch(/src\/large\.txt/);
    expect(manifest.stats.at(-1)).toMatchObject({
      agent: 'echo',
      status: 'failed',
      attempts: 2,
    });
  });

  it('saves raw output when structured output parsing fails', async () => {
    const file = await writePipeline(tmpRoot, 'raw-output-on-parse-failure', {
      name: 'raw-output-on-parse-failure',
      nodes: [],
      steps: [
        {
          agent: 'echo',
          agent_file: FIXTURE_AGENT,
          inputs: { text: 'INVALID_FILES_JSON' },
          outputs: { result: '$FILES:.singleton/output/generated' },
        },
      ],
    });

    await expect(runPipeline(file, { quiet: true })).rejects.toThrow(/invalid JSON/);

    const latestRun = await fs.realpath(path.join(tmpRoot, '.singleton', 'runs', 'latest'));
    const raw = await fs.readFile(path.join(latestRun, '01-echo', 'raw-output.md'), 'utf8');
    expect(raw).toContain('Invalid $FILES JSON');
    expect(raw).toContain('not json');
  });
});
