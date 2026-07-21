# Threat Model

## Security objective

DevSpace gives trusted owner-controlled projects extensive freedom inside rootless containers while preventing accidental or compromised project behavior from controlling the host, Coolify, production data, or unrelated projects.

DevSpace is not a hostile-code sandbox. Rootless containers reduce impact but do not make arbitrary untrusted code safe.

## Actors

- authenticated owner;
- unauthenticated internet client;
- malicious or compromised preview JavaScript;
- trusted repository containing buggy or compromised dependencies;
- AI coding CLI and remote AI provider;
- DevSpace web process;
- workspace agent;
- rootless Docker daemon;
- Caddy preview gateway;
- Cloudflare Access and Tunnel.

## Trust boundaries

1. Internet to the administrator-selected DNS/TLS/access layer.
2. Browser to DevSpace Web/API.
3. Browser preview origin to control-plane origin.
4. Web/API to agent Unix socket.
5. Agent to dedicated rootless Docker socket.
6. Agent to managed repository and worktree roots.
7. Workspace container to host kernel and mounted worktree.
8. One workspace network/filesystem to another.
9. Outer ingress to the shared preview connector and Caddy data plane.
10. AI CLI to remote provider.

## Filesystem risks

### Risks

- path traversal or absolute-path injection;
- symlink replacement between validation and use;
- worktree path confusion;
- arbitrary bind mounts;
- access to state/secrets/logs;
- Git hooks, filters, or submodules invoking unexpected commands.

### Controls

- all repository stores and worktrees are agent-derived paths under fixed managed roots;
- configured project, workspace, private-state, and journal roots are real directories provisioned
  by the administrator before Agent startup; the Agent never creates these top-level roots;
- the parent directories of configured roots are not writable by workspace containers or project
  processes; only Agent-owned internal children are created after the configured roots are
  canonicalized and device/inode-pinned;
- browser requests contain opaque IDs, never paths;
- reject symlinked managed resources and revalidate canonical paths plus pinned device/inode
  identities immediately before mutation;
- do not permit project-configured host bind mounts;
- mount only the workspace worktree and declared named volumes;
- keep state, secrets, Docker data, and production directories outside container mounts;
- execute Git with controlled environment, disabled interactive prompting, and explicit hook policy;
- do not initialize or update submodules automatically without a separate approved action.

## Command execution risks

### Risks

- shell injection;
- configuration substitution attacks;
- child processes escaping stop operations;
- resource exhaustion;
- task name impersonation.

### Controls

- tasks use executable plus argument arrays;
- no browser-supplied commands, working directories, environment keys, or ports;
- working directories are relative to `/workspace` and validated;
- system values such as preview ports are injected structurally;
- each process receives an opaque ID and exact workspace/container/exec ownership is checked;
- task commands use structured executable/argument arrays and M1 does not attempt individual process
  signaling or descendant sweeping;
- CPU, memory, PID, and disk limits are configurable at the container/runtime layer; task
  `timeoutSeconds`, long-running supervision, replacement, and exact descendant termination are
  deferred execution controls;
- terminal and AI sessions are separately classified and audited as arbitrary shell capability.

## Container/runtime risks

### Risks

- root in a container being confused with host root;
- privileged containers or dangerous capabilities;
- Docker socket exposure;
- host namespace sharing;
- cross-workspace network access;
- malicious image or Dockerfile build behavior.

### Controls

- dedicated rootless Docker daemon under `devspace`;
- never use the host/Coolify Docker socket;
- no `privileged`, host PID, host network, arbitrary devices, or arbitrary host mounts;
- workspace containers never receive any Docker socket;
- one private network and namespaced resources per workspace;
- image and Dockerfile configuration is an activated Project Options revision;
- image build context is restricted to the project source and excludes DevSpace state;
- default Docker seccomp/AppArmor behavior remains enabled;
- use explicit resource limits and maximum stack size.

## Terminal-session risks

### Risks

