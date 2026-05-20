<script lang="ts">
	import { ulid } from 'ulid';
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

	// --- pricing -----------------------------------------------------------
	function toggleMode() {
		data.pricing.mode = data.pricing.mode === 'tiered' ? 'simple' : 'tiered';
		recompute();
		scheduleSave();
	}

	function setLumpSumDollars(v: number) {
		data.pricing.lumpSumCents = Math.max(0, Math.round(v * 100));
		recompute();
		scheduleSave();
	}

	function addTier() {
		data.pricing.tiers = [
			...data.pricing.tiers,
			{ id: ulid(), label: 'Height tier', quantity: 0, unit: 'm2', rateCents: 0 }
		];
		recompute();
		scheduleSave();
	}

	function removeTier(id: string) {
		data.pricing.tiers = data.pricing.tiers.filter((t) => t.id !== id);
		recompute();
		scheduleSave();
	}

	function updateTier(
		id: string,
		field: 'label' | 'quantity' | 'unit' | 'rateCents',
		raw: string
	) {
		const idx = data.pricing.tiers.findIndex((t) => t.id === id);
		if (idx === -1) return;
		if (field === 'quantity') {
			data.pricing.tiers[idx].quantity = Math.max(0, parseFloat(raw) || 0);
		} else if (field === 'rateCents') {
			data.pricing.tiers[idx].rateCents = Math.max(0, Math.round((parseFloat(raw) || 0) * 100));
		} else {
			data.pricing.tiers[idx][field] = raw;
		}
		recompute();
		scheduleSave();
	}

	function setMargin(v: number) {
		data.pricing.marginPct = Math.max(0, Math.min(100, v));
		recompute();
		scheduleSave();
	}

	function setGst(v: number) {
		data.pricing.gstPct = Math.max(0, Math.min(100, v));
		recompute();
		scheduleSave();
	}

	function recompute() {
		const sub =
			data.pricing.mode === 'tiered'
				? data.pricing.tiers.reduce(
						(s, t) => s + Math.round(t.quantity * t.rateCents),
						0
					)
				: data.pricing.lumpSumCents;
		data.pricing.subtotalCents = sub;
		const withMargin = Math.round(sub * (1 + data.pricing.marginPct / 100));
		const withGst = Math.round(withMargin * (1 + data.pricing.gstPct / 100));
		data.pricing.totalCents = withGst;
	}

	// Ensure totals are correct on first mount even if the user hasn't touched anything.
	$effect(() => {
		// re-compute when subtotal-driving fields change
		data.pricing.mode;
		data.pricing.lumpSumCents;
		data.pricing.marginPct;
		data.pricing.gstPct;
		data.pricing.tiers.length;
		recompute();
	});

	function fmtMoney(cents: number): string {
		return (cents / 100).toLocaleString('en-AU', {
			style: 'currency',
			currency: 'AUD',
			minimumFractionDigits: 2,
			maximumFractionDigits: 2
		});
	}
</script>

