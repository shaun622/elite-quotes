<script lang="ts">
	import type { Snippet } from 'svelte';
	let {
		title,
		body,
		children
	}: {
		title: string;
		body: string;
		children?: Snippet;
	} = $props();
</script>

<div class="placeholder">
	<h2>{title}</h2>
	<p>{body}</p>
	{@render children?.()}
</div>

<style>
	.placeholder {
		padding: 2rem 1.5rem;
		border: 1px dashed var(--border);
		border-radius: 12px;
		background: var(--surface);
	}
	h2 {
		font-size: 1.25rem;
		margin: 0 0 0.5rem;
	}
	p {
		margin: 0 0 0.5rem;
		color: var(--text-muted);
		line-height: 1.55;
	}
</style>
