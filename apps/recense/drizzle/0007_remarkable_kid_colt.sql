ALTER TABLE `instances` ADD `was_self` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `reviews` ADD `imported_at` integer;--> statement-breakpoint
UPDATE `instances` SET `was_self` = 1;
