# Singleton Pipeline Builder

Build, visualize, and run local multi-agent pipelines from Markdown agent files with a visual builder and interactive CLI.

Singleton is project-local by design:
- agents usually live in `.claude/agents`
- pipelines live in `.singleton/pipelines`
- run artifacts live in `.singleton/runs`

## What It Does

- Scans a project for Markdown agent definitions.
- Builds pipelines visually with Vue Flow.
- Saves pipelines inside the current project's `.singleton/pipelines`.
- Runs pipelines from the CLI with `$INPUT`, `$FILE`, `$PIPE`, and `$FILES` resolution.
- Executes agents through the local `claude` CLI.
- Provides an interactive REPL with autocomplete, scrollable logs, and pipeline status.
- Prints an execution recap with duration, turns, cost, totals, and written files.
- Lets you commit the last run deliverables with `/commit-last`.

## Status

This is an early local-first tool. Real execution works, but the pipeline format and CLI ergonomics may still evolve.

## Requirements

- Node.js 20+
- npm
- Claude Code CLI available as `claude` in your shell for real execution

Dry-runs do not call Claude.

## Install

```bash
npm install
```

## Project Model

Each target project owns its own Singleton workspace:

```txt
my-project/
  .claude/agents/
  .singleton/
    agents.json
    pipelines/
    runs/
```

Important:
- `.singleton/` is specific to the target project, not to this repo.
- `singleton_pipeline` is the tool.
- the project being scanned or executed is the source of truth for agents, pipelines, and runs.

## Quickstart

Scan agents in a project:

```bash
node packages/cli/src/index.js scan /path/to/project
```

Start the API server for a project root:

```bash
node packages/cli/src/index.js serve --root /path/to/project
```

In another terminal, start the web builder:

```bash
cd packages/web
npm run dev
```

Then open `http://localhost:5173`.

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
/edit [agent-id]
/serve
/commit-last
/ls
/help
/quit
```

Autocomplete is available with `Tab`:

```txt
/ru<Tab>              -> /run
/run vue<Tab>         -> completes a pipeline name
/edit reviewer<Tab>   -> completes an agent id
/run pipeline <Tab>   -> suggests flags
```

## `/commit-last`

`/commit-last` uses the latest run manifest from the current project:

- reads `.singleton/runs/latest/run-manifest.json`
- keeps real project deliverables
- ignores `.singleton` artifacts
- includes files directly edited during the run
- prompts for a commit message
- runs `git add` only on the detected deliverables

This is intended for real runs, not `--dry-run`.

## Web Builder Workflow

1. Start the server with `serve --root <project>`.
2. Open the web UI.
3. Drag agents from the sidebar to the canvas.
4. Add input nodes when runtime values or file paths are needed.
5. Connect outputs to downstream inputs.
6. Save the pipeline into the project's `.singleton/pipelines`.
7. Run it from the CLI.

## Agent Format

Agents are Markdown files with a `## Config` section and a prompt body.

```markdown
# Code Generator

## Config

- **id**: code-generator
- **description**: Generates source code from a specification
- **inputs**: spec, guidelines
- **outputs**: source_code
- **tags**: code, generation
- **model**: claude-sonnet-4-6

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
- `model`
- `estimated_tokens`

## Pipeline References

## Pipeline Variables

Pipelines can define input nodes that act like runtime variables.

Typical uses:

- a project brief
- a file path
- a component name
- a free-form instruction

In practice, these variables are stored as input nodes in the pipeline JSON and are resolved at run time.

Example:

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

Example:

```json
{
  "request": "$INPUT:input-request",
  "spec": "$INPUT:input-spec"
}
```

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

## Example Step

```json
{
  "agent": "code-review",
  "agent_file": ".claude/agents/code-review.md",
  "inputs": {
    "source_code": "$PIPE:code-generator.source_code",
    "guidelines": "$FILE:docs/guidelines.md"
  },
  "outputs": {
    "review_report": "$FILE:.singleton/output/review_report.md"
  }
}
```

## Execution Recap

After a run, Singleton prints a summary with:

- one line per step
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

## Repository Structure

```txt
packages/cli      CLI, REPL, scanner, parser, executor
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

# Build the web UI
cd packages/web && npm run build
```

## Notes

- Agent discovery prioritizes `.claude/agents/*.md` when present.
- `.singleton/agents.json` is a cache file.
- `.singleton/pipelines` contains project-local pipeline definitions.
- `.singleton/runs` contains run artifacts and manifests.
- Real deliverables should be written to normal project paths, not inside `.singleton`.
