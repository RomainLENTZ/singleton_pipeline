# Changelog

All notable beta changes for Singleton Pipeline Builder.

## 0.4.0-beta.12

This beta hardens local execution and turns the CLI executor from one large script into smaller, testable runtime modules.

- Fresh clones now include the Markdown agent fixtures used by the CLI test suite.
- `/new` now opens a sectioned in-shell agent form instead of a raw prompt chain, with field autocomplete, ghost defaults, `:back`, `:dir`, `:cancel`, review, and overwrite confirmation.
- The REPL gained prompt-scoped completers and passive `/run <pipeline>` flag suggestions, so pipeline runs and agent creation stay inside the same terminal UI.
- User-provided `$INPUT`, `$FILE`, and `$PIPE` content is XML-escaped before being embedded in prompts, so files cannot inject fake `<security_policy>`, `<workspace>`, or output tags.
- Replay rollback is now explicit: debug review shows snapshot coverage, replay restores touched project files before editing inputs, and skipped files are reported loudly.
- The executor has been split into focused modules under `packages/cli/src/executor/`: `inputs`, `outputs`, `snapshot-manager`, `preflight`, `debug-loop`, `step-runner`, `run-report`, `security-review`, `run-setup`, and `replay-loop`.
- `executor.js` now orchestrates the run instead of owning every detail inline; the file dropped from roughly 2,600+ lines to about 660 lines.
- Run reporting is cleaner: manifests and terminal summaries are generated from `run-report.js`, debug review labels include the active step, and the CLI summary keeps high-signal fields visible while the full details stay in `run-manifest.json`.
- The terminal UI now uses semantic color tokens, framed run panels, step labels, mirrored pipeline logs, compact debug choices, syntax-colored diffs, and status-focused summary tables.
- Copilot output handling is quieter and more deterministic: Singleton passes prompts through the CLI argument expected by Copilot and keeps the final assistant message instead of intermediate narration.
- Copilot, OpenCode, Claude, and Codex share the same `security_profile` model, with deterministic post-run validation as the final enforcement layer.
- Test coverage is up to 110 tests across 12 files.

## 0.3.0-beta

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
