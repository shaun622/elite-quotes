import { fetchArcgisParcelPolygon } from './arcgis';
import type { PolygonBoundary } from './types';

// NSW Spatial Services — Land Parcel Property Theme, Lot feature service.
// Public endpoint, no auth.
const NSW_PARCEL_URL =
	'https://portal.spatial.nsw.gov.au/server/rest/services/NSW_Land_Parcel_Property_Theme/FeatureServer/8';

export function fetchNswParcel(lng: number, lat: number): Promise<PolygonBoundary | null> {
	return fetchArcgisParcelPolygon({ queryUrl: NSW_PARCEL_URL, lng, lat });
}
