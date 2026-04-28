# Singleton Reference

This document is the detailed reference for Singleton.

Use the main [README](../README.md) for the product overview and quickstart.
Use this file when you need exact behavior, node semantics, command details, or execution rules.

## Terminology

- **project**: the target codebase where Singleton runs
- **agent**: a Markdown file with a `## Config` section and a prompt
- **pipeline**: a directed graph of inputs and agent steps
- **run**: one execution of a pipeline
- **deliverable**: a real project file written outside `.singleton`
- **intermediate**: a report, plan, log, or temporary artifact written inside `.singleton`

## Project Workspace

Singleton is project-local. A typical target project looks like this:

```txt
my-project/
  .singleton/
    agents/
    agents.json
    pipelines/
    runs/
```

Meaning:

- `.singleton/agents/` contains Singleton-native agents
- `.singleton/agents.json` is the scan cache
- `.singleton/pipelines/` contains saved pipeline definitions
- `.singleton/runs/` contains versioned run artifacts and manifests

Compatibility sources:

- `.claude/agents/` is scanned as a legacy or external source
- `AGENTS.md` and `AGENTS.override.md` are not agents; they are Codex project instructions

## Agent Model

Agents are Markdown files.

Minimal structure:

```markdown
# Agent Title

## Config

- **id**: my-agent
- **description**: What the agent does
- **inputs**: input_a, input_b
- **outputs**: output_a

---

## Prompt

Your prompt here.
```

### Required fields

- `id`
- `description`
- `inputs`
- `outputs`

### Optional fields

- `tags`
- `provider`
- `model`
- `permission_mode`
- `estimated_tokens`

### Field semantics

- `id`
  - stable identifier used in scans and step definitions
- `description`
  - human-readable summary shown in scan output and tooling
- `inputs`
  - comma-separated list of logical inputs exposed to the prompt
- `outputs`
  - comma-separated list of logical outputs expected from the step
- `tags`
  - optional categorization
- `provider`
  - execution backend, currently `claude` or `codex`
- `model`
  - provider-specific model name
- `permission_mode`
  - currently relevant for Claude integrations
- `estimated_tokens`
  - optional metadata for planning

### Provider resolution

When running a step, Singleton resolves provider in this order:

1. `step.provider`
2. `agent.provider`
3. fallback to `claude`

Model resolution:

1. `step.model`
2. `agent.model`
3. no explicit model

Permission mode resolution:

1. `step.permission_mode`
2. `agent.permission_mode`
3. no explicit permission mode

## Pipeline Model

A pipeline is a directed graph serialized as JSON.

Conceptually:

- input nodes provide runtime values or file paths
- agent nodes represent executable steps
- edges connect outputs to downstream inputs

At runtime, Singleton executes steps in dependency order.
Dependencies are derived from the serialized references used in step inputs, especially `$PIPE:...`.

## Node Types

### Input Node

Purpose:

- capture a runtime text value
- capture a runtime file path

Typical shape:

```json
{
  "id": "input-spec",
  "type": "input",
  "data": {
    "label": "spec",
    "subtype": "file",
    "value": ""
  }
}
```

Relevant fields:

- `id`
  - referenced later through `$INPUT:<id>`
- `label`
  - user-facing prompt label
- `subtype`
  - `text` or `file`
- `value`
  - optional default value

Behavior:

- in normal runs, missing values are prompted interactively
- in dry-runs, placeholder values are injected
- for `file` inputs, the value is treated as a path and resolved through the file loader

### Agent Node

Purpose:

- represent one executable step bound to an agent file

In saved pipelines, agent nodes are converted into `steps[]`.

Typical step shape:

```json
{
  "agent": "code-generator",
  "agent_file": ".singleton/agents/code-generator.md",
  "inputs": {
    "spec": "$INPUT:input-spec"
  },
  "outputs": {
    "source_code": "$FILE:src/generated/output.js"
  }
}
```

## References

Singleton uses four reference types.

### `$INPUT:<id>`

Use when a step needs a runtime value from an input node.

Example:

```json
{
  "request": "$INPUT:input-request"
}
```

Behavior:

- resolves to a string value
- if the input node subtype is `file`, Singleton treats the resolved value as a file path and reads the file(s)

### `$FILE:<path>`

Use for reading or writing a single file.

Read example:

```json
{
  "spec": "$FILE:docs/spec.md"
}
```

Write example:

```json
{
  "result": "$FILE:src/generated/result.md"
}
```

Behavior:

- input side:
  - resolves file content and injects it into the prompt as `<file path="...">...</file>`
- output side:
  - writes the output content to the target path

### `$PIPE:<agent>.<output>`

Use to pass one step output to another.

Example:

```json
{
  "source_code": "$PIPE:code-generator.source_code"
}
```

Behavior:

- references a previous step output kept in memory during the run
- drives dependency ordering
- must point to an already-available upstream step output

