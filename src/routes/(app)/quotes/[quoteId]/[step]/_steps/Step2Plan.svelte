<script lang="ts">
	import { browser } from '$app/environment';
	import { untrack } from 'svelte';
	import { ulid } from 'ulid';
	import type {
		Map as MLMap,
		Marker as MLMarker,
		MapMouseEvent,
		GeoJSONSource
	} from 'maplibre-gl';
	import type { Photo, QuoteData } from '$lib/schemas/quote';
	import {
		haversineMeters,
		lngLatToLocal,
		localToLngLat,
		multiPolylineLengthMeters,
		nearestSegment,
		offsetPolyline,
		pathToSegments,
		perpendicularLabelAnchor,
		polylineLengthMeters,
		projectPointOnPolyline,
		segmentsToPath,
		snapAngle,
		type LngLat
	} from '$lib/wall-math';

	type SaveState = 'idle' | 'saving' | 'saved' | 'conflict' | 'error';
	type Tool = 'pan' | 'draw';
	type VertexRef = { segIdx: number; vertexIdx: number };

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
				ensureActiveWall();
				pendingStart = null;
				mapVersion++;
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

	// --- wall + segment state ---------------------------------------------
	// svelte-ignore state_referenced_locally
	let activeWallId = $state<string | null>(initialData.walls[0]?.id ?? null);

	/**
	 * Drawing model: each click on the map in Draw mode either sets the start
	 * point or the end point of a new line. After the second click the line
	 * is committed as a fresh two-vertex sub-segment and the tool snaps back
	 * to Pan. Refining (drag, double-click insert, double-click delete) works
	 * on existing sub-segments regardless of which tool is active.
	 */
	let pendingStart = $state<LngLat | null>(null);

	/** Which section in the active wall is "focused" — clicking a wall line
	 *  on the map sets this; the sidebar highlights the matching row and the
	 *  map renders that section's line thicker. Null = none. */
	let focusedSectionIdx = $state<number | null>(null);

	/** Top-level interaction tool. Pan = clicks ignored, just navigate.
	 *  Always defaults to Pan on load — even on a fresh wall — so a stray
	 *  click while the page is settling doesn't drop a point. */
	let tool = $state<Tool>('pan');

	let mapVersion = $state(0);

	/** Set while a vertex marker is being actively dragged. Tracked so any
	 *  reactive sync that fires mid-drag knows to leave the dragging marker
	 *  alone — destroying it mid-gesture cancels the drag. */
	let dragging = $state(false);

	function activeWall() {
		return data.walls.find((w) => w.id === activeWallId);
	}

	function segments(): LngLat[][] {
		return pathToSegments(activeWall()?.pathGeoJson ?? null);
	}

	function setSegments(segs: LngLat[][]) {
		const w = activeWall();
		if (!w) return;
		w.pathGeoJson = segmentsToPath(segs);
		// Keep legacy + new height arrays aligned: pad or trim to the new length.
		const legacy = Array.isArray(w.sectionHeightsMm) ? w.sectionHeightsMm : [];
		const nextLegacy: (number | null)[] = legacy.slice(0, segs.length);
		while (nextLegacy.length < segs.length) nextLegacy.push(null);
		w.sectionHeightsMm = nextLegacy;

		const heights = Array.isArray(w.sectionHeights) ? w.sectionHeights : [];
		const nextHeights = heights.slice(0, segs.length).map((h) => ({
			startMm: h?.startMm ?? null,
			endMm: h?.endMm ?? null
		}));
		while (nextHeights.length < segs.length) nextHeights.push({ startMm: null, endMm: null });
		w.sectionHeights = nextHeights;
		mapVersion++;
	}

	/** Read the start height for section i. Falls back through the new
	 *  `sectionHeights[i].startMm` → legacy `sectionHeightsMm[i]` → wall default. */
	function sectionStartMm(wall: ReturnType<typeof activeWall>, segIdx: number): number {
		if (!wall) return 0;
		const v = wall.sectionHeights?.[segIdx]?.startMm;
		if (typeof v === 'number') return v;
		const legacy = wall.sectionHeightsMm?.[segIdx];
		if (typeof legacy === 'number') return legacy;
		return wall.defaults.defaultHeightMm ?? 0;
	}

	/** Read the end height for section i. Same fall-through pattern as start. */
	function sectionEndMm(wall: ReturnType<typeof activeWall>, segIdx: number): number {
		if (!wall) return 0;
		const v = wall.sectionHeights?.[segIdx]?.endMm;
		if (typeof v === 'number') return v;
		const legacy = wall.sectionHeightsMm?.[segIdx];
		if (typeof legacy === 'number') return legacy;
		return wall.defaults.defaultHeightMm ?? 0;
	}

	/** Average of start/end — used for m² area calc per section. */
	function sectionAvgMm(wall: ReturnType<typeof activeWall>, segIdx: number): number {
		return (sectionStartMm(wall, segIdx) + sectionEndMm(wall, segIdx)) / 2;
	}

	/** Ensure `wall.sectionHeights[segIdx]` exists, returning a writable copy
	 *  of the full array along with the resolved index. */
	function ensureHeightsRow(w: ReturnType<typeof activeWall>, segIdx: number) {
		if (!w) return null;
		const arr = Array.isArray(w.sectionHeights) ? w.sectionHeights.slice() : [];
		while (arr.length <= segIdx) arr.push({ startMm: null, endMm: null });
		arr[segIdx] = { ...arr[segIdx] };
		return arr;
	}

	/**
	 * Set start height for section `segIdx`. The end of section i-1 is the
	 * SAME ground point as the start of section i — so editing one updates
	 * the other to keep the chained heights consistent.
	 */
	function setSectionStartHeight(segIdx: number, valueMm: number | null) {
		const w = activeWall();
		if (!w) return;
		const arr = ensureHeightsRow(w, segIdx);
		if (!arr) return;
		arr[segIdx].startMm = valueMm;
		// Mirror to previous section's end if it exists.
		if (segIdx > 0) {
			arr[segIdx - 1] = { ...arr[segIdx - 1], endMm: valueMm };
		}
		w.sectionHeights = arr;
		// Mirror to legacy array for downstream readers using the average.
		syncLegacyHeights(w);
		mapVersion++;
		scheduleSave();
	}

	/**
	 * Set end height for section `segIdx`. Mirrors to the next section's
	 * start to maintain the chain (end[i] === start[i+1]).
	 */
	function setSectionEndHeight(segIdx: number, valueMm: number | null) {
		const w = activeWall();
		if (!w) return;
		const arr = ensureHeightsRow(w, segIdx);
		if (!arr) return;
		arr[segIdx].endMm = valueMm;
		if (segIdx + 1 < arr.length) {
			arr[segIdx + 1] = { ...arr[segIdx + 1], startMm: valueMm };
		}
		w.sectionHeights = arr;
		syncLegacyHeights(w);
		mapVersion++;
		scheduleSave();
	}

	/** Keep the legacy flat `sectionHeightsMm` array in sync with the new
	 *  chained model — value = avg(start, end), or null when both are null.
	 *  Older PDF / takeoff code that reads the legacy field stays sensible. */
	function syncLegacyHeights(w: ReturnType<typeof activeWall>) {
		if (!w) return;
		const heights = w.sectionHeights ?? [];
		w.sectionHeightsMm = heights.map((h) => {
			if (h.startMm == null && h.endMm == null) return null;
			const s = h.startMm ?? h.endMm ?? null;
			const e = h.endMm ?? h.startMm ?? null;
			if (s == null || e == null) return null;
			return Math.round((s + e) / 2);
		});
	}

	function deleteSection(segIdx: number) {
		const w = activeWall();
		if (!w) return;
		const segs = segments();
		if (segIdx < 0 || segIdx >= segs.length) return;
		const updated = segs.slice();
		updated.splice(segIdx, 1);
		setSegments(updated);
		scheduleSave();
	}

	function ensureActiveWall() {
		if (data.walls.length === 0) {
			const wall = newEmptyWall(`Wall 1`);
			data.walls.push(wall);
			activeWallId = wall.id;
		} else if (!activeWallId || !data.walls.some((w) => w.id === activeWallId)) {
			activeWallId = data.walls[0].id;
		}
	}

	function newEmptyWall(name: string) {
		return {
			id: ulid(),
			name,
			pathGeoJson: null,
			posts: [],
			sectionHeightsMm: [],
			sectionHeights: [],
			defaults: {
				boundaryOffsetMm: 300,
				panelModuleMm: 200,
				postSpacingMm: 2400,
				concreteStrength: 'N25' as const,
				defaultHeightMm: 600
			}
		};
	}

	function selectWall(id: string, focusSeg: number | null = null) {
		activeWallId = id;
		focusedSectionIdx = focusSeg;
		pendingStart = null;
		mapVersion++;
	}

	function startNewWall() {
		const next = newEmptyWall(`Wall ${data.walls.length + 1}`);
		data.walls.push(next);
		activeWallId = next.id;
		pendingStart = null;
		tool = 'draw';
		mapVersion++;
		scheduleSave();
	}

	function deleteWall(id: string) {
		const idx = data.walls.findIndex((w) => w.id === id);
		if (idx === -1) return;
		data.walls.splice(idx, 1);
		if (data.walls.length === 0) {
			ensureActiveWall();
		} else if (activeWallId === id) {
			activeWallId = data.walls[0].id;
		}
		pendingStart = null;
		mapVersion++;
		scheduleSave();
	}

	/** Undo: if a draw is mid-flight (start clicked, end pending), clear it.
	 *  Otherwise pop the most-recently added sub-segment. */
	function undoLast() {
		if (pendingStart !== null) {
			pendingStart = null;
			clearHover();
			return;
		}
		const segs = segments();
		if (segs.length === 0) return;
		setSegments(segs.slice(0, -1));
		scheduleSave();
	}

	function deleteVertex(ref: VertexRef) {
		const segs = segments();
		if (!segs[ref.segIdx]) return;
		const seg = segs[ref.segIdx];
		// Refuse to drop below two vertices — a line needs both endpoints to exist.
		if (seg.length <= 2) {
			// Two-vertex line: deleting any one vertex means "delete the whole line".
			const updated = segs.slice();
			updated.splice(ref.segIdx, 1);
			setSegments(updated);
			scheduleSave();
			return;
		}
		const updated = segs.slice();
		updated[ref.segIdx] = seg.filter((_, i) => i !== ref.vertexIdx);
		setSegments(updated);
		scheduleSave();
	}

	function moveVertex(ref: VertexRef, ll: LngLat) {
		const segs = segments();
		if (!segs[ref.segIdx]) return;
		const updated = segs.slice();
		updated[ref.segIdx] = updated[ref.segIdx].slice();
		updated[ref.segIdx][ref.vertexIdx] = ll;
		setSegments(updated);
		scheduleSave();
	}

	function insertVertexInSegment(segIdx: number, segmentInsertAt: number, ll: LngLat) {
		const segs = segments();
		if (!segs[segIdx]) return;
		const updated = segs.slice();
		updated[segIdx] = updated[segIdx].slice();
		updated[segIdx].splice(segmentInsertAt + 1, 0, ll);
		setSegments(updated);
		scheduleSave();
	}

	// --- snap helpers ------------------------------------------------------
	/** Snap tolerance in metres for clicks. At zoom 19 a metre is ~15 px so
	 *  1.2 m gives "if your click lands clearly within snap range" without
	 *  fighting the user when they're trying to place a point next to an
	 *  existing one. */
	const SNAP_DISTANCE_M = 1.2;

	type SnapKind = 'vertex' | 'offset' | 'angle';
	type SnapResult = { snapped: LngLat; kind: SnapKind; label: string } | null;

	/**
	 * Find the nearest snap target for a candidate draw point.
	 *
	 * Priority order:
	 *  1) Snap to an existing wall vertex (any wall, any sub-segment endpoint).
	 *     This is the strongest tie because endpoints are intentional anchors
	 *     — most "start a new wall at the end of the last one" actions land
	 *     here.
	 *  2) Snap to the active wall's boundary-offset line. Lets the user draw
	 *     a wall that hugs the set-back line without having to click pixel-
	 *     perfect.
	 *  3) Snap to a 0/90/180/270° angle relative to a pivot (if `pivot` and
	 *     `prevDir` are given — used by the second-click branch).
	 */
	function snapDrawPoint(
		candidate: LngLat,
		opts: { pivot?: LngLat; prevDir?: LngLat } = {}
	): SnapResult {
		// 1) Endpoints of any wall sub-segment.
		let bestVertex: { ll: LngLat; distM: number; wallName: string } | null = null;
		for (const w of data.walls) {
			const segs = pathToSegments(w.pathGeoJson ?? null);
			segs.forEach((seg) => {
				if (seg.length < 1) return;
				const endpoints: LngLat[] = [seg[0], seg[seg.length - 1]];
				for (const v of endpoints) {
					const d = haversineMeters(candidate, v);
					if (d <= SNAP_DISTANCE_M && (!bestVertex || d < bestVertex.distM)) {
						bestVertex = { ll: v, distM: d, wallName: w.name };
					}
				}
			});
		}
		if (bestVertex !== null) {
			const v = bestVertex as { ll: LngLat; distM: number; wallName: string };
			return { snapped: v.ll, kind: 'vertex', label: `↳ ${v.wallName} end` };
		}

		// 2) Active wall's offset (set-back) line.
		const aw = activeWall();
		if (aw) {
			const offsetM = (aw.defaults.boundaryOffsetMm ?? 300) / 1000;
			const segs = pathToSegments(aw.pathGeoJson ?? null);
			let best: { ll: LngLat; distM: number } | null = null;
			for (const seg of segs) {
				if (seg.length < 2) continue;
				const off = offsetPolyline(seg, offsetM);
				if (off.length < 2) continue;
				const hit = projectPointOnPolyline(candidate, off);
				if (hit && hit.distanceM <= SNAP_DISTANCE_M && (!best || hit.distanceM < best.distM)) {
					best = { ll: hit.snapped, distM: hit.distanceM };
				}
			}
			if (best !== null) {
				const b = best as { ll: LngLat; distM: number };
				return { snapped: b.ll, kind: 'offset', label: 'offset line' };
			}
		}

		// 3) Angle snap (only when we have a pivot + a prior direction).
		if (opts.pivot && opts.prevDir) {
			const ang = snapAngle({ prev: opts.prevDir, pivot: opts.pivot, candidate });
			if (ang) {
				return { snapped: ang.snapped, kind: 'angle', label: `${ang.angleDeg}°` };
			}
		}
		return null;
	}

	// --- click logic -------------------------------------------------------
	/**
	 * Two-click drawing: first click stores the start (snapped to any nearby
	 * wall endpoint), second click commits the line and tool flips back to Pan.
	 * The second click also tries the offset line and a 90° angle snap against
	 * the previous sub-segment.
	 */
	function handleMapClick(lngLat: LngLat) {
		if (tool !== 'draw') return;
		const w = activeWall();
		if (!w) return;

		if (pendingStart === null) {
			// First click — try to snap to an existing wall endpoint or the
			// offset line so a "new wall" cleanly latches onto prior geometry.
			const snap = snapDrawPoint(lngLat);
			pendingStart = snap?.snapped ?? lngLat;
			return;
		}

		// Second click — try snapping to vertex, offset, or 90° angle (in that
		// priority). When no priority snap matches, the candidate is used raw.
		const segs = segments();
		const last = segs[segs.length - 1];
		const pivot = pendingStart;
		const prevDir =
			last && last.length >= 2 ? last[last.length - 2] : segs[segs.length - 1]?.[0];
		const snap = snapDrawPoint(lngLat, {
			pivot,
			prevDir: prevDir as LngLat | undefined
		});
		const end: LngLat = snap?.snapped ?? lngLat;

		const updated = [...segs, [pendingStart, end] as LngLat[]];
		setSegments(updated);
		pendingStart = null;
		tool = 'pan';
		scheduleSave();
	}

	function cancelDraw() {
		pendingStart = null;
		tool = 'pan';
		clearHover();
	}

	// --- map -----------------------------------------------------------------
	let mapContainer: HTMLDivElement | undefined = $state();
	let mapStatus: 'idle' | 'loading' | 'ready' = $state('idle');
	let mapInstance: MLMap | null = null;
	let activeVertexMarkers: MLMarker[] = [];
	let labelMarkers: MLMarker[] = [];
	let mlCtors: {
		Marker: typeof import('maplibre-gl').Marker;
		LngLatBounds: typeof import('maplibre-gl').LngLatBounds;
	} | null = null;
	let snapHintCoords = $state<LngLat[] | null>(null);
	let snapHintLabel = $state<string>('');

	/** Per-edge length-edit state. Keyed by `${segIdx}:${edgeIdx}`; value is
	 *  the in-progress text input. The active wall's edges show in the side
	 *  panel and each edge has its own little input. */
	let edgeLenInputs = $state<Record<string, string>>({});
	/** Briefly highlight an edge after a successful Set Length action. */
	let recentlySetEdge = $state<string | null>(null);

	// --- map layer toggles -------------------------------------------------
	function readToggle(key: string, def: boolean): boolean {
		if (!browser) return def;
		try {
			const v = localStorage.getItem(key);
			return v === null ? def : v === '1';
		} catch {
			return def;
		}
	}
	// svelte-ignore state_referenced_locally
	let showBoundary = $state(readToggle('eq.step2.showBoundary', true));
	// New key (`.v2`) so any stale `0` from the previous toggle iteration
	// is ignored and users land on the default-ON behaviour.
	// svelte-ignore state_referenced_locally
	let showLabels = $state(readToggle('eq.step2.showLabels.v2', true));

	$effect(() => {
		const v = showBoundary;
		if (!browser) return;
		try {
			localStorage.setItem('eq.step2.showBoundary', v ? '1' : '0');
		} catch {
			/* private mode or quota — fail silently */
		}
	});

	$effect(() => {
		const v = showLabels;
		if (!browser) return;
		try {
			localStorage.setItem('eq.step2.showLabels.v2', v ? '1' : '0');
		} catch {
			/* private mode — fine */
		}
	});

	// Apply boundary visibility via MapLibre layout properties (cheap, no relayout).
	$effect(() => {
		const v = showBoundary;
		if (!browser || !mapInstance || mapStatus !== 'ready') return;
		for (const id of ['boundary-line', 'boundary-fill']) {
			try {
				mapInstance.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none');
			} catch {
				/* layer not ready yet */
			}
		}
	});

	const initialCenter: LngLat = (() => {
		// svelte-ignore state_referenced_locally
		for (const w of initialData.walls) {
			const segs = pathToSegments(w.pathGeoJson ?? null);
			for (const seg of segs) if (seg.length > 0) return seg[seg.length - 1];
		}
		// svelte-ignore state_referenced_locally
		const g = initialData.site.geocode;
		if (g) return [g.lng, g.lat];
		return [153.026, -27.4698];
	})();

	$effect(() => {
		if (!browser) return;
		const container = mapContainer;
		const token = mapboxToken;
		if (!container || !token) {
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
			mlCtors = { Marker: maplibregl.Marker, LngLatBounds: maplibregl.LngLatBounds };

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
				center: initialCenter,
				zoom: 19,
				minZoom: 14,
				maxZoom: 21.5,
				attributionControl: { compact: true }
			});

			m.addControl(
				new maplibregl.NavigationControl({ visualizePitch: false, showCompass: false }),
				'top-right'
			);

			m.on('load', () => {
				if (cancelled) return;

				const empty = (): GeoJSON.FeatureCollection => ({
					type: 'FeatureCollection',
					features: []
				});

				m.addSource('boundary', { type: 'geojson', data: empty() });
				m.addSource('walls-other', { type: 'geojson', data: empty() });
				m.addSource('wall-active', { type: 'geojson', data: empty() });
				m.addSource('wall-active-offset', { type: 'geojson', data: empty() });
				m.addSource('wall-segment-labels', { type: 'geojson', data: empty() });
				m.addSource('snap-hint', { type: 'geojson', data: empty() });
				m.addSource('hover-ghost', { type: 'geojson', data: empty() });
				m.addSource('pending-start', { type: 'geojson', data: empty() });

				// Property boundary — solid yellow perimeter, slightly translucent fill so
				// the lot reads at a glance without obscuring the satellite imagery.
				m.addLayer({
					id: 'boundary-fill',
					source: 'boundary',
					type: 'fill',
					paint: {
						'fill-color': '#ffd23f',
						'fill-opacity': 0.05
					}
				});
				m.addLayer({
					id: 'boundary-line',
					source: 'boundary',
					type: 'line',
					paint: {
						'line-color': '#ffd23f',
						'line-width': 2.5,
						'line-opacity': 0.95
					}
				});

				// Other walls — slightly faded; thinner than the active wall so
				// the active one reads as "in focus".
				m.addLayer({
					id: 'walls-other-line',
					source: 'walls-other',
					type: 'line',
					paint: { 'line-color': '#ff8a1c', 'line-width': 1.6, 'line-opacity': 0.55 }
				});

				// Offset (set-back) line — dashed, green so it visually pairs with
				// the green snap hint and the green start-dot when drawing. Sits
				// behind the wall line so the wall reads as primary.
				m.addLayer({
					id: 'wall-active-offset-line',
					source: 'wall-active-offset',
					type: 'line',
					paint: {
						'line-color': '#7fd99a',
						'line-width': 1.4,
						'line-opacity': 0.85,
						'line-dasharray': [3, 3]
					}
				});

				// Active wall — thinner than before; reference designs use ~2.5px
				// so the wall sits clearly on the satellite without burying detail.
				m.addLayer({
					id: 'wall-active-line',
					source: 'wall-active',
					type: 'line',
					paint: {
						'line-color': '#ff8a1c',
						'line-width': 2.5
					}
				});

				// Focused-section overlay — same source, filtered to the single
				// segIdx in `focusedSectionIdx`. Slightly thicker + brighter so
				// the selected section pops without dwarfing the unfocused parts.
				m.addLayer({
					id: 'wall-active-focused',
					source: 'wall-active',
					type: 'line',
					filter: ['==', ['get', 'segIdx'], -1],
					paint: {
						'line-color': '#ffd28a',
						'line-width': 5,
						'line-opacity': 0.95
					}
				});

				m.addLayer({
					id: 'hover-ghost-line',
					source: 'hover-ghost',
					type: 'line',
					paint: {
						'line-color': '#ff8a1c',
						'line-width': 2,
						'line-opacity': 0.55,
						'line-dasharray': [1, 2]
					}
				});

				m.addLayer({
					id: 'snap-hint-line',
					source: 'snap-hint',
					type: 'line',
					paint: {
						'line-color': '#a8e0b3',
						'line-width': 1.5,
						'line-opacity': 0.9,
						'line-dasharray': [1, 1]
					}
				});

				// Pulsing-glow dot at the pending start point during a draw.
				m.addLayer({
					id: 'pending-start-glow',
					source: 'pending-start',
					type: 'circle',
					paint: {
						'circle-color': '#4ad165',
						'circle-radius': 14,
						'circle-opacity': 0.35,
						'circle-blur': 0.6
					}
				});
				m.addLayer({
					id: 'pending-start-dot',
					source: 'pending-start',
					type: 'circle',
					paint: {
						'circle-color': '#4ad165',
						'circle-radius': 7,
						'circle-stroke-width': 2,
						'circle-stroke-color': '#ffffff'
					}
				});

				// Wall segment labels are now rendered as HTML Markers for the pill look —
				// see syncSourcesAndMarkers. We keep the empty source around so older
				// references / future features that want a symbol layer can hook in.

				m.doubleClickZoom.disable();
				m.on('click', onMapClick);
				m.on('mousemove', onMapMouseMove);
				m.on('mouseleave', () => clearHover());
				m.on('dblclick', onMapDblClick);

				// Pointer cursor when hovering over any wall line in Pan mode —
				// communicates that the line is clickable.
				const setPointer = () => {
					if (tool === 'pan' && mapInstance) {
						mapInstance.getCanvas().style.cursor = 'pointer';
					}
				};
				const clearPointer = () => {
					if (tool === 'pan' && mapInstance) {
						mapInstance.getCanvas().style.cursor = '';
					}
				};
				m.on('mouseenter', 'walls-other-line', setPointer);
				m.on('mouseleave', 'walls-other-line', clearPointer);
				m.on('mouseenter', 'wall-active-line', setPointer);
				m.on('mouseleave', 'wall-active-line', clearPointer);

				mapInstance = m;
				mapStatus = 'ready';
				syncSourcesAndMarkers();
			});
		})();

		return () => {
			cancelled = true;
			tearDown();
		};
	});

	function tearDown() {
		clearVertexMarkers();
		clearLabelMarkers();
		mapInstance?.remove();
		mapInstance = null;
		mapStatus = 'idle';
	}

	function clearVertexMarkers() {
		for (const m of activeVertexMarkers) m.remove();
		activeVertexMarkers = [];
	}

	function clearLabelMarkers() {
		for (const m of labelMarkers) m.remove();
		labelMarkers = [];
	}

	type LabelKind =
		| 'wall-active'
		| 'wall-other'
		| 'boundary'
		| 'offset'
		| 'wall-name'
		| 'ground';

	function addLabelMarker(opts: {
		map: MLMap;
		Marker: typeof import('maplibre-gl').Marker;
		lngLat: LngLat;
		text: string;
		kind: LabelKind;
	}) {
		const el = document.createElement('div');
		el.className = `edge-label edge-label--${opts.kind}`;
		el.textContent = opts.text;
		const marker = new opts.Marker({ element: el, anchor: 'center' })
			.setLngLat(opts.lngLat)
			.addTo(opts.map);
		labelMarkers.push(marker);
	}

	function onMapClick(e: MapMouseEvent) {
		const target = (e.originalEvent.target as HTMLElement) ?? null;
		if (target && target.closest('.vertex-handle')) return;

		// In Pan mode, clicks on wall lines route to wall/section selection
		// instead of falling through to the draw logic. queryRenderedFeatures
		// gives us pixel-accurate hit testing against the rendered layers.
		if (tool === 'pan' && mapInstance) {
			const hits = mapInstance.queryRenderedFeatures(e.point, {
				layers: ['walls-other-line', 'wall-active-line']
			});
			if (hits.length > 0) {
				const f = hits[0];
				const wallId = f.properties?.wallId as string | undefined;
				const segIdx = f.properties?.segIdx;
				const segNum = typeof segIdx === 'number' ? segIdx : null;
				if (wallId && wallId !== activeWallId) {
					selectWall(wallId, segNum);
				} else if (wallId && wallId === activeWallId) {
					focusedSectionIdx = segNum;
					mapVersion++;
				}
				return;
			}
			// Pan-mode click on empty map clears any focused section.
			if (focusedSectionIdx !== null) {
				focusedSectionIdx = null;
				mapVersion++;
			}
			return;
		}

		handleMapClick([e.lngLat.lng, e.lngLat.lat]);
	}

	function onMapMouseMove(e: MapMouseEvent) {
		if (!mapInstance) return;
		if (tool !== 'draw') {
			clearHover();
			return;
		}
		const ll: LngLat = [e.lngLat.lng, e.lngLat.lat];

		// Pending start === null → user is about to click the START of a line.
		// Preview the vertex/offset snap so they see where the start will land.
		if (pendingStart === null) {
			const startSnap = snapDrawPoint(ll);
			if (startSnap) {
				snapHintLabel = `snap → ${startSnap.label}`;
				snapHintCoords = [startSnap.snapped, ll];
				setSnapHint(snapHintCoords);
			} else {
				snapHintLabel = '';
				snapHintCoords = null;
				setSnapHint(null);
			}
			setHoverGhost(null);
			return;
		}

		// Pending start set → preview the line from start to candidate end,
		// snapped against vertex / offset line / 90° angle (priority order).
		const segs = segments();
		const last = segs[segs.length - 1];
		const prevDir =
			last && last.length >= 2 ? last[last.length - 2] : segs[segs.length - 1]?.[0];
		const snap = snapDrawPoint(ll, {
			pivot: pendingStart,
			prevDir: prevDir as LngLat | undefined
		});
		const endPoint: LngLat = snap?.snapped ?? ll;

		setHoverGhost([pendingStart, endPoint]);
		if (snap) {
			snapHintCoords = [pendingStart, endPoint];
			snapHintLabel = `snap → ${snap.label}`;
			setSnapHint(snapHintCoords);
		} else {
			snapHintCoords = null;
			snapHintLabel = '';
			setSnapHint(null);
		}
	}

	function clearHover() {
		setHoverGhost(null);
		setSnapHint(null);
		snapHintCoords = null;
		snapHintLabel = '';
	}

	function setPendingStartMarker(coord: LngLat | null) {
		const src = mapInstance?.getSource('pending-start') as GeoJSONSource | undefined;
		if (!src) return;
		src.setData(
			coord
				? {
						type: 'Feature',
						properties: {},
						geometry: { type: 'Point', coordinates: coord }
					}
				: { type: 'FeatureCollection', features: [] }
		);
	}

	/**
	 * Map double-click → insert a vertex on the closest wall segment if the
	 * click is within ~1 m of a line. Default MapLibre double-click-zoom is
	 * disabled to free the gesture for this. Vertex deletion uses dblclick on
	 * the marker DOM elements (handled inside syncSourcesAndMarkers).
	 */
	function onMapDblClick(e: MapMouseEvent) {
		const target = (e.originalEvent.target as HTMLElement) ?? null;
		if (target && target.closest('.vertex-handle')) return;
		const click: LngLat = [e.lngLat.lng, e.lngLat.lat];
		const w = activeWall();
		if (!w) return;
		const segs = pathToSegments(w.pathGeoJson ?? null);
		let best: { segIdx: number; edgeIdx: number; distM: number } | null = null;
		for (let si = 0; si < segs.length; si++) {
			if (segs[si].length < 2) continue;
			const result = nearestSegment(click, segs[si]);
			if (!result) continue;
			if (!best || result.distanceM < best.distM) {
				best = { segIdx: si, edgeIdx: result.index, distM: result.distanceM };
			}
		}
		if (best && best.distM < 1.5) {
			insertVertexInSegment(best.segIdx, best.edgeIdx, click);
		}
	}

	function setHoverGhost(coords: LngLat[] | null) {
		const src = mapInstance?.getSource('hover-ghost') as GeoJSONSource | undefined;
		if (!src) return;
		src.setData(
			coords && coords.length >= 2
				? {
						type: 'Feature',
						properties: {},
						geometry: { type: 'LineString', coordinates: coords }
					}
				: { type: 'FeatureCollection', features: [] }
		);
	}

	function setSnapHint(coords: LngLat[] | null) {
		const src = mapInstance?.getSource('snap-hint') as GeoJSONSource | undefined;
		if (!src) return;
		src.setData(
			coords && coords.length >= 2
				? {
						type: 'Feature',
						properties: {},
						geometry: { type: 'LineString', coordinates: coords }
					}
				: { type: 'FeatureCollection', features: [] }
		);
	}

	// --- effect: sync map sources + vertex markers ------------------------
	$effect(() => {
		mapVersion;
		if (!browser || !mapInstance || mapStatus !== 'ready') return;
		// If a drag is in flight, the drag handler is already keeping the
		// sources and labels live. Any incidental re-sync here would clear
		// and re-create the dragging marker mid-gesture and break the drag.
		if (dragging) return;
		untrack(() => syncSourcesAndMarkers());
	});

	// --- effect: keep the pending-start dot in sync -----------------------
	$effect(() => {
		const ps = pendingStart;
		if (!browser || !mapInstance || mapStatus !== 'ready') return;
		untrack(() => setPendingStartMarker(ps));
	});

	// --- effect: filter the focused-section overlay layer ---------------
	$effect(() => {
		const idx = focusedSectionIdx;
		if (!browser || !mapInstance || mapStatus !== 'ready') return;
		try {
			mapInstance.setFilter('wall-active-focused', [
				'==',
				['get', 'segIdx'],
				idx === null ? -1 : idx
			]);
		} catch {
			/* layer not yet ready */
		}
	});

	/**
	 * Set the length of an arbitrary edge (between vertex `edgeIdx` and
	 * vertex `edgeIdx+1`) in segment `segIdx` of the active wall. The end
	 * vertex is moved along the existing bearing to produce exactly the
	 * target metres; every subsequent vertex in the same sub-segment is
	 * translated by the same delta so the downstream geometry preserves
	 * its shape and just shifts.
	 */
	function setEdgeLength(segIdx: number, edgeIdx: number, target: number): boolean {
		if (!Number.isFinite(target) || target < 0.05 || target > 500) return false;
		const segs = segments();
		const seg = segs[segIdx];
		if (!seg || edgeIdx < 0 || edgeIdx + 1 >= seg.length) return false;

		const a = seg[edgeIdx];
		const b = seg[edgeIdx + 1];
		const local = lngLatToLocal(b, a);
		const currentLen = Math.hypot(local.x, local.y);
		if (currentLen < 1e-6) return false;

		const scale = target / currentLen;
		const newB = localToLngLat({ x: local.x * scale, y: local.y * scale }, a);
		const dLng = newB[0] - b[0];
		const dLat = newB[1] - b[1];

		const updated = segs.slice();
		updated[segIdx] = seg.map((v, i) =>
			i > edgeIdx ? ([v[0] + dLng, v[1] + dLat] as LngLat) : v
		);
		setSegments(updated);
		scheduleSave();
		return true;
	}

	/** Apply the pending value from the side panel for one edge. */
	function applyEdgeInput(segIdx: number, edgeIdx: number) {
		const key = `${segIdx}:${edgeIdx}`;
		const raw = edgeLenInputs[key];
		if (raw === undefined || raw === '') return;
		const target = parseFloat(raw);
		const ok = setEdgeLength(segIdx, edgeIdx, target);
		if (ok) {
			edgeLenInputs = { ...edgeLenInputs, [key]: '' };
			recentlySetEdge = key;
			setTimeout(() => {
				if (recentlySetEdge === key) recentlySetEdge = null;
			}, 1200);
		}
	}

	$effect(() => {
		const t = tool;
		if (!browser || !mapInstance || mapStatus !== 'ready') return;
		mapInstance.getCanvas().style.cursor = t === 'draw' ? 'crosshair' : '';
		if (t === 'pan') untrack(() => clearHover());
	});

	/**
	 * Live drag is the key reason this function takes `skipVertexMarkers`.
	 * While the user is dragging a vertex, MapLibre is actively moving that
	 * marker DOM element; if we clear and re-create vertex markers during
	 * each drag frame, the dragging marker gets destroyed mid-gesture and
	 * the drag breaks. So we update the line sources and labels (which the
	 * user expects to follow live) but leave the vertex marker layer alone
	 * until the drag ends.
	 */
	function syncSourcesAndMarkers(opts: { skipVertexMarkers?: boolean } = {}) {
		if (!mapInstance) return;
		const m = mapInstance;
		const aId = activeWallId;
		const aWall = data.walls.find((w) => w.id === aId);
		const aSegments = aWall ? pathToSegments(aWall.pathGeoJson ?? null) : [];
		const offsetMm = aWall?.defaults.boundaryOffsetMm ?? 300;

		// Other walls — every sub-segment tagged with wallId + segIdx so a
		// click on a faded wall can route to selectWall() with the right id.
		const otherFeatures: GeoJSON.Feature[] = [];
		for (const w of data.walls) {
			if (w.id === aId) continue;
			const segs = pathToSegments(w.pathGeoJson ?? null);
			segs.forEach((seg, si) => {
				if (seg.length >= 2) {
					otherFeatures.push({
						type: 'Feature',
						properties: { wallId: w.id, wallName: w.name, segIdx: si },
						geometry: { type: 'LineString', coordinates: seg }
					});
				}
			});
		}
		(m.getSource('walls-other') as GeoJSONSource).setData({
			type: 'FeatureCollection',
			features: otherFeatures
		});

		// Active wall: one feature per renderable sub-segment, tagged with
		// segIdx so a click can highlight the right section in the sidebar.
		const activeFeatures: GeoJSON.Feature[] = [];
		const offsetFeatures: GeoJSON.Feature[] = [];
		aSegments.forEach((seg, si) => {
			if (seg.length >= 2) {
				activeFeatures.push({
					type: 'Feature',
					properties: { wallId: aId, segIdx: si },
					geometry: { type: 'LineString', coordinates: seg }
				});
				const off = offsetPolyline(seg, offsetMm / 1000);
				if (off.length >= 2) {
					offsetFeatures.push({
						type: 'Feature',
						properties: { wallId: aId, segIdx: si },
						geometry: { type: 'LineString', coordinates: off }
					});
				}
			}
		});
		(m.getSource('wall-active') as GeoJSONSource).setData({
			type: 'FeatureCollection',
			features: activeFeatures
		});
		(m.getSource('wall-active-offset') as GeoJSONSource).setData({
			type: 'FeatureCollection',
			features: offsetFeatures
		});

		// Length labels + name pills + ground-level pills — all rendered as
		// HTML markers so we get full CSS pill styling and crisp text.
		clearLabelMarkers();
		if (mlCtors) {
			const { Marker } = mlCtors;
			const pushSegmentLabels = (segs: LngLat[][], kind: LabelKind) => {
				for (const seg of segs) {
					for (let i = 0; i < seg.length - 1; i++) {
						const a = seg[i];
						const b = seg[i + 1];
						const len = haversineMeters(a, b);
						if (len < 0.05) continue; // skip near-zero spurs
						const mid: LngLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
						addLabelMarker({
							map: m,
							Marker,
							lngLat: mid,
							text: `${len.toFixed(2)} m`,
							kind
						});
					}
				}
			};
			pushSegmentLabels(aSegments, 'wall-active');
			for (const w of data.walls) {
				if (w.id === aId) continue;
				pushSegmentLabels(pathToSegments(w.pathGeoJson ?? null), 'wall-other');
			}

			// Wall name pill — offset perpendicular to the wall so it sits
			// BESIDE the wall's edge-length label instead of stacking on top
			// of it. For a two-vertex wall (the common case) the centroid IS
			// the edge midpoint, which is where the length pill lives — that
			// was the bug that made the wall length look "missing".
			const wallNameAnchor = (segs: LngLat[][]): LngLat | null => {
				// Find the longest sub-segment (most stable anchor for multi-
				// segment walls) and offset perpendicular to its first edge.
				let bestSeg: LngLat[] | null = null;
				let bestLen = -1;
				for (const seg of segs) {
					if (seg.length < 2) continue;
					const len = polylineLengthMeters(seg);
					if (len > bestLen) {
						bestLen = len;
						bestSeg = seg;
					}
				}
				if (!bestSeg) return null;
				// Offset by ~6 metres perpendicular — clears the edge label
				// pill at any sensible zoom while staying clearly "on" the wall.
				return perpendicularLabelAnchor({
					a: bestSeg[0],
					b: bestSeg[1],
					offsetMeters: 6
				});
			};
			for (const w of data.walls) {
				const segs = pathToSegments(w.pathGeoJson ?? null);
				const anchor = wallNameAnchor(segs);
				if (!anchor) continue;
				addLabelMarker({
					map: m,
					Marker,
					lngLat: anchor,
					text: w.name,
					kind: 'wall-name'
				});
			}

			// Ground-level pills at section endpoints — show the start height
			// at the very first vertex of the wall, then the end height at the
			// last vertex of every section. End[i] = Start[i+1] by the chain,
			// so labelling only ends after the first section gives a clean
			// one-pill-per-junction effect.
			//
			// Each pill is offset PERPENDICULAR to the wall's local direction
			// by ~2.5 m so it sits beside the vertex instead of on top of
			// it — the boss flagged that on-vertex pills blocked the vertex
			// handle and made the endpoint impossible to pinpoint.
			const GROUND_PILL_OFFSET_M = 2.5;
			const offsetPerpFromVertex = (
				vertex: LngLat,
				edgeOther: LngLat,
				offsetMeters: number
			): LngLat => {
				const lo = lngLatToLocal(edgeOther, vertex);
				const len = Math.hypot(lo.x, lo.y) || 1;
				// Left-hand normal of vertex→edgeOther direction.
				const nx = -lo.y / len;
				const ny = lo.x / len;
				return localToLngLat({ x: nx * offsetMeters, y: ny * offsetMeters }, vertex);
			};

			if (aWall && aSegments.length > 0) {
				for (let i = 0; i < aSegments.length; i++) {
					const seg = aSegments[i];
					if (seg.length < 2) continue;
					if (i === 0) {
						const startMm = sectionStartMm(aWall, 0);
						// First vertex offset: perpendicular to the section's
						// first edge (vertex 0 → vertex 1).
						const anchor = offsetPerpFromVertex(
							seg[0],
							seg[1],
							GROUND_PILL_OFFSET_M
						);
						addLabelMarker({
							map: m,
							Marker,
							lngLat: anchor,
							text: `${Math.round(startMm)} mm`,
							kind: 'ground'
						});
					}
					const endMm = sectionEndMm(aWall, i);
					// End vertex offset: perpendicular to the section's LAST
					// edge (vertex n-1 → vertex n, computed by passing the
					// "other" vertex so the direction matches travel).
					const lastIdx = seg.length - 1;
					const anchor = offsetPerpFromVertex(
						seg[lastIdx],
						seg[lastIdx - 1],
						GROUND_PILL_OFFSET_M
					);
					addLabelMarker({
						map: m,
						Marker,
						lngLat: anchor,
						text: `${Math.round(endMm)} mm`,
						kind: 'ground'
					});
				}
			}
		}

		// Property boundary fill + outline + per-edge labels.
		const boundary = data.site.propertyBoundaryGeoJson;
		(m.getSource('boundary') as GeoJSONSource).setData(
			boundary
				? {
						type: 'Feature',
						properties: {},
						geometry: boundary as GeoJSON.Polygon
					}
				: { type: 'FeatureCollection', features: [] }
		);
		// Boundary edge labels — one per edge of the outer ring.
		if (mlCtors && boundary && boundary.coordinates[0]) {
			const ring = boundary.coordinates[0];
			for (let i = 0; i < ring.length - 1; i++) {
				const a = ring[i] as LngLat;
				const b = ring[i + 1] as LngLat;
				const len = haversineMeters(a, b);
				if (len < 0.5) continue; // skip the tiny closing spur duplicates
				const mid: LngLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
				addLabelMarker({
					map: m,
					Marker: mlCtors.Marker,
					lngLat: mid,
					text: `${len.toFixed(2)} m`,
					kind: 'boundary'
				});
			}
		}

		// Offset distance label — show once the offset is at least 250 mm
		// (AS 4678 minimum). At a typical 300 mm offset and zoom 19, the wall
		// and offset line are ~10 px apart so the label sits between them with
		// room to read. Smaller offsets are still visible via the dashed line
		// itself plus the value in the wall settings panel.
		if (mlCtors && aWall && offsetMm >= 250) {
			let longestSeg: LngLat[] | null = null;
			let longestLen = 0;
			for (const seg of aSegments) {
				if (seg.length < 2) continue;
				const segLen = polylineLengthMeters(seg);
				if (segLen > longestLen) {
					longestLen = segLen;
					longestSeg = seg;
				}
			}
			if (longestSeg && longestLen >= 1) {
				// Use the longest individual edge inside that sub-segment for the anchor.
				let bestA: LngLat = longestSeg[0];
				let bestB: LngLat = longestSeg[1];
				let bestEdgeLen = haversineMeters(bestA, bestB);
				for (let i = 1; i < longestSeg.length - 1; i++) {
					const len = haversineMeters(longestSeg[i], longestSeg[i + 1]);
					if (len > bestEdgeLen) {
						bestEdgeLen = len;
						bestA = longestSeg[i];
						bestB = longestSeg[i + 1];
					}
				}
				const anchor = perpendicularLabelAnchor({
					a: bestA,
					b: bestB,
					offsetMeters: offsetMm / 1000
				});
				addLabelMarker({
					map: m,
					Marker: mlCtors.Marker,
					lngLat: anchor,
					text: `${offsetMm} mm`,
					kind: 'offset'
				});
			}
		}

		// Vertex markers — every vertex of every sub-segment of the active wall.
		// Drag = move (always). Double-click = delete. Click during Draw mode
		// = snap the next clicked point to this vertex's exact coordinates.
		// Skipped during a live drag so we don't destroy the dragging marker
		// mid-gesture (see opts comment on syncSourcesAndMarkers).
		if (opts.skipVertexMarkers) return;
		clearVertexMarkers();
		if (mlCtors && aWall) {
			const { Marker } = mlCtors;
			aSegments.forEach((seg, segIdx) => {
				seg.forEach((c, vertexIdx) => {
					const ref: VertexRef = { segIdx, vertexIdx };
					const el = document.createElement('div');
					el.className = 'vertex-handle';
					const marker = new Marker({ element: el, draggable: true })
						.setLngLat(c)
						.addTo(m);

					// Live drag — fires on every cursor frame. Update the
					// wall's pathGeoJson directly (no mapVersion bump, no
					// scheduleSave) and re-render lines + labels so the user
					// sees the geometry follow their cursor in real time.
					marker.on('dragstart', () => {
						dragging = true;
					});
					marker.on('drag', () => {
						const ll = marker.getLngLat();
						const aw = activeWall();
						if (!aw) return;
						const segsLive = pathToSegments(aw.pathGeoJson ?? null);
						if (!segsLive[ref.segIdx] || !segsLive[ref.segIdx][ref.vertexIdx]) return;
						segsLive[ref.segIdx] = segsLive[ref.segIdx].slice();
						segsLive[ref.segIdx][ref.vertexIdx] = [ll.lng, ll.lat];
						aw.pathGeoJson = segmentsToPath(segsLive);
						// Sources + labels follow the cursor; vertex marker
						// stays intact so the drag gesture isn't interrupted.
						syncSourcesAndMarkers({ skipVertexMarkers: true });
					});
					marker.on('dragend', () => {
						dragging = false;
						const ll = marker.getLngLat();
						// Full commit — bumps mapVersion (triggers proper
						// vertex marker refresh) and schedules the save.
						moveVertex(ref, [ll.lng, ll.lat]);
					});
					el.addEventListener('click', (e) => {
						e.stopPropagation();
						if (tool !== 'draw') return;
						// Snap the next draw click to this vertex's exact coords.
						const segsNow = segments();
						const v = segsNow[ref.segIdx]?.[ref.vertexIdx];
						if (v) handleMapClick(v);
					});
					el.addEventListener('dblclick', (e) => {
						e.preventDefault();
						e.stopPropagation();
						deleteVertex(ref);
					});
					activeVertexMarkers.push(marker);
				});
			});
		}
	}

	// --- keyboard shortcuts ------------------------------------------------
	function onKey(e: KeyboardEvent) {
		const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
		if (tag === 'input' || tag === 'textarea') return;
		if (e.key === 'v' || e.key === 'V') {
			cancelDraw();
		} else if (e.key === 'd' || e.key === 'D') {
			tool = 'draw';
		} else if (e.key === 'Escape') {
			cancelDraw();
		} else if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			undoLast();
		}
	}

	// --- boundary auto-fetch (once per quote) -----------------------------
	let boundaryFetchAttempted = false;
	$effect(() => {
		if (!browser || boundaryFetchAttempted) return;
		const g = data.site.geocode;
		const attempted = data.site.boundaryAttempted;
		if (!g || attempted) return;
		boundaryFetchAttempted = true;
		(async () => {
			try {
				const params = new URLSearchParams({
					lat: String(g.lat),
					lng: String(g.lng),
					...(data.site.state ? { state: data.site.state } : {})
				});
				const res = await fetch(`/api/cadastre?${params}`);
				if (!res.ok) return;
				const body = (await res.json()) as {
					boundary: { type: 'Polygon'; coordinates: [number, number][][] } | null;
				};
				data.site.propertyBoundaryGeoJson = body.boundary ?? null;
				data.site.boundaryAttempted = true;
				mapVersion++;
				scheduleSave();
				if (body.boundary) {
					setTimeout(() => fitMapToContent(), 700);
				}
			} catch {
				/* fall back to no boundary */
			}
		})();
	});

	// --- initial init ------------------------------------------------------
	ensureActiveWall();

	$effect(() => {
		if (!browser || !mapInstance || mapStatus !== 'ready' || !mlCtors) return;
		untrack(() => fitMapToContent());
	});

	function fitMapToContent() {
		if (!mapInstance || !mlCtors) return;
		const { LngLatBounds } = mlCtors;
		const points: LngLat[] = [];
		for (const w of data.walls) {
			for (const seg of pathToSegments(w.pathGeoJson ?? null)) {
				for (const c of seg) points.push(c);
			}
		}
		const boundary = data.site.propertyBoundaryGeoJson;
		if (boundary) {
			for (const ring of boundary.coordinates) {
				for (const c of ring) points.push(c as LngLat);
			}
		}
		if (points.length === 0) return;
		if (points.length === 1) {
			mapInstance.flyTo({ center: points[0], zoom: 19, duration: 600 });
			return;
		}
		const bounds = points.reduce(
			(b, p) => b.extend(p),
			new LngLatBounds(points[0], points[0])
		);
		mapInstance.fitBounds(bounds, { padding: 60, duration: 600, maxZoom: 20 });
	}

	// --- derived totals ----------------------------------------------------
	const totals = $derived(() => {
		const perWall = data.walls.map((w) => ({
			id: w.id,
			name: w.name,
			meters: multiPolylineLengthMeters(pathToSegments(w.pathGeoJson ?? null))
		}));
		const total = perWall.reduce((s, p) => s + p.meters, 0);
		return { perWall, total };
	});

	const activeWallSegmentCount = $derived(() => segments().length);

	/** Render-helpers for the side panel — per-active-wall list of sub-segments,
	 *  each with edges, lengths, and chained start/end retained heights. */
	const sidebarSegments = $derived(() => {
		const w = activeWall();
		if (!w)
			return [] as Array<{
				length: number;
				startMm: number;
				endMm: number;
				avgMm: number;
				m2: number;
				edges: Array<{ length: number }>;
			}>;
		const segs = pathToSegments(w.pathGeoJson ?? null);
		return segs.map((seg, idx) => {
			const edges: Array<{ length: number }> = [];
			for (let i = 0; i < seg.length - 1; i++) {
				edges.push({ length: haversineMeters(seg[i], seg[i + 1]) });
			}
			const length = polylineLengthMeters(seg);
			const startMm = sectionStartMm(w, idx);
			const endMm = sectionEndMm(w, idx);
			const avgMm = (startMm + endMm) / 2;
			const m2 = length * (avgMm / 1000);
			return { length, startMm, endMm, avgMm, m2, edges };
		});
	});

	const wallTotalM2 = $derived(() => sidebarSegments().reduce((s, x) => s + x.m2, 0));

	// --- per-wall settings panel ------------------------------------------
	let settingsOpen = $state(false);

	function setBoundaryOffset(value: number) {
		const w = activeWall();
		if (!w) return;
		const clamped = Math.max(250, Math.min(1000, Math.round(value)));
		if (w.defaults.boundaryOffsetMm === clamped) return;
		w.defaults.boundaryOffsetMm = clamped;
		mapVersion++;
		scheduleSave();
	}

	function setPostSpacing(value: number) {
		const w = activeWall();
		if (!w) return;
		const clamped = Math.max(1500, Math.min(3000, Math.round(value)));
		if (w.defaults.postSpacingMm === clamped) return;
		w.defaults.postSpacingMm = clamped;
		scheduleSave();
	}

	function setConcreteStrength(value: 'N25' | 'N32') {
		const w = activeWall();
		if (!w) return;
		if (w.defaults.concreteStrength === value) return;
		w.defaults.concreteStrength = value;
		scheduleSave();
	}

	// --- site photos ------------------------------------------------------
	// Lives on Step 2 (not Step 1) because this is when the estimator is
	// physically at the property and can take real on-site photos.
	let photoUploading = $state(false);
	let photoCount = $state(0);
	let photoError = $state('');
	// Collapsed by default — photos sit in the sidebar accordion and most
	// quoting sessions open the page without needing to look at them.
	// svelte-ignore state_referenced_locally
	let photosExpanded = $state(initialData.photos.length > 0);

	async function onPhotoPick(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const files = input.files;
		if (!files || files.length === 0) return;
		photoError = '';
		photoUploading = true;
		photoCount = files.length;
		try {
			const fd = new FormData();
			for (const f of files) fd.append('files', f);
			const res = await fetch(`/api/quotes/${quoteId}/photos`, { method: 'POST', body: fd });
			if (res.status === 409) {
				photoError = 'Quote was edited elsewhere — reload to continue.';
				return;
			}
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				photoError = body.error ?? `Upload failed (${res.status})`;
				return;
			}
			const body = (await res.json()) as {
				photos: Photo[];
				dataHash: string;
				versionNumber: number;
			};
			data.photos = body.photos;
			dataHash = body.dataHash;
			versionNumber = body.versionNumber;
		} catch (err) {
			photoError = err instanceof Error ? err.message : 'Upload failed';
		} finally {
			photoUploading = false;
			photoCount = 0;
			input.value = '';
		}
	}

	async function deletePhoto(id: string) {
		if (!confirm('Remove this photo?')) return;
		photoError = '';
		try {
			const res = await fetch(`/api/quotes/${quoteId}/photos/${id}`, { method: 'DELETE' });
			if (!res.ok) {
				photoError = `Delete failed (${res.status})`;
				return;
			}
			const body = (await res.json()) as { ok: true; dataHash: string };
			data.photos = data.photos.filter((p) => p.id !== id);
			dataHash = body.dataHash;
		} catch (err) {
			photoError = err instanceof Error ? err.message : 'Delete failed';
		}
	}
