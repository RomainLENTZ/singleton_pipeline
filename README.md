# Singleton Pipeline Builder (v0.4.0-beta.4)

[![npm version](https://img.shields.io/npm/v/singleton-pipeline/beta.svg)](https://www.npmjs.com/package/singleton-pipeline)
[![npm downloads](https://img.shields.io/npm/dm/singleton-pipeline.svg)](https://www.npmjs.com/package/singleton-pipeline)
[![license](https://img.shields.io/npm/l/singleton-pipeline.svg)](LICENSE)

Build multi-agent pipelines for your codebase, visually.

You probably already chain Claude, Codex, Copilot, or OpenCode agents by hand: a scout reads the repo, a generator writes code, a reviewer checks it. Singleton turns that workflow into a reusable pipeline you can edit in a graph, run in one command, and commit cleanly.

- agents are plain Markdown files
- pipelines are JSON, stored in your project under `.singleton/`
- runs are versioned, with a manifest of what was actually written
- nothing leaves your machine Singleton drives local provider CLIs (`claude`, `codex`, `copilot`, `opencode`)

> Status: beta. Singleton is usable locally, but the pipeline format, provider adapters, and builder UX may still evolve.

## Version 0.4.0 Beta

This beta uniformizes the four runners around a single security model and adds the deterministic post-run validation layer.

- All four runners (Claude Code, Codex, Copilot, OpenCode) accept a `security_profile` parameter and translate it to their native CLI flags through a dedicated, unit-tested builder (`buildClaudePermissionArgs`, `buildCodexSandboxArgs`, `buildCopilotPermissionArgs`, `buildOpenCodePermissionConfig`).
- Codex now honors the four profiles via `--sandbox` modes (`read-only`, `workspace-write`, `danger-full-access`) instead of a hardcoded `workspace-write`.
- Claude now maps profiles to `--permission-mode` and `--disallowedTools` instead of relying on the legacy `permission_mode`; the legacy escape hatch is preserved.
- Layer 3 (post-run snapshot diff) is now covered by a dedicated test suite that exercises out-of-bounds writes, blocked-path patterns, `../` traversal, and read-only enforcement without any LLM in the loop.
- `assertWriteAllowed` is unit-tested as the atomic security predicate (11 cases) in `security/policy.test.js`.
- Preflight now emits explicit info/warning messages for each provider × profile combination, calling out when Singleton relies on Layer 3 because a runner has no per-path filter.
- Shared runner helpers (`safeJsonParse`, `extractText`, `findUsage`, `findCostUsd`) factored into `runners/_shared.js`; ~120 lines of duplicated parsing logic removed.
- OpenCode auth fix: Singleton no longer redirects `XDG_DATA_HOME`, which used to strip provider credentials from the spawned process. Permission isolation now relies exclusively on `OPENCODE_CONFIG_CONTENT`.
- A `Security model` section in this README describes the three layers and their per-runner coverage.
- Test count grew from 52 to 96 across the uniformization work.

## Version 0.3.0 Beta

This beta focused on multi-provider execution, Copilot support, inspection, and safer local runs.

- Claude, Codex, Copilot, and experimental OpenCode can now run from the same pipeline model.
- Copilot support uses the local `copilot` CLI with optional `runner_agent`.
- Copilot tool permissions are generated from Singleton security profiles using `--allow-tool` and `--deny-tool`.
- Repo-level Copilot profiles in `.github/agents/*.agent.md` are optional; user-level and organization-level agents can also be used.
- OpenCode support uses the local `opencode` CLI with optional `runner_agent`; Singleton maps security profiles to OpenCode native permissions through runtime config.
- `Policy` is now visible during runs and in the final recap.
- Agents can run as `read-only`, `workspace-write`, `restricted-write`, or `dangerous`.
- Pipelines can restrict writers to exact files or folders with `allowed_paths`.
- `.singleton/security.json` defines project-wide defaults, blocked paths, and commit exclusions.
- Singleton validates writes before execution, at write-time, and after each step by checking real project changes.
- Security violations pause the REPL with `continue`, `stop`, and `diff` options.
- `--debug` pauses before each step with `continue`, `inspect`, `edit`, `skip`, and `abort`.
- Debug also pauses after each step to inspect parsed outputs, written files, detected changes, and diffs before continuing.
- Debug inspect shows the full prompt that will be sent to the provider.
- Debug edit lets you override resolved step inputs for the current run only.
- Debug replay can rerun a step with adjusted inputs; project file changes from the previous attempt are restored first.
- Debug replay stores repeated step artifacts under `attempt-1`, `attempt-2`, etc.; steps without replay keep artifacts at the step root.
- Debug replay is capped per step and only restores detected project file changes, not external side effects.
- Edited inputs are marked in prompt preview with `debug-edited="true"` to make prompt priority easier to inspect.
- Debug decisions are recorded in `run-manifest.json` as lightweight `debugEvents`.
- Debug runs are stored with a `DEBUG-` prefix in `.singleton/runs/`.
- Raw provider output can be inspected during debug and is saved as `raw-output.md` when structured output parsing fails or debug detects output warnings.
- Run manifests are written even when a pipeline fails, so partial runs remain inspectable.
- `/commit-last` previews files, applies security exclusions, and asks for confirmation.

## Install

The fastest path is via npm:

```bash
npm install -g singleton-pipeline@beta
singleton --version
```

Or run it directly without installing globally:

```bash
npx singleton-pipeline@beta --help
```

Singleton drives the provider CLIs you already use; install the ones you want in your `$PATH` with a working session: `claude`, `codex`, `copilot`, `opencode`.

Requirements: Node 20+.

### From source (development)

```bash
git clone https://github.com/RomainLENTZ/singleton_pipeline.git
cd singleton_pipeline
npm install
npm link        # optional, to use `singleton` globally
```

## Quickstart

Run the bundled mixed-provider example end-to-end (uses Claude for scouting/review and Codex for implementation):

```bash
singleton run --pipeline examples/mixed-code-review/.singleton/pipelines/text-spec-to-code-review-mixed.json
```

Add `--dry-run` to validate the pipeline without calling any LLM.

Use `--debug` to pause before each step, inspect the prompt, and adjust inputs for the current run:

```bash
singleton run --pipeline examples/mixed-code-review/.singleton/pipelines/text-spec-to-code-review-mixed.json --debug
```

Open the visual builder on your own project:

```bash
singleton serve --root /path/to/your/project
cd packages/web && npm run dev
# → http://localhost:5173
```

Or just drop into the REPL:

```bash
singleton
```

## How it works

A pipeline is a graph of two node types:

- **Input** : a value or file path you provide at runtime
- **Agent** : a Markdown file (`## Config` + prompt) that gets executed

Steps wire to each other through four references:

| Reference              | Direction | Use for                                       |
| ---------------------- | --------- | --------------------------------------------- |
| `$INPUT:<id>`          | in        | a value supplied at run time                  |
| `$FILE:<path>`         | in / out  | read or write a single file                   |
| `$PIPE:<agent>.<out>`  | in        | grab the output of a previous step            |
| `$FILES:<dir>`         | out       | let an agent emit several files at once       |

Execution is sequential, ordered by `$PIPE` dependencies. A preflight pass validates inputs, files, providers, references, and security policies before any LLM is called. Each run lands in `.singleton/runs/<id>/` with a manifest, even when the run fails; `/commit-last` stages only approved project deliverables (never `.singleton` itself).

Debug mode adds interactive checkpoints before and after each agent. It is designed for inspecting what the agent will receive, testing alternate specs, reviewing outputs, or replaying one step with adjusted inputs. Any edited input is temporary and does not mutate the pipeline JSON.

Full details, agent fields, provider resolution, preflight rules, CLI flags, `$FILES` format, run manifest schema live in **[docs/reference.md](docs/reference.md)**.

## Security model

Singleton enforces a `security_profile` (`read-only`, `restricted-write`, `workspace-write`, `dangerous`) at three layers, in order of trust:

1. **Prompt-level policy** — Singleton injects a `<security_policy>` block in the user message describing `allowed_paths`/`blocked_paths`. Cooperative models honor it on their own. *Not load-bearing*: a jailbreak can bypass it.
2. **Runner-native permissions** — Singleton translates the profile into each CLI's native flags before spawning. Best-effort, varies by runner (see matrix below).
3. **Post-run snapshot diff** — Singleton snapshots the project filesystem before each step and diffs it after. Any change outside `allowed_paths` (or matching `blocked_paths`) fails the step, regardless of what the agent did. *This is the deterministic guarantee* — it does not depend on the LLM, the runner, or the prompt.

| Profile | Claude Code | Codex | Copilot | OpenCode |
| --- | --- | --- | --- | --- |
| `read-only` | native (`--disallowedTools Write,Edit,Bash,NotebookEdit`) | native (`--sandbox read-only`) | native (`--deny-tool=write --deny-tool=shell`) | native (`permission.edit=deny`) |
| `restricted-write` (per `allowed_paths`) | ⚠ no per-path filter → Layer 3 enforces | ⚠ no per-path filter → Layer 3 enforces | ✅ native (`--allow-tool=write(path)`) | ✅ native (`permission.edit` per pattern) |
| `workspace-write` | native (`--permission-mode acceptEdits`) | native (`--sandbox workspace-write`) | native (`--allow-tool=write`) | native (`permission.edit=allow`) |
| `dangerous` | bypass (`--permission-mode bypassPermissions`) | bypass (`--sandbox danger-full-access`) | bypass (`--allow-all-tools`) | bypass (`--dangerously-skip-permissions`) |

⚠ Claude and Codex do not expose per-path write filters in their CLIs. For these runners, the agent *can* write anywhere it has permission to — Singleton's post-run snapshot diff is what fails the step when the write lands outside `allowed_paths`. Layer 3 covers both runners with a deterministic check that does not depend on the agent cooperating.

Tests covering Layer 3: see [`packages/cli/src/security/policy.test.js`](packages/cli/src/security/policy.test.js) (`assertWriteAllowed` atomic predicate, including `../` traversal and blocked-path patterns) and [`packages/cli/src/executor.test.js`](packages/cli/src/executor.test.js) (`describe('Layer 3 — post-run snapshot diff …')` end-to-end without any LLM in the loop).

## Examples

The repository ships with runnable example projects:

| Example | Providers | Purpose |
| ------- | --------- | ------- |
| `examples/claude-code-review` | Claude | Text spec -> scout -> code writer -> reviewer |
| `examples/codex-code-review` | Codex | Same code workflow, using Codex only |
| `examples/mixed-code-review` | Claude + Codex | Claude scouts/reviews, Codex edits code |
| `examples/frontend-audit` | Claude | Read-only frontend audit pipeline |
| `examples/opencode-review` | OpenCode | Experimental read-only review pipeline |

The code-review examples are portable templates: they do not ship a toy source file. When you run them for real, provide a spec, a target file path, and the same file as readable context from your own project.

Validate any example without calling an LLM:

```bash
singleton run --pipeline examples/mixed-code-review/.singleton/pipelines/text-spec-to-code-review-mixed.json --dry-run
```

## Project layout

Singleton is project-local. In your target repo:

```txt
my-project/
  .singleton/
    agents/      # your Singleton agents
    pipelines/   # saved pipelines
    runs/        # versioned run artifacts
  .github/
    agents/      # optional repo-level Copilot profiles (*.agent.md)
```

`.claude/agents/` is also scanned for Singleton-compatible agents. `.github/agents/*.agent.md` is not scanned as Singleton agents; it is only used by Copilot when a Singleton agent sets `runner_agent`.

Copilot does not require `.github/agents`. If `runner_agent` is omitted, Copilot uses its default agent. If `runner_agent` is set, Copilot can resolve it from a repo-level profile, a user-level profile, or an organization-level profile. Singleton warns when a repo-level profile is not found, but does not fail preflight.

`AGENTS.md` is forwarded to Codex as project context.

## Screenshots

| Home                                                  | Pipeline run                                              |
| ----------------------------------------------------- | --------------------------------------------------------- |
| ![Home](.github/assets/singleton_img_home.png)        | ![Run](.github/assets/singleton_img_pipeline.png)         |
| **Help**                                              | **Run summary**                                           |
| ![Help](.github/assets/singleton_img_help.png)        | ![Summary](.github/assets/singleton_img_pipeline_finished.png) |

## Repo

```txt
packages/cli      CLI, REPL, executor, runners
packages/server   builder API
packages/web      builder UI
docs/             reference documentation
examples/         official example projects
```

## Tests

```bash
npm test
```
