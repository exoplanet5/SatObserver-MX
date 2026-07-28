# SatObserver-MX — Development Log

Project: a macOS replacement for [mic8.ch SatObserver](https://www.mic8.ch/en/satobserver.php),
built 2026-07-15 → 2026-07-16 in `/Users/mickey/sda/satobserver`.
Development was done with Claude Code (Claude Fable 5): architecture and core modules
written directly, four large modules built by parallel sub-agents against a written
contract (`CONTRACT.md`), everything verified end-to-end in a live browser, then
hardened by an adversarial multi-agent review and packaged as a standalone `.app`.

---

## 1. Original requirements (2026-07-15)

From the user, a long-time SatObserver user:

| # | Requirement | Status |
|---|---|---|
| R1 | Orbit-element fetch from **CelesTrak API** | ✅ 25 curated groups, disk-cached |
| R2 | Orbit-element fetch from **McCants zip links** | ✅ classfd.zip / inttles.zip / any zip-or-text URL |
| R3 | **Space-Track API with credentials** (missing in the original app) | ✅ NORAD list / name / full-catalog queries, credentials stored locally |
| R4 | **Satellite import window** from the fetched database | ✅ filterable catalog table → named families |
| R5 | **2D global map** (primary view) with ground track, orbit, visible-area circle | ✅ canvas map, tracks + footprints (orbit line is 3D-only, labeled as such) |
| R6 | **3D globe** with the same overlays | ✅ three.js, ECEF frame, day/night shader |
| R7 | **Location list window**, manual lat/lon/alt stations | ✅ inline-editable, one *active* station |
| R8 | **Master clock**: free-running + keyboard-editable `yyyy-mm-dd HH:MM:SS`, ↑/↓ per segment, efficient SGP4 propagation | ✅ rates ±1000×, caret-segment stepping |
| R9 | Multiple sats per **family**; per-item toggles for track / orbit / visible area | ✅ GT / OR / FP / LB toggles, per-sat + per-family |
| R10 | Open-source **high-res terrain map without country boundaries** | ✅ NASA Blue Marble Next Generation (topography + bathymetry), 5400×2700 |
| R11 | Preview first, then a **standalone app** | ✅ browser preview → pywebview/PyInstaller `.app` |
| + | "more functions that you think needed" | pass predictor w/ optical visibility, sky chart, SATCAT details, per-family TLE refresh, day/night terminator, sun/moon subpoints, … |

---

## 2. Architecture

**Two processes in one:** a local Python backend (network + persistence) and a
browser frontend (all propagation, all rendering). No build step, no frontend
framework, no third-party Python packages at runtime.

```
server.py                  Python 3.13 stdlib-only backend
  ├─ static file server    serves app/ on 127.0.0.1:8474 (fallback 8475…8484)
  ├─ /api/celestrak/*      gp.php GROUP fetch, 2 h disk cache, stale fallback
  ├─ /api/spacetrack/tle   ajaxauth login (cookie jar) + gp query, 3le format
  ├─ /api/mccants/tle      zip download → in-memory extract → TLE parse
  ├─ /api/text/tle         pasted-TLE parser
  ├─ /api/refresh/tle      per-family refresh (Space-Track batch → CelesTrak fallback)
  ├─ /api/satcat           CelesTrak SATCAT record per NORAD (30-day cache)
  ├─ /api/cache*           cached-set list / load / delete
  └─ /api/state            GET/PUT persistence (atomic writes)

app/                       frontend — classic scripts, global SAT namespace
  ├─ index.html, css/app.css
  ├─ js/vendor/            satellite.js 5.0 (SGP4/SDP4), three.js r147 + OrbitControls
  ├─ js/util.js            sun/moon ephemeris (Meeus), terminator, great-circle,
  │                        sat-sunlit shadow-cylinder test, DOM helpers
  ├─ js/windows.js         internal floating-window manager (drag/resize/z-order,
  │                        geometry persisted per window)
  ├─ js/clock.js           master simulation clock + clock window UI
  ├─ js/propagate.js       SGP4 wrapper: geodetic, ground tracks (cached, split at
  │                        antimeridian), orbit sampling, footprints, look angles
  ├─ js/state.js           event bus + central store + debounced backend persistence
  │                        (+ pagehide flush)
  ├─ js/sources.js         TLE Sources window (CelesTrak / Space-Track / McCants /
  │                        paste / cache tabs)
  ├─ js/catalog.js         Satellites window: catalog browser + import + family tree
  ├─ js/satinfo.js         ⓘ per-satellite detail window (SATCAT + mean elements)
  ├─ js/locations.js       ground-station list window
  ├─ js/map2d.js           2D equirectangular canvas map (primary view)
  ├─ js/globe3d.js         three.js globe, Earth-fixed (ECEF) frame
  ├─ js/passes.js          pass predictor (AOS/TCA/LOS + optical visibility)
  ├─ js/skychart.js        polar az/el sky chart
  └─ js/main.js            boot: state → windows → menu bar → shortcuts

desktop.py                 pywebview shell for the packaged app
CONTRACT.md                binding module-API contract (used to parallelize the build)
```

**Key conventions** (full detail in `CONTRACT.md`):
degrees at module boundaries, longitudes in [−180, 180), km for satellite
altitude / m for station altitude, JS `Date` in UTC; a single event bus
(`time`, `sats-changed`, `selection-changed`, `locations-changed`,
`catalog-changed`, `settings-changed`, `state-loaded`); every render loop is
defensive — an SGP4 failure hides that satellite, never throws.

**Data sources:** NASA Blue Marble Next Generation 5400×2700 (terrain +
bathymetry, no borders — R10) + NASA night-lights composite; CelesTrak GP +
SATCAT; Space-Track GP; McCants classified/integrated zips.

### How it was built

1. `CONTRACT.md` written first — exact APIs for every module.
2. Core framework (util / windows / clock / propagate / state / sources /
   catalog / locations / main) written directly; simultaneously **four
   sub-agents** built `map2d.js`, `globe3d.js`, `passes.js`, `server.py`
   against the contract, in parallel.
3. Integration + live browser verification (below).
4. Adversarial review workflow: 4 reviewer agents (orbital math / JS lifecycle /
   backend / UX-completeness) raised 30 findings; each was independently
   verified, ~20 confirmed and fixed.

---

## 3. Phase 1 — browser preview (2026-07-15)

### What the preview shipped

- **TLE Sources window** — CelesTrak group dropdown; Space-Track credential
  form (identity persisted, password optional once saved, `data/config.json`
  chmod 600); McCants URL with suggestions; paste-TLE tab; cache browser.
- **Satellites window** — catalog table (name/NORAD filter), multi-select,
  import into families; per-sat GT/OR/FP/LB toggles, colors, family batch
  toggles.
- **2D Map** — pan/zoom to 40×, ground tracks (past dim / future bright,
  antimeridian-safe), footprint circles (pole-enclosing fill handled),
  day/night shading + terminator, 30° graticule, sun/moon subpoints, station
  markers, click-select, HUD readouts (cursor lat/lon; selected sat
  lat/lon/alt/vel + az/el/range vs active station; TLE epoch age).
- **3D Globe** — SphereGeometry Earth, custom day/night-lights shader driven
  by the real sun vector, orbits (ECI ring rotated by GMST), surface ground
  tracks, footprint rings, station cones, procedural stars, atmosphere rim,
  raycast click-select, follow-selected mode.
- **Master Clock** — rAF-driven sim clock; rate buttons −1000×…+1000×; step
  buttons ±10 s…±1 d; *Real time* sync; the SatObserver-style field where
  ↑/↓ steps the segment under the caret (impossible dates rejected, month
  steps clamp to month end).
- **Locations** — add/edit/delete; active-station radio drives readouts and
  passes.
- **Passes** — 30 s coarse scan + 1 s bisection refinement for AOS/LOS, ternary
  TCA; chunked to keep the UI responsive; sortable results; row-click jumps
  the clock to 60 s before AOS and selects the sat.
- State persistence (families/locations/settings/window layout) via the
  backend, debounced + flushed on tab close.

### Verification (live, in Chrome)

- CelesTrak `visual` group fetched live (157 objects, real 2026 elements);
  McCants `classfd.zip` fetched live (392 objects); paste parser tested.
- ISS imported → position, ground track, footprint rendered on both views;
  3D night side matched the real terminator at test time.
- 1000× time acceleration; year-step via caret; pass table for Greenwich:
  4 ISS passes with textbook geometry (10–11 min durations, max el 88°),
  row-click jump verified.
- Sun-position math validated numerically (solar altitude at Greenwich noon
  Jul 15 = 60.0°, matches δ≈21.5° + φ=51.5°).

### Review round — notable findings fixed

- **HTTP keep-alive poisoning**: error responses sent before the request body
  was drained corrupted the next request on the connection (verified live,
  fixed by draining up-front — see also the regression below).
- **Alpha-5 catalog numbers** (`A1234` → 101234) silently dropped by the TLE
  parser — fixed; immediately relevant since analyst objects (e.g. NORAD
  100057) use them.
- Orphaned TLE lines becoming the *next* satellite's name — fixed.
- Debounced state save lost on quick tab close — `pagehide` flush with
  `fetch(…, keepalive)`.
- Clock field accepted impossible dates via JS `Date` rollover
  (2026-02-31 → Mar 3) — round-trip validation added.
- Import of thousands of sats (Starlink…) froze rendering — confirmation
  guard above 400 objects.
- Map kept rendering at 60 fps while its window was closed — render gate.
- Stale 3D orbit lines after re-importing fresh TLEs — force rebuild on
  `sats-changed`.
- Space-Track credential tmp file was briefly world-readable — `os.open`
  with 0600 from the start; credentials now saved once login succeeds.
- Download/zip size caps (32 MB / 128 MB) on user-supplied URLs.
- **Self-inflicted regression caught by regression test**: the body-drain fix
  cached the request body on the *handler instance*, which persists across
  keep-alive requests — a GET's empty body was replayed into the next PUT,
  wiping `state.json` to `{}`. Fixed by resetting per-request state in
  `_route()`; a socket-level regression test now pins the behaviour.

Refuted findings (25 of them) were discarded after independent verification.

---

## 4. Phase 2 — user-review iterations (2026-07-15 → 07-16)

Each iteration was implemented, verified in the browser, then rolled into the app.

1. **3D labels constant screen size** — sprite world-height rescaled every
   frame by camera distance (`h = base · d / REF_DIST`), matching the 2D map's
   pixel-sized labels.
2. **Catalog table upgrade** — added INTLDES, RAAN°, AOP° columns; period unit
   moved into the header (min); NORAD header click-sorts ▲/▼; all orbital
   values at 2 decimals.
3. **Import defaults** — new imports arrive label-only (LB on; GT/OR/FP off).
4. **ⓘ satellite detail window** — NORAD, international designator
   (`1998-067A`), **launch date & site** (new `/api/satcat` endpoint querying
   CelesTrak SATCAT, 30-day cache, site-code → full-name table), owner/type,
   epoch + age, and mean elements at epoch: perigee, apogee, period, SMA, ECC,
   INC, RAAN, AOP, mean anomaly, plus the raw TLE lines.
5. **3D markers constant screen size** — same per-frame distance scaling for
   marker spheres, pick spheres (click target tracks visual size), selection
   ring, and station cones (re-anchored so the scaled cone stays tip-out on
   the surface).
6. **Clock seconds clipped** — time box sized in `ch` units so
   `YYYY-MM-DD HH:MM:SS` always fits.
7. **Satellites window layout** — "Import from catalog" section is foldable
   (caret header, source status stays visible), with an inner splitter to
   resize catalog vs family list; both fold state and height persist; the
   window's outer resize grip untouched.
8. **Per-family TLE refresh** (⟳ on the family header) — new
   `/api/refresh/tle`: one Space-Track batch query for all NORADs when
   credentials are saved, CelesTrak per-object fallback (≤60) for the rest;
   updates elements in place (toggles/colors preserved), invalidates SGP4
   caches, transient "✓ n updated · m not found" tag. Live test refreshed the
   Demo family to same-day epochs and picked up the official rename
   *CSS (TIANHE-1)*.
9. **Sky Chart window** — live polar az/el plot over the active station:
   elevation rings every 30°, azimuth spokes every 45°; sky-view (N up,
   E left) by default with E⇄ map-view toggle (persisted); all
   above-horizon sats as clickable markers; the selected satellite draws its
   current-or-next pass trajectory (≤12 h lookahead) with ↑AOS/↓LOS times at
   the horizon; HUD text box (2D-map style) with AZ / EL / RNG, ● sunlit /
   ✕ eclipsed, and site sun altitude. Verified: ISS over Beijing rising S
   08:25 UTC → setting ENE 08:36 UTC.

Also added along the way: pass-table **optical visibility column**
(shadow-cylinder sunlit test at TCA + site sun < −6° ⇒ ● visible / ☼ daylight
/ ✕ eclipsed — validated against the classic post-dusk ISS window over
Greenwich).

10a. **6-digit catalog-number era** (2026-07-17) — the public catalog crossed
    100000 in June 2026 (SARAMAGO = NORAD 100000), and classic TLE format
    caps out (Alpha-5 covers only 100000–339999). Verified live: CelesTrak
    and Space-Track both serve full integer `NORAD_CAT_ID` in JSON (OMM).
    Both fetchers switched to `FORMAT=json` / `format/json`; NORAD ids now
    come from the integer field, and TLE lines for the SGP4 pipeline are
    taken from the record when embedded (Space-Track) or synthesized by a
    new server-side **OMM→TLE writer** (validated byte-for-byte identical to
    CelesTrak's official ISS TLE, checksums included; Alpha-5 catnum encoding
    for 100000–339999, propagation-safe placeholder above). Also added an
    **INTLDES / COSPAR** query type to the Space-Track panel (accepts
    `2026-162A`, legacy `98067A`, or partials).

10. **Sky Chart planetarium upgrade** (2026-07-17) — (a) elevation grid
    selectable 30°/10° per ring; (b) per-minute tick dots along the pass
    trajectory with dark rounded time boxes (interval auto-widens to keep
    ≤16 labels on long/GEO passes); (c) star layers with 2D-map-style toggle
    buttons in the upper-left: ✶ stars (1018 to mag 4.6), SN bright-star
    names (110), CL constellation lines, CN constellation names (89) —
    catalog converted from d3-celestial (BSD-3, BSC5/HYG-derived) into a
    35 KB bundled `starcat.js`; RA/Dec → alt/az computed per frame from the
    master clock (~3k trig transforms, sub-ms, and the chart already skips
    all work while its window is closed). Verified against the real sky:
    Polaris at az 0.7°/alt 39.4° from Beijing, Vega high in the July evening
    sky, per-minute ISS pass ticks 07:39→07:48 UTC.

11. **CelesTrak SupGP source** (2026-07-20) — new "CelesTrak SupGP" tab
    (between CelesTrak and Space-Track) for supplemental GP data: TLEs
    CelesTrak fits to operator ephemerides, more accurate than standard GP
    and available pre-launch/pre-catalog. Two problems needed a strategy:
    (a) **file discovery** — FILE names are a mix of stable operator files
    (iss, css, starlink, gps…) and launch-specific ones that appear/expire
    unscheduled (starlink-g17-39 + backup-window b1…b10): the backend
    scrapes the supplemental index page (`/api/supgp/index`, 2 h cache,
    stale fallback, labels recovered from the table cells), the tab shows
    both classes in a grouped dropdown with a ⟳ re-scan button plus a
    manual FILE override for names not yet indexed; (b) **multi-segment
    sets** — supplemental files carry many piecewise-fitted "[Segment NN]"
    TLEs per object (live ISS file: 60 segments spanning 15 days, epochs in
    the future). The server collapses them to one catalog entry per NORAD
    id carrying all segments (`segs`), and `propagate.js` gained
    `recFor(sat, date)`: every propagation entry point (positions, ground
    tracks, orbit rings, look angles → passes) uses the segment whose epoch
    is nearest the requested time, memoized per segment, so tracks and pass
    predictions stitch across segments; render caches invalidate on segment
    switch via satrec identity. Family ⟳ refresh now posts each sat's
    source so SupGP imports re-fetch their own file first (Space-Track/
    CelesTrak fallback when a launch file is retired, stale segs dropped).
    Verified live: ISS 60-seg import propagates at 425.6 km with segment
    switches at ±36 h, CSS 28 segs collapse to one object, pre-launch
    STARLINK-G17-39 STACK/SINGLE (placeholder catnums 72000/72001,
    2026-166A/B) fetched hours before liftoff, refresh + dead-file
    fallback exercised through the UI.

12. **Per-family hide/show** (2026-07-20) — 👁 button in each family header
    (before the GT batch toggle). Hiding excludes the family in ONE place —
    `state.allActiveSats()` — which every view (2D map, 3D globe, sky
    chart, passes) already consumes, so markers, labels, tracks, and pass
    predictions all vanish together; per-sat GT/OR/FP/LB flags are never
    touched, so showing again restores the exact prior display state.
    Hiding a family containing the current selection clears the selection.
    Hidden families render dimmed with a struck-through name; `hidden`
    persists in state.json and survives restarts (verified live across a
    reload, including exact-restore of mixed per-sat toggle patterns).

13. **Sky chart Sun & Moon** (2026-07-21) — ☉ toggle in the chart toolbar
    (default on). Alt/az derived from the existing sub-point ephemerides via
    a new `SAT.util.altAzFromSubpoint` (great-circle bearing + zenith
    distance); the moon gets a mean horizontal-parallax correction
    (−0.95°·cos el). Sun rendered in the 2D-map style (rayed disc); the moon
    shows its **real phase**: dark disc + lit region built from the sun-side
    semicircle closed by the terminator ellipse (semi-axis R·|cos ψ| from
    the geocentric sun–moon elongation ψ), bright limb rotated to face the
    sun's chart position (an illuminated-% label was dropped on user
    review — just the phase drawing). Validated against
    astropy 7.2 from the Beijing station (2026-07-21 08:00 UTC): sun az/el
    match to 0.01°, moon to 0.13° topocentric, illumination 49% vs 47%;
    bright-limb orientation pixel-verified on canvas; chart placement
    astronomically sane (sun between Pollux and Procyon, first-quarter moon
    beside Spica).

