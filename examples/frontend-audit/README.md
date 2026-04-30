# Frontend Audit Example

Read-only frontend audit pipeline:

1. scout Vue/style conventions
2. review architecture risks
3. write a bounded remediation plan

Run:

```bash
singleton run --pipeline examples/frontend-audit/.singleton/pipelines/frontend-audit.json
```

Dry-run:

```bash
singleton run --pipeline examples/frontend-audit/.singleton/pipelines/frontend-audit.json --dry-run
```
