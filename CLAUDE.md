# Divepoints – ghost-net survey tracker (Israeli Mediterranean)

Tool for the Coastal Patrol (סיירת החוף) volunteer divers who run proactive
surveys for ghost nets on the shallow belt (0–15 m) of the Israeli coast.
The core object is the **survey point**: a dive survey dropped anywhere on the
map. Declared dive sites and underwater ridges are context layers.
UI language: Hebrew, RTL. Users: divers on phones in the field (wet hands,
sun, often no reception) and the manager planning on desktop.

Live site: https://yuvalbp.github.io/Divepoints/ (GitHub Pages, served from
the default branch `claude/diving-sites-interactive-map-07gxv1`, root folder).
The repo owner (Yuval) speaks Hebrew; answer in Hebrew, short and direct,
with exact click paths when he has to do something in a console (he often
works from a phone). Don't wrap up the conversation: when a topic is done,
ask what else he needs.

## Current state (keep this section up to date)
- Live and in use: GitHub Pages enabled, repo `YuvalBP/Divepoints` is public,
  default branch = the working branch above. Pushing to it deploys in ~1 min.
- Firebase project `divepoints-c2bac` is set up: Google sign-in enabled,
  `yuvalbp.github.io` in Authorized domains, Firestore (eur3, production) with
  `firestore.rules` published, web config in `data/firebase-config.js`.
- Yuval signed in first, so he is the map manager (`meta/owner`). He adds
  divers by Gmail in the app: menu ⋯ → ניהול צוות. Next step on his side:
  invite the team and run a first real field survey.
- Known field issue: his phone's Wi-Fi couldn't resolve accounts.google.com
  (DNS_PROBE_FINISHED_BAD_CONFIG); cellular data works. Not an app bug.
- A WhatsApp onboarding message for the team was drafted in chat (link,
  Google sign-in, "+ סקר" flow, layer meanings); regenerate if asked.

## Stack and layout
Static site, no build step for the app itself: `index.html`, `css/style.css`,
`js/app.js` (one IIFE), Leaflet 1.9.4 + Leaflet.markercluster 1.5.3 from unpkg.
Data files in `data/` are plain `window.X = …` scripts:

| File | What | Built by |
|---|---|---|
| `data/sites.js` | 61 declared dive sites / points of interest (hand-edited; `src: "osm"` = position from OSM, else estimate) | by hand |
| `data/coast.js` | land polygons (OSM coastline) | `tools/build_coast.py` |
| `data/bathy.js` | depth bands, isobaths, per-site model depth (`GRID_DEPTH`), shelf depth grid 0–60 m (`DEPTH_GRID`) from EMODnet | `tools/build_bathy.py` |
| `data/places.js` | coastal place names (OSM) | `tools/build_places.py` |
| `data/ridges.js` | candidate rocky ridges detected from Sentinel-2 imagery | `tools/build_ridges.py` |
| `data/firebase-config.js` | Firebase web config (not secret; access is enforced by rules) | by hand |
| `tiles/{z}/{x}/{y}.jpg` | bundled Sentinel-2 cloudless 2023 tiles (EOX, CC BY-NC-SA), z8–14 coastal strip, 504 files | download script (see git history) |

Each `tools/*.py` documents its inputs at the top. They need numpy, scipy,
matplotlib, shapely, tifffile, pillow (use a venv). EMODnet grid comes from
the WCS URL in `build_bathy.py`.

## Survey record (Firestore `surveys/{id}`, same shape in localStorage)
`id, siteId ("" = independent point), lat, lng, place, modelDepth, date,
timeStart, team, status (done | partial | not-done), notDoneReason,
netsFound (yes | no), findings[{type, amount, size, depth, removed
(yes | partial | no), notes, lat, lng}], siteDescription, bottomType,
marineLife, water{visibility, temp, current, currentDir, seaState, wind,
notes}, dive{entry, maxDepth, duration, divers, description}, route[[lat,lng]],
routeSource (drawn | gps | gpx), createdAt, updatedAt, createdBy{name,email},
updatedBy{name,email}`. Result colour key (`surveyStatusKey`): not-done →
aborted, netsFound → nets, partial → partial, else clean. Finding types and
labels live in `FINDING_TYPES` in `js/app.js`.
Other collections: `sites` (custom dive sites), `edits/{siteId}` (position
fixes/verification of built-in sites), `ridges` (team-drawn polygons
`coords`), `ridgeFlags/{autoId}` (`hidden: true` hides an auto ridge).

