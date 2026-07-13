# DevSpace Documentation

This directory contains the architectural, security, product, and implementation sources of truth for DevSpace.

## Reading policy

Do not read the entire documentation tree for every task.

Start with:

1. the repository-level `AGENTS.md`;
2. `docs/current-state.md`;
3. `docs/orchestration/current-task.md`;
4. only the documents listed for the relevant task type below.

Inspect implementation code directly when verifying current behavior. Documentation describes intended behavior but must not be used as proof that something is implemented.

## Documentation map

| Need                                       | Source                                                                     |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| Product vision and accepted requirements   | [`../DEVSPACE_HANDOFF_V2.md`](../DEVSPACE_HANDOFF_V2.md)                   |
| Current implementation status              | [`current-state.md`](current-state.md)                                     |
| Current assigned task                      | [`orchestration/current-task.md`](orchestration/current-task.md)           |
| System architecture and service boundaries | [`architecture.md`](architecture.md)                                       |
| Milestones and implementation order        | [`roadmap.md`](roadmap.md)                                                 |
| Security model and trust boundaries        | [`security/threat-model.md`](security/threat-model.md)                     |
| Project Options data model                 | [`specs/project-options-v1.md`](specs/project-options-v1.md)               |
| SQLite schema design                       | [`specs/database-v1.md`](specs/database-v1.md)                             |
| Resource lifecycle states                  | [`specs/lifecycle-states.md`](specs/lifecycle-states.md)                   |
| Web-to-agent API and event contracts       | [`specs/agent-api-v1.md`](specs/agent-api-v1.md)                           |
| Settled architectural decisions            | [`decisions/`](decisions/)                                                 |
| AI-assisted development workflow           | [`ai-development-workflow.md`](ai-development-workflow.md)                 |
| Reusable implementation prompt format      | [`templates/codex-task-prompt.md`](templates/codex-task-prompt.md)         |
| Reusable independent-review prompt         | [`templates/codex-review-prompt.md`](templates/codex-review-prompt.md)     |
| Required Codex final-response format       | [`templates/codex-session-handoff.md`](templates/codex-session-handoff.md) |
| Milestone implementation plans             | [`implementation/`](implementation/)                                       |

## Minimal reading sets

### Small maintenance or documentation task

Read:

* `AGENTS.md`;
* `current-state.md`;
* `orchestration/current-task.md`;
* only the files named in the task.

Do not read the complete architecture, roadmap, ADR set, or specifications unless the change affects them.

### Web application task

Read:

* `AGENTS.md`;
* `current-state.md`;
* `orchestration/current-task.md`;
* the relevant section of `architecture.md`;
* the applicable API or lifecycle specification;
* `apps/web/README.md` when present.

Read individual ADRs only when the task touches their decisions.

### Workspace agent task

Read:

* `AGENTS.md`;
* `current-state.md`;
* `orchestration/current-task.md`;
* the workspace-agent section of `architecture.md`;
* `security/threat-model.md`;
* the applicable API or lifecycle specification;
* `apps/agent/README.md` when present.

### Database or migration task

Read:

* `AGENTS.md`;
* `current-state.md`;
* `orchestration/current-task.md`;
* `specs/database-v1.md`;
* `specs/lifecycle-states.md`;
* ADR 005;
* `packages/database/README.md` when present.

### Project Options task

Read:

* `AGENTS.md`;
* `current-state.md`;
* `orchestration/current-task.md`;
* `specs/project-options-v1.md`;
* ADR 004;
* the versioned JSON Schema and relevant fixtures;
* `packages/project-options/README.md` when present.

### Container runtime or security task

Read:

* `AGENTS.md`;
* `current-state.md`;
* `orchestration/current-task.md`;
* `architecture.md`;
* `security/threat-model.md`;
* only the relevant container, agent, or trust-boundary ADRs.

These tasks may require broader reading because security decisions cross subsystem boundaries.

### Preview task

Read:

* `AGENTS.md`;
* `current-state.md`;
* `orchestration/current-task.md`;
* the preview sections of `architecture.md` and `security/threat-model.md`;
* ADRs 007 and 008;
* the applicable API and lifecycle specifications.

### AI-session or terminal task

Read:

* `AGENTS.md`;
* `current-state.md`;
* `orchestration/current-task.md`;
* the relevant architecture and threat-model sections;
* ADR 009;
* the applicable API and lifecycle specifications.

### Architecture or milestone planning

Read the complete set of architecture documents, specifications, and relevant ADRs only when the task explicitly requires cross-project consistency analysis.

This should be uncommon and usually occur once per milestone or major architectural change.

## Authority and conflict resolution

When documents disagree, use this order:

1. explicit user decisions recorded in accepted ADRs;
2. accepted ADRs;
3. versioned specifications;
4. `architecture.md`;
5. `DEVSPACE_HANDOFF_V2.md`;
6. `roadmap.md`;
7. implementation plans;
8. package README files.

`current-state.md` is authoritative about what is currently implemented, but it does not override architecture or security decisions.

Do not silently resolve a material contradiction. Report it and recommend a resolution.

## Document lifecycle

### Durable documents

These remain part of the repository:

* product handoff;
* architecture;
* threat model;
* roadmap;
* specifications;
* ADRs;
* AI development workflow;
* prompt and handoff templates.

### Frequently updated documents

Update these as work progresses:

* `current-state.md`;
* `orchestration/current-task.md`;
* active milestone implementation plans;
* package README files for implemented packages.

### Temporary documents

Do not commit:

* raw AI chat transcripts;
* copied Codex terminal output;
* scratch notes;
* local credentials;
* generated runtime state;
* temporary investigation files.

A temporary finding that affects future work should be summarized in `current-state.md`, an implementation plan, a specification, or an ADR instead of preserving the complete conversation.

## Keeping documentation efficient

* Link to an existing source instead of repeating it.
* Keep `AGENTS.md` limited to rules that apply to most tasks.
* Keep `current-state.md` concise and factual.
* Add an ADR only for a durable architectural choice.
* Add a specification only when code needs a stable contract.
* Do not create a new document for a small implementation task.
* Remove or update obsolete documents promptly.
