# ADR 012: Use semantic web-to-agent operations

- Status: Accepted


## Context
Passing commands, paths, ports, PIDs, mounts, or proxy targets from browser-originated input would collapse the trust boundary.

## Decision
The web references opaque resource IDs, activated configuration revisions, and definition keys. The agent derives runtime details and validates policy independently.

## Consequences
Contracts are larger but safer and testable. Arbitrary terminal access remains a separate explicit capability.
