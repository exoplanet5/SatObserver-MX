# SatObserver-MX — Architecture Contract

A macOS satellite tracking app inspired by mic8.ch SatObserver. Local Python backend
(TLE fetching + persistence) + browser frontend (SGP4 propagation, 2D map, 3D globe,
floating internal windows). This document is the **binding contract** between modules.
Every module MUST expose exactly the API written here and MAY rely on every other
module exposing exactly its API. Plain ES2020 browser JS, **no build step, no ES
modules** — each file is a classic `<script>` that attaches to the global `SAT`
namespace. No external network access from the frontend except the local backend.

## File layout

```
/Users/mickey/sda/satobserver/
  server.py                  # backend: static file server + JSON API (stdlib only)
  app/
    index.html               # loads CSS + scripts in fixed order (see below)
    css/app.css
    assets/earth_day.jpg     # 5400x2700 equirectangular NASA Blue Marble (topo+bathy, no borders)
    assets/earth_night.jpg   # 4800x2400 equirectangular night lights
    js/vendor/satellite.min.js   # satellite.js 5.0 UMD -> global `satellite`
    js/vendor/three.min.js       # three.js r147 UMD -> global `THREE`
    js/vendor/OrbitControls.js   # attaches THREE.OrbitControls
    js/util.js               # SAT.util   (core team)
    js/windows.js            # SAT.windows(core team)
    js/clock.js              # SAT.clock  (core team)
    js/propagate.js          # SAT.prop   (core team)
    js/state.js              # SAT.state, SAT.bus (core team)
    js/sources.js            # SAT.ui.sources   (core team)
    js/catalog.js            # SAT.ui.catalog   (core team)
    js/locations.js          # SAT.ui.locations (core team)
    js/map2d.js              # SAT.map2d   (AGENT A)
    js/globe3d.js            # SAT.globe3d (AGENT B)
    js/passes.js             # SAT.passes  (AGENT C)
    js/main.js               # boot (core team)
  data/                      # backend persistence (state.json, config.json, cache/)
```

`index.html` script order: vendor libs, then `util, windows, clock, propagate, state,
sources, catalog, locations, map2d, globe3d, passes, main`. `window.SAT = {ui:{}}` is
created inline in index.html before any script loads.

## Conventions

- Angles at module boundaries are **degrees** (suffix `Deg`); longitude normalized to
  **[-180, 180]**; altitudes: satellite height in **km**, ground station altitude in **m**.
- Times are JS `Date` objects (internally UTC). Display format `YYYY-MM-DD HH:MM:SS`.
- Colors are CSS hex strings, e.g. `"#ffcc00"`.
- Every module is defensive: a satellite whose SGP4 propagation fails at the current
  time is silently skipped for rendering (no throws in render loops).

## SAT.bus — event bus (in state.js)

`SAT.bus.on(event, fn)`, `SAT.bus.off(event, fn)`, `SAT.bus.emit(event, payload)`.

Events (payloads):
- `'time'    ` `{date: Date, jumped: bool}` — every animation tick from the clock
  (rAF, so up to 60/s; also fired once immediately when a manual edit/step jumps time;
  `jumped:true` means discontinuous change — invalidate caches).
- `'sats-changed'` — family membership, per-sat display toggles, or colors changed.
- `'catalog-changed'` — fetched-catalog list changed (sources window updated it).
- `'locations-changed'` — ground station list/active flag changed.
- `'selection-changed'` `{satId: string|null}`.
- `'settings-changed'` `{section: string}` — e.g. `{section:'map2d'}`.
- `'state-loaded'` — initial state restored from backend; rebuild UI.

## SAT.clock (clock.js)

- `getDate() -> Date` current simulation time.
- `isRunning() -> bool`, `setRunning(bool)`, `toggle()`
- `getRate() -> number` (multiplier, may be negative), `setRate(n)`
- `setDate(date)` — jump; emits `'time'` with `jumped:true`.
- `syncNow()` — jump to real current time.
- `init()` — starts the rAF loop; emits `'time'` every frame while page visible.

## SAT.state (state.js)

Data (JSON-serializable, persisted to backend `/api/state` debounced 800 ms):

