CREATE TABLE `review_group_members` (
	`owner_id` text NOT NULL,
	`review_id` text NOT NULL,
	`group_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `review_id`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`review_id`) REFERENCES `reviews`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`group_id`) REFERENCES `review_groups`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `review_group_members_owner_idx` ON `review_group_members` (`owner_id`);--> statement-breakpoint
CREATE INDEX `review_group_members_owner_group_idx` ON `review_group_members` (`owner_id`,`group_id`);--> statement-breakpoint
CREATE TABLE `review_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `review_groups_owner_idx` ON `review_groups` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `review_groups_owner_id_unique` ON `review_groups` (`owner_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `review_groups_owner_name_unique` ON `review_groups` (`owner_id`,`name`);