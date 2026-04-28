import fs from 'node:fs/promises';
import path from 'node:path';

const PROJECT_DOC_FILENAMES = ['AGENTS.override.md', 'AGENTS.md'];
const SKIP_DIRS = new Set(['.git', '.singleton', 'node_modules', 'dist', 'build', '.next', '.cache', 'coverage']);

function isSubdir(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function readFirstNonEmptyFile(dir, names) {
  for (const name of names) {
    const filePath = path.join(dir, name);
    try {
      const content = (await fs.readFile(filePath, 'utf8')).trim();
      if (!content) continue;
      return { filePath, content };
    } catch {
      // ignore missing files
    }
  }
  return null;
}

async function collectInstructionFiles(rootDir, rel = '', out = []) {
  const abs = rel ? path.join(rootDir, rel) : rootDir;
  const entries = await fs.readdir(abs, { withFileTypes: true });

  const found = await readFirstNonEmptyFile(abs, PROJECT_DOC_FILENAMES);
  if (found) out.push(found);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    await collectInstructionFiles(rootDir, rel ? path.join(rel, entry.name) : entry.name, out);
  }

  return out;
}

export async function discoverCodexProjectInstructions(projectRoot, currentDir) {
  const root = projectRoot || currentDir;
  if (!root) return { text: '', files: [] };

  if (!projectRoot || !currentDir || !isSubdir(projectRoot, currentDir)) {
    const single = await readFirstNonEmptyFile(currentDir || projectRoot, PROJECT_DOC_FILENAMES);
    return single
      ? { text: `<!-- ${path.basename(single.filePath)} -->\n${single.content}`, files: [single.filePath] }
      : { text: '', files: [] };
  }

  const discovered = await collectInstructionFiles(root);
  discovered.sort((a, b) => {
    const relA = path.relative(root, a.filePath);
    const relB = path.relative(root, b.filePath);
    const depthA = relA.split(path.sep).length;
    const depthB = relB.split(path.sep).length;
    if (depthA !== depthB) return depthA - depthB;
    return relA.localeCompare(relB);
  });

  const chunks = [];
  const files = [];

  for (const found of discovered) {
    files.push(found.filePath);
    chunks.push(`<!-- ${path.relative(root, found.filePath)} -->\n${found.content}`);
  }

  return {
    text: chunks.join('\n\n').trim(),
    files,
  };
}