- WebSocket hijacking;
- cross-workspace attachment;
- terminal output leaking secrets;
- stale sessions being mistaken for live sessions.

### Controls

- Cloudflare Access plus application session and strict Origin checks;
- Web authenticates the browser and authorizes the exact workspace and terminal before proxying a
  stream;
- the Agent trusts only the protected local Web-to-Agent Unix-socket peer, is not a browser
  authentication boundary, and is not directly reachable by untrusted browser clients;
- exactly one active Agent stream attachment is permitted per terminal resource;
- browser never chooses container or exec identifiers;
- output is streamed, bounded, and not indexed globally;
- secret values are redacted where feasible, but terminal output is treated as sensitive;
- sessions become `lost` after agent restart unless positively reattached.

## Git risks

### Risks

- destructive reset/remove operations;
- dirty worktree deletion;
- branch-name injection;
- credential leakage;
- automatic merging or pushing.

### Controls

- strict branch/ref validation and `--` separators;
- explicit confirmation for destructive actions;
- dirty-state gates before archive/remove;
- credentials provided through scoped helpers, never command arguments;
- commit and push are explicit user actions;
- no automatic merge or deployment;
- repository store and worktree ownership verified before every mutation.

## Preview-routing risks

### Risks

- hostname injection;
- routing to arbitrary host services;
- stale routes after process death;
- preview JavaScript attacking the control plane;
- bypassing Cloudflare Access through direct ports.

### Controls

- preview hostname stems must fit an administrator-approved base and exact reserved label suffix;
- gateway ownership requires exactly one label above the configured base and rejects ordinary or
  deeper application subdomains;
- agent derives exact targets from validated workspace service definitions;
- gateway routes only to DevSpace workspace networks/loopback targets;
- no direct public preview port;
- health check must pass before route activation;
- stop/loss immediately removes the route;
- periodic reconciliation removes stale routes;
- control plane and previews use separate origins and cookies;
- one permanent outer-ingress rule forwards only the reserved namespace and preserves `Host`;
- the connector is byte-transparent, isolated from host networking, and mounts only the ingress
  socket directory; private control and Docker sockets are not reachable from it;
- the current production Web authentication layer remains Cloudflare Access, while preview ingress
  itself is provider-neutral.

## AI-session risks

### Risks

- AI edits unintended files;
- AI runs destructive commands;
- source or secrets leave the host through the provider;
- provider credentials leak to other projects;
- AI output proposes unsafe Project Options changes.

### Controls

- AI CLI runs inside exactly one workspace container;
- only that worktree and declared volumes are mounted;
- AI provider credentials are injected only into the AI process/profile that needs them;
- secrets are never included in generic environment dumps or audit payloads;
- remote-provider disclosure is an accepted consequence of using that provider and is shown in settings;
- AI may propose configuration changes but cannot activate Project Options revisions;
- destructive Git/publish actions remain explicit user operations.

## Authentication risks

### Controls

- Cloudflare Access is mandatory for control and preview hostnames;
- origin validates Access JWTs rather than trusting arbitrary incoming headers;
- no public origin ports outside the Tunnel path;
- host-only secure cookies, CSRF tokens, and strict WebSocket Origin checks;
- web-to-agent Unix socket permissions restrict access to the DevSpace deployment identity;
- agent-to-gateway administration uses a private endpoint and dedicated credential;
- every mutating action records the Access identity, operation ID, and affected resource.

## Residual risks

- a kernel or container-runtime vulnerability may escape rootless isolation;
- trusted dependencies may exfiltrate repository data over the network;
- rootless resource-limit support depends on host configuration;
- terminal users can intentionally run destructive commands inside their workspace;
- an AI provider receives content sent by its CLI.
- a privileged or same-deployment-identity hostile host process that can concurrently replace
  administrator-controlled root directories is outside the single-user trusted-host boundary.

These risks are accepted for the single-user trusted-repository product boundary and must be documented in the UI and deployment guide.
