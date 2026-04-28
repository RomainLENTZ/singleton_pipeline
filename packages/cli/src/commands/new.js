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
const CODEX_MODELS = [
  { name: 'gpt-5-codex', value: 'gpt-5-codex' },
  { name: 'gpt-5.2-codex', value: 'gpt-5.2-codex' },
  { name: 'gpt-5.1-codex', value: 'gpt-5.1-codex' },
  { name: '(aucun)', value: '' }
];
const PROVIDERS = [
  { name: 'claude', value: 'claude' },
  { name: 'codex', value: 'codex' },
];
const DEFAULT_AGENTS_DIR = '.singleton/agents';
const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-4-6';
const CODEX_DEFAULT_MODEL = 'gpt-5-codex';

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function defaultTitleFromId(id) {
  return id
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

function parseCsvList(value) {
  return uniqueSorted(
    String(value || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

async function askShellValue(shell, message, { defaultValue = '', validate = null, normalize = (v) => v } = {}) {
  while (true) {
    const answer = await shell.prompt(defaultValue ? `${message} (default: ${defaultValue})` : message);
    const value = answer.trim() || defaultValue;
    const verdict = validate ? validate(value) : true;
    if (verdict === true) return normalize(value);
    shell.log(`{red-fg}✕{/} ${verdict}`);
  }
}

function modelChoicesForProvider(provider) {
  return provider === 'codex' ? CODEX_MODELS : CLAUDE_MODELS;
}

async function askShellChoice(shell, message, choices, defaultValue) {
  shell.log('');
  shell.log(`{bold}${message}{/}`);
  choices.forEach((choice, index) => {
    const marker = choice.value === defaultValue ? 'default' : 'option';
    shell.log(`  {#797C81-fg}${index + 1}.{/} ${choice.name}${choice.value === defaultValue ? ` {#797C81-fg}(${marker}){/}` : ''}`);
  });

  while (true) {
    const answer = (await shell.prompt(`${message} (number or exact value)`)).trim();
    const raw = answer || defaultValue;
    const byIndex = /^\d+$/.test(raw) ? choices[Number(raw) - 1] : null;
    const byValue = choices.find((choice) => choice.value === raw);
    const selected = byIndex || byValue;
    if (selected) return selected.value;
    shell.log(`{red-fg}✕{/} Choisis une valeur dans la liste.`);
  }
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
    : await select({
        message: 'modèle',
        choices: CODEX_MODELS,
        default: CODEX_DEFAULT_MODEL
      });

  const estimatedRaw = await input({
    message: 'estimated_tokens',
    default: '',
    validate: (v) => (v === '' || /^\d+$/.test(v) ? true : 'entier attendu')
  });

  const filename = await input({
    message: 'fichier',
    default: `${id}.md`,
    validate: (v) => (v.endsWith('.md') ? true : 'doit finir par .md')
  });

  const targetDir = path.resolve(root, DEFAULT_AGENTS_DIR);
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

  console.log(style.muted(`Dossier canonique : ${DEFAULT_AGENTS_DIR}`));
  console.log(line.success(path.relative(root, targetFile)));
}

export async function newAgentShellCommand({ root, shell }) {
  const absRoot = path.resolve(root || process.cwd());
  const existing = await scanAgents(absRoot);

  const existingIds = new Set(existing.map((a) => a.id));
  const existingOutputs = uniqueSorted(existing.flatMap((a) => a.outputs));
  const existingInputs = uniqueSorted(existing.flatMap((a) => a.inputs));
  const existingTags = uniqueSorted(existing.flatMap((a) => a.tags));
  const inputSuggestions = uniqueSorted([...existingOutputs, ...existingInputs]);

  shell.log('{bold}New agent{/}');
  shell.log(`{#797C81-fg}Canonical dir: ${DEFAULT_AGENTS_DIR}{/}`);
  shell.log('');

  const id = await askShellValue(shell, 'id', {
    validate: (v) => {
      if (!SLUG_RE.test(v)) return 'slug invalide (a-z, 0-9, tirets)';
      if (existingIds.has(v)) return `id "${v}" déjà utilisé`;
      return true;
    },
  });

  const title = await askShellValue(shell, 'titre', {
    defaultValue: defaultTitleFromId(id),
  });

  const description = await askShellValue(shell, 'description', {
    validate: (v) => (v.trim() ? true : 'requis'),
  });

  if (inputSuggestions.length) {
    shell.log(`{#797C81-fg}Input suggestions: ${inputSuggestions.join(', ')}{/}`);
  }
  const inputs = parseCsvList(await askShellValue(shell, 'inputs (comma separated)'));

  if (existingOutputs.length) {
    shell.log(`{#797C81-fg}Output suggestions: ${existingOutputs.join(', ')}{/}`);
  }
  const outputs = parseCsvList(await askShellValue(shell, 'outputs (comma separated)', {
    validate: (v) => (parseCsvList(v).length > 0 ? true : 'au moins une output requise'),
  }));

  if (existingTags.length) {
    shell.log(`{#797C81-fg}Tag suggestions: ${existingTags.join(', ')}{/}`);
  }
  const tags = parseCsvList(await askShellValue(shell, 'tags (comma separated, optional)'));

  const provider = await askShellChoice(shell, 'provider', PROVIDERS, 'claude');
  const model = await askShellChoice(
    shell,
    'modèle',
    modelChoicesForProvider(provider),
    provider === 'claude' ? CLAUDE_DEFAULT_MODEL : CODEX_DEFAULT_MODEL
  );

  const estimatedTokens = await askShellValue(shell, 'estimated_tokens (optional)', {
    validate: (v) => (v === '' || /^\d+$/.test(v) ? true : 'entier attendu'),
  });

  const filename = await askShellValue(shell, 'fichier', {
    defaultValue: `${id}.md`,
    validate: (v) => (v.endsWith('.md') ? true : 'doit finir par .md'),
  });

  const targetDir = path.resolve(absRoot, DEFAULT_AGENTS_DIR);
  const targetFile = path.join(targetDir, filename);

  try {
    await fs.access(targetFile);
    const overwrite = await askShellValue(shell, `${path.relative(absRoot, targetFile)} existe. Écraser ? [y/N]`, {
      defaultValue: 'n',
      normalize: (v) => v.toLowerCase(),
      validate: (v) => (['y', 'yes', 'n', 'no'].includes(v.toLowerCase()) ? true : 'réponds y ou n'),
    });
    if (!['y', 'yes'].includes(overwrite)) {
      shell.log(`{#797C81-fg}Création annulée.{/}`);
      return null;
    }
  } catch {
    // file doesn't exist
  }

  const content = renderAgentFile({
    title,
    id,
    description,
    inputs,
    outputs,
    tags,
    provider,
    model,
    estimatedTokens,
  });

  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(targetFile, content);

  shell.log('');
  shell.log(`{green-fg}✓{/} ${path.relative(absRoot, targetFile)}`);
  return targetFile;
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