</script>

<svelte:window onkeydown={onKey} />

<div class="step2">
	<header class="topbar">
		<div class="walls-tabs" role="tablist">
			{#each data.walls as w (w.id)}
				{@const len = multiPolylineLengthMeters(pathToSegments(w.pathGeoJson ?? null))}
				<button
					type="button"
					role="tab"
					class="tab"
					class:active={w.id === activeWallId}
					onclick={() => selectWall(w.id)}
				>
					<span class="tab-name">{w.name}</span>
					<span class="tab-len">{len.toFixed(1)} m</span>
				</button>
			{/each}
			<button type="button" class="tab add" onclick={startNewWall}>+ Add wall</button>
		</div>

		<div class="mode-actions">
			<button
				type="button"
				class="btn ghost"
				class:on={settingsOpen}
				onclick={() => (settingsOpen = !settingsOpen)}
				disabled={!activeWall()}
				title="Wall settings"
				aria-expanded={settingsOpen}
			>
				⚙ Wall settings
			</button>
			<button
				type="button"
				class="btn ghost"
				onclick={undoLast}
				disabled={pendingStart === null && activeWallSegmentCount() === 0}
				title="Undo last action (Ctrl+Z)"
			>
				Undo
			</button>
			<button
				type="button"
				class="btn danger"
				onclick={() => {
					if (activeWallId && confirm(`Delete ${activeWall()?.name}?`)) {
						deleteWall(activeWallId);
					}
				}}
			>
				Delete wall
			</button>
		</div>
	</header>

	{#if tool === 'draw'}
		<div class="draw-banner" role="status" aria-live="polite">
			<span class="draw-banner-dot"></span>
			<strong>Drawing</strong>
			<span class="draw-banner-msg">
				{pendingStart === null
					? 'Click the start of the line.'
					: 'Now click the end. Snap to 90° lights up green when it aligns with a previous line.'}
			</span>
			<button type="button" class="draw-banner-cancel" onclick={cancelDraw}>Cancel</button>
		</div>
	{/if}

	{#if settingsOpen && activeWall()}
		{@const w = activeWall()!}
		<section class="wall-settings" aria-label="Settings for {w.name}">
			<header>
				<strong>{w.name} settings</strong>
				<span class="muted">Applies to this wall only · changes save automatically</span>
			</header>
			<div class="settings-grid">
				<label>
					<span>Boundary offset</span>
					<div class="input-with-unit">
						<input
							type="number"
							min="250"
							max="1000"
							step="10"
							value={w.defaults.boundaryOffsetMm}
							oninput={(e) => setBoundaryOffset(parseInt((e.currentTarget as HTMLInputElement).value, 10) || 0)}
						/>
						<span class="unit">mm</span>
					</div>
					<small class="muted">Min 250 mm (AS 4678). Walls snap to offset line.</small>
				</label>
				<label>
					<span>Post spacing</span>
					<div class="input-with-unit">
						<input
							type="number"
							min="1500"
							max="3000"
							step="100"
							value={w.defaults.postSpacingMm}
							oninput={(e) => setPostSpacing(parseInt((e.currentTarget as HTMLInputElement).value, 10) || 0)}
						/>
						<span class="unit">mm c/c</span>
					</div>
					<small class="muted">Drives Step 3 post count. Tighter for tall walls.</small>
				</label>
				<label>
					<span>Concrete strength</span>
					<select
						value={w.defaults.concreteStrength}
						onchange={(e) => setConcreteStrength((e.currentTarget as HTMLSelectElement).value as 'N25' | 'N32')}
					>
						<option value="N25">N25</option>
						<option value="N32">N32</option>
					</select>
					<small class="muted">For pier footings. N32 for taller walls.</small>
				</label>
			</div>
		</section>
	{/if}

	<div class="layout">
	<aside class="walls-panel" aria-label="Walls and segments">
		<section class="side-photos" aria-label="Site photos">
			<button
				type="button"
				class="side-photos-head"
				onclick={() => (photosExpanded = !photosExpanded)}
				aria-expanded={photosExpanded}
			>
				<span class="side-photos-title">Site photos</span>
				<span class="side-photos-count muted small">
					{data.photos.length}
				</span>
				<span class="caret" aria-hidden="true">{photosExpanded ? '▾' : '▸'}</span>
			</button>
			{#if photosExpanded}
				<div class="side-photos-body">
					<div class="side-photo-actions">
						<label class="photo-btn">
							<input
								type="file"
								accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
								multiple
								hidden
								onchange={onPhotoPick}
								disabled={photoUploading}
							/>
							{#if photoUploading}
								Uploading {photoCount}…
							{:else}
								+ Add
							{/if}
						</label>
						<label class="photo-btn ghost">
							<input
								type="file"
								accept="image/*"
								capture="environment"
								hidden
								onchange={onPhotoPick}
								disabled={photoUploading}
							/>
							📷 Camera
						</label>
					</div>
					{#if data.photos.length > 0}
						<ul class="photo-grid">
							{#each data.photos as p (p.id)}
								<li>
									<img
										src="/api/quotes/{quoteId}/photos/{p.id}"
										alt={p.label || 'Site photo'}
										loading="lazy"
									/>
									<button
										type="button"
										class="photo-rm"
										onclick={() => deletePhoto(p.id)}
										aria-label="Remove photo"
										title="Remove"
									>
										×
									</button>
								</li>
							{/each}
						</ul>
					{:else}
						<p class="muted small">No photos yet. Add on-site captures here — they land on the client PDF.</p>
					{/if}
					{#if photoError}
						<p class="photo-err">{photoError}</p>
					{/if}
				</div>
			{/if}
		</section>

		<div class="walls-panel-head">
			<h3>Segments</h3>
			<span class="muted small">Type a length and hit Enter to set any edge.</span>
		</div>
		{#if !activeWall()}
			<p class="muted small">Draw a wall first, then sub-segments and edges will appear here for fine-tuning.</p>
		{:else}
			{@const w = activeWall()!}
			<div class="active-wall-row">
				<span class="dot orange"></span>
				<strong>{w.name}</strong>
				<span class="muted">
					{multiPolylineLengthMeters(pathToSegments(w.pathGeoJson ?? null)).toFixed(2)} m ·
					{wallTotalM2().toFixed(2)} m²
				</span>
			</div>
			{#if sidebarSegments().length === 0}
				<p class="muted small">No edges yet — drop two points on the map to create your first.</p>
			{:else}
				<ol class="seg-list">
					{#each sidebarSegments() as seg, segIdx (segIdx)}
						<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
						<li
							class:focused={focusedSectionIdx === segIdx}
							onclick={() => (focusedSectionIdx = segIdx)}
							onkeydown={(e) => {
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault();
									focusedSectionIdx = segIdx;
								}
							}}
							role="button"
							tabindex="0"
						>
							<header class="seg-card-head">
								<div class="seg-name-row">
									<span class="seg-name">Section {segIdx + 1}</span>
									<button
										type="button"
										class="seg-del-icon"
										onclick={(e) => {
											e.stopPropagation();
											if (confirm(`Delete Section ${segIdx + 1}?`)) deleteSection(segIdx);
										}}
										title="Delete this section"
										aria-label="Delete Section {segIdx + 1}"
									>
										✕
									</button>
								</div>
								<div class="seg-headline">
									<span class="seg-headline-num">{seg.length.toFixed(2)}<span class="seg-headline-unit"> m</span></span>
									<span class="seg-headline-sep">·</span>
									<span class="seg-headline-num">{seg.m2.toFixed(2)}<span class="seg-headline-unit"> m²</span></span>
								</div>
							</header>

							<section class="seg-group ground" aria-label="Ground levels for Section {segIdx + 1}">
								<h4 class="seg-group-title">
									<span class="seg-group-dot ground"></span>
									Ground levels
								</h4>
								<div class="seg-heights">
									<label class="seg-height start">
										<span class="seg-height-label">Start</span>
										<div class="seg-height-input">
											<input
												type="number"
												min="0"
												max="5000"
												step="50"
												inputmode="numeric"
												value={seg.startMm}
												oninput={(e) => {
													const v = parseInt((e.currentTarget as HTMLInputElement).value, 10);
													setSectionStartHeight(segIdx, Number.isFinite(v) ? v : null);
												}}
												aria-label="Section {segIdx + 1} start ground level in millimetres"
											/>
											<span class="unit">mm</span>
										</div>
									</label>
									<span class="seg-heights-arrow" aria-hidden="true">→</span>
									<label class="seg-height end">
										<span class="seg-height-label">End</span>
										<div class="seg-height-input">
											<input
												type="number"
												min="0"
												max="5000"
												step="50"
												inputmode="numeric"
												value={seg.endMm}
												oninput={(e) => {
													const v = parseInt((e.currentTarget as HTMLInputElement).value, 10);
													setSectionEndHeight(segIdx, Number.isFinite(v) ? v : null);
												}}
												aria-label="Section {segIdx + 1} end ground level in millimetres"
											/>
											<span class="unit">mm</span>
										</div>
									</label>
								</div>
								{#if segIdx + 1 < sidebarSegments().length}
									<p class="chain-caption">
										<span class="chain-glyph" aria-hidden="true">⇌</span>
										End linked to Section {segIdx + 2} start — edit one, both update.
									</p>
								{/if}
							</section>

							<section class="seg-group length" aria-label="Wall length for Section {segIdx + 1}">
								<h4 class="seg-group-title">
									<span class="seg-group-dot length"></span>
									Wall length
								</h4>
								<ul class="edge-list">
									{#each seg.edges as edge, edgeIdx (edgeIdx)}
										{@const key = `${segIdx}:${edgeIdx}`}
										{@const showLabel = seg.edges.length > 1}
										<li class:recent={recentlySetEdge === key}>
											<div class="edge-current-row">
												{#if showLabel}
													<span class="edge-num">Edge {edgeIdx + 1}</span>
												{:else}
													<span class="edge-num">Current</span>
												{/if}
												<strong class="edge-current">{edge.length.toFixed(2)} m</strong>
											</div>
											<form
												class="edge-form"
												onsubmit={(e) => {
													e.preventDefault();
													applyEdgeInput(segIdx, edgeIdx);
												}}
											>
												<label class="edge-set-label" for="edge-set-{key}">Set to</label>
												<input
													id="edge-set-{key}"
													type="number"
													step="0.01"
													min="0.05"
													max="500"
													inputmode="decimal"
													placeholder="metres"
													aria-label="Set Section {segIdx + 1} {showLabel ? `Edge ${edgeIdx + 1}` : ''} length in metres"
													value={edgeLenInputs[key] ?? ''}
													oninput={(e) => {
														edgeLenInputs = {
															...edgeLenInputs,
															[key]: (e.currentTarget as HTMLInputElement).value
														};
													}}
												/>
												<button
													type="submit"
													class="btn primary tiny"
													disabled={!edgeLenInputs[key]}
												>
													Set
												</button>
											</form>
										</li>
									{/each}
								</ul>
							</section>
						</li>
					{/each}
				</ol>
			{/if}
		{/if}
	</aside>

	<div class="map-frame" class:hide-labels={!showLabels}>
		<div class="map" bind:this={mapContainer}></div>
		{#if mapStatus !== 'ready'}
			<div class="map-loading">Loading satellite…</div>
		{/if}

		<div class="layer-toggles" role="group" aria-label="Map layers">
			<header class="layer-toggles-title">View</header>
			<label>
				<input type="checkbox" bind:checked={showBoundary} />
				<span>Boundary</span>
			</label>
			<label>
				<input type="checkbox" bind:checked={showLabels} />
				<span>Labels</span>
			</label>
		</div>

		<div class="tools" role="toolbar" aria-label="Map tool">
			<button
				type="button"
				class="tool-btn"
				class:active={tool === 'pan'}
				aria-pressed={tool === 'pan'}
				title="Pan / navigate (V)"
				onclick={() => (tool = 'pan')}
			>
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0" />
					<path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2" />
					<path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8" />
					<path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
				</svg>
				<span class="tool-label">Pan</span>
			</button>
			<button
				type="button"
				class="tool-btn"
				class:active={tool === 'draw'}
				aria-pressed={tool === 'draw'}
				title="Draw wall points (D)"
				onclick={() => (tool = 'draw')}
			>
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M12 21s-7-4.5-7-11a7 7 0 1 1 14 0c0 6.5-7 11-7 11z" />
					<circle cx="12" cy="10" r="2.5" />
				</svg>
				<span class="tool-label">Draw</span>
			</button>
		</div>

		<div class="map-legend" aria-label="Map legend">
			<span class="legend-row">
				<span class="legend-swatch wall" aria-hidden="true"></span>
				<span>Wall</span>
			</span>
			<span class="legend-row">
				<span class="legend-swatch offset" aria-hidden="true"></span>
				<span>Boundary offset</span>
			</span>
			<span class="legend-row">
				<span class="legend-swatch boundary" aria-hidden="true"></span>
				<span>Property boundary</span>
			</span>
			<span class="legend-row">
				<span class="legend-pill name" aria-hidden="true">W1</span>
				<span>Wall name</span>
			</span>
			<span class="legend-row">
				<span class="legend-pill ground" aria-hidden="true">600</span>
				<span>Ground level (mm)</span>
			</span>
			{#if data.walls.length > 1}
				<span class="legend-row">
					<span class="legend-swatch other" aria-hidden="true"></span>
					<span>Other walls</span>
				</span>
			{/if}
		</div>

		<div class="map-hint">
			{#if tool === 'pan'}
				Pan tool — drag to navigate, scroll/pinch to zoom. Drag a vertex to move it. Double-click a vertex to remove. Double-click the line between vertices to add one.
			{:else if pendingStart === null}
				Click the start of the line. {#if snapHintLabel}<strong class="snap-tag">{snapHintLabel}</strong>{/if}
			{:else}
				Click the end. {#if snapHintLabel}<strong class="snap-tag">{snapHintLabel}</strong>{/if}
			{/if}
		</div>

	</div>
	</div>

	<footer class="summary">
		<div class="totals">
			<div class="totals-line">
				<span class="muted">Total wall length</span>
				<span class="total">{totals().total.toFixed(2)} m</span>
			</div>
			{#if data.walls.length > 1}
				<ul class="per-wall">
					{#each totals().perWall as p (p.id)}
						<li>
							<span class="muted">{p.name}</span>
							<span>{p.meters.toFixed(2)} m</span>
						</li>
					{/each}
				</ul>
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
	</footer>
</div>

<style>
	.step2 {
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
		min-width: 5rem;
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
	.tab.add {
		justify-content: center;
		align-items: center;
		flex-direction: row;
		font-weight: 500;
		color: var(--accent);
		min-width: auto;
	}

	.mode-actions {
		display: flex;
		gap: 0.5rem;
	}
	.btn {
		padding: 0.5rem 0.9rem;
		border-radius: 8px;
		font-weight: 600;
		font-size: 0.85rem;
		border: 1px solid transparent;
		cursor: pointer;
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.btn.primary {
		background: var(--accent);
		color: var(--accent-fg);
	}
	.btn.ghost {
		background: transparent;
		border-color: var(--border);
		color: var(--text);
	}
	.btn.ghost:hover:not(:disabled) {
		border-color: var(--text-muted);
	}
	.btn.danger {
		background: transparent;
		border-color: var(--danger);
		color: var(--danger);
	}
	.btn.danger:hover:not(:disabled) {
		background: rgba(255, 85, 102, 0.1);
	}
	.btn.on {
		background: rgba(255, 138, 28, 0.15);
		border-color: var(--accent);
		color: var(--accent);
	}

	.wall-settings {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 0.875rem 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
	}
	.wall-settings header {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
		justify-content: space-between;
		flex-wrap: wrap;
	}
	.wall-settings header strong {
		font-size: 0.95rem;
	}
	.settings-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
		gap: 0.75rem 1rem;
	}
	.settings-grid label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.78rem;
		color: var(--text-muted);
	}
	.settings-grid input,
	.settings-grid select {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.4rem 0.55rem;
		color: var(--text);
		font-size: 0.9rem;
		outline: none;
	}
	.settings-grid input:focus,
	.settings-grid select:focus {
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
	.settings-grid small {
		font-size: 0.7rem;
		line-height: 1.2;
	}

	.map-frame {
		position: relative;
		width: 100%;
		/* Map-first sizing — fills ~78% of the viewport height so the
		 * satellite canvas is the dominant element on the page, matching
		 * the site-designer-pro layout the boss flagged as the reference. */
		height: clamp(560px, 78vh, 1000px);
		border-radius: 12px;
		border: 1px solid var(--border);
		overflow: hidden;
		background: #15161a;
	}
	.map {
		position: absolute;
		inset: 0;
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
	.map-hint {
		position: absolute;
		bottom: 0.6rem;
		left: 0.6rem;
		right: 4.5rem;
		background: rgba(11, 11, 12, 0.85);
		color: var(--text);
		font-size: 0.78rem;
		padding: 0.4rem 0.65rem;
		border-radius: 6px;
		line-height: 1.35;
		pointer-events: none;
	}
	.snap-tag {
		display: inline-block;
		background: var(--success);
		color: #0b0b0c;
		padding: 0.05rem 0.4rem;
		border-radius: 4px;
		margin-left: 0.4rem;
	}

	/* Map legend — bottom-right of the map. Compact swatch + label rows that
	 * mirror the actual paint properties of each layer, so the colour key on
	 * the map is "this is what these strokes mean". */
	.map-legend {
		position: absolute;
		bottom: 0.6rem;
		right: 0.6rem;
		background: rgba(11, 11, 12, 0.88);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.45rem 0.6rem;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.72rem;
		color: var(--text);
		z-index: 2;
		pointer-events: none;
	}
	.legend-row {
		display: flex;
		align-items: center;
		gap: 0.45rem;
	}
	.legend-swatch {
		display: inline-block;
		width: 22px;
		height: 4px;
		border-radius: 1px;
	}
	.legend-swatch.wall {
		background: #ff8a1c;
		height: 3px;
	}
	.legend-swatch.offset {
		background: transparent;
		border-top: 2px dashed #7fd99a;
		height: 0;
	}
	.legend-swatch.boundary {
		background: #ffd23f;
		height: 2px;
	}
	.legend-swatch.other {
		background: rgba(255, 138, 28, 0.55);
		height: 2px;
	}
	.legend-pill {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 22px;
		padding: 1px 5px;
		border-radius: 999px;
		font-size: 0.6rem;
		font-weight: 700;
		line-height: 1;
		letter-spacing: 0.04em;
	}
	.legend-pill.name {
		background: #d94c4c;
		color: #fff;
		text-transform: uppercase;
	}
	.legend-pill.ground {
		background: #2e8c4a;
		color: #fff;
	}

	.layout {
		display: grid;
		/* Sidebar LEFT (narrow), map RIGHT (huge). Mirrors the reference
		 * site-designer-pro layout where the map is the canvas and the
		 * sidebar is a slim control panel. */
		grid-template-columns: 17rem minmax(0, 1fr);
		gap: 1rem;
		align-items: stretch;
	}
	@media (max-width: 880px) {
		.layout {
			grid-template-columns: 1fr;
		}
	}

	.walls-panel {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		min-width: 0;
		/* Sidebar scrolls independently of the map so the user can scroll
		 * sections without losing their place on the satellite. */
		max-height: clamp(560px, 78vh, 1000px);
		overflow-y: auto;
		padding-right: 0.25rem;
	}
	/* ─── Sidebar photos accordion ─────────────────────────────────────
	 * Photos used to live in a full-width strip above the map. With the
	 * map-first layout the strip ate too much vertical real estate, so
	 * they now collapse into the sidebar. Default is collapsed when
	 * empty so the user lands directly on the segment list. */
	.side-photos {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 10px;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.side-photos-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.55rem 0.7rem;
		background: transparent;
		border: none;
		color: var(--text);
		cursor: pointer;
		font: inherit;
		text-align: left;
	}
	.side-photos-head:hover {
		background: rgba(255, 255, 255, 0.03);
	}
	.side-photos-title {
		font-weight: 600;
		font-size: 0.82rem;
		flex: 1;
	}
	.side-photos-count {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		background: rgba(255, 255, 255, 0.05);
		padding: 0.05rem 0.4rem;
		border-radius: 4px;
	}
	.caret {
		color: var(--text-muted);
		font-size: 0.75rem;
	}
	.side-photos-body {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0 0.7rem 0.7rem;
		border-top: 1px dashed var(--border);
		padding-top: 0.5rem;
	}
	.side-photo-actions {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
	}

	.walls-panel-head {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}
	.walls-panel-head h3 {
		margin: 0;
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-muted);
		font-weight: 600;
	}
	.small {
		font-size: 0.72rem;
	}
	.active-wall-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.4rem 0.6rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 8px;
		font-size: 0.85rem;
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
	}
	.dot.orange {
		background: var(--accent);
	}
	/* ─── Section list ────────────────────────────────────────────────────
	 * Each section is its own card with two clearly-titled inner groups:
	 * "Ground levels" (green accent) and "Wall length" (orange accent).
	 * The colour-coding mirrors the map legend so the user maps the
	 * sidebar onto the satellite view at a glance.
	 */
	.seg-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
		/* No inner scroll — the parent .walls-panel scrolls. Nested scrollers
		 * mean the user sometimes scrolls the inner instead of the page and
		 * gets stuck.
		 */
	}
	.seg-list > li {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 0;
		display: flex;
		flex-direction: column;
		cursor: pointer;
		transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
		overflow: hidden;
	}
	.seg-list > li:hover {
		border-color: var(--text-muted);
	}
	.seg-list > li.focused {
		border-color: var(--accent);
		background: rgba(255, 138, 28, 0.04);
		box-shadow: 0 0 0 1px var(--accent);
	}

	/* ─── Card head ──────────────────────────────────────────────────── */
	.seg-card-head {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		padding: 0.65rem 0.75rem 0.5rem;
		border-bottom: 1px solid var(--border);
	}
	.seg-name-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.seg-name {
		font-weight: 600;
		font-size: 0.85rem;
		color: var(--text);
	}
	.seg-del-icon {
		background: transparent;
		border: 1px solid transparent;
		color: var(--text-muted);
		width: 22px;
		height: 22px;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.75rem;
		line-height: 1;
		padding: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		opacity: 0.6;
		transition: opacity 0.15s, color 0.15s, border-color 0.15s;
	}
	.seg-list > li:hover .seg-del-icon,
	.seg-list > li.focused .seg-del-icon {
		opacity: 1;
	}
	.seg-del-icon:hover {
		color: var(--danger);
		border-color: var(--danger);
		opacity: 1 !important;
	}

	.seg-headline {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 1rem;
		font-weight: 600;
		color: var(--text);
	}
	.seg-headline-unit {
		font-size: 0.7rem;
		color: var(--text-muted);
		font-weight: 500;
	}
	.seg-headline-sep {
		color: var(--text-muted);
		font-weight: 400;
	}

	/* ─── Card groups ────────────────────────────────────────────────── */
	.seg-group {
		padding: 0.6rem 0.75rem 0.7rem;
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}
	.seg-group + .seg-group {
		border-top: 1px dashed var(--border);
	}
	.seg-group-title {
		margin: 0;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.68rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--text-muted);
	}
	.seg-group-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		display: inline-block;
	}
	.seg-group-dot.ground {
		background: #7fd99a;
	}
	.seg-group-dot.length {
		background: var(--accent);
	}

	/* ─── Ground levels group ────────────────────────────────────────── */
	.seg-heights {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.4rem;
	}
	.seg-heights-arrow {
		color: #7fd99a;
		font-weight: 700;
		font-size: 1rem;
		flex-shrink: 0;
	}
	.seg-height {
		display: flex;
		flex-direction: column;
		gap: 0.18rem;
		flex: 1;
		min-width: 0;
	}
	.seg-height-label {
		font-size: 0.62rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		font-weight: 700;
		color: #7fd99a;
		padding-left: 0.05rem;
	}
	.seg-height-input {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		background: rgba(127, 217, 154, 0.05);
		border: 1px solid rgba(127, 217, 154, 0.35);
		border-radius: 7px;
		padding: 0.25rem 0.4rem;
		transition: border-color 0.12s, box-shadow 0.12s;
	}
	.seg-height-input:focus-within {
		border-color: #7fd99a;
		box-shadow: 0 0 0 2px rgba(127, 217, 154, 0.2);
	}
	.seg-height-input input {
		flex: 1;
		min-width: 0;
		width: 100%;
		background: transparent;
		border: none;
		color: var(--text);
		font-size: 0.9rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-weight: 600;
		outline: none;
		padding: 0;
		/* Hide the native number-input spinner — looks fussy in this layout. */
		-moz-appearance: textfield;
		appearance: textfield;
	}
	.seg-height-input input::-webkit-outer-spin-button,
	.seg-height-input input::-webkit-inner-spin-button {
		-webkit-appearance: none;
		margin: 0;
	}
	.seg-height-input .unit {
		font-size: 0.7rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		color: var(--text-muted);
	}
	.chain-caption {
		margin: 0;
		font-size: 0.7rem;
		color: var(--text-muted);
		line-height: 1.3;
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}
	.chain-glyph {
		color: #7fd99a;
		font-weight: 700;
		font-size: 0.85rem;
	}

	/* ─── Wall length group ──────────────────────────────────────────── */
	.edge-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}
	.edge-list li {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		padding: 0;
		border-radius: 6px;
		transition: background 0.4s ease;
	}
	.edge-list li.recent {
		background: rgba(74, 209, 101, 0.15);
		padding: 0.25rem 0.35rem;
		margin: -0.25rem -0.35rem;
	}
	.edge-current-row {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 0.4rem;
	}
	.edge-num {
		font-size: 0.62rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		font-weight: 700;
		color: var(--text-muted);
	}
	.edge-current {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.92rem;
		font-weight: 600;
		color: var(--text);
	}
	.edge-form {
		display: grid;
		grid-template-columns: auto 1fr auto;
		gap: 0.4rem;
		align-items: center;
	}
	.edge-set-label {
		font-size: 0.7rem;
		color: var(--text-muted);
		font-weight: 500;
	}
	.edge-form input {
		min-width: 0;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 7px;
		padding: 0.35rem 0.55rem;
		color: var(--text);
		font-size: 0.85rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		outline: none;
		transition: border-color 0.12s;
	}
	.edge-form input:focus {
		border-color: var(--accent);
	}
	.btn.tiny {
		padding: 0.35rem 0.7rem;
		font-size: 0.75rem;
	}

	/* Layer-visibility toggles — sit just below MapLibre's +/- zoom buttons
	 * on the top-right edge of the map. Bigger + clearly titled "View" so
	 * the user sees them on first load (the boss missed them entirely with
	 * the older small variant). */
	.layer-toggles {
		position: absolute;
		top: calc(0.6rem + 78px);
		right: 0.6rem;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		background: rgba(11, 11, 12, 0.92);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 0.5rem 0.7rem;
		font-size: 0.82rem;
		z-index: 2;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
	}
	.layer-toggles-title {
		font-size: 0.65rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-muted);
		margin-bottom: 0.1rem;
	}
	.layer-toggles label {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		cursor: pointer;
		user-select: none;
		color: var(--text);
		padding: 0.1rem 0;
	}
	.layer-toggles input[type='checkbox'] {
		accent-color: var(--accent);
		width: 16px;
		height: 16px;
		margin: 0;
	}

	/* When labels are toggled off, hide every pill we render via MapLibre
	 * markers. Boundary lengths, wall lengths, wall-name pills, offset
	 * label and ground-level pills all use the .edge-label class. */
	:global(.map-frame.hide-labels .edge-label) {
		display: none !important;
	}

	.tools {
		position: absolute;
		top: 0.6rem;
		left: 0.6rem;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		background: rgba(11, 11, 12, 0.85);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.3rem;
		z-index: 2;
	}
	.tool-btn {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.1rem;
		width: 44px;
		height: 44px;
		background: transparent;
		border: 1px solid transparent;
		border-radius: 6px;
		color: var(--text-muted);
		cursor: pointer;
		font-size: 0.6rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		font-weight: 600;
		padding: 0.25rem 0;
	}
	.tool-btn:hover {
		color: var(--text);
		background: rgba(255, 255, 255, 0.06);
	}
	.tool-btn.active {
		background: var(--accent);
		color: var(--accent-fg);
		border-color: var(--accent);
	}
	.tool-btn.active:hover {
		background: var(--accent);
	}
	.tool-label {
		font-size: 0.55rem;
		line-height: 1;
	}

	/* Pill-style map labels rendered via MapLibre Markers. The base style
	 * sets typography + a solid drop shadow so every pill reads cleanly
	 * against any satellite tile. Each kind layers its own colour scheme. */
	:global(.edge-label) {
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
		font-size: 14px;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		padding: 4px 10px;
		border-radius: 999px;
		white-space: nowrap;
		pointer-events: none;
		user-select: none;
		/* Double shadow — soft drop + 1-px outline — so the pill stands
		 * proud against both light (grass / pale roofs) and dark (shaded
		 * trees / asphalt) satellite tiles without an explicit border. */
		box-shadow: 0 2px 6px rgba(0, 0, 0, 0.6), 0 0 0 1.5px rgba(0, 0, 0, 0.35);
		letter-spacing: 0.01em;
	}
	:global(.edge-label--wall-active) {
		background: #ff8a1c;
		color: #1a0f00;
	}
	:global(.edge-label--wall-other) {
		background: rgba(255, 138, 28, 0.65);
		color: #1a0f00;
	}
	:global(.edge-label--boundary) {
		background: rgba(11, 11, 12, 0.92);
		color: #ffffff;
		border: 1px solid rgba(255, 210, 63, 0.9);
	}
	:global(.edge-label--offset) {
		background: rgba(11, 11, 12, 0.94);
		color: #c8efb1;
		border: 1px solid rgba(127, 217, 154, 0.9);
		font-size: 11px;
		padding: 3px 7px;
	}
	/* Wall name pill — red like the reference's "W1" / "W2" badges. Sits
	 * on the wall centroid so it identifies the wall at a glance. */
	:global(.edge-label--wall-name) {
		background: #d94c4c;
		color: #fff;
		font-size: 13px;
		font-weight: 800;
		padding: 5px 12px;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		box-shadow: 0 2px 7px rgba(0, 0, 0, 0.65), 0 0 0 1.5px rgba(0, 0, 0, 0.4);
	}
	/* Ground-level pill — green to match the Step 2 sidebar height inputs
	 * and Step 3's reseed action. One pill per section-endpoint on the
	 * active wall, showing the chained start/end height in mm. */
	:global(.edge-label--ground) {
		background: #2e8c4a;
		color: #fff;
		font-size: 12px;
		font-weight: 700;
		padding: 4px 10px;
		border: 1px solid rgba(255, 255, 255, 0.25);
	}

	:global(.vertex-handle) {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: #fff;
		border: 2px solid var(--accent);
		cursor: grab;
		box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
	}
	:global(.vertex-handle:active) {
		cursor: grabbing;
	}
	.photo-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.45rem 0.75rem;
		background: var(--accent);
		color: var(--accent-fg);
		font-size: 0.82rem;
		font-weight: 600;
		border-radius: 8px;
		cursor: pointer;
		user-select: none;
	}
	.photo-btn:hover {
		filter: brightness(1.05);
	}
	.photo-btn.ghost {
		background: transparent;
		border: 1px solid var(--border);
		color: var(--text);
	}
	.photo-btn.ghost:hover {
		border-color: var(--text-muted);
		filter: none;
	}
	.photo-grid {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr));
		gap: 0.5rem;
	}
	.photo-grid li {
		position: relative;
		aspect-ratio: 4 / 3;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 8px;
		overflow: hidden;
	}
	.photo-grid img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}
	.photo-rm {
		position: absolute;
		top: 0.25rem;
		right: 0.25rem;
		width: 26px;
		height: 26px;
		border-radius: 50%;
		background: rgba(11, 11, 12, 0.75);
		border: 1px solid rgba(255, 255, 255, 0.15);
		color: #fff;
		font-size: 1rem;
		line-height: 1;
		cursor: pointer;
		padding: 0;
	}
	.photo-rm:hover {
		background: var(--danger);
		border-color: var(--danger);
	}
	.photo-err {
		color: var(--danger);
		font-size: 0.78rem;
		margin: 0;
	}

	/* Draw banner — full-width strip above the map while the user is in Draw mode. */
	.draw-banner {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.6rem 0.875rem;
		background: rgba(74, 209, 101, 0.12);
		border: 1px solid rgba(74, 209, 101, 0.55);
		border-radius: 10px;
		font-size: 0.85rem;
		color: var(--text);
	}
	.draw-banner-dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: #4ad165;
		box-shadow: 0 0 0 3px rgba(74, 209, 101, 0.3);
		animation: pulse-soft 1.4s ease-in-out infinite;
	}
	.draw-banner-msg {
		color: var(--text);
		flex: 1;
		min-width: 0;
	}
	.draw-banner-cancel {
		background: transparent;
		border: 1px solid var(--border);
		color: var(--text);
		padding: 0.35rem 0.7rem;
		border-radius: 6px;
		font-size: 0.8rem;
		cursor: pointer;
	}
	.draw-banner-cancel:hover {
		border-color: var(--text-muted);
	}
	@keyframes pulse-soft {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.45; }
	}

	.summary {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
		flex-wrap: wrap;
	}
	.totals-line {
		display: flex;
		gap: 0.6rem;
		align-items: baseline;
		font-size: 0.95rem;
	}
	.totals-line .total {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-weight: 600;
		font-size: 1.1rem;
		color: var(--text);
	}
	.muted {
		color: var(--text-muted);
	}
	.per-wall {
		list-style: none;
		padding: 0;
		margin: 0.5rem 0 0;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: 0.8rem;
	}
	.per-wall li {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		min-width: 16rem;
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
