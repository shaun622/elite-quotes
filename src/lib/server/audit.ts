import { ulid } from 'ulid';
import type { DB } from './db';
import { auditLog } from './db/schema';

export async function writeAudit(opts: {
	db: DB;
	orgId: string;
	actorUserId: string | null;
	entityType: string;
	entityId: string;
	action: string;
	diff?: unknown;
	ip?: string | null;
	ua?: string | null;
}): Promise<void> {
	await opts.db.insert(auditLog).values({
		id: ulid(),
		orgId: opts.orgId,
		actorUserId: opts.actorUserId,
		entityType: opts.entityType,
		entityId: opts.entityId,
		action: opts.action,
		diffJson: opts.diff === undefined ? null : JSON.stringify(opts.diff),
		ip: opts.ip ?? null,
		ua: opts.ua ?? null,
		createdAt: new Date()
	});
}
