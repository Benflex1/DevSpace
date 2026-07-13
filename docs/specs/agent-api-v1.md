# Web to Workspace Agent Contract v1

## Scope and authority

This document defines a transport contract only. It does not implement an HTTP client, server, operation handler, terminal relay, or reconciliation loop.

The browser talks only to the web application. The web application is the sole client of the private agent socket. The web sends user intent and activated configuration references; the agent derives host paths, runtime namespaces, container names, network names, process identities, ports, and gateway targets.

## Transport and endpoint semantics

The protocol is REST-style HTTP/1.1 plus JSON over the Unix domain socket `/run/devspace/agent.sock`. It is not JSON-RPC. The protocol major version is part of every route under `/v1`.

- `GET` is read-only and safe to retry. It never creates an operation.
- A `POST` carries a structured validation, inspection, command-resource, or requested-state payload. A mutating `POST` accepts or replays the web-created operation identified in its headers and returns `202 Accepted` unless the operation completed synchronously, in which case it may return `200 OK`.
- Endpoints explicitly described as validation or inspection are non-mutating `POST` requests and return `200 OK`; they do not create operations and do not accept idempotency keys.
- There are no generic command, path, or shell endpoints.

JSON requests and ordinary JSON responses use `Content-Type: application/json; charset=utf-8`. A client sends `Accept: application/json`. `GET /v1/events` uses `application/x-ndjson; charset=utf-8` after its initial HTTP success response. Terminal streams use the separately defined WebSocket binary framing and are not JSON event payloads.

Unknown `/v1` routes return `404`. An unsupported major path such as `/v2` returns `426 Upgrade Required` with `PROTOCOL_VERSION_UNSUPPORTED` when the agent can form a v1 error envelope. A missing or non-`1` protocol-version header on a known v1 route returns the same code and error with HTTP `400` for missing/malformed metadata or `426` for a syntactically valid but unsupported value. The agent does not attempt best-effort interpretation.

## Common metadata and envelopes

Every request carries this common metadata in HTTP headers, including bodyless `GET` requests:

```text
X-DevSpace-Protocol-Version: 1
X-DevSpace-Request-Id: <UUIDv7>
X-DevSpace-Sent-At: <RFC 3339 UTC millisecond timestamp>
```

Every JSON request body is a strict object containing only endpoint data:

```json
{
  "data": {}
}
```

`requestId` is unique per attempt. It correlates logs and responses but has no idempotency meaning. `sentAt` is informational and does not override server ordering or authorization. The response `meta.requestId` echoes `X-DevSpace-Request-Id`.

Every ordinary success response is:

```json
{
  "meta": {
    "protocolVersion": 1,
    "requestId": "018f4f5c-6a2b-7c90-8d31-6f2b35d75a10",
    "respondedAt": "2026-07-14T12:00:00.015Z"
  },
  "data": {}
}
```

A mutating response includes `data.operationId`, echoing the web-created operation ID, and the current operation representation. A non-mutating response has no operation ID unless the queried resource itself contains one.

Every ordinary error response uses the same `meta` and replaces `data` with one strict `error` object:

```json
{
  "meta": {
    "protocolVersion": 1,
    "requestId": "018f4f5c-6a2b-7c90-8d31-6f2b35d75a10",
    "respondedAt": "2026-07-14T12:00:00.015Z"
  },
  "error": {
    "code": "CONFIGURATION_NOT_REGISTERED",
    "message": "The activated configuration revision is not registered with this agent.",
    "retryable": false,
    "details": {}
  }
}
```

Success envelopes never contain `error`; error envelopes never contain `data`. Error `details` is a code-specific strict redacted object and never includes secrets, terminal bytes, arbitrary host paths, or raw command text. HTTP status communicates the transport class; `error.code` communicates the stable domain reason.

The common HTTP mapping is `400` for malformed input or metadata, `404` for an absent permitted resource, `409` for lifecycle/idempotency/cursor conflicts, `422` for a structurally valid request rejected by configuration or runtime policy, `426` for an unsupported protocol version, `500` for an unexpected agent failure, and `503` for an unavailable required runtime dependency. A declared endpoint or error code may narrow this mapping but cannot return a success envelope with a non-2xx status.

The event endpoint is the sole envelope exception: errors produced before streaming use the ordinary JSON error envelope; a successful `200` response consists of NDJSON event lines rather than a success envelope. Failure after streaming starts closes the connection, and the web reconnects with its last fully processed cursor.

