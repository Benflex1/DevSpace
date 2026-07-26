# AI supervisor capability proof

This directory is an explicitly opt-in, non-production feasibility harness for ADR 015. Run it
only from the DevSpace code-server environment:

```bash
DEVSPACE_DOCKER_SOCKET_PATH=/run/devspace-docker/docker.sock pnpm ai-supervisor:proof
```

The command refuses every other socket path. It uses the already-present `node:24-bookworm`
image, uploads these fixture files into a uniquely named disposable container, and never pulls an
image, mounts a host path, enables networking, or runs a real provider.

The runner creates a mode-`0600` ownership record under a mode-`0700` temporary directory outside
the repository. A random credential is supplied to the exact supervisor exec and every new helper
exec on stdin. It never enters arguments, environment, labels, or normal output. The original
Docker attachment is destroyed after bootstrap; recovery uses a separate host process and a new
fixed helper exec.

The accepted provider identity is its inner PID, parent PID, process group, session, Linux
`/proc/<pid>/stat` start time, PID namespace inode, and namespace PID sequence. The supervisor
revalidates that identity and the complete descendant tree before signalling the negative PGID.
PID, exec ID, process name, and socket permissions are never sufficient alone.

The harness is not part of ordinary tests or CI. Unit tests exercise its pure parsing and decision
helpers; `pnpm ai-supervisor:proof` is the only hands-on command.
