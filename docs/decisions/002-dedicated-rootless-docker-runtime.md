# ADR 002: Use a dedicated rootless Docker daemon

- Status: Accepted


## Context
The host/Coolify Docker socket would give DevSpace authority over production and unrelated containers.

## Decision
Run Docker rootlessly under the dedicated `devspace` Unix account. Only the workspace agent can access that daemon socket.

## Consequences
No privileged containers or host-root daemon access are required. Some kernel, device, and networking operations remain intentionally unavailable.
