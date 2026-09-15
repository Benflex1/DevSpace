# Codex credential bootstrap

The alpha deployment provisions the Agent-owned Codex authority through the
Agent deployment CLI. It does not read or copy any operator Codex home.

From the code-server/Agent deployment, configure the existing dedicated
rootless Docker socket and Codex artifact, then run:

```bash
pnpm --filter @devspace/agent run codex:bootstrap
```

The command resolves the configured artifact through the same Agent artifact
identity checks used by discovery, stages it into Agent-private state, and
starts a short-lived rootless Docker container using the dedicated Docker
socket. The container receives only the staged artifact and a fresh temporary
`CODEX_HOME`; it has no workspace, Agent socket, Docker socket, or host
credential mount. The default bootstrap image is `node:24-bookworm`; the
Docker daemon resolves that reference to an immutable image ID before
creation. `DEVSPACE_CODEX_BOOTSTRAP_IMAGE` may select the deployment's
compatible runtime image.

The command prints the one-time device-login instructions in the operator's
terminal and waits for the installed Codex app-server to report completion.
After completion, the Agent's native staged-readback helper validates the
fresh authority and the existing atomic replacement method installs it while
holding the exclusive credential lease.

To replace an existing authority after the Agent has marked it for
reauthentication, run the same command with `--reauth`. A failed attempt leaves
the previous durable authority unchanged. Temporary authentication state and
the bootstrap container are removed on completion or failure.
