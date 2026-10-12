DROP INDEX `previews_hostname_unique`;--> statement-breakpoint
DROP INDEX `previews_workspace_preview_key_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `previews_revision_hostname_unique` ON `previews` (`config_revision_id`, `hostname`);--> statement-breakpoint
CREATE UNIQUE INDEX `previews_workspace_revision_preview_key_unique` ON `previews` (`workspace_id`, `config_revision_id`, `preview_key`);
