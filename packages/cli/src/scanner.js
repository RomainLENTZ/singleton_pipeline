import fg from 'fast-glob';
import fs from 'node:fs/promises';
import { parseAgentFile } from './parser.js';

const SOURCES = [
  { kind: 'singleton', pattern: '.singleton/agents/*.md', priority: 3 },
  { kind: 'claude', pattern: '.claude/agents/*.md', priority: 2 },
  { kind: 'copilot', pattern: '.github/agents/*.md', priority: 2 },
  { kind: 'opencode', pattern: '.opencode/agents/*.md', priority: 2 },
];

function normalizeAgent(agent, source) {
  return {
    ...agent,
    source,
    provider: agent.provider || (['claude', 'copilot', 'opencode'].includes(source) ? source : undefined),
  };
}

export async function scanAgents(root) {
  const selected = new Map();

  for (const source of SOURCES) {
    const files = await fg([source.pattern], {
      cwd: root,
      absolute: true,
      ignore: source.ignore || [],
    });

    for (const file of files) {
      const content = await fs.readFile(file, 'utf8');
      const parsed = parseAgentFile(content, file);
      if (!parsed) continue;

      const agent = normalizeAgent(parsed, source.kind);
      const existing = selected.get(agent.id);

      if (!existing || source.priority > existing.priority) {
        selected.set(agent.id, { ...agent, priority: source.priority });
      }
    }
  }

  return [...selected.values()]
    .map(({ priority, ...agent }) => agent)
    .sort((a, b) => a.id.localeCompare(b.id));
}
