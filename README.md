# Singleton Pipeline Builder

[![npm version](https://img.shields.io/npm/v/singleton-pipeline/beta.svg)](https://www.npmjs.com/package/singleton-pipeline)
[![npm downloads](https://img.shields.io/npm/dm/singleton-pipeline.svg)](https://www.npmjs.com/package/singleton-pipeline)
[![license](https://img.shields.io/npm/l/singleton-pipeline.svg)](LICENSE)

Build and run multi-agent pipelines for your codebase.

Singleton turns the workflow you already do by hand with Claude, Codex, Copilot, or OpenCode into a reusable project-local pipeline: one agent scouts, another writes, another reviews, and the run leaves behind a manifest of what changed.

- agents are plain Markdown files
- pipelines are JSON files under `.singleton/pipelines`
- runs are stored under `.singleton/runs`
- execution is local orchestration over provider CLIs in your `$PATH`
- write policy is enforced by Singleton before and after each step

> Status: beta. Singleton is usable locally, but the pipeline format, provider adapters, and builder UX may still evolve.

## Install

Requirements: Node 20+ and at least one authenticated provider CLI in your `$PATH`: `claude`, `codex`, `copilot`, or `opencode`.

```bash
npm install -g singleton-pipeline@beta
singleton --version
```

Or run without a global install:

```bash
npx singleton-pipeline@beta --help
```

For development from source:

```bash
git clone https://github.com/RomainLENTZ/singleton_pipeline.git
cd singleton_pipeline
npm install
npm link
```

## Quickstart

Validate the bundled mixed-provider example without calling an LLM:

```bash
singleton run --pipeline examples/mixed-code-review/.singleton/pipelines/text-spec-to-code-review-mixed.json --dry-run
```

To run the same template for real, copy or adapt `examples/mixed-code-review/.singleton` into the target project, then run the pipeline from that project. Writer steps are restricted to `src/` by default.

```bash
singleton run --pipeline .singleton/pipelines/text-spec-to-code-review-mixed.json
```

The pipeline prompts for:

- a text spec
- a target file path
- the same target file as readable context

Use debug mode to inspect the prompt, edit runtime inputs, review outputs, or replay one step:

```bash
singleton run --pipeline .singleton/pipelines/text-spec-to-code-review-mixed.json --debug
```

## Current Beta Tips

For now, the most reliable way to author pipelines is to edit the `.singleton` files directly with a local coding agent or LLM running in your terminal. Ask it to create or update:

- `.singleton/agents/*.md`
- `.singleton/pipelines/*.json`
- `.singleton/security.json`

The web builder is available and useful for visualizing the model, but it is still early and planned for redesign. For production-ish workflows, prefer terminal-authored Markdown agents and JSON pipelines, then validate with `--dry-run`.

Singleton currently works best in a Unix-like terminal environment. The project is primarily developed and tested from macOS Terminal/iTerm-style shells; Linux should be the closest runtime profile. Native Windows terminal support is not the main target today, so use WSL if you need to run Singleton on Windows.

## Everyday CLI

Start the Singleton shell:

```bash
singleton
```

Common REPL commands:

```txt
/scan
/new
/run <pipeline> [--dry] [--verbose] [--debug]
/serve
/commit-last
/ls
/help
```

Create a new agent directly:

```bash
singleton new --root /path/to/project
```

Scan agents and refresh `.singleton/agents.json`:

```bash
singleton scan /path/to/project
```

## Builder

If you installed the package, `singleton serve` starts the project API and serves the built web UI:

```bash
singleton serve --root /path/to/project
# http://localhost:4317
```

When developing the web app from source, run the API and Vite separately:

```bash
singleton serve --root /path/to/project
cd packages/web
npm run dev
# http://localhost:5173
```

The Vite dev server proxies `/api` to `http://localhost:4317`.

## How It Works

A Singleton project usually contains:

```txt
my-project/
  .singleton/
    agents/      # Singleton-native Markdown agents
    pipelines/   # saved pipeline JSON files
    runs/        # run artifacts and manifests
```

An agent is a Markdown file with a `## Config` section and a prompt:

```markdown
# Code Writer

## Config

- **id**: code-writer
- **description**: Applies a bounded implementation.
- **inputs**: spec, target_path
- **outputs**: execution_report
- **provider**: codex
- **model**: gpt-5.4
- **security_profile**: restricted-write
- **allowed_paths**: src/

---

## Prompt

Apply the requested change to `<target_path>` and return a concise report.
```

A pipeline is a JSON file with ordered `steps[]`. The builder may also store `nodes[]` and graph metadata for visual editing, but runtime execution follows `steps[]` in the saved order. `$PIPE` references must point to outputs from earlier steps; preflight fails on future or missing references.

Step inputs and outputs use four reference types:

| Reference | Direction | Purpose |
| --- | --- | --- |
| `$INPUT:<id>` | input | runtime text or file input |
| `$FILE:<path>` | input/output | read or write one file |
| `$PIPE:<agent>.<out>` | input | consume an earlier step output |
| `$FILES:<dir>` | output | write multiple files from a JSON manifest |

Each real run writes `.singleton/runs/<id>/run-manifest.json`, even when the pipeline fails after starting.

## Security

Singleton resolves a `security_profile` for every step:

- `read-only`
- `restricted-write`
- `workspace-write`
- `dangerous`

Enforcement happens in three layers:

1. prompt policy injected into the step message
2. provider-native CLI permissions where available
3. deterministic post-run snapshot diff against the project filesystem

The third layer is the main guarantee. It catches direct file edits made by provider CLIs even when they did not go through a declared `$FILE` or `$FILES` output.

Recommended defaults:

- scouts, auditors, planners, reviewers: `read-only`
- code writers: `restricted-write` with the smallest useful `allowed_paths`
- broad refactors: `restricted-write` with a project directory such as `src`
- avoid `dangerous` outside local experiments

## Providers

Singleton currently supports:

| Provider | CLI | Notes |
| --- | --- | --- |
| Claude | `claude` | supports `model` and Claude `permission_mode` |
| Codex | `codex` | receives `AGENTS.md` / `AGENTS.override.md` as project instructions |
| Copilot | `copilot` | supports optional `runner_agent` mapped to `--agent` |
| OpenCode | `opencode` | experimental provider with native permission config injection |

Singleton has no hosted backend. Provider CLIs still use their own networked services according to their normal behavior.

## Agent Sources

Singleton scans Markdown agents from:

- `.singleton/agents/*.md`
- `.claude/agents/*.md`
- `.github/agents/*.md`
- `.opencode/agents/*.md`

When duplicate agent ids exist, `.singleton/agents` wins over compatibility sources.

Copilot repo-level profiles are usually `.github/agents/*.agent.md` and are also used by Copilot when a Singleton agent sets `runner_agent`. If no `runner_agent` is set, Copilot uses its default agent.

`AGENTS.md` and `AGENTS.override.md` are not Singleton agents; they are forwarded to Codex as project context.

## Examples

| Example | Providers | Purpose |
| --- | --- | --- |
| `examples/claude-code-review` | Claude | Text spec -> scout -> code writer -> reviewer |
| `examples/codex-code-review` | Codex | Same workflow with Codex only |
| `examples/mixed-code-review` | Claude + Codex | Claude scouts/reviews, Codex edits code |
| `examples/frontend-audit` | Claude | Read-only frontend audit |
| `examples/opencode-review` | OpenCode | Experimental read-only review |

The code-review examples are templates. They do not ship a toy source file; use `--dry-run` as-is, then copy or adapt their `.singleton` folders into a real project before running writer steps against real files.

## Documentation

- Full behavior reference: [docs/reference.md](docs/reference.md)
- Release notes: [CHANGELOG.md](CHANGELOG.md)

## Repo Layout

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
