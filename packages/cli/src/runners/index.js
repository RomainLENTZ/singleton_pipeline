import { claudeRunner } from './claude.js';
import { codexRunner } from './codex.js';

const RUNNERS = {
  claude: claudeRunner,
  codex: codexRunner,
};

export function getRunner(provider = 'claude') {
  const key = String(provider || 'claude').trim().toLowerCase();
  const runner = RUNNERS[key];
  if (!runner) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  return runner;
}