## Primitive representations

- Every ID, including request, operation, event, agent boot, project, workspace, and resource IDs, is a canonical lowercase UUIDv7 string. Type is represented separately and no ID prefix is permitted.
- Every timestamp is RFC 3339 UTC with exactly millisecond precision, for example `2026-07-14T12:00:00.000Z`.
- Resource references are `{ "type": string, "id": UUIDv7 }` and are accepted only where the endpoint schema permits that resource type.
- Protocol objects are strict. Unknown keys are invalid unless a field is explicitly declared as an extension map.

## Mutation idempotency and request hashes

Every mutating `POST` requires:

- `X-DevSpace-Operation-Id: <UUIDv7>`, created by the web before the request;
- `Idempotency-Key: <UUIDv7>`, generated by the web for one logical operation;
- `X-DevSpace-Request-Hash: sha256-jcs-v1:<digest>`.

The request hash is computed after request-schema validation and explicit default materialization. The hashed JSON value is `{ "protocolVersion": 1, "method": <uppercase method>, "path": <canonical route without query>, "data": <normalized data> }`. Request metadata, authorization material, the idempotency key, timestamps, and transport headers are excluded. The UTF-8 prefix `devspace/agent-request/v1`, a zero byte, and the RFC 8785/JCS bytes of that value form the SHA-256 input. The digest is exactly 64 lowercase hexadecimal characters.

Before sending the request, the web creates the UUIDv7 operation ID and inserts the SQLite operation row. The agent never creates or writes that row. The web-owned row remains the control-plane and audit source of truth.

The agent maintains a narrow durable execution/idempotency journal in agent runtime state outside SQLite. This is not a general second database. Its concrete storage implementation belongs to a later milestone. For each accepted mutation it records at least the operation ID, idempotency key, request hash, accepted state, and replayable result metadata. The acceptance record must be durable before any side effect begins.

For the operation's retention period:

- the same operation ID, idempotency key, and request hash returns the existing accepted/current/result response without repeating effects;
- reuse with any conflicting operation ID, idempotency key, or request hash returns HTTP `409` and `OPERATION_CONFLICT`;
- reuse after the documented retention period is rejected as `IDEMPOTENCY_KEY_EXPIRED`; it never silently creates a second operation with the old key.

Validation failures before operation acceptance do not create an agent acceptance record, although the already-created web operation row remains web-owned and must record the rejected outcome. Once accepted, terminal success or failure remains replayable for the retention period. If the journal is unavailable or detected as corrupt, the agent rejects new mutations with HTTP `503` and `OPERATION_JOURNAL_UNAVAILABLE`; reconciliation or recovery is required before mutation acceptance resumes, rather than risking duplicate execution.

## Authority rule

Rejected browser-derived fields include host paths, command strings, Docker/container IDs, PIDs, bind mounts, host ports, gateway upstreams, and Caddy configuration fragments.

Task requests accept only workspace ID, activated task key, and schema-defined task inputs. Preview requests accept workspace ID and preview key. AI requests accept workspace ID and an approved profile key. No endpoint accepts an executable or arbitrary arguments from the browser.

## Endpoint registry

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

Validation is non-mutating. Registration is mutating and contains canonical configuration, compiled runtime plan, their hashes, revision ID, and project ID. Runtime-plan compilation remains outside Milestone 0; the field is a later producer's versioned input. The agent independently validates policy and registers the accepted ID/hash pair.

### Projects and repositories

```text
POST /v1/projects/inspect-source
POST /v1/projects/create-managed-store
POST /v1/projects/fetch
POST /v1/projects/inspect-git
```

Source import is restricted to configured import roots or an approved remote URL. The caller cannot provide a destination path.

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

Inspect is non-mutating. Other requests identify the project, workspace, revision, branch/base ref, and desired action; the agent derives filesystem and runtime names.

### Tasks and processes

```text
POST /v1/tasks/start
POST /v1/processes/stop
POST /v1/processes/inspect
```

Process inspect is non-mutating. Process stop requires the resource ID; the agent verifies its retained container identity and process token.

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

Preview inspect is non-mutating. The agent derives the service, target, port, hostname, and route from the registered revision.

### AI sessions

```text
POST /v1/ai-sessions/start
POST /v1/ai-sessions/interrupt
POST /v1/ai-sessions/stop
POST /v1/ai-sessions/resume
```

