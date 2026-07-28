CREATE TABLE `ai_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text,
	`sequence` integer NOT NULL,
	`event_type` text NOT NULL,
	`event_json` text NOT NULL,
	`observed_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `ai_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`turn_id`) REFERENCES `ai_turns`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ai_events_event_id_uuid_v7_check" CHECK(length("ai_events"."event_id") = 36 and "ai_events"."event_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "ai_events_session_id_uuid_v7_check" CHECK(length("ai_events"."session_id") = 36 and "ai_events"."session_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "ai_events_turn_id_uuid_v7_check" CHECK("ai_events"."turn_id" is null or (length("ai_events"."turn_id") = 36 and "ai_events"."turn_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
	CONSTRAINT "ai_events_sequence_check" CHECK("ai_events"."sequence" >= 1),
	CONSTRAINT "ai_events_event_json_check" CHECK(json_valid("ai_events"."event_json")),
	CONSTRAINT "ai_events_observed_at_timestamp_check" CHECK(
    length("ai_events"."observed_at") = 24
    and "ai_events"."observed_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )
);
--> statement-breakpoint
CREATE INDEX `ai_events_session_sequence_idx` ON `ai_events` (`session_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `ai_events_session_sequence_unique` ON `ai_events` (`session_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `ai_interaction_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`request_json` text NOT NULL,
	`response_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `ai_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`turn_id`) REFERENCES `ai_turns`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ai_interaction_requests_id_uuid_v7_check" CHECK(length("ai_interaction_requests"."id") = 36 and "ai_interaction_requests"."id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "ai_interaction_requests_session_id_uuid_v7_check" CHECK(length("ai_interaction_requests"."session_id") = 36 and "ai_interaction_requests"."session_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "ai_interaction_requests_turn_id_uuid_v7_check" CHECK("ai_interaction_requests"."turn_id" is null or (length("ai_interaction_requests"."turn_id") = 36 and "ai_interaction_requests"."turn_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
	CONSTRAINT "ai_interaction_requests_state_check" CHECK("ai_interaction_requests"."state" in ('pending', 'responded', 'cancelled', 'expired', 'lost')),
	CONSTRAINT "ai_interaction_requests_request_json_check" CHECK(json_valid("ai_interaction_requests"."request_json")),
	CONSTRAINT "ai_interaction_requests_response_json_check" CHECK("ai_interaction_requests"."response_json" is null or json_valid("ai_interaction_requests"."response_json")),
	CONSTRAINT "ai_interaction_requests_created_at_timestamp_check" CHECK(
    length("ai_interaction_requests"."created_at") = 24
    and "ai_interaction_requests"."created_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "ai_interaction_requests_updated_at_timestamp_check" CHECK(
    length("ai_interaction_requests"."updated_at") = 24
    and "ai_interaction_requests"."updated_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )
);
--> statement-breakpoint
CREATE INDEX `ai_interaction_requests_session_id_idx` ON `ai_interaction_requests` (`session_id`);--> statement-breakpoint
CREATE TABLE `ai_provider_resume_metadata` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`profile_revision` text NOT NULL,
	`runtime_generation` integer NOT NULL,
	`process_generation` integer NOT NULL,
	`state_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `ai_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ai_provider_resume_metadata_id_uuid_v7_check" CHECK(length("ai_provider_resume_metadata"."id") = 36 and "ai_provider_resume_metadata"."id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "ai_provider_resume_metadata_session_id_uuid_v7_check" CHECK(length("ai_provider_resume_metadata"."session_id") = 36 and "ai_provider_resume_metadata"."session_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "ai_provider_resume_metadata_runtime_generation_check" CHECK("ai_provider_resume_metadata"."runtime_generation" >= 1),
	CONSTRAINT "ai_provider_resume_metadata_process_generation_check" CHECK("ai_provider_resume_metadata"."process_generation" >= 1),
	CONSTRAINT "ai_provider_resume_metadata_profile_revision_check" CHECK("ai_provider_resume_metadata"."profile_revision" glob 'sha256-ai-profile-v1:*'),
	CONSTRAINT "ai_provider_resume_metadata_state_json_check" CHECK(json_valid("ai_provider_resume_metadata"."state_json")),
	CONSTRAINT "ai_provider_resume_metadata_created_at_timestamp_check" CHECK(
    length("ai_provider_resume_metadata"."created_at") = 24
    and "ai_provider_resume_metadata"."created_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "ai_provider_resume_metadata_updated_at_timestamp_check" CHECK(
    length("ai_provider_resume_metadata"."updated_at") = 24
    and "ai_provider_resume_metadata"."updated_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_provider_resume_metadata_session_unique` ON `ai_provider_resume_metadata` (`session_id`);--> statement-breakpoint
CREATE TABLE `ai_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`state` text NOT NULL,
	`content_json` text NOT NULL,
	`output_text` text DEFAULT '' NOT NULL,
	`changed_files_json` text DEFAULT '{"files":[],"truncated":false}' NOT NULL,
	`failure_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`session_id`) REFERENCES `ai_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ai_turns_id_uuid_v7_check" CHECK(length("ai_turns"."id") = 36 and "ai_turns"."id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "ai_turns_session_id_uuid_v7_check" CHECK(length("ai_turns"."session_id") = 36 and "ai_turns"."session_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "ai_turns_state_check" CHECK("ai_turns"."state" in ('accepted', 'starting', 'running', 'waiting-for-approval', 'waiting-for-input', 'interrupting', 'provider-completed', 'quiesced', 'completed', 'interrupted', 'failed', 'lost')),
	CONSTRAINT "ai_turns_content_json_check" CHECK(json_valid("ai_turns"."content_json")),
	CONSTRAINT "ai_turns_changed_files_json_check" CHECK(json_valid("ai_turns"."changed_files_json")),
	CONSTRAINT "ai_turns_failure_json_check" CHECK("ai_turns"."failure_json" is null or json_valid("ai_turns"."failure_json")),
	CONSTRAINT "ai_turns_created_at_timestamp_check" CHECK(
    length("ai_turns"."created_at") = 24
    and "ai_turns"."created_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "ai_turns_updated_at_timestamp_check" CHECK(
    length("ai_turns"."updated_at") = 24
    and "ai_turns"."updated_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "ai_turns_completed_at_timestamp_check" CHECK("ai_turns"."completed_at" is null or (
    length("ai_turns"."completed_at") = 24
    and "ai_turns"."completed_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ))
);
--> statement-breakpoint
CREATE INDEX `ai_turns_session_id_idx` ON `ai_turns` (`session_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ai_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`terminal_session_id` text,
	`process_id` text,
	`provider_key` text NOT NULL,
	`profile_key` text NOT NULL,
	`profile_revision` text DEFAULT 'sha256-ai-profile-v1:0000000000000000000000000000000000000000000000000000000000000000' NOT NULL,
	`revision_id` text NOT NULL,
	`runtime_plan_hash` text NOT NULL,
	`runtime_generation` integer NOT NULL,
	`process_generation` integer NOT NULL,
	`last_sequence` integer DEFAULT 0 NOT NULL,
	`failure_code` text,
	`failure_json` text,
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
	FOREIGN KEY (`revision_id`) REFERENCES `project_config_revisions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ai_sessions_id_uuid_v7_check" CHECK(length("__new_ai_sessions"."id") = 36 and "__new_ai_sessions"."id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "ai_sessions_workspace_id_uuid_v7_check" CHECK(length("__new_ai_sessions"."workspace_id") = 36 and "__new_ai_sessions"."workspace_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "ai_sessions_terminal_session_id_uuid_v7_check" CHECK("__new_ai_sessions"."terminal_session_id" is null or (length("__new_ai_sessions"."terminal_session_id") = 36 and "__new_ai_sessions"."terminal_session_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
	CONSTRAINT "ai_sessions_process_id_uuid_v7_check" CHECK("__new_ai_sessions"."process_id" is null or (length("__new_ai_sessions"."process_id") = 36 and "__new_ai_sessions"."process_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
	CONSTRAINT "ai_sessions_revision_id_uuid_v7_check" CHECK(length("__new_ai_sessions"."revision_id") = 36 and "__new_ai_sessions"."revision_id" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
	CONSTRAINT "ai_sessions_runtime_generation_check" CHECK("__new_ai_sessions"."runtime_generation" >= 1),
	CONSTRAINT "ai_sessions_process_generation_check" CHECK("__new_ai_sessions"."process_generation" >= 1),
	CONSTRAINT "ai_sessions_last_sequence_check" CHECK("__new_ai_sessions"."last_sequence" >= 0),
	CONSTRAINT "ai_sessions_profile_revision_check" CHECK("__new_ai_sessions"."profile_revision" glob 'sha256-ai-profile-v1:*'),
	CONSTRAINT "ai_sessions_runtime_plan_hash_check" CHECK("__new_ai_sessions"."runtime_plan_hash" glob 'sha256-jcs-v1:*'),
	CONSTRAINT "ai_sessions_failure_json_check" CHECK("__new_ai_sessions"."failure_json" is null or json_valid("__new_ai_sessions"."failure_json")),
	CONSTRAINT "ai_sessions_state_check" CHECK("__new_ai_sessions"."state" in ('creating', 'active', 'waiting_for_input', 'interrupted', 'stopped', 'failed', 'lost')),
	CONSTRAINT "ai_sessions_created_at_timestamp_check" CHECK(
    length("__new_ai_sessions"."created_at") = 24
    and "__new_ai_sessions"."created_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "ai_sessions_updated_at_timestamp_check" CHECK(
    length("__new_ai_sessions"."updated_at") = 24
    and "__new_ai_sessions"."updated_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
	CONSTRAINT "ai_sessions_last_activity_at_timestamp_check" CHECK("__new_ai_sessions"."last_activity_at" is null or (
    length("__new_ai_sessions"."last_activity_at") = 24
    and "__new_ai_sessions"."last_activity_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )),
	CONSTRAINT "ai_sessions_stopped_at_timestamp_check" CHECK("__new_ai_sessions"."stopped_at" is null or (
    length("__new_ai_sessions"."stopped_at") = 24
    and "__new_ai_sessions"."stopped_at" glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ))
);
--> statement-breakpoint
INSERT INTO `__new_ai_sessions`("id", "workspace_id", "terminal_session_id", "process_id", "provider_key", "profile_key", "profile_revision", "revision_id", "runtime_plan_hash", "runtime_generation", "process_generation", "last_sequence", "failure_code", "failure_json", "external_session_id", "title", "state", "created_at", "updated_at", "last_activity_at", "stopped_at")
SELECT old."id", old."workspace_id", old."terminal_session_id", old."process_id", old."provider_key", old."profile_key",
  'sha256-ai-profile-v1:0000000000000000000000000000000000000000000000000000000000000000',
  projects."active_config_revision_id", 'sha256-jcs-v1:0000000000000000000000000000000000000000000000000000000000000000', 1, 1, 0, NULL, NULL,
  old."external_session_id", old."title", old."state", old."created_at", old."updated_at", old."last_activity_at", old."stopped_at"
FROM `ai_sessions` old JOIN `workspaces` ON `workspaces`."id" = old."workspace_id"
JOIN `projects` ON `projects`."id" = `workspaces`."project_id";--> statement-breakpoint
DROP TABLE `ai_sessions`;--> statement-breakpoint
ALTER TABLE `__new_ai_sessions` RENAME TO `ai_sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `ai_sessions_workspace_id_idx` ON `ai_sessions` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `ai_sessions_terminal_session_id_idx` ON `ai_sessions` (`terminal_session_id`);--> statement-breakpoint
CREATE INDEX `ai_sessions_process_id_idx` ON `ai_sessions` (`process_id`);--> statement-breakpoint
CREATE INDEX `ai_sessions_revision_id_idx` ON `ai_sessions` (`revision_id`);
