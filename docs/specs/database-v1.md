# SQLite Data Model v1

## Storage authority and primitive representations

The web application is the sole SQLite writer. The workspace agent never opens the database, runs migrations, or receives a database dependency. `packages/database` owns schema definitions, forward migrations, and narrowly scoped migration utilities only; future repositories and transactions belong to `apps/web`.

- Every primary and foreign-key ID is `TEXT` containing a canonical lowercase UUIDv7 string. Resource type is stored in its own column and is not encoded in an ID prefix.
- Every timestamp is `TEXT` containing RFC 3339 UTC with exactly millisecond precision, such as `2026-07-14T12:00:00.000Z`.
- Every timestamp is application-supplied. SQLite timestamp defaults, including
  `CURRENT_TIMESTAMP`, are not used because they do not provide the accepted canonical
  millisecond representation.
- Hash columns contain `sha256-jcs-v1:` followed by exactly 64 lowercase hexadecimal characters unless their owning versioned contract introduces a separately named format.
- Foreign keys are enabled for every connection.
- Every foreign key uses `ON UPDATE NO ACTION`; DevSpace identifiers are immutable. The normative
  `ON DELETE` action and relationship classification for every foreign key are defined in the
  foreign-key matrix below.
- Required state, kind, source, and protocol columns use `NOT NULL` plus checks for the closed value sets below.

Registry-backed values such as `actor`, `operation_name`, `event_type`, `resource_type`,
task/service/profile keys, provider keys, error codes, and image references are validated by their
owning runtime schemas rather than frozen as SQL enums.

## JSON storage boundary

JSON values are stored as `TEXT`, must satisfy SQLite `json_valid`, and are validated by an owning versioned runtime schema before every write and after every read. SQLite JSON validity does not replace runtime validation.

- `project_config_revisions.configuration_json` is immutable, default-materialized RFC 8785/JCS Project Options runtime-configuration JSON whose hash matches `configuration_hash`. It does not duplicate project metadata or workspace display names.
- `compiled_runtime_plan_json` and `runtime_plan_hash` remain nullable in Milestone 0. When Milestone 1 supplies them, a versioned runtime-plan schema validates the JSON and hash as one pair.
- `operations.progress_json`, `task_runs.summary_json`, and `audit_events.metadata_json` contain only their strict, versioned, redacted runtime representations. They are not arbitrary extension bags.
- Secret values and raw terminal data are never stored in these JSON columns.

## projects

The project row is the single authoritative storage location for project display name, slug, repository URL, default branch, and automatic fetch policy. These values are edited through the Project Options UI General section but are not configuration-revision JSON.

- `id` primary key
- `name`, authoritative project display name
- `slug` unique, authoritative project slug
- `repository_url`, authoritative repository source URL
- `repository_store_path` unique
- `default_branch`, authoritative default branch
- `automatic_fetch_policy`: `manual | on-start`, `NOT NULL`, default `manual`
- `state`: `registering | ready | invalid | archived`
- `active_config_revision_id` nullable foreign key
- `primary_workspace_id` nullable foreign key
- `created_at` `NOT NULL`
- `updated_at` `NOT NULL`
- `archived_at` nullable
- `row_version`

## project_config_revisions

- `id` primary key
- `project_id` foreign key
- `revision_number` unique per project
- `schema_version`
- `configuration_json`
- `configuration_hash`
- `compiled_runtime_plan_json` nullable
- `runtime_plan_hash` nullable
- `source`: `user | detected | imported`
- `state`: `draft | active | superseded | rejected`
- `created_by`
- `created_at` `NOT NULL`
- `activated_at` nullable
- `superseded_at` nullable

A partial unique index on `project_id WHERE state = 'active'` enforces at most one active revision per project.

## workspaces

`workspaces.name` is the authoritative workspace display name. Project creation may initialize the primary workspace name to `Primary`; it is not stored in every configuration revision.

- `id` primary key
- `project_id` foreign key
- `config_revision_id` foreign key
- `kind`: `primary | isolated`
- `name`, `slug`
- `branch_name`
- `base_ref`
- `worktree_path` unique
- `desired_state`: `stopped | running | archived | removed`
- `observed_state`: `provisioning | stopped | starting | running | stopping | degraded | failed | lost | archived | removed`
- `dirty_state`: `unknown | clean | dirty`
- `created_at` `NOT NULL`
- `updated_at` `NOT NULL`
- `archived_at` nullable
- `removed_at` nullable
- `row_version`

