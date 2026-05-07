/**
 * src/utils/geo.ts
 *
 * Pure geometry helpers. No DB, no I/O.
 *
 * Coordinates throughout Polaris are stored as [latitude, longitude] pairs
 * (Asset.latitude / Asset.longitude, MapRegion polygon vertices). Helpers in
 * this module use the same ordering.
 */

export type LatLng = [number, number];

/**
 * Standard ray-casting point-in-polygon test. Treats the polygon as a closed
 * ring whether or not the caller repeated the first vertex at the end.
 *
 * Counts the polygon edge as "inside" on the Y-bound where horizontal ray
 * exits crossings — fine for our use case (firewall coords vs operator-drawn
 * polygons; equality is exceptionally unlikely and either bucketing is fine).
 *
 * Does NOT handle polygons that cross the antimeridian. Polaris fleets are
 * regional; this is documented as out-of-scope in the feature plan.
 */
export function pointInPolygon(point: LatLng, polygon: LatLng[]): boolean {
  if (polygon.length < 3) return false;
  const [py, px] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [iy, ix] = polygon[i]!;
    const [jy, jx] = polygon[j]!;
    const intersects =
      iy > py !== jy > py &&
      px < ((jx - ix) * (py - iy)) / (jy - iy + Number.EPSILON) + ix;
    if (intersects) inside = !inside;
  }
  return inside;
}
