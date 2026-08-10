CREATE TABLE `entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tool_id` integer,
	`epc` text NOT NULL,
	`entered_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`read_count` integer DEFAULT 1 NOT NULL,
	`source` text DEFAULT 'RFID' NOT NULL,
	FOREIGN KEY (`tool_id`) REFERENCES `tools`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tools` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`serial_number` text NOT NULL,
	`epc` text NOT NULL,
	`status` text DEFAULT 'Available' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tools_epc_unique` ON `tools` (`epc`);