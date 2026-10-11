"""Build data/places.js: coastal place labels (towns, villages, beaches,
stream mouths) from Overpass JSON exports, kept only near the shoreline.

Usage: python3 tools/build_places.py places.json coast.json [rivers*.json ...] > data/places.js
  places.json  node[place~city|town|village] + natural=beach, `out center tags`
  coast.json   way[natural=coastline], `out geom`
  rivers*.json way[waterway~river|stream][name], `out geom tags`
"""
import json, math, sys

def load(p):
    return json.load(open(p))["elements"]

coast = []
for w in load(sys.argv[2]):
    g = w.get("geometry") or []
    coast += [(a["lat"], a["lon"], b["lat"], b["lon"]) for a, b in zip(g, g[1:])]

def dist_km(lat, lon):
    k = math.cos(math.radians(lat))
    best = 1e9
    for a1, o1, a2, o2 in coast:
        if abs(a1 - lat) > .1: continue
        ax, ay = (o1 - lon) * k, a1 - lat; bx, by = (o2 - lon) * k, a2 - lat
        dx, dy = bx - ax, by - ay
        t = max(0, min(1, -(ax * dx + ay * dy) / ((dx * dx + dy * dy) or 1e-12)))
        best = min(best, math.hypot(ax + t * dx, ay + t * dy))
    return best * 111.32

# How far inland each kind is still worth labelling on a coastal survey map.
LIMIT = {"city": 8, "town": 4, "village": 1.8, "beach": 0.6}
out, seen = [], set()
for e in load(sys.argv[1]):
    t = e.get("tags", {})
    name = t.get("name:he") or t.get("name")
    kind = t.get("place") or t.get("natural")
    if kind not in LIMIT or not name: continue
    c = e.get("center", e)
    lat, lon = c["lat"], c["lon"]
    if not (31.5 <= lat <= 33.1): continue
    if dist_km(lat, lon) > LIMIT[kind]: continue
    key = (name, kind)
    if key in seen: continue
    seen.add(key)
    out.append({"n": name, "k": kind, "lat": round(lat, 5), "lng": round(lon, 5)})

# Stream mouths: the end of each named waterway that touches the shore.
mouths = {}
for path in sys.argv[3:]:
    try: els = load(path)
    except Exception: continue
    for w in els:
        t = w.get("tags", {}); g = w.get("geometry") or []
        name = t.get("name:he") or t.get("name")
        if not g or not name: continue
        for p in (g[0], g[-1]):
            d = dist_km(p["lat"], p["lon"])
            if d < 0.35 and (name not in mouths or d < mouths[name][0]):
                mouths[name] = (d, p["lat"], p["lon"], t.get("waterway"))
for name, (d, lat, lon, ww) in mouths.items():
    out.append({"n": name, "k": "mouth", "lat": round(lat, 5), "lng": round(lon, 5)})

print("/* Coastal place names (c) OpenStreetMap contributors, ODbL. */")
print("window.PLACES = " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";")
from collections import Counter
print(Counter(p["k"] for p in out), file=sys.stderr)
