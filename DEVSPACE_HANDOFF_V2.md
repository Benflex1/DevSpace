# DevSpace — Container-First Project Handoff v2

## 1. Purpose

This document supersedes the original host-process-oriented DevSpace handoff.

DevSpace is a self-hosted, single-user, AI-first development control plane. It organizes projects, isolated development environments, Git workspaces, AI coding sessions, terminals, tasks, supporting services, Git state, and preview URLs in one browser interface.

The central design rule is:

> Maximum freedom inside a project workspace; strict isolation from the host, production data, and other projects.

## 2. Confirmed assumptions

- Registered repositories are owner-controlled and trusted. DevSpace does not promise safe execution of hostile repositories or dependencies.
- DevSpace runs under a dedicated unprivileged Unix account.
- Cloudflare Access protects the control plane and preview domains.
- Web and agent communicate through a private Unix domain socket.
- Preview applications use a dedicated preview parent or separate registrable domain.
- Project configuration is edited through Project Options. Manual `.yml` or `.yaml` editing is not required.
- Configuration is stored as immutable, versioned database revisions.
- Git worktrees remain the isolation mechanism for optional parallel workspaces.
- Every workspace, including the primary workspace, receives its own container stack.

## 3. Product model

```text
Project
├── Project Options
│   ├── source and default branch
│   ├── development environment
│   ├── supporting services
│   ├── tasks
│   ├── previews and domain
│   ├── environment variables and secrets
│   ├── AI tool profile
│   └── resource and cleanup policies
│
├── Primary Workspace
│   ├── Git worktree
│   ├── isolated container stack
│   ├── terminals and AI sessions
│   ├── tasks and processes
│   ├── supporting services
│   └── preview routes
│
└── Optional Isolated Workspaces
    └── separate branch, worktree, stack, services, processes, and previews
```

A workspace always contains the complete project. A workspace name such as `castling` means “a complete checkout on the castling branch,” not a partial project containing only castling files.

## 4. User experience

1. Open DevSpace through Cloudflare Access.
2. Add or import a trusted repository.
3. Review automatically detected Project Options.
4. Save an active configuration revision.
5. DevSpace creates a managed repository store and primary Git worktree.
6. Start the primary workspace environment.
7. Open a browser terminal or start an AI coding CLI inside the workspace container.
8. Run predefined tasks or start a preview.
9. Use the configured project preview domain.
10. Optionally create another isolated workspace for parallel work.
11. Review Git status, checks, logs, and changes.
12. Commit, push, archive, or remove the workspace. DevSpace never auto-merges.

## 5. Container runtime model

DevSpace uses a dedicated rootless Docker daemon owned by the `devspace` service account. It never uses the host/Coolify Docker socket.

Each workspace is instantiated as a namespaced stack:

```text
workspace stack
├── development container
├── zero or more declared supporting-service containers
├── private workspace network
├── named cache/data volumes
└── preview targets exposed only to the gateway
```

The development container receives only:

- its own worktree mounted at `/workspace`;
- explicitly declared named volumes;
- generated runtime metadata required by DevSpace;
- selected environment variables and secret values.

It does not receive arbitrary host mounts, the Docker socket, host networking, host PID namespace, production directories, or other project worktrees.

The default interactive account is a development user with passwordless `sudo` inside the container. Container root maps to the unprivileged rootless-runtime user on the host. Projects may run as root inside the container, but never as host root.

Ad-hoc package installations persist while the container exists. Rebuilding the environment returns it to the active Project Options revision. Reproducible dependencies should therefore be captured in Project Options or the project’s own Dockerfile.

## 6. Primary and isolated workspaces

Every project gets one primary workspace automatically. It is the normal day-to-day environment and normally checks out the configured default branch.

Additional workspaces are optional and useful for:

- parallel AI sessions;
- experiments;
- independent previews;
- simultaneous branches;
- work that should not disturb the primary environment.

All workspaces are implemented as Git worktrees created from a managed project repository store. The project repository store itself is not edited directly.

## 7. UI-first configuration

There is no required `.devspace.yml`.

