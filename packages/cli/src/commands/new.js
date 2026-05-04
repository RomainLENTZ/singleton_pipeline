import fs from 'node:fs/promises';
import path from 'node:path';
import { input, search, select, confirm } from '@inquirer/prompts';
import { style, line } from '../theme.js';
import { scanAgents } from '../scanner.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const CHOICE_NONE = { name: '(none)', value: '' };
const CLAUDE_MODELS = [
  { name: 'claude-opus-4-7', value: 'claude-opus-4-7' },
  { name: 'claude-sonnet-4-6', value: 'claude-sonnet-4-6' },
  { name: 'claude-haiku-4-5', value: 'claude-haiku-4-5' },
  CHOICE_NONE,
];
const CODEX_MODELS = [
  { name: 'gpt-5.4', value: 'gpt-5.4' },
  { name: 'gpt-5-codex', value: 'gpt-5-codex' },
  { name: 'gpt-5.2-codex', value: 'gpt-5.2-codex' },
  { name: 'gpt-5.1-codex', value: 'gpt-5.1-codex' },
  CHOICE_NONE,
];
const COPILOT_MODELS = [
  { name: 'gpt-5.4-mini', value: 'gpt-5.4-mini' },
  { name: 'gpt-5.4', value: 'gpt-5.4' },
  { name: 'gpt-4.1', value: 'gpt-4.1' },
  CHOICE_NONE,
];
const PROVIDERS = [
  { name: 'claude', value: 'claude' },
  { name: 'codex', value: 'codex' },
  { name: 'copilot', value: 'copilot' },
];
const CLAUDE_PERMISSION_MODES = [
  { name: '(safe default)', value: '' },
  { name: 'bypassPermissions', value: 'bypassPermissions' },
];
const DEFAULT_AGENTS_DIR = '.singleton/agents';
const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-4-6';
const CODEX_DEFAULT_MODEL = 'gpt-5.4';
const COPILOT_DEFAULT_MODEL = 'gpt-5.4-mini';

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

async function loadAgentCreationContext(root) {
  const existing = await scanAgents(root);

  return {
    root,
    existing,
    existingIds: new Set(existing.map((a) => a.id)),
    existingOutputs: uniqueSorted(existing.flatMap((a) => a.outputs)),
    existingInputs: uniqueSorted(existing.flatMap((a) => a.inputs)),
    existingTags: uniqueSorted(existing.flatMap((a) => a.tags)),
  };
}

function inputSuggestionsFromContext(context) {
  return uniqueSorted([...context.existingOutputs, ...context.existingInputs]);
}

function validateAgentId(existingIds, value) {
  if (!SLUG_RE.test(value)) return 'invalid slug (a-z, 0-9, hyphens)';
  if (existingIds.has(value)) return `id "${value}" is already used`;
  return true;
}

function defaultModelForProvider(provider) {
  if (provider === 'codex') return CODEX_DEFAULT_MODEL;
  if (provider === 'copilot') return COPILOT_DEFAULT_MODEL;
  return CLAUDE_DEFAULT_MODEL;
}

function permissionChoicesForProvider(provider) {
  return provider === 'claude' ? CLAUDE_PERMISSION_MODES : [CHOICE_NONE];
}

function normalizeAgentDraft(draft) {
  return {
    ...draft,
    inputs: uniqueSorted(draft.inputs || []),
    outputs: uniqueSorted(draft.outputs || []),
    tags: uniqueSorted(draft.tags || []),
    permissionMode: draft.provider === 'claude' ? (draft.permissionMode || '') : '',
    runnerAgent: draft.provider === 'copilot' ? (draft.runnerAgent || '') : '',
    model: draft.model || '',
    estimatedTokens: draft.estimatedTokens || '',
  };
}

async function writeAgentDraft({ root, draft, askOverwrite }) {
  const filename = draft.filename.endsWith('.md') ? draft.filename : `${draft.filename}.md`;
  const targetDir = path.resolve(root, DEFAULT_AGENTS_DIR);
  const targetFile = path.join(targetDir, filename);

  try {
    await fs.access(targetFile);
    const overwrite = await askOverwrite(path.relative(root, targetFile));
    if (!overwrite) return null;
  } catch {
    // file doesn't exist
  }

  const content = renderAgentFile(normalizeAgentDraft(draft));
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(targetFile, content);
  return targetFile;
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
  if (provider === 'codex') return CODEX_MODELS;
  if (provider === 'copilot') return COPILOT_MODELS;
  return CLAUDE_MODELS;
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
    shell.log(`{red-fg}✕{/} Choose a value from the list.`);
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
            name: `← remove "${picked[picked.length - 1]}"`,
            value: UNDO
          });
        }

        const avail = existing.filter((v) => !picked.includes(v));
        const matching = t
          ? avail.filter((v) => v.toLowerCase().includes(t.toLowerCase()))
          : avail;
        for (const v of matching) choices.push({ name: v, value: v });

        if (t && SLUG_ITEM_RE.test(t) && !existing.includes(t) && !picked.includes(t)) {
          choices.push({ name: `+ create "${t}"`, value: t });
        }

        choices.push({ name: '✓ finish', value: DONE });
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
  const context = await loadAgentCreationContext(root);
  const inputSuggestions = inputSuggestionsFromContext(context);

  const id = await input({
    message: 'id',
    validate: (v) => validateAgentId(context.existingIds, v),
  });

  const title = await input({
    message: 'title',
    default: id
      .split('-')
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join(' ')
  });

  const description = await input({
    message: 'description',
    validate: (v) => (v.trim() ? true : 'required')
  });

  const inputs = await collectList({
    message: 'inputs',
    existing: inputSuggestions,
  });

  const outputs = await collectList({
    message: 'outputs',
    existing: context.existingOutputs,
  });

  const tags = await collectList({
    message: 'tags',
    existing: context.existingTags,
  });

  const provider = await select({
    message: 'provider',
    choices: PROVIDERS,
    default: 'claude'
  });

  const model = await select({
    message: 'model',
    choices: modelChoicesForProvider(provider),
    default: defaultModelForProvider(provider),
  });

  const permissionMode = provider === 'claude'
    ? await select({
        message: 'permission_mode',
        choices: permissionChoicesForProvider(provider),
        default: '',
      })
    : '';
  const runnerAgent = provider === 'copilot'
    ? await input({
        message: 'runner_agent',
        default: id,
      })
    : '';

  const estimatedRaw = await input({
    message: 'estimated_tokens',
    default: '',
    validate: (v) => (v === '' || /^\d+$/.test(v) ? true : 'expected an integer')
  });

  const filename = await input({
    message: 'file',
    default: `${id}.md`,
    validate: (v) => (v.endsWith('.md') ? true : 'must end with .md')
  });

  const targetFile = await writeAgentDraft({
    root,
    draft: {
      title,
      id,
      description,
      inputs,
      outputs,
      tags,
      provider,
      model,
      runnerAgent,
      permissionMode,
      estimatedTokens: estimatedRaw,
      filename,
    },
    askOverwrite: (relativeFile) => confirm({
      message: `${relativeFile} already exists. Overwrite?`,
      default: false,
    }),
  });
  if (!targetFile) return;

  console.log(style.muted(`Canonical directory: ${DEFAULT_AGENTS_DIR}`));
  console.log(line.success(path.relative(root, targetFile)));
}

