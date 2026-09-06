CREATE TABLE `project_github_sources` (
	`project_id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`owner_login` text NOT NULL,
	`name` text NOT NULL,
	`full_name` text NOT NULL,
	`clean_https_url` text NOT NULL,
	`default_branch` text NOT NULL,
	`is_private` integer NOT NULL,
	`is_archived` integer NOT NULL,
	`is_disabled` integer NOT NULL,
	`verified_at` text NOT NULL,
	`metadata_updated_at` text NOT NULL,
	`row_version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `github_connections`(`connection_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "project_github_sources_repository_id_check" CHECK(length("project_github_sources"."repository_id") between 1 and 32 and "project_github_sources"."repository_id" not glob '*[^0-9]*' and ("project_github_sources"."repository_id" = '0' or substr("project_github_sources"."repository_id", 1, 1) <> '0')),
	CONSTRAINT "project_github_sources_owner_login_check" CHECK(
    length("project_github_sources"."owner_login") between 1 and 39
    and "project_github_sources"."owner_login" not glob '*[^A-Za-z0-9-]*'
    and "project_github_sources"."owner_login" not glob '-*'
    and "project_github_sources"."owner_login" not glob '*-'
  ),
	CONSTRAINT "project_github_sources_name_check" CHECK(
    length("project_github_sources"."name") between 1 and 100
    and "project_github_sources"."name" not glob '*[^A-Za-z0-9_.-]*'
  ),
	CONSTRAINT "project_github_sources_full_name_check" CHECK("project_github_sources"."full_name" = "project_github_sources"."owner_login" || '/' || "project_github_sources"."name"),
	CONSTRAINT "project_github_sources_clean_https_url_check" CHECK(
    "project_github_sources"."clean_https_url" = 'https://github.com/' || "project_github_sources"."full_name" || '.git'
  ),
	CONSTRAINT "project_github_sources_verified_at_timestamp_check" CHECK(
    length("project_github_sources"."verified_at") = 24
    and "project_github_sources"."verified_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "project_github_sources_metadata_updated_at_timestamp_check" CHECK(
    length("project_github_sources"."metadata_updated_at") = 24
    and "project_github_sources"."metadata_updated_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "project_github_sources_row_version_check" CHECK("project_github_sources"."row_version" >= 1)
);
--> statement-breakpoint
CREATE INDEX `project_github_sources_connection_id_idx` ON `project_github_sources` (`connection_id`);