A partial unique index on `project_id WHERE kind = 'primary' AND desired_state <> 'removed'` enforces at most one non-removed primary workspace per project. In this definition, non-removed is based on desired state; an observed row remains the primary while removal is pending unless its desired state has already changed to `removed`.

## runtime_stacks

- `id` primary key
- `workspace_id` unique foreign key
- `runtime_namespace` unique
- `runtime_plan_hash`
- `desired_state`: `absent | stopped | running`
- `observed_state`: `absent | creating | stopped | starting | running | stopping | degraded | failed | lost | removing`
- `runtime_generation`
- `created_at` `NOT NULL`
- `updated_at` `NOT NULL`
- `last_observed_at` nullable
- `last_error_code`, `last_error_message`

## workspace_services

- `id` primary key
- `runtime_stack_id` foreign key
- `service_key`
- `kind`: `development | supporting`
- `container_id` nullable
- `image_reference`
- `image_digest` nullable
- `desired_state`: `absent | stopped | running`
- `observed_state`: `absent | creating | stopped | starting | running | stopping | degraded | failed | lost | removing`
- `health_state`: `unknown | starting | healthy | unhealthy`
- `started_at` nullable
- `stopped_at` nullable
- `last_observed_at` nullable

Unique: `(runtime_stack_id, service_key)`.

## processes

- `id` primary key
- `workspace_id` foreign key
- `service_id` foreign key
- `kind`: `task | terminal | ai | system`
- `definition_key` nullable
- `container_exec_id` nullable
- `desired_state`: `running | stopped`
- `observed_state`: `queued | starting | running | stopping | exited | failed | killed | lost`
- `exit_code` nullable
- `started_at` nullable
- `finished_at` nullable
- `last_observed_at` nullable
- `log_path` nullable

The current database schema stores public process observations only; Agent-private execution records
retain exact workspace/container/exec ownership and operation binding. M1 does not expose or persist
PID, process-group, or process-token ownership for task/terminal termination. Individual task Stop,
terminal Close, timeout enforcement, and exact descendant ownership are deferred to M2; the whole
workspace runtime remains reclaimable through its exact container lifecycle.

## terminal_sessions

- `id` primary key
- `workspace_id` foreign key
- `process_id` unique foreign key
- `title`
- `shell_profile_key`
- `state`: `creating | active | disconnected | closing | closed | failed | lost`
- `created_at` `NOT NULL`
- `last_activity_at` nullable
- `closed_at` nullable

## previews

- `id` primary key
- `workspace_id` foreign key
- `service_id` foreign key
- `preview_key`
- `hostname` unique
- `container_port`
- `protocol`: `http`
- `health_path`
- `desired_state`: `inactive | active`
- `observed_state`: `inactive | starting | healthy | unhealthy | stopping | failed | lost`
- `route_revision` nullable
- `created_at` `NOT NULL`
- `updated_at` `NOT NULL`
- `activated_at` nullable
- `deactivated_at` nullable

Unique: `(workspace_id, preview_key)`.

## port_leases

Port leases are needed only when rootless networking or gateway integration requires a loopback host port. Internal-container-network routing should avoid them where possible.

- `id` primary key
- `workspace_id` foreign key
- `preview_id` nullable foreign key
- `port`
- `bind_address`, fixed to approved loopback addresses
- `state`: `reserved | active | released | stale`
- `lease_token` unique
- `created_at` `NOT NULL`
- `activated_at` nullable
- `released_at` nullable
- `expires_at` `NOT NULL`

A partial unique index on `(bind_address, port) WHERE state IN ('reserved', 'active')` enforces at most one live lease for an address and port.

## ai_sessions

- `id` primary key
- `workspace_id` foreign key
- `terminal_session_id` nullable foreign key
- `process_id` nullable foreign key
- `provider_key`
- `profile_key`
- `external_session_id` nullable
- `title`
- `state`: `creating | active | waiting_for_input | interrupted | stopped | failed | lost`
- `created_at` `NOT NULL`
- `updated_at` `NOT NULL`
- `last_activity_at` nullable
- `stopped_at` nullable

## task_runs

- `id` primary key
- `workspace_id` foreign key
- `task_key`
- `process_id` nullable foreign key
- `config_revision_id` foreign key
- `state`: `queued | starting | running | passed | failed | cancelled | timed_out | lost`
- `exit_code` nullable
- `started_at` nullable
- `finished_at` nullable
- `summary_json` nullable
- `log_path`

