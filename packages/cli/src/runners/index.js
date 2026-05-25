import { claudeRunner } from './claude.js';
import { codexRunner } from './codex.js';
import { copilotRunner } from './copilot.js';
import { opencodeRunner } from './opencode.js';

/** @typedef {import('../types.js').ProviderId} ProviderId */
/** @typedef {import('../types.js').ProviderRunner} ProviderRunner */

/** @type {Record<ProviderId, ProviderRunner>} */
const RUNNERS = {
  claude: claudeRunner,
  codex: codexRunner,
  copilot: copilotRunner,
  opencode: opencodeRunner,
};

/**
 * @param {string} [provider]
 * @returns {ProviderRunner}
 */
export function getRunner(provider = 'claude') {
  const key = /** @type {ProviderId} */ (String(provider || 'claude').trim().toLowerCase());
  const runner = RUNNERS[key];
  if (!runner) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  return runner;
}
