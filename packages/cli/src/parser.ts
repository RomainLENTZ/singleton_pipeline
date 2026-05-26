import type { AgentConfig, ProviderId, SecurityProfile } from './types.js';

const CONFIG_HEADER = /^##\s+Config\s*$/m;
const PROMPT_HEADER = /^##\s+(Prompt|System|Instructions)\s*$/m;
const HR = /^---\s*$/m;
const KV_LINE = /^\s*-\s+\*\*([^*]+)\*\*\s*:\s*(.+?)\s*$/;
const REQUIRED = ['id', 'description', 'inputs', 'outputs'] as const;
const LIST_KEYS = new Set(['inputs', 'outputs', 'tags', 'allowed_paths', 'blocked_paths']);

type ConfigValue = string | string[];
type RawConfig = Partial<Record<string, ConfigValue>>;

function asProvider(value: ConfigValue | undefined): ProviderId | undefined {
  return typeof value === 'string' ? value as ProviderId : undefined;
}

function asSecurityProfile(value: ConfigValue | undefined): SecurityProfile | undefined {
  return typeof value === 'string' ? value as SecurityProfile : undefined;
}

function asList(value: ConfigValue | undefined): string[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: ConfigValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function parseAgentFileDetailed(content: string, file: string): { agent: AgentConfig | null, error: string | null } {
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
  const ends = [nextHeader?.index, hr?.index].filter((index): index is number => typeof index === 'number');
  const endIdx = ends.length ? Math.min(...ends) : afterConfig.length;

  const configBlock = afterConfig.slice(0, endIdx);
  const config: RawConfig = {};
  for (const line of configBlock.split('\n')) {
    const match = line.match(KV_LINE);
    if (!match) continue;
    const key = (match[1] ?? '').trim();
    const raw = (match[2] ?? '').trim();
    config[key] = LIST_KEYS.has(key)
      ? raw.split(',').map((item) => item.trim()).filter(Boolean)
      : raw;
  }

  for (const key of REQUIRED) {
    const value = config[key];
    if (value === undefined || (LIST_KEYS.has(key) && Array.isArray(value) && value.length === 0)) {
      return { agent: null, error: `missing required field: ${key}` };
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

  const agent: AgentConfig = {
    id: String(config.id),
    description: String(config.description || ''),
    inputs: asList(config.inputs),
    outputs: asList(config.outputs),
    tags: asList(config.tags),
    provider: asProvider(config.provider),
    model: asString(config.model),
    runner_agent: asString(config.runner_agent) ?? asString(config.opencode_agent),
    opencode_agent: asString(config.opencode_agent),
    permission_mode: asString(config.permission_mode),
    security_profile: asSecurityProfile(config.security_profile),
    allowed_paths: asList(config.allowed_paths),
    blocked_paths: asList(config.blocked_paths),
    estimated_tokens: config.estimated_tokens ? Number(config.estimated_tokens) : undefined,
    file,
    prompt
  };

  return { agent, error: null };
}

export function parseAgentFile(content: string, file: string): AgentConfig | null {
  return parseAgentFileDetailed(content, file).agent;
}