## operations

- `operation_id` primary key; this is the caller-generated UUIDv7 sent to the Agent as
  `X-DevSpace-Operation-Id`
- `project_id` required ownership foreign key
- `workspace_id` nullable workspace-context foreign key
- `actor`
- `operation_name`
- `resource_type`, `resource_id`
- `state`: `accepted | running | succeeded | failed | cancelled`
- `progress_json` nullable
- `error_code`, `error_message` nullable
- `created_at` `NOT NULL`
- `started_at` nullable
- `finished_at` nullable

The web creates `operation_id` and inserts this SQLite row before sending a mutating request to the
Agent. That same ID is the sole public idempotency identity and is sent only through
`X-DevSpace-Operation-Id`. There is no second public idempotency key or public request hash.
`operation_name` is the stable F09 mutation operation name. `project_id` makes the row
project-owned; `workspace_id` is nullable because some project operations have no workspace and
because retained project operation history may survive deletion of an individual workspace. The
workspace Agent never creates or writes this row.

This row is the Web control-plane and audit source of truth for operation lifecycle, progress, and
outcome. The Agent's separate narrow durable execution/idempotency journal is not SQLite and is
not a second control-plane database; it exists only to make acceptance, execution, and transport
retries safe. That journal may bind an operation ID to an operation name, complete validated
request, and private deterministic fingerprint. The fingerprint is private Agent implementation
state, is not a protocol value, and is not persisted in this SQLite model. F10 Agent execution
observations describe recoverable Agent state and do not create another SQLite table. Reuse or
replay semantics are defined by the Agent protocol.

## audit_events

- `id` primary key
- `sequence` monotonically increasing and unique
- `actor`
- `event_type`
- `resource_type`, `resource_id`
- `operation_id` nullable foreign key
- `metadata_json` redacted
- `created_at` `NOT NULL`

Audit events are append-only through the application layer. Their database sequence is not an agent event cursor and does not reset with agent boots.

## Foreign-key matrix

This matrix is normative. `RESTRICT` is used consistently for required or protected references:
the referenced row cannot be deleted independently while a surviving child or current pointer
depends on it. `CASCADE` is reserved for strict ownership. `SET NULL` is used only for optional
historical or contextual references whose child is intentionally retained without the referenced
row. Every foreign key uses `ON UPDATE NO ACTION`.

