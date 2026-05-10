<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let pendingDeleteId = $state<string | null>(null);
	let errorMsg = $state('');

	function fmt(ms: number): string {
		const d = new Date(ms);
		return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
	}

	function openQuote(id: string) {
		void goto(`/quotes/${id}/1`);
	}

	/** Row click — only navigate if the click didn't land on an interactive
	 *  child (the delete form, buttons, links). Lets the trash icon and the
	 *  quote-number anchor keep their own behaviours. */
	function onRowClick(e: MouseEvent, id: string) {
		const target = e.target as HTMLElement | null;
		if (!target) return;
		if (target.closest('button, a, form, input')) return;
		openQuote(id);
	}

	function onRowKey(e: KeyboardEvent, id: string) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			openQuote(id);
		}
	}
</script>

<svelte:head>
	<title>Quotes — Elite Walls</title>
</svelte:head>

<section class="page">
	<header class="page-head">
		<h1>Quotes</h1>
		<a class="primary" href="/quotes/new">+ New quote</a>
	</header>

	{#if errorMsg}
		<div class="banner err" role="alert">{errorMsg}</div>
	{/if}

	{#if data.quotes.length === 0}
		<div class="empty">
			<h2>No quotes yet</h2>
			<p>Click <strong>New quote</strong> to start your first one.</p>
		</div>
	{:else}
		<table>
			<thead>
				<tr>
					<th>#</th>
					<th>Client</th>
					<th>Site</th>
					<th>Status</th>
					<th>Updated</th>
					<th class="actions-col" aria-label="Actions"></th>
				</tr>
			</thead>
			<tbody>
				{#each data.quotes as q (q.id)}
					<tr
						class="row"
						class:deleting={pendingDeleteId === q.id}
						tabindex="0"
						role="button"
						aria-label="Open Quote #{q.quoteNumber}"
						onclick={(e) => onRowClick(e, q.id)}
						onkeydown={(e) => onRowKey(e, q.id)}
					>
						<td><a href="/quotes/{q.id}/1" tabindex="-1">{q.quoteNumber}</a></td>
						<td>{q.clientName ?? '—'}</td>
						<td>{q.siteAddress ?? '—'}</td>
						<td><span class="badge {q.status}">{q.status}</span></td>
						<td>{fmt(Number(q.updatedAt))}</td>
						<td class="actions-col">
							<span class="chev" aria-hidden="true">›</span>
							<form
								method="POST"
								action="?/delete"
								use:enhance={({ cancel }) => {
									if (
										!confirm(
											`Delete Quote #${q.quoteNumber}${q.clientName ? ` for ${q.clientName}` : ''}?\n\nThis permanently removes the quote and all its versions. The audit log entry is preserved.`
										)
									) {
										cancel();
										return;
									}
									pendingDeleteId = q.id;
									errorMsg = '';
									return async ({ result, update }) => {
										pendingDeleteId = null;
										if (result.type === 'failure') {
											errorMsg =
												(result.data as { error?: string } | undefined)?.error ??
												'Could not delete this quote.';
										} else if (result.type === 'success') {
											await invalidateAll();
										}
										await update({ reset: false });
									};
								}}
							>
								<input type="hidden" name="quoteId" value={q.id} />
								<button
									type="submit"
									class="delete-btn"
									title="Delete quote"
									aria-label="Delete Quote #{q.quoteNumber}"
									disabled={pendingDeleteId === q.id}
								>
									{#if pendingDeleteId === q.id}
										…
									{:else}
										<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
											<path d="M3 6h18" />
											<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
											<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
											<line x1="10" y1="11" x2="10" y2="17" />
											<line x1="14" y1="11" x2="14" y2="17" />
										</svg>
									{/if}
								</button>
							</form>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</section>

<style>
	.page {
		max-width: 64rem;
		margin: 0 auto;
		padding: 2rem 1.25rem;
	}
	.page-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 1.5rem;
	}
	h1 {
		margin: 0;
		font-size: 1.5rem;
	}
	.primary {
		display: inline-block;
		padding: 0.625rem 1rem;
		background: var(--accent);
		color: var(--accent-fg);
		border-radius: 8px;
		font-weight: 600;
		font-size: 0.9rem;
	}
	.primary:hover {
		text-decoration: none;
		filter: brightness(1.05);
	}
	.banner.err {
		background: rgba(255, 85, 102, 0.1);
		border: 1px solid var(--danger);
		color: var(--danger);
		padding: 0.625rem 0.875rem;
		border-radius: 8px;
		margin-bottom: 1rem;
		font-size: 0.85rem;
	}
	.empty {
		text-align: center;
		padding: 4rem 1rem;
		border: 1px dashed var(--border);
		border-radius: 12px;
		color: var(--text-muted);
	}
	.empty h2 {
		color: var(--text);
		margin: 0 0 0.5rem;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
	}
	th,
	td {
		text-align: left;
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--border);
	}
	th {
		font-weight: 500;
		color: var(--text-muted);
		font-size: 0.8rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	tbody tr.row {
		cursor: pointer;
	}
	tbody tr.row:hover {
		background: rgba(255, 138, 28, 0.06);
	}
	tbody tr.row:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
		background: rgba(255, 138, 28, 0.06);
	}
	tbody tr.deleting {
		opacity: 0.5;
		pointer-events: none;
	}
	.actions-col {
		position: relative;
		white-space: nowrap;
	}
	.chev {
		display: inline-block;
		color: var(--text-muted);
		font-size: 1.3rem;
		line-height: 1;
		margin-right: 0.5rem;
		vertical-align: middle;
		opacity: 0;
		transition: opacity 0.15s, transform 0.15s;
	}
	tbody tr.row:hover .chev,
	tbody tr.row:focus-visible .chev {
		opacity: 0.8;
		transform: translateX(2px);
	}
	a {
		color: var(--accent);
	}
	.badge {
		display: inline-block;
		padding: 0.125rem 0.5rem;
		border-radius: 999px;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		font-weight: 600;
		background: var(--border);
		color: var(--text-muted);
	}
	.badge.draft {
		background: #2a2c33;
		color: #d2d4d8;
	}
	.badge.sent {
		background: #1f3a5b;
		color: #b8d8ff;
	}
	.badge.accepted {
		background: #1f3a25;
		color: #a8e0b3;
	}
	.badge.archived {
		background: #2a2c33;
		color: #6f747d;
	}

	.actions-col {
		text-align: right;
		width: 3rem;
	}
	.delete-btn {
		display: inline-grid;
		place-items: center;
		width: 32px;
		height: 32px;
		border: 1px solid transparent;
		border-radius: 6px;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		transition: color 0.15s, background 0.15s, border-color 0.15s;
	}
	.delete-btn:hover:not(:disabled) {
		color: var(--danger);
		background: rgba(255, 85, 102, 0.08);
		border-color: rgba(255, 85, 102, 0.5);
	}
	.delete-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
