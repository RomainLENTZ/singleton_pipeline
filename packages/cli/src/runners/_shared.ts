// Shared helpers used by multiple runners (opencode, codex, ...).
// Each runner emits JSONL events with slightly different shapes; these helpers
// normalize the common patterns: parsing lines, walking nested events to find
// usage/cost, and extracting assistant text from messages with varying schemas.

type JsonRecord = Record<string, unknown>;

export type TokenUsage = {
  input: unknown;
  output: unknown;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object';
}

function getRecord(value: unknown, key: string): JsonRecord | null {
  if (!isRecord(value)) return null;
  const nested = value[key];
  return isRecord(nested) ? nested : null;
}

export function safeJsonParse(line: string): any | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return '';

  if (typeof value.text === 'string') return value.text;
  if (typeof value.content === 'string') return value.content;
  if (typeof value.delta === 'string') return value.delta;
  if (typeof value.message === 'string') return value.message;

  if (Array.isArray(value.content)) {
    return value.content
      .map((item) => extractText(item))
      .filter(Boolean)
      .join('\n');
  }

  if (Array.isArray(value.parts)) {
    return value.parts
      .map((item) => extractText(item))
      .filter(Boolean)
      .join('\n');
  }

  return extractText(getRecord(value, 'message'))
    || extractText(getRecord(value, 'part'))
    || extractText(getRecord(value, 'data'))
    || extractText(getRecord(value, 'result'));
}

export function findUsage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null;

  const tokens = getRecord(value, 'tokens');
  const usage = getRecord(value, 'usage');
  const input = value.input_tokens
    ?? value.inputTokens
    ?? tokens?.input
    ?? usage?.input_tokens
    ?? usage?.inputTokens
    ?? (Object.prototype.hasOwnProperty.call(value, 'input') ? value.input : undefined);
  const output = value.output_tokens
    ?? value.outputTokens
    ?? tokens?.output
    ?? usage?.output_tokens
    ?? usage?.outputTokens
    ?? (Object.prototype.hasOwnProperty.call(value, 'output') ? value.output : undefined);
  if (input !== undefined || output !== undefined) {
    return { input: input ?? null, output: output ?? null };
  }

  for (const nested of Object.values(value)) {
    const nestedUsage = findUsage(nested);
    if (nestedUsage) return nestedUsage;
  }

  return null;
}

export function findCostUsd(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const usage = getRecord(value, 'usage');
  const direct = value.costUsd
    ?? value.cost_usd
    ?? value.total_cost_usd
    ?? usage?.costUsd
    ?? usage?.cost_usd;
  if (direct !== undefined && direct !== null && !Number.isNaN(Number(direct))) return Number(direct);

  for (const nested of Object.values(value)) {
    const cost = findCostUsd(nested);
    if (cost !== null) return cost;
  }

  return null;
}