| Child table | Child column | Parent table | Parent column | Nullability | ON DELETE | ON UPDATE | Classification and rationale |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `projects` | `active_config_revision_id` | `project_config_revisions` | `id` | nullable | `RESTRICT` | `NO ACTION` | Protected current-selection pointer. Staged project creation permits null, but a selected immutable revision cannot be deleted independently. |
| `projects` | `primary_workspace_id` | `workspaces` | `id` | nullable | `RESTRICT` | `NO ACTION` | Protected current-primary pointer. Staged project creation permits null, but the selected primary workspace cannot be deleted independently. |
| `project_config_revisions` | `project_id` | `projects` | `id` | required | `CASCADE` | `NO ACTION` | Strict project ownership; a revision has no independent meaning after project deletion. |
| `workspaces` | `project_id` | `projects` | `id` | required | `CASCADE` | `NO ACTION` | Strict project ownership; a workspace has no independent meaning after project deletion. |
| `workspaces` | `config_revision_id` | `project_config_revisions` | `id` | required | `RESTRICT` | `NO ACTION` | Required immutable-revision reference needed to interpret the workspace. |
| `runtime_stacks` | `workspace_id` | `workspaces` | `id` | required | `CASCADE` | `NO ACTION` | Strict workspace runtime ownership. |
| `workspace_services` | `runtime_stack_id` | `runtime_stacks` | `id` | required | `CASCADE` | `NO ACTION` | Strict runtime-stack ownership, and therefore transitively strict workspace ownership. |
| `processes` | `workspace_id` | `workspaces` | `id` | required | `CASCADE` | `NO ACTION` | Strict workspace runtime ownership. |
| `processes` | `service_id` | `workspace_services` | `id` | required | `RESTRICT` | `NO ACTION` | Required execution-context reference; a service cannot be deleted independently while a surviving process refers to it. |
| `terminal_sessions` | `workspace_id` | `workspaces` | `id` | required | `CASCADE` | `NO ACTION` | Strict workspace runtime ownership. |
| `terminal_sessions` | `process_id` | `processes` | `id` | required | `RESTRICT` | `NO ACTION` | Required one-to-one execution reference needed to interpret the terminal session. |
| `previews` | `workspace_id` | `workspaces` | `id` | required | `CASCADE` | `NO ACTION` | Strict workspace runtime ownership. |
| `previews` | `service_id` | `workspace_services` | `id` | required | `RESTRICT` | `NO ACTION` | Required preview target reference; workspace-targeted previews use the workspace development service. |
| `port_leases` | `workspace_id` | `workspaces` | `id` | required | `CASCADE` | `NO ACTION` | Strict workspace runtime ownership. |
| `port_leases` | `preview_id` | `previews` | `id` | nullable | `SET NULL` | `NO ACTION` | Optional preview context; a lease may remain for release or stale-lease cleanup after preview deletion. |
| `ai_sessions` | `workspace_id` | `workspaces` | `id` | required | `CASCADE` | `NO ACTION` | Strict workspace runtime ownership. |
| `ai_sessions` | `terminal_session_id` | `terminal_sessions` | `id` | nullable | `SET NULL` | `NO ACTION` | Optional historical terminal context; the AI-session record may survive terminal deletion. |
| `ai_sessions` | `process_id` | `processes` | `id` | nullable | `SET NULL` | `NO ACTION` | Optional historical process context; the AI-session record may survive process deletion. |
| `task_runs` | `workspace_id` | `workspaces` | `id` | required | `CASCADE` | `NO ACTION` | Strict workspace ownership. |
| `task_runs` | `process_id` | `processes` | `id` | nullable | `SET NULL` | `NO ACTION` | Optional execution context; retained task-run history may survive process deletion. |
| `task_runs` | `config_revision_id` | `project_config_revisions` | `id` | required | `RESTRICT` | `NO ACTION` | Required immutable-revision reference needed to interpret the task run. |
| `operations` | `project_id` | `projects` | `id` | required | `CASCADE` | `NO ACTION` | Strict project ownership of the Web control-plane operation row. |
| `operations` | `workspace_id` | `workspaces` | `id` | nullable | `SET NULL` | `NO ACTION` | Optional workspace context; project operation history may survive deletion of an individual workspace. |
| `audit_events` | `operation_id` | `operations` | `operation_id` | nullable | `SET NULL` | `NO ACTION` | Optional originating-operation context; retained audit history survives operation deletion. |

## At-most-one constraints and eventual exactly-one transactions

SQLite partial indexes provide only these at-most-one guarantees:

- one `active` configuration revision per project;
- one primary workspace whose desired state is not `removed` per project;
- one `reserved` or `active` port lease per address and port.

The future web application enforces the stronger ready-project invariant: every `ready` project has exactly one active revision and exactly one non-removed primary workspace, and both project pointer columns reference them. SQLite cannot require those child rows while also allowing staged project creation.

Project creation therefore uses this order:

1. Insert the project as `registering` with null active-revision and primary-workspace pointers.
2. Insert and validate a draft configuration revision.
3. In one web-owned finalization transaction, activate that revision, create the primary workspace pinned to it, set both project pointers, and transition the project to `ready`.
4. If finalization fails, roll back the complete transaction and leave the project `registering`; a future web workflow may retry or mark it `invalid`.

Later configuration activation is one web-owned transaction that supersedes the former active row, activates the selected draft, and updates `projects.active_config_revision_id`. Existing workspace pins are unchanged. Primary-workspace replacement is likewise a web-owned transaction that preserves at-most-one and cannot commit while a `ready` project has zero non-removed primary workspaces. Removing the primary without a replacement is invalid for a `ready` project.

## Row versions

`projects.row_version` and `workspaces.row_version` are non-negative integers initialized to `1`. A successful logical update increments the value exactly once, regardless of how many columns change. Future web updates use optimistic concurrency by matching both ID and expected row version; a zero-row update is a conflict and is not retried as an unconditional write. This rule specifically governs General Options edits to project name, slug, repository URL, default branch, and automatic fetch policy. Such edits update only the project row, create no configuration revision, and do not automatically rebuild existing workspaces. Inserts start at `1`, rejected/no-op updates do not increment, and append-only or immutable tables do not gain row versions merely for consistency.

## Migration rules

- forward-only migrations in normal operation;
- each migration tested from an empty database and the previous released schema;
- startup refuses to run against a newer unsupported schema;
- backup before destructive migrations;
- no agent-owned migrations;
- migration utilities do not expose general runtime repositories or write APIs.