14. **Night-sky realism & visibility pass** (2026-07-28) — four features:
    (a) **Milky Way** on the sky chart: d3-celestial mw.json isophotes
    decimated to a 16 KB `vendor/mwdata.js` (5 stacked levels, 1162 pts),
    filled even-odd through an unclamped polar projection clipped to the
    horizon circle; verified against the real July evening sky (band from
    Cassiopeia through Cygnus to the bright Sagittarius core). (b) The **sky disc tint steps** through five discrete twilight stages
    (daylight / civil / nautical / astronomical / night at sun altitudes
    0/−6/−12/−18°) — on user review the initial version (smooth gradient,
    whole-canvas, brighter daylight) was changed to discrete steps, applied
    only inside the horizon circle with the dark theme kept outside, and a
    dimmer daylight shade; the Milky Way still fades out above −18° and is
    gone by −6°. (c) **Earth-shadow distinction on
    tracks**: `SAT.prop.groundTrack` samples now carry `sunlit` (shadow-
    cylinder test), rendered dashed on the 2D map, faint on the 3D globe,
    and dashed+dimmed on sky-chart pass trajectories — the ISS track was
    verified switching styles exactly at the shadow entry inside the
    terminator. (d) **Passes "● Visible only" filter** (dropdown before
    Compute, persisted): keeps passes with dark site (sun < −6°) + sunlit
    satellite at TCA; verified both ways — a 15-pass all-daylight window
    filtered to zero, and a dusk window caught a real ● ISS pass at min-el 0.
    Debug note: a "frozen renderer" during testing was Chrome throttling
    rAF in an occluded tab — not an app bug; repaints resume on focus.

