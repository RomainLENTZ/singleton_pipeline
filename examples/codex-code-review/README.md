# Codex Code Review Example

Three-step Codex pipeline:

1. scout the target file and spec
2. edit a target file under `src/`
3. review the final result

This example is a portable template. It does not ship a toy source file.

Use `--dry-run` as-is from this repository to validate the pipeline shape. For a real run, copy or adapt this example's `.singleton` folder into your target project, then provide:

- a text spec
- the target file path
- the same file as readable context

The writer step is restricted to `src/` by default.

Run after copying into the target project:

```bash
singleton run --pipeline .singleton/pipelines/text-spec-to-code-review.json
```

Dry-run from this repository:

```bash
singleton run --pipeline examples/codex-code-review/.singleton/pipelines/text-spec-to-code-review.json --dry-run
```
