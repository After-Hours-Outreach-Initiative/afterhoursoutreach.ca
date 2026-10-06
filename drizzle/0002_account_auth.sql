CREATE TABLE `auth_rate_limit` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_rate_limit_expiry` ON `auth_rate_limit` (`expires_at`);--> statement-breakpoint
CREATE TABLE `email_challenge` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`code_hash` text NOT NULL,
	`token_hash` text NOT NULL,
	`return_to` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `email_challenge_expiry` ON `email_challenge` (`expires_at`);--> statement-breakpoint
ALTER TABLE `session` ADD `two_factor_verified` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `two_factor` ADD `verified` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `two_factor` ADD `failed_verification_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `two_factor` ADD `locked_until` integer;
