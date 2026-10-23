CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`key` text NOT NULL,
	`at` integer NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`tool_name` text,
	`tool_target` text,
	`tool_status` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_session_id_key_unique` ON `events` (`session_id`,`key`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`harness` text NOT NULL,
	`surface` text NOT NULL,
	`parent_id` text,
	`title` text,
	`cwd` text NOT NULL,
	`branch` text,
	`state` text NOT NULL,
	`observed_at` integer NOT NULL,
	`started_at` integer NOT NULL,
	`last_event_at` integer NOT NULL,
	`source_path` text NOT NULL,
	`read_offset` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_source_path_unique` ON `sessions` (`source_path`);--> statement-breakpoint
CREATE TABLE `summaries` (
	`session_id` text PRIMARY KEY NOT NULL,
	`through_event_id` integer NOT NULL,
	`objective` text NOT NULL,
	`progress` text NOT NULL,
	`tried` text NOT NULL,
	`next` text NOT NULL,
	`blockers` text NOT NULL,
	`waiting_on` text NOT NULL,
	`ask` text,
	`outcome` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
