PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_previews` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`config_revision_id` text NOT NULL,
	`service_id` text,
	`preview_key` text NOT NULL,
	`display_name` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_key` text NOT NULL,
	`domain_base_id` text NOT NULL,
	`hostname_pattern` text NOT NULL,
	`hostname` text NOT NULL,
	`container_port` integer NOT NULL,
	`protocol` text NOT NULL,
	`health_path` text NOT NULL,
	`health_statuses_json` text NOT NULL,
	`startup_timeout_seconds` integer NOT NULL,
	`web_socket_forwarding` integer NOT NULL,
	`desired_state` text NOT NULL,
	`observed_state` text NOT NULL,
	`route_present` integer DEFAULT false NOT NULL,
	`route_revision` integer,
	`runtime_generation` integer,
	`last_observation_json` text,
	`last_error_code` text,
	`last_error_message` text,
	`operation_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`activated_at` text,
	`deactivated_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`config_revision_id`) REFERENCES `project_config_revisions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`service_id`) REFERENCES `workspace_services`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`operation_id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "previews_id_uuid_v7_check" CHECK(length("__new_previews"."id") = 36 and "__new_previews"."id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "previews_workspace_id_uuid_v7_check" CHECK(length("__new_previews"."workspace_id") = 36 and "__new_previews"."workspace_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "previews_config_revision_id_uuid_v7_check" CHECK(length("__new_previews"."config_revision_id") = 36 and "__new_previews"."config_revision_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "previews_service_id_uuid_v7_check" CHECK("__new_previews"."service_id" is null or (length("__new_previews"."service_id") = 36 and "__new_previews"."service_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
	CONSTRAINT "previews_operation_id_uuid_v7_check" CHECK("__new_previews"."operation_id" is null or (length("__new_previews"."operation_id") = 36 and "__new_previews"."operation_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
	CONSTRAINT "previews_target_kind_check" CHECK("__new_previews"."target_kind" in ('workspace', 'service')),
	CONSTRAINT "previews_target_key_check" CHECK(length("__new_previews"."target_key") between 1 and 64),
	CONSTRAINT "previews_domain_base_id_check" CHECK(length("__new_previews"."domain_base_id") between 1 and 64),
	CONSTRAINT "previews_hostname_pattern_check" CHECK(length("__new_previews"."hostname_pattern") between 1 and 253),
	CONSTRAINT "previews_hostname_check" CHECK(
    length("__new_previews"."hostname") between 1 and 253
    and "__new_previews"."hostname" not glob '*[^a-z0-9.-]*'
    and "__new_previews"."hostname" not like '.%'
    and "__new_previews"."hostname" not like '%.'
    and "__new_previews"."hostname" not like '%..%'
  ),
	CONSTRAINT "previews_container_port_check" CHECK("__new_previews"."container_port" between 1 and 65535),
	CONSTRAINT "previews_protocol_check" CHECK("__new_previews"."protocol" in ('http')),
	CONSTRAINT "previews_health_path_check" CHECK(length("__new_previews"."health_path") between 1 and 2048 and substr("__new_previews"."health_path", 1, 1) = '/'),
	CONSTRAINT "previews_health_statuses_json_check" CHECK(length("__new_previews"."health_statuses_json") between 2 and 1024 and json_valid("__new_previews"."health_statuses_json")),
	CONSTRAINT "previews_startup_timeout_seconds_check" CHECK("__new_previews"."startup_timeout_seconds" between 1 and 3600),
	CONSTRAINT "previews_desired_state_check" CHECK("__new_previews"."desired_state" in ('inactive', 'active')),
	CONSTRAINT "previews_observed_state_check" CHECK("__new_previews"."observed_state" in ('inactive', 'starting', 'healthy', 'unhealthy', 'stopping', 'failed', 'lost')),
	CONSTRAINT "previews_route_present_check" CHECK("__new_previews"."route_present" in (0, 1)),
	CONSTRAINT "previews_route_revision_check" CHECK("__new_previews"."route_revision" is null or "__new_previews"."route_revision" >= 0),
	CONSTRAINT "previews_runtime_generation_check" CHECK("__new_previews"."runtime_generation" is null or "__new_previews"."runtime_generation" >= 0),
	CONSTRAINT "previews_last_observation_json_check" CHECK("__new_previews"."last_observation_json" is null or json_valid("__new_previews"."last_observation_json")),
	CONSTRAINT "previews_created_at_timestamp_check" CHECK(
    length("__new_previews"."created_at") = 24
    and "__new_previews"."created_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "previews_updated_at_timestamp_check" CHECK(
    length("__new_previews"."updated_at") = 24
    and "__new_previews"."updated_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "previews_activated_at_timestamp_check" CHECK("__new_previews"."activated_at" is null or (
    length("__new_previews"."activated_at") = 24
    and "__new_previews"."activated_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )),
	CONSTRAINT "previews_deactivated_at_timestamp_check" CHECK("__new_previews"."deactivated_at" is null or (
    length("__new_previews"."deactivated_at") = 24
    and "__new_previews"."deactivated_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ))
);
--> statement-breakpoint
INSERT INTO `__new_previews`("id", "workspace_id", "config_revision_id", "service_id", "preview_key", "display_name", "target_kind", "target_key", "domain_base_id", "hostname_pattern", "hostname", "container_port", "protocol", "health_path", "health_statuses_json", "startup_timeout_seconds", "web_socket_forwarding", "desired_state", "observed_state", "route_present", "route_revision", "runtime_generation", "last_observation_json", "last_error_code", "last_error_message", "operation_id", "created_at", "updated_at", "activated_at", "deactivated_at") SELECT p."id", p."workspace_id", w."config_revision_id", p."service_id", p."preview_key", p."preview_key", 'service', coalesce(s."service_key", 'legacy'), 'legacy', '{preview}', p."hostname", p."container_port", p."protocol", p."health_path", '[200]', 60, 1, p."desired_state", p."observed_state", 0, p."route_revision", null, null, null, null, null, p."created_at", p."updated_at", p."activated_at", p."deactivated_at" FROM `previews` p JOIN `workspaces` w ON w."id" = p."workspace_id" LEFT JOIN `workspace_services` s ON s."id" = p."service_id";--> statement-breakpoint
DROP TABLE `previews`;--> statement-breakpoint
ALTER TABLE `__new_previews` RENAME TO `previews`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `previews_hostname_unique` ON `previews` (`hostname`);--> statement-breakpoint
CREATE INDEX `previews_config_revision_id_idx` ON `previews` (`config_revision_id`);--> statement-breakpoint
CREATE INDEX `previews_service_id_idx` ON `previews` (`service_id`);--> statement-breakpoint
CREATE INDEX `previews_operation_id_idx` ON `previews` (`operation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `previews_workspace_preview_key_unique` ON `previews` (`workspace_id`,`preview_key`);--> statement-breakpoint
CREATE TABLE `__new_port_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`preview_id` text,
	`port` integer NOT NULL,
	`bind_address` text NOT NULL,
	`runtime_generation` integer,
	`state` text NOT NULL,
	`lease_token` text NOT NULL,
	`created_at` text NOT NULL,
	`activated_at` text,
	`released_at` text,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`preview_id`) REFERENCES `previews`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "port_leases_id_uuid_v7_check" CHECK(length("__new_port_leases"."id") = 36 and "__new_port_leases"."id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "port_leases_workspace_id_uuid_v7_check" CHECK(length("__new_port_leases"."workspace_id") = 36 and "__new_port_leases"."workspace_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "port_leases_preview_id_uuid_v7_check" CHECK("__new_port_leases"."preview_id" is null or (length("__new_port_leases"."preview_id") = 36 and "__new_port_leases"."preview_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
	CONSTRAINT "port_leases_port_check" CHECK("__new_port_leases"."port" between 1 and 65535),
	CONSTRAINT "port_leases_bind_address_check" CHECK("__new_port_leases"."bind_address" in ('127.0.0.1', '::1')),
	CONSTRAINT "port_leases_runtime_generation_check" CHECK("__new_port_leases"."runtime_generation" is null or "__new_port_leases"."runtime_generation" >= 0),
	CONSTRAINT "port_leases_state_check" CHECK("__new_port_leases"."state" in ('reserved', 'active', 'released', 'stale')),
	CONSTRAINT "port_leases_created_at_timestamp_check" CHECK(
    length("__new_port_leases"."created_at") = 24
    and "__new_port_leases"."created_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "port_leases_activated_at_timestamp_check" CHECK("__new_port_leases"."activated_at" is null or (
    length("__new_port_leases"."activated_at") = 24
    and "__new_port_leases"."activated_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )),
	CONSTRAINT "port_leases_released_at_timestamp_check" CHECK("__new_port_leases"."released_at" is null or (
    length("__new_port_leases"."released_at") = 24
    and "__new_port_leases"."released_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )),
	CONSTRAINT "port_leases_expires_at_timestamp_check" CHECK(
    length("__new_port_leases"."expires_at") = 24
    and "__new_port_leases"."expires_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )
);
--> statement-breakpoint
INSERT INTO `__new_port_leases`("id", "workspace_id", "preview_id", "port", "bind_address", "runtime_generation", "state", "lease_token", "created_at", "activated_at", "released_at", "expires_at") SELECT "id", "workspace_id", "preview_id", "port", "bind_address", null, "state", "lease_token", "created_at", "activated_at", "released_at", "expires_at" FROM `port_leases`;--> statement-breakpoint
DROP TABLE `port_leases`;--> statement-breakpoint
ALTER TABLE `__new_port_leases` RENAME TO `port_leases`;--> statement-breakpoint
CREATE UNIQUE INDEX `port_leases_lease_token_unique` ON `port_leases` (`lease_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `port_leases_one_live_address_port` ON `port_leases` (`bind_address`,`port`) WHERE "port_leases"."state" in ('reserved', 'active');--> statement-breakpoint
CREATE INDEX `port_leases_workspace_id_idx` ON `port_leases` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `port_leases_preview_id_idx` ON `port_leases` (`preview_id`);
