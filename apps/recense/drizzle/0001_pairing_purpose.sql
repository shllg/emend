PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_pairings` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`purpose` text DEFAULT 'device' NOT NULL,
	`secret_hash` text NOT NULL,
	`code_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`created_by`) REFERENCES `tokens`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pairings_purpose_check" CHECK("__new_pairings"."purpose" in ('device', 'machine'))
);
--> statement-breakpoint
INSERT INTO `__new_pairings`("id", "owner_id", "purpose", "secret_hash", "code_hash", "created_by", "expires_at", "used_at") SELECT "id", "owner_id", 'device', "secret_hash", "code_hash", "created_by", "expires_at", "used_at" FROM `pairings`;--> statement-breakpoint
DROP TABLE `pairings`;--> statement-breakpoint
ALTER TABLE `__new_pairings` RENAME TO `pairings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `pairings_owner_idx` ON `pairings` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `pairings_owner_id_unique` ON `pairings` (`owner_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `pairings_secret_hash_unique` ON `pairings` (`secret_hash`);