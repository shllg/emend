CREATE TABLE `settings` (
	`owner_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `key`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "settings_key_check" CHECK("settings"."key" in ('approvedActiveHours'))
);
--> statement-breakpoint
CREATE INDEX `settings_owner_idx` ON `settings` (`owner_id`);