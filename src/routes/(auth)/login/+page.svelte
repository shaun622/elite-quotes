<script lang="ts">
	import { enhance } from '$app/forms';
	let { form } = $props();
</script>

<svelte:head>
	<title>Sign in — Elite Walls</title>
</svelte:head>

<main>
	<div class="card">
		<div class="brand">
			<span class="logo" aria-hidden="true">E</span>
			<h1>Elite Walls</h1>
		</div>

		{#if form?.sent}
			<h2>Check your email</h2>
			<p>
				We sent a sign-in link to <strong>{form.email}</strong>. The link expires in 10 minutes.
			</p>
			<p class="muted">You can close this tab — the link opens a new session.</p>
		{:else}
			<h2>Sign in</h2>
			<p class="muted">Magic link only. No password to forget.</p>
			<form method="POST" use:enhance>
				<label for="email">Email</label>
				<input
					id="email"
					name="email"
					type="email"
					required
					autocomplete="email"
					inputmode="email"
					placeholder="you@elitewalls.com.au"
					value={form?.email ?? ''}
				/>
				{#if form?.error}
					<p class="error" role="alert">{form.error}</p>
				{/if}
				<button type="submit">Send sign-in link</button>
			</form>
		{/if}
	</div>
</main>

<style>
	main {
		min-height: 100dvh;
		display: grid;
		place-items: center;
		padding: 1.5rem;
	}
	.card {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 14px;
		padding: 2rem;
		width: 100%;
		max-width: 28rem;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 2rem;
	}
	.logo {
		display: inline-grid;
		place-items: center;
		width: 36px;
		height: 36px;
		border-radius: 8px;
		background: var(--accent);
		color: var(--accent-fg);
		font-weight: 800;
	}
	.brand h1 {
		font-size: 1rem;
		margin: 0;
		font-weight: 600;
	}
	h2 {
		font-size: 1.5rem;
		margin: 0 0 0.5rem;
	}
	p {
		margin: 0 0 1rem;
		line-height: 1.5;
	}
	.muted {
		color: var(--text-muted);
	}
	label {
		display: block;
		font-size: 0.875rem;
		font-weight: 500;
		margin-bottom: 0.4rem;
	}
	input {
		width: 100%;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.75rem 0.875rem;
		font-size: 1rem;
		color: var(--text);
		outline: none;
	}
	input:focus {
		border-color: var(--accent);
	}
	button {
		margin-top: 1rem;
		width: 100%;
		padding: 0.875rem 1rem;
		border: none;
		border-radius: 8px;
		background: var(--accent);
		color: var(--accent-fg);
		font-weight: 600;
		font-size: 1rem;
	}
	button:hover {
		filter: brightness(1.05);
	}
	.error {
		color: var(--danger);
		margin-top: 0.75rem;
		font-size: 0.875rem;
	}
</style>