---

## 5. Phase 3 — standalone macOS app (2026-07-16)

### Options considered

| Option | Size | Verdict |
|---|---|---|
| PyInstaller + default browser | ~25 MB | no native window / awkward quit |
| **pywebview + PyInstaller** | **~29 MB** | **chosen** — native WKWebView window, Cmd-Q, code untouched |
| Tauri (Rust + sidecar) | ~15 MB | toolchain overhead, no benefit here |
| Electron | ~200 MB | 8× the size for the same pixels |
| Native Swift + WKWebView | ~10 MB | weeks of work |

### Implementation

- `server.py` made bundle-aware: assets resolve via `sys._MEIPASS`; user data
  moves to `~/Library/Application Support/SatObserverMX/` when frozen
  (dev mode keeps `./data/`); `start_in_thread()` added for embedding.
- `desktop.py` — ~25-line shell: server on a daemon thread, one
  `webview.create_window` (1500×950), `webview.start()`; closing the window
  kills everything.
- Icon: `build_icon/make_icon.py` renders an orthographic globe from the
  bundled Blue Marble (numpy inverse-projection + limb darkening) with an
  orbit ring and satellite dot → iconset → `SatObserver.icns`.
- Build env: `.venv-build/` (pywebview, pyinstaller, pillow, numpy —
  build-time only).
