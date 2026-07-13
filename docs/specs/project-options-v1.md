# Project Options v1

## Principle

Project Options are edited through the DevSpace UI and stored as immutable SQLite revisions. No `.devspace.yml` is required.

A repository detector may populate a draft, but only an authenticated user can activate it. Active revisions are immutable. Existing workspaces stay pinned to their revision until explicitly rebuilt or migrated.

## Sections

### General

- project display name and slug;
- repository URL;
- default branch;
- primary-workspace display name;
- automatic fetch policy.

### Development environment

Supported environment sources:

- DevSpace preset plus runtime version;
- OCI base image;
- repository Dockerfile path and context.

Options include:

- default container user;
- passwordless sudo;
- container working directory, fixed to `/workspace` initially;
- setup steps;
- named cache volumes;
- rebuild policy.

Project Options may not define arbitrary host mounts, Docker sockets, privileged mode, host networking, host PID mode, or host devices.

### Commands

Commands use this structure:

```json
{
  "executable": "pnpm",
  "args": ["test"],
  "workingDirectory": ".",
  "environment": {
    "CI": { "kind": "literal", "value": "true" }
  }
}
```

No shell is implied. A future explicit shell-command mode would require a separate capability and warning; it is excluded from v1.

### Setup steps

Setup steps are ordered commands run only when requested during environment creation/rebuild. They are not silently re-run on every start.

### Tasks

Each task has:

- stable key;
- display name;
- command;
- interactive flag;
- long-running flag;
- timeout and concurrency policy;
- success exit codes;
- optional log-retention override.

### Supporting services

A service has:

- stable key;
- OCI image reference;
- internal environment bindings;
- named volumes;
- internal ports;
- health check;
- CPU/memory limits;
- startup dependency policy.

Services are internal to the workspace network unless selected as a preview target. They cannot publish arbitrary host ports.

### Previews

A preview has:

- stable key and display name;
- target service (`workspace` or a declared supporting service);
- container port;
- protocol (`http` initially);
- health path/status/startup timeout;
- approved domain-base ID;
- one-label hostname pattern using only `{project}`, `{workspace}`, `{preview}`, and `{shortId}`;
- WebSocket/HMR forwarding enabled by default.

Example generated host:

```text
chess-primary-web-a42f.preview.example.net
```

### Environment variables and secrets

Bindings are typed:

- literal value;
- host-provided safe variable from an administrator allowlist;
- secret reference;
- DevSpace-generated value;
- service connection value.

Secret values are not stored in configuration JSON or returned to the browser after entry. The configuration stores only a secret ID.

### AI profile

The initial AI profile identifies:

- provider key;
- executable profile installed in the workspace image;
- permitted fixed arguments;
- credential references;
- instructions-file path relative to the worktree;
- network disclosure warning.

The browser does not define the AI command.

### Resources and cleanup

- CPU quota;
- memory and PID limits;
- maximum named-volume size policy where supported;
- log retention;
- stopped-workspace retention;
- automatic stop policy;
- maximum concurrent workspaces.

## Revision lifecycle

```text
draft → active → superseded
   └──────────→ rejected
```

Only one active revision exists per project. Activating a revision supersedes the former active revision but does not rewrite existing workspace pins.

## Portability

A future Export action produces canonical JSON matching `schemas/project-options-v1.schema.json`. Import always creates a draft and requires review. Repository contents never auto-activate imported configuration.
