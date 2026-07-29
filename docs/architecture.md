# Architecture

## Context

DevSpace is a single-user AI-first control plane for trusted owner-controlled repositories. It creates rootless containerized development environments, not host processes.

## Components

### Browser

The browser renders the UI and terminal. It never receives agent, Docker, gateway, or database credentials.

### Web application

The web application authenticates Cloudflare Access users, owns browser-facing APIs, validates intent, writes SQLite, records audit events, and orchestrates long-running operations.

### Workspace agent

The agent is a private execution service under the dedicated `devspace` Unix account. It manages repository stores, Git worktrees, the dedicated rootless Docker daemon, PTY streams, process observation, health checks, and gateway routes. M1 does not provide individual task or terminal process termination or descendant supervision.

For first-class AI Sessions v1, the Agent additionally owns the future approved-provider registry,
structured provider-process lifecycle, native-protocol adapter, Agent-private acknowledged event
outbox, and exact supervisor ownership record. This contract foundation adds no runtime handler.

### Rootless Docker runtime

A separate rootless daemon owned by `devspace` manages only DevSpace resources. Coolify and production containers are outside its authority. The agent may access this dedicated socket; no workspace container and no web process may access it.

### Workspace stack

One stack exists per workspace. It has a development container, optional supporting services, a private network, named volumes, and preview targets. Resource names are derived from opaque IDs, not user strings.

### Preview gateway

Caddy receives traffic for the administrator-reserved preview namespace and routes exact active
hosts to workspace services. A provider-neutral byte-transparent connector exposes only Caddy's
private HTTP data plane to an administrator-selected outer ingress. The agent is the only Caddy
admin client; Coolify, Traefik, Cloudflare, and DNS APIs are outside DevSpace core runtime.
DevSpace core is deployable on any Docker-capable system and does not require a particular outer
ingress provider, domain, administrator UID/GID, or host runtime directory. The fixed internal
socket and container paths are the deployment contract; provider-specific routing and
authentication configuration belongs in integration documentation.

### SQLite

The web application is the sole writer. SQLite contains desired state, observed-state snapshots, configuration revisions, operations, and audit history. Runtime state is reconciled from Git, Docker, and gateway inspection.

## Project and workspace model

A project is source metadata plus active Project Options. A workspace is a complete checkout of that project, pinned to one Project Options revision, with one isolated stack.

Every project has a primary workspace. Additional workspaces are optional and use separate Git branches/worktrees.

## Repository model

```text
/srv/devspace/projects/<project-id>/repository.git
/srv/devspace/workspaces/<workspace-id>/source
```

The managed repository store is not used as an editable checkout. Every editable checkout is a worktree. This removes the special case where the primary branch would otherwise be edited directly.

## Runtime-plan flow

1. The user edits Project Options through the web UI.
2. The web app validates and stores an immutable draft revision.
3. The user activates the revision.
4. `project-options` compiles a canonical runtime plan.
5. The web app sends the versioned plan and hash to the agent.
6. The agent independently validates policy constraints.
7. Workspaces reference the activated revision and plan hash.
8. Starting a workspace instantiates only that validated plan.

Existing workspaces do not silently change when Project Options change. Rebuild/migration is explicit.

## Process and terminal model

Supported M1 tasks and terminals execute inside the development container. The agent owns the long-lived Docker attach streams. M1 supports interactive browser terminals through `create → attach → input/output → resize → detach → reconnect` and configured foreground one-shot tasks through structured executable/argument arrays. Recovered task starts retain their Agent-private ownership and exact task operation binding across an Agent restart; terminal sessions become `lost` because their PTY attachment is not replayed. M1 task/terminal Stop and forceful Close fail closed because exact individual termination is deferred; AI sessions remain future work.

Predefined tasks use structured executable and argument arrays. Project Options v1 can represent interactive, long-running, timeout, and replacement policies, but the M1 task runtime accepts only `interactive: false`, `longRunning: false`, `timeoutSeconds: null`, and `concurrencyPolicy: "reject" | "allow"`; other valid combinations are rejected before Docker side effects. Interactive browser terminals are the supported elevated shell capability in M1; AI sessions are future work.

## Structured AI-session model

ADR 015 refines ADR 009. Ordinary user-operated provider CLIs may continue to run in generic
terminal PTYs. A first-class AI session is separate: Agent starts the pinned approved provider
inside the exact managed development container using Docker exec with TTY disabled, structured
JSONL on stdin/stdout, and a private stderr diagnostic channel. It is never backed by
`terminal_sessions`.

Web owns committed public session/turn/interaction history and remains the sole SQLite writer.
Agent owns the provider process, native identifiers, exact container/supervisor/process-generation
proof, and a durable acknowledged canonical-event outbox. Agent-assigned per-session sequence
numbers continue across Agent boots and process generations; Web commits in order before browser
delivery and then acknowledges the exact event. No existing lifecycle state is converted to event
sourcing.

Every Web session operation resolves the exact caller-supplied project/workspace/AI-session tuple;
turn operations also verify the exact turn/session relationship. The Web layer never replaces a
requested identity with a latest or active workspace session, and foreign/nonexistent identities
share one bounded public conflict response. SQLite applies bounded aggregate/history retention in
the event transaction: 64 turns, 2 MiB per-turn output, 8 MiB total retained turn output, 2,048
canonical events or 16 MiB, 256 interaction rows or 4 MiB, 128 KiB per interaction JSON value,
and 8 MiB per session response. Canonical event rows are one contiguous suffix described by
`historyStartSequence` and `historyTruncated`; legacy oversized values are length-checked and
projected through valid bounded models. The Agent-private outbox remains the durable replay and
acknowledgement source.

Web sends the exact inspected `sha256-ai-profile-v1` revision on start/resume; Agent re-hashes the
deployment-owned authority document before acceptance. Content-bearing mutations use referenced
Agent-private AI intent records rather than copying prompts or answers into the generic operation
journal.

The later runtime requires an in-container Agent-controlled supervisor with a private authenticated
control channel and exact generation/process-start binding. Docker exec ID or a numeric PID alone
cannot authorize Stop. Until restart recovery re-proves every identity, the provider process and
active turn are reported `lost`.

## Network model

- each workspace has a private network;
- supporting services are reachable by service name only inside that network;
- development service ports are not publicly published;
- preview targets are exposed only to the gateway through private networking or loopback bindings;
- agent and gateway admin endpoints are never public;
- the outer ingress is administrator-selected and may be Traefik, Caddy, Nginx, Cloudflare Tunnel,
  or another compatible reverse proxy;
- only the reserved preview suffix namespace is forwarded to the connector, with the original
  `Host` preserved;
- the selected outer ingress must support the exact administrator-reserved namespace, WebSocket
  upgrades, and authentication/access policy without capturing unrelated application hostnames;
- the connector can see only `/run/devspace/gateway/ingress/preview-http.sock`, never Caddy Admin,
  probe, lease-resolver, Agent, or Docker sockets.

## Configuration ownership

Project Options are stored in SQLite, not read as executable configuration from arbitrary branches. Repository inspection may suggest defaults but cannot activate them. Optional export/import uses canonical JSON and requires explicit confirmation.

## Desired and observed state

For runtime resources, store both:

- desired state: user intent;
- observed state: last agent observation.

Example:

```text
desired=running, observed=starting
desired=running, observed=running
desired=stopped, observed=stopping
desired=running, observed=lost
```

All mutating operations are idempotent and carry operation IDs. General Agent observations remain
ordered per Agent boot and use F10 cursors. AI-session canonical events use the separate durable
per-session F11 sequence/outbox contract in `specs/ai-sessions-v1.md`.
