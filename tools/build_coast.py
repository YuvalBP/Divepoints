"""Build data/coast.js (land polygons for the offline basemap) from an
Overpass JSON export of natural=coastline ways (out geom).

Usage: python3 tools/build_coast.py coastline.json > data/coast.js
OSM coastline ways run with land on the left; mainland chains are closed
off to the east, islands are already closed rings.
"""
import json, sys

TOL = 0.00004  # ~4 m simplification tolerance (degrees)
EAST = 36.5

def simplify(pts, tol):
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts); keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (y1, x1), (y2, x2) = pts[a], pts[b]
        dx, dy = x2 - x1, y2 - y1; L2 = dx * dx + dy * dy or 1e-18
        best, bi = 0, None
        for i in range(a + 1, b):
            y, x = pts[i]
            t = max(0, min(1, ((x - x1) * dx + (y - y1) * dy) / L2))
            d = ((x - x1 - t * dx) ** 2 + (y - y1 - t * dy) ** 2) ** .5
            if d > best: best, bi = d, i
        if bi is not None and best > tol:
            keep[bi] = True; stack += [(a, bi), (bi, b)]
    return [p for p, k in zip(pts, keep) if k]

ways = [[(p["lat"], p["lon"]) for p in w["geometry"]] for w in json.load(open(sys.argv[1]))["elements"] if w.get("geometry")]
# Join ways that share endpoints into chains.
chains = []
while ways:
    c = ways.pop()
    changed = True
    while changed and c[0] != c[-1]:
        changed = False
        for i, w in enumerate(ways):
            if w[0] == c[-1]: c += w[1:]; ways.pop(i); changed = True; break
            if w[-1] == c[0]: c = w[:-1] + c; ways.pop(i); changed = True; break
    chains.append(c)

polys = []
for c in chains:
    if c[0] != c[-1]:
        # Open chain = mainland coast clipped by the bbox. Land is on the
        # left of travel; along the Israeli coast that is east.
        # Run the chain ends past the map's bounds so no cut edge shows.
        north, south = c[0], c[-1]
        c = [(north[0] + 1.0, north[1])] + c + [(south[0] - 1.0, south[1] - 0.6),
             (south[0] - 1.0, EAST), (north[0] + 1.0, EAST), (north[0] + 1.0, north[1])]
    s = simplify(c, TOL)
    if len(s) >= 4:
        polys.append([[round(lng, 5), round(lat, 5)] for lat, lng in s])

out = {"type": "FeatureCollection", "features": [
    {"type": "Feature", "properties": {}, "geometry": {"type": "Polygon", "coordinates": [p]}} for p in polys]}
print("/* Land polygons built from OpenStreetMap coastline (c) OpenStreetMap contributors, ODbL. */")
print("window.COAST_LAND = " + json.dumps(out, separators=(",", ":")) + ";")
print(f"chains={len(chains)} open={sum(1 for c in chains if c[0]!=c[-1])} polys={len(polys)} pts={sum(len(p) for p in polys)}", file=sys.stderr)
