# project-options

`@devspace/project-options` owns the strict Project Options v1 runtime revision. It does not
contain project General metadata, workspace display names, persistence, or runtime-plan
compilation.

## Public contract

- `projectOptionsV1Schema` is the authoritative Zod 4 schema.
- `ProjectOptionsV1` and `ProjectOptionsV1Input` are inferred input/output types.
- `PROJECT_OPTIONS_REVISION_MAX_BYTES` and `ProjectOptionsRevisionSizeError` expose the fixed
  revision-representation boundary and its stable failure metadata.
- `parseProjectOptionsV1` throws the schema's path-aware `ZodError` for invalid input.
- `safeParseProjectOptionsV1` returns the corresponding discriminated success/error result.
- `projectOptionsV1JsonSchema` and `generateProjectOptionsV1JsonSchema` expose the deterministic
  draft 2020-12 portability representation.
- `canonicalizeProjectOptionsV1` and `canonicalizeProjectOptionsV1Bytes` validate through the v1
  parser, materialize defaults, apply only the specified unordered-collection sorting, and emit
  the canonical runtime-revision JSON. Both enforce the final canonical UTF-8 revision limit of
  2,097,152 bytes.
- `hashProjectOptionsV1` hashes the UTF-8 domain `devspace/project-options-revision/v1`, one zero
  byte, and the canonical Project Options bytes with SHA-256. It returns a branded
  `ProjectOptionsRevisionHash` in `sha256-jcs-v1:<64 lowercase hex>` form and cannot hash an
  oversized revision.

The 2,097,152-byte maximum is a revision-level representation constraint measured after parsing,
default materialization, semantic normalization, JCS canonicalization, and UTF-8 encoding.
Exactly 2,097,152 bytes is accepted and 2,097,153 is rejected. `parseProjectOptionsV1` remains the
F07 structural and semantic parser and does not compute canonical byte size.

Defaults are materialized by the parser. Every configuration object is strict; environment maps
accept only valid environment-variable names. Cross-field checks cover collection uniqueness,
named-volume mounts, service dependencies and cycles, health-check ports, service bindings, and
workspace/service preview declared-port matching. Registry references remain identifiers for
later authorization/runtime refinement; secret material is never part of this model.
Task `interactive`, `longRunning`, `timeoutSeconds`, and `concurrencyPolicy` fields are independent
in Project Options v1; all structurally valid combinations remain representable and no additional
schema combination rule is imposed. M1 runtime execution is narrower: it accepts only
`interactive: false`, `longRunning: false`, `timeoutSeconds: null`, and `reject`/`allow`
concurrency, rejecting the other valid configuration concepts before Docker side effects.

The JSON Schema is generated from the Zod source with `z.toJSONSchema(..., { target:
"draft-2020-12", io: "input" })`. `pnpm schema:check` builds the source package, regenerates
into a temporary file, and byte-compares it with `schemas/project-options-v1.schema.json`.

The generated representation includes Zod's strict object shapes, defaults, enums, identifier and
environment-name patterns, UUIDv7 pattern, port/status/resource bounds, health-path shape, the
portable hostname-pattern token alphabet, and canonical container-mount spelling with dot-segment
rejection. Repository-relative path validation and the security validator's full hostname-pattern
semantics remain runtime-only because JSON Schema cannot faithfully express those policies without
duplicating the security package's private validation logic. References, uniqueness by object key,
dependency cycles, preview-port ownership, and other cross-field rules are runtime-only as well.

Canonicalization uses an internal standards-focused `canonicalize` implementation and is not a
general package-level utility. Revision hashing excludes all project General metadata, workspace
display names, and database revision metadata because the strict runtime-revision parser rejects
those fields. Runtime-plan compilation begins in Milestone 1.
