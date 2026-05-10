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
	import type { QuoteData } from '$lib/schemas/quote';
	import {
		haversineMeters,
		polylineLengthMeters,
		offsetPolyline,
		snapAngle,
		nearestSegment,
		nearestVertex,
		type LngLat
	} from '$lib/wall-math';

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

	// svelte-ignore state_referenced_locally
	let data = $state(structuredClone(initialData));
	// svelte-ignore state_referenced_locally
	let dataHash = $state(initialHash);
	// svelte-ignore state_referenced_locally
	let versionNumber = $state(initialVersion);
	let saveState: SaveState = $state('idle');
	let errorMessage = $state('');

	// --- save protocol (shared shape with Step 1) --------------------------
	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	// Serialised save chain — each save waits for the prior to update dataHash
	// before sending. Without this, two clicks within ~600ms can both fire with
	// a stale If-Match header and the second one 409s, the conflict handler
	// then rolls back local state to the server's pre-second-click view.
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

	// --- wall management ---------------------------------------------------
	type Mode = 'drawing' | 'editing';
	type Tool = 'pan' | 'draw';
	// svelte-ignore state_referenced_locally
	let activeWallId = $state<string | null>(initialData.walls[0]?.id ?? null);
	// svelte-ignore state_referenced_locally
	let mode = $state<Mode>(
		initialData.walls.length === 0 ||
			(initialData.walls[0]?.pathGeoJson?.coordinates.length ?? 0) < 2
			? 'drawing'
			: 'editing'
	);
	// Top-level interaction tool. Pan = clicks do nothing, you just navigate.
	// Draw = clicks add points / insert vertices. Auto-selected based on wall
	// state on load and on every wall transition (start/finish/add).
	// svelte-ignore state_referenced_locally
	let tool = $state<Tool>(
		initialData.walls.length === 0 ||
			(initialData.walls[0]?.pathGeoJson?.coordinates.length ?? 0) < 2
			? 'draw'
			: 'pan'
	);
	let mapVersion = $state(0);

	function ensureActiveWall() {
		if (data.walls.length === 0) {
			const wall = newEmptyWall(`Wall 1`);
			data.walls.push(wall);
			activeWallId = wall.id;
			mode = 'drawing';
		} else if (!activeWallId || !data.walls.some((w) => w.id === activeWallId)) {
			activeWallId = data.walls[0].id;
			const c = data.walls[0].pathGeoJson?.coordinates ?? [];
			mode = c.length < 2 ? 'drawing' : 'editing';
		}
	}

	function newEmptyWall(name: string) {
		return {
			id: ulid(),
			name,
			pathGeoJson: null,
			posts: [],
			defaults: {
				boundaryOffsetMm: 100,
				panelModuleMm: 200,
				postSpacingMm: 2400,
				concreteStrength: 'N25' as const
			}
		};
	}

	function activeWall() {
		return data.walls.find((w) => w.id === activeWallId);
	}

	function activeCoords(): LngLat[] {
		return (activeWall()?.pathGeoJson?.coordinates ?? []) as LngLat[];
	}

	function setActiveCoords(coords: LngLat[]) {
		const w = activeWall();
		if (!w) return;
		if (coords.length === 0) {
			w.pathGeoJson = null;
		} else {
			w.pathGeoJson = { type: 'LineString', coordinates: coords };
		}
		mapVersion++;
	}

	function selectWall(id: string) {
		activeWallId = id;
		const c = data.walls.find((w) => w.id === id)?.pathGeoJson?.coordinates ?? [];
		mode = c.length < 2 ? 'drawing' : 'editing';
		tool = mode === 'drawing' ? 'draw' : 'pan';
		mapVersion++;
	}

	function startNewWall() {
		const next = newEmptyWall(`Wall ${data.walls.length + 1}`);
		data.walls.push(next);
		activeWallId = next.id;
		mode = 'drawing';
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
			const c = data.walls[0].pathGeoJson?.coordinates ?? [];
			mode = c.length < 2 ? 'drawing' : 'editing';
		}
		mapVersion++;
		scheduleSave();
	}

	function undoLastPoint() {
		const w = activeWall();
		if (!w) return;
		const c = (w.pathGeoJson?.coordinates ?? []) as LngLat[];
		if (c.length === 0) return;
		setActiveCoords(c.slice(0, -1));
		scheduleSave();
	}

	function finishWall() {
		if (activeCoords().length < 2) return;
		mode = 'editing';
		tool = 'pan';
		mapVersion++;
	}

	function resumeDrawing() {
		mode = 'drawing';
		tool = 'draw';
		mapVersion++;
	}

	function deleteVertex(index: number) {
		const c = activeCoords();
		if (c.length <= 0 || index < 0 || index >= c.length) return;
		setActiveCoords(c.filter((_, i) => i !== index));
		// If we drop below 2 points, switch to drawing mode so the user can add more.
		if (activeCoords().length < 2) mode = 'drawing';
		scheduleSave();
	}

	function moveVertex(index: number, ll: LngLat) {
		const c = activeCoords().slice();
		if (index < 0 || index >= c.length) return;
		c[index] = ll;
		setActiveCoords(c);
		scheduleSave();
	}

	function insertVertex(segmentIndex: number, ll: LngLat) {
		const c = activeCoords().slice();
		c.splice(segmentIndex + 1, 0, ll);
		setActiveCoords(c);
		scheduleSave();
	}

	// --- click logic -------------------------------------------------------
	function handleMapClick(lngLat: LngLat) {
		// Pan tool: clicks ignored. Drag still pans the map natively.
		if (tool === 'pan') return;

		const w = activeWall();
		if (!w) return;
		const coords = activeCoords();

		if (mode === 'drawing') {
			let next: LngLat = lngLat;
			// Snap if 2+ existing points
			if (coords.length >= 2) {
				const snap = snapAngle({
					prev: coords[coords.length - 2],
					pivot: coords[coords.length - 1],
					candidate: lngLat
				});
				if (snap) next = snap.snapped;
			}
			setActiveCoords([...coords, next]);
			scheduleSave();
			return;
		}

		// editing mode: insert vertex on a clicked segment if click is close enough
		if (coords.length < 2) return;
		const seg = nearestSegment(lngLat, coords);
		if (!seg) return;
		// Reasonable threshold: 1 metre at this zoom
		if (seg.distanceM <= 1) {
			insertVertex(seg.index, lngLat);
		}
	}

	// --- map -----------------------------------------------------------------
	let mapContainer: HTMLDivElement | undefined = $state();
	let mapStatus: 'idle' | 'loading' | 'ready' = $state('idle');
	let mapInstance: MLMap | null = null;
	let activeVertexMarkers: MLMarker[] = [];
	// Cached MapLibre constructors after dynamic import. Typed loosely because
	// maplibre-gl's d.ts surfaces named exports but not the default-export
	// object shape — the runtime shape is consistent regardless.
	let mlCtors: {
		Marker: typeof import('maplibre-gl').Marker;
		LngLatBounds: typeof import('maplibre-gl').LngLatBounds;
	} | null = null;
	let snapHintCoords = $state<LngLat[] | null>(null);
	let snapHintLabel = $state<string>('');

	const initialCenter: LngLat = (() => {
		// Prefer last point of any wall, then site geocode, then fallback (Brisbane CBD).
		// svelte-ignore state_referenced_locally
		for (const w of initialData.walls) {
			const c = w.pathGeoJson?.coordinates;
			if (c && c.length > 0) return c[c.length - 1] as LngLat;
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

				// Empty sources — populated by the dedicated sync effect.
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

				// Property boundary — dashed white.
				m.addLayer({
					id: 'boundary-line',
					source: 'boundary',
					type: 'line',
					paint: {
						'line-color': '#ffffff',
						'line-width': 2,
						'line-dasharray': [2, 2],
						'line-opacity': 0.85
					}
				});

				// Other walls — dimmed grey-orange.
				m.addLayer({
					id: 'walls-other-line',
					source: 'walls-other',
					type: 'line',
					paint: {
						'line-color': '#ff8a1c',
						'line-width': 3,
						'line-opacity': 0.45
					}
				});

				// Active wall offset (the parallel line at boundary offset distance) — light orange.
				m.addLayer({
					id: 'wall-active-offset-line',
					source: 'wall-active-offset',
					type: 'line',
					paint: {
						'line-color': '#ff8a1c',
						'line-width': 1,
						'line-opacity': 0.55,
						'line-dasharray': [3, 3]
					}
				});

				// Active wall — bright orange.
				m.addLayer({
					id: 'wall-active-line',
					source: 'wall-active',
					type: 'line',
					paint: {
						'line-color': '#ff8a1c',
						'line-width': 4
					}
				});

				// Hover ghost during drawing — translucent extension to the cursor.
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

				// Snap-hint overlay — shows when a 90°/180°/270° snap kicks in.
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

				// Per-segment length labels.
				m.addLayer({
					id: 'wall-segment-labels-text',
					source: 'wall-segment-labels',
					type: 'symbol',
					layout: {
						'text-field': ['get', 'label'],
						'text-size': 12,
						'text-font': ['Open Sans Regular'],
						'text-allow-overlap': true,
						'text-ignore-placement': true,
						'symbol-placement': 'point'
					},
					paint: {
						'text-color': '#0b0b0c',
						'text-halo-color': '#ffe7c8',
						'text-halo-width': 1.5
					}
				});

				m.on('click', onMapClick);
				m.on('mousemove', onMapMouseMove);
				m.on('mouseleave', () => clearHover());

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
		mapInstance?.remove();
		mapInstance = null;
		mapStatus = 'idle';
	}

	function clearVertexMarkers() {
		for (const m of activeVertexMarkers) m.remove();
		activeVertexMarkers = [];
	}

	function onMapClick(e: MapMouseEvent) {
		// Skip if click landed on a vertex marker — markers handle their own events.
		const target = (e.originalEvent.target as HTMLElement) ?? null;
		if (target && target.closest('.vertex-handle')) return;
		handleMapClick([e.lngLat.lng, e.lngLat.lat]);
	}

	function onMapMouseMove(e: MapMouseEvent) {
		if (!mapInstance) return;
		// In pan tool, no ghost line / snap hint — keeps the map "quiet" while
		// the user is just navigating.
		if (tool === 'pan') {
			clearHover();
			return;
		}
		const ll: LngLat = [e.lngLat.lng, e.lngLat.lat];
		const coords = activeCoords();

		if (mode === 'drawing' && coords.length >= 1) {
			let endPoint: LngLat = ll;
			let snapHit: ReturnType<typeof snapAngle> = null;

			if (coords.length >= 2) {
				snapHit = snapAngle({
					prev: coords[coords.length - 2],
					pivot: coords[coords.length - 1],
					candidate: ll
				});
				if (snapHit) endPoint = snapHit.snapped;
			}

			setHoverGhost([coords[coords.length - 1], endPoint]);

			if (snapHit) {
				snapHintCoords = [coords[coords.length - 1], endPoint];
				snapHintLabel = `${snapHit.angleDeg}°`;
				setSnapHint(snapHintCoords);
			} else {
				snapHintCoords = null;
				setSnapHint(null);
			}
		} else if (mode === 'editing' && coords.length >= 2) {
			// Show a faint marker hint when hovering close to a segment, suggesting "click to add a point here"
			const seg = nearestSegment(ll, coords);
			if (seg && seg.distanceM <= 1) {
				setHoverGhost(null);
				setSnapHint([coords[seg.index], ll, coords[seg.index + 1]]);
			} else {
				setHoverGhost(null);
				setSnapHint(null);
			}
		} else {
			clearHover();
		}
	}

	function clearHover() {
		setHoverGhost(null);
		setSnapHint(null);
		snapHintCoords = null;
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

	// --- effect: sync sources + markers when walls/mode/active change -----
	$effect(() => {
		mapVersion;
		if (!browser || !mapInstance || mapStatus !== 'ready') return;
		untrack(() => syncSourcesAndMarkers());
	});

	// --- effect: cursor reflects the active tool ---------------------------
	$effect(() => {
		const t = tool;
		if (!browser || !mapInstance || mapStatus !== 'ready') return;
		mapInstance.getCanvas().style.cursor = t === 'draw' ? 'crosshair' : '';
		if (t === 'pan') untrack(() => clearHover());
	});

	function syncSourcesAndMarkers() {
		if (!mapInstance) return;
		const m = mapInstance;
		const aId = activeWallId;
		const aWall = data.walls.find((w) => w.id === aId);
		const aCoords = (aWall?.pathGeoJson?.coordinates ?? []) as LngLat[];
		const offsetMm = aWall?.defaults.boundaryOffsetMm ?? 100;

		// Other walls
		(m.getSource('walls-other') as GeoJSONSource).setData({
			type: 'FeatureCollection',
			features: data.walls
				.filter((w) => w.id !== aId && (w.pathGeoJson?.coordinates.length ?? 0) >= 2)
				.map((w) => ({
					type: 'Feature',
					properties: { id: w.id, name: w.name },
					geometry: w.pathGeoJson! as GeoJSON.LineString
				}))
		});

		// Active wall line
		(m.getSource('wall-active') as GeoJSONSource).setData(
			aCoords.length >= 2
				? {
						type: 'Feature',
						properties: { id: aWall?.id },
						geometry: { type: 'LineString', coordinates: aCoords }
					}
				: { type: 'FeatureCollection', features: [] }
		);

		// Active wall offset (parallel line)
		const offsetCoords =
			aCoords.length >= 2 ? offsetPolyline(aCoords, offsetMm / 1000) : [];
		(m.getSource('wall-active-offset') as GeoJSONSource).setData(
			offsetCoords.length >= 2
				? {
						type: 'Feature',
						properties: {},
						geometry: { type: 'LineString', coordinates: offsetCoords }
					}
				: { type: 'FeatureCollection', features: [] }
		);

		// Segment-length labels — midpoint of each segment with the metres reading.
		const labelFeatures: GeoJSON.Feature[] = [];
		for (let i = 0; i < aCoords.length - 1; i++) {
			const a = aCoords[i];
			const b = aCoords[i + 1];
			const len = haversineMeters(a, b);
			const mid: LngLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
			labelFeatures.push({
				type: 'Feature',
				properties: { label: `${len.toFixed(1)} m` },
				geometry: { type: 'Point', coordinates: mid }
			});
		}
		// Other walls' segment lengths too — fainter.
		for (const w of data.walls) {
			if (w.id === aId) continue;
			const c = (w.pathGeoJson?.coordinates ?? []) as LngLat[];
			for (let i = 0; i < c.length - 1; i++) {
				const a = c[i];
				const b = c[i + 1];
				const len = haversineMeters(a, b);
				const mid: LngLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
				labelFeatures.push({
					type: 'Feature',
					properties: { label: `${len.toFixed(1)} m` },
					geometry: { type: 'Point', coordinates: mid }
				});
			}
		}
		(m.getSource('wall-segment-labels') as GeoJSONSource).setData({
			type: 'FeatureCollection',
			features: labelFeatures
		});

		// Boundary
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

		// Vertex markers for the active wall
		clearVertexMarkers();
		if (mlCtors && aWall) {
			const { Marker } = mlCtors;
			aCoords.forEach((c, idx) => {
				const el = document.createElement('div');
				el.className = 'vertex-handle';
				el.dataset.index = String(idx);
				const marker = new Marker({ element: el, draggable: true })
					.setLngLat(c)
					.addTo(m);
				marker.on('dragend', () => {
					const ll = marker.getLngLat();
					moveVertex(idx, [ll.lng, ll.lat]);
				});
				el.addEventListener('contextmenu', (e) => {
					e.preventDefault();
					if (confirm('Remove this point?')) deleteVertex(idx);
				});
				el.addEventListener('dblclick', (e) => {
					e.preventDefault();
					deleteVertex(idx);
				});
				activeVertexMarkers.push(marker);
			});
		}
	}

	// --- keyboard shortcuts ------------------------------------------------
	function onKey(e: KeyboardEvent) {
		// Only handle when the map area is focused-ish (not while typing in the textarea)
		const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
		if (tag === 'input' || tag === 'textarea') return;
		if (e.key === 'v' || e.key === 'V') {
			tool = 'pan';
		} else if (e.key === 'd' || e.key === 'D') {
			tool = 'draw';
		} else if (e.key === 'Escape') {
			if (mode === 'drawing' && activeCoords().length === 0) return;
			if (mode === 'drawing') {
				// Cancel current draw — discard active wall points
				setActiveCoords([]);
				scheduleSave();
			}
		} else if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) {
			if (mode === 'drawing') {
				e.preventDefault();
				undoLastPoint();
			}
		} else if (e.key === 'Enter' && mode === 'drawing' && activeCoords().length >= 2) {
			e.preventDefault();
			finishWall();
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
					// Re-fit so the boundary is visible.
					setTimeout(() => fitMapToContent(), 700);
				}
			} catch {
				// Silently fall back to no-boundary mode.
			}
		})();
	});

	// --- initial init ------------------------------------------------------
	ensureActiveWall();

	// Auto-fit map to show all walls + boundary on first ready.
	$effect(() => {
		if (!browser || !mapInstance || mapStatus !== 'ready' || !mlCtors) return;
		untrack(() => fitMapToContent());
	});

	function fitMapToContent() {
		if (!mapInstance || !mlCtors) return;
		const { LngLatBounds } = mlCtors;
		const points: LngLat[] = [];
		for (const w of data.walls) {
			for (const c of (w.pathGeoJson?.coordinates ?? []) as LngLat[]) {
				points.push(c);
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
			meters: polylineLengthMeters((w.pathGeoJson?.coordinates ?? []) as LngLat[])
		}));
		const total = perWall.reduce((s, p) => s + p.meters, 0);
		return { perWall, total };
	});
