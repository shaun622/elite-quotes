<script lang="ts">
	import type { QuoteData } from '$lib/schemas/quote';
	import {
		generatePostDistances,
		multiPolylineLengthMeters,
		pathToSegments
	} from '$lib/wall-math';
	import {
		PANEL_MODULE_MM,
		isEngineerCertRequired,
		recommendedEmbedmentMm,
		recommendedPierDiameterMm,
		snapToPanelModule
	} from '$lib/engineering';
	import { findLinkForPost } from '$lib/wall-links';
	import { retainedAtDistance } from '$lib/wall-heights';

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
		saveTimer = setTimeout(() => {
			void save();
		}, 600);
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

	// --- wall + post state -------------------------------------------------
	// svelte-ignore state_referenced_locally
	let activeWallId = $state<string | null>(initialData.walls[0]?.id ?? null);
	let activePostIdx = $state<number | null>(null);

	function activeWall() {
		return data.walls.find((w) => w.id === activeWallId);
	}

	function selectWall(id: string) {
		activeWallId = id;
		activePostIdx = null;
		ensurePosts();
	}

	function wallLengthMeters(wallId: string | null): number {
		if (!wallId) return 0;
		const w = data.walls.find((x) => x.id === wallId);
		if (!w) return 0;
		return multiPolylineLengthMeters(pathToSegments(w.pathGeoJson ?? null));
	}

	const activeLengthM = $derived(() => wallLengthMeters(activeWallId));

	/** Post distances along the wall in metres (derived from wall length + spacing). */
	const postDistancesM = $derived(() => {
		const w = activeWall();
		if (!w) return [];
		return generatePostDistances({
			wallLengthMeters: activeLengthM(),
			spacingMm: w.defaults.postSpacingMm
		});
	});

	/**
	 * Ensure data.walls[active].posts has the right number of entries to match
	 * the derived post distances. Preserves existing rgl/ngl values; appends
	 * new posts pre-seeded with the interpolated retained height from Step 2's
	 * section start/end heights, so the elevation chart picks up the wall's
	 * slope without the user re-entering values per post.
	 */
	function ensurePosts() {
		const w = activeWall();
		if (!w) return;
		const distances = postDistancesM();
		const target = distances.length;
		if (w.posts.length === target) return;
		const next = w.posts.slice(0, target);
		while (next.length < target) {
			const idx = next.length;
			// Seed RGL from Step 2's chained section heights at this post's
			// distance along the wall. NGL stays at 0 (relative datum) until
			// the user drags it or supplies a real NGL via the chart.
			const rglMm = retainedAtDistance(w, distances[idx] ?? 0);
			next.push({
				index: idx,
				rglMm,
				nglMm: 0,
				pierDiameterMm: null,
				embedmentMm: null
			});
		}
		// Re-index in case we trimmed
		next.forEach((p, i) => (p.index = i));
		w.posts = next;
	}

	/**
	 * Bulk action: re-seed every post's RGL from the current Step 2 section
	 * heights. Useful when the user has gone back to Step 2, adjusted the
	 * start/end heights, and now wants Step 3 to reflect those changes.
	 *
	 * NGL is left untouched — the user may have set real ground levels via
	 * the elevation chart that we shouldn't blow away.
	 */
	function reseedRglFromStep2() {
		const w = activeWall();
		if (!w) return;
		const distances = postDistancesM();
		for (let i = 0; i < w.posts.length; i++) {
			w.posts[i].rglMm = retainedAtDistance(w, distances[i] ?? 0);
		}
		scheduleSave();
	}

	/** What the auto-seeded RGL WOULD be for post i — used for the sidebar
	 *  hint that lets the user spot drift between their dragged values and
	 *  the Step 2 source-of-truth. */
	function suggestedRglMm(postIdx: number): number {
		const w = activeWall();
		if (!w) return 0;
		const distances = postDistancesM();
		return retainedAtDistance(w, distances[postIdx] ?? 0);
	}

	$effect(() => {
		// When active wall or post-distance count changes, top up the posts array.
		activeWallId;
		postDistancesM().length;
		ensurePosts();
	});

	// Auto-derived geometry per post (pier diameter, embedment).
	function pierFor(rglMm: number) {
		return recommendedPierDiameterMm(Math.max(0, rglMm));
	}
	function embedFor(rglMm: number) {
		return recommendedEmbedmentMm(Math.max(0, rglMm));
	}

	// --- chart geometry ----------------------------------------------------
	const SVG_HEIGHT = 460;
	const PADDING = { top: 56, right: 30, bottom: 60, left: 80 };
	const Y_MIN = -1500; // mm — pier-bottom area
	const Y_MAX = 2400; // mm — head-room above the tallest sensible wall

	let svgEl: SVGSVGElement | null = $state(null);
	let svgWidth = $state(960);
	let chartObserver: ResizeObserver | null = null;

	$effect(() => {
		if (!svgEl) return;
		chartObserver?.disconnect();
		chartObserver = new ResizeObserver(() => {
			if (svgEl) svgWidth = svgEl.clientWidth;
		});
		chartObserver.observe(svgEl);
		svgWidth = svgEl.clientWidth;
		return () => chartObserver?.disconnect();
	});

	function xAt(distanceM: number): number {
		const innerW = svgWidth - PADDING.left - PADDING.right;
		const total = Math.max(activeLengthM(), 0.001);
		return PADDING.left + (distanceM / total) * innerW;
	}

	function yAt(mm: number): number {
		const innerH = SVG_HEIGHT - PADDING.top - PADDING.bottom;
		const range = Y_MAX - Y_MIN;
		// Higher mm → smaller y on screen
		return PADDING.top + ((Y_MAX - mm) / range) * innerH;
	}

	function mmFromY(yPx: number): number {
		const innerH = SVG_HEIGHT - PADDING.top - PADDING.bottom;
		const range = Y_MAX - Y_MIN;
		const mm = Y_MAX - ((yPx - PADDING.top) / innerH) * range;
		return mm;
	}

	// Y-axis tick lines (200 mm intervals — wall snap module).
	const yTicks = $derived(() => {
		const ticks: number[] = [];
		for (let mm = Math.ceil(Y_MIN / 200) * 200; mm <= Y_MAX; mm += 200) {
			ticks.push(mm);
		}
		return ticks;
	});

	// X-axis tick metres (every 2 m unless very long).
	const xTicks = $derived(() => {
		const total = activeLengthM();
		const stepM = total <= 12 ? 1 : total <= 30 ? 2 : 5;
		const ticks: number[] = [];
		for (let m = 0; m <= total + 0.001; m += stepM) ticks.push(m);
		if (ticks[ticks.length - 1] < total - 0.5) ticks.push(total);
		return ticks;
	});

	// --- drag handlers -----------------------------------------------------
	type DragKind = 'rgl' | 'ngl';
	let dragState: { kind: DragKind; postIdx: number; pointerId: number } | null = null;

	function onHandlePointerDown(e: PointerEvent, kind: DragKind, postIdx: number) {
		e.stopPropagation();
		const target = e.currentTarget as Element;
		target.setPointerCapture(e.pointerId);
		dragState = { kind, postIdx, pointerId: e.pointerId };
		activePostIdx = postIdx;
		updateFromPointer(e);
	}

	function onHandlePointerMove(e: PointerEvent) {
		if (!dragState) return;
		updateFromPointer(e);
	}

	function onHandlePointerUp(e: PointerEvent) {
		if (!dragState) return;
		const target = e.currentTarget as Element;
		try {
			target.releasePointerCapture(dragState.pointerId);
		} catch {
			/* no capture */
		}
		dragState = null;
		scheduleSave();
	}

	function updateFromPointer(e: PointerEvent) {
		if (!dragState || !svgEl) return;
		const rect = svgEl.getBoundingClientRect();
		const yInSvg = ((e.clientY - rect.top) / rect.height) * SVG_HEIGHT;
		const mmRaw = mmFromY(yInSvg);
		const snapped = snapToPanelModule(mmRaw);
		// Clamp to safe range
		const clamped = Math.max(Y_MIN + 200, Math.min(Y_MAX - 200, snapped));
		const w = activeWall();
		if (!w) return;
		const post = w.posts[dragState.postIdx];
		if (!post) return;
		if (dragState.kind === 'rgl') {
			if (post.rglMm !== clamped) post.rglMm = clamped;
		} else {
			if (post.nglMm !== clamped) post.nglMm = clamped;
		}
	}

	// --- bulk apply --------------------------------------------------------
	function applyRglToAll() {
		const w = activeWall();
		if (!w) return;
		const idx = activePostIdx ?? 0;
		const value = w.posts[idx]?.rglMm;
		if (value === undefined) return;
		for (const p of w.posts) p.rglMm = value;
		scheduleSave();
	}

	function applyRglFromHere() {
		const w = activeWall();
		if (!w) return;
		const idx = activePostIdx ?? 0;
		const value = w.posts[idx]?.rglMm;
		if (value === undefined) return;
		for (let i = idx + 1; i < w.posts.length; i++) {
			w.posts[i].rglMm = value;
		}
		scheduleSave();
	}

	function applyNglToAll() {
		const w = activeWall();
		if (!w) return;
		const idx = activePostIdx ?? 0;
		const value = w.posts[idx]?.nglMm;
		if (value === undefined) return;
		for (const p of w.posts) p.nglMm = value;
		scheduleSave();
	}

	// --- engineer-cert flag ------------------------------------------------
	const maxRetained = $derived(() => {
		const w = activeWall();
		if (!w || w.posts.length === 0) return 0;
		return Math.max(0, ...w.posts.map((p) => p.rglMm - p.nglMm));
	});

	const certCheck = $derived(() =>
		isEngineerCertRequired({
			maxRetainedMm: maxRetained(),
			state: data.site.state,
			surchargeLoad: data.meta.flags.surchargeLoad
		})
	);

	// Sync the engineerCertRequired meta flag whenever the auto-check changes.
	$effect(() => {
		const required = certCheck().required;
		if (data.meta.flags.engineerCertRequired !== required) {
			data.meta.flags.engineerCertRequired = required;
			scheduleSave();
		}
	});

	function toggleSurcharge() {
		data.meta.flags.surchargeLoad = !data.meta.flags.surchargeLoad;
		scheduleSave();
	}

	function setVerticalDatum(value: 'site' | 'ahd' | 'relative') {
		if (data.site.verticalDatum === value) return;
		data.site.verticalDatum = value;
		scheduleSave();
	}

	const datumLabel = $derived(() => {
		switch (data.site.verticalDatum) {
			case 'ahd':
				return 'AHD';
			case 'relative':
				return 'Relative';
			default:
				return 'Site Benchmark';
		}
	});

	// --- linked-NGL detection ----------------------------------------------
	function linkForPost(wallId: string, postIdx: number) {
		return findLinkForPost({ walls: data.walls, wallId, postIdx });
	}

	function matchNeighbourNgl(wallId: string, postIdx: number) {
		const link = linkForPost(wallId, postIdx);
		if (!link) return;
		const otherWall = data.walls.find((w) => w.id === link.wallId);
		if (!otherWall) return;
		const otherPost = otherWall.posts[link.postIdx];
		if (!otherPost) return;
		const thisWall = data.walls.find((w) => w.id === wallId);
		if (!thisWall) return;
		const thisPost = thisWall.posts[postIdx];
		if (!thisPost) return;
		thisPost.nglMm = otherPost.nglMm;
		scheduleSave();
	}
