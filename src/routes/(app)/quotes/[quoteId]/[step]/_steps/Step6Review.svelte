<script lang="ts">
	import type { QuoteData } from '$lib/schemas/quote';
	import { multiPolylineLengthMeters, pathToSegments } from '$lib/wall-math';

	let {
		quoteId,
		quoteNumber,
		data
	}: {
		quoteId: string;
		quoteNumber: number;
		data: QuoteData;
	} = $props();

	const totalLength = $derived(() =>
		data.walls.reduce(
			(s, w) => s + multiPolylineLengthMeters(pathToSegments(w.pathGeoJson ?? null)),
			0
		)
	);

	function fmtMoney(cents: number): string {
		return (cents / 100).toLocaleString('en-AU', {
			style: 'currency',
			currency: 'AUD',
			minimumFractionDigits: 2,
			maximumFractionDigits: 2
		});
	}
</script>

<div class="step6">
	<header>
		<h2>Review &amp; export</h2>
		<p class="muted">
			Final check before sending. PDF rendering ships in the next PR. For now the canonical JSON
			at <code>/api/quotes/{quoteId}.json</code> is ready to consume.
		</p>
	</header>

	<section class="card">
		<h3>Quote summary</h3>
		<dl>
			<div>
				<dt>Quote number</dt>
				<dd>EW-{quoteNumber}</dd>
			</div>
			<div>
				<dt>Type</dt>
				<dd>{data.quoteType === 'civil' ? 'Civil' : 'Residential'}</dd>
			</div>
			<div>
				<dt>Client</dt>
				<dd>{data.client.name || '—'}</dd>
			</div>
			<div>
				<dt>Site</dt>
				<dd>{data.site.address || '—'}</dd>
			</div>
			<div>
				<dt>Walls</dt>
				<dd>
					{data.walls.length} wall{data.walls.length === 1 ? '' : 's'} · {totalLength().toFixed(2)} m total
				</dd>
			</div>
			<div>
				<dt>Max retained</dt>
				<dd>
					{#if data.quoteType === 'civil' && data.walls.length}
						{Math.max(
							0,
							...data.walls.flatMap((w) => w.posts.map((p) => p.rglMm - p.nglMm))
						)} mm
					{:else}
						{data.resiQuick.maxRetainedMm || '—'} mm
					{/if}
				</dd>
			</div>
			<div>
				<dt>Wall type</dt>
				<dd>{data.resiQuick.wallType || '—'}</dd>
			</div>
			<div>
				<dt>Engineer cert</dt>
				<dd>{data.meta.flags.engineerCertRequired ? '⚠ Required' : '✓ Not required'}</dd>
			</div>
		</dl>
	</section>

	{#if data.scope}
		<section class="card">
			<h3>Scope</h3>
			<p class="scope">{data.scope}</p>
		</section>
	{/if}

	{#if data.allowances.length > 0}
		<section class="card">
			<h3>Allowances</h3>
			<table>
				<thead>
					<tr>
						<th>Item</th>
						<th>Qty</th>
						<th>Unit</th>
						<th>Notes</th>
					</tr>
				</thead>
				<tbody>
					{#each data.allowances as a (a.id)}
						<tr>
							<td>{a.label}</td>
							<td>{a.quantity || '—'}</td>
							<td>{a.unit || '—'}</td>
							<td class="muted">{a.notes}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>
	{/if}

	<section class="card">
		<h3>Pricing</h3>
		<dl>
			<div>
				<dt>Subtotal</dt>
				<dd>{fmtMoney(data.pricing.subtotalCents)}</dd>
			</div>
			<div>
				<dt>Margin</dt>
				<dd>{data.pricing.marginPct}%</dd>
			</div>
			<div>
				<dt>GST</dt>
				<dd>{data.pricing.gstPct}%</dd>
			</div>
			<div class="emph">
				<dt>Total inc GST</dt>
				<dd>{fmtMoney(data.pricing.totalCents)}</dd>
			</div>
		</dl>
	</section>

	<section class="card actions">
		<a
			class="btn-primary"
			href="/api/quotes/{quoteId}/pdf?template=client"
			target="_blank"
			rel="noopener"
		>
			Generate client PDF
		</a>
		<a
			class="btn-secondary"
			href="/api/quotes/{quoteId}/pdf?template=installer"
			target="_blank"
			rel="noopener"
		>
			Generate installer take-off
		</a>
		<p class="muted small">
			Opens in a new tab and downloads. The installer take-off is the same layout minus pricing.
			Push-to-Xero ships in a follow-up.
		</p>
	</section>
</div>

<style>
	.step6 {
		max-width: 56rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	header h2 {
		font-size: 1.25rem;
		margin: 0 0 0.25rem;
	}
	header p {
		margin: 0 0 0.5rem;
	}
	code {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		background: var(--surface);
		padding: 0.05rem 0.3rem;
		border-radius: 4px;
	}
	.muted {
		color: var(--text-muted);
	}
	.small {
		font-size: 0.78rem;
	}

	.card {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 1rem 1.25rem;
	}
	.card h3 {
		margin: 0 0 0.75rem;
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-muted);
		font-weight: 600;
	}

	dl {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
		gap: 0.5rem 1.5rem;
		margin: 0;
	}
	dl > div {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}
	dt {
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
	}
	dd {
		margin: 0;
		font-weight: 500;
	}
	dl .emph dd {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 1.1rem;
		font-weight: 700;
	}

	.scope {
		margin: 0;
		white-space: pre-wrap;
		line-height: 1.5;
		color: var(--text);
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85rem;
	}
	th,
	td {
		text-align: left;
		padding: 0.4rem 0.5rem;
		border-bottom: 1px solid var(--border);
	}
	th {
		color: var(--text-muted);
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		font-weight: 600;
	}

	.actions {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		align-items: flex-start;
	}
	.btn-primary,
	.btn-secondary {
		padding: 0.625rem 1.25rem;
		border-radius: 8px;
		font-weight: 600;
		font-size: 0.9rem;
		border: 1px solid transparent;
		cursor: pointer;
	}
	.btn-primary {
		background: var(--accent);
		color: var(--accent-fg);
	}
	.btn-secondary {
		background: transparent;
		border-color: var(--border);
		color: var(--text);
	}
	.btn-primary:disabled,
	.btn-secondary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