export async function newAgentShellCommand({ root, shell }) {
  const absRoot = path.resolve(root || process.cwd());
  const context = await loadAgentCreationContext(absRoot);
  const inputSuggestions = inputSuggestionsFromContext(context);

  shell.log('{bold}New agent{/}');
  shell.log(`{#797C81-fg}Canonical dir: ${DEFAULT_AGENTS_DIR}{/}`);
  shell.log('');

  const id = await askShellValue(shell, 'id', {
    validate: (v) => validateAgentId(context.existingIds, v),
  });

  const title = await askShellValue(shell, 'title', {
    defaultValue: defaultTitleFromId(id),
  });

  const description = await askShellValue(shell, 'description', {
    validate: (v) => (v.trim() ? true : 'required'),
  });

  if (inputSuggestions.length) {
    shell.log(`{#797C81-fg}Input suggestions: ${inputSuggestions.join(', ')}{/}`);
  }
  const inputs = parseCsvList(await askShellValue(shell, 'inputs (comma separated)'));

  if (context.existingOutputs.length) {
    shell.log(`{#797C81-fg}Output suggestions: ${context.existingOutputs.join(', ')}{/}`);
  }
  const outputs = parseCsvList(await askShellValue(shell, 'outputs (comma separated)', {
    validate: (v) => (parseCsvList(v).length > 0 ? true : 'at least one output is required'),
  }));

  if (context.existingTags.length) {
    shell.log(`{#797C81-fg}Tag suggestions: ${context.existingTags.join(', ')}{/}`);
  }
  const tags = parseCsvList(await askShellValue(shell, 'tags (comma separated, optional)'));

  const provider = await askShellChoice(shell, 'provider', PROVIDERS, 'claude');
  const model = await askShellChoice(
    shell,
    'model',
    modelChoicesForProvider(provider),
    defaultModelForProvider(provider)
  );
  const permissionMode = provider === 'claude'
    ? await askShellChoice(shell, 'permission_mode', permissionChoicesForProvider(provider), '')
    : '';
  const runnerAgent = provider === 'copilot'
    ? await askShellValue(shell, 'runner_agent', { defaultValue: id })
    : '';

  const estimatedTokens = await askShellValue(shell, 'estimated_tokens (optional)', {
    validate: (v) => (v === '' || /^\d+$/.test(v) ? true : 'expected an integer'),
  });

  const filename = await askShellValue(shell, 'file', {
    defaultValue: `${id}.md`,
    validate: (v) => (v.endsWith('.md') ? true : 'must end with .md'),
  });

  const targetFile = await writeAgentDraft({
    root: absRoot,
    draft: {
      title,
      id,
      description,
      inputs,
      outputs,
      tags,
      provider,
      model,
      runnerAgent,
      permissionMode,
      estimatedTokens,
      filename,
    },
    askOverwrite: async (relativeFile) => {
      const overwrite = await askShellValue(shell, `${relativeFile} already exists. Overwrite? [y/N]`, {
        defaultValue: 'n',
        normalize: (v) => v.toLowerCase(),
        validate: (v) => (['y', 'yes', 'n', 'no'].includes(v.toLowerCase()) ? true : 'answer y or n'),
      });
      if (!['y', 'yes'].includes(overwrite)) {
        shell.log(`{#797C81-fg}Creation cancelled.{/}`);
        return false;
      }
      return true;
    },
  });
  if (!targetFile) return null;

  shell.log('');
  shell.log(`{green-fg}✓{/} ${path.relative(absRoot, targetFile)}`);
  return targetFile;
}

function renderAgentFile({ title, id, description, inputs, outputs, tags, provider, model, runnerAgent, permissionMode, estimatedTokens }) {
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
  if (runnerAgent) lines.push(`- **runner_agent**: ${runnerAgent}`);
  if (permissionMode) lines.push(`- **permission_mode**: ${permissionMode}`);
  if (estimatedTokens) lines.push(`- **estimated_tokens**: ${estimatedTokens}`);
  lines.push('', '---', '', '## Prompt', '', '<!-- Your prompt here -->', '');
  return lines.join('\n');
}