### Reconciliation and events

```text
POST /v1/reconciliation/run
GET  /v1/snapshot
GET  /v1/events?cursor=<cursor>
```

## Event stream and cursor grammar

On every agent start, the agent creates a new UUIDv7 `agentBootId`; event sequences begin at `1`. Every event sequence is a positive unsigned decimal integer without leading zeroes and increases by exactly one for every emitted event in that boot stream. No event may have sequence `0`. Event order is the sequence order, including events not associated with an operation.

A cursor has this exact ASCII grammar:

```text
v1.<lowercase UUIDv7 agentBootId>.<sequence>
```

The cursor sequence component has exact ASCII grammar `0|[1-9][0-9]*`. Sequence `0` is a cursor boundary only. A snapshot taken before the first event in the current boot stream may return `throughCursor` with sequence `0`. Subscribing from that zero cursor replays every retained event beginning with sequence `1`; no emitted event itself can use sequence `0`.

The cursor on an event identifies that event. `GET /v1/events?cursor=c` replays retained events with sequence greater than `c`, then remains open for new events. The cursor is required. A missing or malformed cursor returns HTTP `400` with `EVENT_CURSOR_INVALID`; after a snapshot, the client supplies the snapshot's `throughCursor`.

Each NDJSON line is one strict event:

```json
{
  "protocolVersion": 1,
  "eventId": "018f4f5c-6a2b-7c90-8d31-6f2b35d75a11",
  "agentBootId": "018f4f5c-6a2b-7c90-8d31-6f2b35d75a12",
  "sequence": 42,
  "cursor": "v1.018f4f5c-6a2b-7c90-8d31-6f2b35d75a12.42",
  "occurredAt": "2026-07-14T12:00:00.000Z",
  "operationId": null,
  "resource": {
    "type": "workspace",
    "id": "018f4f5c-6a2b-7c90-8d31-6f2b35d75a13"
  },
  "type": "workspace.observed-state.changed",
  "payload": {
    "previous": "starting",
    "current": "running"
  }
}
```

`operationId` is nullable. Observation, health, process-output-availability, and reconciliation events can be emitted without an operation. `resource` is nullable only for agent-wide events whose event schema declares no resource. Absence of an operation never relaxes resource authorization or event ordering.

### Same-boot replay and snapshot-required recovery

Replay succeeds only when the cursor boot ID equals the current boot ID and every emitted sequence after the cursor remains retained. This includes a current-boot zero cursor when all events beginning with sequence `1` remain available. If the boot ID differs, the cursor predates retention, or any required history is unavailable, the agent returns HTTP `409` with `EVENT_SNAPSHOT_REQUIRED`. Error details contain `reason` (`boot_mismatch`, `cursor_expired`, or `history_unavailable`), `currentAgentBootId`, and `snapshotPath: "/v1/snapshot"`.

`GET /v1/snapshot` returns a self-consistent snapshot of all resources visible to the web plus `agentBootId` and a `throughCursor`. The snapshot includes state through that cursor. The client replaces its agent-observed resource view with the snapshot and subscribes with `GET /v1/events?cursor=<throughCursor>`; events after the snapshot cursor are replayed, so the handoff has no intentional gap. If that cursor becomes unavailable before subscription, the client repeats the snapshot flow.

Cursors are agent-observation cursors, not audit-event database sequences, and are not valid across boot streams.

## Required event types

- `operation.progressed`
- `operation.succeeded`
- `operation.failed`
- `operation.cancelled`
- `project.inspected`
- `workspace.observed-state.changed`
- `runtime-stack.observed-state.changed`
- `service.observed-state.changed`
- `service.health.changed`
- `process.started`
- `process.output.available`
- `process.exited`
- `terminal.state.changed`
- `preview.state.changed`
- `ai-session.state.changed`
- `reconciliation.completed`

Terminal input/output bytes and resize/control frames remain exclusively in the terminal WebSocket binary protocol. Domain-event JSON may announce availability or state but never embeds terminal bytes. The same rule applies to raw interactive AI terminal data.

## Error codes

The v1 registry includes:

- `PROTOCOL_VERSION_UNSUPPORTED`
- `OPERATION_CONFLICT`
- `OPERATION_JOURNAL_UNAVAILABLE`
- `IDEMPOTENCY_KEY_EXPIRED`
- `EVENT_SNAPSHOT_REQUIRED`
- `EVENT_CURSOR_INVALID`
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
