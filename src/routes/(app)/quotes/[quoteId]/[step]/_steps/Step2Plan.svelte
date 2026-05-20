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
		lngLatToLocal,
		localToLngLat,
		multiPolylineLengthMeters,
		nearestSegment,
		offsetPolyline,
		pathToSegments,
		perpendicularLabelAnchor,
		polylineLengthMeters,
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

	/** Top-level interaction tool. Pan = clicks ignored, just navigate.
	 *  Always defaults to Pan on load — even on a fresh wall — so a stray
	 *  click while the page is settling doesn't drop a point. */
	let tool = $state<Tool>('pan');

	let mapVersion = $state(0);

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
		mapVersion++;
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
			defaults: {
				boundaryOffsetMm: 100,
				panelModuleMm: 200,
				postSpacingMm: 2400,
				concreteStrength: 'N25' as const
			}
		};
	}

	function selectWall(id: string) {
		activeWallId = id;
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

	// --- click logic -------------------------------------------------------
	/**
	 * Two-click drawing: first click stores the start, second click commits
	 * the line as a fresh 2-vertex sub-segment and snaps the tool back to Pan.
	 * Snap-to-90° kicks in on the second click if the new segment lines up
	 * within tolerance against the previous most-recent sub-segment's last edge.
	 */
	function handleMapClick(lngLat: LngLat) {
		if (tool !== 'draw') return;
		const w = activeWall();
		if (!w) return;

		if (pendingStart === null) {
			pendingStart = lngLat;
			return;
		}

		// Second click — commit the line, with optional snap against the
		// previous sub-segment if one exists for context.
		let end: LngLat = lngLat;
		const segs = segments();
		const last = segs[segs.length - 1];
		if (last && last.length >= 2) {
			const snap = snapAngle({
				prev: last[last.length - 2],
				pivot: last[last.length - 1],
				candidate: lngLat
			});
			if (snap) end = snap.snapped;
		}

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
	// svelte-ignore state_referenced_locally
	let showLabels = $state(readToggle('eq.step2.showLabels', true));

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
			localStorage.setItem('eq.step2.showLabels', v ? '1' : '0');
		} catch {
			/* private mode or quota — fail silently */
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

				// Property boundary — solid orange perimeter, slightly translucent fill so
				// the lot reads at a glance without obscuring the satellite imagery.
				m.addLayer({
					id: 'boundary-fill',
					source: 'boundary',
					type: 'fill',
					paint: {
						'fill-color': '#ff8a1c',
						'fill-opacity': 0.06
					}
				});
				m.addLayer({
					id: 'boundary-line',
					source: 'boundary',
					type: 'line',
					paint: {
						'line-color': '#ff8a1c',
						'line-width': 2.5,
						'line-opacity': 0.95
					}
				});

				m.addLayer({
					id: 'walls-other-line',
					source: 'walls-other',
					type: 'line',
					paint: { 'line-color': '#ff8a1c', 'line-width': 3, 'line-opacity': 0.45 }
				});

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

				m.addLayer({
					id: 'wall-active-line',
					source: 'wall-active',
					type: 'line',
					paint: { 'line-color': '#ff8a1c', 'line-width': 4 }
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

	type LabelKind = 'wall-active' | 'wall-other' | 'boundary' | 'offset';

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
		handleMapClick([e.lngLat.lng, e.lngLat.lat]);
	}

	function onMapMouseMove(e: MapMouseEvent) {
		if (!mapInstance) return;
		if (tool !== 'draw' || pendingStart === null) {
			clearHover();
			return;
		}
		const ll: LngLat = [e.lngLat.lng, e.lngLat.lat];

		// Snap the preview against the previous sub-segment's last edge if there
		// is one — gives the user a green confirmation that the new line will
		// land at 0° / 90° / 180° / 270° relative to existing geometry.
		let endPoint: LngLat = ll;
		let snapHit: ReturnType<typeof snapAngle> = null;
		const segs = segments();
		const last = segs[segs.length - 1];
		if (last && last.length >= 2) {
			snapHit = snapAngle({
				prev: last[last.length - 2],
				pivot: last[last.length - 1],
				candidate: ll
			});
			if (snapHit) endPoint = snapHit.snapped;
		}

		setHoverGhost([pendingStart, endPoint]);
		if (snapHit) {
			snapHintCoords = [pendingStart, endPoint];
			snapHintLabel = `${snapHit.angleDeg}°`;
			setSnapHint(snapHintCoords);
		} else {
			snapHintCoords = null;
			setSnapHint(null);
		}
	}

	function clearHover() {
		setHoverGhost(null);
		setSnapHint(null);
		snapHintCoords = null;
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
		untrack(() => syncSourcesAndMarkers());
	});

	// --- effect: keep the pending-start dot in sync -----------------------
	$effect(() => {
		const ps = pendingStart;
		if (!browser || !mapInstance || mapStatus !== 'ready') return;
		untrack(() => setPendingStartMarker(ps));
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

	function syncSourcesAndMarkers() {
		if (!mapInstance) return;
		const m = mapInstance;
		const aId = activeWallId;
		const aWall = data.walls.find((w) => w.id === aId);
		const aSegments = aWall ? pathToSegments(aWall.pathGeoJson ?? null) : [];
		const offsetMm = aWall?.defaults.boundaryOffsetMm ?? 100;

		// Other walls — flatten each wall's MultiLineString into a single feature collection
		const otherFeatures: GeoJSON.Feature[] = [];
		for (const w of data.walls) {
			if (w.id === aId) continue;
			const segs = pathToSegments(w.pathGeoJson ?? null);
			for (const seg of segs) {
				if (seg.length >= 2) {
					otherFeatures.push({
						type: 'Feature',
						properties: { id: w.id, name: w.name },
						geometry: { type: 'LineString', coordinates: seg }
					});
				}
			}
		}
		(m.getSource('walls-other') as GeoJSONSource).setData({
			type: 'FeatureCollection',
			features: otherFeatures
		});

		// Active wall: one feature per renderable sub-segment.
		const activeFeatures: GeoJSON.Feature[] = [];
		const offsetFeatures: GeoJSON.Feature[] = [];
		for (const seg of aSegments) {
			if (seg.length >= 2) {
				activeFeatures.push({
					type: 'Feature',
					properties: {},
					geometry: { type: 'LineString', coordinates: seg }
				});
				const off = offsetPolyline(seg, offsetMm / 1000);
				if (off.length >= 2) {
					offsetFeatures.push({
						type: 'Feature',
						properties: {},
						geometry: { type: 'LineString', coordinates: off }
					});
				}
			}
		}
		(m.getSource('wall-active') as GeoJSONSource).setData({
			type: 'FeatureCollection',
			features: activeFeatures
		});
		(m.getSource('wall-active-offset') as GeoJSONSource).setData({
			type: 'FeatureCollection',
			features: offsetFeatures
		});

		// Length labels — rendered as HTML markers so we get pill styling.
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

		// Offset distance label — only meaningful when the offset is large
		// enough to render with visual separation from the wall. At a typical
		// 100 mm boundary offset and zoom 19, the wall and offset line are 3-4
		// pixels apart so the label just sits on top of the wall and reads as
		// noise. Show only for offsets ≥ 500 mm; smaller offsets are still
		// visible via the dashed parallel line itself plus the value in the
		// wall settings panel.
		if (mlCtors && aWall && offsetMm >= 500) {
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
					marker.on('dragend', () => {
						const ll = marker.getLngLat();
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

	/** Render-helpers for the side panel — shape: per-active-wall list of
	 *  sub-segments, each with edges and lengths. */
	const sidebarSegments = $derived(() => {
		const w = activeWall();
		if (!w) return [] as Array<{ length: number; edges: Array<{ length: number }> }>;
		const segs = pathToSegments(w.pathGeoJson ?? null);
		return segs.map((seg) => {
			const edges: Array<{ length: number }> = [];
			for (let i = 0; i < seg.length - 1; i++) {
				edges.push({ length: haversineMeters(seg[i], seg[i + 1]) });
			}
			return {
				length: polylineLengthMeters(seg),
				edges
			};
		});
	});

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
	<div class="map-frame" class:hide-labels={!showLabels}>
		<div class="map" bind:this={mapContainer}></div>
		{#if mapStatus !== 'ready'}
			<div class="map-loading">Loading satellite…</div>
		{/if}

		<div class="layer-toggles" role="group" aria-label="Map layers">
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

		<div class="map-hint">
			{#if tool === 'pan'}
				Pan tool — drag to navigate, scroll/pinch to zoom. Drag a vertex to move it. Double-click a vertex to remove. Double-click the line between vertices to add one.
			{:else if pendingStart === null}
				Click the start of the line.
			{:else}
				Click the end. {#if snapHintLabel}<strong class="snap-tag">snap {snapHintLabel}</strong>{/if}
			{/if}
		</div>

	</div>

	<aside class="walls-panel" aria-label="Walls and segments">
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
				<span class="muted">{multiPolylineLengthMeters(pathToSegments(w.pathGeoJson ?? null)).toFixed(2)} m</span>
			</div>
			{#if sidebarSegments().length === 0}
				<p class="muted small">No edges yet — drop two points on the map to create your first.</p>
			{:else}
				<ol class="seg-list">
					{#each sidebarSegments() as seg, segIdx (segIdx)}
						<li>
							<header class="seg-head">
								<span>Section {segIdx + 1}</span>
								<span class="muted">{seg.length.toFixed(2)} m · {seg.edges.length} edge{seg.edges.length === 1 ? '' : 's'}</span>
							</header>
							<ul class="edge-list">
								{#each seg.edges as edge, edgeIdx (edgeIdx)}
									{@const key = `${segIdx}:${edgeIdx}`}
									<li class:recent={recentlySetEdge === key}>
										<span class="edge-num">E{edgeIdx + 1}</span>
										<span class="edge-current">{edge.length.toFixed(2)} m</span>
										<form
											class="edge-form"
											onsubmit={(e) => {
												e.preventDefault();
												applyEdgeInput(segIdx, edgeIdx);
											}}
										>
											<input
												type="number"
												step="0.01"
												min="0.05"
												max="500"
												inputmode="decimal"
												placeholder="set m"
												aria-label="Set Section {segIdx + 1} Edge {edgeIdx + 1} length in metres"
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
						</li>
					{/each}
				</ol>
			{/if}
		{/if}
	</aside>
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
	.snap-tag {
		display: inline-block;
		background: var(--success);
		color: #0b0b0c;
		padding: 0.05rem 0.4rem;
		border-radius: 4px;
		margin-left: 0.4rem;
	}

	.layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 18rem;
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
		gap: 0.5rem;
		min-width: 0;
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
	.seg-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		max-height: clamp(300px, 50vh, 560px);
		overflow-y: auto;
	}
	.seg-list > li {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 0.5rem 0.6rem;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.seg-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 0.5rem;
		font-size: 0.78rem;
		font-weight: 600;
	}
	.edge-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.edge-list li {
		display: grid;
		grid-template-columns: 2rem 1fr auto;
		align-items: center;
		gap: 0.5rem;
		padding: 0.25rem 0.3rem;
		border-radius: 6px;
		transition: background 0.4s ease;
	}
	.edge-list li.recent {
		background: rgba(74, 209, 101, 0.18);
	}
	.edge-num {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.72rem;
		color: var(--text-muted);
	}
	.edge-current {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.78rem;
		color: var(--text);
	}
	.edge-form {
		display: flex;
		gap: 0.3rem;
		align-items: center;
	}
	.edge-form input {
		width: 5rem;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.25rem 0.4rem;
		color: var(--text);
		font-size: 0.8rem;
		outline: none;
	}
	.edge-form input:focus {
		border-color: var(--accent);
	}
	.btn.tiny {
		padding: 0.25rem 0.55rem;
		font-size: 0.72rem;
	}

	/* Layer-visibility toggles — sit just below MapLibre's +/- zoom buttons
	 * on the top-right edge of the map. Keeps the left side clear for the
	 * Pan/Draw tools palette and avoids overlapping with the active vertex. */
	.layer-toggles {
		position: absolute;
		top: calc(0.6rem + 78px);
		right: 0.6rem;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		background: rgba(11, 11, 12, 0.85);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.3rem 0.5rem;
		font-size: 0.75rem;
		z-index: 2;
	}
	.layer-toggles label {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		cursor: pointer;
		user-select: none;
		color: var(--text);
		padding: 0.05rem 0;
	}
	.layer-toggles input[type='checkbox'] {
		accent-color: var(--accent);
		width: 14px;
		height: 14px;
		margin: 0;
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

	/* The Labels toggle removes every length pill in one go via this class. */
	:global(.map-frame.hide-labels .edge-label) {
		display: none !important;
	}

	/* Pill-style edge labels rendered via MapLibre Markers. */
	:global(.edge-label) {
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
		font-size: 11px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		padding: 3px 7px;
		border-radius: 999px;
		white-space: nowrap;
		pointer-events: none;
		user-select: none;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
		letter-spacing: 0.01em;
	}
	:global(.edge-label--wall-active) {
		background: #ff8a1c;
		color: #1a0f00;
	}
	:global(.edge-label--wall-other) {
		background: rgba(255, 138, 28, 0.5);
		color: #1a0f00;
	}
	:global(.edge-label--boundary) {
		background: rgba(11, 11, 12, 0.85);
		color: #ffffff;
		border: 1px solid rgba(255, 138, 28, 0.7);
	}
	:global(.edge-label--offset) {
		background: rgba(11, 11, 12, 0.92);
		color: #d8f0bf;
		border: 1px solid rgba(168, 224, 179, 0.7);
		font-size: 10px;
		padding: 2px 6px;
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