<div class="step5">
	<header>
		<h2>Pricing</h2>
		<p class="muted">
			Default is a single lump sum. Toggle to <strong>tiered</strong> when the wall has multiple
			height bands and you want each priced per m² separately (like the Be Landscapes civil
			format).
		</p>
	</header>

	<div class="mode-row">
		<label class="mode-toggle">
			<input
				type="checkbox"
				checked={data.pricing.mode === 'tiered'}
				onchange={toggleMode}
			/>
			<span>Tiered pricing (by height band)</span>
		</label>
	</div>

	{#if data.pricing.mode === 'simple'}
		<section class="card">
			<label>
				<span>Lump sum (ex GST)</span>
				<div class="input-with-prefix">
					<span class="prefix">$</span>
					<input
						type="number"
						min="0"
						step="0.01"
						inputmode="decimal"
						value={(data.pricing.lumpSumCents / 100).toFixed(2)}
						oninput={(e) =>
							setLumpSumDollars(parseFloat((e.currentTarget as HTMLInputElement).value) || 0)}
					/>
				</div>
				<small class="muted">Type the total ex-GST price you're quoting the client.</small>
			</label>
		</section>
	{:else}
		<section class="card">
			<ul class="tiers">
				{#each data.pricing.tiers as t (t.id)}
					<li>
						<input
							class="tier-label"
							type="text"
							placeholder="e.g. Height 0–1.0 m"
							value={t.label}
							oninput={(e) =>
								updateTier(t.id, 'label', (e.currentTarget as HTMLInputElement).value)}
						/>
						<input
							class="tier-qty"
							type="number"
							min="0"
							step="0.01"
							inputmode="decimal"
							placeholder="Qty"
							value={t.quantity}
							oninput={(e) =>
								updateTier(t.id, 'quantity', (e.currentTarget as HTMLInputElement).value)}
						/>
						<input
							class="tier-unit"
							type="text"
							placeholder="Unit"
							value={t.unit}
							oninput={(e) =>
								updateTier(t.id, 'unit', (e.currentTarget as HTMLInputElement).value)}
						/>
						<div class="tier-rate">
							<span class="prefix">$</span>
							<input
								type="number"
								min="0"
								step="0.01"
								inputmode="decimal"
								placeholder="Rate"
								value={(t.rateCents / 100).toFixed(2)}
								oninput={(e) =>
									updateTier(t.id, 'rateCents', (e.currentTarget as HTMLInputElement).value)}
							/>
						</div>
						<div class="tier-total">{fmtMoney(Math.round(t.quantity * t.rateCents))}</div>
						<button
							type="button"
							class="row-rm"
							onclick={() => removeTier(t.id)}
							aria-label="Remove tier"
							title="Remove"
						>
							×
						</button>
					</li>
				{/each}
			</ul>
			<button type="button" class="preset" onclick={addTier}>+ Add tier</button>
		</section>
	{/if}

	<section class="card totals">
		<div class="row">
			<span class="muted">Subtotal</span>
			<span class="num">{fmtMoney(data.pricing.subtotalCents)}</span>
		</div>
		<div class="row">
			<span>
				Margin
				<input
					type="number"
					class="inline-pct"
					min="0"
					max="100"
					step="0.5"
					value={data.pricing.marginPct}
					oninput={(e) =>
						setMargin(parseFloat((e.currentTarget as HTMLInputElement).value) || 0)}
				/>
				<span class="muted">%</span>
			</span>
			<span class="num">{fmtMoney(Math.round(data.pricing.subtotalCents * data.pricing.marginPct / 100))}</span>
		</div>
		<div class="row">
			<span>
				GST
				<input
					type="number"
					class="inline-pct"
					min="0"
					max="100"
					step="0.5"
					value={data.pricing.gstPct}
					oninput={(e) =>
						setGst(parseFloat((e.currentTarget as HTMLInputElement).value) || 0)}
				/>
				<span class="muted">%</span>
			</span>
			<span class="num">{fmtMoney(data.pricing.totalCents - Math.round(data.pricing.subtotalCents * (1 + data.pricing.marginPct / 100)))}</span>
		</div>
		<div class="row total">
			<strong>Total (inc GST)</strong>
			<strong class="num">{fmtMoney(data.pricing.totalCents)}</strong>
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
	.step5 {
		max-width: 48rem;
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
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

	.mode-row {
		display: flex;
		justify-content: flex-end;
	}
	.mode-toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.85rem;
		cursor: pointer;
	}
	.mode-toggle input {
		width: 16px;
		height: 16px;
		accent-color: var(--accent);
	}

	.card {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 1rem 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
	}
	.card label {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		font-size: 0.85rem;
		color: var(--text-muted);
	}
	.input-with-prefix {
		display: flex;
		align-items: stretch;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg);
		overflow: hidden;
	}
	.input-with-prefix:focus-within {
		border-color: var(--accent);
	}
	.input-with-prefix .prefix {
		padding: 0.5rem 0.6rem;
		background: var(--border);
		color: var(--text-muted);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	.input-with-prefix input {
		flex: 1;
		min-width: 0;
		background: transparent;
		border: none;
		padding: 0.5rem 0.75rem;
		color: var(--text);
		font-size: 1rem;
		outline: none;
	}
	small {
		font-size: 0.72rem;
		line-height: 1.3;
	}

	.tiers {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.tiers li {
		display: grid;
		grid-template-columns: minmax(0, 2.5fr) 4.5rem 3.5rem 6rem 6rem auto;
		gap: 0.45rem;
		align-items: center;
	}
	.tiers input {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.35rem 0.5rem;
		font-size: 0.85rem;
		color: var(--text);
		outline: none;
		width: 100%;
		min-width: 0;
		box-sizing: border-box;
	}
	.tiers input:focus {
		border-color: var(--accent);
	}
	.tier-rate {
		display: flex;
		align-items: stretch;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg);
		overflow: hidden;
	}
	.tier-rate .prefix {
		background: var(--border);
		color: var(--text-muted);
		padding: 0 0.45rem;
		display: grid;
		place-items: center;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.85rem;
	}
	.tier-rate input {
		border: none;
		background: transparent;
		border-radius: 0;
	}
	.tier-total {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		text-align: right;
		font-size: 0.85rem;
		color: var(--text);
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
	.preset {
		background: transparent;
		border: 1px dashed var(--border);
		color: var(--accent);
		padding: 0.4rem 0.75rem;
		border-radius: 8px;
		font-size: 0.8rem;
		font-weight: 600;
		cursor: pointer;
		align-self: flex-start;
	}
	.preset:hover {
		border-style: solid;
	}

	.totals .row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		font-size: 0.92rem;
	}
	.totals .row.total {
		border-top: 1px solid var(--border);
		padding-top: 0.625rem;
		margin-top: 0.5rem;
		font-size: 1.15rem;
	}
	.num {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	.inline-pct {
		width: 4rem;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.2rem 0.4rem;
		color: var(--text);
		font-size: 0.85rem;
		outline: none;
		margin: 0 0.25rem;
	}
	.inline-pct:focus {
		border-color: var(--accent);
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
		.tiers li {
			grid-template-columns: 1fr 1fr;
		}
		.tier-total {
			grid-column: 1 / -1;
		}
	}
</style>