### `$FILES:<dir>`

Use when a step needs to create multiple files from one output.

Example:

```json
{
  "files": "$FILES:src/generated"
}
```

Expected output format:

```json
[
  { "path": "a.js", "content": "..." },
  { "path": "b.js", "content": "..." }
]
```

Behavior:

- each entry is written relative to the target base directory
- paths are validated against the project root before writing

## Execution Model

Each run goes through these phases:

1. load pipeline JSON
2. resolve project root
3. collect runtime inputs
4. run preflight checks
5. execute each step in order
6. write deliverables and intermediates
7. detect modified project files
8. write a run manifest
9. print a run summary

### Preflight

Preflight is always the first visible system step.

It validates:

- input presence
- input file resolution
- agent file existence
- agent parsing
- provider validity
- provider CLI availability
- `$INPUT` references
- `$PIPE` references
- `$FILE` input resolution
- unsafe sink paths

Possible outcomes:

- **info**
- **warning**
- **error**

Errors stop the run before any provider CLI is called.

### Dry-run

Dry-run:

- skips actual provider CLI calls
- still runs pipeline loading and preflight
- still resolves the execution plan
- still renders the recap

Use it to validate a pipeline structure safely.

## Deliverables vs Intermediates

Singleton distinguishes between:

- **deliverables**
  - real project files outside `.singleton`
- **intermediates**
  - reports, notes, plans, debug artifacts, or output files inside `.singleton`

This distinction is used in:

- run manifests
- execution recap
- `/commit-last`

## Run Artifacts

Each real run creates a versioned directory:

```txt
.singleton/runs/<run-id>/
```

Singleton also updates:

```txt
.singleton/runs/latest
```

The run manifest contains:

- pipeline name
- project root
- creation timestamp
- deliverables
- intermediates
- per-step stats

## Multi-Provider Model

Singleton’s core model is provider-neutral:

- agents are Markdown documents
- steps are pipeline orchestration units
- runners adapt those steps to specific CLIs

### Claude

Claude runs:

- execute through the local `claude` CLI
- support optional `permission_mode`
- support explicit `model`

If `permission_mode` is not set, Singleton does not inject one explicitly.

### Codex

Codex runs:

- execute through the local `codex` CLI
- support explicit `model`
- automatically receive project instructions from discovered `AGENTS.md` / `AGENTS.override.md`

Important:

- `AGENTS.md` is not scanned as a Singleton agent
- it is forwarded only as Codex project context

## CLI Commands

### `scan`

Scan a project for agents and write the agent cache.

Example:

```bash
node packages/cli/src/index.js scan /path/to/project
```

What it does:

- scans `.singleton/agents`
- scans `.claude/agents`
- prints id, description, source, provider, permission mode, inputs, outputs
- writes `.singleton/agents.json`

### `run`

Run a pipeline JSON file.

Example:

```bash
node packages/cli/src/index.js run --pipeline /path/to/project/.singleton/pipelines/my-pipeline.json
```

Flags:

- `--dry-run`
- `--verbose`

### `serve`

Start the builder API server.

Example:

```bash
node packages/cli/src/index.js serve --root /path/to/project
```

### `new`

Create a new agent interactively.

Example:

```bash
node packages/cli/src/index.js new --root /path/to/project
```

Behavior:

- writes to `.singleton/agents`
- validates id format
- offers provider/model choices
- scaffolds `## Config`

### `repl`

Start the interactive shell.

Example:

```bash
node packages/cli/src/index.js
```

## REPL Commands

Main commands:

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

Shell features:

- autocomplete with `Tab`
- persistent command history
- scrollable logs
- pipeline execution mode
- footer with project status information

## `/commit-last`

`/commit-last` reads the latest run manifest and:

- keeps real project deliverables
- excludes `.singleton` artifacts
- includes files modified directly during the run
- prompts for a commit message
- runs `git add` on deliverables only
- creates a Git commit

## Builder

The web builder is the visual authoring interface.

Its job is to:

- display available agents
- let you place agent and input nodes
- connect outputs to downstream inputs
- serialize the graph into a pipeline JSON

Conceptually:

- input nodes become `$INPUT`
- graph edges become serialized references
- graph order becomes execution order

## Example Project

The reference mixed-provider example lives here:

```txt
examples/mixed-claude-codex
```

It includes:

- Claude agents in `.claude/agents`
- a Codex agent in `.singleton/agents`
- Codex project instructions
- a mixed pipeline

## Tests

Run the suite:

```bash
npm test
```

Watch mode:

```bash
npm run test:watch
```

Current coverage focuses on:

- parser behavior
- preflight behavior
- builder graph ordering and cycle detection

## Repository Layout

```txt
packages/cli      CLI, REPL, scanner, parser, executor, runners
packages/server   API
packages/web      builder UI
docs/             detailed documentation
examples/         official example projects
```
