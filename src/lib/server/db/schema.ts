import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

/* -------------------------------------------------------------------------- */
/*  Roles                                                                     */
/* -------------------------------------------------------------------------- */

export const ROLES = ['owner', 'estimator', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'archived'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

/* -------------------------------------------------------------------------- */
/*  Tenants & users                                                           */
/* -------------------------------------------------------------------------- */

export const orgs = sqliteTable(
	'orgs',
	{
		id: text('id').primaryKey(),
		slug: text('slug').notNull(),
		name: text('name').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
	},
	(t) => [uniqueIndex('orgs_slug_uq').on(t.slug)]
);

// Owned by Better Auth's Drizzle adapter — column names match Better Auth defaults.
export const users = sqliteTable(
	'users',
	{
		id: text('id').primaryKey(),
		email: text('email').notNull(),
		emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
		name: text('name'),
		image: text('image'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		lastLoginAt: integer('last_login_at', { mode: 'timestamp_ms' })
	},
	(t) => [uniqueIndex('users_email_uq').on(t.email)]
);

// Better Auth: links external/social/credential accounts.
export const accounts = sqliteTable(
	'accounts',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		accountId: text('account_id').notNull(),
		providerId: text('provider_id').notNull(),
		accessToken: text('access_token'),
		refreshToken: text('refresh_token'),
		idToken: text('id_token'),
		accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
		refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
		scope: text('scope'),
		password: text('password'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
	},
	(t) => [index('accounts_user_idx').on(t.userId)]
);

// Better Auth: short-lived verification tokens (magic-link, email-verify).
export const verifications = sqliteTable(
	'verifications',
	{
		id: text('id').primaryKey(),
		identifier: text('identifier').notNull(),
		value: text('value').notNull(),
		expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
	},
	(t) => [index('verifications_identifier_idx').on(t.identifier)]
);

/* -------------------------------------------------------------------------- */
/*  Memberships (roles live here, not on users)                               */
/* -------------------------------------------------------------------------- */

export const memberships = sqliteTable(
	'memberships',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id')
			.notNull()
			.references(() => orgs.id, { onDelete: 'cascade' }),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		role: text('role', { enum: ROLES }).notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
	},
	(t) => [
		uniqueIndex('memberships_org_user_uq').on(t.orgId, t.userId),
		index('memberships_user_idx').on(t.userId)
	]
);

/* -------------------------------------------------------------------------- */
/*  Quotes (envelope) + immutable versions                                    */
/* -------------------------------------------------------------------------- */

export const quotes = sqliteTable(
	'quotes',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id')
			.notNull()
			.references(() => orgs.id, { onDelete: 'cascade' }),
		quoteNumber: integer('quote_number').notNull(),
		clientName: text('client_name'),
		siteAddress: text('site_address'),
		// Pointer to current head version. NULL for an empty shell with no versions yet.
		currentVersionId: text('current_version_id'),
		status: text('status', { enum: QUOTE_STATUSES }).notNull().default('draft'),
		createdBy: text('created_by')
			.notNull()
			.references(() => users.id),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
	},
	(t) => [
		uniqueIndex('quotes_org_number_uq').on(t.orgId, t.quoteNumber),
		index('quotes_org_updated_idx').on(t.orgId, t.updatedAt)
	]
);

// Append-only. Never UPDATE except the two pdf_*_r2_key columns after a render.
export const quoteVersions = sqliteTable(
	'quote_versions',
	{
		id: text('id').primaryKey(),
		quoteId: text('quote_id')
			.notNull()
			.references(() => quotes.id, { onDelete: 'cascade' }),
		// Denormalised so every tenant query stays one-line filterable by org.
		orgId: text('org_id')
			.notNull()
			.references(() => orgs.id, { onDelete: 'cascade' }),
		// NULL on the first version; otherwise points at the prior version in the linear chain.
		parentId: text('parent_id'),
		versionNumber: integer('version_number').notNull(),
		dataJson: text('data_json').notNull(),
		dataHash: text('data_hash').notNull(),
		pdfClientR2Key: text('pdf_client_r2_key'),
		pdfInstallerR2Key: text('pdf_installer_r2_key'),
		createdBy: text('created_by')
			.notNull()
			.references(() => users.id),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
	},
	(t) => [
		index('qv_quote_version_idx').on(t.quoteId, t.versionNumber),
		index('qv_parent_idx').on(t.parentId)
	]
);

/* -------------------------------------------------------------------------- */
/*  Audit log                                                                 */
/* -------------------------------------------------------------------------- */

export const auditLog = sqliteTable(
	'audit_log',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		actorUserId: text('actor_user_id'),
		entityType: text('entity_type').notNull(),
		entityId: text('entity_id').notNull(),
		action: text('action').notNull(),
		diffJson: text('diff_json'),
		ip: text('ip'),
		ua: text('ua'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
	},
	(t) => [index('audit_org_entity_idx').on(t.orgId, t.entityId, t.createdAt)]
);

/* -------------------------------------------------------------------------- */
/*  Inferred types                                                            */
/* -------------------------------------------------------------------------- */

export type Org = typeof orgs.$inferSelect;
export type User = typeof users.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type Quote = typeof quotes.$inferSelect;
export type QuoteVersion = typeof quoteVersions.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;
