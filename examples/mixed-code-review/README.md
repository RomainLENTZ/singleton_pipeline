# Mixed Claude/Codex Code Review Example

Mixed-provider pipeline:

1. Claude scouts the target file and spec
2. Codex edits a target file under `src/`
3. Claude reviews the final result

This example is a portable template. Run it from a real project and provide:

- a text spec
- the target file path
- the same file as readable context

Run:

```bash
singleton run --pipeline examples/mixed-code-review/.singleton/pipelines/text-spec-to-code-review-mixed.json
```

Dry-run:

```bash
singleton run --pipeline examples/mixed-code-review/.singleton/pipelines/text-spec-to-code-review-mixed.json --dry-run
```
