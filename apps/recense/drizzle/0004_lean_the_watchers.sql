CREATE TABLE `doc_assets` (
	`owner_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`doc_id` text NOT NULL,
	`asset_id` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`revision_id`,`doc_id`) REFERENCES `files`(`owner_id`,`revision_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`revision_id`,`asset_id`) REFERENCES `files`(`owner_id`,`revision_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `doc_assets_owner_idx` ON `doc_assets` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `doc_assets_owner_doc_asset_unique` ON `doc_assets` (`owner_id`,`doc_id`,`asset_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `revisions_content_key_unique` ON `revisions` (`content_key`);
--> statement-breakpoint
INSERT INTO doc_assets (owner_id, revision_id, doc_id, asset_id) SELECT owner_id, revision_id, parent_doc_id, id FROM files WHERE role = 'asset' AND parent_doc_id IS NOT NULL;
