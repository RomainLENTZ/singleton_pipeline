import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseAgentFileDetailed } from '../parser.js';
import { G } from '../shell.js';
import { getRunner } from '../runners/index.js';
import { discoverCodexProjectInstructions } from '../runners/codex-instructions.js';
import {
  assertWriteAllowed,
  resolveSecurityPolicyWithConfig,
  validateSecurityPolicy,
} from '../security/policy.js';
import { buildUserMessage, escapePromptXml, parsePipeRef, resolveFileGlob } from './inputs.js';
import { isSingletonInternalPath } from './outputs.js';

const WINDOWS_ARGV_PROMPT_WARN_BYTES = 24 * 1024;
// Hard block threshold: past this, the prompt is very likely to crash the
// provider on Windows (CMD/CreateProcess ~32 KiB ceiling, Copilot documents
// ~32 KiB). We refuse to start the pipeline rather than let it fail mid-run
// with an opaque ENAMETOOLONG/EINVAL surfacing from the spawn syscall.
const WINDOWS_ARGV_PROMPT_BLOCK_BYTES = 28 * 1024;

export function resolveProvider(step, agent) {
  return step.provider || agent.provider || 'claude';
}

export function resolveModel(step, agent) {
  return step.model || agent.model || null;
}

export function resolveRunnerAgent(step, agent) {
  return step.runner_agent || step.opencode_agent || agent.runner_agent || agent.opencode_agent || null;
}

export function resolvePermissionMode(step, agent) {
  return step.permission_mode || agent.permission_mode || '';
}

