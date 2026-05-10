/**
 * Engineering rules for Elite Walls retaining-wall quoting.
 *
 * Defaults locked during planning:
 * - Post spacing height-banded: 2400 (≤1.0 m), 2100 (1.0–1.5 m), 1800 (>1.5 m)
 * - Pier Ø: 300 mm (≤1.0 m), 450 mm (1.0–1.5 m), 600 mm (>1.5 m)
 * - Embedment = max(retainedHeight × 1.0, 600 mm)
 * - Engineer-cert threshold: QLD ≤1000 mm, NSW ≤600 mm, default 600 mm
 *   (treat unknown states as conservative). Surcharge load auto-flags regardless.
 *
 * All units in millimetres unless noted.
 */

export const PANEL_MODULE_MM = 200;
export const DEFAULT_BOUNDARY_OFFSET_MM = 100;

/** Recommended post spacing in mm given the maximum retained height (mm). */
export function recommendedPostSpacingMm(maxRetainedMm: number): number {
	if (maxRetainedMm <= 1000) return 2400;
	if (maxRetainedMm <= 1500) return 2100;
	return 1800;
}

/** Recommended pier diameter (mm) given a post's retained height (mm). */
export function recommendedPierDiameterMm(retainedMm: number): number {
	if (retainedMm <= 1000) return 300;
	if (retainedMm <= 1500) return 450;
	return 600;
}

/**
 * Required pier embedment depth (mm). Conservative: max(retained × 1.0, 600 mm).
 * The plan locked this; if engineering review wants something tighter,
 * adjust here in one place.
 */
export function recommendedEmbedmentMm(retainedMm: number): number {
	return Math.max(retainedMm, 600);
}

/** Engineer-cert threshold by state. Returns the max retained height (mm)
 *  permitted without an engineer's certification. Defaults to NSW's stricter
 *  600 mm if the state is unknown — a quote is safer to be flagged than not. */
export function engineerCertThresholdMm(state: string | null | undefined): number {
	const s = state?.toUpperCase();
	if (s === 'QLD') return 1000;
	if (s === 'NSW') return 600;
	// Other states haven't been profiled yet — default to NSW's conservative number.
	return 600;
}

/** Whether the wall as designed needs an engineer's certification. */
export function isEngineerCertRequired(opts: {
	maxRetainedMm: number;
	state: string | null | undefined;
	surchargeLoad: boolean;
}): { required: boolean; reason: string | null } {
	if (opts.surchargeLoad) {
		return { required: true, reason: 'Surcharge load flagged (driveway / pool / structure within 1× wall height behind).' };
	}
	const threshold = engineerCertThresholdMm(opts.state);
	if (opts.maxRetainedMm > threshold) {
		const stateLabel = opts.state ?? 'this state';
		return {
			required: true,
			reason: `Max retained height ${opts.maxRetainedMm} mm exceeds the ${threshold} mm non-engineered limit for ${stateLabel}.`
		};
	}
	return { required: false, reason: null };
}

/** Snap a height value (mm) to the nearest panel module. */
export function snapToPanelModule(mm: number, moduleMm: number = PANEL_MODULE_MM): number {
	return Math.round(mm / moduleMm) * moduleMm;
}
