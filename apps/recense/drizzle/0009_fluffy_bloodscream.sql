CREATE TABLE `viewed_files` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`review_id` text NOT NULL,
	`path` text NOT NULL,
	`revision_seq` integer NOT NULL,
	`old_blob` text,
	`new_blob` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`review_id`) REFERENCES `reviews`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`old_blob`) REFERENCES `blobs`(`owner_id`,`sha256`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`new_blob`) REFERENCES `blobs`(`owner_id`,`sha256`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "viewed_files_revision_seq_positive" CHECK("viewed_files"."revision_seq" > 0)
);
--> statement-breakpoint
CREATE INDEX `viewed_files_owner_idx` ON `viewed_files` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `viewed_files_owner_id_unique` ON `viewed_files` (`owner_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `viewed_files_owner_review_path_unique` ON `viewed_files` (`owner_id`,`review_id`,`path`);--> statement-breakpoint
CREATE INDEX `files_owner_revision_path_idx` ON `files` (`owner_id`,`revision_id`,`path`);