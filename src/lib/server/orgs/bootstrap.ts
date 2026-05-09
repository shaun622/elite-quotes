import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { DB } from '../db';
import { memberships, orgs, users, type Role } from '../db/schema';

export type ResolvedMembership = {
	orgId: string;
	orgSlug: string;
	orgName: string;
	role: Role;
};

/**
 * Resolve the user's primary org and role, creating one if this is the
 * configured `BOOTSTRAP_OWNER_EMAIL` and they have no memberships yet.
 *
 * Any other unmembered user resolves to `null` — caller is expected to
 * surface a "Contact your administrator" error.
 */
export async function resolveOrCreateMembership(opts: {
	db: DB;
	user: { id: string; email: string };
	bootstrapEmail: string;
}): Promise<ResolvedMembership | null> {
	const { db, user, bootstrapEmail } = opts;

	const existing = await db
		.select({ orgId: memberships.orgId, role: memberships.role })
		.from(memberships)
		.where(eq(memberships.userId, user.id))
		.limit(1);

	if (existing.length > 0) {
		const m = existing[0];
		const org = await db.select().from(orgs).where(eq(orgs.id, m.orgId)).limit(1);
		if (org.length === 0) return null; // org was deleted; bail
		return { orgId: org[0].id, orgSlug: org[0].slug, orgName: org[0].name, role: m.role as Role };
	}

	if (user.email.toLowerCase() !== bootstrapEmail.toLowerCase()) {
		return null;
	}

	// Bootstrap path: this user is the configured owner and has no orgs yet.
	const orgId = ulid();
	const now = new Date();
	const slug = 'elite-walls';
	await db.insert(orgs).values({ id: orgId, slug, name: 'Elite Walls', createdAt: now });
	await db.insert(memberships).values({
		id: ulid(),
		orgId,
		userId: user.id,
		role: 'owner',
		createdAt: now
	});
	return { orgId, orgSlug: slug, orgName: 'Elite Walls', role: 'owner' };
}

/**
 * Used by the login form to decide whether to send a magic link at all.
 * Returns true if the email is the bootstrap owner OR is already a member of any org.
 */
export async function isLoginAllowed(opts: {
	db: DB;
	email: string;
	bootstrapEmail: string;
}): Promise<boolean> {
	const { db, email, bootstrapEmail } = opts;

	if (email.toLowerCase() === bootstrapEmail.toLowerCase()) return true;

	const u = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
	if (u.length === 0) return false;
	const m = await db
		.select({ id: memberships.id })
		.from(memberships)
		.where(eq(memberships.userId, u[0].id))
		.limit(1);
	return m.length > 0;
}
