/**
 * Shared geospatial grid coordinate helpers for Dusty Earth.
 * Supports both regular WGS84 bounds and exact 4-corner rotated/UTM PALM quads.
 */

export function getGridQuad(gridMeta) {
  if (!gridMeta) {
    return [
      [50.0, 26.0],
      [52.0, 26.0],
      [52.0, 24.0],
      [50.0, 24.0],
    ];
  }
  if (Array.isArray(gridMeta.canvas_quad) && gridMeta.canvas_quad.length === 4) {
    return gridMeta.canvas_quad;
  }
  const dx = Number(gridMeta.dx) || 0;
  const dy = Number(gridMeta.dy) || 0;
  const lonMin = Number(gridMeta.lon_min) - 0.5 * dx;
  const lonMax = Number(gridMeta.lon_max) + 0.5 * dx;
  const latMin = Number(gridMeta.lat_min) - 0.5 * dy;
  const latMax = Number(gridMeta.lat_max) + 0.5 * dy;
  return [
    [lonMin, latMax], // NW
    [lonMax, latMax], // NE
    [lonMax, latMin], // SE
    [lonMin, latMin], // SW
  ];
}

export function getDomainPolygonFeature(gridMeta) {
  let ring;
  if (Array.isArray(gridMeta && gridMeta.polygon) && gridMeta.polygon.length >= 4) {
    ring = gridMeta.polygon.map((pt) => [Number(pt[0]), Number(pt[1])]);
  } else {
    const [nw, ne, se, sw] = getGridQuad(gridMeta);
    ring = [sw, se, ne, nw, sw];
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && last && (Math.abs(first[0] - last[0]) > 1e-8 || Math.abs(first[1] - last[1]) > 1e-8)) {
    ring = [...ring, [first[0], first[1]]];
  }
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [ring],
    },
  };
}

export function lonLatToGridIndices(lon, lat, gridMeta) {
  if (!gridMeta) {
    return { inBounds: false, col: 0, row: 0, u: -1, v: -1 };
  }
  const nx = gridMeta.nx || 1;
  const ny = gridMeta.ny || 1;
  const quad = getGridQuad(gridMeta);
  const [nw, ne, se, sw] = quad;

  let u;
  let v;
  const axisAligned =
    Math.abs(nw[0] - sw[0]) < 1e-7 &&
    Math.abs(ne[0] - se[0]) < 1e-7 &&
    Math.abs(nw[1] - ne[1]) < 1e-7 &&
    Math.abs(sw[1] - se[1]) < 1e-7;

  if (axisAligned) {
    const spanLon = ne[0] - nw[0];
    const spanLat = nw[1] - sw[1];
    if (Math.abs(spanLon) < 1e-12 || Math.abs(spanLat) < 1e-12) {
      return { inBounds: false, col: 0, row: 0, u: -1, v: -1 };
    }
    u = (lon - nw[0]) / spanLon;
    v = (nw[1] - lat) / spanLat;
  } else {
    u = 0.5;
    v = 0.5;
    for (let iter = 0; iter < 5; iter++) {
      const w00 = (1 - u) * (1 - v);
      const w10 = u * (1 - v);
      const w11 = u * v;
      const w01 = (1 - u) * v;

      const fx = w00 * nw[0] + w10 * ne[0] + w11 * se[0] + w01 * sw[0] - lon;
      const fy = w00 * nw[1] + w10 * ne[1] + w11 * se[1] + w01 * sw[1] - lat;

      const dxdU = (1 - v) * (ne[0] - nw[0]) + v * (se[0] - sw[0]);
      const dydU = (1 - v) * (ne[1] - nw[1]) + v * (se[1] - sw[1]);
      const dxdV = (1 - u) * (sw[0] - nw[0]) + u * (se[0] - ne[0]);
      const dydV = (1 - u) * (sw[1] - nw[1]) + u * (se[1] - ne[1]);

      const det = dxdU * dydV - dydU * dxdV;
      if (Math.abs(det) < 1e-18) break;
      const du = (fx * dydV - fy * dxdV) / det;
      const dv = (dxdU * fy - dydU * fx) / det;
      u -= du;
      v -= dv;
      if (Math.abs(du) < 1e-9 && Math.abs(dv) < 1e-9) break;
    }
  }

  if (u < -1e-6 || u > 1 + 1e-6 || v < -1e-6 || v > 1 + 1e-6) {
    return { inBounds: false, col: 0, row: 0, u, v };
  }

  const uC = Math.max(0.0, Math.min(1.0, u));
  const vC = Math.max(0.0, Math.min(1.0, v));
  const col = Math.max(0.0, Math.min(nx - 1, uC * nx - 0.5));
  const row = Math.max(0.0, Math.min(ny - 1, vC * ny - 0.5));
  return { inBounds: true, col, row, u: uC, v: vC };
}