- Existing `./data/` migrated to Application Support so the app opened with
  the user's families/stations/credentials intact.

```sh
# rebuild after any code change
.venv-build/bin/pyinstaller --noconfirm --clean --windowed \
  --name "SatObserver-MX" --icon build_icon/SatObserver.icns \
  --add-data "app:app" --osx-bundle-identifier "local.satobserver.mx" desktop.py
```

Result: `dist/SatObserver-MX.app`, 29 MB, arm64, ad-hoc signed (built
on-machine ⇒ no Gatekeeper prompt locally; a copy moved to another Mac needs
one right-click → Open). Verified: embedded server serves the bundled
frontend, state loads from Application Support, all features live in the
WKWebView window.

**Windows build (2026-07-18):** PyInstaller cannot cross-compile, so
`.github/workflows/build-windows.yml` builds on a `windows-latest` runner
(Python 3.12, pywebview/EdgeWebView2 + PyInstaller, `--add-data "app;app"`)
and commits `release/SatObserver-MX-windows-x64.zip` back to the repo.
`server.py` gained per-platform bundled data dirs (macOS Application
Support / Windows `%APPDATA%\SatObserverMX` / Linux `~/.local/share`);
`build_icon/SatObserver.ico` generated from the same 1024-px icon render.
First CI run: success (18 MB zip, exe + pythonnet/WebView2 stack + all
frontend assets verified inside the archive).

