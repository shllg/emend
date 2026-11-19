CREATE TABLE `review_pins` (
	`owner_id` text NOT NULL,
	`review_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `review_id`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`review_id`) REFERENCES `reviews`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `review_pins_owner_idx` ON `review_pins` (`owner_id`);