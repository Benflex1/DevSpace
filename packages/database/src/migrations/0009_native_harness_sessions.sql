CREATE TABLE `harness_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`origin` text DEFAULT 'custom' NOT NULL,
	`launch_json` text NOT NULL,
	`resume_json` text,
	`environment_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "harness_definitions_id_key_check" CHECK(length("harness_definitions"."id") between 1 and 64 and "harness_definitions"."id" glob '[a-z]*' and "harness_definitions"."id" not glob '*[^a-z0-9-]*'),
	CONSTRAINT "harness_definitions_origin_check" CHECK("harness_definitions"."origin" = 'custom'),
	CONSTRAINT "harness_definitions_launch_json_check" CHECK(json_valid("harness_definitions"."launch_json")),
	CONSTRAINT "harness_definitions_resume_json_check" CHECK("harness_definitions"."resume_json" is null or json_valid("harness_definitions"."resume_json")),
	CONSTRAINT "harness_definitions_environment_json_check" CHECK(json_valid("harness_definitions"."environment_json")),
	CONSTRAINT "harness_definitions_created_at_timestamp_check" CHECK(
    length("harness_definitions"."created_at") = 24
    and "harness_definitions"."created_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "harness_definitions_updated_at_timestamp_check" CHECK(
    length("harness_definitions"."updated_at") = 24
    and "harness_definitions"."updated_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )
);
--> statement-breakpoint
ALTER TABLE `ai_sessions` ADD `runtime_kind` text DEFAULT 'structured' NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_sessions` ADD `harness_id` text;
