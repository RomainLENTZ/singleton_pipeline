# Singleton Pipeline Builder (Beta)

Build multi-agent pipelines for your codebase, visually.

You probably already chain Claude/Codex agents by hand a scout reads the repo, a generator writes code, a reviewer checks it. Singleton turns that workflow into a reusable pipeline you can edit in a graph, run in one command, and commit cleanly.

- agents are plain Markdown files
- pipelines are JSON, stored in your project under `.singleton/`
- runs are versioned, with a manifest of what was actually written
- nothing leaves your machine Singleton drives the local `claude` and `codex` CLIs

> Status: early beta. The pipeline format may still evolve.

## Install

```bash
npm install
npm link        # optional, to use `singleton` globally
```

Requirements: Node 20+, plus `claude` and/or `codex` available in your `$PATH` with a working session.

## Quickstart

Run the bundled example end-to-end (uses both Claude and Codex):

```bash
singleton run --pipeline examples/mixed-claude-codex/.singleton/pipelines/contact-view-polish-mixed.json
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

Execution is sequential, ordered by `$PIPE` dependencies. A preflight pass validates inputs, files, providers and references before any LLM is called. Each run lands in `.singleton/runs/<id>/` with a manifest; `/commit-last` stages only the real project deliverables (never `.singleton` itself).

Full details, agent fields, provider resolution, preflight rules, CLI flags, `$FILES` format, run manifest schema live in **[docs/reference.md](docs/reference.md)**.

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
