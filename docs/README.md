# DevSpace documentation map

## Durable sources

- `architecture.md` — system structure and service boundaries.
- `security/threat-model.md` — trust boundaries, assets, and security assumptions.
- `roadmap.md` — product milestones and sequencing.
- `specs/` — versioned implementation contracts.
- `decisions/` — durable accepted ADRs.

## Status

`current-state.md` is the concise factual status of the repository. It is not an authority for
architecture or contracts.

## Historical and execution documents

`implementation/milestone-0-foundation-plan.md` remains useful until Milestone 0 closes. It is an
execution plan, not a permanent architecture authority; after M0 it may be archived or removed.

## Authority and conflict order

When documents disagree, use this order:

1. explicit current user/product decisions;
2. accepted ADRs;
3. versioned specifications;
4. architecture and security documents;
5. roadmap;
6. status and implementation plans;
7. package READMEs and code comments.

Agents should read `AGENTS.md`, directly relevant code, and directly relevant durable
docs/specs. They should not automatically read `current-state.md` or every architecture document
for every task.
