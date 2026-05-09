-- Elite Walls — initial schema
-- Generated to match src/lib/server/db/schema.ts
-- Run via: wrangler d1 migrations apply elite-walls --local
--      or: wrangler d1 migrations apply elite-walls --remote

PRAGMA foreign_keys = ON;

-- ----- orgs ------------------------------------------------------------------
CREATE TABLE `orgs` (
	`id` TEXT PRIMARY KEY NOT NULL,
	`slug` TEXT NOT NULL,
	`name` TEXT NOT NULL,
	`created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX `orgs_slug_uq` ON `orgs` (`slug`);

-- ----- users (Better Auth-owned) --------------------------------------------
CREATE TABLE `users` (
	`id` TEXT PRIMARY KEY NOT NULL,
	`email` TEXT NOT NULL,
	`email_verified` INTEGER NOT NULL DEFAULT 0,
	`name` TEXT,
	`image` TEXT,
	`created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
	`updated_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
	`last_login_at` INTEGER
);
CREATE UNIQUE INDEX `users_email_uq` ON `users` (`email`);

-- ----- accounts (Better Auth) ------------------------------------------------
CREATE TABLE `accounts` (
	`id` TEXT PRIMARY KEY NOT NULL,
	`user_id` TEXT NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`account_id` TEXT NOT NULL,
	`provider_id` TEXT NOT NULL,
	`access_token` TEXT,
	`refresh_token` TEXT,
	`id_token` TEXT,
	`access_token_expires_at` INTEGER,
	`refresh_token_expires_at` INTEGER,
	`scope` TEXT,
	`password` TEXT,
	`created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
	`updated_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX `accounts_user_idx` ON `accounts` (`user_id`);

-- ----- verifications (Better Auth: magic-link + email-verify tokens) --------
CREATE TABLE `verifications` (
	`id` TEXT PRIMARY KEY NOT NULL,
	`identifier` TEXT NOT NULL,
	`value` TEXT NOT NULL,
	`expires_at` INTEGER NOT NULL,
	`created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
	`updated_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX `verifications_identifier_idx` ON `verifications` (`identifier`);

-- ----- memberships (roles live here, not on users) --------------------------
CREATE TABLE `memberships` (
	`id` TEXT PRIMARY KEY NOT NULL,
	`org_id` TEXT NOT NULL REFERENCES `orgs`(`id`) ON DELETE CASCADE,
	`user_id` TEXT NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`role` TEXT NOT NULL CHECK (`role` IN ('owner','estimator','viewer')),
	`created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX `memberships_org_user_uq` ON `memberships` (`org_id`, `user_id`);
CREATE INDEX `memberships_user_idx` ON `memberships` (`user_id`);

-- ----- quotes (envelope, mutable head pointer) ------------------------------
CREATE TABLE `quotes` (
	`id` TEXT PRIMARY KEY NOT NULL,
	`org_id` TEXT NOT NULL REFERENCES `orgs`(`id`) ON DELETE CASCADE,
	`quote_number` INTEGER NOT NULL,
	`client_name` TEXT,
	`site_address` TEXT,
	`current_version_id` TEXT,
	`status` TEXT NOT NULL DEFAULT 'draft' CHECK (`status` IN ('draft','sent','accepted','archived')),
	`created_by` TEXT NOT NULL REFERENCES `users`(`id`),
	`created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
	`updated_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX `quotes_org_number_uq` ON `quotes` (`org_id`, `quote_number`);
CREATE INDEX `quotes_org_updated_idx` ON `quotes` (`org_id`, `updated_at`);

-- ----- quote_versions (append-only, parent_id chain) ------------------------
CREATE TABLE `quote_versions` (
	`id` TEXT PRIMARY KEY NOT NULL,
	`quote_id` TEXT NOT NULL REFERENCES `quotes`(`id`) ON DELETE CASCADE,
	`org_id` TEXT NOT NULL REFERENCES `orgs`(`id`) ON DELETE CASCADE,
	`parent_id` TEXT,
	`version_number` INTEGER NOT NULL,
	`data_json` TEXT NOT NULL,
	`data_hash` TEXT NOT NULL,
	`pdf_client_r2_key` TEXT,
	`pdf_installer_r2_key` TEXT,
	`created_by` TEXT NOT NULL REFERENCES `users`(`id`),
	`created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX `qv_quote_version_idx` ON `quote_versions` (`quote_id`, `version_number`);
CREATE INDEX `qv_parent_idx` ON `quote_versions` (`parent_id`);

-- ----- audit_log -------------------------------------------------------------
CREATE TABLE `audit_log` (
	`id` TEXT PRIMARY KEY NOT NULL,
	`org_id` TEXT NOT NULL,
	`actor_user_id` TEXT,
	`entity_type` TEXT NOT NULL,
	`entity_id` TEXT NOT NULL,
	`action` TEXT NOT NULL,
	`diff_json` TEXT,
	`ip` TEXT,
	`ua` TEXT,
	`created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX `audit_org_entity_idx` ON `audit_log` (`org_id`, `entity_id`, `created_at`);