Project Options are the source of truth and are stored in SQLite as immutable revisions. Saving changes creates a draft revision; activating it makes it the default for new workspaces. Existing workspaces remain pinned to the revision with which they were created until the user explicitly rebuilds or migrates them.

Configuration can be detected from repository files such as `package.json`, Dockerfiles, and lockfiles, but detected settings remain a draft until reviewed and activated.

An optional JSON export/import capability may be added for portability. It is not the normal editing interface and is not trusted merely because it exists in a repository.

## 8. Architecture

```text
Browser
  │
  │ Cloudflare Access + HTTPS/WebSocket
  ▼
DevSpace Web/API ─────────────── SQLite
  │                                ▲
  │ versioned semantic API         │ sole writer
  │ over Unix domain socket        │
  ▼                                │
Workspace Agent ───────────────────┘
  │
  ├── managed Git repository stores and worktrees
  ├── dedicated rootless Docker API
  ├── workspace stacks and processes
  ├── PTY/terminal streams
  ├── task logs and health checks
  └── Caddy gateway adapter
             │
             ▼
       Preview Gateway
             │
             ▼
      Workspace services
```

### Web/API responsibilities

- Cloudflare Access identity verification;
- browser sessions, CSRF, and origin checks;
- Project Options UI;
- projects, workspaces, operations, and audit state;
- sole ownership of SQLite writes and migrations;
- browser-facing REST, event, and terminal endpoints;
- orchestration and destructive-action confirmation;
- redaction of secrets and sensitive agent details.

The web application never executes commands, invokes Git, talks to Docker, selects host paths, signals PIDs, or administers Caddy directly.

### Workspace Agent responsibilities

- enforce managed-path boundaries;
- manage repository stores and Git worktrees;
- independently validate activated runtime plans;
- manage only the dedicated rootless Docker daemon;
- create and destroy workspace stacks;
- start and supervise predefined tasks;
- maintain PTY and AI CLI streams;
- collect logs and observed state;
- allocate internal ports and verify health;
- register exact preview routes through the gateway adapter;
- reconcile runtime state after restart.

The agent accepts semantic requests. It does not accept browser-supplied command strings, host paths, container IDs, PIDs, ports, mounts, or proxy targets.

### Database responsibilities

SQLite is authoritative for desired state, resource identity, immutable configuration revisions, operations, and audit history. Runtime inspection is authoritative for whether a container or process actually exists. Reconciliation updates observed state.

### Preview gateway responsibilities

Caddy routes exact approved hostnames to healthy workspace services. It supports HTTP, WebSockets, and development HMR. Its admin interface is private and available only to the agent. It does not read SQLite or discover containers itself.

### External AI tools

AI coding CLIs run inside the development container through a PTY. They can modify only the mounted workspace and use the tools and services available in that stack. They receive no web session, agent secret, gateway credential, Docker socket, or unrelated host secret.

## 9. Filesystem layout

Recommended host layout:

```text
/srv/devspace/
├── projects/<project-id>/repository.git
└── workspaces/<workspace-id>/source

/var/lib/devspace/
├── database/devspace.sqlite
├── configuration-revisions/
├── generated-runtime-plans/
├── logs/
├── runtime-metadata/
└── secrets/

/var/cache/devspace/
├── image-builds/
└── package-caches/

/run/devspace/
└── agent.sock
```

The dedicated `devspace` Unix account owns these paths. Production deployment directories and unrelated user homes are not readable by that account.

The rootless Docker data directory belongs to the same dedicated account but is not mounted into project containers.

## 10. Preview domains

Global DevSpace settings contain a list of administrator-approved preview domain bases. A project selects one of those bases and defines a validated one-label hostname pattern.

Recommended shared pattern:

```text
<project>-<workspace>-<preview>.preview.example.net
```

Optional project-specific pattern:

```text
<workspace>-<preview>.chess.preview.example.net
```

Each configured base must already have wildcard DNS, Cloudflare Tunnel routing, TLS, and Cloudflare Access protection. DevSpace validates and uses the domain; Cloudflare API automation is outside the MVP.

