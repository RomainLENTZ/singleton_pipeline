// Shared helpers used by multiple runners (opencode, codex, …).
// Each runner emits JSONL events with slightly different shapes; these helpers
// normalize the common patterns: parsing lines, walking nested events to find
// usage/cost, and extracting assistant text from messages with varying schemas.

// On Windows, npm-installed CLI binaries are shipped as .cmd wrappers (claude.cmd,
// copilot.cmd, codex.cmd, opencode.cmd). Node's spawn does not append the extension
// automatically, so we resolve the platform-specific name here.
export function resolveBinary(command) {
  return process.platform === 'win32' ? `${command}.cmd` : command;
}

export function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function extractText(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';

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

  if (value.message && typeof value.message === 'object') return extractText(value.message);
  if (value.part && typeof value.part === 'object') return extractText(value.part);
  if (value.data && typeof value.data === 'object') return extractText(value.data);
  if (value.result && typeof value.result === 'object') return extractText(value.result);

  return '';
}

export function findUsage(value) {
  if (!value || typeof value !== 'object') return null;

  const input = value.input_tokens
    ?? value.inputTokens
    ?? value.tokens?.input
    ?? value.usage?.input_tokens
    ?? value.usage?.inputTokens
    ?? (Object.prototype.hasOwnProperty.call(value, 'input') ? value.input : undefined);
  const output = value.output_tokens
    ?? value.outputTokens
    ?? value.tokens?.output
    ?? value.usage?.output_tokens
    ?? value.usage?.outputTokens
    ?? (Object.prototype.hasOwnProperty.call(value, 'output') ? value.output : undefined);
  if (input !== undefined || output !== undefined) {
    return { input: input ?? null, output: output ?? null };
  }

  for (const nested of Object.values(value)) {
    const usage = findUsage(nested);
    if (usage) return usage;
  }

  return null;
}

export function findCostUsd(value) {
  if (!value || typeof value !== 'object') return null;
  const direct = value.costUsd ?? value.cost_usd ?? value.total_cost_usd ?? value.usage?.costUsd ?? value.usage?.cost_usd;
  if (direct !== undefined && direct !== null && !Number.isNaN(Number(direct))) return Number(direct);

  for (const nested of Object.values(value)) {
    const cost = findCostUsd(nested);
    if (cost !== null) return cost;
  }

  return null;
}
