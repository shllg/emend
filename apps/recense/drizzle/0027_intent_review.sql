ALTER TABLE `reviews` ADD `intent_review_id` text;--> statement-breakpoint
CREATE INDEX `reviews_owner_intent_idx` ON `reviews` (`owner_id`,`intent_review_id`);