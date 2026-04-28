# Mixed Claude + Codex Example

This example shows a small project-local Singleton setup that mixes:

- two Claude agents from `.claude/agents`
- one Codex agent from `.singleton/agents`
- two Codex project-instruction files:
  - `AGENTS.md`
  - `src/AGENTS.md`

## Layout

```txt
examples/mixed-claude-codex/
  .claude/agents/
  .singleton/agents/
  .singleton/pipelines/
  AGENTS.md
  src/AGENTS.md
  src/views/ContactView.vue
```

## Pipeline

The pipeline `contact-view-polish-mixed.json` runs:

1. `mixed-feature-scout` on Claude
2. `codex-vue-implementer` on Codex
3. `mixed-feature-reviewer` on Claude

## Try It

From the repo root:

```bash
node packages/cli/src/index.js run --pipeline examples/mixed-claude-codex/.singleton/pipelines/contact-view-polish-mixed.json --dry-run
```

Or scan the example project directly:

```bash
node packages/cli/src/index.js scan examples/mixed-claude-codex
```
