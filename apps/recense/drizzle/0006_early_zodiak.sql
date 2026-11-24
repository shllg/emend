ALTER TABLE `revisions` ADD `main` text;--> statement-breakpoint
ALTER TABLE `revisions` ADD `writeup_empty` integer DEFAULT 0 NOT NULL;