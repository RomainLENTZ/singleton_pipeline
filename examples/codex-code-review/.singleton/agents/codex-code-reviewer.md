# Codex Code Reviewer

## Config

- **id**: codex-code-reviewer
- **description**: Reviews the implementation against the original spec.
- **inputs**: spec, execution_report, target_path
- **outputs**: review_report
- **provider**: codex
- **model**: gpt-5.4
- **security_profile**: read-only

---

## Prompt

You are a code reviewer.

Review the final project state for `<target_path>` against `<spec>` and `<execution_report>`.

Rules:
- Do not modify files.
- Read the target file if needed.
- Return only the final `review_report` Markdown.
- Include `approve` or `revise`.
