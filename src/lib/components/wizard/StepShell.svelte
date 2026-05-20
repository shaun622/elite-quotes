<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { QuoteType } from '$lib/schemas/quote';
	import ProgressBar, { type Step } from './ProgressBar.svelte';

	let {
		quoteId,
		current,
		steps,
		quoteNumber,
		quoteType = 'residential',
		onTypeChange,
		children
	}: {
		quoteId: string;
		current: number;
		steps: Step[];
		quoteNumber: number;
		quoteType?: QuoteType;
		onTypeChange?: (next: QuoteType) => void;
		children?: Snippet;
	} = $props();

	// Wizard step is fixed for the lifetime of this component instance —
	// route navigation re-mounts it with fresh props. No reactivity needed.
	// svelte-ignore state_referenced_locally
	const prevN = current > 1 ? current - 1 : null;
	// svelte-ignore state_referenced_locally
	const nextN = current < steps.length ? current + 1 : null;
</script>

<ProgressBar {quoteId} {current} {steps} />

<section class="step">
	<header class="step-head">
		<div class="trail">
			<a href="/quotes">Quotes</a>
			<span aria-hidden="true">›</span>
			<span>Quote EW-{quoteNumber}</span>
		</div>
		{#if onTypeChange}
			<label class="type-toggle">
				<span class="type-toggle-label">Type</span>
				<select
					value={quoteType}
					onchange={(e) =>
						onTypeChange?.((e.currentTarget as HTMLSelectElement).value as QuoteType)}
				>
					<option value="residential">Residential</option>
					<option value="civil">Civil</option>
				</select>
			</label>
		{/if}
	</header>

	<div class="step-body">
		{@render children?.()}
	</div>

	<footer class="step-foot">
		{#if prevN}
			<a class="btn ghost" href="/quotes/{quoteId}/{prevN}">← Back</a>
		{:else}
			<span></span>
		{/if}
		{#if nextN}
			<a class="btn primary" href="/quotes/{quoteId}/{nextN}">Continue →</a>
		{:else}
			<span></span>
		{/if}
	</footer>
</section>

<style>
	.step {
		max-width: 56rem;
		margin: 0 auto;
		padding: 1.5rem 1.25rem 6rem;
	}
	.step-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		margin-bottom: 1.25rem;
		flex-wrap: wrap;
	}
	.trail {
		display: flex;
		gap: 0.5rem;
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.type-toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.75rem;
		color: var(--text-muted);
	}
	.type-toggle-label {
		text-transform: uppercase;
		letter-spacing: 0.05em;
		font-weight: 600;
	}
	.type-toggle select {
		background: var(--surface);
		border: 1px solid var(--border);
		color: var(--text);
		padding: 0.3rem 0.55rem;
		border-radius: 6px;
		font-size: 0.85rem;
		outline: none;
	}
	.type-toggle select:focus {
		border-color: var(--accent);
	}
	.trail a {
		color: var(--text-muted);
	}
	.trail a:hover {
		color: var(--text);
	}
	.step-foot {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		margin-top: 2rem;
		padding: 0.875rem 0;
		border-top: 1px solid var(--border);
		position: sticky;
		bottom: 0;
		background: var(--bg);
		z-index: 5;
	}
	.btn {
		display: inline-block;
		padding: 0.625rem 1rem;
		border-radius: 8px;
		font-weight: 600;
		font-size: 0.9rem;
	}
	.btn.primary {
		background: var(--accent);
		color: var(--accent-fg);
	}
	.btn.primary:hover {
		filter: brightness(1.05);
		text-decoration: none;
	}
	.btn.ghost {
		border: 1px solid var(--border);
		color: var(--text);
	}
	.btn.ghost:hover {
		text-decoration: none;
		border-color: var(--text-muted);
	}
</style>
