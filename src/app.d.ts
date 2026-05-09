// See https://svelte.dev/docs/kit/types#app
import type { D1Database, R2Bucket, KVNamespace } from '@cloudflare/workers-types';
import type { Role } from '$lib/server/db/schema';

declare global {
	namespace App {
		interface Error {
			code?: string;
			id?: string;
		}
		interface Locals {
			user: { id: string; email: string } | null;
			org: { id: string; slug: string; name: string } | null;
			role: Role | null;
			requestId: string;
		}
		// interface PageData {}
		// interface PageState {}
		interface Platform {
			env: {
				DB: D1Database;
				CACHE: KVNamespace;
				/** Bound in PR3 when PDF rendering ships — see wrangler.toml. */
				FILES?: R2Bucket;
				BETTER_AUTH_SECRET: string;
				RESEND_API_KEY: string;
				RESEND_FROM_EMAIL: string;
				BOOTSTRAP_OWNER_EMAIL: string;
				PUBLIC_APP_URL: string;
				SENTRY_DSN?: string;
				MAPTILER_KEY?: string;
			};
			context: { waitUntil: (promise: Promise<unknown>) => void };
			caches: CacheStorage & { default: Cache };
		}
	}
}

export {};
