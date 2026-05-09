<script lang="ts">
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();

	function fmt(ms: number): string {
		const d = new Date(ms);
		return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
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
				</tr>
			</thead>
			<tbody>
				{#each data.quotes as q (q.id)}
					<tr>
						<td><a href="/quotes/{q.id}/1">{q.quoteNumber}</a></td>
						<td>{q.clientName ?? '—'}</td>
						<td>{q.siteAddress ?? '—'}</td>
						<td><span class="badge {q.status}">{q.status}</span></td>
						<td>{fmt(Number(q.updatedAt))}</td>
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
	tbody tr:hover {
		background: rgba(255, 255, 255, 0.02);
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
</style>
