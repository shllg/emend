CREATE TABLE `agent_waiters` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`review_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`review_id`) REFERENCES `reviews`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_waiters_owner_idx` ON `agent_waiters` (`owner_id`);--> statement-breakpoint
CREATE INDEX `agent_waiters_owner_review_expiry_idx` ON `agent_waiters` (`owner_id`,`review_id`,`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_waiters_owner_id_unique` ON `agent_waiters` (`owner_id`,`id`);