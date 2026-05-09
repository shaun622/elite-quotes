/**
 * Minimal observability shim. Today: console.error.
 * PR2: swap in @sentry/cloudflare and forward to Sentry — call sites stay the same.
 */
export function captureException(
	err: unknown,
	ctx: Record<string, unknown> = {}
): { id: string } {
	const id = crypto.randomUUID();
	const ts = new Date().toISOString();
	console.error(
		JSON.stringify({
			t: ts,
			level: 'error',
			errorId: id,
			message: err instanceof Error ? err.message : String(err),
			stack: err instanceof Error ? err.stack : undefined,
			...ctx
		})
	);
	return { id };
}
