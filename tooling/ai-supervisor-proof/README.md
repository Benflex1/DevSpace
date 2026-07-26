# AI supervisor capability proof

This directory is an explicitly opt-in, non-production harness for ADR 015:

```bash
DEVSPACE_DOCKER_SOCKET_PATH=/run/devspace-docker/docker.sock pnpm ai-supervisor:proof
```

The command refuses every other socket, uses only the already-local `node:24-bookworm` image, and
never pulls, enables networking, mounts a host path, adds privileges/capabilities, or runs a real
provider. It is not part of ordinary tests or CI.

The current verdict is **BLOCKED**. Authenticated reconnect and exact process-start identity are
feasible. Production-safe descendant termination is not: the deployment provides no writable
delegated cgroup, rootless Docker rejects `writable-cgroups=true`, and a numeric process group is
subject to escape, reuse, membership churn, and scan-to-signal races. `fixture-stop` is deliberately
named and reported as a process-group experiment; it is not production Stop authority.

The harness uses a mode-`0600` ownership record in a mode-`0700` temporary directory. Random
credentials reach the supervisor and helpers only through stdin. Strict records bind the exact
container, exec, session/generation, supervisor/provider `/proc` start identities, and the
fixture-only group observation. Docker multiplex frames, JSONL readiness, control frames, socket
lifetimes, concurrent clients, output, and mutation correlation are bounded.

The proof-local schemas demonstrate strict equality and identity binding. They are not production
request authority. Production AI launch remains blocked until an enforceable, race-safe descendant
boundary is available in every AI-capable runtime.
