import { and, desc, eq, max } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { DB } from '../db';
import { quotes, quoteVersions, type Quote, type QuoteVersion } from '../db/schema';
import { QuoteDataSchema, emptyQuote, type QuoteData } from '$lib/schemas/quote';
import { writeAudit } from '../audit';

export type QuoteWithVersion = {
	quote: Quote;
	version: QuoteVersion;
	data: QuoteData;
};

export type SaveResult =
	| { ok: true; versionId: string; versionNumber: number; dataHash: string; data: QuoteData }
	| {
			ok: false;
			conflict: { currentDataHash: string; currentVersion: number; data: QuoteData };
	  };

async function nextQuoteNumber(db: DB, orgId: string): Promise<number> {
	const r = await db
		.select({ m: max(quotes.quoteNumber) })
		.from(quotes)
		.where(eq(quotes.orgId, orgId));
	return (r[0]?.m ?? 0) + 1;
}

export async function hashJson(data: unknown): Promise<string> {
	const text = JSON.stringify(data);
	const buf = new TextEncoder().encode(text);
	const digest = await crypto.subtle.digest('SHA-256', buf);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, 32);
}

export async function createDraft(opts: {
	db: DB;
	orgId: string;
	userId: string;
	ip?: string | null;
	ua?: string | null;
}): Promise<{ quoteId: string; quoteNumber: number; dataHash: string; data: QuoteData }> {
	const { db, orgId, userId } = opts;
	const quoteId = ulid();
	const versionId = ulid();
	const now = new Date();
	const quoteNumber = await nextQuoteNumber(db, orgId);

	const data = emptyQuote();
	const dataHash = await hashJson(data);

	await db.insert(quotes).values({
		id: quoteId,
		orgId,
		quoteNumber,
		clientName: null,
		siteAddress: null,
		currentVersionId: null,
		status: 'draft',
		createdBy: userId,
		createdAt: now,
		updatedAt: now
	});

	await db.insert(quoteVersions).values({
		id: versionId,
		quoteId,
		orgId,
		parentId: null,
		versionNumber: 1,
		dataJson: JSON.stringify(data),
		dataHash,
		createdBy: userId,
		createdAt: now
	});

	await db
		.update(quotes)
		.set({ currentVersionId: versionId })
		.where(eq(quotes.id, quoteId));

	await writeAudit({
		db,
		orgId,
		actorUserId: userId,
		entityType: 'quote',
		entityId: quoteId,
		action: 'create',
		ip: opts.ip,
		ua: opts.ua
	});

	return { quoteId, quoteNumber, dataHash, data };
}

export async function getCurrentVersion(opts: {
	db: DB;
	orgId: string;
	quoteId: string;
}): Promise<QuoteWithVersion | null> {
	const { db, orgId, quoteId } = opts;
	const q = await db
		.select()
		.from(quotes)
		.where(and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId)))
		.limit(1);
	if (q.length === 0) return null;
	const quote = q[0];

	const v = quote.currentVersionId
		? await db
				.select()
				.from(quoteVersions)
				.where(eq(quoteVersions.id, quote.currentVersionId))
				.limit(1)
		: await db
				.select()
				.from(quoteVersions)
				.where(eq(quoteVersions.quoteId, quoteId))
				.orderBy(desc(quoteVersions.versionNumber))
				.limit(1);
	if (v.length === 0) return null;
	const version = v[0];

	const parsed = QuoteDataSchema.safeParse(JSON.parse(version.dataJson));
	if (!parsed.success) {
		throw new Error(
			`quote_versions.data_json invalid for ${version.id}: ${parsed.error.message}`
		);
	}
	return { quote, version, data: parsed.data };
}

export async function saveVersion(opts: {
	db: DB;
	orgId: string;
	quoteId: string;
	userId: string;
	expectedDataHash: string;
	newData: QuoteData;
	ip?: string | null;
	ua?: string | null;
}): Promise<SaveResult> {
	const { db, orgId, quoteId, userId, expectedDataHash, newData } = opts;
	const current = await getCurrentVersion({ db, orgId, quoteId });
	if (!current) throw new Error(`quote ${quoteId} not found`);

	if (current.version.dataHash !== expectedDataHash) {
		return {
			ok: false,
			conflict: {
				currentDataHash: current.version.dataHash,
				currentVersion: current.version.versionNumber,
				data: current.data
			}
		};
	}

	const dataHash = await hashJson(newData);
	if (dataHash === expectedDataHash) {
		// Same content, no-op save. Don't write a new row.
		return {
			ok: true,
			versionId: current.version.id,
			versionNumber: current.version.versionNumber,
			dataHash,
			data: newData
		};
	}

	const versionId = ulid();
	const versionNumber = current.version.versionNumber + 1;
	const now = new Date();

	await db.insert(quoteVersions).values({
		id: versionId,
		quoteId,
		orgId,
		parentId: current.version.id,
		versionNumber,
		dataJson: JSON.stringify(newData),
		dataHash,
		createdBy: userId,
		createdAt: now
	});

	await db
		.update(quotes)
		.set({
			currentVersionId: versionId,
			clientName: newData.client.name || null,
			siteAddress: newData.site.address || null,
			updatedAt: now
		})
		.where(and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId)));

	const fields = computeShallowDiff(current.data, newData);

	await writeAudit({
		db,
		orgId,
		actorUserId: userId,
		entityType: 'quote',
		entityId: quoteId,
		action: 'save',
		diff: { from: expectedDataHash, to: dataHash, version: versionNumber, fields },
		ip: opts.ip,
		ua: opts.ua
	});

	return { ok: true, versionId, versionNumber, dataHash, data: newData };
}

export async function listQuotesForOrg(opts: { db: DB; orgId: string; limit?: number }) {
	return opts.db
		.select()
		.from(quotes)
		.where(eq(quotes.orgId, opts.orgId))
		.orderBy(desc(quotes.updatedAt))
		.limit(opts.limit ?? 100);
}

/**
 * Hard-delete a quote. Cascades to `quote_versions` via the FK's
 * `ON DELETE CASCADE`. The audit log row is written BEFORE deletion so we
 * preserve a record of who deleted what — audit_log entries deliberately
 * outlive their entities for compliance.
 */
export async function deleteQuote(opts: {
	db: DB;
	orgId: string;
	userId: string;
	quoteId: string;
	ip?: string | null;
	ua?: string | null;
}): Promise<{ ok: true } | { ok: false; reason: 'not-found' }> {
	const { db, orgId, userId, quoteId } = opts;

	const found = await db
		.select()
		.from(quotes)
		.where(and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId)))
		.limit(1);

	if (found.length === 0) {
		return { ok: false, reason: 'not-found' };
	}
	const quote = found[0];

	await writeAudit({
		db,
		orgId,
		actorUserId: userId,
		entityType: 'quote',
		entityId: quoteId,
		action: 'delete',
		diff: {
			quoteNumber: quote.quoteNumber,
			clientName: quote.clientName,
			siteAddress: quote.siteAddress,
			status: quote.status
		},
		ip: opts.ip,
		ua: opts.ua
	});

	await db
		.delete(quotes)
		.where(and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId)));

	return { ok: true };
}

/** Top-level field paths that changed. Cheap, bounded; full diff is expensive. */
function computeShallowDiff(prev: QuoteData, next: QuoteData): string[] {
	const changed: string[] = [];
	const keys = new Set([...Object.keys(prev), ...Object.keys(next)]) as Set<keyof QuoteData>;
	for (const k of keys) {
		if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) changed.push(String(k));
	}
	return changed;
}
