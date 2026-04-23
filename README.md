# Singleton Pipeline Builder

Build, visualize, and run local multi-agent pipelines from simple Markdown agent files.

Singleton scans a project for agents, lets you wire them together visually, then runs the resulting pipeline from a CLI. It is designed for local code-generation workflows where each agent has typed inputs, typed outputs, and can pass its result to the next step.

## What It Does

- Scans a repository for agent definitions written in `.md`.
- Builds pipelines visually with a Vue Flow canvas.
- Saves pipelines as JSON in `.singleton/pipelines`.
- Runs pipelines from the CLI with `$INPUT`, `$FILE`, `$PIPE`, and `$FILES` resolution.
- Executes agents through the local `claude` CLI.
- Provides an interactive REPL with autocomplete for commands, pipelines, agents, and flags.
- Prints an execution recap with per-step duration, turns, cost, totals, and generated files.

## Project Status

This is an early local-first tool. It works for real pipeline execution, but the API and pipeline format may still evolve.

## Requirements

- Node.js 20+ recommended.
- npm.
- Claude Code CLI available as `claude` in your shell path for real execution.

Dry-runs do not call Claude and can be used without API execution.

## Install

```bash
npm install
```

## Quickstart

Scan agents in a project:

```bash
node packages/cli/src/index.js scan /path/to/your/project
```

Start the API server for a project root:

```bash
node packages/cli/src/index.js serve --root /path/to/your/project
```

In another terminal, start the web builder:

```bash
cd packages/web
npm run dev
```

Open:

```txt
http://localhost:5173
```

## CLI Usage

Run a saved pipeline:

```bash
node packages/cli/src/index.js run --pipeline /path/to/your/project/.singleton/pipelines/my-pipeline.json
```

Run without calling Claude:

```bash
node packages/cli/src/index.js run --pipeline /path/to/your/project/.singleton/pipelines/my-pipeline.json --dry-run
```

Show prompts and outputs during execution:

```bash
node packages/cli/src/index.js run --pipeline /path/to/your/project/.singleton/pipelines/my-pipeline.json --verbose
```

Start the interactive shell:

```bash
node packages/cli/src/index.js
```

Inside the REPL:

```txt
/run <pipeline> [--dry] [--verbose]
/scan
/new
/edit [agent-id]
/serve
/ls
/help
/quit
```

Autocomplete is available with `Tab`:

```txt
/ru<Tab>          -> /run
/run vue<Tab>     -> completes a pipeline name
/edit vue<Tab>    -> completes an agent id
/run pipeline <Tab> -> suggests flags
```

## Web Builder Workflow

1. Start the server with `serve --root <project>`.
2. Open the web UI.
3. Drag agents from the sidebar to the canvas.
4. Add input nodes when a pipeline needs runtime values or file paths.
5. Connect agent outputs to downstream inputs.
6. Save the pipeline.
7. Run it from the CLI or export the generated command.

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

Pipeline step inputs and outputs support a few special references.

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
  "files": "$FILES:./generated-app"
}
```

## Example Pipeline Step

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

After a run, Singleton prints a summary like:

```txt
Récapitulatif

 # │ Agent          │ Statut │ Temps │ Tours │ Coût
───┼────────────────┼────────┼───────┼───────┼───────
 1 │ code-generator │ done   │ 12.4s │     2 │ $0.034
 2 │ code-review    │ done   │  7.1s │     1 │ $0.012
───┼────────────────┼────────┼───────┼───────┼───────
   │ TOTAL          │ done   │ 19.5s │     3 │ $0.046

Généré
  · .singleton/runs/latest/01-code-generator/source_code.js
  · .singleton/runs/latest/02-code-review/review_report.md
```

## Repository Structure

```txt
packages/cli      CLI, REPL, scanner, parser, executor
packages/server   Express API used by the web builder
packages/web      Vue 3 + Vue Flow pipeline builder
```

## Useful Commands

```bash
# Scan agents in a project
node packages/cli/src/index.js scan /path/to/your/project

# Start API server
node packages/cli/src/index.js serve --root /path/to/your/project

# Start web UI in dev mode
cd packages/web && npm run dev

# Run a pipeline
node packages/cli/src/index.js run --pipeline /path/to/your/project/.singleton/pipelines/my-pipeline.json

# Dry-run a pipeline
node packages/cli/src/index.js run --pipeline /path/to/your/project/.singleton/pipelines/my-pipeline.json --dry-run

# Build the web UI
cd packages/web && npm run build
```

## Notes

- Agent discovery prioritizes `.claude/agents/*.md` when present, otherwise it scans Markdown files in the project.
- `.singleton/` is used for cached agents, saved pipelines, and run artifacts.
- Intermediate artifacts are redirected to `.singleton/runs/<run-id>` when appropriate.
- Project deliverables can still be written to their natural paths through `$FILE`.
