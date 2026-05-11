# OpenCode Review Example

Single-step experimental OpenCode pipeline:

1. read a request and target file
2. produce a Markdown review report

This example is intentionally read-only. It validates the OpenCode runner without requiring Singleton to trust OpenCode write permissions.

Run:

```bash
singleton run --pipeline examples/opencode-review/.singleton/pipelines/opencode-review.json
```

Dry-run:

```bash
singleton run --pipeline examples/opencode-review/.singleton/pipelines/opencode-review.json --dry-run
```

Requirements:

- `opencode` available in your shell
- an OpenCode model configured, for example `ollama/qwen2.5-coder:14b`

