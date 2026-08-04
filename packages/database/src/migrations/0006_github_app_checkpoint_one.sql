CREATE TABLE `github_connection_attempts` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`state_hash` text NOT NULL,
	`status` text NOT NULL,
	`expires_at` text NOT NULL,
	`claimed_installation_id` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`failure_classification` text,
	`row_version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "github_connection_attempts_connection_id_uuid_v7_check" CHECK(length("github_connection_attempts"."connection_id") = 36 and "github_connection_attempts"."connection_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "github_connection_attempts_state_hash_check" CHECK(length("github_connection_attempts"."state_hash") = 64 and "github_connection_attempts"."state_hash" not glob '*[^0-9a-f]*'),
	CONSTRAINT "github_connection_attempts_status_check" CHECK("github_connection_attempts"."status" in ('pending', 'claimed', 'connected', 'failed')),
	CONSTRAINT "github_connection_attempts_expires_at_timestamp_check" CHECK(
    length("github_connection_attempts"."expires_at") = 24
    and "github_connection_attempts"."expires_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "github_connection_attempts_created_at_timestamp_check" CHECK(
    length("github_connection_attempts"."created_at") = 24
    and "github_connection_attempts"."created_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "github_connection_attempts_updated_at_timestamp_check" CHECK(
    length("github_connection_attempts"."updated_at") = 24
    and "github_connection_attempts"."updated_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "github_connection_attempts_claimed_installation_id_check" CHECK("github_connection_attempts"."claimed_installation_id" is null or (length("github_connection_attempts"."claimed_installation_id") between 1 and 32 and "github_connection_attempts"."claimed_installation_id" not glob '*[^0-9]*' and ("github_connection_attempts"."claimed_installation_id" = '0' or substr("github_connection_attempts"."claimed_installation_id", 1, 1) <> '0'))),
	CONSTRAINT "github_connection_attempts_row_version_check" CHECK("github_connection_attempts"."row_version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_connection_attempts_state_hash_unique` ON `github_connection_attempts` (`state_hash`);--> statement-breakpoint
CREATE TABLE `github_connections` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`account_id` text NOT NULL,
	`account_type` text NOT NULL,
	`account_login` text NOT NULL,
	`repository_selection` text NOT NULL,
	`permissions_json` text NOT NULL,
	`status` text NOT NULL,
	`verified_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`row_version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "github_connections_connection_id_uuid_v7_check" CHECK(length("github_connections"."connection_id") = 36 and "github_connections"."connection_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "github_connections_installation_id_check" CHECK(length("github_connections"."installation_id") between 1 and 32 and "github_connections"."installation_id" not glob '*[^0-9]*' and ("github_connections"."installation_id" = '0' or substr("github_connections"."installation_id", 1, 1) <> '0')),
	CONSTRAINT "github_connections_account_id_check" CHECK(length("github_connections"."account_id") between 1 and 32 and "github_connections"."account_id" not glob '*[^0-9]*' and ("github_connections"."account_id" = '0' or substr("github_connections"."account_id", 1, 1) <> '0')),
	CONSTRAINT "github_connections_account_type_check" CHECK("github_connections"."account_type" in ('User', 'Organization')),
	CONSTRAINT "github_connections_repository_selection_check" CHECK("github_connections"."repository_selection" in ('all', 'selected')),
	CONSTRAINT "github_connections_permissions_json_check" CHECK(json_valid("github_connections"."permissions_json")),
	CONSTRAINT "github_connections_status_check" CHECK("github_connections"."status" in ('connected', 'degraded', 'failed')),
	CONSTRAINT "github_connections_verified_at_timestamp_check" CHECK(
    length("github_connections"."verified_at") = 24
    and "github_connections"."verified_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "github_connections_created_at_timestamp_check" CHECK(
    length("github_connections"."created_at") = 24
    and "github_connections"."created_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "github_connections_updated_at_timestamp_check" CHECK(
    length("github_connections"."updated_at") = 24
    and "github_connections"."updated_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "github_connections_row_version_check" CHECK("github_connections"."row_version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_connections_installation_id_unique` ON `github_connections` (`installation_id`);