# SatObserver-MX

Satellite tracking and visualization app for macOS, inspired by mic8.ch SatObserver.
Local Python backend (TLE fetching, caching, persistence) + browser frontend
(SGP4 propagation via satellite.js, 2D world map, 3D globe, polar sky chart,
floating windows) — packaged as a standalone native app.

![SatObserver-MX](docs/screenshot.png)

Full development history — requirements → preview → review fixes → iterations →
packaging — is in [DEVLOG.md](DEVLOG.md); module APIs are in [CONTRACT.md](CONTRACT.md).

## Requirements

**To run the packaged app** (`release/SatObserver-MX-macOS-arm64.zip`):
- macOS on Apple Silicon (arm64); built and tested on macOS 15
- No runtime dependencies — Python, imagery, and star catalog are bundled
- Network access for TLE fetching (cached TLEs work offline)
- Optional: a free [space-track.org](https://www.space-track.org) account for
  Space-Track queries and batch TLE refresh
- The app is unsigned: first launch on a machine other than the build machine
  needs right-click → Open once

**To run from source** (browser mode):
- Python ≥ 3.10 — **standard library only**, no packages needed
- Any modern browser (developed against Chrome; the packaged app uses WKWebView)

**To rebuild the .app**:
- `python -m venv .venv-build && .venv-build/bin/pip install pywebview pyinstaller`
- (icon regeneration additionally needs `pillow numpy`)

## Run

**Standalone app**: unzip `release/SatObserver-MX-macOS-arm64.zip`, drag
`SatObserver-MX.app` to /Applications if you like, double-click. Native window,
Cmd-Q quits. User data lives in `~/Library/Application Support/SatObserverMX/`.

**Dev / browser mode**:

```sh
python3 server.py
```

This starts a local server on http://127.0.0.1:8474 and opens your browser.
Options: `--port N`, `--no-browser`. In dev mode data lives in `./data/`.

**Rebuild the app** (after code changes):

```sh
.venv-build/bin/pyinstaller --noconfirm --clean --windowed \
  --name "SatObserver-MX" --icon build_icon/SatObserver.icns \
  --add-data "app:app" --osx-bundle-identifier "local.satobserver.mx" desktop.py
```

## Features

- **TLE sources**: CelesTrak groups (stations, visual, Starlink, GPS, …),
  **Space-Track.org with your credentials** (NORAD IDs / INTLDES / name search /
  full catalog), Mike McCants zip links (classfd.zip, inttles.zip), paste-in
  TLEs. All fetches cached on disk (2 h freshness for CelesTrak; stale cache
  served if network is down). **6-digit catalog numbers fully supported**: both
  fetchers use JSON (OMM) with integer `NORAD_CAT_ID`; TLE lines for the SGP4
  pipeline are taken from the record or synthesized server-side (validated
  byte-identical to CelesTrak's own TLEs), with Alpha-5 encoding where needed.
- **Satellites window**: browse the fetched catalog (name/NORAD filter,
  NORAD-sortable, INTLDES / inclination / RAAN / AOP / period / apogee /
  perigee columns), multi-select, import into named **families** (label-only
  by default). Per-satellite toggles for ground track (GT), orbit (OR),
  footprint (FP), label (LB); per-family batch toggles; per-sat colors; a ⓘ
  button opens a detail panel (NORAD, int'l designator, launch date & site
  from CelesTrak SATCAT, epoch, and full mean orbital elements). The import
  section folds away and has its own height splitter.
- **Click-to-select** in every view: clicking a satellite turns on its ground
  track, orbit, and footprint; clicking it again reverts it to label-only;
  selecting another satellite leaves the previous one's display as-is.
- **2D Map**: NASA Blue Marble (terrain + bathymetry, no political borders),
  pan/zoom, ground tracks (past dim / future bright), footprint circles,
  day/night terminator, graticule, sun/moon subpoints, ground stations,
  live lat/lon/alt/vel + az/el/range readout.
- **3D Globe**: textured Earth with night lights, satellites, orbits, ground
  tracks, footprints, stations, stars, sun-synchronized lighting; screen-
  constant labels and markers; **FS** mode rides the nadir line of the
  selected satellite, looking straight down at the ground it overflies.
- **Master Clock**: free-running simulation clock, keyboard-editable
  `YYYY-MM-DD HH:MM:SS` (UTC) with per-segment ↑/↓ stepping
  (year/month/day/hour/min/sec), rate −1000×…+1000×, quick step buttons,
  "Real time" sync, Space to run/pause. Everything repropagates instantly.
- **Locations window**: ground stations by lat/lon/alt; the active station
  drives az/el/range readouts, pass predictions, and the sky chart.
- **Passes window**: AOS/TCA/LOS pass predictions over the active station,
  min-elevation filter, optical visibility flag (● satellite sunlit + dark
  site · ☼ daylight pass · ✕ satellite in Earth's shadow), click a pass to
  jump the clock to it.
- **Sky Chart window**: live polar az/el plot over the active station
  (elevation rings selectable 30°/10°, azimuth spokes every 45°, sky-view
  E-left or map-view E-right). Satellites above the horizon are clickable;
  pass trajectories follow the GT toggle, are cut at a 1° rise/set threshold,
  and carry per-minute time-boxed ticks with AOS/LOS times. Toggleable star
  layers computed live from the master clock: ~1000 stars to mag 4.6,
  bright-star names, constellation lines & names.
- **Per-family TLE refresh**: the ⟳ button re-fetches every member's current
  TLE (one Space-Track batch query when credentials are saved, CelesTrak
  per-object fallback) and updates in place.
- State (families, locations, settings, window layout) auto-saved.

## Repository layout

```
server.py            backend: static server + JSON API (Python stdlib only)
desktop.py           native-window shell for the packaged app (pywebview)
app/                 frontend (classic JS, no build step) + NASA imagery + vendor libs
build_icon/          app icon generator (orthographic Blue Marble render)
release/             packaged app zip (macOS arm64)
docs/                screenshot
CONTRACT.md          binding module-API contract used during development
DEVLOG.md            full development log
SatObserver.command  double-click dev launcher
```

## Notes & credits

- Space-Track credentials are stored (optionally) in the local data directory,
  chmod 600, plaintext — local machine only, never committed.
- Base imagery: NASA Blue Marble Next Generation and NASA Earth Observatory
  night lights (public domain).
- Star & constellation catalog derived from
  [d3-celestial](https://github.com/ofrohn/d3-celestial) (BSD-3; BSC5/HYG data).
- Propagation: [satellite.js](https://github.com/shashwatak/satellite-js) (MIT);
  3D: [three.js](https://threejs.org) (MIT).
- Orbital data: [CelesTrak](https://celestrak.org),
  [Space-Track](https://www.space-track.org), and Mike McCants' TLE archives.
