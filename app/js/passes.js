/* ============================================================================
 * passes.js — SAT.passes : pass predictor over the active ground station.
 *
 * Coarse-scans elevation (SAT.prop.lookAngles) at 30 s steps over the chosen
 * window, refines AOS/LOS crossings by bisection to <=1 s, finds TCA/max-el
 * by dense sampling + ternary refinement. Work is chunked into ~40 ms
 * setTimeout slices so the UI stays responsive. Results are manual-recompute
 * only and get flagged 'stale' when the clock jumps, the sat set changes, or
 * the active station changes.
 * ========================================================================== */
(function () {
  'use strict';

  var STYLE_ID = 'pas-style';

  var COMPASS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                   'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

  var COARSE_MS = 30000;   // coarse elevation scan step
  var TCA_MS    = 5000;    // dense TCA sampling step
  var REFINE_MS = 1000;    // target precision for AOS/LOS/TCA
  var SLICE_MS  = 38;      // work budget per setTimeout slice

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      '.pas-root{display:flex;flex-direction:column;gap:8px;padding:8px;box-sizing:border-box;font-size:12px;}',
      '.pas-controls{display:flex;flex-wrap:wrap;gap:6px;align-items:center;}',
      '.pas-lbl{color:#8a93a0;white-space:nowrap;}',
      '.pas-station{color:#e8eaed;white-space:nowrap;}',
      '.pas-station.pas-none{color:#ff5252;}',
      '.pas-status{color:#8a93a0;white-space:nowrap;font-variant-numeric:tabular-nums;margin-left:auto;}',
      '.pas-meta{color:#8a93a0;display:flex;flex-wrap:wrap;gap:6px;align-items:center;}',
      '.pas-stale{color:#101418;background:#ffb300;border-radius:3px;padding:0 6px;font-weight:600;}',
      '.pas-hint{color:#6b7480;font-size:11px;}',
      '.pas-msg{color:#8a93a0;padding:14px 4px;}',
      '.pas-table-wrap{overflow:auto;}',
      '.pas-row{cursor:pointer;}',
      '.pas-row:hover{background:rgba(79,195,247,0.12);}',
      '.pas-th-sort{cursor:pointer;user-select:none;white-space:nowrap;}',
      '.pas-num{font-variant-numeric:tabular-nums;white-space:nowrap;}',
      '.pas-el-hi{font-weight:700;}'
    ].join('\n');
    document.head.appendChild(st);
  }

  function compass(azDeg) {
    var a = ((azDeg % 360) + 360) % 360;
    return COMPASS16[Math.round(a / 22.5) % 16];
  }

  function fmtAz(azDeg) {
    var a = ((azDeg % 360) + 360) % 360;
    return String(Math.round(a)).padStart(3, '0') + '° ' + compass(a);
  }

  function fmtDur(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  /* ------------------------------------------------------------------ */

  function init(bodyEl, win) {
    injectStyle();
    var U = SAT.util;
    var el = U.el;

    /* ---- module state ------------------------------------------------ */
    var results = null;    // committed [{sat,aos,aosAzDeg,tca,maxElDeg,los,losAzDeg,...}]
    var meta = null;       // what the results were computed for (station/window snapshot)
    var stale = false;
    var armStale = false;  // set stale on first jumped 'time' event after a compute
    var suppressStaleOnce = false; // row-click jump must not stale its own results
    var sortKey = 'aos';
    var sortAsc = true;
    var job = null;        // running compute job, or null
    var staleTag = null;

    function passSettings() {
      var s = SAT.state.settings || (SAT.state.settings = {});
      if (!s.passes) s.passes = { hours: 24, minElevationDeg: 10 };
      return s.passes;
    }

    /* ---- controls ---------------------------------------------------- */
    var scopeSel = el('select', { class: 'select' });
    [['selected', 'Selected satellite'], ['all', 'All imported']].forEach(function (o) {
      var opt = el('option', {}, o[1]);
      opt.value = o[0];
      scopeSel.appendChild(opt);
    });
    scopeSel.value = 'all';

    var durSel = el('select', { class: 'select' });
    [12, 24, 48].forEach(function (h) {
      var opt = el('option', {}, h + ' h');
      opt.value = String(h);
      durSel.appendChild(opt);
    });

    var minElInput = el('input', { class: 'input' });
    minElInput.type = 'number';
    minElInput.min = '0';
    minElInput.max = '90';
    minElInput.step = '1';
    minElInput.style.width = '54px';

    // optical-visibility filter: keep only passes that are ● visible
    // (site sun below the horizon past civil dusk AND satellite sunlit at TCA)
    var visSel = el('select', {
      class: 'select',
      title: 'Visible only: site in darkness (sun < −6°, i.e. after sunset ends) and satellite sunlit',
    });
    [['all', 'All passes'], ['visible', '● Visible only']].forEach(function (o) {
      var opt = el('option', {}, o[1]);
      opt.value = o[0];
      visSel.appendChild(opt);
    });

    var stationEl = el('span', { class: 'pas-station' }, '');
    var statusEl = el('span', { class: 'pas-status' }, '');
    var computeBtn = el('button', { class: 'btn small', onclick: onComputeClick }, 'Compute');

    var skyBtn = el('button', {
      class: 'btn small', title: 'open the polar sky chart',
      onclick: function () {
        var w = SAT.windows.get('skychart');
        if (w) { w.open(); w.focus(); }
      }
    }, 'Sky chart');
    var controls = el('div', { class: 'pas-controls' }, [
      scopeSel, durSel,
      el('span', { class: 'pas-lbl' }, 'min el ≥'), minElInput,
      el('span', { class: 'pas-lbl' }, '°'),
      visSel,
      el('span', { class: 'pas-lbl' }, 'station:'), stationEl,
      computeBtn, skyBtn, statusEl
    ]);

    var resultsEl = el('div', { class: 'pas-results' });
    var root = el('div', { class: 'pas-root' }, [controls, resultsEl]);
    bodyEl.appendChild(root);

    function syncControlsFromSettings() {
      var ps = passSettings();
      durSel.value = ([12, 24, 48].indexOf(ps.hours) >= 0) ? String(ps.hours) : '24';
      var me = Number(ps.minElevationDeg);
      minElInput.value = String(isFinite(me) ? me : 10);
      visSel.value = ps.visibleOnly ? 'visible' : 'all';
    }
    syncControlsFromSettings();

    durSel.onchange = function () {
      passSettings().hours = parseInt(durSel.value, 10);
      SAT.state.save();
    };
    visSel.onchange = function () {
      passSettings().visibleOnly = visSel.value === 'visible';
      SAT.state.save();
    };
    minElInput.onchange = function () {
      var v = U.clamp(parseFloat(minElInput.value) || 0, 0, 90);
      minElInput.value = String(v);
      passSettings().minElevationDeg = v;
      SAT.state.save();
    };

    function updateStationLabel() {
      var loc = SAT.state.activeLocation();
      if (loc) {
        stationEl.textContent = loc.name;
        stationEl.classList.remove('pas-none');
        stationEl.title = loc.latDeg.toFixed(3) + '°, ' + loc.lonDeg.toFixed(3) +
                          '°, ' + Math.round(loc.altM) + ' m';
      } else {
        stationEl.textContent = '(no active station)';
        stationEl.classList.add('pas-none');
        stationEl.title = '';
      }
    }
    updateStationLabel();

    /* ---- bus wiring --------------------------------------------------- */
    SAT.bus.on('time', function (p) {
      if (armStale && p && p.jumped) {
        if (suppressStaleOnce) { suppressStaleOnce = false; return; }
        armStale = false; setStale();
      }
    });
    SAT.bus.on('sats-changed', function () {
      if (job) job.satsDirty = true;
      else if (results) setStale();
    });
    SAT.bus.on('locations-changed', function () {
      updateStationLabel();
      if (results && meta && activeLocDiffers(meta)) setStale();
    });
    SAT.bus.on('state-loaded', function () {
      syncControlsFromSettings();
      updateStationLabel();
    });

    function activeLocDiffers(snap) {
      var loc = SAT.state.activeLocation();
      return !loc || loc.id !== snap.stationId || loc.latDeg !== snap.latDeg ||
             loc.lonDeg !== snap.lonDeg || loc.altM !== snap.altM;
    }

    function setStale() {
      stale = true;
      if (staleTag) staleTag.style.display = '';
    }

    /* ---- elevation sampling (null-safe: SGP4 may fail at some epochs) - */
    function elevAt(loc, sat, tMs) {
      try {
        var la = SAT.prop.lookAngles(loc, sat, new Date(tMs));
        return la ? la.elDeg : null;
      } catch (e) { return null; }
    }

    function azAt(loc, sat, tMs) {
      try {
        var la = SAT.prop.lookAngles(loc, sat, new Date(tMs));
        return la ? la.azDeg : null;
      } catch (e) { return null; }
    }

    /* Bisect the horizon crossing bracketed by [a,b] down to <=1 s.
     * rising: el(a)<=0 < el(b);  falling: el(a)>0 >= el(b).
     * Returns the boundary on the above-horizon side. */
    function refineCrossing(loc, sat, a, b, rising) {
      for (var i = 0; i < 48 && (b - a) > REFINE_MS; i++) {
        var m = (a + b) / 2;
        var e = elevAt(loc, sat, m);
        if (e === null) break; // cannot decide; bracket is already narrow
        if (e > 0) { if (rising) b = m; else a = m; }
        else       { if (rising) a = m; else b = m; }
      }
      return Math.round(rising ? b : a);
    }

    /* ---- compute job -------------------------------------------------- */
    function onComputeClick() {
      if (job) { cancelJob('Cancelled'); return; }

      var loc = SAT.state.activeLocation();
      if (!loc) { renderMessage('Set an active ground station in the Locations window'); return; }

      var sats;
      if (scopeSel.value === 'selected') {
        var id = SAT.state.selection ? SAT.state.selection.satId : null;
        var s = id ? SAT.state.getSat(id) : null;
        if (!s) { renderMessage('Select a satellite first (or choose "All imported").'); return; }
        if (!SAT.prop.ensureSatrec(s)) { renderMessage('Selected satellite has an invalid TLE.'); return; }
        sats = [s];
      } else {
        sats = SAT.state.allActiveSats();
        if (!sats.length) { renderMessage('Import satellites first'); return; }
      }

      var t0 = SAT.clock.getDate().getTime();
      var hours = parseInt(durSel.value, 10) || 24;
      var minEl = U.clamp(parseFloat(minElInput.value) || 0, 0, 90);

      job = {
        cancelled: false,
        satsDirty: false,
        // frozen station snapshot: lookAngles only needs lat/lon/alt, and the
        // snapshot lets us detect in-place edits of the live location object
        loc: { id: loc.id, name: loc.name, latDeg: loc.latDeg, lonDeg: loc.lonDeg, altM: loc.altM },
        sats: sats,
        t0: t0,
        t1: t0 + hours * 3600e3,
        minEl: minEl,
        visOnly: visSel.value === 'visible',
        scopeLabel: scopeSel.value === 'selected' ? sats[0].name : sats.length + ' sats',
        satIdx: 0,
        cursor: t0,
        prev: null,          // last valid {t, el} sample for the current sat
        inPass: false,
        aosT: 0,
        ongoingStart: false,
        found: [],
        timer: 0
      };
      computeBtn.textContent = 'Cancel';
      statusEl.textContent = '';
      slice();
    }

    function cancelJob(msg) {
      if (!job) return;
      job.cancelled = true;
      if (job.timer) clearTimeout(job.timer);
      job = null;
      computeBtn.textContent = 'Compute';
      statusEl.textContent = msg || '';
    }

    function slice() {
      if (!job || job.cancelled) return;
      job.timer = 0;
      var deadline = performance.now() + SLICE_MS;
      while (performance.now() < deadline) {
        if (job.satIdx >= job.sats.length) { finishJob(); return; }
        stepSat();
      }
      updateProgress();
      job.timer = setTimeout(slice, 0);
    }

    /* One 30 s coarse step for the current sat (includes any inline
     * refinement triggered by a detected crossing). */
    function stepSat() {
      var sat = job.sats[job.satIdx];
      var t = Math.min(job.cursor, job.t1);
      var last = (t >= job.t1);
      var e = elevAt(job.loc, sat, t);

      if (e !== null) {
        if (!job.inPass) {
          if (e > 0) {
            if (job.prev && job.prev.el <= 0) {
              job.aosT = refineCrossing(job.loc, sat, job.prev.t, t, true);
              job.ongoingStart = false;
            } else {
              // already above horizon at first valid sample
              job.aosT = t;
              job.ongoingStart = (t <= job.t0);
            }
            job.inPass = true;
          }
        } else if (e <= 0) {
          var losT = (job.prev && job.prev.el > 0)
            ? refineCrossing(job.loc, sat, job.prev.t, t, false)
            : t;
          finishPass(sat, losT, false);
        }
        job.prev = { t: t, el: e };
      }

      if (last) {
        if (job.inPass) finishPass(sat, job.t1, true); // still up at window end
        nextSat();
      } else {
        job.cursor += COARSE_MS;
      }
    }

    function nextSat() {
      job.satIdx++;
      job.cursor = job.t0;
      job.prev = null;
      job.inPass = false;
      job.ongoingStart = false;
      job.aosT = 0;
    }

    /* Close out the pass [job.aosT, losT]: find TCA/max-el, filter, record. */
    function finishPass(sat, losT, ongoingEnd) {
      var loc = job.loc;
      var aosT = job.aosT;
      job.inPass = false;
      var wasOngoingStart = job.ongoingStart;
      job.ongoingStart = false;

      if (losT <= aosT) return;

      // Dense scan for the peak. 5 s steps normally; for very long passes
      // (e.g. GEO up for the whole window) cap at ~720 samples, then re-scan
      // around the best sample at 5 s before the 1 s ternary refinement.
      var step = Math.max(TCA_MS, (losT - aosT) / 720);
      var scan = function (a, b, st) {
        for (var t = a; t <= b; t += st) {
          var e = elevAt(loc, sat, t);
          if (e !== null && e > bestEl) { bestEl = e; bestT = t; }
        }
      };
      var bestT = aosT, bestEl = -90;
      scan(aosT, losT, step);
      var eLos = elevAt(loc, sat, losT);
      if (eLos !== null && eLos > bestEl) { bestEl = eLos; bestT = losT; }
      if (step > TCA_MS) {
        scan(Math.max(aosT, bestT - step), Math.min(losT, bestT + step), TCA_MS);
      }

      // Ternary refinement of the (locally unimodal) peak to ~1 s.
      var a = Math.max(aosT, bestT - TCA_MS);
      var b = Math.min(losT, bestT + TCA_MS);
      for (var i = 0; i < 40 && (b - a) > REFINE_MS; i++) {
        var m1 = a + (b - a) / 3;
        var m2 = b - (b - a) / 3;
        var e1 = elevAt(loc, sat, m1); if (e1 === null) e1 = -90;
        var e2 = elevAt(loc, sat, m2); if (e2 === null) e2 = -90;
        if (e1 >= e2) b = m2; else a = m1;
      }
      var tcaT = Math.round((a + b) / 2);
      var eTca = elevAt(loc, sat, tcaT);
      var maxEl = Math.max(bestEl, eTca === null ? -90 : eTca);

      if (maxEl < job.minEl) return;

      var aosAz = azAt(loc, sat, aosT);
      if (aosAz === null) aosAz = azAt(loc, sat, aosT + 1000);
      var losAz = azAt(loc, sat, losT);
      if (losAz === null) losAz = azAt(loc, sat, losT - 1000);

      // Optical visibility at TCA: satellite sunlit + observer in darkness
      var visState = null;
      try {
        var tcaDate = new Date(tcaT);
        var gd = SAT.prop.geodetic(sat, tcaDate);
        if (gd && gd.eciPos) {
          var sunlit = SAT.util.satSunlit(gd.eciPos, tcaDate);
          var sunAlt = SAT.util.sunAltitudeDeg(loc.latDeg, loc.lonDeg, tcaDate);
          visState = !sunlit ? 'eclipsed' : (sunAlt < -6 ? 'visible' : 'daylight');
        }
      } catch (e) { visState = null; }

      // visible-only filter: dark site + sunlit satellite at TCA
      if (job.visOnly && visState !== 'visible') return;

      job.found.push({
        sat: sat,
        aos: new Date(aosT),
        aosAzDeg: aosAz === null ? 0 : aosAz,
        tca: new Date(tcaT),
        maxElDeg: maxEl,
        los: new Date(losT),
        losAzDeg: losAz === null ? 0 : losAz,
        ongoingStart: wasOngoingStart,
        ongoingEnd: !!ongoingEnd,
        visState: visState
      });
    }

    function updateProgress() {
      var n = job.sats.length;
      var i = Math.min(job.satIdx, n - 1);
      var frac = U.clamp((job.cursor - job.t0) / (job.t1 - job.t0), 0, 1);
      var pct = Math.round(((job.satIdx + frac) / n) * 100);
      statusEl.textContent = job.sats[i].name + ' ' + Math.min(job.satIdx + 1, n) +
                             '/' + n + ' · ' + Math.min(pct, 100) + '%';
    }

    function finishJob() {
      var j = job;
      job = null;
      computeBtn.textContent = 'Compute';

      results = j.found;
      meta = {
        stationId: j.loc.id, stationName: j.loc.name,
        latDeg: j.loc.latDeg, lonDeg: j.loc.lonDeg, altM: j.loc.altM,
        t0: j.t0, t1: j.t1, minEl: j.minEl, visOnly: j.visOnly, scopeLabel: j.scopeLabel
      };
      sortKey = 'aos';
      sortAsc = true;
      stale = j.satsDirty || activeLocDiffers(meta);
      armStale = true;

      statusEl.textContent = results.length + (results.length === 1 ? ' pass' : ' passes');
      renderResults();
    }

    /* ---- rendering ---------------------------------------------------- */
    function renderMessage(msg) {
      resultsEl.innerHTML = '';
      resultsEl.appendChild(el('div', { class: 'pas-msg' }, msg));
    }

    function fmtTime(d) { return U.fmtDate(d).slice(11); }

    function setSort(key) {
      if (sortKey === key) sortAsc = !sortAsc;
      else { sortKey = key; sortAsc = (key === 'aos'); }
      renderResults();
    }

    function sortCmp(a, b) {
      var d = (sortKey === 'maxEl') ? (a.maxElDeg - b.maxElDeg) : (a.aos - b.aos);
      if (d === 0) d = a.aos - b.aos;
      return sortAsc ? d : -d;
    }

    function jumpTo(r) {
      // Jump the whole app to just before the pass — and make sure time then
      // actually flows into it (running, forward). The jump itself must not
      // flag our own results stale.
      suppressStaleOnce = true;
      SAT.clock.setDate(new Date(r.aos.getTime() - 60000));
      if (SAT.clock.getRate() <= 0) SAT.clock.setRate(1);
      SAT.clock.setRunning(true);
      SAT.state.setSelection(r.sat.id);
    }

    function renderResults() {
      resultsEl.innerHTML = '';
      if (!results) {
        resultsEl.appendChild(el('div', { class: 'pas-msg' },
          'Choose a scope and press Compute to predict passes.'));
        return;
      }

      staleTag = el('span', { class: 'pas-stale' }, 'stale — recompute');
      staleTag.style.display = stale ? '' : 'none';
      var metaLine = el('div', { class: 'pas-meta' }, [
        'Station ' + meta.stationName +
          ' (' + meta.latDeg.toFixed(2) + '°, ' + meta.lonDeg.toFixed(2) + '°)',
        '· ' + U.fmtDate(new Date(meta.t0)) + ' → ' + U.fmtDate(new Date(meta.t1)) + ' UTC',
        '· min max-el ' + meta.minEl + '°',
        meta.visOnly ? '· ● visible only' : '',
        '· ' + meta.scopeLabel,
        staleTag
      ]);
      resultsEl.appendChild(metaLine);

      if (!results.length) {
        resultsEl.appendChild(el('div', { class: 'pas-msg' },
          meta.visOnly
            ? 'No optically visible passes (dark site + sunlit satellite, max el ≥ ' + meta.minEl + '°) in this window.'
            : 'No passes with max elevation ≥ ' + meta.minEl + '° in this window.'));
        return;
      }

      resultsEl.appendChild(el('div', { class: 'pas-hint' },
        'Click a pass to jump the clock to 60 s before AOS and select the satellite. ' +
        '↷ = already in progress at window start.'));

      var arrow = function (key) {
        return sortKey === key ? (sortAsc ? ' ▲' : ' ▼') : '';
      };
      var thead = el('thead', {}, el('tr', {}, [
        el('th', {}, 'Satellite'),
        el('th', { class: 'pas-th-sort', title: 'Sort by AOS',
                   onclick: function () { setSort('aos'); } }, 'AOS (UTC)' + arrow('aos')),
        el('th', {}, 'Az↑'),
        el('th', {}, 'TCA'),
        el('th', { class: 'pas-th-sort', title: 'Sort by max elevation',
                   onclick: function () { setSort('maxEl'); } }, 'Max El' + arrow('maxEl')),
        el('th', {}, 'LOS'),
        el('th', {}, 'Az↓'),
        el('th', {}, 'Dur'),
        el('th', { title: 'Optical visibility at TCA: ● sat sunlit + dark site · ☼ sat sunlit but daylight/twilight · ✕ sat in Earth’s shadow' }, 'Vis')
      ]));

      var rows = results.slice().sort(sortCmp).map(function (r) {
        var elCell = el('td', { class: 'pas-num' }, r.maxElDeg.toFixed(1) + '°');
        if (r.maxElDeg > 45) elCell.classList.add('pas-el-hi');
        var visCell;
        if (r.visState === 'visible') {
          visCell = el('td', { title: 'optically visible: satellite sunlit, site dark',
                               style: 'color:#7ad97a;font-weight:700' }, '●');
        } else if (r.visState === 'daylight') {
          visCell = el('td', { title: 'satellite sunlit but the sky is bright (radio/day pass)',
                               style: 'color:#8a93a0' }, '☼');
        } else if (r.visState === 'eclipsed') {
          visCell = el('td', { title: 'satellite in Earth’s shadow at TCA',
                               style: 'color:#8a93a0' }, '✕');
        } else {
          visCell = el('td', {}, '—');
        }
        return el('tr', {
          class: 'pas-row',
          title: 'Jump clock to 60 s before AOS',
          onclick: function () { jumpTo(r); }
        }, [
          el('td', {}, r.sat.name),
          el('td', { class: 'pas-num' }, (r.ongoingStart ? '↷ ' : '') + U.fmtDate(r.aos)),
          el('td', { class: 'pas-num' }, fmtAz(r.aosAzDeg)),
          el('td', { class: 'pas-num' }, fmtTime(r.tca)),
          elCell,
          el('td', { class: 'pas-num' }, fmtTime(r.los) + (r.ongoingEnd ? ' →' : '')),
          el('td', { class: 'pas-num' }, fmtAz(r.losAzDeg)),
          el('td', { class: 'pas-num' }, fmtDur(r.los - r.aos)),
          visCell
        ]);
      });

      var table = el('table', { class: 'table' }, [thead, el('tbody', {}, rows)]);
      resultsEl.appendChild(el('div', { class: 'pas-table-wrap' }, table));
    }

    renderResults(); // initial empty state
  }

  SAT.passes = { init: init };
})();
