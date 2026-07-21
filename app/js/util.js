/* SAT.util — shared helpers, low-precision solar/lunar ephemeris */
(function () {
  'use strict';
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;

  function pad2(n) { return String(Math.floor(Math.abs(n))).padStart(2, '0'); }
  function pad4(n) { return String(Math.floor(Math.abs(n))).padStart(4, '0'); }

  function fmtDate(d) {
    return pad4(d.getUTCFullYear()) + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) +
      ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
  }
  function fmtDateLocal(d) {
    return pad4(d.getFullYear()) + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function wrapLon(deg) {
    let x = ((deg + 180) % 360 + 360) % 360 - 180;
    return x;
  }
  function deg(rad) { return rad * R2D; }
  function rad(d) { return d * D2R; }

  function uuid(prefix) {
    return (prefix || 'id') + '_' + Math.random().toString(36).slice(2, 10);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function debounce(fn, ms) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  // Tiny DOM helper: el('div', {class:'row', onclick: fn, title:'x'}, [child, 'text'])
  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null) continue;
        if (k === 'class') e.className = v;
        else if (k === 'style') e.style.cssText = v;
        else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else if (k === 'checked' || k === 'disabled' || k === 'selected') { if (v) e[k] = true; }
        else if (k === 'value') e.value = v;
        else e.setAttribute(k, v);
      }
    }
    if (children != null) {
      const add = c => {
        if (c == null) return;
        if (Array.isArray(c)) { c.forEach(add); return; }
        e.appendChild(typeof c === 'string' || typeof c === 'number'
          ? document.createTextNode(String(c)) : c);
      };
      add(children);
    }
    return e;
  }

  // ---- ephemerides (low precision, Meeus-style) ----

  function julian(date) { return date.getTime() / 86400000 + 2440587.5; }

  // Subsolar point, accuracy ~0.01 deg
  function sunEclipticRaDec(date) {
    const n = julian(date) - 2451545.0;
    const L = (280.460 + 0.9856474 * n) % 360;
    const g = rad((357.528 + 0.9856003 * n) % 360);
    const lam = rad(L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g));
    const eps = rad(23.439 - 0.0000004 * n);
    const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
    const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
    return { ra, dec };
  }

  function raDecToSubpoint(ra, dec, date) {
    const gmst = satellite.gstime(date); // rad
    return { latDeg: deg(dec), lonDeg: wrapLon(deg(ra - gmst)) };
  }

  function sunSubpoint(date) {
    const s = sunEclipticRaDec(date);
    return raDecToSubpoint(s.ra, s.dec, date);
  }

  // Sublunar point, accuracy ~0.3 deg (truncated ELP series)
  function moonSubpoint(date) {
    const T = (julian(date) - 2451545.0) / 36525.0;
    const Lp = rad((218.316 + 481267.8813 * T) % 360);
    const M = rad((357.529 + 35999.0503 * T) % 360);
    const Mp = rad((134.963 + 477198.8676 * T) % 360);
    const D = rad((297.850 + 445267.1115 * T) % 360);
    const F = rad((93.272 + 483202.0175 * T) % 360);
    const lam = Lp
      + rad(6.289) * Math.sin(Mp)
      - rad(1.274) * Math.sin(Mp - 2 * D)
      + rad(0.658) * Math.sin(2 * D)
      + rad(0.214) * Math.sin(2 * Mp)
      - rad(0.186) * Math.sin(M)
      - rad(0.114) * Math.sin(2 * F);
    const bet = rad(5.128) * Math.sin(F)
      + rad(0.280) * Math.sin(Mp + F)
      + rad(0.277) * Math.sin(Mp - F)
      + rad(0.173) * Math.sin(2 * D - F);
    const eps = rad(23.439 - 0.013 * T);
    const ra = Math.atan2(Math.sin(lam) * Math.cos(eps) - Math.tan(bet) * Math.sin(eps), Math.cos(lam));
    const dec = Math.asin(Math.sin(bet) * Math.cos(eps) + Math.cos(bet) * Math.sin(eps) * Math.sin(lam));
    return raDecToSubpoint(ra, dec, date);
  }

  // Terminator curve: n+1 points ordered by longitude from -180 to +180.
  // Night side determination is up to the consumer (see isNight / sun latitude sign).
  function nightPolygon(date, n) {
    n = n || 180;
    const sun = sunSubpoint(date);
    let latS = sun.latDeg;
    if (Math.abs(latS) < 0.01) latS = latS < 0 ? -0.01 : 0.01; // avoid tan() blowup at equinox instant
    const tanLatS = Math.tan(rad(latS));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const lon = -180 + 360 * i / n;
      const lat = deg(Math.atan(-Math.cos(rad(lon - sun.lonDeg)) / tanLatS));
      pts.push({ latDeg: lat, lonDeg: lon });
    }
    return pts;
  }

  function isNight(latDeg, lonDeg, sunSub) {
    const cosd = Math.sin(rad(latDeg)) * Math.sin(rad(sunSub.latDeg)) +
      Math.cos(rad(latDeg)) * Math.cos(rad(sunSub.latDeg)) * Math.cos(rad(lonDeg - sunSub.lonDeg));
    return cosd < 0;
  }

  // Sun direction unit vector in ECI (TEME-adequate for visibility tests)
  function sunEciUnit(date) {
    const s = sunEclipticRaDec(date);
    const cd = Math.cos(s.dec);
    return { x: cd * Math.cos(s.ra), y: cd * Math.sin(s.ra), z: Math.sin(s.dec) };
  }

  // Sun altitude above the horizon at a ground site, degrees
  function sunAltitudeDeg(latDeg, lonDeg, date) {
    const s = sunEclipticRaDec(date);
    const gmst = satellite.gstime(date);
    const ha = gmst + rad(lonDeg) - s.ra; // local hour angle
    const la = rad(latDeg);
    const sinAlt = Math.sin(la) * Math.sin(s.dec) +
      Math.cos(la) * Math.cos(s.dec) * Math.cos(ha);
    return deg(Math.asin(clamp(sinAlt, -1, 1)));
  }

  // Is a satellite at ECI position (km) illuminated by the sun?
  // Cylinder shadow model: eclipsed when behind the terminator plane and
  // within one Earth radius of the anti-sun axis.
  function satSunlit(eciPos, date) {
    const s = sunEciUnit(date);
    const d = eciPos.x * s.x + eciPos.y * s.y + eciPos.z * s.z;
    if (d >= 0) return true;
    const px = eciPos.x - d * s.x, py = eciPos.y - d * s.y, pz = eciPos.z - d * s.z;
    return Math.sqrt(px * px + py * py + pz * pz) > 6371.0;
  }

  // Alt/az of a celestial body seen from a site, from the body's sub-point
  // (the body is at zenith there). Exact for distant bodies (sun, stars);
  // for the moon subtract horizontal parallax (~0.95° · cos alt) from elDeg.
  function altAzFromSubpoint(latDeg, lonDeg, sub) {
    const la1 = rad(latDeg), la2 = rad(sub.latDeg), dl = rad(sub.lonDeg - lonDeg);
    const sinEl = Math.sin(la1) * Math.sin(la2) +
      Math.cos(la1) * Math.cos(la2) * Math.cos(dl);
    const az = Math.atan2(Math.sin(dl) * Math.cos(la2),
      Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dl));
    return { azDeg: (deg(az) + 360) % 360, elDeg: deg(Math.asin(clamp(sinEl, -1, 1))) };
  }

  // Great-circle destination given bearing and angular distance (all degrees)
  function destPoint(latDeg, lonDeg, bearingDeg, angDistDeg) {
    const la1 = rad(latDeg), lo1 = rad(lonDeg), th = rad(bearingDeg), dl = rad(angDistDeg);
    const la2 = Math.asin(Math.sin(la1) * Math.cos(dl) + Math.cos(la1) * Math.sin(dl) * Math.cos(th));
    const lo2 = lo1 + Math.atan2(Math.sin(th) * Math.sin(dl) * Math.cos(la1),
      Math.cos(dl) - Math.sin(la1) * Math.sin(la2));
    return { latDeg: deg(la2), lonDeg: wrapLon(deg(lo2)) };
  }

  SAT.util = {
    pad2, pad4, fmtDate, fmtDateLocal, clamp, wrapLon, deg, rad, uuid,
    escapeHtml, debounce, el, julian,
    sunSubpoint, moonSubpoint, nightPolygon, isNight, destPoint,
    sunEciUnit, sunAltitudeDeg, satSunlit, altAzFromSubpoint,
  };
})();