## Data and sync
- Hosted site: **Firebase** (project `divepoints-c2bac`): Google sign-in +
  Firestore with offline persistence. `firestore.rules` is the access model:
  `meta/owner` = map manager (first sign-in claims it, immutable from the app),
  `team/{email}` = members (only the manager writes), data collections
  `surveys, sites, edits, ridges, ridgeFlags` readable/writable by members only.
  If you change the rules file, Yuval must paste it into the Firebase console
  (Firestore → Rules → Publish).
- Firestore can't store nested arrays: point lists (`route`, `coords`) are
  encoded as `[{lat,lng}]` in `persist()` and decoded in `subscribeAll()`.
- With `FIREBASE_CONFIG = null` the app runs local-only (localStorage).
- `dist/divepoints.html` (+ tiles) is an older claude.ai artifact build
  (`tools/build_artifact.py`) using the artifact `db` capability. The hosted
  site is the single source of truth now; the artifact is not maintained.

## Product decisions (keep them)
- Survey points are independent; linking to a site is optional
  (auto-suggested within 400 m). Every survey stores `createdBy`/`updatedBy`.
- Layers: survey points (diamonds, colour = result), routes/findings, ridges
  (auto = dashed ochre, team-drawn = solid; wrong auto ridges hidden for
  everyone via `ridgeFlags`), declared sites (clustered), depth lines.
  The 15 m isobath is always drawn in magenta: the survey-belt boundary.
- Base maps: satellite (live Esri over bundled tiles), nautical chart
  (EMODnet bands, drawn only in this mode), streets (OSM). Long press / right
  click anywhere = depth probe from `DEPTH_GRID`.
- Design: "field dive slate". Karantina (display: titles, counts, names in
  cards; use weight 400 for big digits, the bold zero closes up), IBM Plex
  Sans Hebrew (body), IBM Plex Mono (depths, coordinates in DDM like boat
  GPS). Navy slate header, magenta = survey actions. Dark mode = night chart.
- Phones: thin bottom tab bar (swipe up), floating "+" survey button, only
  layers + legend buttons on the map. Keep pan smooth: don't draw vector
  layers under imagery, keep labels in per-zoom groups, ridges from zoom 11.
- Coordinates in `sites.js` without `src: "osm"` are estimates; the team
  corrects them in the field ("תקן מיקום").

## Testing
No test runner in the repo; tests were Playwright scripts run ad hoc:
- serve with `python3 -m http.server`, open `index.html`, override
  `data/firebase-config.js` with `window.FIREBASE_CONFIG = null;` for local
  flows (register that route after any catch-all route: later routes win).
- Sync and rules: `firebase emulators:start --only firestore,auth --project
  demo-divepoints` (uses `firebase.json`), config with
  `emulatorHost: "127.0.0.1"`, sign in via
  `firebase.auth().signInWithCredential(GoogleAuthProvider.credential(JSON.stringify({sub,email,email_verified:true,name})))`.
  Verified: stranger denied, members sync surveys/ridges/flags, members can't
  edit the team or take over the manager role.
- Mobile perf check: Playwright `devices['Pixel 7']` + CDP CPU throttle 4×,
  time `map.panBy` frames (target ≲ 60 ms).
- `page.evaluate` must not return Leaflet objects (wrap setView in braces).

## Environment notes for future sessions
- Overpass: `overpass-api.de` often resets; `maps.mail.ru/osm/tools/overpass/api/interpreter`
  worked; split big queries into small bboxes. OSM API (`api.openstreetmap.org/api/0.6/way/{id}/full.json`)
  is reliable for single ways.
- Imagery tiles: `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/{z}/{y}/{x}.jpg`.
- gov.il links for the official dive-site list returned 404.
- A claude.ai artifact copy exists at https://claude.ai/artifact/WU3SiPFGD71BHeJjiUzQ8a
  (old version, separate data store); don't point users there.
- Commit messages: English, imperative subject, body explains why.

## Known gaps / ideas
- Stream mouths (nets snag there) not mapped: Overpass kept timing out.
- Ridge detection is weak where rock touches the shore (e.g. Dor).
- Photos of findings are not supported yet (would need Firebase Storage).
- Survey export is per device (JSON/GeoJSON/CSV from menu → נתונים); no
  team-wide report/dashboard yet.
- No "my location" on the map yet (GPS route recording exists in the form).
- Ridge editing is add/delete only (no vertex editing, no notes on ridges).
