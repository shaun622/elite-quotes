<script lang="ts">
	import { ulid } from 'ulid';
	import type { Allowance, AllowanceKind, QuoteData } from '$lib/schemas/quote';

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

	// --- allowance vocabulary ----------------------------------------------
	type Preset = {
		kind: AllowanceKind;
		label: string;
		unit: string;
		hint?: string;
	};

	const PRESETS: Preset[] = [
		{ kind: 'concrete_sleeper', label: 'Concrete sleeper', unit: 'lm', hint: '200 × 75 mm, plain grey' },
		{ kind: 'composite_sleeper', label: 'Composite sleeper', unit: 'lm', hint: '200 × 65 mm, Woodlands grey' },
		{ kind: 'timber_sleeper', label: 'Timber sleeper', unit: 'lm' },
		{ kind: 'steel_post', label: 'Steel post (100UC14.8 galv)', unit: 'ea' },
		{ kind: 'concrete_pier', label: 'Concrete pier (N25, 300 Ø)', unit: 'ea' },
		{ kind: 'gravel_drainage', label: 'Drainage gravel (20/40 mm)', unit: 'm³' },
		{ kind: 'ag_pipe', label: 'Ag pipe (100 mm slotted)', unit: 'lm' },
		{ kind: 'geotextile', label: 'Geotextile membrane', unit: 'm²' },
		{ kind: 'fence_bracket', label: 'Fence bracket (6 mm)', unit: 'ea' },
		{ kind: 'colourbond_top', label: 'Colourbond fence on top', unit: 'lm' },
		{ kind: 'gate_remove', label: 'Remove + dump gate', unit: 'ea' },
		{ kind: 'excavation', label: 'Excavation', unit: 'm³' },
		{ kind: 'spoil_disposal', label: 'Spoil disposal', unit: 'm³' },
		{ kind: 'engineer_cert', label: "Engineer's certification (Form 15)", unit: 'ea' },
		{ kind: 'mobilisation', label: 'Mobilisation / demobilisation', unit: 'ea' }
	];

	function addPreset(p: Preset) {
		const row: Allowance = {
			id: ulid(),
			kind: p.kind,
			label: p.label,
			quantity: '',
			unit: p.unit,
			notes: p.hint ?? ''
		};
		data.allowances = [...data.allowances, row];
		scheduleSave();
	}

	function addCustom() {
		const row: Allowance = {
			id: ulid(),
			kind: 'custom',
			label: '',
			quantity: '',
			unit: '',
			notes: ''
		};
		data.allowances = [...data.allowances, row];
		scheduleSave();
	}

	function removeRow(id: string) {
		data.allowances = data.allowances.filter((r) => r.id !== id);
		scheduleSave();
	}

	function updateRow<K extends keyof Allowance>(id: string, field: K, value: Allowance[K]) {
		const idx = data.allowances.findIndex((r) => r.id === id);
		if (idx === -1) return;
		data.allowances[idx][field] = value;
		scheduleSave();
	}

	const usedKinds = $derived(() => new Set(data.allowances.map((a) => a.kind)));
</script>

