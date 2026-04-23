import fg from 'fast-glob';
import fs from 'node:fs/promises';
import { parseAgentFile } from './parser.js';

const IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.singleton/**'];

export async function scanAgents(root) {
  // Priorité à .claude/agents/ (répertoire natif Claude Code), puis tout le repo
  const claudeAgentsDir = `${root}/.claude/agents`;
  const hasClaudeAgents = await fg(['.claude/agents/*.md'], { cwd: root, absolute: true }).then(f => f.length > 0).catch(() => false);
  const patterns = hasClaudeAgents ? ['.claude/agents/*.md'] : ['**/*.md'];
  const files = await fg(patterns, { cwd: root, absolute: true, ignore: IGNORE });
  const agents = [];

  for (const file of files) {
    const content = await fs.readFile(file, 'utf8');
    const parsed = parseAgentFile(content, file);
    if (parsed) agents.push(parsed);
  }

  return agents;
}
