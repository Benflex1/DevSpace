# contracts

`@devspace/contracts` owns the executable Agent API v1 F09/F10/F11 wire foundation. Its package-root API
provides strict Zod schemas and inferred types for shared wire primitives, request/success
envelopes, configuration revision documents, endpoint data, lifecycle-dependent inspections, the
unchanged F09-only 23-code executable error registry, the historical 30-endpoint F09 inventory,
mutation headers, and the pure terminal binary-frame codec. F10 adds the textual boot-scoped
cursor, recovery snapshot and seven-resource union, four-state Agent operation observations,
18-code asynchronous execution failures with exact 20-mutation applicability, the strict 11-event
union, two F10-only errors, two F10 endpoint descriptors, complete-v1 inventory/error views, and
the NDJSON content-type/framing metadata. F10 process observations are restricted to
`task | terminal` and exclude first-class AI processes. F11 supersedes F09's four never-implemented
AI descriptors, adds ten AI profile/session operations, strict provider-neutral commands, safe
profile and interaction projections, the 22-event canonical AI union, append/duplicate/gap
classification, and a dedicated replay/synchronization stream. Start/resume fence the exact inspected
`sha256-ai-profile-v1` revision, and the append classifier checks both sequence ownership and
global event-ID ownership.

The F09 inventory remains the historical authority for its accepted non-AI operations. Its four
dormant AI descriptors are retained only for compatibility evidence and are excluded from the
complete inventory. F10 and F11 compose with the 26 non-AI F09 descriptors to provide mechanically
testable historical-F09, F10-only, F11-only, and complete-v1 views.
Together the endpoint descriptors are the authority for operation names, methods, paths,
classification, headers, request/success validators, statuses, and route-specific error unions.
The generated `schemas/agent-api-v1.schema.json` artifact is drift-checked by
`pnpm contracts:check`; runtime Zod schemas remain authoritative.

Endpoint header schemas validate only the extracted DevSpace-owned protocol-header projection.
`extractDevSpaceProtocolHeaders` treats raw HTTP names case-insensitively, ignores ordinary HTTP,
proxy, tracing, and WebSocket headers, rejects unknown `X-DevSpace-*` names, and rejects duplicate
known values. The endpoint schema then requires or prohibits the operation-ID projection according
to its classification. This package does not claim ownership of the complete HTTP header map.

The generated artifact is a structural JSON Schema projection, not a standalone substitute for
the runtime Zod contracts. Important runtime-only validation includes:

- exact canonical JSON text, RFC 8785/JCS equality, Unicode scalar validity, and the final
  2,097,152-byte UTF-8 Project Options revision boundary;
- semantic calendar validity and exact canonical UTC-millisecond timestamp equality beyond the
  portable textual pattern;
- the domain-owned Git branch shorthand policy and repository URL policy;
- Unicode-scalar validation and scalar-count limits for operator messages;
- state-dependent process timestamp and exit-code relationships, source-inspection and preview
  route/hostname relationships, and managed-store dirty-state relationships;
- route-specific resource/source identity echo and applicability relationships that require
  request context.
- F10 cursor/event boot-and-sequence equality and snapshot boot/cursor equality;
- the exact EventCursor sequence maximum (`9007199254740991`) through authoritative runtime
  parsing; the portable generated decimal-string pattern does not encode that upper bound;
- snapshot resource, project Git-scope, and operation-observation uniqueness and consistency;
- domain-owned lifecycle structural-edge checks and full process observation change rules;
- preview event-object invariants in the event schema; complete preview transition validation that
  requires the Agent's retained prior full observation is performed only by
  `validatePreviewObservationChange` with that retained context.
- AI content UTF-8 bounds, workspace-relative presentation paths, immutable profile capability
  requirements, closed failure category/incident policy, profile-revision representation, and
  exact event append decisions. The Agent-private provider-adapter module owns executable
  profile-authority canonicalization and hashing tests without exporting the private document as
  an Agent/Web contract.

Portable types, required properties, closed objects, discriminators, numeric bounds, literal
values, and representable string patterns remain in the generated JSON Schema. Its deterministic
root `$comment` points consumers back to these runtime refinements and explicitly identifies the
cursor maximum and retained-preview-context boundary.

Standalone `agentEventSchema` validates the complete wire object and all event-object refinements,
but it cannot prove preview transition conditions that depend on a previous full observation absent
from the event payload. JSON Schema likewise does not prove those retained-context conditions.

The generated schema does not prove snapshot atomicity, per-boot stream continuity, replay
availability, retained-history integrity, or retention policy. F10 implements no snapshot
collection, event production/storage, replay, HTTP streaming, NDJSON codec, or runtime recovery.

F11 mutation descriptors distinguish existing bounded generic-request journaling from the future
dedicated private-AI-intent-reference policy required by prompts and structured-input answers.
The deep Agent-private fingerprint helper fixes the domain-separated
`hmac-sha256-ai-private-intent-v1` canonical document and key-rotation policy without exporting
either helper or private schema from the package root.
The package contains no runtime plan implementation, reconciliation, mutation journal,
provider-process runtime, credential delivery, second idempotency identity, or public request hash.
The Codex 0.145.0 raw-protocol pin is an internal fixture boundary and is not exported as the
Agent/Web contract. Its offline tests hash and parse the actual checked generated stable-default
components and separately classified experimental structured-input component. Among production
workspace packages, contracts depends only on
`@devspace/domain`. It does not depend on security, Project Options, database, Agent, or Web.