function runCommand(cmd, args, { cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `${cmd} exited ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function resolveCopilotProjectRoot(cwd) {
  try {
    const { stdout } = await runCommand('git', ['rev-parse', '--show-toplevel'], { cwd });
    return stdout.trim() || cwd;
  } catch {
    return cwd;
  }
}

async function findCopilotRepoAgentProfile(cwd, runnerAgent) {
  const name = String(runnerAgent || '').trim();
  if (!name || name.includes('/') || name.includes('\\')) return null;
  const projectRoot = await resolveCopilotProjectRoot(cwd);
  const file = path.join(projectRoot, '.github', 'agents', `${name}.agent.md`);
  try {
    await fs.access(file);
    const raw = await fs.readFile(file, 'utf8');
    return { file, projectRoot, tools: parseCopilotAgentTools(raw) };
  } catch {
    const singletonRootFile = path.join(cwd, '.github', 'agents', `${name}.agent.md`);
    try {
      await fs.access(singletonRootFile);
      const raw = await fs.readFile(singletonRootFile, 'utf8');
      return {
        file: singletonRootFile,
        projectRoot,
        notVisibleFromGitRoot: projectRoot !== cwd,
        tools: parseCopilotAgentTools(raw),
      };
    } catch {
      return { file: null, projectRoot };
    }
  }
}

function parseCopilotAgentTools(raw) {
  const match = String(raw || '').match(/^---\n([\s\S]*?)\n---/);
  if (!match) return [];

  for (const line of match[1].split('\n')) {
    const m = line.match(/^\s*tools\s*:\s*\[([^\]]*)\]\s*$/);
    if (!m) continue;
    return m[1]
      .split(',')
      .map((token) => token.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  return [];
}

function validateCopilotAgentTools({ label, runnerAgent, securityPolicy, tools }) {
  const errors = [];
  const warnings = [];
  const list = Array.isArray(tools) ? tools : [];
  const writeEnabled = list.includes('write') || list.includes('edit');
  const shellEnabled = list.includes('shell') || list.includes('bash');

  if (securityPolicy.profile === 'restricted-write' || securityPolicy.profile === 'workspace-write') {
    if (list.length && !writeEnabled) {
      warnings.push(`${label} Copilot runner_agent "${runnerAgent}" declares tools without write/edit; the step may be unable to modify allowed_paths.`);
    }
    if (shellEnabled) {
      warnings.push(`${label} Copilot runner_agent "${runnerAgent}" enables shell tools; Singleton cannot sandbox external side effects from shell commands.`);
    }
  }

  if (securityPolicy.profile === 'read-only' && writeEnabled) {
    warnings.push(`${label} Copilot runner_agent "${runnerAgent}" enables write/edit tools; Singleton will override them with --deny-tool=write for security_profile "read-only".`);
  }

  return { errors, warnings };
}

async function findOpenCodeProjectAgentProfile(cwd, runnerAgent) {
  const name = String(runnerAgent || '').trim();
  if (!name || name.includes('/') || name.includes('\\')) return null;

  const file = path.join(cwd, '.opencode', 'agents', `${name}.md`);
  try {
    await fs.access(file);
    const raw = await fs.readFile(file, 'utf8');
    return { file, tools: parseOpenCodeAgentTools(raw) };
  } catch {
    return { file: null };
  }
}

function parseOpenCodeAgentTools(raw) {
  const match = String(raw || '').match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const tools = {};
  let inTools = false;
  for (const line of match[1].split('\n')) {
    if (/^\s*tools\s*:\s*$/.test(line)) {
      inTools = true;
      continue;
    }
    if (inTools && /^\S/.test(line)) break;
    const toolMatch = line.match(/^\s{2,}([A-Za-z0-9_-]+)\s*:\s*(true|false)\s*$/);
    if (inTools && toolMatch) {
      tools[toolMatch[1]] = toolMatch[2] === 'true';
    }
  }

  return tools;
}

function validateOpenCodeAgentTools({ label, runnerAgent, securityPolicy, tools }) {
  const errors = [];
  const warnings = [];
  const writeEnabled = tools.write === true || tools.edit === true;
  const bashEnabled = tools.bash === true;

  if (securityPolicy.profile === 'read-only') {
    const enabled = ['write', 'edit', 'bash'].filter((name) => tools[name] === true);
    if (enabled.length) {
      warnings.push(`${label} OpenCode runner_agent "${runnerAgent}" enables legacy ${enabled.join(', ')} tools; Singleton will override them with native OpenCode permissions for security_profile "read-only".`);
    }
  }

  if (securityPolicy.profile === 'restricted-write') {
    warnings.push(`${label} uses OpenCode with security_profile "restricted-write"; Singleton will inject native OpenCode edit permissions for allowed_paths and still validate post-run changes.`);
    if (!writeEnabled) {
      warnings.push(`${label} OpenCode runner_agent "${runnerAgent}" does not enable write/edit tools; the step may be unable to modify allowed_paths.`);
    }
    if (bashEnabled) {
      warnings.push(`${label} OpenCode runner_agent "${runnerAgent}" enables bash; Singleton cannot sandbox external side effects from shell commands.`);
    }
  }

  if (securityPolicy.profile === 'workspace-write') {
    if (!writeEnabled) {
      warnings.push(`${label} OpenCode runner_agent "${runnerAgent}" does not enable write/edit tools; the step may behave as read-only.`);
    }
    if (bashEnabled) {
      warnings.push(`${label} OpenCode runner_agent "${runnerAgent}" enables bash; keep workspace-write steps scoped and review post-run changes.`);
    }
  }

  return { errors, warnings };
}

function formatSecurityHighlight({ label, provider, permissionMode, securityPolicy }) {
  const parts = [`${label}: security_profile "${securityPolicy.profile}"`];
  if (provider === 'claude' && permissionMode) {
    parts.push(`permission_mode "${permissionMode}"`);
  }
  if (securityPolicy.profile === 'restricted-write') {
    parts.push(`allowed_paths ${securityPolicy.allowedPaths.join(', ') || '—'}`);
  }
  return parts.join(` ${G.bullet} `);
}

function shouldHighlightSecurity({ provider, permissionMode, securityPolicy }) {
  return securityPolicy.profile !== 'workspace-write' || (provider === 'claude' && Boolean(permissionMode));
}

function wrapProviderPromptEstimate(provider, { runnerAgent, systemPrompt, userMessage }) {
  if (provider === 'claude') return systemPrompt;
  if (provider === 'copilot') return runnerAgent
    ? userMessage
    : ['<system>', systemPrompt, '</system>', '', '<user>', userMessage, '</user>', ''].join('\n');
  if (provider === 'opencode') {
    return ['<system>', systemPrompt, '</system>', '', '<user>', userMessage, '</user>', ''].join('\n');
  }
  return '';
}

async function estimateResolvedInputsForArgv(step, { cwd, inputValues, inputDefs }) {
  const resolved = {};
  for (const [name, spec] of Object.entries(step.inputs || {})) {
    if (typeof spec !== 'string') {
      resolved[name] = escapePromptXml(spec);
      continue;
    }
    if (spec.startsWith('$PIPE:')) {
      resolved[name] = `(pipeline output reference: ${spec.slice('$PIPE:'.length).trim()})`;
      continue;
    }
    if (spec.startsWith('$INPUT:')) {
      const id = spec.slice('$INPUT:'.length).trim();
      const val = inputValues[id];
      const def = inputDefs.find((item) => item.id === id);
      if (def?.subtype === 'file' && val && !String(val).startsWith('(')) {
        resolved[name] = await estimateFilePromptBlock(`$FILE:${val}`, cwd);
      } else {
        resolved[name] = escapePromptXml(val || `(input not provided: ${id})`);
      }
      continue;
    }
    if (spec.startsWith('$FILE:')) {
      resolved[name] = await estimateFilePromptBlock(spec, cwd);
      continue;
    }
    resolved[name] = escapePromptXml(spec);
  }
  return resolved;
}

async function estimateFilePromptBlock(spec, cwd) {
  const files = await resolveFileGlob(spec, cwd);
  if (files.length === 0) return `(no files matched: ${spec})`;
  return files.map((file) => {
    const relPath = path.relative(cwd, file.path).split(path.sep).join('/');
    return `<file path="${relPath}" source="user" content_escaped="true">\n${escapePromptXml(file.content)}\n</file>`;
  }).join('\n\n');
}

function findBiggestInputContributor(resolvedInputs) {
  let topName = null;
  let topBytes = 0;
  for (const [name, value] of Object.entries(resolvedInputs)) {
    const bytes = Buffer.byteLength(String(value ?? ''), 'utf8');
    if (bytes > topBytes) {
      topBytes = bytes;
      topName = name;
    }
  }
  return topName ? { name: topName, bytes: topBytes } : null;
}

export async function getWindowsArgvPromptCheck({
  platform = process.platform,
  label,
  provider,
  runnerAgent,
  step,
  agent,
  cwd,
  inputValues,
  inputDefs,
  securityPolicy,
}) {
  if (platform !== 'win32') return null;
  if (!['claude', 'copilot', 'opencode'].includes(provider)) return null;

  const systemPrompt = agent.prompt || agent.description || '';
  const outputNames = Object.keys(step.outputs || {});
  const resolvedInputs = await estimateResolvedInputsForArgv(step, { cwd, inputValues, inputDefs });
  const userMessage = buildUserMessage(
    resolvedInputs,
    outputNames,
    { projectRoot: cwd, stepDirRel: `.singleton/runs/<run-id>/<step-${label}>` },
    securityPolicy
  );
  const argvPrompt = wrapProviderPromptEstimate(provider, { runnerAgent, systemPrompt, userMessage });
  const bytes = Buffer.byteLength(argvPrompt, 'utf8');
  if (bytes <= WINDOWS_ARGV_PROMPT_WARN_BYTES) return null;

  const topContributor = findBiggestInputContributor(resolvedInputs);
  const sizeLabel = `${Math.round(bytes / 1024)} KiB prompt argument`;
  const inputHint = topContributor
    ? ` Biggest contributor: input "${topContributor.name}" (~${Math.round(topContributor.bytes / 1024)} KiB).`
    : '';

  if (bytes >= WINDOWS_ARGV_PROMPT_BLOCK_BYTES) {
    return {
      level: 'error',
      message: `${label} would exceed the Windows command-line ceiling for provider "${provider}" (${sizeLabel}, hard limit ~${Math.round(WINDOWS_ARGV_PROMPT_BLOCK_BYTES / 1024)} KiB).${inputHint} Shrink the input or move the large content to a $FILE: reference.`,
    };
  }

  return {
    level: 'warning',
    message: `${label} may exceed Windows command-line length limits for provider "${provider}" (${sizeLabel}).${inputHint} Prefer smaller inputs or a provider path that uses stdin/files.`,
  };
}

// Back-compat shim: older callers expect a plain message string. Returns the
// `.message` of the structured check, regardless of level. Prefer the new
// `getWindowsArgvPromptCheck` for callers that need to distinguish warning
// from error.
export async function getWindowsArgvPromptWarning(args) {
  const check = await getWindowsArgvPromptCheck(args);
  return check ? check.message : null;
}

function commandExists(command) {
  return new Promise((resolve) => {
    const lookup = process.platform === 'win32' ? 'where' : 'which';
    const child = spawn(lookup, [command], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

export async function runPreflightChecks({ pipeline, cwd, inputDefs, inputValues, dryRun, securityConfig }) {
  const errors = [];
  const warnings = [];
  const infos = [];
  const securityHighlights = [];
  const stepAgents = new Map();
  const availablePipeOutputs = new Set();

  if (securityConfig) {
    const relConfig = path.relative(cwd, securityConfig.file);
    infos.push(`Project security config: ${relConfig} ${G.bullet} default_profile "${securityConfig.defaultProfile}".`);
  }

  for (const def of inputDefs) {
    const value = inputValues[def.id];
    if (!dryRun && !String(value || '').trim()) {
      errors.push(`Missing input "${def.id}".`);
      continue;
    }
    if (!dryRun && def.subtype === 'file' && String(value || '').trim()) {
      const files = await resolveFileGlob(`$FILE:${value}`, cwd);
      if (files.length === 0) {
        errors.push(`Input file "${def.id}" does not resolve to any file: ${value}`);
      }
    }
  }

  const parsedAgents = [];
  for (let i = 0; i < pipeline.steps.length; i += 1) {
    const step = pipeline.steps[i];
    const label = `Step ${i + 1} "${step.agent}"`;

    if (!step.agent_file) {
      errors.push(`${label} is missing agent_file.`);
      continue;
    }

    const agentFilePath = path.isAbsolute(step.agent_file)
      ? step.agent_file
      : path.resolve(cwd, step.agent_file);

    let raw;
    try {
      raw = await fs.readFile(agentFilePath, 'utf8');
    } catch {
      errors.push(`${label} agent file not found: ${step.agent_file}`);
      continue;
    }

    const { agent, error } = parseAgentFileDetailed(raw, agentFilePath);
    if (!agent) {
      errors.push(`${label} agent file is invalid: ${step.agent_file}${error ? ` (${error})` : ''}`);
      continue;
    }

    parsedAgents.push({ step, agent });
    stepAgents.set(step.agent, agent);
    const securityPolicy = resolveSecurityPolicyWithConfig(step, agent, securityConfig);
    for (const error of validateSecurityPolicy(securityPolicy)) {
      errors.push(`${label} ${error}.`);
    }

    let provider;
    try {
      provider = resolveProvider(step, agent);
      getRunner(provider);
    } catch (err) {
      errors.push(`${label} uses unknown provider "${step.provider || agent.provider || ''}".`);
      continue;
    }

    const model = resolveModel(step, agent);
    if (!model) warnings.push(`${label} has no model configured for provider "${provider}".`);
    const runnerAgent = resolveRunnerAgent(step, agent);
    if (provider === 'copilot' && !runnerAgent) {
      warnings.push(`${label} uses provider "copilot" without runner_agent; Copilot will use its default agent.`);
    }
    if (provider === 'opencode' && !runnerAgent) {
      warnings.push(`${label} uses provider "opencode" without runner_agent; OpenCode will use its default agent.`);
    }
    const permissionMode = resolvePermissionMode(step, agent);
    if (provider === 'claude' && permissionMode && permissionMode !== 'bypassPermissions') {
      errors.push(`${label} uses unsupported Claude permission_mode "${permissionMode}".`);
    }
    if (provider !== 'claude' && permissionMode) {
      warnings.push(`${label} defines permission_mode "${permissionMode}", but provider "${provider}" ignores it.`);
    }
    if (provider === 'claude' && permissionMode === 'bypassPermissions') {
      infos.push(`${label} runs Claude with permission_mode "${permissionMode}".`);
    }
    if (provider === 'claude' && !permissionMode) {
      if (securityPolicy.profile === 'read-only') {
        infos.push(`${label} runs Claude in read-only mode (Write/Edit/Bash disabled via --disallowedTools).`);
      } else if (securityPolicy.profile === 'restricted-write') {
        warnings.push(`${label} uses Claude with security_profile "restricted-write"; Claude has no per-path tool filter, so Singleton relies on its post-run snapshot diff to reject writes outside allowed_paths.`);
      } else if (securityPolicy.profile === 'dangerous') {
        warnings.push(`${label} uses Claude with security_profile "dangerous"; Singleton will pass --permission-mode bypassPermissions.`);
      }
    }
    if (provider === 'codex') {
      if (securityPolicy.profile === 'read-only') {
        infos.push(`${label} runs Codex in --sandbox read-only.`);
      } else if (securityPolicy.profile === 'restricted-write') {
        warnings.push(`${label} uses Codex with security_profile "restricted-write"; Codex has no per-path sandbox filter, so Singleton relies on its post-run snapshot diff to reject writes outside allowed_paths.`);
      } else if (securityPolicy.profile === 'workspace-write') {
        infos.push(`${label} runs Codex in --sandbox workspace-write.`);
      } else if (securityPolicy.profile === 'dangerous') {
        warnings.push(`${label} uses Codex with security_profile "dangerous"; Singleton will pass --sandbox danger-full-access.`);
      }
    }
    if (provider === 'copilot' && runnerAgent) {
      infos.push(`${label} runs Copilot with runner_agent "${runnerAgent}".`);
      const repoAgentProfile = await findCopilotRepoAgentProfile(cwd, runnerAgent);
      if (repoAgentProfile?.file && !repoAgentProfile.notVisibleFromGitRoot) {
        infos.push(`${label} Copilot repo agent profile: ${path.relative(cwd, repoAgentProfile.file)}.`);
      } else if (repoAgentProfile?.file && repoAgentProfile.notVisibleFromGitRoot) {
        warnings.push(`${label} Copilot runner_agent "${runnerAgent}" exists at ${path.relative(cwd, repoAgentProfile.file)}, but Copilot will use git root ${repoAgentProfile.projectRoot}. Move the profile to ${path.relative(cwd, path.join(repoAgentProfile.projectRoot, '.github', 'agents'))} or run inside a standalone git repo.`);
      } else {
        warnings.push(`${label} Copilot runner_agent "${runnerAgent}" was not found in .github/agents; Copilot may still resolve a user-level or organization-level agent.`);
      }
      if (repoAgentProfile?.file) {
        const toolValidation = validateCopilotAgentTools({
          label,
          runnerAgent,
          securityPolicy,
          tools: repoAgentProfile.tools || [],
        });
        errors.push(...toolValidation.errors);
        warnings.push(...toolValidation.warnings);
      }
    }
    if (provider === 'opencode') {
      const opencodeRuntime = [
        model ? `model "${model}"` : null,
        runnerAgent ? `runner_agent "${runnerAgent}"` : 'default agent',
      ].filter(Boolean).join(` ${G.bullet} `);
      infos.push(`${label} runs OpenCode${opencodeRuntime ? ` with ${opencodeRuntime}` : ''}.`);
      if (runnerAgent) {
        const projectAgentProfile = await findOpenCodeProjectAgentProfile(cwd, runnerAgent);
        if (projectAgentProfile?.file) {
          infos.push(`${label} OpenCode project agent profile: ${path.relative(cwd, projectAgentProfile.file)}.`);
          const toolValidation = validateOpenCodeAgentTools({
            label,
            runnerAgent,
            securityPolicy,
            tools: projectAgentProfile.tools || {},
          });
          errors.push(...toolValidation.errors);
          warnings.push(...toolValidation.warnings);
        } else if (projectAgentProfile === null) {
          warnings.push(`${label} OpenCode runner_agent "${runnerAgent}" cannot be validated as a local project agent name.`);
        } else {
          warnings.push(`${label} OpenCode runner_agent "${runnerAgent}" was not found in .opencode/agents; OpenCode may still resolve a user-level agent.`);
        }
      }
      if (securityPolicy.profile === 'dangerous') {
        warnings.push(`${label} uses provider "opencode" with security_profile "dangerous"; Singleton will pass --dangerously-skip-permissions.`);
      } else if (securityPolicy.profile !== 'restricted-write') {
        warnings.push(`${label} uses experimental provider "opencode"; Singleton enforces the security policy with write-time and post-run validation.`);
      }
    }
    if (shouldHighlightSecurity({ provider, permissionMode, securityPolicy })) {
      securityHighlights.push(formatSecurityHighlight({ label, provider, permissionMode, securityPolicy }));
    }
    const argvCheck = await getWindowsArgvPromptCheck({
      label,
      provider,
      runnerAgent,
      step,
      agent,
      cwd,
      inputValues,
      inputDefs,
      securityPolicy,
    });
    if (argvCheck) {
      if (argvCheck.level === 'error') errors.push(argvCheck.message);
      else warnings.push(argvCheck.message);
    }

    for (const [name, spec] of Object.entries(step.inputs || {})) {
      if (typeof spec !== 'string') continue;

      if (spec.startsWith('$INPUT:')) {
        const id = spec.slice('$INPUT:'.length).trim();
        if (!inputDefs.some((def) => def.id === id)) {
          errors.push(`${label} input "${name}" references unknown $INPUT:${id}.`);
        }
      } else if (spec.startsWith('$PIPE:')) {
        const { ref, agentId, outName } = parsePipeRef(spec);
        if (!stepAgents.has(agentId)) {
          errors.push(`${label} input "${name}" references future or unknown $PIPE:${ref}.`);
        } else if (outName && !availablePipeOutputs.has(`${agentId}.${outName}`)) {
          errors.push(`${label} input "${name}" references missing $PIPE output: ${ref}.`);
        }
      } else if (spec.startsWith('$FILE:')) {
        const files = await resolveFileGlob(spec, cwd);
        if (files.length === 0) {
          errors.push(`${label} input "${name}" matched no files for ${spec}.`);
        }
      }
    }

    for (const [outputName, rawSink] of Object.entries(step.outputs || {})) {
      availablePipeOutputs.add(`${step.agent}.${outputName}`);

      if (typeof rawSink !== 'string') continue;
      if (!rawSink.startsWith('$FILE:') && !rawSink.startsWith('$FILES:')) continue;

      let sink = rawSink;
      for (const [id, val] of Object.entries(inputValues)) {
        sink = sink.replaceAll(`$INPUT:${id}`, val);
      }
      const prefix = sink.startsWith('$FILE:') ? '$FILE:' : '$FILES:';
      const rawPath = sink.slice(prefix.length).trim();
      const absOut = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
      if (isSingletonInternalPath(absOut, cwd)) continue;
      try {
        assertWriteAllowed(absOut, {
          root: cwd,
          agentName: step.agent,
          outputName,
          policy: securityPolicy,
        });
      } catch (err) {
        errors.push(err.message);
      }
    }
  }

  const usedProviders = [...new Set(parsedAgents.map(({ step, agent }) => resolveProvider(step, agent)))];
  if (dryRun) {
    if (usedProviders.length) {
      infos.push(`Dry-run: skipped provider CLI binary checks (${usedProviders.join(', ')}).`);
    }
  } else {
    for (const provider of usedProviders) {
      try {
        const runner = getRunner(provider);
        if (runner.command) {
          const exists = await commandExists(runner.command);
          if (!exists) errors.push(`Provider "${provider}" requires missing CLI binary: ${runner.command}`);
        }
      } catch {
        // already captured above
      }
    }
  }

  if (usedProviders.includes('codex')) {
    const projectInstructions = await discoverCodexProjectInstructions(cwd, cwd);
    infos.push(
      `Codex project instructions: ${projectInstructions.files.length} file${projectInstructions.files.length !== 1 ? 's' : ''} detected.`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    infos,
    securityHighlights,
    providerCount: usedProviders.length,
  };
}
