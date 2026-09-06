CREATE TABLE `github_connection_setup_attempts` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`state_hash` text NOT NULL,
	`status` text NOT NULL,
	`target_generation` integer NOT NULL,
	`expires_at` text NOT NULL,
	`claimed_installation_id` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`failure_classification` text,
	`row_version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `github_connections`(`connection_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "github_connection_setup_attempts_attempt_id_uuid_v7_check" CHECK(length("github_connection_setup_attempts"."attempt_id") = 36 and "github_connection_setup_attempts"."attempt_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "github_connection_setup_attempts_connection_id_uuid_v7_check" CHECK(length("github_connection_setup_attempts"."connection_id") = 36 and "github_connection_setup_attempts"."connection_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "github_connection_setup_attempts_state_hash_check" CHECK(length("github_connection_setup_attempts"."state_hash") = 64 and "github_connection_setup_attempts"."state_hash" not glob '*[^0-9a-f]*'),
	CONSTRAINT "github_connection_setup_attempts_status_check" CHECK("github_connection_setup_attempts"."status" in ('pending', 'claimed', 'connected', 'failed')),
	CONSTRAINT "github_connection_setup_attempts_target_generation_check" CHECK("github_connection_setup_attempts"."target_generation" >= 1),
	CONSTRAINT "github_connection_setup_attempts_expires_at_timestamp_check" CHECK(
    length("github_connection_setup_attempts"."expires_at") = 24
    and "github_connection_setup_attempts"."expires_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "github_connection_setup_attempts_created_at_timestamp_check" CHECK(
    length("github_connection_setup_attempts"."created_at") = 24
    and "github_connection_setup_attempts"."created_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "github_connection_setup_attempts_updated_at_timestamp_check" CHECK(
    length("github_connection_setup_attempts"."updated_at") = 24
    and "github_connection_setup_attempts"."updated_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "github_connection_setup_attempts_claimed_installation_id_check" CHECK("github_connection_setup_attempts"."claimed_installation_id" is null or (length("github_connection_setup_attempts"."claimed_installation_id") between 1 and 32 and "github_connection_setup_attempts"."claimed_installation_id" not glob '*[^0-9]*' and ("github_connection_setup_attempts"."claimed_installation_id" = '0' or substr("github_connection_setup_attempts"."claimed_installation_id", 1, 1) <> '0'))),
	CONSTRAINT "github_connection_setup_attempts_row_version_check" CHECK("github_connection_setup_attempts"."row_version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_connection_setup_attempts_state_hash_unique` ON `github_connection_setup_attempts` (`state_hash`);--> statement-breakpoint
CREATE INDEX `github_connection_setup_attempts_connection_id_idx` ON `github_connection_setup_attempts` (`connection_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_github_connections` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`account_id` text NOT NULL,
	`account_type` text NOT NULL,
	`account_login` text NOT NULL,
	`repository_selection` text NOT NULL,
	`permissions_json` text NOT NULL,
	`status` text NOT NULL,
	`lifecycle_generation` integer DEFAULT 1 NOT NULL,
	`lifecycle_state` text DEFAULT 'enabled' NOT NULL,
	`cleanup_state` text DEFAULT 'settled' NOT NULL,
	`last_authority_failure_code` text,
	`last_authority_checked_at` text,
	`verified_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`row_version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "github_connections_connection_id_uuid_v7_check" CHECK(length("__new_github_connections"."connection_id") = 36 and "__new_github_connections"."connection_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "github_connections_installation_id_check" CHECK(length("__new_github_connections"."installation_id") between 1 and 32 and "__new_github_connections"."installation_id" not glob '*[^0-9]*' and ("__new_github_connections"."installation_id" = '0' or substr("__new_github_connections"."installation_id", 1, 1) <> '0')),
	CONSTRAINT "github_connections_account_id_check" CHECK(length("__new_github_connections"."account_id") between 1 and 32 and "__new_github_connections"."account_id" not glob '*[^0-9]*' and ("__new_github_connections"."account_id" = '0' or substr("__new_github_connections"."account_id", 1, 1) <> '0')),
	CONSTRAINT "github_connections_account_type_check" CHECK("__new_github_connections"."account_type" in ('User', 'Organization')),
	CONSTRAINT "github_connections_repository_selection_check" CHECK("__new_github_connections"."repository_selection" in ('all', 'selected')),
	CONSTRAINT "github_connections_permissions_json_check" CHECK(json_valid("__new_github_connections"."permissions_json")),
	CONSTRAINT "github_connections_status_check" CHECK("__new_github_connections"."status" in ('connected', 'degraded', 'failed')),
	CONSTRAINT "github_connections_lifecycle_generation_check" CHECK("__new_github_connections"."lifecycle_generation" >= 1),
	CONSTRAINT "github_connections_lifecycle_state_check" CHECK("__new_github_connections"."lifecycle_state" in ('enabled', 'disconnect-pending', 'disconnected', 'reconnect-pending', 'installation-removed', 'installation-suspended', 'permission-required', 'repository-access-unavailable', 'transient-error')),
	CONSTRAINT "github_connections_cleanup_state_check" CHECK("__new_github_connections"."cleanup_state" in ('settled', 'pending', 'degraded')),
	CONSTRAINT "github_connections_last_authority_checked_at_timestamp_check" CHECK("__new_github_connections"."last_authority_checked_at" is null or (
    length("__new_github_connections"."last_authority_checked_at") = 24
    and "__new_github_connections"."last_authority_checked_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )),
	CONSTRAINT "github_connections_verified_at_timestamp_check" CHECK(
    length("__new_github_connections"."verified_at") = 24
    and "__new_github_connections"."verified_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "github_connections_created_at_timestamp_check" CHECK(
    length("__new_github_connections"."created_at") = 24
    and "__new_github_connections"."created_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "github_connections_updated_at_timestamp_check" CHECK(
    length("__new_github_connections"."updated_at") = 24
    and "__new_github_connections"."updated_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "github_connections_row_version_check" CHECK("__new_github_connections"."row_version" >= 1)
);
--> statement-breakpoint
INSERT INTO `__new_github_connections`("connection_id", "installation_id", "account_id", "account_type", "account_login", "repository_selection", "permissions_json", "status", "lifecycle_generation", "lifecycle_state", "cleanup_state", "last_authority_failure_code", "last_authority_checked_at", "verified_at", "created_at", "updated_at", "row_version") SELECT "connection_id", "installation_id", "account_id", "account_type", "account_login", "repository_selection", "permissions_json", "status", 1, 'enabled', 'settled', NULL, NULL, "verified_at", "created_at", "updated_at", "row_version" FROM `github_connections`;--> statement-breakpoint
DROP TABLE `github_connections`;--> statement-breakpoint
ALTER TABLE `__new_github_connections` RENAME TO `github_connections`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `github_connections_installation_id_unique` ON `github_connections` (`installation_id`);
