# Current Task

## Status

M0-F09 is accepted and committed at `fb9687d`. The first M0-F10 implementation attempt correctly
stopped before changing production code because the deferred event/snapshot specification did not
define deterministic payload, snapshot, error-applicability, numeric-bound, or NDJSON contracts.
The first documentation-only completion then failed adversarial independent review with 11
concrete ownership, identity, lifecycle, asynchronous-failure, recovery, and framing findings. The
next focused re-review found five remaining operation-recovery, post-acceptance-race,
lifecycle-ownership, preview-recovery, and process-observation problems. The current uncommitted
task remains documentation-only M0-F10 specification correction. No F10 production implementation
has begun.

## Specification-closure deliverables

- an exact two-route F10 inventory and 31-route complete-v1 count without reconciliation;
- safe-integer event/cursor bounds, exact serialized cursor grammar, and cursor-invalid reason
  precedence;
- a strict four-field snapshot boundary with eight exact Agent-observation resource members and
  retained Agent operation observations that do not replace Web lifecycle ownership;
- an exact 12-way event union binding each discriminator to one resource/operation association and
  one closed payload;
- type-specific resource identities with multi-scope project Git recovery and no manufactured
  runtime-stack/service UUIDs;
- an 18-code race-aware `AgentExecutionFailure` union, exhaustive classification of all 23 F09
  errors, and exact applicability for all 19 mutations;
- authoritative domain-owned structural lifecycle-edge validation without fabricated context;
- a coarse three-state Agent operation observation that guarantees nonterminal recovery while
  preserving accepted F09 terminal compaction;
- complete F09 process and preview observation events, including exact same-state enrichment rules;
- F09 inspection/error-shape reuse without changing the accepted 29-endpoint/23-error F09 views;
- two F10-only errors, exhaustive route applicability, and a 25-error full-v1 view;
- deterministic snapshot-required replay reasons and exact LF-only ordinary-JSON framing,
  property-order, trailing-newline, blank-line, and incomplete-line semantics;
- explicit separation between individual-object validation and runtime continuity/replay
  guarantees;
- milestone-plan alignment that assigns snapshot contracts to F10 while leaving snapshot
  collection, event production, replay, retention, and HTTP streaming outside Milestone 0.

## Scope boundary

This slice changes specification and living documentation only. It adds no package source,
generated schema, fixture, dependency, Agent/Web/database behavior, snapshot collection, event
production/storage, replay, HTTP/NDJSON transport, reconciliation, runtime plan, or F11 work.

## Next task

Perform a focused independent re-review of the corrected M0-F10 specification. If accepted, retain
it as the documentation boundary for a fresh M0-F10 implementation agent. Do not begin M0-F11.
