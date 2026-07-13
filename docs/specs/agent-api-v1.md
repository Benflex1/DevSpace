# Web ↔ Workspace Agent Contract v1

## Transport

- HTTP-style JSON RPC over `/run/devspace/agent.sock`.
- Event stream over the same private socket.
- Browser clients never access the socket.
- Every request contains `protocolVersion`, `operationId`, and `requestId`.
- Mutations are idempotent by `operationId` plus canonical request hash.

## Authority rule

The web sends user intent and activated configuration revisions. The agent derives host paths, runtime namespaces, container names, network names, process identifiers, ports, and gateway targets.

Rejected browser-derived fields include:

- host path;
- command string;
- Docker/container ID;
- PID;
- bind mount;
- host port;
- gateway upstream;
- Caddy configuration fragment.

## Core endpoints

### Health and capabilities

```text
GET /v1/health
GET /v1/capabilities
GET /v1/runtime/status
```

### Configuration revisions

```text
POST /v1/configuration-revisions/validate
POST /v1/configuration-revisions/register
```

The registration request contains the canonical configuration, compiled runtime plan, hashes, and project ID. The agent validates policy independently and caches the accepted revision by ID/hash.

### Projects and repositories

```text
POST /v1/projects/inspect-source
POST /v1/projects/create-managed-store
POST /v1/projects/fetch
POST /v1/projects/inspect-git
```

Source import is restricted to configured import roots or an approved remote URL. The browser cannot provide a destination path.

### Workspaces

```text
POST /v1/workspaces/create
POST /v1/workspaces/inspect
POST /v1/workspaces/start
POST /v1/workspaces/stop
POST /v1/workspaces/rebuild
POST /v1/workspaces/archive
POST /v1/workspaces/remove
```

Requests identify project, workspace, revision, branch/base ref, and desired action. The agent derives all filesystem and runtime names.

### Tasks and processes

```text
POST /v1/tasks/start
POST /v1/processes/stop
POST /v1/processes/inspect
```

`tasks/start` accepts only workspace ID, activated task key, and a small schema-defined set of task inputs. It never accepts a command.

### Terminals

```text
POST /v1/terminals/create
POST /v1/terminals/close
WS   /v1/terminals/{terminalId}/stream
```

The web creates a short-lived attachment grant bound to the authenticated user and terminal ID. The agent validates the internal grant forwarded by the web.

### Previews

```text
POST /v1/previews/activate
POST /v1/previews/deactivate
POST /v1/previews/inspect
```

The request contains workspace ID and preview key. The agent derives the service, target, port, hostname, and gateway route from the registered revision.

### AI sessions

```text
POST /v1/ai-sessions/start
POST /v1/ai-sessions/interrupt
POST /v1/ai-sessions/stop
POST /v1/ai-sessions/resume
```

Requests reference an approved AI profile key and workspace. No executable or arbitrary arguments are accepted.

### Reconciliation

```text
POST /v1/reconciliation/run
GET  /v1/snapshot
GET  /v1/events?cursor=<cursor>
```

## Event envelope

```json
{
  "protocolVersion": 1,
  "eventId": "evt_...",
  "cursor": "agentBootId:sequence",
  "occurredAt": "2026-07-13T20:00:00.000Z",
  "agentBootId": "boot_...",
  "operationId": "op_...",
  "resource": {
    "type": "workspace",
    "id": "ws_..."
  },
  "type": "workspace.observed-state.changed",
  "payload": {
    "previous": "starting",
    "current": "running"
  }
}
```

## Required event types

- `operation.progressed`
- `operation.succeeded`
- `operation.failed`
- `project.inspected`
- `workspace.observed-state.changed`
- `runtime-stack.observed-state.changed`
- `service.health.changed`
- `process.started`
- `process.output.available`
- `process.exited`
- `terminal.state.changed`
- `preview.state.changed`
- `ai-session.state.changed`
- `reconciliation.completed`

Terminal bytes use a dedicated binary WebSocket frame protocol and are not embedded in domain events.

## Error model

```json
{
  "error": {
    "code": "CONFIGURATION_NOT_REGISTERED",
    "message": "The activated configuration revision is not registered with this agent.",
    "retryable": false,
    "details": {}
  }
}
```

Important codes:

- `PROTOCOL_VERSION_UNSUPPORTED`
- `OPERATION_CONFLICT`
- `CONFIGURATION_INVALID`
- `CONFIGURATION_NOT_REGISTERED`
- `RUNTIME_POLICY_VIOLATION`
- `PROJECT_NOT_FOUND`
- `WORKSPACE_STATE_CONFLICT`
- `DIRTY_WORKSPACE_REQUIRES_ACTION`
- `TASK_NOT_DEFINED`
- `PROCESS_IDENTITY_MISMATCH`
- `PREVIEW_DOMAIN_NOT_APPROVED`
- `GATEWAY_UPDATE_FAILED`
- `ROOTLESS_RUNTIME_UNAVAILABLE`
