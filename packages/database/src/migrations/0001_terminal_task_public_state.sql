DROP INDEX `processes_process_token_unique`;--> statement-breakpoint
ALTER TABLE `processes` DROP COLUMN `container_exec_id`;--> statement-breakpoint
ALTER TABLE `processes` DROP COLUMN `process_token`;--> statement-breakpoint
ALTER TABLE `processes` DROP COLUMN `process_group_id`;--> statement-breakpoint
ALTER TABLE `processes` DROP COLUMN `log_path`;--> statement-breakpoint
ALTER TABLE `task_runs` DROP COLUMN `log_path`;