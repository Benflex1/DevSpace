# Architecture

## Context

DevSpace is a single-user AI-first control plane for trusted owner-controlled repositories. It creates rootless containerized development environments, not host processes.

## Components

### Browser

The browser renders the UI and terminal. It never receives agent, Docker, gateway, or database credentials.

### Web application

The web application authenticates Cloudflare Access users, owns browser-facing APIs, validates intent, writes SQLite, records audit events, and orchestrates long-running operations.

### Workspace agent

The agent is a private execution service under the dedicated `devspace` Unix account. It manages repository stores, Git worktrees, the dedicated rootless Docker daemon, PTY streams, process supervision, health checks, and gateway routes.

### Rootless Docker runtime

A separate rootless daemon owned by `devspace` manages only DevSpace resources. Coolify and production containers are outside its authority. The agent may access this dedicated socket; no workspace container and no web process may access it.

### Workspace stack

One stack exists per workspace. It has a development container, optional supporting services, a private network, named volumes, and preview targets. Resource names are derived from opaque IDs, not user strings.

### Preview gateway

Caddy receives wildcard preview traffic and routes exact active hosts to workspace services. The agent is the only admin client.

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

Tasks, terminals, and AI CLIs execute inside the development container. The agent owns the long-lived Docker attach streams. Browser reconnect is supported while the agent remains alive. Surviving and reattaching after an agent restart is not required initially; such sessions become `lost` and are reconciled safely.

Predefined tasks use structured executable and argument arrays. Interactive terminal and AI sessions are explicit elevated capabilities and are audited.

## Network model

- each workspace has a private network;
- supporting services are reachable by service name only inside that network;
- development service ports are not publicly published;
- preview targets are exposed only to the gateway through private networking or loopback bindings;
- agent and gateway admin endpoints are never public;
- Cloudflare Tunnel is the only public ingress.

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

All mutating operations are idempotent and carry operation IDs. Events are ordered per agent connection and include a cursor for reconnect.