</script>

<div class="step3">
	<header class="topbar">
		<div class="walls-tabs" role="tablist">
			{#each data.walls as w (w.id)}
				{@const len = wallLengthMeters(w.id)}
				<button
					type="button"
					role="tab"
					class="tab"
					class:active={w.id === activeWallId}
					onclick={() => selectWall(w.id)}
				>
					<span class="tab-name">{w.name}</span>
					<span class="tab-len">{len.toFixed(1)} m · {w.posts.length || '—'} posts</span>
				</button>
			{/each}
		</div>

		<div class="topbar-right">
			<label class="datum-select">
				<span class="datum-label">Vertical datum</span>
				<select
					value={data.site.verticalDatum}
					onchange={(e) =>
						setVerticalDatum((e.currentTarget as HTMLSelectElement).value as 'site' | 'ahd' | 'relative')}
				>
					<option value="site">Site Benchmark</option>
					<option value="ahd">AHD (Australian Height Datum)</option>
					<option value="relative">Relative (no datum)</option>
				</select>
			</label>

			{#if activeWall()}
				<div class="cert" class:required={certCheck().required}>
					{#if certCheck().required}
						<strong>⚠ Engineer cert required</strong>
						<span>{certCheck().reason}</span>
					{:else}
						<strong>✓ Within non-engineered limits</strong>
						<span>Max retained {maxRetained()} mm · datum: {datumLabel()}</span>
					{/if}
				</div>
			{/if}
		</div>
	</header>

	{#if !activeWall() || activeLengthM() < 0.5}
		<div class="empty">
			<p>Draw at least one wall on the Plan view (Step 2) to set up post elevations here.</p>
		</div>
	{:else}
		<div class="layout">
			<div class="chart-area">
				<div class="chart-meta">
					<span><strong>{activeWall()?.name}</strong></span>
					<span class="muted">{activeLengthM().toFixed(2)} m, {postDistancesM().length} posts at {activeWall()?.defaults.postSpacingMm} mm c/c (snaps to {PANEL_MODULE_MM} mm panels)</span>
				</div>

				<svg
					bind:this={svgEl}
					viewBox="0 0 {svgWidth} {SVG_HEIGHT}"
					preserveAspectRatio="none"
					class="chart"
					role="application"
					aria-label="Wall elevation chart with draggable retained-ground-level and natural-ground-level handles per post"
					onpointermove={onHandlePointerMove}
					onpointerup={onHandlePointerUp}
					onpointercancel={onHandlePointerUp}
				>
					<!-- Snap grid (200 mm) -->
					{#each yTicks() as mm}
						<line
							x1={PADDING.left}
							x2={svgWidth - PADDING.right}
							y1={yAt(mm)}
							y2={yAt(mm)}
							class="grid"
							class:zero={mm === 0}
						/>
					{/each}

					<!-- Y-axis labels -->
					{#each yTicks() as mm}
						{#if mm % 400 === 0}
							<text x={PADDING.left - 8} y={yAt(mm) + 3} text-anchor="end" class="axis-label">
								{mm}
							</text>
						{/if}
					{/each}
					<text x={20} y={SVG_HEIGHT / 2} class="axis-title" transform="rotate(-90, 20, {SVG_HEIGHT / 2})">
						mm
					</text>

					<!-- X-axis baseline + labels -->
					<line
						x1={PADDING.left}
						x2={svgWidth - PADDING.right}
						y1={SVG_HEIGHT - PADDING.bottom}
						y2={SVG_HEIGHT - PADDING.bottom}
						class="axis"
					/>
					{#each xTicks() as m}
						<line
							x1={xAt(m)}
							x2={xAt(m)}
							y1={SVG_HEIGHT - PADDING.bottom}
							y2={SVG_HEIGHT - PADDING.bottom + 4}
							class="axis"
						/>
						<text
							x={xAt(m)}
							y={SVG_HEIGHT - PADDING.bottom + 18}
							text-anchor="middle"
							class="axis-label"
						>
							{m.toFixed(m < 10 ? 1 : 0)} m
						</text>
					{/each}

					<!-- NGL polyline (dashed green) -->
					{#if activeWall() && activeWall()!.posts.length > 1}
						{@const w = activeWall()!}
						{@const ngl = w.posts.map((p, i) => `${xAt(postDistancesM()[i])},${yAt(p.nglMm)}`).join(' ')}
						<polyline points={ngl} class="ngl-line" />
					{/if}

					<!-- RGL polyline (solid blue) -->
					{#if activeWall() && activeWall()!.posts.length > 1}
						{@const w = activeWall()!}
						{@const rgl = w.posts.map((p, i) => `${xAt(postDistancesM()[i])},${yAt(p.rglMm)}`).join(' ')}
						<polyline points={rgl} class="rgl-line" />
					{/if}

					<!-- Per-post: pier rectangle, post line, handles -->
					{#if activeWall()}
						{@const w = activeWall()!}
						{#each w.posts as post, i (i)}
							{@const dist = postDistancesM()[i]}
							{@const px = xAt(dist)}
							{@const pierD = pierFor(post.rglMm - post.nglMm)}
							{@const embed = embedFor(post.rglMm - post.nglMm)}
							{@const pierTopY = yAt(post.nglMm)}
							{@const pierBotY = yAt(post.nglMm - embed)}
							{@const pierWidthPx = Math.max(8, (pierD / 1000) * (svgWidth / Math.max(activeLengthM(), 0.001)))}

							<!-- Pier (concrete footing) -->
							<rect
								x={px - pierWidthPx / 2}
								y={pierTopY}
								width={pierWidthPx}
								height={pierBotY - pierTopY}
								class="pier"
								class:active={activePostIdx === i}
							/>

							<!-- Post line (RGL down to NGL — visible part) -->
							<line
								x1={px}
								x2={px}
								y1={yAt(post.rglMm)}
								y2={yAt(post.nglMm)}
								class="post-line"
								class:active={activePostIdx === i}
							/>

							<!-- Post label above -->
							<text
								x={px}
								y={PADDING.top - 22}
								text-anchor="middle"
								class="post-label"
								class:active={activePostIdx === i}
							>
								P{i + 1}
							</text>

							<!-- Height label (RGL value) -->
							<text x={px} y={PADDING.top - 8} text-anchor="middle" class="rgl-label">
								{post.rglMm}
							</text>

							<!-- RGL drag handle (top of post) -->
							<circle
								cx={px}
								cy={yAt(post.rglMm)}
								r="9"
								class="handle handle-rgl"
								class:active={activePostIdx === i}
								onpointerdown={(e) => onHandlePointerDown(e, 'rgl', i)}
								role="slider"
								tabindex="0"
								aria-label="Retained ground level for post {i + 1}, currently {post.rglMm} millimetres"
								aria-valuenow={post.rglMm}
								aria-valuemin={Y_MIN + 200}
								aria-valuemax={Y_MAX - 200}
							/>

							<!-- NGL drag handle (ground level at post) -->
							<circle
								cx={px}
								cy={yAt(post.nglMm)}
								r="6"
								class="handle handle-ngl"
								class:active={activePostIdx === i}
								onpointerdown={(e) => onHandlePointerDown(e, 'ngl', i)}
								role="slider"
								tabindex="0"
								aria-label="Natural ground level for post {i + 1}, currently {post.nglMm} millimetres"
								aria-valuenow={post.nglMm}
								aria-valuemin={Y_MIN + 200}
								aria-valuemax={Y_MAX - 200}
							/>
						{/each}
					{/if}

					<!-- Legend -->
					<g transform="translate({svgWidth - PADDING.right - 200}, {PADDING.top - 38})">
						<rect x="0" y="-12" width="200" height="32" class="legend-bg" rx="4" />
						<line x1="8" x2="36" y1="-2" y2="-2" class="rgl-line" />
						<text x="42" y="2" class="legend-text">RGL — Retained</text>
						<line x1="8" x2="36" y1="13" y2="13" class="ngl-line" />
						<text x="42" y="17" class="legend-text">NGL — Natural</text>
					</g>
				</svg>

				<div class="chart-actions">
					<button
						type="button"
						class="btn ghost reseed"
						onclick={reseedRglFromStep2}
						title="Re-interpolate every post's RGL from Step 2's section start/end heights"
					>
						⇌ Reseed RGL from Step 2
					</button>
					<button type="button" class="btn ghost" onclick={applyRglToAll}>
						Apply RGL to all posts
					</button>
					<button
						type="button"
						class="btn ghost"
						onclick={applyRglFromHere}
						disabled={activePostIdx === null}
					>
						Apply RGL → onward
					</button>
					<button type="button" class="btn ghost" onclick={applyNglToAll}>
						Apply NGL to all posts
					</button>
				</div>
			</div>

			<aside class="sidebar">
				<h3>Posts</h3>
				<ul class="post-list">
					{#if activeWall()}
						{@const w = activeWall()!}
						{#each w.posts as post, i (i)}
							{@const retained = Math.max(0, post.rglMm - post.nglMm)}
							{@const link = linkForPost(w.id, i)}
							{@const suggested = suggestedRglMm(i)}
							{@const drift = Math.abs(post.rglMm - suggested) > 1}
							<li>
								<button
									type="button"
									class:active={activePostIdx === i}
									onclick={() => (activePostIdx = i)}
								>
									<span class="post-num">P{i + 1}</span>
									<span class="post-rgl">{retained} mm</span>
									<span class="post-meta muted">
										Ø{pierFor(retained)} · {embedFor(retained)} embed
									</span>
								</button>
								{#if drift}
									<button
										type="button"
										class="step2-hint"
										title="Step 2 section heights interpolated to {suggested} mm at this post. Click to apply."
										onclick={() => {
											const wAct = activeWall();
											if (wAct) {
												wAct.posts[i].rglMm = suggested;
												scheduleSave();
											}
										}}
									>
										Step 2: {suggested} mm
									</button>
								{/if}
								{#if link}
									<button
										type="button"
										class="link-pill"
										title="NGL: {w.posts[i].nglMm} mm · neighbour: {data.walls.find((wl) => wl.id === link.wallId)?.posts[link.postIdx]?.nglMm ?? 0} mm. Click to copy from neighbour."
										onclick={() => matchNeighbourNgl(w.id, i)}
									>
										↔ {link.wallName} {link.end === 'start' ? 'Start' : 'End'}
									</button>
								{/if}
							</li>
						{/each}
					{/if}
				</ul>

				<h3>Site</h3>
				<label class="checkbox">
					<input
						type="checkbox"
						checked={data.meta.flags.surchargeLoad}
						onchange={toggleSurcharge}
					/>
					Surcharge load behind wall (driveway / pool / structure)
				</label>
				<p class="muted small">
					When ticked, this wall is auto-flagged for engineer certification regardless of height.
				</p>
			</aside>
		</div>
	{/if}

	<footer class="status" role="status" aria-live="polite">
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
	</footer>
</div>

<style>
	.step3 {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
	}

	.topbar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		flex-wrap: wrap;
	}

	.walls-tabs {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
	}
	.tab {
		display: inline-flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.1rem;
		background: var(--surface);
		border: 1px solid var(--border);
		color: var(--text-muted);
		padding: 0.4rem 0.7rem;
		border-radius: 8px;
		font-size: 0.8rem;
		cursor: pointer;
		min-width: 7rem;
	}
	.tab.active {
		border-color: var(--accent);
		color: var(--text);
	}
	.tab .tab-name {
		font-weight: 600;
	}
	.tab .tab-len {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.7rem;
	}

	.topbar-right {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.5rem;
		max-width: 28rem;
	}
	.datum-select {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.datum-label {
		text-transform: uppercase;
		letter-spacing: 0.05em;
		font-size: 0.7rem;
		font-weight: 600;
	}
	.datum-select select {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.35rem 0.5rem;
		color: var(--text);
		font-size: 0.85rem;
		outline: none;
	}
	.datum-select select:focus {
		border-color: var(--accent);
	}

	.cert {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		font-size: 0.85rem;
		text-align: right;
		max-width: 28rem;
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

	.empty {
		padding: 2rem 1.5rem;
		border: 1px dashed var(--border);
		border-radius: 12px;
		background: var(--surface);
		color: var(--text-muted);
	}

	.layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 18rem;
		gap: 1rem;
	}
	@media (max-width: 880px) {
		.layout {
			grid-template-columns: 1fr;
		}
	}

	.chart-area {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.chart-meta {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 1rem;
		font-size: 0.85rem;
		flex-wrap: wrap;
	}

	.chart {
		width: 100%;
		height: 460px;
		background: linear-gradient(to bottom, #f1efe8 0%, #f1efe8 50%, #b6926e 50%, #8c6a48 100%);
		border-radius: 12px;
		border: 1px solid var(--border);
		touch-action: none;
		user-select: none;
	}

	.grid {
		stroke: rgba(255, 255, 255, 0.6);
		stroke-width: 1;
	}
	.grid.zero {
		stroke: rgba(0, 0, 0, 0.5);
		stroke-width: 1.5;
	}
	.axis {
		stroke: rgba(0, 0, 0, 0.7);
		stroke-width: 1;
	}
	.axis-label {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 11px;
		fill: rgba(0, 0, 0, 0.85);
	}
	.axis-title {
		font-size: 11px;
		fill: rgba(0, 0, 0, 0.7);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.ngl-line {
		fill: none;
		stroke: #1a8a3a;
		stroke-width: 2;
		stroke-dasharray: 6 4;
	}
	.rgl-line {
		fill: none;
		stroke: #1f5fbf;
		stroke-width: 2.5;
	}

	.pier {
		fill: rgba(70, 70, 75, 0.8);
		stroke: #2a2a2e;
		stroke-width: 1;
	}
	.pier.active {
		fill: rgba(255, 138, 28, 0.6);
		stroke: var(--accent);
	}

	.post-line {
		stroke: #2a2a2e;
		stroke-width: 4;
		stroke-linecap: square;
	}
	.post-line.active {
		stroke: var(--accent);
	}

	.post-label {
		font-size: 11px;
		font-weight: 600;
		fill: rgba(0, 0, 0, 0.75);
	}
	.post-label.active {
		fill: var(--accent);
	}
	.rgl-label {
		font-size: 11px;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		fill: #1f5fbf;
		font-weight: 600;
	}

	.handle {
		cursor: ns-resize;
		stroke: #fff;
		stroke-width: 2;
	}
	.handle-rgl {
		fill: #1f5fbf;
	}
	.handle-rgl.active {
		fill: var(--accent);
		stroke-width: 3;
	}
	.handle-ngl {
		fill: #1a8a3a;
	}
	.handle-ngl.active {
		stroke-width: 3;
	}

	.legend-bg {
		fill: rgba(255, 255, 255, 0.85);
		stroke: rgba(0, 0, 0, 0.2);
	}
	.legend-text {
		font-size: 11px;
		fill: rgba(0, 0, 0, 0.85);
	}

	.chart-actions {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.btn {
		padding: 0.45rem 0.85rem;
		border-radius: 8px;
		font-weight: 600;
		font-size: 0.82rem;
		border: 1px solid transparent;
		cursor: pointer;
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.btn.ghost {
		background: transparent;
		border-color: var(--border);
		color: var(--text);
	}
	.btn.ghost:hover:not(:disabled) {
		border-color: var(--text-muted);
	}
	/* Reseed-from-Step-2 — green-tinted to signal "pulls from the Step 2
	 * section heights you've entered" and visually pair with Step 2's
	 * green height inputs. */
	.btn.ghost.reseed {
		background: rgba(127, 217, 154, 0.08);
		border-color: rgba(127, 217, 154, 0.55);
		color: #c8efb1;
	}
	.btn.ghost.reseed:hover:not(:disabled) {
		background: rgba(127, 217, 154, 0.15);
		border-color: #7fd99a;
	}
	.step2-hint {
		align-self: flex-start;
		margin-left: 3rem;
		margin-bottom: 0.25rem;
		background: rgba(127, 217, 154, 0.12);
		border: 1px solid rgba(127, 217, 154, 0.45);
		color: #c8efb1;
		padding: 0.15rem 0.5rem;
		border-radius: 999px;
		font-size: 0.7rem;
		font-weight: 600;
		cursor: pointer;
		text-align: left;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	.step2-hint:hover {
		background: rgba(127, 217, 154, 0.22);
		color: #e6f8d4;
	}

	.sidebar {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.sidebar h3 {
		margin: 0.5rem 0 0;
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-muted);
		font-weight: 600;
	}
	.post-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		max-height: 18rem;
		overflow-y: auto;
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.25rem;
		background: var(--surface);
	}
	.post-list li {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}
	.post-list li button {
		display: grid;
		grid-template-columns: 2.5rem 1fr auto;
		gap: 0.5rem;
		align-items: baseline;
		width: 100%;
		text-align: left;
		background: transparent;
		border: none;
		color: var(--text);
		padding: 0.45rem 0.5rem;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.85rem;
	}
	.link-pill {
		align-self: flex-start;
		margin-left: 3rem;
		margin-bottom: 0.25rem;
		background: rgba(168, 224, 179, 0.15);
		border: 1px solid rgba(168, 224, 179, 0.5);
		color: #a8e0b3;
		padding: 0.15rem 0.5rem;
		border-radius: 999px;
		font-size: 0.7rem;
		font-weight: 600;
		cursor: pointer;
		text-align: left;
	}
	.link-pill:hover {
		background: rgba(168, 224, 179, 0.25);
		color: #d8f0bf;
	}
	.post-list li button:hover {
		background: rgba(255, 255, 255, 0.04);
	}
	.post-list li button.active {
		background: rgba(255, 138, 28, 0.15);
		color: var(--text);
	}
	.post-num {
		font-weight: 600;
	}
	.post-rgl {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	.post-meta {
		font-size: 0.7rem;
		text-align: right;
	}
	.muted {
		color: var(--text-muted);
	}
	.small {
		font-size: 0.75rem;
		margin: 0.25rem 0 0;
	}

	.checkbox {
		display: flex;
		gap: 0.5rem;
		align-items: flex-start;
		font-size: 0.85rem;
		cursor: pointer;
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
</style>
