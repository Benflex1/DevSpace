CREATE TABLE `ai_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`terminal_session_id` text,
	`process_id` text,
	`provider_key` text NOT NULL,
	`profile_key` text NOT NULL,
	`external_session_id` text,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_activity_at` text,
	`stopped_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`terminal_session_id`) REFERENCES `terminal_sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`process_id`) REFERENCES `processes`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ai_sessions_id_uuid_v7_check" CHECK(length("ai_sessions"."id") = 36 and "ai_sessions"."id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "ai_sessions_workspace_id_uuid_v7_check" CHECK(length("ai_sessions"."workspace_id") = 36 and "ai_sessions"."workspace_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "ai_sessions_terminal_session_id_uuid_v7_check" CHECK("ai_sessions"."terminal_session_id" is null or (length("ai_sessions"."terminal_session_id") = 36 and "ai_sessions"."terminal_session_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
	CONSTRAINT "ai_sessions_process_id_uuid_v7_check" CHECK("ai_sessions"."process_id" is null or (length("ai_sessions"."process_id") = 36 and "ai_sessions"."process_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
	CONSTRAINT "ai_sessions_state_check" CHECK("ai_sessions"."state" in ('creating', 'active', 'waiting_for_input', 'interrupted', 'stopped', 'failed', 'lost')),
	CONSTRAINT "ai_sessions_created_at_timestamp_check" CHECK(
    length("ai_sessions"."created_at") = 24
    and "ai_sessions"."created_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "ai_sessions_updated_at_timestamp_check" CHECK(
    length("ai_sessions"."updated_at") = 24
    and "ai_sessions"."updated_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "ai_sessions_last_activity_at_timestamp_check" CHECK("ai_sessions"."last_activity_at" is null or (
    length("ai_sessions"."last_activity_at") = 24
    and "ai_sessions"."last_activity_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )),
	CONSTRAINT "ai_sessions_stopped_at_timestamp_check" CHECK("ai_sessions"."stopped_at" is null or (
    length("ai_sessions"."stopped_at") = 24
    and "ai_sessions"."stopped_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ))
);
--> statement-breakpoint
CREATE INDEX `ai_sessions_workspace_id_idx` ON `ai_sessions` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `ai_sessions_terminal_session_id_idx` ON `ai_sessions` (`terminal_session_id`);--> statement-breakpoint
CREATE INDEX `ai_sessions_process_id_idx` ON `ai_sessions` (`process_id`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`sequence` integer NOT NULL,
	`actor` text NOT NULL,
	`event_type` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`operation_id` text,
	`metadata_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`operation_id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "audit_events_id_uuid_v7_check" CHECK(length("audit_events"."id") = 36 and "audit_events"."id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "audit_events_resource_id_uuid_v7_check" CHECK(length("audit_events"."resource_id") = 36 and "audit_events"."resource_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "audit_events_operation_id_uuid_v7_check" CHECK("audit_events"."operation_id" is null or (length("audit_events"."operation_id") = 36 and "audit_events"."operation_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
	CONSTRAINT "audit_events_sequence_check" CHECK("audit_events"."sequence" >= 0),
	CONSTRAINT "audit_events_metadata_json_check" CHECK(json_valid("audit_events"."metadata_json")),
	CONSTRAINT "audit_events_created_at_timestamp_check" CHECK(
    length("audit_events"."created_at") = 24
    and "audit_events"."created_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_events_sequence_unique` ON `audit_events` (`sequence`);--> statement-breakpoint
CREATE INDEX `audit_events_operation_id_idx` ON `audit_events` (`operation_id`);--> statement-breakpoint
CREATE TABLE `operations` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`workspace_id` text,
	`actor` text NOT NULL,
	`operation_name` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`state` text NOT NULL,
	`progress_json` text,
	`error_code` text,
	`error_message` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "operations_operation_id_uuid_v7_check" CHECK(length("operations"."operation_id") = 36 and "operations"."operation_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "operations_project_id_uuid_v7_check" CHECK(length("operations"."project_id") = 36 and "operations"."project_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "operations_workspace_id_uuid_v7_check" CHECK("operations"."workspace_id" is null or (length("operations"."workspace_id") = 36 and "operations"."workspace_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
	CONSTRAINT "operations_resource_id_uuid_v7_check" CHECK(length("operations"."resource_id") = 36 and "operations"."resource_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "operations_state_check" CHECK("operations"."state" in ('accepted', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "operations_progress_json_check" CHECK("operations"."progress_json" is null or json_valid("operations"."progress_json")),
	CONSTRAINT "operations_created_at_timestamp_check" CHECK(
    length("operations"."created_at") = 24
    and "operations"."created_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "operations_started_at_timestamp_check" CHECK("operations"."started_at" is null or (
    length("operations"."started_at") = 24
    and "operations"."started_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )),
	CONSTRAINT "operations_finished_at_timestamp_check" CHECK("operations"."finished_at" is null or (
    length("operations"."finished_at") = 24
    and "operations"."finished_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ))
);
--> statement-breakpoint
CREATE INDEX `operations_project_id_idx` ON `operations` (`project_id`);--> statement-breakpoint
CREATE INDEX `operations_workspace_id_idx` ON `operations` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `port_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`preview_id` text,
	`port` integer NOT NULL,
	`bind_address` text NOT NULL,
	`state` text NOT NULL,
	`lease_token` text NOT NULL,
	`created_at` text NOT NULL,
	`activated_at` text,
	`released_at` text,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`preview_id`) REFERENCES `previews`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "port_leases_id_uuid_v7_check" CHECK(length("port_leases"."id") = 36 and "port_leases"."id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "port_leases_workspace_id_uuid_v7_check" CHECK(length("port_leases"."workspace_id") = 36 and "port_leases"."workspace_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "port_leases_preview_id_uuid_v7_check" CHECK("port_leases"."preview_id" is null or (length("port_leases"."preview_id") = 36 and "port_leases"."preview_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
	CONSTRAINT "port_leases_port_check" CHECK("port_leases"."port" between 1 and 65535),
	CONSTRAINT "port_leases_bind_address_check" CHECK("port_leases"."bind_address" in ('127.0.0.1', '::1')),
	CONSTRAINT "port_leases_state_check" CHECK("port_leases"."state" in ('reserved', 'active', 'released', 'stale')),
	CONSTRAINT "port_leases_created_at_timestamp_check" CHECK(
    length("port_leases"."created_at") = 24
    and "port_leases"."created_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "port_leases_activated_at_timestamp_check" CHECK("port_leases"."activated_at" is null or (
    length("port_leases"."activated_at") = 24
    and "port_leases"."activated_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )),
	CONSTRAINT "port_leases_released_at_timestamp_check" CHECK("port_leases"."released_at" is null or (
    length("port_leases"."released_at") = 24
    and "port_leases"."released_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )),
	CONSTRAINT "port_leases_expires_at_timestamp_check" CHECK(
    length("port_leases"."expires_at") = 24
    and "port_leases"."expires_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `port_leases_lease_token_unique` ON `port_leases` (`lease_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `port_leases_one_live_address_port` ON `port_leases` (`bind_address`,`port`) WHERE "port_leases"."state" in ('reserved', 'active');--> statement-breakpoint
CREATE INDEX `port_leases_workspace_id_idx` ON `port_leases` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `port_leases_preview_id_idx` ON `port_leases` (`preview_id`);--> statement-breakpoint
CREATE TABLE `previews` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`service_id` text NOT NULL,
	`preview_key` text NOT NULL,
	`hostname` text NOT NULL,
	`container_port` integer NOT NULL,
	`protocol` text NOT NULL,
	`health_path` text NOT NULL,
	`desired_state` text NOT NULL,
	`observed_state` text NOT NULL,
	`route_revision` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`activated_at` text,
	`deactivated_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `workspace_services`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "previews_id_uuid_v7_check" CHECK(length("previews"."id") = 36 and "previews"."id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "previews_workspace_id_uuid_v7_check" CHECK(length("previews"."workspace_id") = 36 and "previews"."workspace_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "previews_service_id_uuid_v7_check" CHECK(length("previews"."service_id") = 36 and "previews"."service_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "previews_container_port_check" CHECK("previews"."container_port" between 1 and 65535),
	CONSTRAINT "previews_protocol_check" CHECK("previews"."protocol" in ('http')),
	CONSTRAINT "previews_desired_state_check" CHECK("previews"."desired_state" in ('inactive', 'active')),
	CONSTRAINT "previews_observed_state_check" CHECK("previews"."observed_state" in ('inactive', 'starting', 'healthy', 'unhealthy', 'stopping', 'failed', 'lost')),
	CONSTRAINT "previews_route_revision_check" CHECK("previews"."route_revision" is null or "previews"."route_revision" >= 0),
	CONSTRAINT "previews_created_at_timestamp_check" CHECK(
    length("previews"."created_at") = 24
    and "previews"."created_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "previews_updated_at_timestamp_check" CHECK(
    length("previews"."updated_at") = 24
    and "previews"."updated_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "previews_activated_at_timestamp_check" CHECK("previews"."activated_at" is null or (
    length("previews"."activated_at") = 24
    and "previews"."activated_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )),
	CONSTRAINT "previews_deactivated_at_timestamp_check" CHECK("previews"."deactivated_at" is null or (
    length("previews"."deactivated_at") = 24
    and "previews"."deactivated_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `previews_hostname_unique` ON `previews` (`hostname`);--> statement-breakpoint
CREATE INDEX `previews_service_id_idx` ON `previews` (`service_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `previews_workspace_preview_key_unique` ON `previews` (`workspace_id`,`preview_key`);--> statement-breakpoint
CREATE TABLE `processes` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`service_id` text NOT NULL,
	`kind` text NOT NULL,
	`definition_key` text,
	`container_exec_id` text,
	`process_token` text NOT NULL,
	`process_group_id` text,
	`desired_state` text NOT NULL,
	`observed_state` text NOT NULL,
	`exit_code` integer,
	`started_at` text,
	`finished_at` text,
	`last_observed_at` text,
	`log_path` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `workspace_services`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "processes_id_uuid_v7_check" CHECK(length("processes"."id") = 36 and "processes"."id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "processes_workspace_id_uuid_v7_check" CHECK(length("processes"."workspace_id") = 36 and "processes"."workspace_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "processes_service_id_uuid_v7_check" CHECK(length("processes"."service_id") = 36 and "processes"."service_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "processes_kind_check" CHECK("processes"."kind" in ('task', 'terminal', 'ai', 'system')),
	CONSTRAINT "processes_desired_state_check" CHECK("processes"."desired_state" in ('running', 'stopped')),
	CONSTRAINT "processes_observed_state_check" CHECK("processes"."observed_state" in ('queued', 'starting', 'running', 'stopping', 'exited', 'failed', 'killed', 'lost')),
	CONSTRAINT "processes_started_at_timestamp_check" CHECK("processes"."started_at" is null or (
    length("processes"."started_at") = 24
    and "processes"."started_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )),
	CONSTRAINT "processes_finished_at_timestamp_check" CHECK("processes"."finished_at" is null or (
    length("processes"."finished_at") = 24
    and "processes"."finished_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )),
	CONSTRAINT "processes_last_observed_at_timestamp_check" CHECK("processes"."last_observed_at" is null or (
    length("processes"."last_observed_at") = 24
    and "processes"."last_observed_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `processes_process_token_unique` ON `processes` (`process_token`);--> statement-breakpoint
CREATE INDEX `processes_workspace_id_idx` ON `processes` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `processes_service_id_idx` ON `processes` (`service_id`);--> statement-breakpoint
CREATE TABLE `project_config_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`revision_number` integer NOT NULL,
	`schema_version` integer NOT NULL,
	`configuration_json` text NOT NULL,
	`configuration_hash` text NOT NULL,
	`compiled_runtime_plan_json` text,
	`runtime_plan_hash` text,
	`source` text NOT NULL,
	`state` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`activated_at` text,
	`superseded_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "project_config_revisions_id_uuid_v7_check" CHECK(length("project_config_revisions"."id") = 36 and "project_config_revisions"."id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "project_config_revisions_project_id_uuid_v7_check" CHECK(length("project_config_revisions"."project_id") = 36 and "project_config_revisions"."project_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "project_config_revisions_revision_number_check" CHECK("project_config_revisions"."revision_number" >= 1),
	CONSTRAINT "project_config_revisions_schema_version_check" CHECK("project_config_revisions"."schema_version" >= 1),
	CONSTRAINT "project_config_revisions_configuration_json_check" CHECK(json_valid("project_config_revisions"."configuration_json")),
	CONSTRAINT "project_config_revisions_configuration_hash_check" CHECK(
    length("project_config_revisions"."configuration_hash") = 78
    and substr("project_config_revisions"."configuration_hash", 1, 14) = 'sha256-jcs-v1:'
    and substr("project_config_revisions"."configuration_hash", 15) not glob '*[^0-9a-f]*'
  ),
	CONSTRAINT "project_config_revisions_compiled_runtime_plan_json_check" CHECK("project_config_revisions"."compiled_runtime_plan_json" is null or json_valid("project_config_revisions"."compiled_runtime_plan_json")),
	CONSTRAINT "project_config_revisions_runtime_plan_hash_check" CHECK("project_config_revisions"."runtime_plan_hash" is null or (
    length("project_config_revisions"."runtime_plan_hash") = 78
    and substr("project_config_revisions"."runtime_plan_hash", 1, 14) = 'sha256-jcs-v1:'
    and substr("project_config_revisions"."runtime_plan_hash", 15) not glob '*[^0-9a-f]*'
  )),
	CONSTRAINT "project_config_revisions_runtime_plan_pair_check" CHECK(
    ("project_config_revisions"."compiled_runtime_plan_json" is null and "project_config_revisions"."runtime_plan_hash" is null)
    or ("project_config_revisions"."compiled_runtime_plan_json" is not null and "project_config_revisions"."runtime_plan_hash" is not null)
  ),
	CONSTRAINT "project_config_revisions_source_check" CHECK("project_config_revisions"."source" in ('user', 'detected', 'imported')),
	CONSTRAINT "project_config_revisions_state_check" CHECK("project_config_revisions"."state" in ('draft', 'active', 'rejected', 'superseded')),
	CONSTRAINT "project_config_revisions_created_at_timestamp_check" CHECK(
    length("project_config_revisions"."created_at") = 24
    and "project_config_revisions"."created_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "project_config_revisions_activated_at_timestamp_check" CHECK("project_config_revisions"."activated_at" is null or (
    length("project_config_revisions"."activated_at") = 24
    and "project_config_revisions"."activated_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )),
	CONSTRAINT "project_config_revisions_superseded_at_timestamp_check" CHECK("project_config_revisions"."superseded_at" is null or (
    length("project_config_revisions"."superseded_at") = 24
    and "project_config_revisions"."superseded_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_config_revisions_one_active_per_project` ON `project_config_revisions` (`project_id`) WHERE "project_config_revisions"."state" = 'active';--> statement-breakpoint
CREATE INDEX `project_config_revisions_project_id_idx` ON `project_config_revisions` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_config_revisions_project_revision_unique` ON `project_config_revisions` (`project_id`,`revision_number`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`repository_url` text NOT NULL,
	`repository_store_path` text NOT NULL,
	`default_branch` text NOT NULL,
	`automatic_fetch_policy` text DEFAULT 'manual' NOT NULL,
	`state` text NOT NULL,
	`active_config_revision_id` text,
	`primary_workspace_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text,
	`row_version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`active_config_revision_id`) REFERENCES `project_config_revisions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`primary_workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "projects_id_uuid_v7_check" CHECK(length("projects"."id") = 36 and "projects"."id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "projects_active_config_revision_id_uuid_v7_check" CHECK("projects"."active_config_revision_id" is null or (length("projects"."active_config_revision_id") = 36 and "projects"."active_config_revision_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
	CONSTRAINT "projects_primary_workspace_id_uuid_v7_check" CHECK("projects"."primary_workspace_id" is null or (length("projects"."primary_workspace_id") = 36 and "projects"."primary_workspace_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
	CONSTRAINT "projects_automatic_fetch_policy_check" CHECK("projects"."automatic_fetch_policy" in ('manual', 'on-start')),
	CONSTRAINT "projects_state_check" CHECK("projects"."state" in ('registering', 'ready', 'invalid', 'archived')),
	CONSTRAINT "projects_created_at_timestamp_check" CHECK(
    length("projects"."created_at") = 24
    and "projects"."created_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "projects_updated_at_timestamp_check" CHECK(
    length("projects"."updated_at") = 24
    and "projects"."updated_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "projects_archived_at_timestamp_check" CHECK("projects"."archived_at" is null or (
    length("projects"."archived_at") = 24
    and "projects"."archived_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )),
	CONSTRAINT "projects_row_version_check" CHECK("projects"."row_version" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_unique` ON `projects` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_repository_store_path_unique` ON `projects` (`repository_store_path`);--> statement-breakpoint
CREATE INDEX `projects_active_config_revision_id_idx` ON `projects` (`active_config_revision_id`);--> statement-breakpoint
CREATE INDEX `projects_primary_workspace_id_idx` ON `projects` (`primary_workspace_id`);--> statement-breakpoint
CREATE TABLE `runtime_stacks` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`runtime_namespace` text NOT NULL,
	`runtime_plan_hash` text NOT NULL,
	`desired_state` text NOT NULL,
	`observed_state` text NOT NULL,
	`runtime_generation` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_observed_at` text,
	`last_error_code` text,
	`last_error_message` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "runtime_stacks_id_uuid_v7_check" CHECK(length("runtime_stacks"."id") = 36 and "runtime_stacks"."id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "runtime_stacks_workspace_id_uuid_v7_check" CHECK(length("runtime_stacks"."workspace_id") = 36 and "runtime_stacks"."workspace_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "runtime_stacks_runtime_plan_hash_check" CHECK(
    length("runtime_stacks"."runtime_plan_hash") = 78
    and substr("runtime_stacks"."runtime_plan_hash", 1, 14) = 'sha256-jcs-v1:'
    and substr("runtime_stacks"."runtime_plan_hash", 15) not glob '*[^0-9a-f]*'
  ),
	CONSTRAINT "runtime_stacks_desired_state_check" CHECK("runtime_stacks"."desired_state" in ('absent', 'stopped', 'running')),
	CONSTRAINT "runtime_stacks_observed_state_check" CHECK("runtime_stacks"."observed_state" in ('absent', 'creating', 'stopped', 'starting', 'running', 'stopping', 'degraded', 'failed', 'removing', 'lost')),
	CONSTRAINT "runtime_stacks_runtime_generation_check" CHECK("runtime_stacks"."runtime_generation" >= 0),
	CONSTRAINT "runtime_stacks_created_at_timestamp_check" CHECK(
    length("runtime_stacks"."created_at") = 24
    and "runtime_stacks"."created_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "runtime_stacks_updated_at_timestamp_check" CHECK(
    length("runtime_stacks"."updated_at") = 24
    and "runtime_stacks"."updated_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "runtime_stacks_last_observed_at_timestamp_check" CHECK("runtime_stacks"."last_observed_at" is null or (
    length("runtime_stacks"."last_observed_at") = 24
    and "runtime_stacks"."last_observed_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_stacks_workspace_id_unique` ON `runtime_stacks` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_stacks_runtime_namespace_unique` ON `runtime_stacks` (`runtime_namespace`);--> statement-breakpoint
CREATE TABLE `task_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`task_key` text NOT NULL,
	`process_id` text,
	`config_revision_id` text NOT NULL,
	`state` text NOT NULL,
	`exit_code` integer,
	`started_at` text,
	`finished_at` text,
	`summary_json` text,
	`log_path` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`process_id`) REFERENCES `processes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`config_revision_id`) REFERENCES `project_config_revisions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "task_runs_id_uuid_v7_check" CHECK(length("task_runs"."id") = 36 and "task_runs"."id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "task_runs_workspace_id_uuid_v7_check" CHECK(length("task_runs"."workspace_id") = 36 and "task_runs"."workspace_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "task_runs_process_id_uuid_v7_check" CHECK("task_runs"."process_id" is null or (length("task_runs"."process_id") = 36 and "task_runs"."process_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
	CONSTRAINT "task_runs_config_revision_id_uuid_v7_check" CHECK(length("task_runs"."config_revision_id") = 36 and "task_runs"."config_revision_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "task_runs_state_check" CHECK("task_runs"."state" in ('queued', 'starting', 'running', 'passed', 'failed', 'cancelled', 'timed_out', 'lost')),
	CONSTRAINT "task_runs_started_at_timestamp_check" CHECK("task_runs"."started_at" is null or (
    length("task_runs"."started_at") = 24
    and "task_runs"."started_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )),
	CONSTRAINT "task_runs_finished_at_timestamp_check" CHECK("task_runs"."finished_at" is null or (
    length("task_runs"."finished_at") = 24
    and "task_runs"."finished_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )),
	CONSTRAINT "task_runs_summary_json_check" CHECK("task_runs"."summary_json" is null or json_valid("task_runs"."summary_json"))
);
--> statement-breakpoint
CREATE INDEX `task_runs_workspace_id_idx` ON `task_runs` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `task_runs_process_id_idx` ON `task_runs` (`process_id`);--> statement-breakpoint
CREATE INDEX `task_runs_config_revision_id_idx` ON `task_runs` (`config_revision_id`);--> statement-breakpoint
CREATE TABLE `terminal_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`process_id` text NOT NULL,
	`title` text NOT NULL,
	`shell_profile_key` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`last_activity_at` text,
	`closed_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`process_id`) REFERENCES `processes`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "terminal_sessions_id_uuid_v7_check" CHECK(length("terminal_sessions"."id") = 36 and "terminal_sessions"."id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "terminal_sessions_workspace_id_uuid_v7_check" CHECK(length("terminal_sessions"."workspace_id") = 36 and "terminal_sessions"."workspace_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "terminal_sessions_process_id_uuid_v7_check" CHECK(length("terminal_sessions"."process_id") = 36 and "terminal_sessions"."process_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "terminal_sessions_state_check" CHECK("terminal_sessions"."state" in ('creating', 'active', 'disconnected', 'closing', 'closed', 'failed', 'lost')),
	CONSTRAINT "terminal_sessions_created_at_timestamp_check" CHECK(
    length("terminal_sessions"."created_at") = 24
    and "terminal_sessions"."created_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "terminal_sessions_last_activity_at_timestamp_check" CHECK("terminal_sessions"."last_activity_at" is null or (
    length("terminal_sessions"."last_activity_at") = 24
    and "terminal_sessions"."last_activity_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )),
	CONSTRAINT "terminal_sessions_closed_at_timestamp_check" CHECK("terminal_sessions"."closed_at" is null or (
    length("terminal_sessions"."closed_at") = 24
    and "terminal_sessions"."closed_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `terminal_sessions_process_id_unique` ON `terminal_sessions` (`process_id`);--> statement-breakpoint
CREATE INDEX `terminal_sessions_workspace_id_idx` ON `terminal_sessions` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `workspace_services` (
	`id` text PRIMARY KEY NOT NULL,
	`runtime_stack_id` text NOT NULL,
	`service_key` text NOT NULL,
	`kind` text NOT NULL,
	`container_id` text,
	`image_reference` text NOT NULL,
	`image_digest` text,
	`desired_state` text NOT NULL,
	`observed_state` text NOT NULL,
	`health_state` text NOT NULL,
	`started_at` text,
	`stopped_at` text,
	`last_observed_at` text,
	FOREIGN KEY (`runtime_stack_id`) REFERENCES `runtime_stacks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workspace_services_id_uuid_v7_check" CHECK(length("workspace_services"."id") = 36 and "workspace_services"."id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "workspace_services_runtime_stack_id_uuid_v7_check" CHECK(length("workspace_services"."runtime_stack_id") = 36 and "workspace_services"."runtime_stack_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "workspace_services_kind_check" CHECK("workspace_services"."kind" in ('development', 'supporting')),
	CONSTRAINT "workspace_services_desired_state_check" CHECK("workspace_services"."desired_state" in ('absent', 'stopped', 'running')),
	CONSTRAINT "workspace_services_observed_state_check" CHECK("workspace_services"."observed_state" in ('absent', 'creating', 'stopped', 'starting', 'running', 'stopping', 'degraded', 'failed', 'removing', 'lost')),
	CONSTRAINT "workspace_services_health_state_check" CHECK("workspace_services"."health_state" in ('unknown', 'starting', 'healthy', 'unhealthy')),
	CONSTRAINT "workspace_services_started_at_timestamp_check" CHECK("workspace_services"."started_at" is null or (
    length("workspace_services"."started_at") = 24
    and "workspace_services"."started_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )),
	CONSTRAINT "workspace_services_stopped_at_timestamp_check" CHECK("workspace_services"."stopped_at" is null or (
    length("workspace_services"."stopped_at") = 24
    and "workspace_services"."stopped_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )),
	CONSTRAINT "workspace_services_last_observed_at_timestamp_check" CHECK("workspace_services"."last_observed_at" is null or (
    length("workspace_services"."last_observed_at") = 24
    and "workspace_services"."last_observed_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_services_stack_service_key_unique` ON `workspace_services` (`runtime_stack_id`,`service_key`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`config_revision_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`branch_name` text NOT NULL,
	`base_ref` text NOT NULL,
	`worktree_path` text NOT NULL,
	`desired_state` text NOT NULL,
	`observed_state` text NOT NULL,
	`dirty_state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text,
	`removed_at` text,
	`row_version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`config_revision_id`) REFERENCES `project_config_revisions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "workspaces_id_uuid_v7_check" CHECK(length("workspaces"."id") = 36 and "workspaces"."id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "workspaces_project_id_uuid_v7_check" CHECK(length("workspaces"."project_id") = 36 and "workspaces"."project_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "workspaces_config_revision_id_uuid_v7_check" CHECK(length("workspaces"."config_revision_id") = 36 and "workspaces"."config_revision_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "workspaces_kind_check" CHECK("workspaces"."kind" in ('primary', 'isolated')),
	CONSTRAINT "workspaces_desired_state_check" CHECK("workspaces"."desired_state" in ('stopped', 'running', 'archived', 'removed')),
	CONSTRAINT "workspaces_observed_state_check" CHECK("workspaces"."observed_state" in ('provisioning', 'stopped', 'starting', 'running', 'stopping', 'degraded', 'failed', 'lost', 'archived', 'removed')),
	CONSTRAINT "workspaces_dirty_state_check" CHECK("workspaces"."dirty_state" in ('unknown', 'clean', 'dirty')),
	CONSTRAINT "workspaces_created_at_timestamp_check" CHECK(
    length("workspaces"."created_at") = 24
    and "workspaces"."created_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "workspaces_updated_at_timestamp_check" CHECK(
    length("workspaces"."updated_at") = 24
    and "workspaces"."updated_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "workspaces_archived_at_timestamp_check" CHECK("workspaces"."archived_at" is null or (
    length("workspaces"."archived_at") = 24
    and "workspaces"."archived_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )),
	CONSTRAINT "workspaces_removed_at_timestamp_check" CHECK("workspaces"."removed_at" is null or (
    length("workspaces"."removed_at") = 24
    and "workspaces"."removed_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )),
	CONSTRAINT "workspaces_row_version_check" CHECK("workspaces"."row_version" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_worktree_path_unique` ON `workspaces` (`worktree_path`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_one_non_removed_primary_per_project` ON `workspaces` (`project_id`) WHERE "workspaces"."kind" = 'primary' and "workspaces"."desired_state" <> 'removed';--> statement-breakpoint
CREATE INDEX `workspaces_project_id_idx` ON `workspaces` (`project_id`);--> statement-breakpoint
CREATE INDEX `workspaces_config_revision_id_idx` ON `workspaces` (`config_revision_id`);