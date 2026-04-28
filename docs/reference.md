# Singleton Reference

This document is the detailed reference for Singleton.

Use the main [README](../README.md) for the product overview and quickstart.
Use this file when you need exact behavior, node semantics, command details, or execution rules.

## Table of contents

- [Terminology](#terminology)
- [Project workspace](#project-workspace)
- [Agent model](#agent-model)
- [Pipeline model](#pipeline-model)
- [Node types](#node-types)
- [References](#references)
- [Execution model](#execution-model)
- [Deliverables vs intermediates](#deliverables-vs-intermediates)
- [Run artifacts](#run-artifacts)
- [Multi-provider model](#multi-provider-model)
- [CLI commands](#cli-commands)
- [REPL commands](#repl-commands)
- [`/commit-last`](#commit-last)
- [Builder](#builder)
- [Full pipeline example](#full-pipeline-example)
- [Troubleshooting](#troubleshooting)

## Terminology

- **project**: the target codebase where Singleton runs
- **agent**: a Markdown file with a `## Config` section and a prompt
- **pipeline**: a directed graph of inputs and agent steps
- **run**: one execution of a pipeline
- **deliverable**: a real project file written outside `.singleton`
- **intermediate**: a report, plan, log, or temporary artifact written inside `.singleton`

## Project workspace

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

## Agent model

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

- `id` — stable identifier used in scans and step definitions
- `description` — human-readable summary shown in scan output and tooling
- `inputs` — comma-separated list of logical inputs exposed to the prompt
- `outputs` — comma-separated list of logical outputs expected from the step
- `tags` — optional categorization
- `provider` — execution backend, currently `claude` or `codex`
- `model` — provider-specific model name
- `permission_mode` — applies to Claude only, ignored for Codex runs
- `estimated_tokens` — optional metadata for planning

### Provider resolution

When running a step, Singleton resolves provider in this order:

1. `step.provider`
2. `agent.provider`
3. fallback to `claude`

Model resolution:

1. `step.model`
2. `agent.model`
3. no explicit model

Permission mode resolution (Claude only):

1. `step.permission_mode`
2. `agent.permission_mode`
3. no explicit permission mode

If `step.provider` overrides `agent.provider`, the step value wins silently — the agent's preference is treated as a default, not a constraint.

## Pipeline model

A pipeline is a directed graph serialized as JSON.

Conceptually:

- input nodes provide runtime values or file paths
- agent nodes represent executable steps
- edges connect outputs to downstream inputs

At runtime, Singleton executes steps in dependency order.
Dependencies are derived from the serialized references used in step inputs, especially `$PIPE:...`.

A complete example is in [Full pipeline example](#full-pipeline-example).

## Node types

### Input node

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

- `id` — referenced later through `$INPUT:<id>`
- `label` — user-facing prompt label
- `subtype` — `text` or `file`
- `value` — optional default value

Behavior:

- in normal runs, missing values are prompted interactively
- in dry-runs, placeholder values are injected
- for `file` inputs, the value is treated as a path and resolved through the file loader

### Agent node

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

```json
{ "request": "$INPUT:input-request" }
```

Behavior:

- resolves to a string value
- if the input node subtype is `file`, Singleton treats the resolved value as a path and reads the file(s)

### `$FILE:<path>`

Read or write a single file.

```json
{ "spec": "$FILE:docs/spec.md" }
```

Behavior:

- **input side**: file content is read and injected into the prompt as `<file path="...">...</file>`
- **output side**: after the step finishes, the value mapped to that output key is written verbatim to the target path. The agent's output is treated as a raw string — no JSON parsing, no transformation.
- writes happen between the step that produced the value and the next step that depends on it
- target paths are validated against the project root before writing

### `$PIPE:<agent>.<output>`

Pass one step output to another.

```json
{ "source_code": "$PIPE:code-generator.source_code" }
```

Behavior:

- references a previous step output kept in memory during the run
- drives dependency ordering — `$PIPE` is what makes the graph topological
- must point to an already-available upstream step output, otherwise preflight fails

### `$FILES:<dir>`

Use when a step needs to create multiple files from one output.

```json
{ "files": "$FILES:src/generated" }
```

The agent must return a JSON-parseable string with this shape:

```json
[
  { "path": "a.js", "content": "..." },
  { "path": "b.js", "content": "..." }
]
```

Behavior:

- the runner parses the agent output as JSON; if parsing fails the step is reported as failed
- each entry is written relative to the target base directory
- paths are validated against the project root before writing

## Execution model

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

## Deliverables vs intermediates

Singleton distinguishes between:

- **deliverables** — real project files outside `.singleton`
- **intermediates** — reports, notes, plans, debug artifacts, or output files inside `.singleton`

This distinction is used in:

- run manifests
- execution recap
- `/commit-last`

## Run artifacts

Each real run creates a versioned directory:

```txt
.singleton/runs/<run-id>/
```

Singleton also updates `.singleton/runs/latest` to point at the most recent run.

A run manifest looks like this:

```json
{
  "pipeline": "contact-view-polish-mixed",
  "project_root": "/abs/path/to/project",
  "created_at": "2026-04-28T14:32:11.000Z",
  "deliverables": [
    { "path": "src/contact-view.js", "size": 2048 }
  ],
  "intermediates": [
    { "path": ".singleton/runs/2026-04-28T14-32-11/scout.md", "size": 512 }
  ],
  "steps": [
    {
      "agent": "scout",
      "provider": "claude",
      "model": "claude-sonnet-4-6",
      "status": "ok",
      "duration_ms": 8420,
      "turns": 3,
      "cost_usd": 0.012
    }
  ]
}
```

## Multi-provider model

Singleton's core model is provider-neutral:

- agents are Markdown documents
- steps are pipeline orchestration units
- runners adapt those steps to specific CLIs

### Claude

- executes through the local `claude` CLI
- supports optional `permission_mode`
- supports explicit `model`

If `permission_mode` is not set, Singleton does not inject one explicitly.

### Codex

- executes through the local `codex` CLI
- supports explicit `model`
- automatically receives project instructions from discovered `AGENTS.md` / `AGENTS.override.md`
- ignores `permission_mode`

`AGENTS.md` is not scanned as a Singleton agent — it is forwarded only as Codex project context.

## CLI commands

Global flags: every command supports `--help`.

Exit codes: `0` on success, non-zero on any failure (preflight, step error, invalid arguments). There is no finer-grained code grid.

### `scan`

Scan a project for agents and write the agent cache.

```bash
singleton scan /path/to/project
```

What it does:

- scans `.singleton/agents`
- scans `.claude/agents`
- prints id, description, source, provider, permission mode, inputs, outputs
- writes `.singleton/agents.json`

### `run`

Run a pipeline JSON file.

```bash
singleton run --pipeline /path/to/project/.singleton/pipelines/my-pipeline.json
```

Flags:

- `--dry-run` — validate without calling any LLM CLI
- `--verbose` — surface raw provider stdout/stderr

### `serve`

Start the builder API server.

```bash
singleton serve --root /path/to/project
```

### `new`

Create a new agent interactively.

```bash
singleton new --root /path/to/project
```

Behavior:

- writes to `.singleton/agents`
- validates id format
- offers provider/model choices
- scaffolds `## Config`

### `repl`

Start the interactive shell.

```bash
singleton
```

## REPL commands

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

The web builder is the visual authoring interface served by `singleton serve` + `packages/web` (Vite dev server on port 5173).

It lets you:

- browse scanned agents and drop them on a canvas as agent nodes
- add input nodes (`text` or `file`) and bind them to step inputs
- draw edges from agent outputs to downstream inputs — these become `$PIPE` references
- bind step outputs to `$FILE` / `$FILES` sinks
- save the resulting graph as a pipeline JSON in `.singleton/pipelines/`

The serialization mapping:

- input nodes → `$INPUT:<id>` references
- graph edges → serialized references
- topological order → execution order

Cycles are rejected at save time.

## Full pipeline example

Illustrative only — this is not a ready-to-run project. The agents `code-generator` and `code-review` are placeholders to show how the pieces fit together. For an executable example, see `examples/mixed-claude-codex/`.

A two-step pipeline: a generator writes code from a spec, a reviewer reads that code and emits a report.

```json
{
  "name": "generate-and-review",
  "nodes": [
    {
      "id": "input-spec",
      "type": "input",
      "data": { "label": "spec", "subtype": "file", "value": "" }
    }
  ],
  "steps": [
    {
      "agent": "code-generator",
      "agent_file": ".singleton/agents/code-generator.md",
      "inputs": {
        "spec": "$INPUT:input-spec"
      },
      "outputs": {
        "source_code": "$FILE:src/generated/output.js"
      }
    },
    {
      "agent": "code-review",
      "agent_file": ".singleton/agents/code-review.md",
      "inputs": {
        "source_code": "$PIPE:code-generator.source_code"
      },
      "outputs": {
        "report": "$FILE:.singleton/runs/latest/review.md"
      }
    }
  ]
}
```

What this pipeline does at runtime:

1. prompts the user for the path to the spec file
2. runs `code-generator` with the spec content injected as `<file>...</file>`
3. writes the generator's output to `src/generated/output.js` (a deliverable)
4. runs `code-review` with the generator's output passed via `$PIPE`
5. writes the review to `.singleton/runs/latest/review.md` (an intermediate)
6. emits a manifest distinguishing the deliverable from the intermediate

See `examples/mixed-claude-codex/` for an end-to-end example using both Claude and Codex.

## Troubleshooting

**`claude: command not found` (or `codex: command not found`) during preflight**
The corresponding CLI is not in `$PATH`. Install it and ensure it runs standalone before retrying. Singleton never installs or upgrades provider CLIs.

**Provider call fails immediately with an auth error**
The CLI is installed but no active session/credentials. Run the provider's login flow once interactively, then retry.

**Preflight error: `$PIPE:foo.bar` references unknown step**
The upstream step `foo` is missing from the pipeline, or its `outputs` don't declare `bar`. Check both the step list order and the agent's `outputs:` line in `## Config`.

**Preflight error: unsafe sink path**
A `$FILE` or `$FILES` target resolves outside the project root. Singleton refuses to write there. Make the path relative to the project root.

**`permission_mode` rejected for a Claude step**
Only specific values are accepted by the Claude runner. Check the agent's `## Config` and the step override.

**Step succeeds but no file appears on disk**
The step output is kept in memory unless a sink (`$FILE` or `$FILES`) is wired in `outputs`. Without a sink, the value is only available to downstream `$PIPE` references.

**`$FILES` step fails with a parse error**
The agent's output isn't valid JSON of the expected shape. Inspect the raw output with `--verbose` and adjust the prompt to constrain the format.
