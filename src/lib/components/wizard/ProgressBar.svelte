<script lang="ts">
	export type Step = { n: number; label: string };

	let {
		quoteId,
		current,
		steps
	}: {
		quoteId: string;
		current: number;
		steps: Step[];
	} = $props();
</script>

<ol class="bar">
	{#each steps as s (s.n)}
		{@const status = s.n < current ? 'done' : s.n === current ? 'now' : 'todo'}
		<li class={status}>
			<a href="/quotes/{quoteId}/{s.n}">
				<span class="dot">{s.n}</span>
				<span class="label">{s.label}</span>
			</a>
		</li>
	{/each}
</ol>

<style>
	.bar {
		list-style: none;
		display: flex;
		gap: 0;
		padding: 0;
		margin: 0;
		border-bottom: 1px solid var(--border);
		background: var(--surface);
		overflow-x: auto;
	}
	li {
		flex: 1 1 0;
		min-width: 7rem;
	}
	li a {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.875rem 1rem;
		color: var(--text-muted);
		text-decoration: none;
		border-bottom: 2px solid transparent;
		font-size: 0.875rem;
	}
	li a:hover {
		color: var(--text);
		text-decoration: none;
	}
	li.done a {
		color: var(--text);
	}
	li.now a {
		color: var(--accent);
		border-bottom-color: var(--accent);
		font-weight: 600;
	}
	.dot {
		display: inline-grid;
		place-items: center;
		width: 22px;
		height: 22px;
		border-radius: 50%;
		background: var(--border);
		color: var(--text-muted);
		font-size: 0.75rem;
		font-weight: 600;
	}
	li.done .dot {
		background: #2a3a2c;
		color: #a8e0b3;
	}
	li.now .dot {
		background: var(--accent);
		color: var(--accent-fg);
	}
	.label {
		white-space: nowrap;
	}
</style>
