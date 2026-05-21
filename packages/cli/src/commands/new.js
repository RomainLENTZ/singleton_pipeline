import fs from 'node:fs/promises';
import path from 'node:path';
import { input, search, select, confirm } from '@inquirer/prompts';
import { style, line } from '../theme.js';
import { scanAgents } from '../scanner.js';
import { S } from '../shell.js';

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
const OPENCODE_MODELS = [
  { name: 'ollama/qwen2.5-coder:14b', value: 'ollama/qwen2.5-coder:14b' },
  { name: 'ollama/qwen2.5-coder:7b', value: 'ollama/qwen2.5-coder:7b' },
  { name: 'anthropic/claude-sonnet-4-6', value: 'anthropic/claude-sonnet-4-6' },
  CHOICE_NONE,
];
const PROVIDERS = [
  { name: 'claude', value: 'claude' },
  { name: 'codex', value: 'codex' },
  { name: 'copilot', value: 'copilot' },
  { name: 'opencode', value: 'opencode' },
];
const CLAUDE_PERMISSION_MODES = [
  { name: '(safe default)', value: '' },
  { name: 'bypassPermissions', value: 'bypassPermissions' },
];
const DEFAULT_AGENTS_DIR = '.singleton/agents';
const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-4-6';
const CODEX_DEFAULT_MODEL = 'gpt-5.4';
const COPILOT_DEFAULT_MODEL = 'gpt-5.4-mini';
const OPENCODE_DEFAULT_MODEL = 'ollama/qwen2.5-coder:14b';

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
  if (provider === 'opencode') return OPENCODE_DEFAULT_MODEL;
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
    runnerAgent: ['copilot', 'opencode'].includes(draft.provider) ? (draft.runnerAgent || '') : '',
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

