const CONFIG_HEADER = /^##\s+Config\s*$/m;
const PROMPT_HEADER = /^##\s+(Prompt|System|Instructions)\s*$/m;
const HR = /^---\s*$/m;
const KV_LINE = /^\s*-\s+\*\*([^*]+)\*\*\s*:\s*(.+?)\s*$/;
const REQUIRED = ['id', 'description', 'inputs', 'outputs'];
const LIST_KEYS = new Set(['inputs', 'outputs', 'tags', 'allowed_paths', 'blocked_paths']);

export function parseAgentFileDetailed(content, file) {
  // Strip YAML frontmatter if present
  const stripped = content.startsWith('---')
    ? content.replace(/^---[\s\S]*?---\n?/, '')
    : content;
  const configMatch = stripped.match(CONFIG_HEADER);
  if (!configMatch) {
    return { agent: null, error: 'missing "## Config" section' };
  }

  const afterConfig = stripped.slice(configMatch.index + configMatch[0].length);

  // Find end of config block: next ## header, ---, or EOF
  const nextHeader = afterConfig.match(/^##\s+/m);
  const hr = afterConfig.match(HR);
  const ends = [nextHeader?.index, hr?.index].filter((i) => typeof i === 'number');
  const endIdx = ends.length ? Math.min(...ends) : afterConfig.length;

  const configBlock = afterConfig.slice(0, endIdx);
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
    if (config[k] === undefined || (LIST_KEYS.has(k) && config[k].length === 0 && k !== 'tags')) {
      return { agent: null, error: `missing required field: ${k}` };
    }
  }

  // Extract prompt body
  const promptMatch = stripped.match(PROMPT_HEADER);
  let prompt = '';
  if (promptMatch) {
    prompt = stripped.slice(promptMatch.index + promptMatch[0].length).trim();
  } else {
    const hrAll = stripped.match(HR);
    if (hrAll) prompt = stripped.slice(hrAll.index + hrAll[0].length).trim();
  }

  const agent = {
    id: config.id,
    description: config.description || '',
    inputs: config.inputs || [],
    outputs: config.outputs || [],
    tags: config.tags || [],
    provider: config.provider,
    model: config.model,
    runner_agent: config.runner_agent || config.opencode_agent,
    opencode_agent: config.opencode_agent,
    permission_mode: config.permission_mode,
    security_profile: config.security_profile,
    allowed_paths: config.allowed_paths || [],
    blocked_paths: config.blocked_paths || [],
    estimated_tokens: config.estimated_tokens ? Number(config.estimated_tokens) : undefined,
    file,
    prompt
  };

  return { agent, error: null };
}

export function parseAgentFile(content, file) {
  return parseAgentFileDetailed(content, file).agent;
}
