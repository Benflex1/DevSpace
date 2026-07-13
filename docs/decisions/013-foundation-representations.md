# ADR 013: Foundation representations and agent transport

## Status

Accepted on 2026-07-14.

## Context

Milestone 0 needs one representation for runtime tooling, versioned schemas, identifiers, timestamps, hashes, and the web-to-agent transport. Leaving those choices to individual packages would make generated artifacts, fixtures, persistence, and wire contracts incompatible.

## Decision

- DevSpace targets Node.js 24 LTS and pnpm 11. M0-F02 will pin one exact pnpm 11 release.
- All first-party JavaScript and TypeScript packages use ESM. CommonJS may be consumed as an external dependency but is not a first-party output format.
- Zod runtime schemas are the executable source of truth for versioned data models. TypeScript types are inferred from them. Committed JSON Schema draft 2020-12 files are deterministic generated artifacts and are never hand-maintained.
- IDs are canonical lowercase UUIDv7 strings. The resource type is carried in a separate field and is never encoded as an ID prefix.
- Timestamps are canonical RFC 3339 UTC strings with exactly millisecond precision. SQLite stores them as `TEXT`.
- Validated configuration and request values are normalized as their owning specifications define, including explicit default materialization. JSON is then serialized with RFC 8785/JCS.
- Configuration and operation request hashes use SHA-256 and lowercase hexadecimal digests. Their textual representation carries the algorithm and format version as defined by the owning specification.
- The agent protocol is REST-style HTTP with JSON over a Unix domain socket, with the major protocol version in the `/v1` path. It is not JSON-RPC.
- An event cursor identifies an agent boot ID and a sequence in that boot stream. Replay is available only for the same retained boot stream. A boot mismatch, expired cursor, or unavailable history requires a fresh resource snapshot followed by resubscription from the snapshot cursor.

## Consequences

- M0-F02 may scaffold packages without selecting these representations again.
- Schema checks must detect drift by regenerating artifacts from Zod sources; generated JSON Schema is not an alternate authority.
- Database, domain, Project Options, and contract fixtures share the same ID, timestamp, canonicalization, and hash formats.
- Agent restarts intentionally break cursor continuity; clients recover from a snapshot instead of treating cursors as durable global offsets.

## Detailed contracts

- [Project Options v1](../specs/project-options-v1.md)
- [SQLite Data Model v1](../specs/database-v1.md)
- [Lifecycle State Machines](../specs/lifecycle-states.md)
- [Web to Workspace Agent Contract v1](../specs/agent-api-v1.md)

