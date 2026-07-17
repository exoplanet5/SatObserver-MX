/* SAT.prop — SGP4 propagation, tracks, footprints (satellite.js 5.0) */
(function () {
  'use strict';
  const U = () => SAT.util;
  const Re = 6371.0;        // km, mean radius (graphics/footprint)
  const ReEq = 6378.137;    // km, equatorial

  function ensureSatrec(sat) {
    if (sat._satrec) return true;
    if (sat._satrecBad) return false;
    try {
      const rec = satellite.twoline2satrec(sat.l1, sat.l2);
      if (!rec || rec.error) { sat._satrecBad = true; return false; }
      // reject records that cannot propagate at their own epoch
      const pv = satellite.propagate(rec, epochDate(rec));
      if (!pv || !pv.position) { sat._satrecBad = true; return false; }
      sat._satrec = rec;
      return true;
    } catch (e) {
      sat._satrecBad = true;
      return false;
    }
  }

  function epochDate(rec) {
    // satrec.jdsatepoch (+ jdsatepochF in some builds)
    const jd = (rec.jdsatepoch || 2451545) + (rec.jdsatepochF || 0);
    return new Date((jd - 2440587.5) * 86400000);
  }

  function geodetic(sat, date) {
    if (!ensureSatrec(sat)) return null;
    try {
      const pv = satellite.propagate(sat._satrec, date);
      if (!pv || !pv.position) return null;
      const gmst = satellite.gstime(date);
      const geo = satellite.eciToGeodetic(pv.position, gmst);
      const v = pv.velocity;
      return {
        latDeg: satellite.degreesLat(geo.latitude),
        lonDeg: U().wrapLon(satellite.degreesLong(geo.longitude)),
        heightKm: geo.height,
        velKmS: v ? Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) : 0,
        eciPos: pv.position,
        gmst,
      };
    } catch (e) { return null; }
  }

  function periodMinutes(sat) {
    if (!ensureSatrec(sat)) return 0;
    const n = sat._satrec.no_kozai || sat._satrec.no; // rad/min
    return n ? (2 * Math.PI / n) : 0;
  }

  // ---- caches ----
  const trackCache = new Map();  // satId -> {rec, centerMs, back, fwd, result}
  const orbitCache = new Map();  // satId -> {rec, centerMs, n, result}

  function groundTrack(sat, date, minutesBack, minutesFwd) {
    if (!ensureSatrec(sat)) return { points: [] };
    const period = periodMinutes(sat) || 90;
    const back = minutesBack > 0 ? minutesBack : period / 2;
    const fwd = minutesFwd > 0 ? minutesFwd : period;
    const t = date.getTime();
    const c = trackCache.get(sat.id);
    const maxDrift = period * 60000 / 8;
    if (c && c.rec === sat._satrec && c.back === back && c.fwd === fwd &&
        Math.abs(t - c.centerMs) < maxDrift) {
      return c.result;
    }
    const N = 240;
    const t0 = t - back * 60000, t1 = t + fwd * 60000;
    const step = (t1 - t0) / N;
    const points = [];
    let prev = null;
    for (let i = 0; i <= N; i++) {
      const ti = t0 + i * step;
      const g = geodetic(sat, new Date(ti));
      if (!g) { if (prev) { points.push(null); prev = null; } continue; }
      const p = { t: ti, latDeg: g.latDeg, lonDeg: g.lonDeg, heightKm: g.heightKm };
      if (prev && Math.abs(p.lonDeg - prev.lonDeg) > 180) points.push(null); // antimeridian
      points.push(p);
      prev = p;
    }
    const result = { points };
    trackCache.set(sat.id, { rec: sat._satrec, centerMs: t, back, fwd, result });
    return result;
  }

  function orbitEci(sat, date, nSamples) {
    if (!ensureSatrec(sat)) return [];
    const n = nSamples || 180;
    const period = periodMinutes(sat) || 90;
    const t = date.getTime();
    const c = orbitCache.get(sat.id);
    const maxDrift = period * 60000 / 8;
    if (c && c.rec === sat._satrec && c.n === n && Math.abs(t - c.centerMs) < maxDrift) {
      return c.result;
    }
    const t0 = t - period * 30000, span = period * 60000; // centered: -P/2 .. +P/2
    const pts = [];
    for (let i = 0; i <= n; i++) {
      try {
        const pv = satellite.propagate(sat._satrec, new Date(t0 + span * i / n));
        if (pv && pv.position) pts.push({ x: pv.position.x, y: pv.position.y, z: pv.position.z });
      } catch (e) { /* skip */ }
    }
    orbitCache.set(sat.id, { rec: sat._satrec, centerMs: t, n, result: pts });
    return pts;
  }

  function footprint(latDeg, lonDeg, heightKm, n) {
    n = n || 90;
    const h = Math.max(heightKm, 1);
    const angDeg = U().deg(Math.acos(Re / (Re + h)));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      pts.push(U().destPoint(latDeg, lonDeg, 360 * i / n, angDeg));
    }
    return pts;
  }

  function lookAngles(loc, sat, date) {
    if (!loc || !ensureSatrec(sat)) return null;
    try {
      const pv = satellite.propagate(sat._satrec, date);
      if (!pv || !pv.position) return null;
      const gmst = satellite.gstime(date);
      const ecf = satellite.eciToEcf(pv.position, gmst);
      const obs = {
        latitude: U().rad(loc.latDeg),
        longitude: U().rad(loc.lonDeg),
        height: (loc.altM || 0) / 1000,
      };
      const la = satellite.ecfToLookAngles(obs, ecf);
      return {
        azDeg: U().deg(la.azimuth),
        elDeg: U().deg(la.elevation),
        rangeKm: la.rangeSat,
      };
    } catch (e) { return null; }
  }

  function tleEpoch(sat) {
    if (!ensureSatrec(sat)) return null;
    return epochDate(sat._satrec);
  }

  function clearCaches() { trackCache.clear(); orbitCache.clear(); }

  SAT.prop = {
    Re, ReEq, ensureSatrec, geodetic, periodMinutes,
    groundTrack, orbitEci, footprint, lookAngles, tleEpoch, clearCaches,
  };
})();
