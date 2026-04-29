import { describe, it, expect } from 'vitest';
import { parseAgentFile, parseAgentFileDetailed } from './parser.js';

const VALID_AGENT = `# My Agent

## Config

- **id**: my-agent
- **description**: Does the thing
- **inputs**: alpha, beta
- **outputs**: result
- **tags**: writing, code
- **provider**: claude
- **model**: claude-sonnet-4-6
- **permission_mode**: bypassPermissions
- **security_profile**: restricted-write
- **allowed_paths**: src, tests
- **blocked_paths**: src/secrets

---

## Prompt

You are an agent. Do the thing with <alpha> and <beta>.
`;

describe('parseAgentFile', () => {
  it('parses required fields', () => {
    const a = parseAgentFile(VALID_AGENT, '/tmp/agent.md');
    expect(a.id).toBe('my-agent');
    expect(a.description).toBe('Does the thing');
    expect(a.inputs).toEqual(['alpha', 'beta']);
    expect(a.outputs).toEqual(['result']);
  });

  it('parses optional fields', () => {
    const a = parseAgentFile(VALID_AGENT, '/tmp/agent.md');
    expect(a.tags).toEqual(['writing', 'code']);
    expect(a.provider).toBe('claude');
    expect(a.model).toBe('claude-sonnet-4-6');
    expect(a.permission_mode).toBe('bypassPermissions');
    expect(a.security_profile).toBe('restricted-write');
    expect(a.allowed_paths).toEqual(['src', 'tests']);
    expect(a.blocked_paths).toEqual(['src/secrets']);
  });

  it('extracts the prompt body', () => {
    const a = parseAgentFile(VALID_AGENT, '/tmp/agent.md');
    expect(a.prompt).toContain('You are an agent.');
    expect(a.prompt).toContain('<alpha>');
  });

  it('strips YAML frontmatter', () => {
    const withFrontmatter = `---
foo: bar
---
${VALID_AGENT}`;
    const a = parseAgentFile(withFrontmatter, '/tmp/agent.md');
    expect(a.id).toBe('my-agent');
  });
});

describe('parseAgentFileDetailed errors', () => {
  it('returns error when ## Config is missing', () => {
    const { agent, error } = parseAgentFileDetailed('# Just a title\n\nNo config here.', '/tmp/x.md');
    expect(agent).toBeNull();
    expect(error).toMatch(/Config/);
  });

  it('returns error when a required field is missing', () => {
    const missing = `## Config\n\n- **id**: foo\n- **description**: bar\n- **outputs**: x\n`;
    const { agent, error } = parseAgentFileDetailed(missing, '/tmp/x.md');
    expect(agent).toBeNull();
    expect(error).toMatch(/inputs/);
  });
});
