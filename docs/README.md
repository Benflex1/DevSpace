# DevSpace documentation map

## Durable sources

- `architecture.md` — system structure and service boundaries.
- `security/threat-model.md` — trust boundaries, assets, and security assumptions.
- `static-analysis.md` — Semgrep CE workflow, report summary, and AI triage policy.
- `roadmap.md` — product milestones and sequencing.
- `specs/` — versioned implementation contracts.
- `decisions/` — durable accepted ADRs.

Current AI-session authorities are ADR 015 and `specs/ai-sessions-v1.md` for the structured
Codex path; ADR 016 and `specs/harness-sessions-v1.md` for the generic native PTY path;
ADR 009 remains the authority for ordinary user-operated terminal/PTY AI CLI workflows.

## Status

`current-state.md` is the concise factual status of the repository. It is not an authority for
architecture or contracts.

## Authority and conflict order

When documents disagree, use this order:

1. explicit current user/product decisions;
2. accepted ADRs;
3. versioned specifications;
4. architecture and security documents;
5. roadmap;
6. current status;
7. package READMEs and code comments.

Agents should read `AGENTS.md`, directly relevant code, and directly relevant durable
docs/specs. They should not automatically read `current-state.md` or every architecture document
for every task.