</script>

<svelte:window onkeydown={onKey} />

<div class="step2">
	<header class="topbar">
		<div class="walls-tabs" role="tablist">
			{#each data.walls as w (w.id)}
				{@const len = polylineLengthMeters((w.pathGeoJson?.coordinates ?? []) as LngLat[])}
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
			{#if mode === 'drawing'}
				<button
					type="button"
					class="btn ghost"
					onclick={undoLastPoint}
					disabled={activeCoords().length === 0}
				>
					Undo
				</button>
				<button
					type="button"
					class="btn primary"
					onclick={finishWall}
					disabled={activeCoords().length < 2}
				>
					Finish wall
				</button>
			{:else}
				<button type="button" class="btn ghost" onclick={resumeDrawing}>+ Add points</button>
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
			{/if}
		</div>
	</header>

	<div class="map-frame">
		<div class="map" bind:this={mapContainer}></div>
		{#if mapStatus !== 'ready'}
			<div class="map-loading">Loading satellite…</div>
		{/if}

		<!-- Tool palette: Pan vs Draw. Stays clear of MapLibre's top-right nav controls. -->
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

		<div class="map-hint">
			{#if tool === 'pan'}
				Pan tool — drag to navigate, scroll/pinch to zoom. Switch to Draw to add points.
			{:else if mode === 'drawing'}
				{#if activeCoords().length === 0}
					Tap the map to drop the first wall point.
				{:else if activeCoords().length === 1}
					Tap to add the next point — at least 2 points needed.
				{:else}
					Keep tapping to extend. Hold near 90° from the previous segment for a snap.
					{#if snapHintLabel}<strong class="snap-tag">snap {snapHintLabel}</strong>{/if}
				{/if}
			{:else}
				Tap on the line between vertices to insert one. Drag any vertex to fine-tune. Double-click a vertex to remove it.
			{/if}
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

	.map-frame {
		position: relative;
		width: 100%;
		height: clamp(420px, 60vh, 720px);
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

	/* Tool palette — top-left of the map, away from MapLibre's top-right nav */
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
	.snap-tag {
		display: inline-block;
		background: var(--success);
		color: #0b0b0c;
		padding: 0.05rem 0.4rem;
		border-radius: 4px;
		margin-left: 0.4rem;
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
