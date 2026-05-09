<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { LayoutData } from './$types';
	let { data, children }: { data: LayoutData; children?: Snippet } = $props();
</script>

<div class="shell">
	<header>
		<a class="brand" href="/quotes">
			<span class="logo" aria-hidden="true">E</span>
			<span class="brand-text">
				<span class="brand-name">Elite Walls</span>
				<span class="brand-org">{data.org.name}</span>
			</span>
		</a>
		<nav>
			<a href="/quotes">Quotes</a>
		</nav>
		<form method="POST" action="/sign-out">
			<button class="signout" type="submit" aria-label="Sign out">
				{data.user.email} · Sign out
			</button>
		</form>
	</header>

	<main>
		{@render children?.()}
	</main>
</div>

<style>
	.shell {
		min-height: 100dvh;
		display: flex;
		flex-direction: column;
	}
	header {
		display: flex;
		align-items: center;
		gap: 1.5rem;
		padding: 0.75rem 1.25rem;
		border-bottom: 1px solid var(--border);
		background: var(--surface);
		position: sticky;
		top: 0;
		z-index: 10;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		text-decoration: none;
		color: var(--text);
	}
	.logo {
		display: inline-grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border-radius: 6px;
		background: var(--accent);
		color: var(--accent-fg);
		font-weight: 800;
		font-size: 0.875rem;
	}
	.brand-text {
		display: flex;
		flex-direction: column;
		line-height: 1.1;
	}
	.brand-name {
		font-weight: 600;
		font-size: 0.95rem;
	}
	.brand-org {
		font-size: 0.75rem;
		color: var(--text-muted);
	}
	nav {
		display: flex;
		gap: 1rem;
		flex: 1;
	}
	nav a {
		color: var(--text-muted);
		font-size: 0.9rem;
	}
	nav a:hover {
		color: var(--text);
		text-decoration: none;
	}
	.signout {
		background: transparent;
		border: 1px solid var(--border);
		color: var(--text-muted);
		font-size: 0.8rem;
		padding: 0.4rem 0.75rem;
		border-radius: 6px;
	}
	.signout:hover {
		color: var(--text);
		border-color: var(--text-muted);
	}
	main {
		flex: 1;
		display: block;
	}
</style>
