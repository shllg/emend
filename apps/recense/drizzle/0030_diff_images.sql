CREATE TABLE `diff_images` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`file_id` text NOT NULL,
	`side` text NOT NULL,
	`blob` text,
	`flag` text,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`file_id`) REFERENCES `files`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`blob`) REFERENCES `blobs`(`owner_id`,`sha256`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "diff_images_side_check" CHECK("diff_images"."side" in ('old', 'new')),
	CONSTRAINT "diff_images_flag_check" CHECK("diff_images"."flag" in ('oversized')),
	CONSTRAINT "diff_images_payload_check" CHECK(("diff_images"."blob" is null) <> ("diff_images"."flag" is null))
);
--> statement-breakpoint
CREATE INDEX `diff_images_owner_idx` ON `diff_images` (`owner_id`);--> statement-breakpoint
CREATE INDEX `diff_images_owner_blob_idx` ON `diff_images` (`owner_id`,`blob`);--> statement-breakpoint
CREATE UNIQUE INDEX `diff_images_owner_id_unique` ON `diff_images` (`owner_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `diff_images_owner_file_side_unique` ON `diff_images` (`owner_id`,`file_id`,`side`);