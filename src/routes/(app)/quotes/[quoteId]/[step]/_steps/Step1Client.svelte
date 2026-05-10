<script lang="ts">
	import { browser } from '$app/environment';
	import { untrack } from 'svelte';
	import type { QuoteData } from '$lib/schemas/quote';
	import type { GeocodeSuggestion } from '$lib/mapbox';
	// MapLibre is loaded lazily via dynamic import (~700 KB) — see initMap below.
	import type { Map as MLMap, Marker as MLMarker } from 'maplibre-gl';

	type SaveState = 'idle' | 'saving' | 'saved' | 'conflict' | 'error';

	let {
		quoteId,
		data: initialData,
		dataHash: initialHash,
		versionNumber: initialVersion,
		mapboxToken
	}: {
		quoteId: string;
		data: QuoteData;
		dataHash: string;
		versionNumber: number;
		mapboxToken: string;
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

	// --- address autocomplete state -----------------------------------------
	// svelte-ignore state_referenced_locally
	let addressQuery = $state(initialData.site.address);
	let suggestions: GeocodeSuggestion[] = $state([]);
	let suggestionsOpen = $state(false);
	let geocodeLoading = $state(false);
	let geocodeError = $state('');
	let geocodeTimer: ReturnType<typeof setTimeout> | null = null;
	let highlightIndex = $state(-1);

	// svelte-ignore state_referenced_locally
	let hasGeocode = $state(initialData.site.geocode !== null);

	// --- save protocol ------------------------------------------------------
	let saveTimer: ReturnType<typeof setTimeout> | null = null;

	type FreshResponse = { data: QuoteData; dataHash: string; versionNumber: number };
	type SaveResponse = { dataHash: string; versionNumber: number };

	function scheduleSave() {
		if (saveTimer) clearTimeout(saveTimer);
		saveState = 'saving';
		saveTimer = setTimeout(save, 600);
	}

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
				const fresh = (await fetch(`/api/quotes/${quoteId}.json`).then((r) =>
					r.json()
				)) as FreshResponse;
				data = fresh.data;
				dataHash = fresh.dataHash;
				versionNumber = fresh.versionNumber;
				addressQuery = fresh.data.site.address;
				hasGeocode = fresh.data.site.geocode !== null;
				mapSession++; // recreate map for the new property
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

	function onBlur() {
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
		}
		void save();
	}

	// --- geocoding ----------------------------------------------------------

	function onAddressInput() {
		if (geocodeTimer) clearTimeout(geocodeTimer);
		geocodeError = '';
		// User is typing → no longer "selected"
		if (hasGeocode) {
			data.site.geocode = null;
			data.site.state = null;
			data.site.postcode = '';
			hasGeocode = false;
		}
		highlightIndex = -1;
		const q = addressQuery.trim();
		if (q.length < 3) {
			suggestions = [];
			suggestionsOpen = false;
			return;
		}
		geocodeLoading = true;
		suggestionsOpen = true;
		geocodeTimer = setTimeout(runGeocode, 280);
	}

	async function runGeocode() {
		const q = addressQuery.trim();
		try {
			const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
			if (!res.ok) {
				geocodeError = 'Could not search.';
				suggestions = [];
				return;
			}
			const body = (await res.json()) as { suggestions: GeocodeSuggestion[] };
			suggestions = body.suggestions;
			suggestionsOpen = true;
		} catch {
			geocodeError = 'Could not search.';
			suggestions = [];
		} finally {
			geocodeLoading = false;
		}
	}

	function selectSuggestion(s: GeocodeSuggestion) {
		data.site.address = s.label;
		data.site.geocode = { lat: s.lat, lng: s.lng };
		data.site.state = s.state;
		data.site.postcode = s.postcode;
		addressQuery = s.label;
		suggestionsOpen = false;
		suggestions = [];
		highlightIndex = -1;
		hasGeocode = true;
		mapSession++; // signal "external" geocode change → re-init map
		void save();
	}

	function onAddressKey(e: KeyboardEvent) {
		if (!suggestionsOpen || suggestions.length === 0) return;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			highlightIndex = (highlightIndex + 1) % suggestions.length;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			highlightIndex = (highlightIndex - 1 + suggestions.length) % suggestions.length;
		} else if (e.key === 'Enter') {
			if (highlightIndex >= 0) {
				e.preventDefault();
				selectSuggestion(suggestions[highlightIndex]);
			}
		} else if (e.key === 'Escape') {
			suggestionsOpen = false;
		}
	}

	function clearAddress() {
		data.site.address = '';
		data.site.geocode = null;
		data.site.state = null;
		data.site.postcode = '';
		addressQuery = '';
		hasGeocode = false;
		suggestions = [];
		suggestionsOpen = false;
		mapSession++;
		void save();
	}

	// --- interactive mini-map ----------------------------------------------

	let mapContainer: HTMLDivElement | undefined = $state();
	let mapStatus: 'idle' | 'loading' | 'ready' = $state('idle');
	// Bumped whenever we want to re-center/re-init the map (new address picked,
	// quote refresh after conflict). Marker drags do NOT bump this.
	let mapSession = $state(0);
	let mapInstance: MLMap | null = null;
	let markerInstance: MLMarker | null = null;

	$effect(() => {
		mapSession; // reactive dep — incremented on external geocode change
		if (!browser) return;

		// Read non-reactively so a marker drag (which mutates data.site.geocode)
		// doesn't re-fire this effect.
		const geocode = untrack(() => data.site.geocode);
		const container = mapContainer;
		const token = mapboxToken;

		if (!container || !geocode || !token) {
			tearDown();
			return;
		}

		mapStatus = 'loading';
		let cancelled = false;

		(async () => {
			const [{ default: maplibregl }] = await Promise.all([
				import('maplibre-gl'),
				import('maplibre-gl/dist/maplibre-gl.css')
			]);
			if (cancelled) return;

			tearDown();

			const m = new maplibregl.Map({
				container,
				style: {
					version: 8,
					sources: {
						sat: {
							type: 'raster',
							tiles: [
								`https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.png?access_token=${encodeURIComponent(token)}`
							],
							tileSize: 512,
							attribution: '© Mapbox © Maxar'
						}
					},
					layers: [{ id: 'sat', type: 'raster', source: 'sat', minzoom: 0, maxzoom: 22 }]
				},
				center: [geocode.lng, geocode.lat],
				zoom: 18,
				minZoom: 14,
				maxZoom: 21,
				attributionControl: { compact: true }
			});

			m.addControl(
				new maplibregl.NavigationControl({ visualizePitch: false, showCompass: false }),
				'top-right'
			);

			const marker = new maplibregl.Marker({ draggable: true, color: '#ff8a1c' })
				.setLngLat([geocode.lng, geocode.lat])
				.addTo(m);

			marker.on('dragend', () => {
				const ll = marker.getLngLat();
				data.site.geocode = { lat: ll.lat, lng: ll.lng };
				scheduleSave();
			});

			mapInstance = m;
			markerInstance = marker;
			mapStatus = 'ready';
		})();

		return () => {
			cancelled = true;
			tearDown();
		};
	});

	function tearDown() {
		markerInstance?.remove();
		markerInstance = null;
		mapInstance?.remove();
		mapInstance = null;
		mapStatus = 'idle';
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

		<label class="full address-field">
			<span class="row">
				<span>Site address</span>
				{#if hasGeocode}
					<button type="button" class="link" onclick={clearAddress}>Change</button>
				{/if}
			</span>
			<div class="autocomplete">
				<input
					type="text"
					bind:value={addressQuery}
					oninput={onAddressInput}
					onkeydown={onAddressKey}
					autocomplete="street-address"
					placeholder="Start typing an Australian address…"
					aria-autocomplete="list"
				/>
				{#if suggestionsOpen && (suggestions.length > 0 || geocodeLoading || geocodeError)}
					<ul class="suggestions" role="listbox">
						{#if geocodeLoading && suggestions.length === 0}
							<li class="status">Searching…</li>
						{:else if geocodeError}
							<li class="status err">{geocodeError}</li>
						{:else if suggestions.length === 0}
							<li class="status">No matches</li>
						{:else}
							{#each suggestions as s, i (s.label)}
								<li
									role="option"
									class:active={i === highlightIndex}
									aria-selected={i === highlightIndex}
								>
									<button
										type="button"
										onclick={() => selectSuggestion(s)}
										onmouseenter={() => (highlightIndex = i)}
									>
										{s.label}
									</button>
								</li>
							{/each}
						{/if}
					</ul>
				{/if}
			</div>
		</label>

		{#if hasGeocode && data.site.geocode && mapboxToken}
			<div class="map-block full">
				<div class="map-hint">
					Drag the pin to fine-tune the property location if the address pin isn't quite right.
				</div>
				<div class="map-frame">
					<div class="map" bind:this={mapContainer}></div>
					{#if mapStatus !== 'ready'}
						<div class="map-loading">Loading satellite…</div>
					{/if}
				</div>
				<div class="map-meta">
					{#if data.site.state}<span class="chip">{data.site.state}</span>{/if}
					{#if data.site.postcode}<span class="chip">{data.site.postcode}</span>{/if}
					<span class="coords">
						{data.site.geocode.lat.toFixed(5)}, {data.site.geocode.lng.toFixed(5)}
					</span>
				</div>
			</div>
		{/if}

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
		max-width: 56rem;
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
	.row {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
	}
	.link {
		background: transparent;
		border: none;
		color: var(--accent);
		font-size: 0.8rem;
		padding: 0;
		cursor: pointer;
	}
	.link:hover {
		text-decoration: underline;
	}
	input,
	textarea {
		width: 100%;
		box-sizing: border-box;
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

	/* autocomplete */
	.autocomplete {
		position: relative;
	}
	.suggestions {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		right: 0;
		z-index: 5;
		margin: 0;
		padding: 0.25rem;
		list-style: none;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 8px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
		max-height: 18rem;
		overflow-y: auto;
	}
	.suggestions li {
		display: block;
	}
	.suggestions li button {
		width: 100%;
		text-align: left;
		background: transparent;
		border: none;
		color: var(--text);
		font-size: 0.9rem;
		padding: 0.5rem 0.625rem;
		border-radius: 6px;
		cursor: pointer;
	}
	.suggestions li.active button,
	.suggestions li button:hover {
		background: var(--border);
	}
	.suggestions .status {
		padding: 0.6rem 0.75rem;
		color: var(--text-muted);
		font-size: 0.85rem;
	}
	.suggestions .status.err {
		color: var(--danger);
	}

	/* map block */
	.map-block {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		grid-column: 1 / -1;
	}
	.map-hint {
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.map-frame {
		position: relative;
		width: 100%;
		max-width: 700px;
		aspect-ratio: 5 / 3;
		border-radius: 12px;
		border: 1px solid var(--border);
		overflow: hidden;
		background: #15161a;
	}
	.map {
		position: absolute;
		inset: 0;
	}
	:global(.maplibregl-marker) {
		cursor: grab;
	}
	:global(.maplibregl-marker:active) {
		cursor: grabbing;
	}
	.map-loading {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		color: var(--text-muted);
		font-size: 0.85rem;
		pointer-events: none;
	}
	.map-meta {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		flex-wrap: wrap;
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.chip {
		display: inline-block;
		padding: 0.125rem 0.5rem;
		border-radius: 999px;
		background: var(--border);
		color: var(--text);
		font-weight: 600;
		letter-spacing: 0.04em;
	}
	.coords {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
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
		.map-frame {
			aspect-ratio: 4 / 3;
		}
	}
</style>