```js
SAT.state.families = [{ id, name, expanded:true, hidden:false, sats: [SatEntry, ...] }]
// hidden:true — family excluded from allActiveSats(): nothing renders in any
// view (markers, labels, tracks, passes). Per-sat show flags are untouched,
// so unhiding restores the exact previous display state.
// SatEntry:
{ id: "s_<rand>", norad: 25544, name: "ISS (ZARYA)",
  l1: "1 25544U ...", l2: "2 25544U ...",
  color: "#4fc3f7",
  show: { groundTrack: true, orbit: true, footprint: true, label: true },
  source: "celestrak:stations", fetched: "2026-07-15T03:00:00Z",
  segs: [{epoch: "2026-07-20T00:00:00.000000", l1, l2}, ...] }  // optional: SupGP
  // piecewise TLE segments, epoch-sorted; present only for multi-segment
  // SupGP imports (source "supgp:<file>"). l1/l2 = segment nearest fetch time.
// non-persisted runtime fields (stripped on save): _satrec (satellite.js satrec),
// _satrecBad, _segRecs (per-segment satrec memo), _segMs (parsed seg epochs).

SAT.state.locations = [{ id, name, latDeg, lonDeg, altM, show: true, active: false,
                         color: "#ff5252" }]

SAT.state.settings = {
  map2d:  { showTerminator:true, showGraticule:true, showSun:true, showMoon:true,
            showNightShade:true, trackMinutesBack:0 /*0 = auto: half period*/,
            trackMinutesFwd:0 /*0 = auto: one period*/, labelSize:11 },
  globe3d:{ showStars:true, showNightLights:true, showTerminator:true },
  passes: { hours:24, minElevationDeg:10 },
  layout: { <windowId>: {x,y,w,h,open} }   // maintained by SAT.windows
}
SAT.state.selection = { satId: null }
```

Methods:
- `allActiveSats() -> SatEntry[]` flat list of all sats in all non-hidden
  families (each entry guaranteed to have a valid `_satrec`; invalid TLEs and
  `hidden` families excluded — this is the single hide point for all views).
- `getSat(satId) -> SatEntry|null`, `getFamilyOfSat(satId) -> family|null`
- `setSelection(satId|null)` — emits `'selection-changed'`.
- `activeLocation() -> location|null` (the one with `active:true`).
- `save()` — debounced push to backend. Call after ANY mutation.
- `load() -> Promise` — restore from backend, then emits `'state-loaded'`.
- Catalog of last-fetched TLEs (not persisted per se; cached server-side):
  `SAT.state.catalog = { source: "celestrak:visual", fetched: iso, tles: [{name,l1,l2,norad}] }`

## SAT.prop (propagate.js) — all SGP4 via global `satellite` (satellite.js 5.0)

- `ensureSatrec(satEntry) -> bool` — build+memoize `_satrec` from l1/l2; false if TLE invalid.
- `recFor(satEntry, date) -> satrec|null` — the satrec to propagate with at `date`:
  for SupGP multi-segment sats the segment whose epoch is nearest `date`
  (memoized per segment in `_segRecs`), else the base `_satrec`. All
  propagation entry points below route through this, so segmented sats are
  piecewise-propagated automatically (tracks/passes stitch across segments).
- `geodetic(satEntry, date) -> null | { latDeg, lonDeg, heightKm, velKmS, eciPos:{x,y,z}, gmst }`
- `periodMinutes(satEntry) -> number` (from satrec.no_kozai, rad/min).
- `groundTrack(satEntry, date, minutesBack, minutesFwd) -> { points: [ {t:ms, latDeg, lonDeg, heightKm} | null ] }`
  ~240 samples; **`null` entries mark antimeridian splits** (consumers start a new
  polyline at null). Internally cached per sat; cache auto-invalidates when the
  requested date drifts >1/8 period from cache center, on `'time' jumped:true`, and
  on `'sats-changed'`. Pass `minutesBack/Fwd = 0` for auto (half period back, one fwd).
- `orbitEci(satEntry, date, nSamples=180) -> [{x,y,z}(km ECI), ...]` one full period
  centered on `date` (cached same policy as groundTrack).
- `footprint(latDeg, lonDeg, heightKm, n=90) -> [{latDeg, lonDeg}, ...]` horizon
  circle (angular radius `acos(Re/(Re+h))`), NOT split at antimeridian (2D consumer
  splits; 3D consumer uses directly).
- `lookAngles(location, satEntry, date) -> null | { azDeg, elDeg, rangeKm }`
- `Re = 6371.0` (km, mean radius used for footprint/graphics), `ReEq = 6378.137`.

