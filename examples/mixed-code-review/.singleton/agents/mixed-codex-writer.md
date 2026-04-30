# Mixed Codex Writer

## Config

- **id**: mixed-codex-writer
- **description**: Codex writer that applies the bounded implementation.
- **inputs**: spec, scout_report, target_path
- **outputs**: execution_report
- **provider**: codex
- **model**: gpt-5.4
- **security_profile**: restricted-write
- **allowed_paths**: src/

---

## Prompt

You are a constrained code writer. Apply the requested change to `<target_path>` only. Return a concise Markdown execution report.
