<script lang="ts">
	import type { QuoteData } from '$lib/schemas/quote';
	import { RESI_WALL_TYPES } from '$lib/schemas/quote';
	import {
		engineerCertThresholdMm,
		isEngineerCertRequired
	} from '$lib/engineering';

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

	// svelte-ignore state_referenced_locally
	let data = $state(structuredClone(initialData));
	// svelte-ignore state_referenced_locally
	let dataHash = $state(initialHash);
	// svelte-ignore state_referenced_locally
	let versionNumber = $state(initialVersion);
	let saveState: SaveState = $state('idle');
	let errorMessage = $state('');

	// --- save protocol -----------------------------------------------------
	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	let saveChain: Promise<void> = Promise.resolve();

	type FreshResponse = { data: QuoteData; dataHash: string; versionNumber: number };
	type SaveResponse = { dataHash: string; versionNumber: number };

	function scheduleSave() {
		if (saveTimer) clearTimeout(saveTimer);
		saveState = 'saving';
		saveTimer = setTimeout(() => void save(), 600);
	}

	function save(): Promise<void> {
		saveChain = saveChain.then(doSave, doSave);
		return saveChain;
	}

	async function doSave() {
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
				const fresh = (await fetch(`/api/quotes/${quoteId}.json`).then((r) =>
					r.json()
				)) as FreshResponse;
				data = fresh.data;
				dataHash = fresh.dataHash;
				versionNumber = fresh.versionNumber;
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
			saveState = 'saved';
			setTimeout(() => {
				if (saveState === 'saved') saveState = 'idle';
			}, 1500);
		} catch (err) {
			saveState = 'error';
			errorMessage = err instanceof Error ? err.message : 'Network error';
		}
	}

	const certCheck = $derived(() =>
		isEngineerCertRequired({
			maxRetainedMm: data.resiQuick.maxRetainedMm,
			state: data.site.state,
			surchargeLoad: data.meta.flags.surchargeLoad
		})
	);

	const threshold = $derived(() => engineerCertThresholdMm(data.site.state));

	$effect(() => {
		const required = certCheck().required;
		if (data.meta.flags.engineerCertRequired !== required) {
			data.meta.flags.engineerCertRequired = required;
			scheduleSave();
		}
	});

	function onMaxHeightInput(e: Event) {
		const v = parseInt((e.currentTarget as HTMLInputElement).value, 10) || 0;
		data.resiQuick.maxRetainedMm = Math.max(0, Math.min(5000, v));
		scheduleSave();
	}

	function onTopperHeightInput(e: Event) {
		const v = parseInt((e.currentTarget as HTMLInputElement).value, 10) || 0;
		data.resiQuick.topperHeightMm = Math.max(0, Math.min(3000, v));
		scheduleSave();
	}

	function toggleSurcharge() {
		data.meta.flags.surchargeLoad = !data.meta.flags.surchargeLoad;
		scheduleSave();
	}
</script>

<div class="step3-resi">
	<header>
		<h2>Heights & wall type</h2>
		<p class="muted">
			Resi quick-fill. For the per-post elevation chart with drag-to-set RGL handles,
			switch the quote type to <strong>Civil</strong> in the header.
		</p>
	</header>

	<div class="grid">
		<label>
			<span>Max retained height</span>
			<div class="input-with-unit">
				<input
					type="number"
					min="0"
					max="5000"
					step="50"
					value={data.resiQuick.maxRetainedMm}
					oninput={onMaxHeightInput}
				/>
				<span class="unit">mm</span>
			</div>
			<small class="muted">Tallest point of the wall above natural ground.</small>
		</label>

		<label>
			<span>Wall type</span>
			<select
				value={data.resiQuick.wallType}
				onchange={(e) => {
					data.resiQuick.wallType = (e.currentTarget as HTMLSelectElement).value;
					scheduleSave();
				}}
			>
				{#each RESI_WALL_TYPES as t (t)}
					<option value={t}>{t}</option>
				{/each}
			</select>
			<small class="muted">Default Concrete sleeper. Switch if the client has chosen another.</small>
		</label>

		<label>
			<span>Topper height (Colourbond etc.)</span>
			<div class="input-with-unit">
				<input
					type="number"
					min="0"
					max="3000"
					step="100"
					value={data.resiQuick.topperHeightMm}
					oninput={onTopperHeightInput}
				/>
				<span class="unit">mm</span>
			</div>
			<small class="muted">0 if no fence on top.</small>
		</label>

		<label>
			<span>Topper type</span>
			<input
				type="text"
				value={data.resiQuick.topperType}
				placeholder="e.g. Colourbond, paling fence, none"
				oninput={(e) => {
					data.resiQuick.topperType = (e.currentTarget as HTMLInputElement).value;
					scheduleSave();
				}}
			/>
		</label>

		<label class="checkbox full">
			<input
				type="checkbox"
				checked={data.meta.flags.surchargeLoad}
				onchange={toggleSurcharge}
			/>
			<span>Surcharge load behind wall (driveway / pool / structure within 1× wall height)</span>
		</label>
	</div>

	<div class="cert" class:required={certCheck().required}>
		{#if certCheck().required}
			<strong>⚠ Engineer cert required</strong>
			<span>{certCheck().reason}</span>
		{:else}
			<strong>✓ Within non-engineered limits</strong>
			<span>
				Max {data.resiQuick.maxRetainedMm} mm ≤ {threshold()} mm threshold for
				{data.site.state ?? 'this state'}.
			</span>
		{/if}
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
	.step3-resi {
		max-width: 44rem;
	}
	header h2 {
		font-size: 1.25rem;
		margin: 0 0 0.25rem;
	}
	header p {
		margin: 0 0 1.5rem;
	}
	.muted {
		color: var(--text-muted);
	}
	.grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	label.full {
		grid-column: 1 / -1;
	}
	input,
	select {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.55rem 0.7rem;
		font-size: 0.95rem;
		color: var(--text);
		outline: none;
	}
	input:focus,
	select:focus {
		border-color: var(--accent);
	}
	.input-with-unit {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.input-with-unit input {
		flex: 1;
		min-width: 0;
	}
	.unit {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		color: var(--text-muted);
		font-size: 0.78rem;
	}
	small {
		font-size: 0.7rem;
		line-height: 1.3;
	}
	.checkbox {
		flex-direction: row;
		align-items: flex-start;
		gap: 0.5rem;
		color: var(--text);
		font-size: 0.85rem;
		cursor: pointer;
		padding-top: 0.5rem;
	}
	.checkbox input {
		margin-top: 0.15rem;
		width: 16px;
		height: 16px;
		accent-color: var(--accent);
	}

	.cert {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		margin-top: 1.25rem;
		padding: 0.875rem 1rem;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--surface);
		font-size: 0.85rem;
	}
	.cert strong {
		color: var(--success);
	}
	.cert.required strong {
		color: #f3a93b;
	}
	.cert span {
		color: var(--text-muted);
		font-size: 0.78rem;
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
