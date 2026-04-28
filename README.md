# Singleton Pipeline Builder

Singleton is a local-first multi-agent pipeline runner for codebases. It lets you define agents as Markdown files, connect them visually, execute them with Claude or Codex, inspect runs, and commit generated deliverables safely.

Singleton is local-first:
- agents live canonically in `.singleton/agents`
- pipelines live in `.singleton/pipelines`
- run artifacts live in `.singleton/runs`

## Features

- Scan agents from `.singleton/agents` first, then `.claude/agents` for compatibility.
- Create new Singleton agents from the CLI or from the REPL with a guided `## Config` scaffold.
- Run pipelines with `$INPUT`, `$FILE`, `$PIPE`, and `$FILES` resolution.
- Support multiple runners:
  - `claude`
  - `codex`
- Show visible `preflight checks` before execution.
- Print a run recap with provider, model, status, time, turns, cost, totals, and written files.
- Keep a versioned run workspace in `.singleton/runs/<run-id>`.
- Commit the last run deliverables with `/commit-last`.
- Start the builder API from the REPL with `/serve` and stop it with `/stop`.

## Supported Providers

- `claude`
  - runs Singleton Markdown agents through the local Claude CLI
  - supports optional `permission_mode` in agent or step config
- `codex`
  - runs Singleton Markdown agents through the local Codex CLI
  - automatically injects project instructions discovered from `AGENTS.md` and `AGENTS.override.md`

Important:
- `.singleton/agents` contains Singleton agents executed by the pipeline runner
- `AGENTS.md` is not a Singleton agent
- `AGENTS.md` is Codex project context that Singleton forwards only to Codex runs

## Requirements

- Node.js 20+
- npm
- `claude` in your shell for real Claude runs
- `codex` in your shell for real Codex runs

Dry-runs do not call any LLM CLI.

## Install

```bash
npm install
```

## Project Model

Each target project owns its own Singleton workspace:

```txt
my-project/
  .singleton/
    agents/
    agents.json
    pipelines/
    runs/
```

Important:
- `.singleton/` belongs to the target project, not to this repo.
- `singleton_pipeline` is the tool.
- `.claude/agents` is still scanned for existing Claude setups.
- `AGENTS.md` and `AGENTS.override.md` are treated as Codex project instructions, not as Singleton agents.

## Pipeline Model

A pipeline is a directed graph:

- input nodes provide runtime values or files
- agent nodes execute Markdown agents
- edges map outputs to downstream inputs
- references like `$PIPE:agent.output` are the serialized form of those edges

## Quickstart

Scan a project:

```bash
node packages/cli/src/index.js scan /path/to/project
```

Start the API server for a project:

```bash
node packages/cli/src/index.js serve --root /path/to/project
```

Start the web builder:

```bash
cd packages/web
npm run dev
```

Then open `http://localhost:5173`.

## Example Project

An official mixed-provider example lives in:

```txt
examples/mixed-claude-codex
```

It includes:

- two Claude agents in `.claude/agents`
- one Codex agent in `.singleton/agents`
- two Codex instruction files: `AGENTS.md` and `src/AGENTS.md`
- a mixed pipeline at `.singleton/pipelines/contact-view-polish-mixed.json`

Try it with:

```bash
node packages/cli/src/index.js run --pipeline examples/mixed-claude-codex/.singleton/pipelines/contact-view-polish-mixed.json --dry-run
```

## CLI

Run a pipeline:

```bash
node packages/cli/src/index.js run --pipeline /path/to/project/.singleton/pipelines/my-pipeline.json
```

Dry-run a pipeline:

```bash
node packages/cli/src/index.js run --pipeline /path/to/project/.singleton/pipelines/my-pipeline.json --dry-run
```

Verbose execution:

```bash
node packages/cli/src/index.js run --pipeline /path/to/project/.singleton/pipelines/my-pipeline.json --verbose
```

Start the interactive shell:

```bash
node packages/cli/src/index.js
```

Main REPL commands:

```txt
/run <name> [--dry] [--verbose]
/scan
/new
/serve
/stop
/commit-last
/ls
/help
/quit
```

Autocomplete is available with `Tab`:

```txt
/ru<Tab>            -> /run
/run vue<Tab>       -> completes a pipeline name
/run pipeline <Tab> -> suggests flags
```

## Agent Discovery

Discovery order:

1. `.singleton/agents/*.md`
2. `.claude/agents/*.md`

If the same `id` exists in both places, `.singleton/agents` wins.

Each scanned agent keeps:
- its `provider`
- its `source`
- its absolute file path

## Agent Format

Agents are Markdown files with a `## Config` section and a prompt body.
Singleton creates them in `.singleton/agents` by default.

```markdown
# Code Generator

## Config

- **id**: code-generator
- **description**: Generates source code from a specification
- **inputs**: spec, guidelines
- **outputs**: source_code
- **tags**: code, generation
- **provider**: claude
- **model**: claude-sonnet-4-6
- **permission_mode**: bypassPermissions

---

## Prompt

You are a senior software engineer.

Use `<spec>` and `<guidelines>` to generate the requested source code.
Return only the generated code.
```

