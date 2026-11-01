/* SAT.prop — SGP4 propagation, tracks, footprints (satellite.js 5.0) */
(function () {
  'use strict';
  const U = () => SAT.util;
  const Re = 6371.0;        // km, mean radius (graphics/footprint)
  const ReEq = 6378.137;    // km, equatorial

  // Deep-space resonant orbits (GEO, Molniya: satrec.irez != 0) carry a
  // fixed-step (720 min) integrator whose state the patched satellite.min.js
  // keeps on the satrec. It only runs forward from that state; a call earlier
  // than it restarts from the TLE epoch — ~900 steps for a 600-day-old elset.
  // Views constantly hop back and forth in time (track/orbit/pass sampling),
  // so integrator states are checkpointed per satrec and the nearest one at
  // or before the target is restored first. The integration is deterministic,
  // so results are bit-identical to integrating from epoch every time.
  const CK_MAX = 64;
  function prop(rec, date) {
    if (rec.irez) {
      const t = (date.getTime() / 86400000 + 2440587.5 - rec.jdsatepoch) * 1440;
      const at = rec.atime;
      if (at !== 0 && (t * at <= 0 || Math.abs(t) < Math.abs(at))) {
        let best = null;
        const ck = rec._ck;
        if (ck) {
          for (let i = 0; i < ck.length; i++) {
            const c = ck[i];
            if (c.atime * t > 0 && Math.abs(c.atime) <= Math.abs(t) &&
                (!best || Math.abs(c.atime) > Math.abs(best.atime))) best = c;
          }
        }
        if (best) { rec.atime = best.atime; rec.xli = best.xli; rec.xni = best.xni; }
        else rec.atime = 0;   // integrator restarts from epoch
      }
      const pv = satellite.propagate(rec, date);
      if (rec.atime !== 0) {
        const ck = rec._ck || (rec._ck = []);
        let seen = false;
        for (let i = 0; i < ck.length; i++) if (ck[i].atime === rec.atime) { seen = true; break; }
        if (!seen) {
          ck.push({ atime: rec.atime, xli: rec.xli, xni: rec.xni });
          if (ck.length > CK_MAX) ck.shift();
        }
      }
      return pv;
    }
    return satellite.propagate(rec, date);
  }

  function buildRec(l1, l2) {
    try {
      const rec = satellite.twoline2satrec(l1, l2);
      if (!rec || rec.error) return null;
      // reject records that cannot propagate at their own epoch
      const pv = prop(rec, epochDate(rec));
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

  // The 2D map, globe and sky chart all ask for every sat at the same clock
  // instant each frame: memoize the latest result per sat (read-only object).
  function geodetic(sat, date) {
    const rec = recFor(sat, date);
    if (!rec) return null;
    const t = date.getTime();
    if (sat._geoMs === t && sat._geoRec === rec) return sat._geo;
    let out = null;
    try {
      const pv = prop(rec, date);
      if (pv && pv.position) {
        const gmst = satellite.gstime(date);
        const geo = satellite.eciToGeodetic(pv.position, gmst);
        const v = pv.velocity;
        out = {
          latDeg: satellite.degreesLat(geo.latitude),
          lonDeg: U().wrapLon(satellite.degreesLong(geo.longitude)),
          heightKm: geo.height,
          velKmS: v ? Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) : 0,
          eciPos: pv.position,
          gmst,
        };
      }
    } catch (e) { out = null; }
    sat._geoMs = t; sat._geoRec = rec; sat._geo = out;
    return out;
  }

  function periodMinutes(sat) {
    if (!ensureSatrec(sat)) return 0;
    const n = sat._satrec.no_kozai || sat._satrec.no; // rad/min
    return n ? (2 * Math.PI / n) : 0;
  }

  // ---- caches ----
  // keyed by sat AND window length: the 2D map (user-set minutes) and the
  // globe (default window) must not evict each other every frame
  const trackCache = new Map();  // satId|back|fwd -> {rec, centerMs, result}
  const orbitCache = new Map();  // satId -> {rec, centerMs, n, result}

  // Points carry wrapped longitudes in [-180, 180); consecutive samples are
  // NOT split at the antimeridian (the 2D map unwraps, the globe needs no
  // split). A null entry marks a propagation gap only.
  function groundTrack(sat, date, minutesBack, minutesFwd) {
    const rec0 = recFor(sat, date);   // segment at track center = cache identity
    if (!rec0) return { points: [] };
    const period = periodMinutes(sat) || 90;
    const back = minutesBack > 0 ? minutesBack : period / 2;
    const fwd = minutesFwd > 0 ? minutesFwd : period;
    const t = date.getTime();
    const key = sat.id + '|' + back + '|' + fwd;
    const c = trackCache.get(key);
    const maxDrift = period * 60000 / 8;
    if (c && c.rec === rec0 && Math.abs(t - c.centerMs) < maxDrift) return c.result;
    const N = 240;
    const t0 = t - back * 60000, t1 = t + fwd * 60000;
    const step = (t1 - t0) / N;
    const points = [];
    let prev = null;
    for (let i = 0; i <= N; i++) {
      const ti = t0 + i * step;
      const di = new Date(ti);
      const g = geodetic(sat, di);
      if (!g) { if (prev) { points.push(null); prev = null; } continue; }
      const p = { t: ti, latDeg: g.latDeg, lonDeg: g.lonDeg, heightKm: g.heightKm,
                  sunlit: U().satSunlit(g.eciPos, di) };
      points.push(p);
      prev = p;
    }
    const result = { points };
    trackCache.set(key, { rec: rec0, centerMs: t, result });
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
        const pv = prop(rec, new Date(t0 + span * i / n));
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
      const pv = prop(rec, date);
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
