/* main.js — boot: load state, start clock, register windows, menu bar */
(function () {
  'use strict';
  const U = SAT.util;

  function helpContent(body) {
    body.appendChild(U.el('div', { class: 'pane', style: 'font-size:12px;line-height:1.6;max-width:560px' }, [
      U.el('h3', { style: 'margin:4px 0' }, 'SatObserver-MX'),
      U.el('p', { class: 'dim', style: 'margin:4px 0' },
        'Satellite tracking & visualization. All propagation is SGP4 from TLEs, driven by the master clock.'),
      U.el('div', { class: 'sep' }),
      U.el('p', { style: 'margin:4px 0' }, [U.el('b', null, 'Workflow: '),
        '1) Fetch TLEs in Sources (CelesTrak group, CelesTrak SupGP operator ephemerides, ',
        'Space-Track credentials, McCants zip, or paste). ',
        '2) In Satellites, filter, tick objects and Import into a family. ',
        '3) Watch them on the 2D Map / 3D Globe; toggle per-sat ground track (GT), orbit (OR), footprint (FP), label (LB). ',
        '4) Add ground stations in Locations; the active ● station drives az/el/range readouts and Passes.']),
      U.el('div', { class: 'sep' }),
      U.el('p', { style: 'margin:4px 0' }, [U.el('b', null, 'Clock: '),
        'The field accepts YYYY-MM-DD HH:MM:SS (UTC). Put the caret on a segment and press ↑/↓ to step ',
        'year/month/day/hour/min/sec — the whole app repropagates instantly. Rate buttons run time ',
        'forward/backward up to 1000×. “Real time” returns to now at 1×.']),
      U.el('p', { style: 'margin:4px 0' }, [U.el('b', null, 'Shortcuts: '),
        'Space = run/pause · N = jump to real time (when not typing in a field).']),
      U.el('div', { class: 'sep' }),
      U.el('p', { class: 'dim', style: 'margin:4px 0;font-size:11px' },
        'Base map: NASA Blue Marble Next Generation (topography + bathymetry, no political borders). ' +
        'Propagation: satellite.js (SGP4). Data: CelesTrak, Space-Track, Mike McCants. ' +
        'State is saved automatically to data/state.json next to server.py.'),
    ]));
  }

  function registerWindows() {
    const dt = document.getElementById('desktop');
    const W = dt.clientWidth, H = dt.clientHeight;
    const defs = [
      { id: 'map2d', title: '2D Map', x: 8, y: 8, w: Math.round(W * 0.56), h: Math.round(H * 0.58),
        minW: 420, minH: 260, open: true, build: (b, w) => { w.noScroll = true; SAT.map2d.init(b, w); } },
      { id: 'globe3d', title: '3D Globe', x: Math.round(W * 0.56) + 16, y: 8,
        w: Math.round(W * 0.44) - 24, h: Math.round(H * 0.50), minW: 320, minH: 240, open: true,
        build: (b, w) => { w.noScroll = true; SAT.globe3d.init(b, w); } },
      { id: 'clock', title: 'Master Clock', x: Math.round(W * 0.56) + 16, y: Math.round(H * 0.50) + 16,
        w: 330, h: 250, minW: 300, minH: 210, open: true, build: (b, w) => SAT.clock.buildUI(b, w) },
      { id: 'catalog', title: 'Satellites', x: 8, y: Math.round(H * 0.58) + 16,
        w: Math.round(W * 0.50), h: Math.round(H * 0.42) - 24, minW: 420, minH: 220, open: true,
        build: (b, w) => SAT.ui.catalog.init(b, w) },
      { id: 'sources', title: 'TLE Sources', x: Math.round(W * 0.47), y: Math.round(H * 0.62),
        w: Math.round(W * 0.36), h: 240, minW: 430, minH: 200, open: true,
        build: (b, w) => SAT.ui.sources.init(b, w) },
      { id: 'locations', title: 'Locations', x: Math.round(W * 0.30), y: Math.round(H * 0.25),
        w: 560, h: 260, minW: 480, minH: 200, open: false, build: (b, w) => SAT.ui.locations.init(b, w) },
      { id: 'passes', title: 'Passes', x: Math.round(W * 0.25), y: Math.round(H * 0.20),
        w: 720, h: 340, minW: 560, minH: 240, open: false, build: (b, w) => SAT.passes.init(b, w) },
      { id: 'skychart', title: 'Sky Chart', x: Math.round(W * 0.55), y: Math.round(H * 0.12),
        w: 440, h: 470, minW: 320, minH: 340, open: false,
        build: (b, w) => { w.noScroll = true; SAT.skychart.init(b, w); } },
      { id: 'help', title: 'Help', x: Math.round(W * 0.30), y: Math.round(H * 0.15),
        w: 600, h: 420, open: false, build: helpContent },
    ];
    defs.forEach(d => SAT.windows.register(d));

    // menu bar toggle buttons
    const mb = document.getElementById('mb-buttons');
    defs.forEach(d => {
      const btn = U.el('span', {
        class: 'mb-btn', 'data-win': d.id,
        onclick: () => SAT.windows.toggle(d.id),
      }, d.title);
      mb.appendChild(btn);
    });
    const refreshMb = () => {
      mb.querySelectorAll('.mb-btn').forEach(b => {
        const w = SAT.windows.get(b.dataset.win);
        b.classList.toggle('on', !!(w && w.isOpen()));
      });
    };
    SAT.bus.on('windows-changed', refreshMb);
    refreshMb();

    document.getElementById('mb-clock').addEventListener('click', () => {
      const w = SAT.windows.get('clock'); if (w) { w.open(); w.focus(); }
    });
  }

  function keyboard() {
    // release focus after any button click so the Space run/pause shortcut
    // keeps working (a focused button would otherwise swallow Space)
    window.addEventListener('click', e => {
      const b = e.target && e.target.closest && e.target.closest('button');
      if (b) b.blur();
    });
    window.addEventListener('keydown', e => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' ||
                t.tagName === 'BUTTON' || t.isContentEditable)) return;
      if (e.code === 'Space') { e.preventDefault(); SAT.clock.toggle(); }
      else if (e.key === 'n' || e.key === 'N') { SAT.clock.syncNow(); }
    });
  }

  async function boot() {
    await SAT.state.load();      // settings.layout needed before windows restore geometry
    registerWindows();
    SAT.clock.init();
    keyboard();
    SAT.bus.emit('state-loaded', {});  // panels built above render initial data
  }

  boot();
})();
