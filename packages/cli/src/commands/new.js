import fs from 'node:fs/promises';
import path from 'node:path';
import { input, search, select, confirm } from '@inquirer/prompts';
import { style, line } from '../theme.js';
import { scanAgents } from '../scanner.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const CLAUDE_MODELS = [
  { name: 'claude-opus-4-7', value: 'claude-opus-4-7' },
  { name: 'claude-sonnet-4-6', value: 'claude-sonnet-4-6' },
  { name: 'claude-haiku-4-5', value: 'claude-haiku-4-5' },
  { name: '(aucun)', value: '' }
];
const PROVIDERS = [
  { name: 'claude', value: 'claude' },
  { name: 'codex', value: 'codex' },
];

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

const DONE = '__DONE__';
const UNDO = '__UNDO__';
const SLUG_ITEM_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

async function collectList({ message, existing }) {
  const picked = [];

  while (true) {
    const summary = picked.length ? style.muted(`[${picked.join(', ')}]`) : '';

    const answer = await search({
      message: summary ? `${message} ${summary}` : message,
      source: async (term) => {
        const t = (term || '').trim();
        const choices = [];

        if (picked.length > 0) {
          choices.push({
            name: `← retirer « ${picked[picked.length - 1]} »`,
            value: UNDO
          });
        }

        const avail = existing.filter((v) => !picked.includes(v));
        const matching = t
          ? avail.filter((v) => v.toLowerCase().includes(t.toLowerCase()))
          : avail;
        for (const v of matching) choices.push({ name: v, value: v });

        if (t && SLUG_ITEM_RE.test(t) && !existing.includes(t) && !picked.includes(t)) {
          choices.push({ name: `+ créer « ${t} »`, value: t });
        }

        choices.push({ name: '✓ terminer', value: DONE });
        return choices;
      }
    });

    if (answer === DONE) break;
    if (answer === UNDO) {
      picked.pop();
      continue;
    }
    if (!picked.includes(answer)) picked.push(answer);
  }

  return picked;
}

export async function newAgentCommand(opts) {
  const root = path.resolve(opts.root || process.cwd());
  const existing = await scanAgents(root);

  const existingIds = new Set(existing.map((a) => a.id));
  const existingOutputs = uniqueSorted(existing.flatMap((a) => a.outputs));
  const existingInputs = uniqueSorted(existing.flatMap((a) => a.inputs));
  const existingTags = uniqueSorted(existing.flatMap((a) => a.tags));
  const inputSuggestions = uniqueSorted([...existingOutputs, ...existingInputs]);

  const id = await input({
    message: 'id',
    validate: (v) => {
      if (!SLUG_RE.test(v)) return 'slug invalide (a-z, 0-9, tirets)';
      if (existingIds.has(v)) return `id "${v}" déjà utilisé`;
      return true;
    }
  });

  const title = await input({
    message: 'titre',
    default: id
      .split('-')
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join(' ')
  });

  const description = await input({
    message: 'description',
    validate: (v) => (v.trim() ? true : 'requis')
  });

  const inputs = await collectList({
    message: 'inputs',
    existing: inputSuggestions,
    hint: 'input'
  });

  const outputs = await collectList({
    message: 'outputs',
    existing: existingOutputs,
    hint: 'output'
  });

  const tags = await collectList({
    message: 'tags',
    existing: existingTags,
    hint: 'tag'
  });

  const provider = await select({
    message: 'provider',
    choices: PROVIDERS,
    default: 'claude'
  });

  const model = provider === 'claude'
    ? await select({
        message: 'modèle',
        choices: CLAUDE_MODELS,
        default: 'claude-sonnet-4-6'
      })
    : await input({
        message: 'modèle',
        default: '',
      });

  const estimatedRaw = await input({
    message: 'estimated_tokens',
    default: '',
    validate: (v) => (v === '' || /^\d+$/.test(v) ? true : 'entier attendu')
  });

  const defaultDir = existing[0]
    ? path.relative(root, path.dirname(existing[0].file)) || 'agents'
    : 'agents';
  const dir = await input({
    message: 'dossier',
    default: defaultDir
  });

  const filename = await input({
    message: 'fichier',
    default: `${id}.md`,
    validate: (v) => (v.endsWith('.md') ? true : 'doit finir par .md')
  });

  const targetDir = path.resolve(root, dir);
  const targetFile = path.join(targetDir, filename);

  try {
    await fs.access(targetFile);
    const overwrite = await confirm({
      message: `${path.relative(root, targetFile)} existe. Écraser ?`,
      default: false
    });
    if (!overwrite) return;
  } catch {
    // file doesn't exist
  }

  const content = renderAgentFile({ title, id, description, inputs, outputs, tags, provider, model, estimatedTokens: estimatedRaw });

  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(targetFile, content);

  console.log(line.success(path.relative(root, targetFile)));
}

function renderAgentFile({ title, id, description, inputs, outputs, tags, provider, model, estimatedTokens }) {
  const lines = [
    `# ${title}`,
    '',
    '## Config',
    '',
    `- **id**: ${id}`,
    `- **description**: ${description}`,
    `- **inputs**: ${inputs.join(', ')}`,
    `- **outputs**: ${outputs.join(', ')}`
  ];
  if (tags.length) lines.push(`- **tags**: ${tags.join(', ')}`);
  if (provider) lines.push(`- **provider**: ${provider}`);
  if (model) lines.push(`- **model**: ${model}`);
  if (estimatedTokens) lines.push(`- **estimated_tokens**: ${estimatedTokens}`);
  lines.push('', '---', '', '## Prompt', '', '<!-- Ton prompt ici -->', '');
  return lines.join('\n');
}
