/* SAT.prop — SGP4 propagation, tracks, footprints (satellite.js 5.0) */
(function () {
  'use strict';
  const U = () => SAT.util;
  const Re = 6371.0;        // km, mean radius (graphics/footprint)
  const ReEq = 6378.137;    // km, equatorial

  function buildRec(l1, l2) {
    try {
      const rec = satellite.twoline2satrec(l1, l2);
      if (!rec || rec.error) return null;
      // reject records that cannot propagate at their own epoch
      const pv = satellite.propagate(rec, epochDate(rec));
      return (pv && pv.position) ? rec : null;
    } catch (e) { return null; }
  }

  function ensureSatrec(sat) {
    if (sat._satrec) return true;
    if (sat._satrecBad) return false;
    const rec = buildRec(sat.l1, sat.l2);
    if (!rec) { sat._satrecBad = true; return false; }
    sat._satrec = rec;
    return true;
  }

  // SupGP multi-segment sets (sat.segs = [{epoch,l1,l2}, …], epoch-sorted):
  // each segment is best-fitted near its own epoch, so propagate every moment
  // with the segment whose epoch is nearest. Ordinary single-TLE sats fall
  // through to the base satrec. Built satrecs are memoized per segment.
  function recFor(sat, date) {
    const segs = sat.segs;
    if (segs && segs.length > 1) {
      if (!sat._segMs || sat._segMs.length !== segs.length) {
        sat._segMs = segs.map(s =>
          Date.parse(String(s.epoch).replace(/Z$/i, '') + 'Z') || 0);
      }
      const ms = sat._segMs, t = date.getTime();
      let i = 0;
      while (i < ms.length - 1 && t >= (ms[i] + ms[i + 1]) / 2) i++;
      const recs = sat._segRecs || (sat._segRecs = new Array(segs.length));
      if (recs[i] === undefined) recs[i] = buildRec(segs[i].l1, segs[i].l2);
      if (recs[i]) return recs[i];   // bad segment -> fall through to base TLE
    }
    return ensureSatrec(sat) ? sat._satrec : null;
  }

  function epochDate(rec) {
    // satrec.jdsatepoch (+ jdsatepochF in some builds)
    const jd = (rec.jdsatepoch || 2451545) + (rec.jdsatepochF || 0);
    return new Date((jd - 2440587.5) * 86400000);
  }

  function geodetic(sat, date) {
    const rec = recFor(sat, date);
    if (!rec) return null;
    try {
      const pv = satellite.propagate(rec, date);
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
    const rec0 = recFor(sat, date);   // segment at track center = cache identity
    if (!rec0) return { points: [] };
    const period = periodMinutes(sat) || 90;
    const back = minutesBack > 0 ? minutesBack : period / 2;
    const fwd = minutesFwd > 0 ? minutesFwd : period;
    const t = date.getTime();
    const c = trackCache.get(sat.id);
    const maxDrift = period * 60000 / 8;
    if (c && c.rec === rec0 && c.back === back && c.fwd === fwd &&
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
    trackCache.set(sat.id, { rec: rec0, centerMs: t, back, fwd, result });
    return result;
  }

  function orbitEci(sat, date, nSamples) {
    const rec = recFor(sat, date);   // one segment for the whole ring
    if (!rec) return [];
    const n = nSamples || 180;
    const period = periodMinutes(sat) || 90;
    const t = date.getTime();
    const c = orbitCache.get(sat.id);
    const maxDrift = period * 60000 / 8;
    if (c && c.rec === rec && c.n === n && Math.abs(t - c.centerMs) < maxDrift) {
      return c.result;
    }
    const t0 = t - period * 30000, span = period * 60000; // centered: -P/2 .. +P/2
    const pts = [];
    for (let i = 0; i <= n; i++) {
      try {
        const pv = satellite.propagate(rec, new Date(t0 + span * i / n));
        if (pv && pv.position) pts.push({ x: pv.position.x, y: pv.position.y, z: pv.position.z });
      } catch (e) { /* skip */ }
    }
    orbitCache.set(sat.id, { rec, centerMs: t, n, result: pts });
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
    if (!loc) return null;
    const rec = recFor(sat, date);
    if (!rec) return null;
    try {
      const pv = satellite.propagate(rec, date);
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

  function tleEpoch(sat, date) {
    // with a date: epoch of the segment active at that time (SupGP sets)
    const rec = date ? recFor(sat, date) : (ensureSatrec(sat) ? sat._satrec : null);
    return rec ? epochDate(rec) : null;
  }

  function clearCaches() { trackCache.clear(); orbitCache.clear(); }

  SAT.prop = {
    Re, ReEq, ensureSatrec, recFor, geodetic, periodMinutes,
    groundTrack, orbitEci, footprint, lookAngles, tleEpoch, clearCaches,
  };
})();
