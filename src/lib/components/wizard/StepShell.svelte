<script lang="ts">
	import type { Snippet } from 'svelte';
	import ProgressBar, { type Step } from './ProgressBar.svelte';

	let {
		quoteId,
		current,
		steps,
		quoteNumber,
		children
	}: {
		quoteId: string;
		current: number;
		steps: Step[];
		quoteNumber: number;
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
			<span>Quote #{quoteNumber}</span>
		</div>
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
		margin-bottom: 1.25rem;
	}
	.trail {
		display: flex;
		gap: 0.5rem;
		font-size: 0.8rem;
		color: var(--text-muted);
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
		padding-top: 1.25rem;
		border-top: 1px solid var(--border);
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
