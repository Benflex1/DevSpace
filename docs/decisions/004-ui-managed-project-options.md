# ADR 004: Store Project Options as versioned database revisions

- Status: Accepted


## Context
Manual `.devspace.yml` editing is not part of the desired user experience, and branch-controlled executable configuration creates approval ambiguity.

## Decision
Project Options are edited in the UI and saved as immutable SQLite revisions. Detection/import creates drafts; only explicit activation makes a revision executable.

## Consequences
No repository YAML is required. Workspaces remain reproducible by pinning a revision. Optional JSON export/import can be added later.
