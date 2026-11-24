CREATE TABLE `review_tombstones` (
	`owner_id` text NOT NULL,
	`review_id` text NOT NULL,
	`deleted_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `review_id`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `review_tombstones_owner_idx` ON `review_tombstones` (`owner_id`);--> statement-breakpoint
ALTER TABLE `reviews` ADD `snoozed_at` integer;--> statement-breakpoint
ALTER TABLE `reviews` ADD `snoozed_until` integer;--> statement-breakpoint
ALTER TABLE `reviews` ADD `released_at` integer;--> statement-breakpoint
ALTER TABLE `reviews` ADD `released_reason` text CONSTRAINT `reviews_released_reason_check` CHECK(`released_reason` in ('snoozed', 'retired'));--> statement-breakpoint
CREATE INDEX `reviews_owner_state_updated_idx` ON `reviews` (`owner_id`,`state`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `blobs_sha256_idx` ON `blobs` (`sha256`);--> statement-breakpoint
CREATE INDEX `files_owner_old_blob_idx` ON `files` (`owner_id`,`old_blob`);--> statement-breakpoint
CREATE INDEX `files_owner_new_blob_idx` ON `files` (`owner_id`,`new_blob`);--> statement-breakpoint
CREATE INDEX `files_owner_rendered_blob_idx` ON `files` (`owner_id`,`rendered_blob`);--> statement-breakpoint
CREATE INDEX `viewed_files_owner_old_blob_idx` ON `viewed_files` (`owner_id`,`old_blob`);--> statement-breakpoint
CREATE INDEX `viewed_files_owner_new_blob_idx` ON `viewed_files` (`owner_id`,`new_blob`);--> statement-breakpoint
CREATE INDEX `writeups_owner_source_blob_idx` ON `writeups` (`owner_id`,`source_blob`);--> statement-breakpoint
CREATE INDEX `writeups_owner_rendered_blob_idx` ON `writeups` (`owner_id`,`rendered_blob`);