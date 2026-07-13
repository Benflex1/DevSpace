# ADR 011: Separate desired and observed runtime state

- Status: Accepted


## Context
SQLite cannot prove that containers, processes, or routes currently exist.

## Decision
Persist user intent as desired state and agent observations as observed state. Reconciliation compares both with runtime reality.

## Consequences
Transient and lost states are explicit. UI and operations must tolerate eventual observation updates.
