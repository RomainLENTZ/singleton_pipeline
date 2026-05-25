/**
 * @typedef {'claude' | 'codex' | 'copilot' | 'opencode'} ProviderId
 * @typedef {'read-only' | 'workspace-write' | 'restricted-write' | 'dangerous'} SecurityProfile
 */

/**
 * @typedef {object} AgentConfig
 * @property {string} id
 * @property {string} description
 * @property {string[]} inputs
 * @property {string[]} outputs
 * @property {string[]} tags
 * @property {ProviderId=} provider
 * @property {string=} model
 * @property {string=} runner_agent
 * @property {string=} opencode_agent
 * @property {string=} permission_mode
 * @property {SecurityProfile=} security_profile
 * @property {string[]} allowed_paths
 * @property {string[]} blocked_paths
 * @property {number=} estimated_tokens
 * @property {string} file
 * @property {string} prompt
 */

/**
 * @typedef {object} SecurityPolicy
 * @property {SecurityProfile} profile
 * @property {string[]} allowedPaths
 * @property {string[]} blockedPaths
 */

/**
 * @typedef {object} PipelineStep
 * @property {string} agent
 * @property {ProviderId=} provider
 * @property {string=} model
 * @property {string=} runner_agent
 * @property {string=} permission_mode
 * @property {SecurityProfile=} security_profile
 * @property {string[]=} allowed_paths
 * @property {string[]=} blocked_paths
 * @property {Record<string, string>=} inputs
 * @property {Record<string, string>=} outputs
 */

/**
 * @typedef {object} PipelineConfig
 * @property {string} name
 * @property {PipelineStep[]} steps
 */

/**
 * @typedef {object} TimelineLike
 * @property {(text: string) => void} logMuted
 */

/**
 * @typedef {object} FileWrite
 * @property {string} path
 * @property {string} absPath
 * @property {string} relPath
 * @property {string} kind
 * @property {number=} bytes
 */

/**
 * @typedef {object} InputDef
 * @property {string} id
 * @property {string} subtype
 * @property {string} label
 * @property {string} value
 */

/**
 * @typedef {object} PromptStyle
 * @property {(text: string) => string} heading
 * @property {(text: string) => string} muted
 */

export {};
