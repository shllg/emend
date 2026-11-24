CREATE TABLE `blobs` (
	`owner_id` text NOT NULL,
	`sha256` text NOT NULL,
	`size` integer NOT NULL,
	`media_type` text NOT NULL,
	PRIMARY KEY(`owner_id`, `sha256`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "blobs_size_nonnegative" CHECK("blobs"."size" >= 0)
);
--> statement-breakpoint
CREATE INDEX `blobs_owner_idx` ON `blobs` (`owner_id`);--> statement-breakpoint
CREATE TABLE `changed_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`block_id` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`revision_id`) REFERENCES `revisions`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `changed_blocks_owner_idx` ON `changed_blocks` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `changed_blocks_owner_id_unique` ON `changed_blocks` (`owner_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `changed_blocks_revision_block_unique` ON `changed_blocks` (`revision_id`,`block_id`);--> statement-breakpoint
CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`review_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`author` text NOT NULL,
	`body` text NOT NULL,
	`outcome` text,
	`send_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`review_id`,`thread_id`) REFERENCES `threads`(`owner_id`,`review_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`review_id`,`send_id`) REFERENCES `sends`(`owner_id`,`review_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "comments_author_check" CHECK("comments"."author" in ('user', 'agent')),
	CONSTRAINT "comments_outcome_check" CHECK("comments"."outcome" in ('fixed', 'explained', 'held', 'declined'))
);
--> statement-breakpoint
CREATE INDEX `comments_owner_idx` ON `comments` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `comments_owner_id_unique` ON `comments` (`owner_id`,`id`);--> statement-breakpoint
CREATE TABLE `deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`review_id` text NOT NULL,
	`lease_until` integer NOT NULL,
	`confirmed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`review_id`) REFERENCES `reviews`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deliveries_owner_idx` ON `deliveries` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `deliveries_owner_id_unique` ON `deliveries` (`owner_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `deliveries_owner_review_id_unique` ON `deliveries` (`owner_id`,`review_id`,`id`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`instance_id` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`instance_id`) REFERENCES `instances`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "devices_kind_check" CHECK("devices"."kind" in ('browser', 'machine'))
);
--> statement-breakpoint
CREATE INDEX `devices_owner_idx` ON `devices` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `devices_owner_id_unique` ON `devices` (`owner_id`,`id`);--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`path` text NOT NULL,
	`old_path` text,
	`role` text NOT NULL,
	`status` text,
	`topic_slug` text,
	`ord` integer NOT NULL,
	`media_type` text NOT NULL,
	`old_blob` text,
	`new_blob` text,
	`rendered_blob` text,
	`flag` text,
	`parent_doc_id` text,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`revision_id`) REFERENCES `revisions`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`revision_id`,`topic_slug`) REFERENCES `topics`(`owner_id`,`revision_id`,`slug`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`revision_id`,`parent_doc_id`) REFERENCES `files`(`owner_id`,`revision_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`old_blob`) REFERENCES `blobs`(`owner_id`,`sha256`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`new_blob`) REFERENCES `blobs`(`owner_id`,`sha256`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`rendered_blob`) REFERENCES `blobs`(`owner_id`,`sha256`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "files_role_check" CHECK("files"."role" in ('diff', 'doc', 'asset')),
	CONSTRAINT "files_status_check" CHECK("files"."status" in ('added', 'modified', 'deleted', 'renamed', 'mode-changed')),
	CONSTRAINT "files_flag_check" CHECK("files"."flag" in ('binary', 'oversized'))
);
--> statement-breakpoint
CREATE INDEX `files_owner_idx` ON `files` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `files_owner_id_unique` ON `files` (`owner_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `files_owner_revision_id_unique` ON `files` (`owner_id`,`revision_id`,`id`);--> statement-breakpoint
CREATE TABLE `instances` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`is_self` integer DEFAULT false NOT NULL,
	`attached_at` integer,
	`last_seen_at` integer
);
--> statement-breakpoint
CREATE TABLE `owners` (
	`id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pairings` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`secret_hash` text NOT NULL,
	`code_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`created_by`) REFERENCES `tokens`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pairings_owner_idx` ON `pairings` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `pairings_owner_id_unique` ON `pairings` (`owner_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `pairings_secret_hash_unique` ON `pairings` (`secret_hash`);--> statement-breakpoint
CREATE TABLE `placements` (
	`owner_id` text NOT NULL,
	`review_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`status` text NOT NULL,
	`location` text,
	`reason` text,
	PRIMARY KEY(`thread_id`, `revision_id`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`review_id`,`thread_id`) REFERENCES `threads`(`owner_id`,`review_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`review_id`,`revision_id`) REFERENCES `revisions`(`owner_id`,`review_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "placements_status_check" CHECK("placements"."status" in ('placed', 'unplaced')),
	CONSTRAINT "placements_reason_check" CHECK("placements"."reason" in ('block-gone', 'ambiguous', 'topic-gone', 'file-gone', 'lines-gone')),
	CONSTRAINT "placements_shape_check" CHECK(("placements"."status" = 'placed' and "placements"."location" is not null and "placements"."reason" is null) or ("placements"."status" = 'unplaced' and "placements"."location" is null and "placements"."reason" is not null))
);
--> statement-breakpoint
CREATE INDEX `placements_owner_idx` ON `placements` (`owner_id`);--> statement-breakpoint
CREATE TABLE `repos` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `repos_owner_idx` ON `repos` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `repos_owner_id_unique` ON `repos` (`owner_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `repos_owner_key_unique` ON `repos` (`owner_id`,`key`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`origin_instance_id` text NOT NULL,
	`review_key` text NOT NULL,
	`repo_id` text,
	`branch` text,
	`title` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`approved_revision` text,
	`moved_to_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`origin_instance_id`) REFERENCES `instances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`repo_id`) REFERENCES `repos`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`id`,`approved_revision`) REFERENCES `revisions`(`owner_id`,`review_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reviews_state_check" CHECK("reviews"."state" in ('open', 'approved', 'settled'))
);
--> statement-breakpoint
CREATE INDEX `reviews_owner_idx` ON `reviews` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_owner_id_unique` ON `reviews` (`owner_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_owner_origin_key_unique` ON `reviews` (`owner_id`,`origin_instance_id`,`review_key`);--> statement-breakpoint
CREATE TABLE `revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`review_id` text NOT NULL,
	`seq` integer NOT NULL,
	`base` text,
	`head` text,
	`content_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`review_id`) REFERENCES `reviews`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "revisions_seq_positive" CHECK("revisions"."seq" > 0)
);
--> statement-breakpoint
CREATE INDEX `revisions_owner_idx` ON `revisions` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `revisions_owner_id_unique` ON `revisions` (`owner_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `revisions_review_seq_unique` ON `revisions` (`review_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `revisions_owner_review_id_unique` ON `revisions` (`owner_id`,`review_id`,`id`);--> statement-breakpoint
CREATE TABLE `sends` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`review_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`kind` text NOT NULL,
	`mode` text,
	`instruction` text,
	`delivery_id` text,
	`set_aside_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`review_id`) REFERENCES `reviews`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`review_id`,`revision_id`) REFERENCES `revisions`(`owner_id`,`review_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`review_id`,`delivery_id`) REFERENCES `deliveries`(`owner_id`,`review_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sends_kind_check" CHECK("sends"."kind" in ('go', 'approve')),
	CONSTRAINT "sends_mode_check" CHECK("sends"."mode" in ('fix-clear', 'explain', 'fix-all'))
);
--> statement-breakpoint
CREATE INDEX `sends_owner_idx` ON `sends` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sends_owner_id_unique` ON `sends` (`owner_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sends_owner_review_id_unique` ON `sends` (`owner_id`,`review_id`,`id`);--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`review_id` text NOT NULL,
	`target` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`created_revision_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`review_id`) REFERENCES `reviews`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`review_id`,`created_revision_id`) REFERENCES `revisions`(`owner_id`,`review_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "threads_state_check" CHECK("threads"."state" in ('open', 'sent', 'answered', 'resolved'))
);
--> statement-breakpoint
CREATE INDEX `threads_owner_idx` ON `threads` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `threads_owner_id_unique` ON `threads` (`owner_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `threads_owner_review_id_unique` ON `threads` (`owner_id`,`review_id`,`id`);--> statement-breakpoint
CREATE TABLE `tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`instance_id` text,
	`device_id` text,
	`name` text NOT NULL,
	`secret_hash` text NOT NULL,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`instance_id`) REFERENCES `instances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`device_id`) REFERENCES `devices`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tokens_kind_check" CHECK("tokens"."kind" in ('admin', 'agent', 'reviewer')),
	CONSTRAINT "tokens_agent_instance_check" CHECK("tokens"."kind" != 'agent' or "tokens"."instance_id" is not null)
);
--> statement-breakpoint
CREATE INDEX `tokens_owner_idx` ON `tokens` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tokens_owner_id_unique` ON `tokens` (`owner_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tokens_secret_hash_unique` ON `tokens` (`secret_hash`);--> statement-breakpoint
CREATE TABLE `topics` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`importance` real NOT NULL,
	`summary` text NOT NULL,
	`door` text,
	`blast_scope` text,
	`blast_note` text,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`revision_id`) REFERENCES `revisions`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "topics_door_check" CHECK("topics"."door" in ('one-way', 'two-way')),
	CONSTRAINT "topics_importance_range" CHECK("topics"."importance" between 0 and 100)
);
--> statement-breakpoint
CREATE INDEX `topics_owner_idx` ON `topics` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `topics_owner_id_unique` ON `topics` (`owner_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `topics_owner_revision_slug_unique` ON `topics` (`owner_id`,`revision_id`,`slug`);--> statement-breakpoint
CREATE TABLE `writeups` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`source_blob` text NOT NULL,
	`rendered_blob` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`revision_id`) REFERENCES `revisions`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`source_blob`) REFERENCES `blobs`(`owner_id`,`sha256`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`rendered_blob`) REFERENCES `blobs`(`owner_id`,`sha256`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `writeups_owner_idx` ON `writeups` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `writeups_owner_id_unique` ON `writeups` (`owner_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `writeups_revision_unique` ON `writeups` (`revision_id`);