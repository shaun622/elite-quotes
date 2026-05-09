<script lang="ts">
	import type { QuoteData } from '$lib/schemas/quote';

	type SaveState = 'idle' | 'saving' | 'saved' | 'conflict' | 'error';

	let {
		quoteId,
		data: initialData,
		dataHash: initialHash,
		versionNumber: initialVersion
	}: {
		quoteId: string;
		data: QuoteData;
		dataHash: string;
		versionNumber: number;
	} = $props();

	// Initial values are snapshotted from props on mount. Step navigation
	// re-mounts this component with fresh data, so no reactive prop binding.
	// svelte-ignore state_referenced_locally
	let data = $state(structuredClone(initialData));
	// svelte-ignore state_referenced_locally
	let dataHash = $state(initialHash);
	// svelte-ignore state_referenced_locally
	let versionNumber = $state(initialVersion);
	let saveState: SaveState = $state('idle');
	let errorMessage = $state('');
	// svelte-ignore state_referenced_locally
	let lastSavedHash = $state(initialHash);

	let saveTimer: ReturnType<typeof setTimeout> | null = null;

	function scheduleSave() {
		if (saveTimer) clearTimeout(saveTimer);
		saveState = 'saving';
		saveTimer = setTimeout(save, 600);
	}

	type FreshResponse = { data: QuoteData; dataHash: string; versionNumber: number };
	type SaveResponse = { dataHash: string; versionNumber: number };

	async function save() {
		const idemKey = crypto.randomUUID();
		try {
			const res = await fetch(`/api/quotes/${quoteId}.json`, {
				method: 'PUT',
				headers: {
					'Content-Type': 'application/json',
					'If-Match': `"${dataHash}"`,
					'Idempotency-Key': idemKey
				},
				body: JSON.stringify({ data })
			});

			if (res.status === 409) {
				saveState = 'conflict';
				errorMessage = 'This quote was edited in another window — reloading.';
				// Last-write-wins-with-toast: refetch and replace.
				const fresh = (await fetch(`/api/quotes/${quoteId}.json`).then((r) =>
					r.json()
				)) as FreshResponse;
				data = fresh.data;
				dataHash = fresh.dataHash;
				versionNumber = fresh.versionNumber;
				lastSavedHash = fresh.dataHash;
				setTimeout(() => (saveState = 'idle'), 2500);
				return;
			}
			if (!res.ok) {
				saveState = 'error';
				errorMessage = `Save failed (${res.status}).`;
				return;
			}

			const body = (await res.json()) as SaveResponse;
			dataHash = body.dataHash;
			versionNumber = body.versionNumber;
			lastSavedHash = body.dataHash;
			saveState = 'saved';
			setTimeout(() => {
				if (saveState === 'saved') saveState = 'idle';
			}, 1500);
		} catch (err) {
			saveState = 'error';
			errorMessage = err instanceof Error ? err.message : 'Network error';
		}
	}

	function onBlur() {
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
		}
		void save();
	}
</script>

<div class="form">
	<h2>Client &amp; site</h2>
	<p class="muted">Who is the quote for, and where is the wall going.</p>

	<div class="grid">
		<label>
			<span>Client name</span>
			<input
				type="text"
				bind:value={data.client.name}
				oninput={scheduleSave}
				onblur={onBlur}
				autocomplete="name"
				placeholder="e.g. Sarah Johnson"
			/>
		</label>

		<label>
			<span>Email</span>
			<input
				type="email"
				bind:value={data.client.email}
				oninput={scheduleSave}
				onblur={onBlur}
				autocomplete="email"
				placeholder="sarah@example.com"
			/>
		</label>

		<label>
			<span>Phone</span>
			<input
				type="tel"
				bind:value={data.client.phone}
				oninput={scheduleSave}
				onblur={onBlur}
				autocomplete="tel"
				inputmode="tel"
				placeholder="0400 000 000"
			/>
		</label>

		<label class="full">
			<span>Site address</span>
			<input
				type="text"
				bind:value={data.site.address}
				oninput={scheduleSave}
				onblur={onBlur}
				autocomplete="street-address"
				placeholder="12 Smith St, Brisbane QLD 4000"
			/>
		</label>

		<label class="full">
			<span>Notes</span>
			<textarea
				rows="3"
				bind:value={data.client.notes}
				oninput={scheduleSave}
				onblur={onBlur}
				placeholder="Anything to remember about this client or site"
			></textarea>
		</label>
	</div>

	<div class="status" role="status" aria-live="polite">
		{#if saveState === 'saving'}
			<span class="dot dot-saving"></span> Saving…
		{:else if saveState === 'saved'}
			<span class="dot dot-saved"></span> Saved (v{versionNumber})
		{:else if saveState === 'conflict'}
			<span class="dot dot-warn"></span> {errorMessage}
		{:else if saveState === 'error'}
			<span class="dot dot-err"></span> {errorMessage}
		{:else}
			<span class="dot dot-idle"></span> Up to date (v{versionNumber})
		{/if}
	</div>
</div>

<style>
	.form {
		max-width: 40rem;
	}
	h2 {
		font-size: 1.25rem;
		margin: 0 0 0.25rem;
	}
	.muted {
		color: var(--text-muted);
		margin: 0 0 1.5rem;
	}
	.grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		font-size: 0.85rem;
		color: var(--text-muted);
	}
	label.full {
		grid-column: 1 / -1;
	}
	input,
	textarea {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.625rem 0.75rem;
		font-size: 1rem;
		color: var(--text);
		outline: none;
	}
	input:focus,
	textarea:focus {
		border-color: var(--accent);
	}
	textarea {
		resize: vertical;
		min-height: 4.5rem;
	}
	.status {
		margin-top: 1.25rem;
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.85rem;
		color: var(--text-muted);
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		display: inline-block;
	}
	.dot-idle {
		background: var(--text-muted);
	}
	.dot-saving {
		background: var(--accent);
		animation: pulse 0.9s infinite;
	}
	.dot-saved {
		background: var(--success);
	}
	.dot-warn {
		background: #f3a93b;
	}
	.dot-err {
		background: var(--danger);
	}
	@keyframes pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.4;
		}
	}
	@media (max-width: 640px) {
		.grid {
			grid-template-columns: 1fr;
		}
	}
</style>
