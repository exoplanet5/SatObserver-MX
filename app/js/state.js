/* SAT.bus + SAT.state — event bus, central store, backend persistence */
(function () {
  'use strict';

  // ---------------- event bus ----------------
  const listeners = new Map(); // event -> Set(fn)
  SAT.bus = {
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev).add(fn);
    },
    off(ev, fn) { const s = listeners.get(ev); if (s) s.delete(fn); },
    emit(ev, payload) {
      const s = listeners.get(ev);
      if (!s) return;
      s.forEach(fn => { try { fn(payload); } catch (e) { console.error('bus:' + ev, e); } });
    },
  };

  // ---------------- defaults ----------------
  function defaultSettings() {
    return {
      map2d: {
        showTerminator: true, showGraticule: true, showSun: true, showMoon: true,
        showNightShade: true, trackMinutesBack: 0, trackMinutesFwd: 0, labelSize: 11,
      },
      globe3d: { showStars: true, showNightLights: true, showTerminator: true },
      passes: { hours: 24, minElevationDeg: 10 },
      catalogUI: { collapsed: false, height: 0 }, // import-section fold + splitter height
      skychart: { eastLeft: true, elStep: 30, stars: true,
                  starNames: false, constLines: false, constNames: false },
      layout: {},
    };
  }

  const state = {
    families: [],
    locations: [],
    settings: defaultSettings(),
    selection: { satId: null },
    catalog: null, // {source, fetched, tles:[{name,l1,l2,norad}]}
  };

  function deepMerge(dst, src) {
    for (const k of Object.keys(src || {})) {
      if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) &&
          dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) {
        deepMerge(dst[k], src[k]);
      } else {
        dst[k] = src[k];
      }
    }
    return dst;
  }

  // ---------------- methods ----------------
  state.allActiveSats = function () {
    const out = [];
    for (const fam of state.families) {
      for (const s of fam.sats) if (SAT.prop.ensureSatrec(s)) out.push(s);
    }
    return out;
  };

  state.getSat = function (id) {
    for (const fam of state.families) {
      for (const s of fam.sats) if (s.id === id) return s;
    }
    return null;
  };

  state.getFamilyOfSat = function (id) {
    for (const fam of state.families) {
      for (const s of fam.sats) if (s.id === id) return fam;
    }
    return null;
  };

  // Selection drives the overlays: the selected sat shows ground track /
  // orbit / footprint automatically; on deselect it falls back to label only.
  function setOverlays(sat, on) {
    if (!sat) return false;
    const s = sat.show || (sat.show = {});
    if (!!s.groundTrack === on && !!s.orbit === on && !!s.footprint === on) return false;
    s.groundTrack = on;
    s.orbit = on;
    s.footprint = on;
    if (!on) s.label = true;
    return true;
  }

  state.setSelection = function (satId) {
    satId = satId || null;
    if (state.selection.satId === satId) return;
    state.selection.satId = satId;
    // selecting turns the new sat's overlays on; whatever was selected before
    // keeps its toggles exactly as they are
    const changed = setOverlays(state.getSat(satId), true);
    SAT.bus.emit('selection-changed', { satId: satId });
    if (changed) {
      state.save();
      SAT.bus.emit('sats-changed', {});
    }
  };

  // Map-view click semantics: click selects (overlays on); a second click on
  // the already-selected sat deselects it and reverts IT to label only;
  // clicking empty space does nothing.
  state.clickSelect = function (satId) {
    if (!satId) return;
    if (state.selection.satId === satId) {
      const changed = setOverlays(state.getSat(satId), false);
      state.selection.satId = null;
      SAT.bus.emit('selection-changed', { satId: null });
      if (changed) {
        state.save();
        SAT.bus.emit('sats-changed', {});
      }
    } else {
      state.setSelection(satId);
    }
  };

  state.activeLocation = function () {
    return state.locations.find(l => l.active) || null;
  };

  // ---------------- persistence ----------------
  function serializable() {
    return JSON.parse(JSON.stringify({
      families: state.families,
      locations: state.locations,
      settings: state.settings,
    }, (k, v) => (k && k.startsWith('_')) ? undefined : v));
  }

  let saveTimer = null;
  function push(keepalive) {
    saveTimer = null;
    fetch('/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(serializable()),
      keepalive: !!keepalive, // survives page unload
    }).catch(e => console.warn('state save failed', e));
  }
  state.save = function () {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(push, 800);
  };
  // Flush a pending debounced save when the tab is hidden or closed,
  // otherwise the last action of a session (import, toggle, drag) is lost.
  function flush() {
    if (saveTimer != null) { clearTimeout(saveTimer); push(true); }
  }
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });

  state.load = async function () {
    try {
      const r = await fetch('/api/state');
      const data = await r.json();
      if (data && typeof data === 'object') {
        if (Array.isArray(data.families)) state.families = data.families;
        if (Array.isArray(data.locations)) state.locations = data.locations;
        state.settings = deepMerge(defaultSettings(), data.settings || {});
      }
    } catch (e) {
      console.warn('state load failed', e);
    }
    if (state.locations.length === 0) {
      state.locations.push({
        id: SAT.util.uuid('loc'), name: 'Greenwich Observatory',
        latDeg: 51.4769, lonDeg: -0.0005, altM: 46, show: true, active: true,
        color: '#ff5252',
      });
    }
    SAT.bus.emit('state-loaded', {});
  };

  SAT.state = state;
})();
