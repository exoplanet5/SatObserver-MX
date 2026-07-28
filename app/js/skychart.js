/* SAT.skychart — polar az/el sky chart over the active ground station.
 * Elevation rings every 30°, azimuth spokes every 45°. Default orientation is
 * sky-view (N up, E left, as when looking up); toggle flips to map-view.
 * Selected satellite shows its current/next pass trajectory across the sky. */
(function () {
  'use strict';

  var body = null, winRef = null, canvas = null, ctx = null;
  var cssW = 0, cssH = 0, dpr = 1;
  var dirty = false, rafQueued = false;
  var markerHits = [];         // [{id,x,y}]
  var elHud = null, elFoot = null;
  var trackCache = new Map();  // satId -> {rec, aosMs, losMs, pts:[{t,az,el}], none:bool, computedAt}
  var MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

  function cfg() {
    var s = SAT.state.settings;
    if (!s.skychart) s.skychart = {};
    var c = s.skychart;
    if (c.eastLeft == null) c.eastLeft = true;
    if (c.elStep == null) c.elStep = 30;        // elevation grid: 30° or 10°
    if (c.stars == null) c.stars = true;
    if (c.starNames == null) c.starNames = false;
    if (c.constLines == null) c.constLines = false;
    if (c.constNames == null) c.constNames = false;
    if (c.sunMoon == null) c.sunMoon = true;
    return c;
  }

  function hexA(hex, a) {
    var h = (hex || '#4fc3f7').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (!isFinite(n)) n = 0x4fc3f7;
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  // ---- sky-disc shade by twilight stage (discrete, no gradients) ----
  // Only the area inside the horizon circle is tinted; outside it the chart
  // keeps the dark theme background.
  function skyBg(sunAlt) {
    if (sunAlt >= 0) return '#1e3348';    // daylight
    if (sunAlt >= -6) return '#182a3c';   // civil twilight
    if (sunAlt >= -12) return '#131f2e';  // nautical twilight
    if (sunAlt >= -18) return '#0e1620';  // astronomical twilight
    return '#0a0e13';                     // night
  }

  // ---- geometry ----
  function metrics() {
    var R = Math.max(30, Math.min(cssW, cssH) / 2 - 30);
    return { cx: cssW / 2, cy: cssH / 2, R: R };
  }

  function project(azDeg, elDeg, m) {
    var r = (90 - Math.max(elDeg, -5)) / 90 * m.R;   // slightly below horizon allowed for AOS/LOS ticks
    var a = azDeg * Math.PI / 180;
    var sx = cfg().eastLeft ? -1 : 1;                 // sky view: E on the left
    return { x: m.cx + sx * r * Math.sin(a), y: m.cy - r * Math.cos(a) };
  }

  // ---- pass trajectory (rise/set threshold: 1 deg elevation) ----
  var STEP = 30000, BACK_MAX = 200 * 60000, FWD_MAX = 12 * 3600000;
  var RISE_EL = 1.0; // deg — pass tracks are cut off below this elevation

  function elAt(loc, sat, t) {
    var la = SAT.prop.lookAngles(loc, sat, new Date(t));
    return la ? la.elDeg : null;
  }

  // bisect the RISE_EL crossing bracketed by tBelow/tAbove to ~2 s
  function refineCross(loc, sat, tBelow, tAbove) {
    for (var i = 0; i < 24 && Math.abs(tAbove - tBelow) > 2000; i++) {
      var mid = (tBelow + tAbove) / 2;
      var e = elAt(loc, sat, mid);
      if (e == null) break;
      if (e > RISE_EL) tAbove = mid; else tBelow = mid;
    }
    return tAbove;
  }

  function computeTrack(loc, sat, nowMs) {
    var e0 = elAt(loc, sat, nowMs);
    var aos = null, los = null, t;
    if (e0 != null && e0 > RISE_EL) {
      aos = nowMs; los = nowMs;
      for (t = nowMs; t > nowMs - BACK_MAX; t -= STEP) {
        var e = elAt(loc, sat, t);
        if (e == null || e <= RISE_EL) break;
        aos = t;
      }
      for (t = nowMs; t < nowMs + BACK_MAX; t += STEP) {
        var e2 = elAt(loc, sat, t);
        if (e2 == null || e2 <= RISE_EL) break;
        los = t;
      }
    } else {
      for (t = nowMs + STEP; t < nowMs + FWD_MAX; t += STEP) {
        var e3 = elAt(loc, sat, t);
        if (e3 != null && e3 > RISE_EL) { aos = t; break; }
      }
      if (aos != null) {
        los = aos;
        for (t = aos; t < aos + BACK_MAX; t += STEP) {
          var e4 = elAt(loc, sat, t);
          if (e4 == null || e4 <= RISE_EL) break;
          los = t;
        }
      }
    }
    if (aos == null) {
      return { satId: sat.id, rec: sat._satrec, none: true, computedAt: nowMs, aosMs: 0, losMs: 0, pts: [] };
    }
    // pin the endpoints exactly on the 1-deg threshold
    aos = Math.round(refineCross(loc, sat, aos - STEP, aos));
    los = Math.round(refineCross(loc, sat, los + STEP, los));
    var pts = [];
    var N = 160, span = los - aos;
    for (var i = 0; i <= N; i++) {
      var ti = aos + span * i / N;
      var di = new Date(ti);
      var la = SAT.prop.lookAngles(loc, sat, di);
      if (la && la.elDeg >= RISE_EL - 0.2) {
        var lit = true;   // Earth-shadow state along the pass
        try {
          var g = SAT.prop.geodetic(sat, di);
          if (g) lit = SAT.util.satSunlit(g.eciPos, di);
        } catch (e) { /* default sunlit */ }
        pts.push({ t: ti, az: la.azDeg, el: la.elDeg, sunlit: lit });
      }
    }
    return { satId: sat.id, rec: sat._satrec, none: false, aosMs: aos, losMs: los, pts: pts, computedAt: nowMs };
  }

  function getTrack(loc, sat, nowMs) {
    var c = trackCache.get(sat.id);
    if (c && c.rec === sat._satrec) {
      if (c.none && Math.abs(nowMs - c.computedAt) < 60000) return c;
      if (!c.none && nowMs >= c.aosMs - 300000 && nowMs <= c.losMs) return c;
    }
    c = computeTrack(loc, sat, nowMs);
    trackCache.set(sat.id, c);
    return c;
  }

  // ---- sun & moon ----
  function drawSunMoon(m, loc, date) {
    if (!cfg().sunMoon) return;
    var U = SAT.util;
    var sunSub, moonSub;
    try { sunSub = U.sunSubpoint(date); moonSub = U.moonSubpoint(date); } catch (e) { return; }
    var sun = U.altAzFromSubpoint(loc.latDeg, loc.lonDeg, sunSub);
    var moon = U.altAzFromSubpoint(loc.latDeg, loc.lonDeg, moonSub);
    moon.elDeg -= 0.95 * Math.cos(moon.elDeg * Math.PI / 180); // lunar parallax (mean 57')

    if (sun.elDeg > 0) {
      var p = project(sun.azDeg, sun.elDeg, m);
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

    if (moon.elDeg > 0) {
      var q = project(moon.azDeg, moon.elDeg, m);
      // geocentric sun–moon elongation -> phase; terminator drawn accordingly
      var f1 = moonSub.latDeg * Math.PI / 180, f2 = sunSub.latDeg * Math.PI / 180;
      var dl = (sunSub.lonDeg - moonSub.lonDeg) * Math.PI / 180;
      var cosPsi = Math.sin(f1) * Math.sin(f2) + Math.cos(f1) * Math.cos(f2) * Math.cos(dl);
      // bright limb faces the sun's chart position (valid below horizon too:
      // project() clamps el, keeping the azimuth direction)
      var ps = project(sun.azDeg, sun.elDeg, m);
      var phi = Math.atan2(ps.y - q.y, ps.x - q.x);
      var R = 5.5;
      ctx.save();
      ctx.translate(q.x, q.y);
      ctx.rotate(phi);                    // +x now points toward the sun
      ctx.beginPath();                    // dark side
      ctx.arc(0, 0, R, 0, Math.PI * 2);
      ctx.fillStyle = '#3c4148';
      ctx.fill();
      ctx.beginPath();                    // lit side: sun-side semicircle …
      ctx.arc(0, 0, R, -Math.PI / 2, Math.PI / 2, false);
      // … closed by the terminator ellipse (toward the sun when crescent)
      ctx.ellipse(0, 0, R * Math.abs(cosPsi), R, 0, Math.PI / 2, -Math.PI / 2, cosPsi > 0);
      ctx.fillStyle = '#e6e2d6';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(8,10,14,0.7)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
  }

  // ---- drawing ----
  function drawGrid(m) {
    var i, p;
    var step = cfg().elStep || 30;
    ctx.lineWidth = 1;
    // elevation rings every `step` degrees; 30°-multiples drawn brighter
    for (var el = 0; el < 90; el += step) {
      var r = (90 - el) / 90 * m.R;
      ctx.beginPath();
      ctx.arc(m.cx, m.cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = el === 0 ? 'rgba(232,234,237,0.5)' :
        (el % 30 === 0 ? 'rgba(232,234,237,0.16)' : 'rgba(232,234,237,0.08)');
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(m.cx, m.cy, 1.6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(232,234,237,0.5)';
    ctx.fill();

    // azimuth spokes every 45°
    var names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    ctx.font = '11px ' + MONO;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (i = 0; i < 8; i++) {
      var az = i * 45;
      var pe = project(az, 0, m);
      ctx.beginPath();
      ctx.moveTo(m.cx, m.cy);
      ctx.lineTo(pe.x, pe.y);
      ctx.strokeStyle = 'rgba(232,234,237,0.10)';
      ctx.stroke();
      var pl = project(az, -14, m); // label just outside the horizon
      ctx.fillStyle = az === 0 ? '#e8eaed' : 'rgba(154,164,174,0.9)';
      ctx.fillText(names[i], pl.x, pl.y);
    }
    // elevation labels along the NNE direction
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(154,164,174,0.75)';
    ctx.font = '10px ' + MONO;
    [0, 30, 60].forEach(function (el) {
      p = project(22.5, el, m);
      ctx.fillText(el + '°', p.x + 2, p.y);
    });
  }

  function haloText(text, x, y, fill, align) {
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = 'rgba(5,8,12,0.85)';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
  }

  // ---- star layer (RA/Dec -> alt/az each render; ~3k trig ops, sub-ms) ----
  var D2R = Math.PI / 180, R2D = 180 / Math.PI;

  // returns {altDeg, azDeg} for equatorial coords at the given site/time
  function altAz(raDeg, decDeg, lstRad, sinLat, cosLat) {
    var H = lstRad - raDeg * D2R;
    var sinDec = Math.sin(decDeg * D2R), cosDec = Math.cos(decDeg * D2R);
    var cosH = Math.cos(H), sinH = Math.sin(H);
    var sinAlt = sinLat * sinDec + cosLat * cosDec * cosH;
    var alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
    var az = Math.atan2(-cosDec * sinH, sinDec * cosLat - cosDec * sinLat * cosH);
    var azDeg = az * R2D;
    if (azDeg < 0) azDeg += 360;
    return { altDeg: alt * R2D, azDeg: azDeg };
  }

  // like project(), but without the horizon clamp — for filled sky shapes
  // whose below-horizon parts must land outside the (clipped) horizon circle
  function projectSky(azDeg, elDeg, m) {
    var r = (90 - elDeg) / 90 * m.R;
    var a = azDeg * D2R;
    var sx = cfg().eastLeft ? -1 : 1;
    return { x: m.cx + sx * r * Math.sin(a), y: m.cy - r * Math.cos(a) };
  }

  // faint Milky Way isophotes (d3-celestial contours), faded out in twilight
  function drawMW(m, loc, gmst, dark) {
    var mw = SAT.mwdata;
    if (!mw || !cfg().stars || dark <= 0.02) return;
    var lst = gmst + loc.lonDeg * D2R;
    var sinLat = Math.sin(loc.latDeg * D2R), cosLat = Math.cos(loc.latDeg * D2R);
    ctx.save();
    ctx.beginPath();
    ctx.arc(m.cx, m.cy, m.R, 0, Math.PI * 2);
    ctx.clip();
    for (var L = 0; L < mw.levels.length; L++) {
      var lev = mw.levels[L];
      ctx.beginPath();
      for (var ri = 0; ri < lev.rings.length; ri++) {
        var ring = lev.rings[ri];
        for (var i = 0; i < ring.length; i++) {
          var a = altAz(ring[i][0], ring[i][1], lst, sinLat, cosLat);
          var p = projectSky(a.azDeg, a.altDeg, m);
          if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
      }
      ctx.fillStyle = 'rgba(172,192,222,' + (lev.a * dark).toFixed(3) + ')';
      ctx.fill('evenodd');
    }
    ctx.restore();
  }

  function drawStars(m, loc, gmst) {
    var sd = SAT.stardata;
    var c = cfg();
    if (!sd || (!c.stars && !c.starNames && !c.constLines && !c.constNames)) return;
    var lst = gmst + loc.lonDeg * D2R;
    var sinLat = Math.sin(loc.latDeg * D2R), cosLat = Math.cos(loc.latDeg * D2R);
    var i, j, a, p;

    if (c.constLines && sd.lines) {
      ctx.strokeStyle = 'rgba(110,150,215,0.30)';
      ctx.lineWidth = 1;
      for (i = 0; i < sd.lines.length; i++) {
        var seg = sd.lines[i];
        var prev = null;
        ctx.beginPath();
        for (j = 0; j < seg.length; j++) {
          a = altAz(seg[j][0], seg[j][1], lst, sinLat, cosLat);
          if (a.altDeg <= 0) { prev = null; continue; }
          p = project(a.azDeg, a.altDeg, m);
          if (prev) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
          prev = p;
        }
        ctx.stroke();
      }
    }

    if (c.stars && sd.stars) {
      for (i = 0; i < sd.stars.length; i++) {
        var st = sd.stars[i];
        a = altAz(st[0], st[1], lst, sinLat, cosLat);
        if (a.altDeg <= 0.3) continue;
        p = project(a.azDeg, a.altDeg, m);
        var mag = st[2];
        var rad = Math.max(0.6, 2.7 - 0.45 * mag);
        var alpha = Math.max(0.25, 0.95 - 0.13 * mag);
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(225,235,255,' + alpha.toFixed(2) + ')';
        ctx.fill();
      }
    }

    if (c.starNames && sd.names) {
      ctx.font = '9px ' + MONO;
      for (i = 0; i < sd.names.length; i++) {
        var nm = sd.names[i];
        a = altAz(nm[0], nm[1], lst, sinLat, cosLat);
        if (a.altDeg <= 1) continue;
        p = project(a.azDeg, a.altDeg, m);
        haloText(nm[2], p.x + 5, p.y - 4, 'rgba(185,205,240,0.9)');
      }
    }

    if (c.constNames && sd.cons) {
      ctx.font = 'italic 10px ' + MONO;
      ctx.textBaseline = 'middle';
      for (i = 0; i < sd.cons.length; i++) {
        var cn = sd.cons[i];
        a = altAz(cn[0], cn[1], lst, sinLat, cosLat);
        if (a.altDeg <= 4) continue;
        p = project(a.azDeg, a.altDeg, m);
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(140,165,205,0.55)';
        ctx.fillText(cn[2], p.x, p.y);
      }
      ctx.textAlign = 'left';
    }
  }

  // small dark rounded text box (same palette as the HUD readouts)
  function timeBox(text, x, y) {
    var w = ctx.measureText(text).width + 6, h = 12;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y - h + 2, w, h, 3);
    else ctx.rect(x, y - h + 2, w, h);
    ctx.fillStyle = 'rgba(10,14,18,0.72)';
    ctx.fill();
    ctx.fillStyle = '#e8eaed';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, x + 3, y);
  }

  function drawTrajectory(m, loc, sat, nowMs) {
    var tr = getTrack(loc, sat, nowMs);
    if (tr.none || tr.pts.length < 2) return tr;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    var prev = null;
    for (var i = 0; i < tr.pts.length; i++) {
      var q = tr.pts[i];
      var p = project(q.az, Math.max(q.el, RISE_EL), m);
      if (prev) {
        // eclipsed (Earth-shadow) stretches: dashed + dimmer
        var ecl = q.sunlit === false;
        ctx.strokeStyle = hexA(sat.color, (q.t <= nowMs ? 0.35 : 0.85) * (ecl ? 0.5 : 1));
        ctx.setLineDash(ecl ? [3, 3] : []);
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      prev = p;
    }
    ctx.setLineDash([]);
    // time ticks along the track: per minute when the pass is short enough,
    // else the smallest interval that keeps <=16 labels (long/GEO passes)
    var durMin = (tr.losMs - tr.aosMs) / 60000;
    var steps = [1, 2, 5, 10, 30, 60, 180, 360];
    var stepMin = 360;
    for (var si = 0; si < steps.length; si++) {
      if (durMin / steps[si] <= 16) { stepMin = steps[si]; break; }
    }
    ctx.font = '9px ' + MONO;
    for (var tt = Math.ceil(tr.aosMs / 60000) * 60000; tt < tr.losMs; tt += stepMin * 60000) {
      var la = SAT.prop.lookAngles(loc, sat, new Date(tt));
      if (!la || la.elDeg < RISE_EL) continue;
      var pt = project(la.azDeg, la.elDeg, m);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 2.2, 0, Math.PI * 2);
      ctx.fillStyle = hexA(sat.color, 1);
      ctx.fill();
      ctx.strokeStyle = 'rgba(8,10,14,0.9)';
      ctx.lineWidth = 1;
      ctx.stroke();
      timeBox(SAT.util.fmtDate(new Date(tt)).slice(11, 16), pt.x + 5, pt.y - 5);
    }

    // AOS / LOS markers at the 1-deg rise/set threshold
    var a = tr.pts[0], b = tr.pts[tr.pts.length - 1];
    var pa = project(a.az, Math.max(a.el, RISE_EL), m);
    var pb = project(b.az, Math.max(b.el, RISE_EL), m);
    ctx.font = '10px ' + MONO;
    haloText('↑' + SAT.util.fmtDate(new Date(tr.aosMs)).slice(11, 16), pa.x + 4, pa.y - 8, hexA(sat.color, 1));
    haloText('↓' + SAT.util.fmtDate(new Date(tr.losMs)).slice(11, 16), pb.x + 4, pb.y + 8, hexA(sat.color, 1));
    return tr;
  }

  function render() {
    if (!ctx || cssW < 2 || cssH < 2) return;
    var date = SAT.clock.getDate();
    var nowMs = date.getTime();
    var m = metrics();
    markerHits = [];

    var loc = SAT.state.activeLocation();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0e13';       // dark theme outside the horizon circle
    ctx.fillRect(0, 0, cssW, cssH);

    if (!loc) {
      ctx.fillStyle = '#9aa4ae';
      ctx.font = '12px ' + MONO;
      ctx.textAlign = 'center';
      ctx.fillText('Set an active ground station in the Locations window', m.cx, m.cy);
      elHud.style.display = 'none';
      elFoot.textContent = '';
      return;
    }

    var sunAlt = -90;
    try { sunAlt = SAT.util.sunAltitudeDeg(loc.latDeg, loc.lonDeg, date); } catch (e) { sunAlt = -90; }
    // sky disc tinted by twilight stage (daylight → night, discrete steps)
    ctx.beginPath();
    ctx.arc(m.cx, m.cy, m.R, 0, Math.PI * 2);
    ctx.fillStyle = skyBg(sunAlt);
    ctx.fill();

    var gmst = satellite.gstime(date);
    // Milky Way fades over twilight: full below sun alt -18°, gone above -6°
    var mwDark = Math.max(0, Math.min(1, (-6 - sunAlt) / 12));
    try { drawMW(m, loc, gmst, mwDark); } catch (e) { /* optional layer */ }
    drawGrid(m);
    try { drawStars(m, loc, gmst); } catch (e) { /* stars are optional */ }
    try { drawSunMoon(m, loc, date); } catch (e) { /* sun/moon are optional */ }

    var selId = SAT.state.selection ? SAT.state.selection.satId : null;
    var sats = [];
    try { sats = SAT.state.allActiveSats() || []; } catch (e) { sats = []; }

    var hudSat = null, hudLa = null, upCount = 0, selTrack = null;

    // pass trajectories follow the ground-track toggle, i.e. the same
    // click-selection cycle as the other views (drawn under the markers)
    sats.forEach(function (sat) {
      if (!sat.show || sat.show.groundTrack) {
        try { drawTrajectory(m, loc, sat, nowMs); } catch (e) { /* skip */ }
      }
    });
    // HUD next-pass info still keys off the selected sat (cached, not drawn here)
    var selSat = selId ? SAT.state.getSat(selId) : null;
    if (selSat && SAT.prop.ensureSatrec(selSat)) {
      try { selTrack = getTrack(loc, selSat, nowMs); } catch (e) { selTrack = null; }
    }

    sats.forEach(function (sat) {
      var la = null;
      try { la = SAT.prop.lookAngles(loc, sat, date); } catch (e) { la = null; }
      if (!la || la.elDeg <= 0) return;
      upCount++;
      var p = project(la.azDeg, la.elDeg, m);
      ctx.fillStyle = sat.color || '#4fc3f7';
      ctx.strokeStyle = 'rgba(8,10,14,0.9)';
      ctx.lineWidth = 1;
      ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
      ctx.strokeRect(p.x - 3, p.y - 3, 6, 6);
      if (sat.id === selId) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6.5, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
      if (!sat.show || sat.show.label) {
        ctx.font = '11px ' + MONO;
        haloText(sat.name || '', p.x + 8, p.y, '#ffffff');
      }
      markerHits.push({ id: sat.id, x: p.x, y: p.y });
      if (sat.id === selId) { hudSat = sat; hudLa = la; }
    });

    // HUD: selected sat (even below horizon), else hint
    if (!hudSat && selSat) {
      hudSat = selSat;
      try { hudLa = SAT.prop.lookAngles(loc, selSat, date); } catch (e) { hudLa = null; }
    }
    if (hudSat && hudLa) {
      var txt = (hudSat.name || '') +
        '  AZ ' + hudLa.azDeg.toFixed(1) + '°' +
        '  EL ' + hudLa.elDeg.toFixed(1) + '°' +
        '  RNG ' + hudLa.rangeKm.toFixed(0) + ' km';
      try {
        var g = SAT.prop.geodetic(hudSat, date);
        if (g && g.eciPos) {
          txt += '  |  ' + (SAT.util.satSunlit(g.eciPos, date) ? '● sunlit' : '✕ eclipsed');
        }
      } catch (e) { /* leave sunlight off */ }
      txt += ' · site sun ' + SAT.util.sunAltitudeDeg(loc.latDeg, loc.lonDeg, date).toFixed(1) + '°';
      if (hudLa.elDeg <= 0 && selTrack) {
        txt += selTrack.none ? '  (no pass < 12 h)'
          : '  (next pass ' + SAT.util.fmtDate(new Date(selTrack.aosMs)).slice(11, 16) + ' UTC)';
      }
      elHud.textContent = txt;
      elHud.style.display = 'block';
    } else {
      elHud.textContent = upCount + ' satellite' + (upCount === 1 ? '' : 's') +
        ' above horizon — click one, or select in Satellites';
      elHud.style.display = 'block';
    }

    elFoot.textContent = loc.name;
  }

  function requestRender() {
    dirty = true;
    if (rafQueued) return;
    rafQueued = true;
    requestAnimationFrame(function () {
      rafQueued = false;
      if (!dirty) return;
      if (winRef && !winRef.isOpen()) return;
      dirty = false;
      try { render(); } catch (e) { /* keep the loop alive */ }
    });
  }

  // ---- interaction / plumbing ----
  function resize() {
    if (!body || !canvas) return;
    var r = body.getBoundingClientRect();
    var w = Math.max(1, Math.floor(r.width)), h = Math.max(1, Math.floor(r.height));
    var d = window.devicePixelRatio || 1;
    if (w === cssW && h === cssH && d === dpr) return;
    cssW = w; cssH = h; dpr = d;
    canvas.width = Math.round(w * d);
    canvas.height = Math.round(h * d);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    requestRender();
  }

  function injectStyle() {
    if (document.getElementById('skc-style')) return;
    var s = document.createElement('style');
    s.id = 'skc-style';
    s.textContent =
      '.skc-canvas{position:absolute;left:0;top:0;display:block;cursor:crosshair;}' +
      '.skc-hud{position:absolute;font:11px ' + MONO + ';font-variant-numeric:tabular-nums;' +
        'color:#e8eaed;background:rgba(10,14,18,0.62);padding:2px 7px;border-radius:3px;' +
        'pointer-events:none;white-space:nowrap;z-index:5;}' +
      '.skc-topstack{position:absolute;top:34px;left:6px;right:6px;display:flex;' +
        'flex-direction:column;gap:4px;align-items:flex-start;pointer-events:none;z-index:5;}' +
      '.skc-topstack .skc-hud{position:static;white-space:normal;line-height:1.5;}' +
      '.skc-foot{color:#9aa4ad;}' +
      '.skc-toolbar{position:absolute;top:6px;left:6px;display:flex;gap:3px;z-index:6;opacity:.85;}' +
      '.skc-toolbar:hover{opacity:1;}' +
      '.skc-tbtn{min-width:26px;padding:2px 6px;}' +
      '.skc-tbtn.skc-on{outline:1px solid #4fc3f7;color:#4fc3f7;}';
    document.head.appendChild(s);
  }

  function init(bodyEl, win) {
    body = bodyEl;
    winRef = win;
    win.noScroll = true;
    injectStyle();

    canvas = document.createElement('canvas');
    canvas.className = 'skc-canvas';
    body.appendChild(canvas);
    ctx = canvas.getContext('2d');

    elHud = SAT.util.el('div', { class: 'skc-hud' }, '');
    elFoot = SAT.util.el('div', { class: 'skc-hud skc-foot' }, '');
    body.appendChild(SAT.util.el('div', { class: 'skc-topstack' }, [elHud, elFoot]));

    // toolbar, 2D-map style: grid spacing, star layers, orientation
    var toolBtns = {};
    function tbtn(key, label, title, onclick) {
      var b = SAT.util.el('button', { class: 'btn small skc-tbtn', title: title, onclick: onclick }, label);
      if (key) toolBtns[key] = b;
      return b;
    }
    function toggleLayer(key) {
      return function () {
        var c = cfg();
        c[key] = !c[key];
        SAT.state.save();
        updateToolbar();
        requestRender();
      };
    }
    function updateToolbar() {
      var c = cfg();
      toolBtns.grid.textContent = c.elStep + '°';
      toolBtns.stars.classList.toggle('skc-on', !!c.stars);
      toolBtns.starNames.classList.toggle('skc-on', !!c.starNames);
      toolBtns.constLines.classList.toggle('skc-on', !!c.constLines);
      toolBtns.constNames.classList.toggle('skc-on', !!c.constNames);
      toolBtns.sunMoon.classList.toggle('skc-on', !!c.sunMoon);
    }
    body.appendChild(SAT.util.el('div', { class: 'skc-toolbar' }, [
      tbtn('grid', '30°', 'elevation grid spacing: 30° / 10° per ring', function () {
        var c = cfg();
        c.elStep = c.elStep === 30 ? 10 : 30;
        SAT.state.save();
        updateToolbar();
        requestRender();
      }),
      tbtn('sunMoon', '☉', 'sun & moon (moon shows phase)', toggleLayer('sunMoon')),
      tbtn('stars', '✶', 'stars (to mag 4.6)', toggleLayer('stars')),
      tbtn('starNames', 'SN', 'bright star names', toggleLayer('starNames')),
      tbtn('constLines', 'CL', 'constellation lines', toggleLayer('constLines')),
      tbtn('constNames', 'CN', 'constellation names', toggleLayer('constNames')),
      tbtn(null, 'E⇄', 'flip east/west (sky view vs map view)', function () {
        cfg().eastLeft = !cfg().eastLeft;
        SAT.state.save();
        requestRender();
      }),
    ]));
    updateToolbar();
    SAT.bus.on('state-loaded', updateToolbar);

    canvas.addEventListener('click', function (e) {
      var r = canvas.getBoundingClientRect();
      var x = e.clientX - r.left, y = e.clientY - r.top;
      var best = null, bestD = 9;
      for (var i = 0; i < markerHits.length; i++) {
        var d = Math.hypot(markerHits[i].x - x, markerHits[i].y - y);
        if (d <= bestD) { bestD = d; best = markerHits[i]; }
      }
      try { SAT.state.clickSelect(best ? best.id : null); } catch (err) {}
    });

    body.addEventListener('win-resize', resize);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(body);
    resize();

    SAT.bus.on('time', function (p) {
      if (p && p.jumped) trackCache.clear();
      requestRender();
    });
    SAT.bus.on('sats-changed', function () { trackCache.clear(); requestRender(); });
    SAT.bus.on('selection-changed', requestRender);
    SAT.bus.on('locations-changed', function () { trackCache.clear(); requestRender(); });
    SAT.bus.on('settings-changed', requestRender);
    SAT.bus.on('state-loaded', function () { trackCache.clear(); requestRender(); });
    requestRender();
  }

  SAT.skychart = { init: init, requestRender: requestRender };
})();
