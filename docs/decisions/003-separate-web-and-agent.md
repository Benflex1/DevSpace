# ADR 003: Separate the control plane from execution

- Status: Accepted


## Context
A browser-facing process should not directly own filesystem, Git, Docker, PTY, or gateway privileges.

## Decision
Use a web application for authentication/orchestration and a private workspace agent for execution. Communicate through a Unix domain socket.

## Consequences
The security boundary is explicit and independently testable. Deployment must mount only the narrow agent socket into the web service.
