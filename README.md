# Singleton Pipeline Builder (Beta)

Build multi-agent pipelines for your codebase, visually.

You probably already chain Claude/Codex agents by hand: a scout reads the repo, a generator writes code, a reviewer checks it. Singleton turns that workflow into a reusable pipeline you can edit in a graph, run in one command, and commit cleanly.

- agents are plain Markdown files
- pipelines are JSON, stored in your project under `.singleton/`
- runs are versioned, with a manifest of what was actually written
- nothing leaves your machine Singleton drives the local `claude` and `codex` CLIs

> Status: early beta. The pipeline format may still evolve.

## Latest Beta Update

This beta adds a first serious security layer around local LLM execution.

- `Policy` is now visible during runs and in the final recap.
- Agents can run as `read-only`, `workspace-write`, `restricted-write`, or `dangerous`.
- Pipelines can restrict writers to exact files or folders with `allowed_paths`.
- `.singleton/security.json` defines project-wide defaults, blocked paths, and commit exclusions.
- Singleton validates writes before execution, at write-time, and after each step by checking real project changes.
- Security violations pause the REPL with `continue`, `stop`, and `diff` options.
- Run manifests are written even when a pipeline fails, so partial runs remain inspectable.
- `/commit-last` previews files, applies security exclusions, and asks for confirmation.

## Install

```bash
npm install
npm link        # optional, to use `singleton` globally
```

Requirements: Node 20+, plus `claude` and/or `codex` available in your `$PATH` with a working session.

## Quickstart

Run the bundled mixed-provider example end-to-end (uses Claude for scouting/review and Codex for implementation):

```bash
singleton run --pipeline examples/mixed-code-review/.singleton/pipelines/text-spec-to-code-review-mixed.json
```

Add `--dry-run` to validate the pipeline without calling any LLM.

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

Full details, agent fields, provider resolution, preflight rules, CLI flags, `$FILES` format, run manifest schema live in **[docs/reference.md](docs/reference.md)**.

## Examples

The repository ships with runnable example projects:

| Example | Providers | Purpose |
| ------- | --------- | ------- |
| `examples/claude-code-review` | Claude | Text spec -> scout -> code writer -> reviewer |
| `examples/codex-code-review` | Codex | Same code workflow, using Codex only |
| `examples/mixed-code-review` | Claude + Codex | Claude scouts/reviews, Codex edits code |
| `examples/frontend-audit` | Claude | Read-only frontend audit pipeline |

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
```

`.claude/agents/` is also scanned, and `AGENTS.md` is forwarded to Codex as project context.

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
