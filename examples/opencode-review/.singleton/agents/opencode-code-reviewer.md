# OpenCode Code Reviewer

## Config

- **id**: opencode-code-reviewer
- **description**: Reviews a target file with OpenCode and returns a concise Markdown report.
- **inputs**: request, target_file, target_path
- **outputs**: review_report
- **provider**: opencode
- **model**: ollama/qwen2.5-coder:14b
- **security_profile**: read-only

---

## Prompt

Review `<target_path>` using `<request>` and `<target_file>`.

Strict rules:
- Do not mention your capabilities.
- Do not mention OpenCode, Ollama, or the execution environment.
- Do not invent functions that are not present in the provided code.
- Use the exact names from the provided code.
- Do not modify files.
- Focus on correctness, maintainability, security, and testability.
- Keep the report concise.
- Return only this Markdown structure:

## Review

### Findings

### Suggested improvement

### Verdict
