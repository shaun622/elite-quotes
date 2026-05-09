# Elite Walls Quoting App

Retaining-wall quoting for Australian (Brisbane-based) installers. Web-first, designed to work on phones and iPads for on-site residential takeoffs.

> **Status:** PR1 — foundation. Wizard step 1 (Client + Site) is fully wired through the canonical JSON save pipeline. Steps 2–6 are placeholders. Map and elevation designer ship in PR2 / PR3.

## Stack

- **SvelteKit 2** (Svelte 5) on **Cloudflare Pages**
- **Cloudflare D1** (SQLite) via **Drizzle ORM**
- **Cloudflare R2** (PDFs and snapshots — bound but unused in PR1)
- **Cloudflare KV** (sessions via Better Auth `secondaryStorage` + idempotency cache)
- **Better Auth** with magic-link email transport via **Resend**
- **Zod** for canonical quote-JSON validation

## Architecture in one paragraph

Each quote is an envelope that points at the head of an immutable, linear chain of `quote_versions`. The version's `data_json` is the canonical source of truth — PDFs and the takeoff API derive from it, never the reverse. Saves go through `PUT /api/quotes/:id.json` with `If-Match` (ETag = SHA-256 of the prior JSON) and an `Idempotency-Key` header. On `If-Match` mismatch the API returns `409` and the client refetches and replaces local form state — no merging. Every mutation writes an `audit_log` row with org, actor, action, and a shallow diff. Sessions live in KV, not D1.

## Local setup

You'll need: Node 20+, npm, a Cloudflare account, and a Resend account.

```bash
# 1. Install deps
npm install

# 2. Create the local D1 + KV + R2 resources (run once)
npx wrangler d1 create elite-walls
npx wrangler kv:namespace create CACHE
npx wrangler r2 bucket create elite-walls-files
# Paste the database_id into wrangler.toml and the KV id under [[kv_namespaces]].

# 3. Apply migrations to your local D1
npm run db:migrate:local

# 4. Configure secrets for local dev
cp .dev.vars.example .dev.vars
# Edit .dev.vars and fill in:
#   BETTER_AUTH_SECRET (openssl rand -base64 32)
#   RESEND_API_KEY     (resend.com)
#   RESEND_FROM_EMAIL  ("Elite Walls <quotes@yourdomain.com>")
#   BOOTSTRAP_OWNER_EMAIL  (your Elite Walls admin address)
#   PUBLIC_APP_URL     (http://localhost:5173 in dev)

# 5. Run the dev server
npm run dev
```

> **First sign-in:** the bootstrap owner email is the *only* address that can self-create the org on first sign-in. Every other email gets "Contact your administrator" until the invite flow lands in PR2.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | SvelteKit dev server with miniflare bindings |
| `npm run check` | TypeScript + Svelte type check |
| `npm test` | Vitest — schema validation + unit tests |
| `npm run build` | Production build via `adapter-cloudflare` |
| `npm run preview` | Run the built bundle through `wrangler pages dev` |
| `npm run db:generate` | Regenerate Drizzle migrations from `schema.ts` |
| `npm run db:migrate:local` | Apply migrations to local D1 |
| `npm run db:migrate:remote` | Apply migrations to production D1 |
| `npm run db:studio` | Open Drizzle Studio against the configured D1 |
| `npm run deploy` | Build + deploy to Cloudflare Pages (also handled by Pages git integration) |

## Cloudflare Pages deploy

1. Connect the GitHub repo to a Cloudflare Pages project (Pages → "Connect to Git").
2. Build command: `npm run build`. Build output: `.svelte-kit/cloudflare`.
3. Bind D1, KV, R2 in the Pages dashboard (production *and* preview environments).
4. Set production secrets via:
   ```bash
   npx wrangler pages secret put BETTER_AUTH_SECRET
   npx wrangler pages secret put RESEND_API_KEY
   npx wrangler pages secret put RESEND_FROM_EMAIL
   npx wrangler pages secret put BOOTSTRAP_OWNER_EMAIL
   npx wrangler pages secret put PUBLIC_APP_URL
   ```
5. Apply remote migrations:
   ```bash
   npm run db:migrate:remote
   ```

## Data model

| Table | What it holds |
|---|---|
| `orgs` | Tenant. One row for Elite Walls today; multi-tenant from day 1. |
| `users`, `accounts`, `verifications` | Better Auth identity. |
| `memberships` | `org_id × user_id × role` — roles live here, not on users. |
| `quotes` | The envelope. Mutable head pointer (`current_version_id`). |
| `quote_versions` | Append-only. Linear `parent_id` chain. `data_json` is canonical. |
| `audit_log` | Every mutation, with shallow diff. |

`org_id` is denormalised onto `quote_versions` and `audit_log` so every tenant query is one filter wide and accidental cross-tenant reads are structurally hard.

## Canonical save protocol

```
GET  /api/quotes/:id.json
  →  { data, dataHash, versionNumber }
  Headers: ETag: "<dataHash>"

PUT  /api/quotes/:id.json
  Headers: If-Match: "<dataHash>", Idempotency-Key: <uuid>
  Body:    { data: <QuoteData> }
  →  200 { dataHash, versionNumber } | 409 conflict
```

On `409`, **do not merge**. Refetch via GET and replace local state — last-write-wins with a toast warning. See `src/routes/(app)/quotes/[quoteId]/[step]/_steps/Step1Client.svelte` for the reference client.

## What's NOT in PR1

- Map drawing surface (PR2)
- Property-boundary fetch (NSW + QLD WFS adapters, PR2)
- Elevation / RGL designer (PR3)
- PDF rendering (client + installer copies, PR3)
- Engineer-cert auto-flag by postcode (PR3, requires RGL data)
- Org-editable defaults config UI (PR2)
- Member invite flow (PR2 — non-bootstrap signups currently error with "Contact your administrator")

## Reference

Plan file: `C:\Users\USER\.claude\plans\1-stack-sveltekit-glowing-pond.md`.
