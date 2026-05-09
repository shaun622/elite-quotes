import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink } from 'better-auth/plugins';
import { makeDb } from './db';
import { sendMagicLink } from './email';

/**
 * Build a Better Auth instance for the current request.
 *
 * Cloudflare Workers bindings (D1, KV, secrets) are only available via
 * `event.platform.env`, so we cannot construct a singleton at module top-level.
 * Call this from `hooks.server.ts` and from the `/api/auth/[...all]` handler.
 */
export function makeAuth(env: App.Platform['env']) {
	const db = makeDb(env.DB);

	return betterAuth({
		database: drizzleAdapter(db, {
			provider: 'sqlite',
			usePlural: true
		}),

		// Sessions live in Cloudflare KV, not D1 — avoids a D1 read per request.
		secondaryStorage: {
			get: (key) => env.CACHE.get(key),
			set: (key, value, ttl) =>
				env.CACHE.put(key, value, ttl ? { expirationTtl: ttl } : undefined),
			delete: (key) => env.CACHE.delete(key)
		},

		secret: (env.BETTER_AUTH_SECRET ?? '').trim(),
		baseURL: (env.PUBLIC_APP_URL ?? '').trim(),

		// Trust the same origin only.
		trustedOrigins: [(env.PUBLIC_APP_URL ?? '').trim()],

		emailAndPassword: { enabled: false },

		session: {
			// 30-day rolling session.
			expiresIn: 60 * 60 * 24 * 30,
			updateAge: 60 * 60 * 24,
			cookieCache: { enabled: true, maxAge: 60 * 5 }
		},

		plugins: [
			magicLink({
				expiresIn: 60 * 10, // 10 minutes
				sendMagicLink: async ({ email, url }) => {
					await sendMagicLink({
						to: email,
						url,
						apiKey: env.RESEND_API_KEY,
						from: env.RESEND_FROM_EMAIL
					});
				}
			})
		]
	});
}

export type AuthInstance = ReturnType<typeof makeAuth>;
