# SQLite Data Model v1

All IDs are opaque UUID-compatible text identifiers. Timestamps are UTC ISO-8601 text or integer epoch milliseconds, selected consistently in implementation. Foreign keys are enabled. The web application is the sole writer.

## projects

- `id` primary key
- `name`
- `slug` unique
- `repository_url`
- `repository_store_path` unique
- `default_branch`
- `state`: `registering | ready | invalid | archived`
- `active_config_revision_id` nullable
- `primary_workspace_id` nullable
- `created_at`, `updated_at`, `archived_at`
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
- `created_at`, `activated_at`, `superseded_at`

Constraint: at most one active revision per project.

## workspaces

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
- `created_at`, `updated_at`, `archived_at`, `removed_at`
- `row_version`

Constraint: exactly one non-removed primary workspace per project.

## runtime_stacks

- `id` primary key
- `workspace_id` unique foreign key
- `runtime_namespace` unique
- `runtime_plan_hash`
- `desired_state`: `absent | stopped | running`
- `observed_state`: `absent | creating | stopped | starting | running | stopping | degraded | failed | lost | removing`
- `runtime_generation`
- `created_at`, `updated_at`, `last_observed_at`
- `last_error_code`, `last_error_message`

## workspace_services

- `id` primary key
- `runtime_stack_id` foreign key
- `service_key`
- `kind`: `development | supporting`
- `container_id` nullable
- `image_reference`
- `image_digest` nullable
- `desired_state`
- `observed_state`
- `health_state`: `unknown | starting | healthy | unhealthy`
- `started_at`, `stopped_at`, `last_observed_at`

Unique: `(runtime_stack_id, service_key)`.

## processes

- `id` primary key
- `workspace_id` foreign key
- `service_id` foreign key
- `kind`: `task | terminal | ai | system`
- `definition_key` nullable
- `container_exec_id` nullable
- `process_token` unique
- `process_group_id` nullable
- `desired_state`: `running | stopped`
- `observed_state`: `queued | starting | running | stopping | exited | failed | killed | lost`
- `exit_code` nullable
- `started_at`, `finished_at`, `last_observed_at`
- `log_path` nullable

A process is never stopped based only on a PID. Container identity and a generated process token must match.

## terminal_sessions

- `id` primary key
- `workspace_id` foreign key
- `process_id` unique foreign key
- `title`
- `shell_profile_key`
- `state`: `creating | active | disconnected | closing | closed | failed | lost`
- `created_at`, `last_activity_at`, `closed_at`

## previews

- `id` primary key
- `workspace_id` foreign key
- `service_id` foreign key
- `preview_key`
- `hostname` unique
- `container_port`
- `protocol`
- `health_path`
- `desired_state`: `inactive | active`
- `observed_state`: `inactive | starting | healthy | unhealthy | stopping | failed | lost`
- `route_revision` nullable
- `created_at`, `updated_at`, `activated_at`, `deactivated_at`

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
- `created_at`, `activated_at`, `released_at`, `expires_at`

Partial unique index: one active/reserved lease per `(bind_address, port)`.

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
- `created_at`, `updated_at`, `last_activity_at`, `stopped_at`

## task_runs

- `id` primary key
- `workspace_id` foreign key
- `task_key`
- `process_id` nullable foreign key
- `config_revision_id` foreign key
- `state`: `queued | starting | running | passed | failed | cancelled | timed_out | lost`
- `exit_code` nullable
- `started_at`, `finished_at`
- `summary_json` nullable
- `log_path`

## operations

- `id` primary key
- `idempotency_key` unique
- `actor`
- `operation_type`
- `resource_type`, `resource_id`
- `request_hash`
- `state`: `accepted | running | succeeded | failed | cancelled`
- `progress_json` nullable
- `error_code`, `error_message` nullable
- `created_at`, `started_at`, `finished_at`

## audit_events

- `id` primary key
- `sequence` monotonically increasing
- `actor`
- `event_type`
- `resource_type`, `resource_id`
- `operation_id` nullable foreign key
- `metadata_json` redacted
- `created_at`

Audit events are append-only through the application layer.

## Migration rules

- forward-only migrations in normal operation;
- each migration tested from an empty database and the previous released schema;
- startup refuses to run against a newer unsupported schema;
- backup before destructive migrations;
- no agent-owned migrations.
