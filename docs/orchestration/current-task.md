# Current Task

## Status

The focused architecture correction to the documentation-only Agent API v1 wire contract is ready
for independent re-review. M0-F08 is accepted and committed as `67691aa`. M0-F09 production
implementation has not begun.

The first independent contract review required removal of premature runtime-plan, second-key/public
request-hash, extra Agent-side terminal authorization, keyed AI-profile, reconciliation,
Web-operation-lifecycle, optional capability, broad Git-ref, and F10-error concepts. Those findings
are resolved in the specification.

## Corrected deliverables

- an exact 29-endpoint F09 inventory: 19 journaled mutations, nine ordinary non-mutating HTTP
  operations, and one terminal WebSocket upgrade;
- the Web-created `X-DevSpace-Operation-Id` as the sole public idempotency identity, with private
  Agent fingerprinting permitted but not standardized;
- Project Options revision validation/registration with no runtime-plan document or hash;
- minimal `{ operationId }` durable-acceptance receipts with no duplicated Web operation state;
- fixed capability metadata with every executable v1 endpoint mandatory;
- singular workspace `aiProfile` selection and `AI_NOT_CONFIGURED` for a null profile;
- protected-UDS terminal proxy authorization owned by Web, one active attachment, deterministic
  pre-ready rejection, and detach without terminal closure;
- distinct branch-name and branch/commit base-ref concepts, plus the required future extraction of
  branch validation authority into `@devspace/domain` while preserving the security API;
- a 23-code executable F09 error registry and exhaustive 29-row route mapping;
- reconciliation deferred beyond both F09 and F10, while F10 snapshot/event/error contracts remain
  clearly non-executable F09 design input.

## Scope boundary

This slice changes specification and living/security documentation only. It adds no production
source, runtime schemas, generated artifacts, Agent/Web/database behavior, transport, journal,
terminal implementation, reconciliation, or F10 event/cursor implementation.

## Next task

Perform a focused independent contract re-review. If accepted, resume M0-F09 implementation
directly from `docs/specs/agent-api-v1.md`; do not begin M0-F10 in the same review slice.
