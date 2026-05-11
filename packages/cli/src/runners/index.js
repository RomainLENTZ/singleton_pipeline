import { claudeRunner } from './claude.js';
import { codexRunner } from './codex.js';
import { copilotRunner } from './copilot.js';
import { opencodeRunner } from './opencode.js';

const RUNNERS = {
  claude: claudeRunner,
  codex: codexRunner,
  copilot: copilotRunner,
  opencode: opencodeRunner,
};

export function getRunner(provider = 'claude') {
  const key = String(provider || 'claude').trim().toLowerCase();
  const runner = RUNNERS[key];
  if (!runner) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  return runner;
}
