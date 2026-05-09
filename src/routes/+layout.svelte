<script lang="ts">
	import type { Snippet } from 'svelte';
	let { children }: { children?: Snippet } = $props();
</script>

<svelte:head>
	<style>
		:root {
			--bg: #0b0b0c;
			--surface: #15161a;
			--border: #2a2c33;
			--text: #f0f1f4;
			--text-muted: #9ca0aa;
			--accent: #ff8a1c;
			--accent-fg: #1a0f00;
			--danger: #ff5566;
			--success: #2ecc71;
			--radius: 8px;
			--font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
		}
		*,
		*::before,
		*::after {
			box-sizing: border-box;
		}
		html,
		body {
			margin: 0;
			padding: 0;
			background: var(--bg);
			color: var(--text);
			font-family: var(--font);
			-webkit-font-smoothing: antialiased;
		}
		input,
		button,
		select,
		textarea {
			font: inherit;
			color: inherit;
		}
		button {
			cursor: pointer;
		}
		a {
			color: var(--accent);
			text-decoration: none;
		}
		a:hover {
			text-decoration: underline;
		}
	</style>
</svelte:head>

{@render children?.()}