## SAT.util (util.js)

- `fmtDate(date) -> "YYYY-MM-DD HH:MM:SS"` (UTC), `fmtDateLocal(date)`, `pad2/pad4`
- `clamp(v,a,b)`, `wrapLon(deg)->[-180,180)`, `deg(rad)`, `rad(deg)`
- `uuid(prefix) -> "prefix_xxxxxxxx"`
- `sunSubpoint(date) -> {latDeg, lonDeg}` (low-precision solar ephemeris, ±0.01°)
- `moonSubpoint(date) -> {latDeg, lonDeg}` (low-precision, ±0.3°)
- `altAzFromSubpoint(latDeg, lonDeg, sub) -> {azDeg, elDeg}` — body's alt/az at a
  site from its sub-point (exact for distant bodies; for the moon subtract
  horizontal parallax ~0.95°·cos(el) from elDeg)
- `nightPolygon(date, n=180) -> [{latDeg, lonDeg}...]` — polygon (in lon order,
  closed by consumer) tracing the terminator, plus helper
  `isNight(latDeg, lonDeg, sunSub) -> bool`
- `destPoint(latDeg, lonDeg, bearingDeg, angDistDeg) -> {latDeg, lonDeg}` great-circle
- `escapeHtml(s)`, `debounce(fn, ms)`
- `el(tag, attrs, children) -> HTMLElement` tiny DOM helper: `attrs` object (class,
  style string, title, ...event handlers as `onclick` fns), children = string | El | array.

## SAT.windows (windows.js) — internal floating window manager

- `SAT.windows.register({ id, title, x, y, w, h, minW=260, minH=160, open=true,
    build(bodyEl, win) })` — registers and (if open) creates. `build` is called once
    when first shown. Returns win handle.
- Win handle: `{ id, el, body, open(), close(), toggle(), isOpen(), setTitle(s), focus() }`
- `SAT.windows.get(id)`, `SAT.windows.toggle(id)`
- Windows are draggable by title bar, resizable by bottom-right grip, close button;
  z-order raises on mousedown; geometry+open state saved into
  `SAT.state.settings.layout[id]` (call `SAT.state.save()`).
- **Resize notification:** on any window resize, the window el dispatches DOM event
  `'win-resize'` on `win.body` (map2d/globe3d listen and resize canvases). Body has
  `position:relative; overflow:hidden` when `build` sets `win.noScroll = true`,
  otherwise `overflow:auto`.

## Panel modules (windows content)

Each is initialized from main.js via `SAT.windows.register({... build: (body, win) => SAT.<mod>.init(body, win)})`.

### SAT.map2d.init(bodyEl, win)  — AGENT A (js/map2d.js)

2D equirectangular world map on `<canvas>`, SatObserver-style main view.
- Base layer `assets/earth_day.jpg` (plate carrée: x=(lon+180)/360*W, y=(90-lat)/180*H).
- Pan (drag) & zoom (wheel, toward cursor; 1x..40x), double-click to reset fit.
  Canvas fills the window body; handle `'win-resize'` + devicePixelRatio.
- Layers (respect `SAT.state.settings.map2d` + per-sat `show` flags, re-render on
  bus events `time/sats-changed/selection-changed/locations-changed/settings-changed/state-loaded`):
  - night shading: darken the night side (use `SAT.util.nightPolygon`/`isNight`),
    subtle (~35% black), plus terminator line.
  - graticule every 30° with labels, equator/prime meridian slightly brighter.
  - per sat: ground track polyline (its color; portion in the past dimmer/thinner),
    footprint circle (translucent fill + outline), marker (small filled square like
    the original) + name label, selected sat gets highlight ring.
  - ground stations: triangle marker + label in location color.
  - sun icon (☀ yellow disc w/ rays) & moon icon (gray disc) at their subpoints.
- Interactions: click on/near sat marker (<=8 px) selects it (`SAT.state.setSelection`);
  click elsewhere deselects. Hover shows cursor lat/lon in a corner readout.
  Bottom-left readout: for selected sat show `NAME  lat lon alt(km) | az el range` (az/el/range
  vs active location if any).
- Performance: render only on demand (dirty flag + rAF); tracks come from
  `SAT.prop.groundTrack` (cached); avoid full-image redraw cost by drawing the base
  image with canvas transform.
- Expose: `SAT.map2d = { init, requestRender }`.

