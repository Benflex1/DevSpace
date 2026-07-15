# contracts

`@devspace/contracts` owns the executable Agent API v1 F09 wire foundation. Its package-root API
provides strict Zod schemas and inferred types for shared wire primitives, request/success
envelopes, configuration revision documents, endpoint data, lifecycle-dependent inspections, the
23-code executable error registry, the declarative 29-endpoint inventory, mutation headers, and
the pure terminal binary-frame codec.

The endpoint inventory is the single authority for operation names, methods, paths,
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
- distinct AI-session source/new identities and other cross-field relationships;
- route-specific resource/source identity echo and applicability relationships that require
  request context.

Portable types, required properties, closed objects, discriminators, numeric bounds, literal
values, and representable string patterns remain in the generated JSON Schema. Its deterministic
root `$comment` points consumers back to these runtime refinements.

F09 contains no transport implementation, runtime plan, reconciliation, snapshot, event/cursor,
mutation journal, attachment grant, keyed AI profile, second idempotency identity, or public
request hash. Among production workspace packages, contracts depends only on `@devspace/domain`.
It does not depend on security, Project Options, database, Agent, or Web.
