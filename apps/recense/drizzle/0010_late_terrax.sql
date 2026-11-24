CREATE TABLE `agent_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`file_id` text NOT NULL,
	`side` text NOT NULL,
	`start_line` integer NOT NULL,
	`end_line` integer NOT NULL,
	`summary` text NOT NULL,
	`rationale` text,
	`ref` text,
	`ord` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`file_id`) REFERENCES `files`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_notes_side_check" CHECK("agent_notes"."side" in ('old', 'new')),
	CONSTRAINT "agent_notes_range_check" CHECK("agent_notes"."start_line" >= 1 and "agent_notes"."end_line" >= "agent_notes"."start_line"),
	CONSTRAINT "agent_notes_ord_check" CHECK("agent_notes"."ord" between 0 and 7)
);
--> statement-breakpoint
CREATE INDEX `agent_notes_owner_idx` ON `agent_notes` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_notes_owner_id_unique` ON `agent_notes` (`owner_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_notes_owner_file_ord_unique` ON `agent_notes` (`owner_id`,`file_id`,`ord`);