### SAT.globe3d.init(bodyEl, win)  — AGENT B (js/globe3d.js)

three.js (r147 UMD, global THREE + THREE.OrbitControls) 3D view, Earth-fixed (ECEF) frame.
- Sphere radius 1 unit = SAT.prop.Re km; texture `assets/earth_day.jpg`; optional
  night-lights blend (`assets/earth_night.jpg`) via custom ShaderMaterial with sun
  direction uniform (from `SAT.util.sunSubpoint`); subtle atmosphere rim; star field
  (procedural points); directional sun light + soft ambient.
- Per sat (ECI->ECEF with gmst): point marker (sprite/small sphere, sat color),
  name label (canvas sprite, respect `show.label`), orbit line (one period,
  `SAT.prop.orbitEci` rotated rigidly by current gmst, respect `show.orbit`),
  ground track on surface (from `SAT.prop.groundTrack` points, slightly above surface,
  respect `show.groundTrack`), footprint ring on surface (`SAT.prop.footprint`).
- Stations: cone/pin markers + labels.
- OrbitControls: rotate/zoom (min alt ~1.05R, max ~8R), damping. Click sat -> select.
- Render loop: rAF, but skip work when window closed; resize on `'win-resize'`.
- Sun-synchronized lighting updates with `'time'` events.
- Expose: `SAT.globe3d = { init, requestRender }`.

### SAT.passes.init(bodyEl, win)  — AGENT C (js/passes.js)

Pass predictor over the **active location**.
- Controls: scope (selected sat | all imported sats), duration (12/24/48 h from
  current sim time), min max-elevation filter (default from settings.passes), Compute button.
- Algorithm: coarse scan elevation at 30 s steps via `SAT.prop.lookAngles`, refine
  AOS/LOS by bisection to ~1 s, TCA by local max; compute in `setTimeout` chunks so UI
  stays responsive; progress text.
- Results table: Sat, AOS (UTC), AOS az, TCA, max el, LOS, LOS az, duration mm:ss;
  sortable by AOS/max el; row click -> `SAT.clock.setDate(AOS)` + select sat (jump to pass!).
- Handles no-active-location / no-sats with a friendly message.
- Expose: `SAT.passes = { init }`.

## Backend — server.py  — AGENT D (Python 3.13 stdlib ONLY)

`ThreadingHTTPServer` on `127.0.0.1:8474` (fall back +1.. if busy). Serves `app/`
statics at `/` (correct MIME for html/css/js/jpg; `index.html` at `/`). JSON API
(UTF-8, `Content-Type: application/json`; on error return
`{"ok":false,"error":"msg"}` with appropriate 4xx/5xx):

- `GET /api/ping` -> `{ok:true, version:"0.1.0"}`
- `GET /api/celestrak/groups` -> `{ok, groups:[{id,name}]}` — curated static list:
  stations, visual, active, brightest? no — use: stations, visual, last-30-days,
  active, weather, noaa, resource, gps-ops, glonass-ops, galileo, beidou, sbas,
  amateur, starlink, oneweb, iridium-NEXT, globalstar, intelsat, ses, geo, science,
  cubesat, military, radar, tle-new (id = CelesTrak GROUP value, name = human label).
- `GET /api/celestrak/tle?group=<id>[&refresh=1]` — fetch
  `https://celestrak.org/NORAD/elements/gp.php?GROUP=<id>&FORMAT=tle`,
  parse 3-line TLE text -> `TlePayload`; disk-cache `data/cache/celestrak_<id>.json`;
  serve cache when fresh (<2 h) unless `refresh=1`; on network error, fall back to
  stale cache with `"stale":true`.
- `GET /api/supgp/index[?refresh=1]` -> `{ok, fetched, files:[{file,label,launch:bool}]}`
  — scrape `https://celestrak.org/NORAD/elements/supplemental/` for every
  `sup-gp.php?FILE=<name>` link. Stable operator files (iss, css, starlink, gps, …)
  have plain labels; launch-specific files (e.g. `starlink-g17-39`, `…b1`) appear
  and expire with each launch (`launch:true` = name contains a digit). Cache
  `supgp_index.json`, 2 h fresh, stale fallback.
