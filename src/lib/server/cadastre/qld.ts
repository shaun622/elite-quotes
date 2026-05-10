import { fetchArcgisParcelPolygon } from './arcgis';
import type { PolygonBoundary } from './types';

// QLD Spatial — Land Parcel Property Framework, layer 4 (Cadastral Boundary).
// Public endpoint, no auth.
const QLD_PARCEL_URL =
	'https://gisservices.information.qld.gov.au/arcgis/rest/services/PlanningCadastre/LandParcelPropertyFramework/MapServer/4';

export function fetchQldParcel(lng: number, lat: number): Promise<PolygonBoundary | null> {
	return fetchArcgisParcelPolygon({ queryUrl: QLD_PARCEL_URL, lng, lat });
}
