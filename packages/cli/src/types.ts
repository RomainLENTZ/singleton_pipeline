export type ProviderId = 'claude' | 'codex' | 'copilot' | 'opencode';
export type SecurityProfile = 'read-only' | 'workspace-write' | 'restricted-write' | 'dangerous';

export type AgentConfig = {
  id: string;
  description: string;
  inputs: string[];
  outputs: string[];
  tags: string[];
  provider?: ProviderId;
  model?: string;
  runner_agent?: string;
  opencode_agent?: string;
  permission_mode?: string;
  security_profile?: SecurityProfile;
  allowed_paths: string[];
  blocked_paths: string[];
  estimated_tokens?: number;
  file: string;
  prompt: string;
};

export type DiscoveredAgent = AgentConfig & {
  source: string;
};

export type SecurityPolicy = {
  profile: SecurityProfile;
  allowedPaths: string[];
  blockedPaths: string[];
};

export type PipelineStep = {
  agent: string;
  provider?: ProviderId;
  model?: string;
  runner_agent?: string;
  opencode_agent?: string;
  permission_mode?: string;
  security_profile?: SecurityProfile;
  allowed_paths?: string[];
  blocked_paths?: string[];
  inputs?: Record<string, string>;
  outputs?: Record<string, string>;
};

export type PipelineConfig = {
  name: string;
  steps: PipelineStep[];
};

export type TimelineLike = {
  logMuted(text: string): void;
};

export type FileWrite = {
  path?: string;
  absPath: string;
  relPath: string;
  kind: string;
  bytes?: number;
};

export type ParsedOutputSummary = {
  name: string;
  found: boolean;
  chars: number;
  lines: number;
};

export type RunStat = {
  agent: string;
  provider?: ProviderId | 'system';
  model?: string;
  runnerAgent?: string;
  securityProfile?: string;
  permissionMode?: string;
  status: string;
  seconds?: number;
  turns?: number;
  cost?: number;
  attempts?: number;
  outputWarnings?: string[];
  parsedOutputs?: ParsedOutputSummary[];
  rawOutputPath?: string | null;
};

export type RunnerOptions = {
  cwd: string;
  projectRoot?: string;
  currentDir?: string;
  systemPrompt: string;
  userPrompt: string;
  model?: string | null;
  runnerAgent?: string | null;
  permissionMode?: string;
  securityPolicy?: SecurityPolicy;
  timeoutMs?: number;
  verbose?: boolean;
};

export type RunnerResult = {
  text: string;
  metadata: Record<string, unknown>;
};

export type ProviderRunner = {
  id: ProviderId;
  command: string | null;
  run(options: RunnerOptions): Promise<RunnerResult>;
};

export type CommandResult = {
  stdout: string;
  stderr: string;
};

export type TimelineController = {
  setRunning(index: number, info?: string): void;
  setPaused(index: number, info?: string): void;
  setDone(index: number, info?: string): void;
  setError(index: number, info?: string): void;
  log(text: string): void;
  logMuted(text: string): void;
  logSuccess(text: string): void;
  logDiffLine(line: string): void;
  end(): void;
};

export type SnapshotChange = {
  relPath: string;
  absPath: string;
  kind: string;
};

export type SnapshotState = Map<string, string> & {
  gitStatus?: Map<string, string> | null;
};

export type SnapshotManagerLike = {
  captureState(): Promise<SnapshotState>;
  detectChanges(before: SnapshotState, after: SnapshotState): SnapshotChange[];
};

export type StepAttemptFailure = {
  failed: true;
  error: unknown;
  elapsedSeconds: number;
  attemptTurns: number;
  attemptCost: number;
};

export type StepAttemptSuccess = {
  failed: false;
  attemptDir?: string | null;
  text: string;
  elapsedSeconds: number;
  attemptTurns: number;
  attemptCost: number;
  stepWritesStart: number;
  attemptWrites: FileWrite[];
  parsed: Record<string, string>;
  outputWarnings: string[];
  parsedOutputSummary: ParsedOutputSummary[];
  rawOutputPath: string | null;
  stepChanges: SnapshotChange[];
  stepAfterSnapshot: SnapshotState | null;
};

export type StepAttemptResult = StepAttemptFailure | StepAttemptSuccess;

export type DebugEvent = {
  type?: string;
  message?: string;
  data?: Record<string, unknown>;
};

export type InputDef = {
  id: string;
  subtype: string;
  label: string;
  value: string;
};

export type PromptStyle = {
  heading(text: string): string;
  muted(text: string): string;
};
