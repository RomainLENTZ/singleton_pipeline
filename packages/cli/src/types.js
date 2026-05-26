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
 * @typedef {AgentConfig & { source: string }} DiscoveredAgent
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
 * @property {string=} opencode_agent
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
 * @property {string=} path
 * @property {string} absPath
 * @property {string} relPath
 * @property {string} kind
 * @property {number=} bytes
 */

/**
 * @typedef {object} ParsedOutputSummary
 * @property {string} name
 * @property {boolean} found
 * @property {number} chars
 * @property {number} lines
 */

/**
 * @typedef {object} RunStat
 * @property {string} agent
 * @property {ProviderId | 'system'=} provider
 * @property {string=} model
 * @property {string=} runnerAgent
 * @property {string=} securityProfile
 * @property {string=} permissionMode
 * @property {string} status
 * @property {number=} seconds
 * @property {number=} turns
 * @property {number=} cost
 * @property {number=} attempts
 * @property {string[]=} outputWarnings
 * @property {ParsedOutputSummary[]=} parsedOutputs
 * @property {string | null=} rawOutputPath
 */

/**
 * @typedef {object} RunnerOptions
 * @property {string} cwd
 * @property {string=} projectRoot
 * @property {string=} currentDir
 * @property {string} systemPrompt
 * @property {string} userPrompt
 * @property {string | null=} model
 * @property {string | null=} runnerAgent
 * @property {string=} permissionMode
 * @property {SecurityPolicy=} securityPolicy
 * @property {number=} timeoutMs
 * @property {boolean=} verbose
 */

/**
 * @typedef {object} RunnerResult
 * @property {string} text
 * @property {Record<string, unknown>} metadata
 */

/**
 * @typedef {object} ProviderRunner
 * @property {ProviderId} id
 * @property {string} command
 * @property {(options: RunnerOptions) => Promise<RunnerResult>} run
 */

/**
 * @typedef {object} CommandResult
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * @typedef {object} TimelineController
 * @property {(index: number, info?: string) => void} setRunning
 * @property {(index: number, info?: string) => void} setPaused
 * @property {(index: number, info?: string) => void} setDone
 * @property {(index: number, info?: string) => void} setError
 * @property {(text: string) => void} log
 * @property {(text: string) => void} logMuted
 * @property {(text: string) => void} logSuccess
 * @property {(line: string) => void} logDiffLine
 * @property {() => void} end
 */

/**
 * @typedef {object} SnapshotChange
 * @property {string} relPath
 * @property {string} absPath
 * @property {string} kind
 */

/**
 * @typedef {Map<string, string> & { gitStatus?: Map<string, string> | null }} SnapshotState
 */

/**
 * @typedef {object} SnapshotManagerLike
 * @property {() => Promise<SnapshotState>} captureState
 * @property {(before: SnapshotState, after: SnapshotState) => SnapshotChange[]} detectChanges
 */

/**
 * @typedef {object} StepAttemptFailure
 * @property {true} failed
 * @property {unknown} error
 * @property {number} elapsedSeconds
 * @property {number} attemptTurns
 * @property {number} attemptCost
 */

/**
 * @typedef {object} StepAttemptSuccess
 * @property {false} failed
 * @property {string | null} [attemptDir]
 * @property {string} text
 * @property {number} elapsedSeconds
 * @property {number} attemptTurns
 * @property {number} attemptCost
 * @property {number} stepWritesStart
 * @property {FileWrite[]} attemptWrites
 * @property {Record<string, string>} parsed
 * @property {string[]} outputWarnings
 * @property {ParsedOutputSummary[]} parsedOutputSummary
 * @property {string | null} rawOutputPath
 * @property {SnapshotChange[]} stepChanges
 * @property {SnapshotState | null} stepAfterSnapshot
 */

/**
 * @typedef {StepAttemptFailure | StepAttemptSuccess} StepAttemptResult
 */

/**
 * @typedef {object} DebugEvent
 * @property {string} [type]
 * @property {string} [message]
 * @property {Record<string, unknown>} [data]
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