function modelChoicesForProvider(provider) {
  if (provider === 'codex') return CODEX_MODELS;
  if (provider === 'copilot') return COPILOT_MODELS;
  if (provider === 'opencode') return OPENCODE_MODELS;
  return CLAUDE_MODELS;
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
  const runnerAgent = ['copilot', 'opencode'].includes(provider)
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

// ── Shell flow (TUI) ──────────────────────────────────────────────────────
//
// Form-style multi-section view rendered in the content widget. The user
// answers fields one by one in the prompt bar; the form above always
// reflects current draft state. `:back` jumps to the previous field,
// `:cancel` aborts.

const ESC = '__SINGLETON_ESC__';

const SECTIONS = [
  {
    title: 'identity',
    hint: 'Who this agent is and what it does.',
    fields: ['id', 'title', 'description'],
  },
  {
    title: 'schema',
    hint: 'What it consumes and produces.',
    fields: ['inputs', 'outputs', 'tags'],
  },
  {
    title: 'runtime',
    hint: 'How it executes and which model it uses.',
    fields: ['provider', 'model', 'permissionMode', 'runnerAgent'],
  },
  {
    title: 'meta',
    hint: 'File location and token budget.',
    fields: ['estimatedTokens', 'file'],
  },
];

const FIELD_LABELS = {
  id: 'id',
  title: 'title',
  description: 'description',
  inputs: 'inputs',
  outputs: 'outputs',
  tags: 'tags',
  provider: 'provider',
  model: 'model',
  permissionMode: 'permission mode',
  runnerAgent: 'runner agent',
  estimatedTokens: 'estimated tokens',
  file: 'file',
};

function isFieldVisible(name, draft) {
  if (name === 'permissionMode') return draft.provider === 'claude';
  if (name === 'runnerAgent')    return ['copilot', 'opencode'].includes(draft.provider);
  return true;
}

function buildOrder(draft) {
  const order = [];
  for (const section of SECTIONS) {
    for (const name of section.fields) {
      if (!isFieldVisible(name, draft)) continue;
      order.push({ section: section.title, name });
    }
  }
  return order;
}

function formatValue(name, value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.length ? value.join(', ') : null;
  if (value === '') return null;
  return String(value);
}

function defaultFor(name, draft) {
  if (name === 'title')        return draft.id ? defaultTitleFromId(draft.id) : '';
  if (name === 'provider')     return 'claude';
  if (name === 'model')        return defaultModelForProvider(draft.provider);
  if (name === 'runnerAgent')  return draft.id || '';
  if (name === 'file')         return draft.id ? `${draft.id}.md` : '';
  if (name === 'permissionMode') return '';
  return '';
}

function suggestionsFor(name, draft, context) {
  if (name === 'inputs')   return uniqueSorted([...context.existingOutputs, ...context.existingInputs]);
  if (name === 'outputs')  return context.existingOutputs;
  if (name === 'tags')     return context.existingTags;
  if (name === 'provider') return PROVIDERS.map((p) => p.value);
  if (name === 'model')    return modelChoicesForProvider(draft.provider).map((m) => m.value).filter(Boolean);
  if (name === 'permissionMode') return ['(default)', 'bypassPermissions'];
  return [];
}

// Builds a `shell.prompt({ completer })` callback for a scalar field. Items match
// the buffer substring, case-insensitively. Returns null when no autocomplete applies.
function buildScalarCompleter(name, draft, context) {
  if (!['provider', 'model', 'permissionMode'].includes(name)) return null;
  const items = suggestionsFor(name, draft, context);
  if (!items.length) return null;
  return ({ buffer }) => {
    const t = String(buffer || '').toLowerCase();
    return items
      .filter((v) => v.toLowerCase().includes(t))
      .map((v) => ({ label: v, value: v }));
  };
}

// Completer for list fields: filters existing repo values, excludes already-picked
// items, and offers a `+ create "<term>"` row when the user types a fresh slug.
function buildListCompleter(name, draft, context, picked) {
  const all = suggestionsFor(name, draft, context);
  return ({ buffer }) => {
    const t = String(buffer || '').trim();
    const tl = t.toLowerCase();
    const avail = all.filter((v) => !picked.includes(v));
    const matching = tl
      ? avail.filter((v) => v.toLowerCase().includes(tl))
      : avail;
    const items = matching.map((v) => ({ label: v, value: v }));
    if (t && SLUG_ITEM_RE.test(t) && !all.includes(t) && !picked.includes(t)) {
      items.push({ label: `+ create "${t}"`, value: t });
    }
    return items;
  };
}

function validateFieldRaw(name, value, draft, context) {
  if (name === 'id') {
    const verdict = validateAgentId(context.existingIds, value);
    return verdict === true ? null : verdict;
  }
  if (name === 'description' && !value.trim()) return 'required';
  if (name === 'outputs' && parseCsvList(value).length === 0) return 'at least one output is required';
  if (name === 'provider' && !PROVIDERS.some((p) => p.value === value)) {
    return `choose one of: ${PROVIDERS.map((p) => p.value).join(', ')}`;
  }
  if (name === 'model') {
    const allowed = modelChoicesForProvider(draft.provider).map((m) => m.value);
    if (value && !allowed.includes(value)) return `unknown model for ${draft.provider}`;
  }
  if (name === 'permissionMode') {
    if (value && value !== '(default)' && value !== 'bypassPermissions') {
      return 'choose: (default) or bypassPermissions';
    }
  }
  if (name === 'estimatedTokens' && value !== '' && !/^\d+$/.test(value)) return 'expected an integer';
  if (name === 'file' && !value.endsWith('.md')) return 'must end with .md';
  return null;
}

function parseFieldValue(name, value) {
  if (['inputs', 'outputs', 'tags'].includes(name)) return parseCsvList(value);
  if (name === 'permissionMode' && (value === '' || value === '(default)')) return '';
  return value;
}

function renderForm(shell, { draft, activeField, currentStep, totalSteps, context, error = null }) {
  const lines = [];

  lines.push('');
  lines.push(
    `{${S.text}-fg}{bold}New agent{/}` +
    `  {${S.subtle}-fg}·{/} {${S.muted}-fg}step ${currentStep}/${totalSteps}{/}` +
    `  {${S.subtle}-fg}·{/} {${S.keyword}-fg}${FIELD_LABELS[activeField]}{/}`
  );
  lines.push(`  {${S.subtle}-fg}:back to revisit · :cancel to abort{/}`);
  lines.push('');

  for (const section of SECTIONS) {
    const visible = section.fields.filter((name) => isFieldVisible(name, draft));
    if (!visible.length) continue;

    lines.push(`  {${S.muted}-fg}{bold}${section.title}{/}  {${S.subtle}-fg}${section.hint}{/}`);

    for (const name of visible) {
      const label = FIELD_LABELS[name].padEnd(16);
      const value = formatValue(name, draft[name]);
      const isActive = name === activeField;

      if (isActive) {
        lines.push(`    {${S.accent}-fg}▸{/} {${S.text}-fg}{bold}${label}{/} {${S.muted}-fg}…{/}`);
      } else if (value !== null) {
        lines.push(`      {${S.muted}-fg}${label}{/} {${S.text}-fg}${value}{/}`);
      } else {
        lines.push(`      {${S.muted}-fg}${label}{/} {${S.subtle}-fg}—{/}`);
      }
    }
    lines.push('');
  }

  const suggestions = suggestionsFor(activeField, draft, context);
  if (suggestions.length) {
    const label = ['inputs', 'outputs', 'tags'].includes(activeField) ? 'existing' : 'options';
    lines.push(`  {${S.muted}-fg}${label}:{/} {${S.subtle}-fg}${suggestions.join(', ')}{/}`);
  }

  // The default is rendered as ghost text inside the prompt bar itself
  // (shell.prompt({ default })), so we don't duplicate it inline here.

  if (error) {
    lines.push('');
    lines.push(`  {${S.error}-fg}✕ ${error}{/}`);
  }

  shell.setContent(lines.join('\n'));
}

// Review render — same shape as renderForm but no active field marker, and a
// concise header tailored to the confirmation step. The full target path is
// shown in the prompt bar message, not duplicated here.
function renderReview(shell, { draft, error = null }) {
  const lines = [];
  lines.push('');
  lines.push(`{${S.text}-fg}{bold}New agent{/}  {${S.subtle}-fg}·{/} {${S.muted}-fg}review{/}`);
  lines.push('');

  for (const section of SECTIONS) {
    const visible = section.fields.filter((name) => isFieldVisible(name, draft));
    if (!visible.length) continue;

    lines.push(`  {${S.muted}-fg}{bold}${section.title}{/}  {${S.subtle}-fg}${section.hint}{/}`);

    for (const name of visible) {
      const label = FIELD_LABELS[name].padEnd(16);
      const value = formatValue(name, draft[name]);
      if (value !== null) {
        lines.push(`      {${S.muted}-fg}${label}{/} {${S.text}-fg}${value}{/}`);
      } else {
        lines.push(`      {${S.muted}-fg}${label}{/} {${S.subtle}-fg}—{/}`);
      }
    }
    lines.push('');
  }

  if (error) {
    lines.push(`  {${S.error}-fg}✕ ${error}{/}`);
  }

  shell.setContent(lines.join('\n'));
}

function cancelled(shell) {
  shell.setMode(null);
  shell.clear();
  shell.log(`{${S.muted}-fg}/new cancelled{/}`);
  return null;
}

// One-token-at-a-time collection sub-loop for list fields. Renders the form
// after each pick so the user sees the growing list. Returns 'done' / 'back' /
// 'cancelled'.
async function collectListInShell({ shell, draft, name, context, renderForField }) {
  const picked = Array.isArray(draft[name]) ? [...draft[name]] : [];
  const isRequired = name === 'outputs';
  let error = null;

  while (true) {
    draft[name] = picked.length ? picked : null;
    renderForField(error);
    error = null;

    const message = picked.length
      ? `${FIELD_LABELS[name]} +   ${picked.length} picked · empty Enter to finish · :pop to undo last`
      : `${FIELD_LABELS[name]}     ${isRequired ? 'pick at least one' : 'empty Enter to skip'}`;
    const completer = buildListCompleter(name, draft, context, picked);
    const answer = await shell.prompt(message, { silent: true, completer });
    if (answer === ESC) return 'cancelled';

    const t = String(answer || '').trim();
    if (t === ':cancel' || t === ':q') return 'cancelled';
    if (t === ':back') {
      draft[name] = null;
      return 'back';
    }
    if (t === ':pop') {
      if (picked.length > 0) picked.pop();
      continue;
    }
    if (t === '') {
      if (isRequired && picked.length === 0) {
        error = 'at least one output is required';
        continue;
      }
      draft[name] = picked;
      return 'done';
    }
    if (!SLUG_ITEM_RE.test(t)) {
      error = `invalid slug "${t}" (a-z, 0-9, hyphens, underscores)`;
      continue;
    }
    if (picked.includes(t)) {
      error = `"${t}" already picked`;
      continue;
    }
    picked.push(t);
  }
}

// Run the form loop starting at `startIndex`, mutating `draft` in place.
// Returns 'done' when all fields are filled, or 'cancelled' if the user aborted.
async function runForm({ shell, draft, context, startIndex = 0 }) {
  let order = buildOrder(draft);
  let i = Math.min(startIndex, order.length - 1);
  let lastError = null;

  while (i < order.length) {
    const name = order[i].name;
    const isList = ['inputs', 'outputs', 'tags'].includes(name);

    const renderForField = (errOverride = null) => renderForm(shell, {
      draft,
      activeField: name,
      currentStep: i + 1,
      totalSteps: order.length,
      context,
      error: errOverride ?? lastError,
    });

    if (isList) {
      lastError = null;
      const result = await collectListInShell({ shell, draft, name, context, renderForField });
      if (result === 'cancelled') return 'cancelled';
      if (result === 'back') {
        if (i > 0) { i -= 1; draft[order[i].name] = null; order = buildOrder(draft); }
        continue;
      }
      i += 1;
      continue;
    }

    renderForField();
    lastError = null;

    const def = defaultFor(name, draft);
    const completer = buildScalarCompleter(name, draft, context);
    const answer = await shell.prompt(FIELD_LABELS[name], {
      silent: true,
      completer,
      default: def,
    });
    if (answer === ESC) return 'cancelled';

    const trimmed = String(answer || '').trim();
    if (trimmed === ':cancel' || trimmed === ':q') return 'cancelled';

    if (trimmed === ':back') {
      if (i > 0) {
        i -= 1;
        draft[order[i].name] = null;
        order = buildOrder(draft);
      }
      continue;
    }

    // Shell already substituted the default when buffer was empty; treat the answer as-is.
    const raw = trimmed;
    const err = validateFieldRaw(name, raw, draft, context);
    if (err) { lastError = err; continue; }

    draft[name] = parseFieldValue(name, raw);

    if (name === 'provider') {
      // Provider change adds/removes conditional fields; reset model if it's
      // no longer valid for the new provider.
      const allowedModels = modelChoicesForProvider(draft.provider).map((m) => m.value);
      if (draft.model && !allowedModels.includes(draft.model)) draft.model = null;
      order = buildOrder(draft);
    }

    i += 1;
  }

  return 'done';
}

export async function newAgentShellCommand({ root, shell }) {
  const absRoot = path.resolve(root || process.cwd());
  const context = await loadAgentCreationContext(absRoot);

  const draft = {
    id: null, title: null, description: null,
    inputs: null, outputs: null, tags: null,
    provider: null, model: null,
    permissionMode: null, runnerAgent: null,
    estimatedTokens: null, file: null,
  };

  shell.setMode('running');

  const formResult = await runForm({ shell, draft, context });
  if (formResult === 'cancelled') return cancelled(shell);

  // ── Confirm + write ────────────────────────────────────────────────────
  let targetDir = DEFAULT_AGENTS_DIR;
  let confirmError = null;

  while (true) {
    renderReview(shell, { draft, error: confirmError });
    confirmError = null;

    const fullPath = path.join(targetDir, draft.file);
    // The prompt message itself carries the target path and the inline action
    // hints, so the form panel above stays clean and the user reads everything
    // in one place. Tagged content is rendered verbatim by updatePrompt.
    const promptMessage =
      `{${S.warning}-fg}{bold}write to{/} {${S.keyword}-fg}${fullPath}{/}` +
      `  {${S.subtle}-fg}· :dir · :back · :cancel{/}`;
    const answer = await shell.prompt(promptMessage, { silent: true });
    if (answer === ESC) return cancelled(shell);

    const trimmed = String(answer || '').trim();

    if (trimmed === ':cancel' || trimmed === ':q') return cancelled(shell);

    if (trimmed === ':back') {
      // Re-edit the last field — clear it and run the form from that index.
      const order = buildOrder(draft);
      const lastIdx = order.length - 1;
      draft[order[lastIdx].name] = null;
      const r = await runForm({ shell, draft, context, startIndex: lastIdx });
      if (r === 'cancelled') return cancelled(shell);
      continue;
    }

    if (trimmed === ':dir') {
      const next = await shell.prompt('directory', { silent: true, default: targetDir });
      if (next === ESC) continue;
      const cleaned = String(next || '').trim();
      // Reserved control tokens inside the dir sub-prompt: `:back` cancels just
      // the directory change, `:cancel`/`:q` aborts the whole `/new`. Without
      // this guard the user would end up creating a literal `:back/` folder.
      if (cleaned === ':back') continue;
      if (cleaned === ':cancel' || cleaned === ':q') return cancelled(shell);
      if (cleaned) targetDir = cleaned;
      continue;
    }

    if (trimmed === '' || ['y', 'yes'].includes(trimmed.toLowerCase())) {
      const targetAbsDir = path.resolve(absRoot, targetDir);
      const targetFile = path.join(targetAbsDir, draft.file);

      let exists = false;
      try { await fs.access(targetFile); exists = true; } catch {}

      if (exists) {
        const overwrite = await shell.prompt(`overwrite ${path.relative(absRoot, targetFile)}? [y/N]`, { silent: true });
        if (overwrite === ESC) { confirmError = 'overwrite cancelled'; continue; }
        const ow = String(overwrite || '').trim().toLowerCase();
        if (!['y', 'yes'].includes(ow)) { confirmError = 'overwrite cancelled'; continue; }
      }

      await fs.mkdir(targetAbsDir, { recursive: true });
      await fs.writeFile(targetFile, renderAgentFile(normalizeAgentDraft({
        ...draft,
        filename: draft.file,
        inputs: draft.inputs || [],
        outputs: draft.outputs || [],
        tags: draft.tags || [],
        permissionMode: draft.permissionMode || '',
        runnerAgent: draft.runnerAgent || '',
        estimatedTokens: draft.estimatedTokens || '',
      })));

      shell.setMode(null);
      shell.clear();
      shell.log(`{${S.success}-fg}✓{/} {${S.text}-fg}${path.relative(absRoot, targetFile)}{/}`);
      return targetFile;
    }

    confirmError = 'unknown command (Enter, :dir, :back, :cancel)';
  }
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
