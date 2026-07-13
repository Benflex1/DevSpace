# Codex Review Prompt Template

```text
Review the current DevSpace working-tree diff. Do not edit files yet.

Read first:
- AGENTS.md
- docs/current-state.md
- <relevant ADRs/specifications>

Review focus:
- correctness and edge cases;
- architecture-boundary violations;
- security regressions;
- missing or weak tests;
- migration and lifecycle consistency where applicable;
- accidental scope expansion;
- misleading documentation or unsupported claims.

Instructions:
1. Inspect the actual diff and relevant surrounding code.
2. Run focused read-only checks if useful.
3. Report findings ordered by severity.
4. For every finding, cite the file and explain the concrete failure mode.
5. Do not include stylistic preferences unless they affect maintainability or correctness.
6. If there are no material findings, say so and list remaining verification gaps.
7. Do not modify the working tree until explicitly asked.
```
