const CONFIG_HEADER = /^##\s+Config\s*$/m;
const PROMPT_HEADER = /^##\s+(Prompt|System|Instructions)\s*$/m;
const HR = /^---\s*$/m;
const KV_LINE = /^\s*-\s+\*\*([^*]+)\*\*\s*:\s*(.+?)\s*$/;
const REQUIRED = ['id', 'description', 'inputs', 'outputs'];
const LIST_KEYS = new Set(['inputs', 'outputs', 'tags', 'allowed_paths', 'blocked_paths']);

/** @typedef {import('./types.js').AgentConfig} AgentConfig */

/**
 * @param {string} content
 * @param {string} file
 * @returns {{ agent: AgentConfig | null, error: string | null }}
 */
export function parseAgentFileDetailed(content, file) {
  // Strip YAML frontmatter if present
  const stripped = content.startsWith('---')
    ? content.replace(/^---[\s\S]*?---\n?/, '')
    : content;
  const configMatch = stripped.match(CONFIG_HEADER);
  if (!configMatch) {
    return { agent: null, error: 'missing "## Config" section' };
  }

  const configStart = configMatch.index ?? 0;
  const afterConfig = stripped.slice(configStart + configMatch[0].length);

  // Find end of config block: next ## header, ---, or EOF
  const nextHeader = afterConfig.match(/^##\s+/m);
  const hr = afterConfig.match(HR);
  const ends = [nextHeader?.index, hr?.index].filter((i) => typeof i === 'number');
  const endIdx = ends.length ? Math.min(...ends) : afterConfig.length;

  const configBlock = afterConfig.slice(0, endIdx);
  /** @type {Record<string, string | string[]>} */
  const config = {};
  for (const line of configBlock.split('\n')) {
    const m = line.match(KV_LINE);
    if (!m) continue;
    const key = m[1].trim();
    const raw = m[2].trim();
    config[key] = LIST_KEYS.has(key)
      ? raw.split(',').map((s) => s.trim()).filter(Boolean)
      : raw;
  }

  for (const k of REQUIRED) {
    const value = config[k];
    if (value === undefined || (LIST_KEYS.has(k) && Array.isArray(value) && value.length === 0 && k !== 'tags')) {
      return { agent: null, error: `missing required field: ${k}` };
    }
  }

  // Extract prompt body
  const promptMatch = stripped.match(PROMPT_HEADER);
  let prompt = '';
  if (promptMatch) {
    const promptStart = promptMatch.index ?? 0;
    prompt = stripped.slice(promptStart + promptMatch[0].length).trim();
  } else {
    const hrAll = stripped.match(HR);
    if (hrAll) {
      const hrStart = hrAll.index ?? 0;
      prompt = stripped.slice(hrStart + hrAll[0].length).trim();
    }
  }

  /** @type {AgentConfig} */
  const agent = {
    id: String(config.id),
    description: String(config.description || ''),
    inputs: Array.isArray(config.inputs) ? config.inputs : [],
    outputs: Array.isArray(config.outputs) ? config.outputs : [],
    tags: Array.isArray(config.tags) ? config.tags : [],
    provider: typeof config.provider === 'string' ? /** @type {AgentConfig['provider']} */ (config.provider) : undefined,
    model: typeof config.model === 'string' ? config.model : undefined,
    runner_agent: typeof config.runner_agent === 'string' ? config.runner_agent : typeof config.opencode_agent === 'string' ? config.opencode_agent : undefined,
    opencode_agent: typeof config.opencode_agent === 'string' ? config.opencode_agent : undefined,
    permission_mode: typeof config.permission_mode === 'string' ? config.permission_mode : undefined,
    security_profile: typeof config.security_profile === 'string' ? /** @type {AgentConfig['security_profile']} */ (config.security_profile) : undefined,
    allowed_paths: Array.isArray(config.allowed_paths) ? config.allowed_paths : [],
    blocked_paths: Array.isArray(config.blocked_paths) ? config.blocked_paths : [],
    estimated_tokens: config.estimated_tokens ? Number(config.estimated_tokens) : undefined,
    file,
    prompt
  };

  return { agent, error: null };
}

/**
 * @param {string} content
 * @param {string} file
 * @returns {AgentConfig | null}
 */
export function parseAgentFile(content, file) {
  return parseAgentFileDetailed(content, file).agent;
}