Required config fields:

- `id`
- `description`
- `inputs`
- `outputs`

Optional fields:

- `tags`
- `provider`
- `model`
- `permission_mode`
- `estimated_tokens`

Notes:
- `permission_mode` is currently useful for `claude`.
- `bypassPermissions` is opt-in. If omitted, Claude runs use the CLI default behavior.

## Pipeline Variables

Pipelines can define input nodes that act like runtime variables.

Typical uses:

- a project brief
- a file path
- a component name
- a free-form instruction

Example input node:

```json
{
  "id": "input-spec",
  "type": "input",
  "data": {
    "label": "spec",
    "subtype": "file"
  }
}
```

At execution time:

- in normal mode, Singleton prompts for missing values
- in `--dry-run`, placeholder values are used
- file inputs are read from disk and injected into the agent prompt
- text inputs are injected as plain values

Those variables are then referenced from steps through `$INPUT:<id>`.

## Pipeline References

`$INPUT:<id>` resolves a value from an input node:

```json
{
  "component_request": "$INPUT:input-request"
}
```

`$FILE:<path>` reads or writes a file:

```json
{
  "spec": "$FILE:docs/spec.md"
}
```

`$PIPE:<agent>.<output>` passes a previous step output to another step:

```json
{
  "source_code": "$PIPE:code-generator.source_code"
}
```

`$FILES:<dir>` writes multiple files from a JSON manifest returned by an agent:

```json
{
  "files": "$FILES:src/generated"
}
```

## Preflight Checks

Every run starts with a visible `preflight checks` step.

Preflight validates:

- pipeline inputs
- file input resolution
- agent file existence
- agent parsing
- provider validity
- CLI availability for each used provider
- `$INPUT` references
- `$PIPE` references
- `$FILE` input resolution
- sink paths escaping the project root

Preflight can emit:

- `info`
- `warnings`
- blocking `errors`

Examples:

- missing `model` -> warning
- unknown provider -> error
- `$FILE:` sink outside the project root -> error

## Multi-LLM Execution

Singleton normalizes runner execution behind a common interface.

Current providers:

- `claude`
- `codex`

Provider resolution is intentionally simple:

1. `step.provider`
2. `agent.provider`
3. fallback to `claude`

Model resolution:

1. `step.model`
2. `agent.model`
3. no explicit model

## Codex Project Instructions

For Codex runs, Singleton automatically discovers project instructions from:

- `AGENTS.override.md`
- otherwise `AGENTS.md`

These files are aggregated from the project tree and injected into Codex as additional project context.

This means:

- Singleton agents still live in `.singleton/agents`
- `AGENTS.md` is not scanned as an agent
- Codex runs can still respect repo-local working agreements

The preflight step also reports how many Codex instruction files were detected.

## `/serve` And `/stop`

From the REPL:

- `/serve` starts the builder API server
- `/stop` stops it

The shell footer keeps showing a centered runtime state while the server is running.

## `/commit-last`

`/commit-last` uses the latest run manifest from the current project:

- reads `.singleton/runs/latest/run-manifest.json`
- keeps real project deliverables
- ignores `.singleton` artifacts
- includes files directly edited during the run
- prompts for a commit message
- runs `git add` only on the detected deliverables

This is intended for real runs, not `--dry-run`.

## Execution Recap

After a run, Singleton prints a summary with:

- one line per step
- provider
- model
- status
- duration
- turn count
- cost when available
- total duration and total cost
- written files and detected deliverables

Run manifests are written into:

```txt
.singleton/runs/<run-id>/run-manifest.json
.singleton/runs/latest/run-manifest.json
```

## Tests

Run the current test suite:

```bash
npm test
```

Watch mode:

```bash
npm run test:watch
```

Current tests cover core parser, preflight, and builder graph logic.

## Repository Structure

```txt
packages/cli      CLI, REPL, scanner, parser, executor, runners
packages/server   Express API for the builder
packages/web      Vue 3 + Vue Flow builder
```

## Useful Commands

```bash
# Scan agents in a project
node packages/cli/src/index.js scan /path/to/project

# Start API server
node packages/cli/src/index.js serve --root /path/to/project

# Start web UI in dev mode
cd packages/web && npm run dev

# Run a pipeline
node packages/cli/src/index.js run --pipeline /path/to/project/.singleton/pipelines/my-pipeline.json

# Dry-run a pipeline
node packages/cli/src/index.js run --pipeline /path/to/project/.singleton/pipelines/my-pipeline.json --dry-run

# Run tests
npm test
```

## Notes

- `.singleton/agents.json` is a cache file.
- `.singleton/pipelines` contains project-local pipeline definitions.
- `.singleton/runs` contains run artifacts and manifests.
- Real deliverables should be written to normal project paths, not inside `.singleton`.