<div class="step4">
	<header>
		<h2>Scope &amp; allowances</h2>
		<p class="muted">
			Describe the job in plain English, then list everything you've allowed for. The client sees
			the scope verbatim on the quote and can use the allowances list if anything has to be
			back-charged later.
		</p>
	</header>

	<section class="scope">
		<label>
			<span>Scope description</span>
			<textarea
				rows="4"
				bind:value={data.scope}
				oninput={scheduleSave}
				placeholder="e.g. Featured Concrete sleeper, 28.5 m fencing and retaining, 600 mm to 400 mm retaining, 1.5 m Colourbond on top of wall, remove and dump double gate and return panels on left side of the property."
			></textarea>
		</label>
	</section>

	<section class="allowances">
		<header class="allow-head">
			<h3>Allowances</h3>
			<span class="muted">{data.allowances.length} item{data.allowances.length === 1 ? '' : 's'}</span>
		</header>

		{#if data.allowances.length === 0}
			<div class="empty">
				<p class="muted">No allowances yet. Tap a preset below to add a common one, or hit "Custom".</p>
			</div>
		{:else}
			<ul class="rows">
				{#each data.allowances as row (row.id)}
					<li>
						<input
							class="row-label"
							type="text"
							placeholder="Item"
							value={row.label}
							oninput={(e) => updateRow(row.id, 'label', (e.currentTarget as HTMLInputElement).value)}
						/>
						<input
							class="row-qty"
							type="text"
							placeholder="Qty"
							value={row.quantity}
							inputmode="decimal"
							oninput={(e) => updateRow(row.id, 'quantity', (e.currentTarget as HTMLInputElement).value)}
						/>
						<input
							class="row-unit"
							type="text"
							placeholder="Unit"
							value={row.unit}
							oninput={(e) => updateRow(row.id, 'unit', (e.currentTarget as HTMLInputElement).value)}
						/>
						<input
							class="row-notes"
							type="text"
							placeholder="Notes"
							value={row.notes}
							oninput={(e) => updateRow(row.id, 'notes', (e.currentTarget as HTMLInputElement).value)}
						/>
						<button
							type="button"
							class="row-rm"
							onclick={() => removeRow(row.id)}
							aria-label="Remove this allowance"
							title="Remove"
						>
							×
						</button>
					</li>
				{/each}
			</ul>
		{/if}

		<div class="presets">
			<span class="muted small">Add common item:</span>
			{#each PRESETS as p (p.kind)}
				<button
					type="button"
					class="preset"
					class:used={usedKinds().has(p.kind)}
					onclick={() => addPreset(p)}
				>
					+ {p.label}
				</button>
			{/each}
			<button type="button" class="preset custom" onclick={addCustom}>+ Custom</button>
		</div>
	</section>

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
	.step4 {
		max-width: 56rem;
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}
	header h2 {
		font-size: 1.25rem;
		margin: 0 0 0.25rem;
	}
	header p {
		margin: 0;
	}
	.muted {
		color: var(--text-muted);
	}
	.small {
		font-size: 0.72rem;
	}

	.scope label {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		font-size: 0.85rem;
		color: var(--text-muted);
	}
	.scope textarea {
		width: 100%;
		box-sizing: border-box;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.625rem 0.75rem;
		font-size: 0.95rem;
		color: var(--text);
		outline: none;
		font-family: inherit;
		min-height: 6rem;
		resize: vertical;
	}
	.scope textarea:focus {
		border-color: var(--accent);
	}

	.allowances {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
	}
	.allow-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 1rem;
		margin: 0;
	}
	.allow-head h3 {
		margin: 0;
		font-size: 0.85rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-muted);
		font-weight: 600;
	}
	.empty {
		padding: 1.25rem;
		border: 1px dashed var(--border);
		border-radius: 10px;
		text-align: center;
	}

	.rows {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.rows li {
		display: grid;
		grid-template-columns: minmax(0, 2.5fr) 5rem 4rem minmax(0, 3fr) auto;
		gap: 0.45rem;
		align-items: center;
		padding: 0.4rem 0.55rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 8px;
	}
	.rows input {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.35rem 0.5rem;
		font-size: 0.85rem;
		color: var(--text);
		outline: none;
		min-width: 0;
		width: 100%;
		box-sizing: border-box;
	}
	.rows input:focus {
		border-color: var(--accent);
	}
	.row-rm {
		background: transparent;
		border: 1px solid transparent;
		color: var(--text-muted);
		width: 28px;
		height: 28px;
		border-radius: 6px;
		cursor: pointer;
		font-size: 1.2rem;
		line-height: 1;
		padding: 0;
	}
	.row-rm:hover {
		color: var(--danger);
		border-color: var(--danger);
	}

	.presets {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		align-items: center;
		padding: 0.6rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 10px;
	}
	.preset {
		background: transparent;
		border: 1px solid var(--border);
		color: var(--text);
		padding: 0.25rem 0.55rem;
		border-radius: 999px;
		font-size: 0.75rem;
		cursor: pointer;
	}
	.preset:hover {
		border-color: var(--accent);
		color: var(--accent);
	}
	.preset.used {
		opacity: 0.55;
	}
	.preset.custom {
		border-color: var(--accent);
		color: var(--accent);
	}

	.status {
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

	@media (max-width: 720px) {
		.rows li {
			grid-template-columns: 1fr 4rem 3.5rem auto;
		}
		.row-notes {
			grid-column: 1 / -1;
		}
	}
</style>
