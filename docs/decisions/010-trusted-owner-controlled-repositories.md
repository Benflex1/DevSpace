# ADR 010: Adopt a trusted-repository threat model

- Status: Accepted


## Context
Rootless containers reduce impact but do not safely execute arbitrary hostile code.

## Decision
Support only owner-controlled trusted repositories. Enforce strong host and cross-project boundaries without claiming hostile-code sandboxing.

## Consequences
Network exfiltration and container-runtime vulnerabilities remain residual risks and must be documented.
