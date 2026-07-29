ALTER TABLE `ai_sessions` ADD `history_start_sequence` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_sessions` ADD `history_truncated` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_turns` ADD `output_truncated` integer DEFAULT false NOT NULL;