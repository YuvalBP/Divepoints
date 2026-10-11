"""Build data/bathy.js (depth bands + isobaths) from an EMODnet Bathymetry
GeoTIFF of the Israeli coast.

Get the grid (1/16 arc-minute, ~115 m; values are metres, negative = depth):
  curl -o emod.tif "https://ows.emodnet-bathymetry.eu/wcs?service=WCS&version=2.0.1\
&request=GetCoverage&coverageId=emodnet__mean&format=image/tiff\
&subset=Lat(31.5,33.15)&subset=Long(34.2,35.15)"
Then: python tools/build_bathy.py emod.tif > data/bathy.js
Needs numpy, matplotlib, tifffile, shapely.

Shallow contours (5-10 m) are approximate at this grid size; near-shore
detail comes from the coastline layer, not from this grid.
"""
import json, sys
import numpy as np
import tifffile
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from shapely.geometry import Polygon, LineString, mapping
from shapely.validation import make_valid

LON0, LAT1, RES = 34.2, 33.15, 1 / 960  # west edge, north edge, degrees per cell
BANDS = [0, 5, 10, 15, 20, 30, 50, 100, 200, 500, 3000]  # depth band edges (m)
LINES = [5, 10, 15, 20, 30, 50, 100, 200, 500]
TOL = 0.00025  # ~25 m simplification

z = tifffile.imread(sys.argv[1]).astype(float)
depth = -z  # positive down; land negative
h, w = depth.shape


def despike(d, win=9):
    """Replace cells far deeper than their neighbourhood median (bad soundings,
    e.g. a spurious 500-600 m patch inside Herzliya marina)."""
    r = win // 2
    pad = np.pad(d, r, mode="edge")
    view = np.lib.stride_tricks.sliding_window_view(pad, (win, win))
    med = np.median(view, axis=(2, 3))
    bad = (d - med > 15) & (d > 2 * np.maximum(med, 5))
    out = d.copy(); out[bad] = med[bad]
    return out, int(bad.sum())


depth, nbad = despike(depth)
print(f"despiked cells: {nbad}", file=sys.stderr)
lon = LON0 + (np.arange(w) + 0.5) * RES
lat = LAT1 - (np.arange(h) + 0.5) * RES
# Light smoothing of the shallow shelf noise (3x3 mean).
k = np.ones((3, 3)) / 9
pad = np.pad(depth, 1, mode="edge")
depth = sum(pad[i:i + h, j:j + w] * k[i, j] for i in range(3) for j in range(3))


def rings_to_polys(rings):
    """Even-odd nesting: rings inside an odd number of others are holes."""
    polys = [Polygon(r) for r in rings if len(r) >= 4]
    polys = [p for p in polys if p.is_valid and p.area > 2e-7] + \
            [make_valid(p) for p in polys if not p.is_valid]
    polys = [p if p.geom_type == "Polygon" else max(p.geoms, key=lambda g: g.area) for p in polys
             if p.geom_type in ("Polygon", "MultiPolygon")]
    polys.sort(key=lambda p: -p.area)
    out = []  # (shell, [holes])
    depth_of = []
    for i, p in enumerate(polys):
        pt = p.representative_point()
        parents = [j for j in range(i) if polys[j].contains(pt)]
        d = len(parents)
        depth_of.append(d)
        if d % 2 == 0:
            out.append([p, []])
        else:
            parent = parents[-1]
            for o in out:
                if o[0] is polys[parent]:
                    o[1].append(p)
    res = []
    for shell, holes in out:
        g = Polygon(shell.exterior.coords, [hh.exterior.coords for hh in holes])
        g = make_valid(g).simplify(TOL, preserve_topology=True)
        if not g.is_empty:
            res.append(g)
    return res


def rnd(geom):
    m = mapping(geom)
    def r(c):
        return [round(c[0], 5), round(c[1], 5)] if isinstance(c[0], float) else [r(x) for x in c]
    m["coordinates"] = r(m["coordinates"])
    return m


feats = []
fig = plt.figure()
# The OSM land layer is drawn on top, so let the shallowest band run under
# the land: no gap where the model's shoreline and OSM's disagree.
cf = plt.contourf(lon, lat, np.maximum(depth, 0.5), levels=BANDS)
for (lo, hi), path in zip(zip(BANDS, BANDS[1:]), cf.get_paths()):
    rings = [r for r in path.to_polygons(closed_only=True)]
    for g in rings_to_polys(rings):
        feats.append({"type": "Feature", "properties": {"kind": "band", "min": lo, "max": hi}, "geometry": rnd(g)})

cl = plt.contour(lon, lat, depth, levels=LINES)
for level, path in zip(LINES, cl.get_paths()):
    for seg in path.to_polygons(closed_only=False):
        if len(seg) < 3:
            continue
        g = LineString(seg).simplify(TOL)
        if g.length < 0.004:  # drop tiny noise loops (<~400 m)
            continue
        feats.append({"type": "Feature", "properties": {"kind": "isobath", "depth": level}, "geometry": rnd(g)})

# Model depth at each base site (sites.js), shown in the site card.
import re, pathlib
src = (pathlib.Path(__file__).resolve().parent.parent / "data/sites.js").read_text()
grid = {}
raw, _ = despike(-tifffile.imread(sys.argv[1]).astype(float))
for sid, la, lo in re.findall(r'id: "([^"]+)".*?lat: ([\d.]+), lng: ([\d.]+)', src, re.S):
    r, c = int((LAT1 - float(la)) / RES), int((float(lo) - LON0) / RES)
    d = raw[max(r - 1, 0):r + 2, max(c - 1, 0):c + 2]  # 3x3 cells around the site
    sea = d[d > 0]
    if sea.size:
        grid[sid] = round(float(np.median(sea)), 1)  # median resists stray cells

out = {"type": "FeatureCollection", "features": feats}
print("/* Depth bands and isobaths derived from EMODnet Bathymetry (DTM, 1/16 arc-minute).")
print(" * Shallow contours are approximate. Not for navigation. */")
print("window.BATHY = " + json.dumps(out, separators=(",", ":")) + ";")
print("window.GRID_DEPTH = " + json.dumps(grid, separators=(",", ":")) + ";")
print(f"features={len(feats)}", file=sys.stderr)