The control plane and preview applications must not share authentication cookies. A separate registrable preview domain is preferred. When only a dedicated parent domain is available, the web app uses host-only `__Host-` cookies and strict origin validation.

## 11. Security statement

DevSpace is a strong workflow and host-boundary design for trusted owner-controlled code. It is not a hostile-code sandbox.

Primary controls:

- dedicated Unix account;
- rootless Docker daemon separate from Coolify;
- no privileged containers;
- no host Docker socket;
- no arbitrary host mounts;
- one worktree and network namespace per workspace;
- structured Project Options and commands;
- immutable active configuration revisions;
- semantic web-to-agent operations;
- Cloudflare Access at all public ingress;
- private agent and gateway administration;
- process, memory, CPU, disk, and log limits;
- audit events for sensitive actions.

## 12. Non-goals

DevSpace is not initially:

- a browser IDE or VS Code replacement;
- a general Docker/container dashboard;
- a production deployment platform or Coolify replacement;
- a multi-user or multi-tenant system;
- a secure environment for unknown hostile repositories;
- a native AI chat system;
- a generic infrastructure-as-code editor;
- an automatic merge or deployment tool.

## 13. Revised roadmap

### Milestone 0 — Architecture and contracts

- monorepo and documentation scaffold;
- threat model and trust boundaries;
- Project Options v1 schema;
- database schema and lifecycle state machines;
- web/agent contracts and event protocol;
- rootless runtime and preview-gateway deployment design;
- ADRs and CI contract checks.

### Milestone 1 — Project onboarding and primary workspace foundation

- global managed roots and preview-domain registry;
- project registration/import;
- repository metadata inspection;
- Project Options detection and activation;
- managed repository store;
- primary worktree creation;
- primary workspace record and stopped runtime-stack record;
- dashboard showing source, branch, dirty state, configuration revision, and runtime state.

No task execution, terminal, preview, AI session, or supporting service is started yet.

### Milestone 2 — Workspace runtime lifecycle

- dedicated rootless Docker integration;
- runtime plan generation and validation;
- development image build/pull;
- start/stop/rebuild primary workspace stack;
- declared supporting services;
- health and resource state;
- runtime reconciliation.

### Milestone 3 — Predefined tasks and logs

- structured task execution inside the development container;
- process groups, stop/restart, exit status;
- persistent rotated logs;
- task-run summaries and reconciliation.

### Milestone 4 — Browser terminals

- PTY sessions inside the development container;
- xterm.js transport, resize, multiple tabs;
- reconnect while agent remains alive;
- audited elevated arbitrary shell capability.

### Milestone 5 — Dynamic previews

- preview definitions and internal port targets;
- Caddy adapter;
- wildcard hostname generation;
- health checks, HMR, WebSockets, cleanup, and Cloudflare Access validation.

### Milestone 6 — Optional isolated workspaces

- branch and worktree creation;
- one independent stack per workspace;
- dirty-state protection, archive, and removal;
- separate data volumes and previews.

### Milestone 7 — AI terminal sessions

- AI CLI profiles;
- PTY-based start, interrupt, reconnect, and resume;
- workspace scoping and credential injection;
- AI session metadata and audit events.

### Milestone 8 — Git review and publishing

- changed-file and diff views;
- checks summary;
- explicit commit and push flows;
- optional draft pull request creation;
- never auto-merge.

### Milestone 9 — Reliability and polish

- deeper reconciliation;
- stale-resource cleanup;
- backup and restore validation;
- disk and resource reporting;
- notification and mobile monitoring improvements.

A native structured AI interface remains a later milestone after the PTY workflow proves useful.

## 14. Milestone 0 completion criteria

Milestone 0 is complete when:

- every major security and ownership boundary has an ADR;
- Project Options v1 is represented by strict schemas and examples;
- database migrations and lifecycle transitions are specified;
- web/agent requests and events are versioned and fixture-tested;
- no feature task must invent a new authority boundary;
- no repository YAML is required;
- no feature implementation beyond contracts and scaffold has begun.
