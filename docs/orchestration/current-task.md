# Current Task

## Status

The accepted Agent API v1 specification at `bafa075` has been implemented as the uncommitted
M0-F09 executable contract foundation. Seven concrete findings from the first implementation
review have been corrected and the slice is ready for re-review. It is not accepted or committed.

## Implementation deliverables

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
- distinct branch-name and branch/commit base-ref concepts, with branch validation authority
  extracted into `@devspace/domain` while preserving the security API;
- a 23-code executable F09 error registry and exhaustive 29-row route mapping;
- reconciliation deferred beyond both F09 and F10, while F10 snapshot/event/error contracts remain
  clearly non-executable F09 design input;
- strict Zod request, response, primitive, lifecycle, and error schemas exposed from the contracts
  package root;
- one declarative 29-endpoint inventory with mechanically inspectable mutation headers, success
  statuses, and route-specific errors;
- pure byte-exact terminal frame codecs and protocol metadata, without WebSocket transport;
- domain-owned branch shorthand validation with security delegation and narrow workspace-graph
  correction;
- deterministic generated Agent API v1 JSON Schema artifact and permanent regression tests;
- DevSpace-only raw-header projection that ignores ordinary transport headers while rejecting
  unknown or duplicate protocol headers;
- one exact 2,097,152-byte final canonical Project Options revision boundary across F08 and F09;
- literal-preserving endpoint lookup types, independent endpoint/error test oracles, documented
  JSON Schema runtime limitations, and a fixed public error API with no override-capable builder.

## Scope boundary

This slice adds contract infrastructure only. It adds no Agent/Web/database behavior, HTTP or UDS
transport, mutation journal, terminal execution/proxy, reconciliation, runtime plan, or F10
event/cursor implementation.

## Next task

Perform a focused independent re-review of the corrected M0-F09 diff. If accepted, commit it as a
separate review boundary before beginning M0-F10.
