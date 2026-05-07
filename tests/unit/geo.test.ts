/**
 * tests/unit/geo.test.ts
 */

import { describe, it, expect } from "vitest";
import { pointInPolygon } from "../../src/utils/geo.js";

// Square covering Atlanta-ish: roughly (33.5,-84.7) → (34.0,-84.2)
const SQUARE: [number, number][] = [
  [33.5, -84.7],
  [33.5, -84.2],
  [34.0, -84.2],
  [34.0, -84.7],
];

describe("pointInPolygon", () => {
  it("rejects polygons with fewer than 3 vertices", () => {
    expect(pointInPolygon([0, 0], [])).toBe(false);
    expect(pointInPolygon([0, 0], [[0, 0]])).toBe(false);
    expect(pointInPolygon([0, 0], [[0, 0], [1, 1]])).toBe(false);
  });

  it("returns true for a point clearly inside the polygon", () => {
    expect(pointInPolygon([33.75, -84.45], SQUARE)).toBe(true);
  });

  it("returns false for a point clearly outside the polygon", () => {
    expect(pointInPolygon([35.0, -85.0], SQUARE)).toBe(false);
    expect(pointInPolygon([0, 0], SQUARE)).toBe(false);
  });

  it("handles a closed ring (first vertex repeated at the end) the same as an open ring", () => {
    const closed: [number, number][] = [...SQUARE, SQUARE[0]!];
    expect(pointInPolygon([33.75, -84.45], closed)).toBe(true);
    expect(pointInPolygon([35.0, -85.0], closed)).toBe(false);
  });

  it("handles non-convex polygons via ray casting", () => {
    // Concave "C" shape opening to the right
    const C: [number, number][] = [
      [0, 0],
      [0, 4],
      [3, 4],
      [3, 3],
      [1, 3],
      [1, 1],
      [3, 1],
      [3, 0],
    ];
    // (2, 2) is in the open mouth of the C → outside
    expect(pointInPolygon([2, 2], C)).toBe(false);
    // (0.5, 2) is on the back wall → inside
    expect(pointInPolygon([0.5, 2], C)).toBe(true);
  });
});
