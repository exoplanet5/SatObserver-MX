/* ============================================================================
 * map2d.js — SAT.map2d : 2D equirectangular world map (primary view)
 *
 * Plain classic script; attaches SAT.map2d = { init, requestRender }.
 * Projection: plate carrée. View state {scale, cx, cy} where cx/cy are the
 * map-fraction coordinates of the viewport center; scale 1 = fit-to-window
 * (whole world visible, letterboxed) up to 40x.
 * ==========================================================================*/
(function () {
  'use strict';

  var MAX_ZOOM = 40;
  var IMG_SRC = 'assets/earth_day.jpg';
  var MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

  // ---- module state --------------------------------------------------------
  var body = null, winRef = null;
  var canvas = null, ctx = null;
  var cssW = 0, cssH = 0, dpr = 1;
  var view = { scale: 1, cx: 0.5, cy: 0.5 };
  var baseImg = null, baseReady = false;
  var dirty = false, rafQueued = false;
  var markerHits = [];                 // [{id,x,y}] sat marker px positions from last render
  var nightCache = { key: NaN, poly: null, sun: null, poleLat: -90 };
  var drag = null;
  var renderErrWarned = false;

  // HUD elements
  var elCursor = null, elSel = null, elEpoch = null, elToolbar = null;
  var tbtnNight = null, tbtnGrid = null, tbtnSunMoon = null;

  // ---- small helpers -------------------------------------------------------

  function settings() {
    var s = SAT.state && SAT.state.settings && SAT.state.settings.map2d;
    return s || { showTerminator: true, showGraticule: true, showSun: true,
                  showMoon: true, showNightShade: true, trackMinutesBack: 0,
                  trackMinutesFwd: 0, labelSize: 11 };
  }

  // hex color -> rgba() string with given alpha (accepts #rgb / #rrggbb)
  function hexA(hex, a) {
    var h = (hex || '#4fc3f7').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (!isFinite(n)) n = 0x4fc3f7;
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function fmtLat(v) { return Math.abs(v).toFixed(2) + '°' + (v < 0 ? 'S' : 'N'); }
  function fmtLon(v) { return Math.abs(v).toFixed(2) + '°' + (v < 0 ? 'W' : 'E'); }

  function safeGeo(sat, date) {
    try { return SAT.prop.geodetic(sat, date); } catch (e) { return null; }
  }

  // ---- projection ----------------------------------------------------------

  // Current drawn-map rectangle in CSS px: {w, h, left, top}
  function metrics() {
    var fitW = Math.max(1, Math.min(cssW, cssH * 2));
    var w = fitW * view.scale, h = w / 2;
    return { w: w, h: h, left: cssW / 2 - view.cx * w, top: cssH / 2 - view.cy * h };
  }

  // lon may be exactly +180 (right map edge) — deliberately NOT wrapped here.
  function lonLatToPx(lonDeg, latDeg, m) {
    return { x: m.left + (lonDeg + 180) / 360 * m.w,
             y: m.top + (90 - latDeg) / 180 * m.h };
  }

  function pxToLonLat(x, y, m) {
    var fx = (x - m.left) / m.w, fy = (y - m.top) / m.h;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
    return { lonDeg: SAT.util.wrapLon(fx * 360 - 180), latDeg: 90 - fy * 180 };
  }

  // Empty margin on any side must never exceed 20% of the viewport dimension.
  function clampAxis(c, mapDim, viewDim) {
    var lo = 0.3 * viewDim / mapDim, hi = 1 - lo;
    return lo > hi ? 0.5 : Math.min(hi, Math.max(lo, c));
  }

  function clampView() {
    view.scale = Math.min(MAX_ZOOM, Math.max(1, view.scale));
    var m = metrics();
    view.cx = clampAxis(view.cx, m.w, cssW);
    view.cy = clampAxis(view.cy, m.h, cssH);
  }

  // Zoom keeping the map point under (mx,my) fixed on screen.
  function zoomAt(mx, my, factor) {
    var m0 = metrics();
    view.scale = Math.min(MAX_ZOOM, Math.max(1, view.scale * factor));
    var fitW = Math.max(1, Math.min(cssW, cssH * 2));
    var w1 = fitW * view.scale, h1 = w1 / 2;
    var fx = view.cx + (mx - cssW / 2) / m0.w;
    var fy = view.cy + (my - cssH / 2) / m0.h;
    view.cx = fx - (mx - cssW / 2) / w1;
    view.cy = fy - (my - cssH / 2) / h1;
    clampView();
    requestRender();
  }

  function resetView() {
    view.scale = 1; view.cx = 0.5; view.cy = 0.5;
    requestRender();
  }

  // ---- render scheduling ---------------------------------------------------

  function requestRender() {
    dirty = true;
    if (rafQueued) return;
    rafQueued = true;
    requestAnimationFrame(function () {
      rafQueued = false;
      if (!dirty) return;
      // window closed: skip all work (reopening fires 'win-resize' -> render)
      if (winRef && !winRef.isOpen()) return;
      dirty = false;
      try {
        render();
      } catch (e) {
        if (!renderErrWarned) { renderErrWarned = true; console.warn('map2d render error:', e); }
      }
    });
  }

  // ---- night shading (cached per 30 simulated seconds) ---------------------

  function getNight(date) {
    var key = Math.floor(date.getTime() / 30000);
    if (nightCache.key !== key) {
      var poly = null, sun = null;
      try {
        sun = SAT.util.sunSubpoint(date);
        poly = SAT.util.nightPolygon(date, 180);
      } catch (e) { poly = null; }
      // The fully-dark polar cap is at the pole opposite the sun's declination.
      nightCache = { key: key, poly: poly, sun: sun,
                     poleLat: (sun && sun.latDeg < 0) ? 90 : -90 };
    }
    return nightCache;
  }

  function drawNight(m, date, st) {
    var nc = getNight(date);
    if (!nc.poly || nc.poly.length < 2) return;
    var P = nc.poly, i, p;
    var first = P[0], last = P[P.length - 1];

    if (st.showNightShade) {
      ctx.beginPath();
      p = lonLatToPx(-180, first.latDeg, m); ctx.moveTo(p.x, p.y);
      for (i = 0; i < P.length; i++) {
        p = lonLatToPx(P[i].lonDeg, P[i].latDeg, m); ctx.lineTo(p.x, p.y);
      }
      p = lonLatToPx(180, last.latDeg, m); ctx.lineTo(p.x, p.y);
      p = lonLatToPx(180, nc.poleLat, m); ctx.lineTo(p.x, p.y);
      p = lonLatToPx(-180, nc.poleLat, m); ctx.lineTo(p.x, p.y);
      ctx.closePath();
      ctx.fillStyle = 'rgba(0,0,10,0.35)';
      ctx.fill();
    }

    if (st.showTerminator) {
      ctx.beginPath();
      p = lonLatToPx(-180, first.latDeg, m); ctx.moveTo(p.x, p.y);
      for (i = 0; i < P.length; i++) {
        p = lonLatToPx(P[i].lonDeg, P[i].latDeg, m); ctx.lineTo(p.x, p.y);
      }
      p = lonLatToPx(180, last.latDeg, m); ctx.lineTo(p.x, p.y);
      ctx.strokeStyle = 'rgba(255,205,110,0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // ---- graticule -----------------------------------------------------------

  function lonLabel(lon) {
    if (lon === 0) return '0°';
    if (lon === 180 || lon === -180) return '180°';
    return Math.abs(lon) + '°' + (lon < 0 ? 'W' : 'E');
  }
  function latLabel(lat) {
    if (lat === 0) return '0°';
    return Math.abs(lat) + '°' + (lat < 0 ? 'S' : 'N');
  }

  function haloText(text, x, y, fill) {
    ctx.strokeStyle = 'rgba(5,8,12,0.8)';
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
  }

  function drawGraticule(m) {
    // Visible portion of the map, in CSS px
    var vx0 = Math.max(m.left, 0), vx1 = Math.min(m.left + m.w, cssW);
    var vy0 = Math.max(m.top, 0), vy1 = Math.min(m.top + m.h, cssH);
    if (vx1 <= vx0 || vy1 <= vy0) return;
    var lon, lat, p;

    ctx.lineWidth = 1;
    for (lon = -180; lon <= 180; lon += 30) {
      p = lonLatToPx(lon, 0, m);
      if (p.x < vx0 - 1 || p.x > vx1 + 1) continue;
      ctx.strokeStyle = lon === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.10)';
      ctx.beginPath();
      ctx.moveTo(p.x, m.top);
      ctx.lineTo(p.x, m.top + m.h);
      ctx.stroke();
    }
    for (lat = -90; lat <= 90; lat += 30) {
      p = lonLatToPx(0, lat, m);
      if (p.y < vy0 - 1 || p.y > vy1 + 1) continue;
      ctx.strokeStyle = lat === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.10)';
      ctx.beginPath();
      ctx.moveTo(m.left, p.y);
      ctx.lineTo(m.left + m.w, p.y);
      ctx.stroke();
    }

    // Labels along the visible map edges
    ctx.font = '10px ' + MONO;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    for (lon = -180; lon <= 150; lon += 30) {
      p = lonLatToPx(lon, 0, m);
      if (p.x < vx0 + 2 || p.x > vx1 - 28) continue;
      haloText(lonLabel(lon), p.x + 3, vy1 - 4, 'rgba(255,255,255,0.55)');
    }
    for (lat = -60; lat <= 60; lat += 30) {
      p = lonLatToPx(0, lat, m);
      if (p.y < vy0 + 12 || p.y > vy1 - 4) continue;
      haloText(latLabel(lat), vx0 + 4, p.y - 3, 'rgba(255,255,255,0.55)');
    }
  }

  // ---- satellite layers ----------------------------------------------------

  // Footprint circle. Points from SAT.prop.footprint are NOT antimeridian-split.
  function drawFootprint(m, geo, color, selected) {
    var pts;
    try { pts = SAT.prop.footprint(geo.latDeg, geo.lonDeg, geo.heightKm, 90); }
    catch (e) { return; }
    if (!pts || pts.length < 3) return;

    var h = Math.max(geo.heightKm, 0.1);
    var rDeg = Math.acos(Math.min(1, SAT.prop.Re / (SAT.prop.Re + h))) * 180 / Math.PI;
    var encN = rDeg > (90 - geo.latDeg);
    var encS = rDeg > (90 + geo.latDeg);

    ctx.fillStyle = hexA(color, 0.08);
    ctx.strokeStyle = hexA(color, selected ? 0.85 : 0.4);
    ctx.lineWidth = selected ? 1.6 : 1;
    ctx.lineJoin = 'round';

    var i, p;
    if (encN || encS) {
      // Circle encloses a pole: every meridian crosses the boundary exactly once,
      // so sort by longitude and close the fill along the polar map edge.
      var poleLat = encN ? 90 : -90;
      var sorted = pts.slice().sort(function (a, b) { return a.lonDeg - b.lonDeg; });
      var first = sorted[0], last = sorted[sorted.length - 1];

      ctx.beginPath();
      p = lonLatToPx(-180, first.latDeg, m); ctx.moveTo(p.x, p.y);
      for (i = 0; i < sorted.length; i++) {
        p = lonLatToPx(sorted[i].lonDeg, sorted[i].latDeg, m); ctx.lineTo(p.x, p.y);
      }
      p = lonLatToPx(180, last.latDeg, m); ctx.lineTo(p.x, p.y);
      p = lonLatToPx(180, poleLat, m); ctx.lineTo(p.x, p.y);
      p = lonLatToPx(-180, poleLat, m); ctx.lineTo(p.x, p.y);
      ctx.closePath();
      ctx.fill();

      // Outline: boundary only (no line along the map edge)
      ctx.beginPath();
      p = lonLatToPx(-180, first.latDeg, m); ctx.moveTo(p.x, p.y);
      for (i = 0; i < sorted.length; i++) {
        p = lonLatToPx(sorted[i].lonDeg, sorted[i].latDeg, m); ctx.lineTo(p.x, p.y);
      }
      p = lonLatToPx(180, last.latDeg, m); ctx.lineTo(p.x, p.y);
      ctx.stroke();
    } else {
      // Unwrap longitudes into a continuous closed path; draw shifted copies
      // (±360°) so parts crossing the antimeridian appear on the other edge.
      var path = new Path2D();
      var lonPrev = pts[0].lonDeg, minL = lonPrev, maxL = lonPrev;
      p = lonLatToPx(lonPrev, pts[0].latDeg, m);
      path.moveTo(p.x, p.y);
      for (i = 1; i < pts.length; i++) {
        var l = pts[i].lonDeg;
        while (l - lonPrev > 180) l -= 360;
        while (l - lonPrev < -180) l += 360;
        lonPrev = l;
        if (l < minL) minL = l;
        if (l > maxL) maxL = l;
        p = lonLatToPx(l, pts[i].latDeg, m);
        path.lineTo(p.x, p.y);
      }
      path.closePath();

      var offsets = [0];
      if (maxL > 180) offsets.push(-m.w);
      if (minL < -180) offsets.push(m.w);
      for (i = 0; i < offsets.length; i++) {
        ctx.save();
        ctx.translate(offsets[i], 0);
        ctx.fill(path);
        ctx.stroke(path);
        ctx.restore();
      }
    }
  }

  // Ground track: null entries mark antimeridian splits (start new segment).
  // Past half dim/thin, future half brighter/thicker, split at current time.
  function drawTrack(m, sat, date, nowMs, st) {
    var gt;
    try {
      gt = SAT.prop.groundTrack(sat, date, st.trackMinutesBack || 0, st.trackMinutesFwd || 0);
    } catch (e) { return; }
    if (!gt || !gt.points || gt.points.length < 2) return;

    var past = new Path2D(), fut = new Path2D();
    function seg(path, aLon, aLat, bLon, bLat) {
      var pa = lonLatToPx(aLon, aLat, m), pb = lonLatToPx(bLon, bLat, m);
      path.moveTo(pa.x, pa.y);
      path.lineTo(pb.x, pb.y);
    }

    var prev = null, i, p;
    for (i = 0; i < gt.points.length; i++) {
      p = gt.points[i];
      if (!p) { prev = null; continue; }
      if (prev) {
        if (p.t <= nowMs) {
          seg(past, prev.lonDeg, prev.latDeg, p.lonDeg, p.latDeg);
        } else if (prev.t >= nowMs) {
          seg(fut, prev.lonDeg, prev.latDeg, p.lonDeg, p.latDeg);
        } else {
          // Segment spans "now": split at the interpolated current position.
          var f = (nowMs - prev.t) / (p.t - prev.t);
          var mLon = prev.lonDeg + (p.lonDeg - prev.lonDeg) * f;
          var mLat = prev.latDeg + (p.latDeg - prev.latDeg) * f;
          seg(past, prev.lonDeg, prev.latDeg, mLon, mLat);
          seg(fut, mLon, mLat, p.lonDeg, p.latDeg);
        }
      }
      prev = p;
    }

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = sat.color || '#4fc3f7';
    ctx.globalAlpha = 0.45; ctx.lineWidth = 1; ctx.stroke(past);
    ctx.globalAlpha = 0.9; ctx.lineWidth = 1.6; ctx.stroke(fut);
    ctx.globalAlpha = 1;
  }

  function drawSatLabel(text, x, y, sizePx) {
    ctx.font = sizePx + 'px ' + MONO;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = 'rgba(5,8,12,0.85)';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, x, y);
  }

  function drawSatMarker(m, sat, geo, selected, st) {
    var p = lonLatToPx(SAT.util.wrapLon(geo.lonDeg), geo.latDeg, m);
    // 7px filled square, 1px dark outline
    ctx.fillStyle = sat.color || '#4fc3f7';
    ctx.strokeStyle = 'rgba(8,10,14,0.9)';
    ctx.lineWidth = 1;
    ctx.fillRect(p.x - 3.5, p.y - 3.5, 7, 7);
    ctx.strokeRect(p.x - 3.5, p.y - 3.5, 7, 7);

    if (selected) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (!sat.show || sat.show.label) {
      drawSatLabel(sat.name || '', p.x + 8, p.y, st.labelSize || 11);
    }
    markerHits.push({ id: sat.id, x: p.x, y: p.y });
  }

  // ---- stations / sun / moon -----------------------------------------------

  function drawStations(m, st) {
    var locs = (SAT.state && SAT.state.locations) || [];
    for (var i = 0; i < locs.length; i++) {
      var loc = locs[i];
      if (!loc || !loc.show) continue;
      var p = lonLatToPx(SAT.util.wrapLon(loc.lonDeg), loc.latDeg, m);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - 5.5);
      ctx.lineTo(p.x - 5, p.y + 4);
      ctx.lineTo(p.x + 5, p.y + 4);
      ctx.closePath();
      ctx.fillStyle = loc.color || '#ff5252';
      ctx.fill();
      ctx.strokeStyle = 'rgba(8,10,14,0.9)';
      ctx.lineWidth = 1;
      ctx.stroke();
      if (loc.active) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 8.5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      drawSatLabel(loc.name || '', p.x + 9, p.y, st.labelSize || 11);
    }
  }

  function drawSun(m, date) {
    var s;
    try { s = SAT.util.sunSubpoint(date); } catch (e) { return; }
    var p = lonLatToPx(SAT.util.wrapLon(s.lonDeg), s.latDeg, m);
    ctx.strokeStyle = '#ffd54f';
    ctx.lineWidth = 1.5;
    for (var k = 0; k < 8; k++) {
      var a = k * Math.PI / 4;
      ctx.beginPath();
      ctx.moveTo(p.x + Math.cos(a) * 7, p.y + Math.sin(a) * 7);
      ctx.lineTo(p.x + Math.cos(a) * 11, p.y + Math.sin(a) * 11);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffd54f';
    ctx.fill();
    ctx.strokeStyle = 'rgba(60,40,0,0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function drawMoon(m, date) {
    var s;
    try { s = SAT.util.moonSubpoint(date); } catch (e) { return; }
    var p = lonLatToPx(SAT.util.wrapLon(s.lonDeg), s.latDeg, m);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#c9ccd1';
    ctx.fill();
    ctx.strokeStyle = 'rgba(8,10,14,0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // subtle crater dots
    ctx.fillStyle = 'rgba(120,124,132,0.85)';
    ctx.beginPath(); ctx.arc(p.x - 1.6, p.y - 1.2, 1.1, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(p.x + 1.7, p.y + 0.4, 0.8, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(p.x - 0.2, p.y + 2.0, 0.7, 0, Math.PI * 2); ctx.fill();
  }

  // ---- HUD readouts --------------------------------------------------------

  function updateReadouts(date) {
    var selId = SAT.state && SAT.state.selection ? SAT.state.selection.satId : null;
    var sat = selId && SAT.state.getSat ? SAT.state.getSat(selId) : null;
    if (!sat) {
      elSel.style.display = 'none';
      elEpoch.style.display = 'none';
      return;
    }

    var txt = sat.name || '';
    var geo = safeGeo(sat, date);
    if (geo) {
      txt += '  ' + fmtLat(geo.latDeg) + ' ' + fmtLon(geo.lonDeg) +
             '  ' + geo.heightKm.toFixed(0) + ' km  ' + geo.velKmS.toFixed(2) + ' km/s';
    }
    var loc = SAT.state.activeLocation ? SAT.state.activeLocation() : null;
    if (loc) {
      var la = null;
      try { la = SAT.prop.lookAngles(loc, sat, date); } catch (e) { la = null; }
      if (la) {
        txt += '  |  AZ ' + la.azDeg.toFixed(1) + '°  EL ' + la.elDeg.toFixed(1) +
               '°  RNG ' + la.rangeKm.toFixed(0) + ' km';
      }
    }
    elSel.textContent = txt;
    elSel.style.display = 'block';

    var sr = sat._satrec;
    if (sr && isFinite(sr.jdsatepoch)) {
      var jdNow = date.getTime() / 86400000 + 2440587.5;
      var ageD = jdNow - sr.jdsatepoch;
      elEpoch.textContent = 'epoch age ' + ageD.toFixed(1) + ' d';
      elEpoch.style.display = 'block';
    } else {
      elEpoch.style.display = 'none';
    }
  }

  // ---- main render ---------------------------------------------------------

  function render() {
    if (!ctx || cssW < 2 || cssH < 2) return;
    var date = SAT.clock.getDate();
    var nowMs = date.getTime();
    var st = settings();
    var m = metrics();
    markerHits = [];

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, cssW, cssH);

    ctx.save();
    ctx.beginPath();
    ctx.rect(m.left, m.top, m.w, m.h);
    ctx.clip();

    // base image
    if (baseReady) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = view.scale > 4 ? 'high' : 'medium';
      ctx.drawImage(baseImg, m.left, m.top, m.w, m.h);
    } else {
      ctx.fillStyle = '#0a1c2e';
      ctx.fillRect(m.left, m.top, m.w, m.h);
    }

    if (st.showNightShade || st.showTerminator) drawNight(m, date, st);
    if (st.showGraticule) drawGraticule(m);

    // satellites — compute geodetic once per sat; skip failures silently
    var sats = [];
    try { sats = SAT.state.allActiveSats() || []; } catch (e) { sats = []; }
    var selId = SAT.state.selection ? SAT.state.selection.satId : null;
    var entries = [], i, e;
    for (i = 0; i < sats.length; i++) {
      var g = safeGeo(sats[i], date);
      if (g) entries.push({ sat: sats[i], geo: g });
    }

    // layer order: footprints, tracks, markers (markers on top)
    for (i = 0; i < entries.length; i++) {
      e = entries[i];
      if (!e.sat.show || e.sat.show.footprint) {
        try { drawFootprint(m, e.geo, e.sat.color, e.sat.id === selId); } catch (err) {}
      }
    }
    for (i = 0; i < entries.length; i++) {
      e = entries[i];
      if (!e.sat.show || e.sat.show.groundTrack) {
        try { drawTrack(m, e.sat, date, nowMs, st); } catch (err) {}
      }
    }
    for (i = 0; i < entries.length; i++) {
      e = entries[i];
      try { drawSatMarker(m, e.sat, e.geo, e.sat.id === selId, st); } catch (err) {}
    }

    drawStations(m, st);
    if (st.showSun) drawSun(m, date);
    if (st.showMoon) drawMoon(m, date);

    ctx.restore();
    updateReadouts(date);
  }

  // ---- interaction ---------------------------------------------------------

  function evtPos(e) {
    var r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function hitTest(x, y) {
    var best = null, bestD = 8; // px radius
    for (var i = 0; i < markerHits.length; i++) {
      var h = markerHits[i];
      var d = Math.hypot(h.x - x, h.y - y);
      if (d <= bestD) { bestD = d; best = h; }
    }
    return best;
  }

  function handleClick(x, y) {
    var hit = hitTest(x, y);
    try { SAT.state.clickSelect(hit ? hit.id : null); } catch (e) {}
  }

  function onDragMove(e) {
    if (!drag) return;
    var pt = evtPos(e);
    var dx = pt.x - drag.lx, dy = pt.y - drag.ly;
    drag.lx = pt.x; drag.ly = pt.y;
    if (Math.abs(pt.x - drag.sx) + Math.abs(pt.y - drag.sy) > 3) drag.moved = true;
    if (drag.button === 0) {
      var m = metrics();
      view.cx -= dx / m.w;
      view.cy -= dy / m.h;
      clampView();
      requestRender();
    } else {
      // right-drag: vertical motion zooms toward the drag anchor point
      zoomAt(drag.ax, drag.ay, Math.exp(-dy * 0.005));
    }
    e.preventDefault();
  }

  function onDragUp() {
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragUp);
    var wasClick = drag && drag.button === 0 && !drag.moved;
    var px = drag ? drag.lx : 0, py = drag ? drag.ly : 0;
    drag = null;
    canvas.style.cursor = 'grab';
    if (wasClick) handleClick(px, py);
  }

  function wireInput() {
    canvas.addEventListener('mousedown', function (e) {
      if (e.button !== 0 && e.button !== 2) return;
      var pt = evtPos(e);
      drag = { button: e.button, sx: pt.x, sy: pt.y, lx: pt.x, ly: pt.y,
               ax: pt.x, ay: pt.y, moved: false };
      canvas.style.cursor = e.button === 0 ? 'grabbing' : 'ns-resize';
      window.addEventListener('mousemove', onDragMove);
      window.addEventListener('mouseup', onDragUp);
      e.preventDefault();
    });

    canvas.addEventListener('dblclick', function (e) {
      resetView();
      e.preventDefault();
    });

    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 33;
      else if (e.deltaMode === 2) dy *= cssH;
      var pt = evtPos(e);
      zoomAt(pt.x, pt.y, Math.exp(-dy * 0.0015));
    }, { passive: false });

    canvas.addEventListener('mousemove', function (e) {
      if (drag) return;
      var pt = evtPos(e);
      var ll = pxToLonLat(pt.x, pt.y, metrics());
      elCursor.textContent = ll ? (fmtLat(ll.latDeg) + '  ' + fmtLon(ll.lonDeg)) : '—';
      canvas.style.cursor = hitTest(pt.x, pt.y) ? 'pointer' : 'grab';
    });

    canvas.addEventListener('mouseleave', function () {
      elCursor.textContent = '—';
    });
  }

  // ---- toolbar / settings --------------------------------------------------

  function mutateSettings(fn) {
    fn(settings());
    try { SAT.state.save(); } catch (e) {}
    SAT.bus.emit('settings-changed', { section: 'map2d' });
  }

  function updateToolbar() {
    var st = settings();
    if (tbtnNight) tbtnNight.classList.toggle('m2d-on', !!st.showNightShade);
    if (tbtnGrid) tbtnGrid.classList.toggle('m2d-on', !!st.showGraticule);
    if (tbtnSunMoon) tbtnSunMoon.classList.toggle('m2d-on', !!(st.showSun || st.showMoon));
  }

  function buildToolbar() {
    elToolbar = document.createElement('div');
    elToolbar.className = 'm2d-toolbar';
    function tb(label, title, fn) {
      var b = document.createElement('button');
      b.className = 'btn small m2d-tbtn';
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', fn);
      elToolbar.appendChild(b);
      return b;
    }
    tb('+', 'Zoom in', function () { zoomAt(cssW / 2, cssH / 2, 1.5); });
    tb('−', 'Zoom out', function () { zoomAt(cssW / 2, cssH / 2, 1 / 1.5); });
    tb('⟲', 'Reset view (fit)', resetView);
    tbtnNight = tb('N', 'Toggle night shading', function () {
      mutateSettings(function (s) {
        var v = !s.showNightShade;
        s.showNightShade = v;
        s.showTerminator = v;
      });
    });
    tbtnGrid = tb('G', 'Toggle graticule', function () {
      mutateSettings(function (s) { s.showGraticule = !s.showGraticule; });
    });
    tbtnSunMoon = tb('☀', 'Toggle sun/moon icons', function () {
      mutateSettings(function (s) {
        var v = !(s.showSun || s.showMoon);
        s.showSun = v;
        s.showMoon = v;
      });
    });
    body.appendChild(elToolbar);
  }

  function buildHud() {
    function hud(cls) {
      var d = document.createElement('div');
      d.className = 'm2d-hud ' + cls;
      body.appendChild(d);
      return d;
    }
    elCursor = hud('m2d-cursor');
    elCursor.textContent = '—';
    elSel = hud('m2d-sel');
    elSel.style.display = 'none';
    elEpoch = hud('m2d-epoch');
    elEpoch.style.display = 'none';
  }

  function injectStyle() {
    if (document.getElementById('m2d-style')) return;
    var s = document.createElement('style');
    s.id = 'm2d-style';
    s.textContent =
      '.m2d-canvas{position:absolute;left:0;top:0;display:block;cursor:grab;}' +
      '.m2d-hud{position:absolute;font:11px ' + MONO + ';font-variant-numeric:tabular-nums;' +
        'color:#e8eaed;background:rgba(10,14,18,0.62);padding:2px 7px;border-radius:3px;' +
        'pointer-events:none;white-space:nowrap;z-index:5;}' +
      '.m2d-cursor{top:6px;right:6px;}' +
      '.m2d-sel{bottom:6px;left:6px;}' +
      '.m2d-epoch{bottom:6px;right:6px;color:#9aa4ad;}' +
      '.m2d-toolbar{position:absolute;top:6px;left:6px;display:flex;gap:3px;z-index:6;opacity:0.85;}' +
      '.m2d-toolbar:hover{opacity:1;}' +
      '.m2d-tbtn{min-width:26px;padding:2px 6px;}' +
      '.m2d-tbtn.m2d-on{outline:1px solid #4fc3f7;color:#4fc3f7;}';
    document.head.appendChild(s);
  }

  // ---- sizing --------------------------------------------------------------

  function resize() {
    if (!body || !canvas) return;
    var r = body.getBoundingClientRect();
    var w = Math.max(1, Math.floor(r.width));
    var h = Math.max(1, Math.floor(r.height));
    var d = window.devicePixelRatio || 1;
    if (w === cssW && h === cssH && d === dpr) return;
    cssW = w; cssH = h; dpr = d;
    canvas.width = Math.round(w * d);
    canvas.height = Math.round(h * d);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    clampView();
    requestRender();
  }

  // ---- init ----------------------------------------------------------------

  function init(bodyEl, win) {
    body = bodyEl;
    winRef = win;
    win.noScroll = true;

    injectStyle();

    canvas = document.createElement('canvas');
    canvas.className = 'm2d-canvas';
    body.appendChild(canvas);
    ctx = canvas.getContext('2d');

    buildHud();
    buildToolbar();
    wireInput();

    // base earth texture (loaded once)
    baseImg = new Image();
    baseImg.onload = function () { baseReady = true; requestRender(); };
    baseImg.onerror = function () { baseReady = false; requestRender(); };
    baseImg.src = IMG_SRC;

    // resize plumbing: win-resize event + ResizeObserver safety net
    body.addEventListener('win-resize', resize);
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(resize).observe(body);
    }
    resize();

    // bus wiring — re-render on all relevant events
    SAT.bus.on('time', function () { requestRender(); });
    SAT.bus.on('sats-changed', requestRender);
    SAT.bus.on('selection-changed', requestRender);
    SAT.bus.on('locations-changed', requestRender);
    SAT.bus.on('settings-changed', function () { updateToolbar(); requestRender(); });
    SAT.bus.on('state-loaded', function () { updateToolbar(); requestRender(); });

    updateToolbar();
    requestRender();
  }

  window.SAT = window.SAT || { ui: {} };
  SAT.map2d = { init: init, requestRender: requestRender };
})();
