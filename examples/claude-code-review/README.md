# Claude Code Review Example

Three-step Claude pipeline:

1. scout the target file and spec
2. edit a target file under `src/`
3. review the final result

This example is a portable template. Run it from a real project and provide:

- a text spec
- the target file path
- the same file as readable context

Run:

```bash
singleton run --pipeline examples/claude-code-review/.singleton/pipelines/text-spec-to-code-review.json
```

Dry-run:

```bash
singleton run --pipeline examples/claude-code-review/.singleton/pipelines/text-spec-to-code-review.json --dry-run
```
