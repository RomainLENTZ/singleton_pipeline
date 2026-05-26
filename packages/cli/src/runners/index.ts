import { claudeRunner } from './claude.js';
import { codexRunner } from './codex.js';
import { copilotRunner } from './copilot.js';
import { opencodeRunner } from './opencode.js';
import type { ProviderId, ProviderRunner } from '../types.js';

const RUNNERS: Record<ProviderId, ProviderRunner> = {
  claude: claudeRunner,
  codex: codexRunner,
  copilot: copilotRunner,
  opencode: opencodeRunner,
};

export function getRunner(provider = 'claude'): ProviderRunner {
  const key = String(provider || 'claude').trim().toLowerCase() as ProviderId;
  const runner = RUNNERS[key];
  if (!runner) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  return runner;
}