**Windows README hardening (2026-07-19):** since development and testing
happened entirely on macOS and the Windows exe has never run on real
hardware, README gained an explicit disclaimer plus a "Windows notes &
caveats" section: detailed requirements (Win10 1803+/11 x64, WebView2
Runtime, .NET 4.7.2+), unblock-zip install steps, SmartScreen and
antivirus-false-positive notes, plaintext-credential warning for
`%APPDATA%`, a local PowerShell build recipe mirroring CI, and the
from-source browser mode as the guaranteed fallback.

---

## 6. Running & files

| Task | How |
|---|---|
| Standalone app | `dist/SatObserver-MX.app` (drag to /Applications if desired) |
| Dev / browser mode | `~/.venvs/astro313/bin/python server.py` → http://127.0.0.1:8474 |
| Finder launcher (dev) | `SatObserver.command` |
| App data | `~/Library/Application Support/SatObserverMX/` (bundled) / `./data/` (dev) |
| Space-Track credentials | `config.json` in the data dir, plaintext, chmod 600, local only |

## 7. Known limitations / future ideas

- Base map is 5400×2700 — crisp to ~10× zoom; a tiled 21600×10800 layer would
  be the upgrade path for deeper zoom.
- Orbit (OR) toggle renders in 3D only (2D shows the ground track, as in the
  original app); labeled "orbit (3D)" in the UI.
- Very large live families (>1000 sats) tax per-frame SGP4 + canvas drawing;
  the import guard warns at 400. Web-worker propagation would lift this.
- Pass predictor is geometric + optical-visibility; no magnitude estimates yet
  (RCS is already available via `/api/satcat` if wanted).
- App is unsigned (no Apple Developer ID) — fine for personal use.
- WKWebView (Safari engine) is the app's renderer; all features verified, but
  the browser (Chrome) remains available as a fallback via dev mode.
