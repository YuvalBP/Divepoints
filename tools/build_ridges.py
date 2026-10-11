"""Detect candidate rocky ridges (kurkar reefs) in shallow water from the
bundled Sentinel-2 tiles, and write data/ridges.js.

Method: within the shallow belt (model depth MIN_D..MAX_D m), a pixel counts
as hard bottom when it is clearly darker than the local seabed around it
(sand reflects, rock and algae absorb). Dark blobs are cleaned, polygonised,
merged across tile edges and simplified. This is a first guess for the team
to correct in the field, not a survey.

Usage: python tools/build_ridges.py emodnet.tif > data/ridges.js
Needs numpy, scipy, pillow, matplotlib, shapely, tifffile.
"""
import json, math, pathlib, sys
import numpy as np
import tifffile
from PIL import Image
from scipy import ndimage
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from shapely.geometry import Polygon, mapping
from shapely.ops import unary_union

ROOT = pathlib.Path(__file__).resolve().parent.parent
Z = 14
MIN_D, MAX_D = 0.8, 20.0      # metres, model depth window
DARK = 0.80                   # pixel / local background luminance
WIN = 41                      # background window in pixels (~330 m)
MIN_AREA_M2 = 2500

# Depth grid (EMODnet, positive down), as in build_bathy.py
LON0, LAT1, RES = 34.2, 33.15, 1 / 960
depth = -tifffile.imread(sys.argv[1]).astype(float)
H, W = depth.shape


def tile_lonlat(x, y, px, py):
    n = 2 ** Z
    lon = (x + px / 256) / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + py / 256) / n))))
    return lon, lat


def depth_at(lon, lat):
    c = ((lon - LON0) / RES).astype(int)
    r = ((LAT1 - lat) / RES).astype(int)
    ok = (r >= 0) & (r < H) & (c >= 0) & (c < W)
    out = np.full(lon.shape, np.nan)
    out[ok] = depth[r[ok], c[ok]]
    return out


tiles = {}
for p in (ROOT / "tiles" / str(Z)).glob("*/*.jpg"):
    tiles[(int(p.parent.name), int(p.stem))] = p


def lum(x, y):
    p = tiles.get((x, y))
    if not p:
        return None
    a = np.asarray(Image.open(p).convert("RGB"), dtype=float) / 255
    return 0.3 * a[..., 0] + 0.59 * a[..., 1] + 0.11 * a[..., 2]


polys = []
for (x, y) in sorted(tiles):
    # 3x3 block so the background filter sees across tile edges
    block = np.full((768, 768), np.nan)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            L = lum(x + dx, y + dy)
            if L is not None:
                block[(dy + 1) * 256:(dy + 2) * 256, (dx + 1) * 256:(dx + 2) * 256] = L
    py, px = np.mgrid[0:768, 0:768]
    lon = (x - 1 + px / 256) / 2 ** Z * 360 - 180
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * (y - 1 + py / 256) / 2 ** Z))))
    d = depth_at(lon, lat)
    sea = (d >= MIN_D) & (d <= MAX_D) & ~np.isnan(block)
    if sea[256:512, 256:512].sum() < 200:
        continue
    v = np.where(sea, block, 0.0)
    num = ndimage.uniform_filter(v, WIN)
    den = ndimage.uniform_filter(sea.astype(float), WIN)
    bg = np.where(den > 0.3, num / np.maximum(den, 1e-6), np.nan)
    dark = sea & (block < bg * DARK)
    dark = ndimage.binary_opening(dark, iterations=1)
    dark = ndimage.binary_closing(dark, iterations=2)
    m = ndimage.gaussian_filter(dark[256:512, 256:512].astype(float), 1.0)
    if m.max() < 0.5:
        continue
    fig = plt.figure()
    cs = plt.contour(np.arange(256), np.arange(256), m, levels=[0.5])
    plt.close(fig)
    for path in cs.get_paths():
        for ring in path.to_polygons(closed_only=True):
            if len(ring) < 4:
                continue
            pts = [tile_lonlat(x, y, cx, cy) for cx, cy in ring]
            g = Polygon(pts).buffer(0)
            if not g.is_empty:
                polys.append(g)

# Join blobs less than ~30 m apart into continuous ridge areas.
merged = unary_union([p.buffer(0.00015) for p in polys]).buffer(-0.00015)
geoms = list(merged.geoms) if hasattr(merged, "geoms") else [merged]
feats = []
for g in geoms:
    lat = g.centroid.y
    area = g.area * (111320 ** 2) * math.cos(math.radians(lat))
    if area < MIN_AREA_M2:
        continue
    g = g.simplify(0.00006, preserve_topology=True)
    if g.is_empty or g.geom_type != "Polygon":
        continue
    m = mapping(g)
    m["coordinates"] = [[[round(a, 5), round(b, 5)] for a, b in ring] for ring in m["coordinates"]]
    feats.append({"type": "Feature", "properties": {"id": "auto-%d" % len(feats), "area": round(area)}, "geometry": m})

out = {"type": "FeatureCollection", "features": feats}
print("/* Candidate rocky ridges detected from Sentinel-2 imagery (shallow belt,")
print(" * darker-than-local-seabed). First guess only: verify in the field. */")
print("window.AUTO_RIDGES = " + json.dumps(out, separators=(",", ":")) + ";")
print(f"ridges={len(feats)} total_km2={sum(f['properties']['area'] for f in feats) / 1e6:.2f}", file=sys.stderr)