- `GET /api/supgp/tle?file=<name>[&refresh=1]` — fetch
  `.../supplemental/sup-gp.php?FILE=<name>&FORMAT=json` (operator-ephemeris-fitted
  OMM). Records are grouped by NORAD id: supplemental files may carry many
  piecewise "[Segment NN]" TLEs per object → ONE payload entry per object,
  `l1/l2` = segment nearest now, all segments (if >1) under `segs`. Source
  `supgp:<file>`, cache `supgp_<file>.json`, 2 h fresh, stale fallback.
- `POST /api/spacetrack/tle` body `{identity?, password?, save?:bool, query:{type, value}}`
  — login `https://www.space-track.org/ajaxauth/login` (POST form identity/password,
  cookie jar); `type`: `"norad"` (value = comma/space/newline-separated IDs) ->
  `.../basicspacedata/query/class/gp/NORAD_CAT_ID/<id1,id2>/orderby/NORAD_CAT_ID/format/3le`,
  `"name"` (value = substring) -> `.../class/gp/OBJECT_NAME/~~<value>/orderby/OBJECT_NAME/format/3le`,
  `"latest_all"` -> `.../class/gp/decay_date/null-val/epoch/%3Enow-30/orderby/norad_cat_id/format/3le`.
  If identity/password omitted, use saved `data/config.json`. If `save:true`, store
  them in `data/config.json` (plaintext, chmod 600, note in README). Cache to
  `data/cache/spacetrack_<hash>.json`. Errors (401 etc.) -> clear message.
- `GET /api/spacetrack/config` -> `{ok, identity:"..."|null, hasPassword:bool}`
- `POST /api/mccants/tle` body `{url}` (default suggestions live in frontend:
  `https://www.mmccants.org/tles/classfd.zip`, `https://www.mmccants.org/tles/inttles.zip`)
  — download zip (`urllib`, UA header), extract all `*.tle|*.txt` members in memory
  (`zipfile`+`io`), parse concatenated TLEs -> payload; cache `mccants_<name>.json`.
  Also accept plain `.tle`/`.txt` URLs (no zip).
- `POST /api/text/tle` body `{text, label?}` — parse pasted TLE text -> payload (no cache).
- `POST /api/refresh/tle` body `{sats:[{norad,source}]}` (legacy `{norads:[int]}`
  accepted) -> `{ok, fetched, count, tles, missing, notes}` — freshest elements
  per object: (1) sats whose `source` is `supgp:<file>` re-fetch that SupGP file
  (entries carry `segs` + `src`; a retired file falls through), (2) Space-Track
  batch when credentials saved, (3) CelesTrak per-object (≤60) for the rest.
- `GET /api/cache` -> `{ok, entries:[{key, source, fetched, count}]}`;
  `GET /api/cache/<key>` -> cached TlePayload; `DELETE /api/cache/<key>`.
- `GET /api/state` -> saved JSON or `{}` ; `PUT /api/state` (or POST, for
  unload-flush) -> save `data/state.json` (atomic write tmp+rename).
- `GET /api/satcat?norad=N` -> `{ok, record}` — CelesTrak SATCAT record
  (LAUNCH_DATE, LAUNCH_SITE, OWNER, …) cached 30 d in `data/cache/satcat_map.json`.

`TlePayload = {ok:true, source:"celestrak:stations", fetched:"<iso>", count:N,
tles:[{name, l1, l2, norad:int}]}`.

TLE parser (shared function): accept 3-line (`name` / `1 ...` / `2 ...`), 2-line
(name := `"OBJECT <norad>"`), and McCants `"0 NAME"` name lines (strip leading `0 `);
skip malformed pairs (l1[0]=='1', l2[0]=='2', matching catalog numbers); tolerate
`\r\n` and blank lines.

Fetch timeouts 30 s; `User-Agent: SatObserverMX/0.1`. On startup: print URL, and
`webbrowser.open` it unless `--no-browser`. `--port N` flag. Log requests briefly to
stdout. NO third-party imports.

## Look & feel

Dark theme (#101418 background, #e8eaed text, accent #4fc3f7). Menu bar across the
top: app title, buttons toggling each window (2D Map, 3D Globe, Satellites, Sources,
Locations, Passes, Clock, Help), right side shows sim clock + rate (click -> focus
clock window). Compact, technical, monospace numerals (font-variant-numeric or
ui-monospace). All controls styled via css/app.css classes: `.btn`, `.btn.small`,
`.input`, `.select`, `.table`, `.win`, `.win-title`, etc. Agents writing panels use
these classes; core team guarantees they exist.
