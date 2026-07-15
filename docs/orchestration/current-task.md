# Current Task

## Status

M0-F08 implementation is in progress on the existing branch. M0-F07 is accepted and committed as
`66c3f2d`. F08 is not accepted or committed.

## In-progress F08 deliverables

- RFC 8785/JCS canonical JSON text and deterministic UTF-8 bytes owned by
  `@devspace/project-options`, behind an explicit JSON-compatible runtime boundary;
- strict rejection of lossy or unstable JavaScript inputs including non-finite numbers, lone
  surrogates, sparse arrays, non-plain objects, accessors, symbols, and cycles;
- Project Options v1 canonicalization through the authoritative F07 parser with defaults
  materialized and only specification-declared unordered collections sorted;
- SHA-256 over `devspace/project-options-revision/v1`, a zero byte, and canonical JSON bytes, with
  `sha256-jcs-v1:<64 lowercase hexadecimal characters>` output;
- published JCS-derived canonicalization vectors, collection/default equivalence regressions,
  ordered-array sensitivity checks, excluded-metadata rejection, and a checked-in golden revision
  fixture.

## Scope boundary

F08 adds representation infrastructure only. It does not add revision persistence or activation,
runtime-plan compilation, agent contracts, events/cursors, database schema or migrations, or any
Git, Docker, process, terminal, preview, Caddy, or AI runtime behavior.

## Next task in this chat

Review the complete F08 diff and verification results. Do not begin F09 or later work.
