/* globe3d.js — SAT.globe3d
 *
 * 3D Earth view in an Earth-FIXED (ECEF) frame: the globe mesh never spins;
 * satellite ECI coordinates are rotated by gmst into ECEF every update.
 *
 * Scene frame (right-handed, Y-up), chosen to match THREE.SphereGeometry's UV
 * layout for a [-180,180] equirectangular texture with NO mesh rotation:
 *   sceneX = ECEF X (lon 0, equator)     [SphereGeometry puts u=0.5 at +X]
 *   sceneY = ECEF Z (north pole)
 *   sceneZ = -ECEF Y (lon 90E -> -Z)     [u=0.75 lands at -Z]
 * i.e. ecefToScene(x,y,z) = (x, z, -y)/Re — a proper rotation, applied
 * consistently to satellites, stations, sun direction and orbit lines.
 * A rotation about ECEF +Z by a maps to a rotation about scene +Y by a, so
 * ECI->ECEF (angle -gmst about Z) is done for orbit lines by parking them in
 * a group with rotation.y = -gmst, updated every tick.
 */
(function () {
  'use strict';

  // ---------- constants ----------
  var SURF_R = 1.002;        // ground track / footprint altitude above unit sphere
  var MARKER_R = 0.012;      // sat marker radius (scene units)
  var PICK_R = 0.035;        // invisible pick-sphere radius (generous click target)
  var LABEL_H = 0.09;        // sat label height (world units)
  var LABEL_H_ST = 0.07;     // station label height
  var CONE_H = 0.05;         // station cone height
  var FOOT_N = 90;           // footprint samples requested
  var FOOT_CAP = 128;        // preallocated footprint vertices
  var ORBIT_N = 180;         // orbit samples per period
  var STAR_COUNT = 2500;
  var STAR_R = 60;
  var CLICK_SLOP_PX = 5;
  var REF_DIST = 3.126;      // |HOME_POS|: label world-height is defined at this camera distance

  // ---------- module state ----------
  var bodyEl = null, winRef = null;
  var renderer = null, scene = null, camera = null, controls = null, raycaster = null;
  var earthMesh, dayTex, nightTex, phongMat, nightMat, atmoMesh, stars;
  var sunLight, ambientLight;
  var eciGroup;                       // orbit lines live here; rotation.y = -gmst
  var ringSprite;                     // selection highlight ring
  var markerGeo, pickGeo, coneGeo, pickMat;
  var satPool = new Map();            // satId -> entry
  var stationPool = new Map();        // locId -> {cone,label,labelKey}
  var labelCache = new Map();         // "text|color" -> {tex,aspect,refs}
  var curDate = null, invRe = 1 / 6371.0;
  var selectedId = null, selScenePos = null;
  var pendingForce = false, needsFullUpdate = true, wasOpen = false;
  var nightBtn, starsBtn, followBtn;
  var followOn = false;
  var pdX = null, pdY = null;
  var HOME_POS = null;                // set in init (THREE not loaded yet here)
  var sunDirVec = null;
  var tmpV = null, tmpV2 = null, mouseNdc = null;

  // ---------- coordinate helpers ----------
  function ecefToScene(x, y, z, out) {
    return out.set(x * invRe, z * invRe, -y * invRe);
  }

  function eciToScene(eci, gmst, out) {
    var c = Math.cos(gmst), s = Math.sin(gmst);
    // ECEF = Rz(gmst)·ECI:  xe = x cos g + y sin g ; ye = -x sin g + y cos g
    return ecefToScene(eci.x * c + eci.y * s, -eci.x * s + eci.y * c, eci.z, out);
  }

  function geoToScene(latDeg, lonDeg, r, out) {
    var la = latDeg * Math.PI / 180, lo = lonDeg * Math.PI / 180;
    var cl = Math.cos(la);
    // ECEF (cosφcosλ, cosφsinλ, sinφ) mapped -> (x, z, -y)
    return out.set(r * cl * Math.cos(lo), r * Math.sin(la), -r * cl * Math.sin(lo));
  }

  function srgbColor(hex) {
    var c = new THREE.Color(hex || '#ffffff');
    return c.convertSRGBToLinear(); // renderer output-encodes back to sRGB -> exact hex
  }

  // ---------- label texture cache (key: text|color, refcounted) ----------
  function makeLabelTexture(text, color) {
    var font = '600 42px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
    var pad = 8, h = 60;
    var cv = document.createElement('canvas');
    var ctx = cv.getContext('2d');
    ctx.font = font;
    cv.width = Math.max(2, Math.ceil(ctx.measureText(text).width) + pad * 2);
    cv.height = h;
    ctx = cv.getContext('2d');
    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(text, pad, h / 2 + 1);
    ctx.fillStyle = color;
    ctx.fillText(text, pad, h / 2 + 1);
    var tex = new THREE.CanvasTexture(cv);
    tex.encoding = THREE.sRGBEncoding;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    return { tex: tex, aspect: cv.width / cv.height };
  }

  function acquireLabel(text, color) {
    var key = text + '|' + color;
    var e = labelCache.get(key);
    if (!e) {
      e = makeLabelTexture(text, color);
      e.refs = 0;
      labelCache.set(key, e);
    }
    e.refs++;
    return { key: key, tex: e.tex, aspect: e.aspect };
  }

  function releaseLabel(key) {
    var e = labelCache.get(key);
    if (!e) return;
    if (--e.refs <= 0) {
      e.tex.dispose();
      labelCache.delete(key);
    }
  }

  function makeLabelSprite(text, color, height) {
    var lbl = acquireLabel(text, color);
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: lbl.tex, transparent: true, depthWrite: false
    }));
    sp.center.set(-0.12, 0.5); // hang label to the right of its anchor point
    sp.scale.set(height * lbl.aspect, height, 1);
    sp.frustumCulled = false;
    sp.userData.labelKey = lbl.key;
    sp.userData.aspect = lbl.aspect;
    sp.userData.baseH = height;   // rescaled per-frame for constant screen size
    return sp;
  }

  // ---------- settings ----------
  function gset() {
    var s = (SAT.state && SAT.state.settings && SAT.state.settings.globe3d) || {};
    return { night: s.showNightLights !== false, stars: s.showStars !== false };
  }

  function writeSetting(key, val) {
    try {
      var st = SAT.state.settings;
      if (!st.globe3d) st.globe3d = {};
      st.globe3d[key] = val;
      SAT.state.save();
      SAT.bus.emit('settings-changed', { section: 'globe3d' });
    } catch (e) { /* keep UI responsive even if state is unhappy */ }
    applySettings();
  }

  function applySettings() {
    var s = gset();
    if (nightBtn) nightBtn.classList.toggle('g3d-on', !!s.night);
    if (starsBtn) starsBtn.classList.toggle('g3d-on', !!s.stars);
    if (earthMesh) earthMesh.material = s.night ? nightMat : phongMat;
    if (stars) stars.visible = s.stars;
    requestRender();
  }

  // ---------- scene construction ----------
  function buildEarth() {
    var loader = new THREE.TextureLoader();
    dayTex = loader.load('assets/earth_day.jpg', requestRender);
    nightTex = loader.load('assets/earth_night.jpg', requestRender);
    var maxAniso = renderer.capabilities.getMaxAnisotropy();
    [dayTex, nightTex].forEach(function (t) {
      t.encoding = THREE.sRGBEncoding;   // WebGL2: hardware decode -> linear samples
      t.anisotropy = maxAniso;
    });

    var geo = new THREE.SphereGeometry(1, 96, 64);

    phongMat = new THREE.MeshPhongMaterial({
      map: dayTex, specular: 0x1a2027, shininess: 10
    });

    nightMat = new THREE.ShaderMaterial({
      uniforms: {
        dayMap: { value: dayTex },
        nightMap: { value: nightTex },
        sunDir: { value: new THREE.Vector3(1, 0, 0) }
      },
      vertexShader: [
        'varying vec2 vUv;',
        'varying vec3 vNormalW;',
        'void main() {',
        '  vUv = uv;',
        '  vNormalW = normalize(mat3(modelMatrix) * normal);',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform sampler2D dayMap;',
        'uniform sampler2D nightMap;',
        'uniform vec3 sunDir;',
        'varying vec2 vUv;',
        'varying vec3 vNormalW;',
        'void main() {',
        '  float d = dot(normalize(vNormalW), sunDir);',
        '  float k = smoothstep(-0.05, 0.05, d);', // ~0.1-wide twilight band
        '  vec3 day = texture2D(dayMap, vUv).rgb * (0.16 + 0.98 * clamp(d, 0.0, 1.0));',
        '  vec3 night = texture2D(nightMap, vUv).rgb * vec3(1.05, 0.95, 0.78);',
        '  vec3 col = mix(night, day, k);',
        // samples were hardware-decoded to linear; manually re-encode to sRGB
        // (ShaderMaterial output is not auto-encoded by the renderer)
        '  gl_FragColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);',
        '}'
      ].join('\n')
    });

    earthMesh = new THREE.Mesh(geo, gset().night ? nightMat : phongMat);
    scene.add(earthMesh);

    // Atmosphere: back-side shell with an additive fresnel-ish rim glow.
    atmoMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1.045, 64, 48),
      new THREE.ShaderMaterial({
        vertexShader: [
          'varying vec3 vN;',
          'void main() {',
          '  vN = normalize(normalMatrix * normal);',
          '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
          '}'
        ].join('\n'),
        fragmentShader: [
          'varying vec3 vN;',
          'void main() {',
          '  float i = pow(clamp(0.66 - dot(vN, vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 5.0);',
          '  gl_FragColor = vec4(0.30, 0.55, 1.0, 1.0) * i * 0.65;',
          '}'
        ].join('\n'),
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false
      })
    );
    scene.add(atmoMesh);
  }

  function buildStars() {
    var pos = new Float32Array(STAR_COUNT * 3);
    for (var i = 0; i < STAR_COUNT; i++) {
      var z = Math.random() * 2 - 1;               // uniform on sphere
      var t = Math.random() * Math.PI * 2;
      var r = Math.sqrt(Math.max(0, 1 - z * z));
      pos[i * 3] = STAR_R * r * Math.cos(t);
      pos[i * 3 + 1] = STAR_R * z;
      pos[i * 3 + 2] = STAR_R * r * Math.sin(t);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    stars = new THREE.Points(g, new THREE.PointsMaterial({
      color: srgbColor('#c8d4e6'), size: 1.4, sizeAttenuation: false,
      transparent: true, opacity: 0.85, depthWrite: false
    }));
    stars.frustumCulled = false;
    stars.visible = gset().stars;
    scene.add(stars);
  }

  function buildLights() {
    sunLight = new THREE.DirectionalLight(0xffffff, 1.25);
    sunLight.position.set(8, 0, 0);
    scene.add(sunLight);
    scene.add(sunLight.target);
    ambientLight = new THREE.AmbientLight(0x222233, 0.55);
    scene.add(ambientLight);
  }

  function buildRingSprite() {
    var cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    var ctx = cv.getContext('2d');
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 9;
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    ctx.arc(64, 64, 52, 0, Math.PI * 2);
    ctx.stroke();
    var tex = new THREE.CanvasTexture(cv);
    tex.encoding = THREE.sRGBEncoding;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    ringSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false
    }));
    ringSprite.scale.set(0.075, 0.075, 1);
    ringSprite.visible = false;
    ringSprite.frustumCulled = false;
    scene.add(ringSprite);
  }

  // ---------- sun ----------
  function updateSun() {
    var sp;
    try { sp = SAT.util.sunSubpoint(curDate); } catch (e) { return; }
    if (!sp) return;
    geoToScene(sp.latDeg, sp.lonDeg, 1, sunDirVec).normalize();
    sunLight.position.copy(sunDirVec).multiplyScalar(8);
    nightMat.uniforms.sunDir.value.copy(sunDirVec);
  }

  // ---------- satellite pool ----------
  function labelText(sat) {
    return sat.name || ('#' + sat.norad);
  }

  function periodMsOf(sat) {
    var m = 90;
    try {
      var p = SAT.prop.periodMinutes(sat);
      if (isFinite(p) && p > 1) m = p;
    } catch (e) { /* default */ }
    return m * 60000;
  }

  function createSatEntry(sat) {
    var col = srgbColor(sat.color);
    var marker = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color: col }));
    var pick = new THREE.Mesh(pickGeo, pickMat); // material invisible: raycast-only
    pick.userData.satId = sat.id;
    var label = makeLabelSprite(labelText(sat), sat.color, LABEL_H);
    var orbit = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.55 })
    );
    var track = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.8 })
    );
    // eclipsed (Earth-shadow) part of the ground track, drawn faint
    var trackDim = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.22 })
    );
    var footGeo = new THREE.BufferGeometry();
    footGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(FOOT_CAP * 3), 3));
    footGeo.setDrawRange(0, 0);
    var foot = new THREE.LineLoop(
      footGeo,
      new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.35 })
    );
    [marker, pick, label, orbit, track, trackDim, foot].forEach(function (o) {
      o.frustumCulled = false;
      o.visible = false;
    });
    scene.add(marker, pick, label, track, trackDim, foot);
    eciGroup.add(orbit);
    return {
      sat: sat, marker: marker, pick: pick, label: label,
      orbit: orbit, track: track, trackDim: trackDim, foot: foot,
      labelKey: label.userData.labelKey, color: sat.color, name: labelText(sat),
      builtMs: -Infinity, periodMs: periodMsOf(sat),
      orbitCount: 0, trackCount: 0, trackDimCount: 0, footCount: 0
    };
  }

  function refreshSatEntry(e, sat) {
    e.sat = sat;
    e.pick.userData.satId = sat.id;
    e.periodMs = periodMsOf(sat);
    var name = labelText(sat);
    if (e.color !== sat.color || e.name !== name) {
      releaseLabel(e.labelKey);
      var lbl = acquireLabel(name, sat.color);
      e.label.material.map = lbl.tex;
      e.label.material.needsUpdate = true;
      e.label.scale.set(LABEL_H * lbl.aspect, LABEL_H, 1);
      e.label.userData.aspect = lbl.aspect;
      e.labelKey = lbl.key;
      e.name = name;
    }
    if (e.color !== sat.color) {
      var col = srgbColor(sat.color);
      e.marker.material.color.copy(col);
      e.orbit.material.color.copy(col);
      e.track.material.color.copy(col);
      e.trackDim.material.color.copy(col);
      e.foot.material.color.copy(col);
      e.color = sat.color;
    }
  }

  function disposeSatEntry(e) {
    scene.remove(e.marker, e.pick, e.label, e.track, e.trackDim, e.foot);
    eciGroup.remove(e.orbit);
    e.marker.material.dispose();
    e.orbit.geometry.dispose();
    e.orbit.material.dispose();
    e.track.geometry.dispose();
    e.track.material.dispose();
    e.trackDim.geometry.dispose();
    e.trackDim.material.dispose();
    e.foot.geometry.dispose();
    e.foot.material.dispose();
    e.label.material.dispose();
    releaseLabel(e.labelKey);
  }

  function syncSats() {
    var list = [];
    try { list = SAT.state.allActiveSats() || []; } catch (e) { list = []; }
    var live = new Map();
    list.forEach(function (s) { live.set(s.id, s); });
    satPool.forEach(function (e, id) {
      if (!live.has(id)) {
        disposeSatEntry(e);
        satPool.delete(id);
      }
    });
    live.forEach(function (sat, id) {
      var e = satPool.get(id);
      if (e) refreshSatEntry(e, sat);
      else satPool.set(id, createSatEntry(sat));
    });
  }

  // ---------- per-tick geometry ----------
  function setLineGeometry(lineObj, arr, vertCount) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    g.setDrawRange(0, vertCount);
    var old = lineObj.geometry;
    lineObj.geometry = g;
    if (old) old.dispose();
  }

  function rebuildLines(e, nowMs) {
    e.builtMs = nowMs;

    // Orbit: ECI samples mapped with the axis swap only; the parent eciGroup's
    // rotation.y = -gmst performs the rigid ECI->ECEF rotation every tick.
    var pts = null;
    try { pts = SAT.prop.orbitEci(e.sat, curDate, ORBIT_N); } catch (err) { pts = null; }
    e.orbitCount = 0;
    if (pts && pts.length > 1) {
      var arr = new Float32Array(pts.length * 3);
      var n = 0;
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        if (!p) continue;
        arr[n * 3] = p.x * invRe;
        arr[n * 3 + 1] = p.z * invRe;
        arr[n * 3 + 2] = -p.y * invRe;
        n++;
      }
      if (n > 1) setLineGeometry(e.orbit, arr, n);
      e.orbitCount = n;
    }

    // Ground track: surface polyline in the ECEF/scene frame, broken at nulls
    // (antimeridian splits) by emitting independent segments.
    var gt = null;
    try { gt = SAT.prop.groundTrack(e.sat, curDate, 0, 0); } catch (err) { gt = null; }
    e.trackCount = 0;
    e.trackDimCount = 0;
    var tp = gt && gt.points;
    if (tp && tp.length > 1) {
      // sunlit segments -> bright line; Earth-shadow segments -> faint line
      var seg = new Float32Array((tp.length - 1) * 6);
      var segDim = new Float32Array((tp.length - 1) * 6);
      var m = 0, md = 0;
      for (var j = 0; j < tp.length - 1; j++) {
        var a = tp[j], b = tp[j + 1];
        if (!a || !b) continue;
        geoToScene(a.latDeg, a.lonDeg, SURF_R, tmpV);
        geoToScene(b.latDeg, b.lonDeg, SURF_R, tmpV2);
        var dst = b.sunlit === false ? segDim : seg;
        var k = b.sunlit === false ? md++ : m++;
        dst[k * 6] = tmpV.x; dst[k * 6 + 1] = tmpV.y; dst[k * 6 + 2] = tmpV.z;
        dst[k * 6 + 3] = tmpV2.x; dst[k * 6 + 4] = tmpV2.y; dst[k * 6 + 5] = tmpV2.z;
      }
      if (m > 0) setLineGeometry(e.track, seg, m * 2);
      if (md > 0) setLineGeometry(e.trackDim, segDim, md * 2);
      e.trackCount = m * 2;
      e.trackDimCount = md * 2;
    }
  }

  function updateFootprint(e, g) {
    var ring = null;
    try { ring = SAT.prop.footprint(g.latDeg, g.lonDeg, g.heightKm, FOOT_N); } catch (err) { ring = null; }
    e.footCount = 0;
    if (!ring || ring.length < 3) return;
    var attr = e.foot.geometry.getAttribute('position');
    var n = Math.min(ring.length, FOOT_CAP);
    for (var i = 0; i < n; i++) {
      geoToScene(ring[i].latDeg, ring[i].lonDeg, SURF_R, tmpV);
      attr.setXYZ(i, tmpV.x, tmpV.y, tmpV.z);
    }
    attr.needsUpdate = true;
    e.foot.geometry.setDrawRange(0, n);
    e.footCount = n;
  }

  function updateSatEntry(e, nowMs, force) {
    var show = e.sat.show || {};
    var g = null;
    try { g = SAT.prop.geodetic(e.sat, curDate); } catch (err) { g = null; }
    if (!g) {
      // SGP4 failed at this epoch: silently hide everything for this sat.
      e.marker.visible = e.pick.visible = e.label.visible = false;
      e.foot.visible = e.orbit.visible = e.track.visible = e.trackDim.visible = false;
      return;
    }
    eciToScene(g.eciPos, g.gmst, e.marker.position);
    e.pick.position.copy(e.marker.position);
    e.label.position.copy(e.marker.position);
    e.marker.visible = true;
    e.pick.visible = true;
    e.label.visible = show.label !== false;

    var wantFoot = show.footprint !== false;
    if (wantFoot) updateFootprint(e, g);
    e.foot.visible = wantFoot && e.footCount > 2;

    if (force || Math.abs(nowMs - e.builtMs) > e.periodMs / 8) rebuildLines(e, nowMs);
    e.orbit.visible = show.orbit !== false && e.orbitCount > 1;
    e.track.visible = show.groundTrack !== false && e.trackCount > 1;
    e.trackDim.visible = show.groundTrack !== false && e.trackDimCount > 1;
  }

  function updateSelectionVisuals() {
    var selPos = null;
    satPool.forEach(function (e, id) {
      // marker scale is set per-frame in rescaleScreenItems (constant screen size)
      if (id === selectedId && e.marker.visible) selPos = e.marker.position;
    });
    selScenePos = selPos;
    if (selPos) {
      ringSprite.visible = true;
      ringSprite.position.copy(selPos);
    } else {
      ringSprite.visible = false;
    }
  }

  function updateScene(force) {
    if (!curDate) {
      try { curDate = SAT.clock.getDate(); } catch (e) { return; }
    }
    var gmst;
    try { gmst = satellite.gstime(curDate); } catch (e) { return; }
    eciGroup.rotation.y = -gmst;
    updateSun();
    var nowMs = curDate.getTime();
    satPool.forEach(function (e) { updateSatEntry(e, nowMs, force); });
    updateSelectionVisuals();
  }

  function doUpdate() {
    var f = pendingForce;
    pendingForce = false;
    updateScene(f);
  }

  function kick() {
    if (winRef && winRef.isOpen()) doUpdate();
    else needsFullUpdate = true;
  }

  // ---------- stations ----------
  function disposeStation(st) {
    scene.remove(st.cone, st.label);
    st.cone.material.dispose();
    st.label.material.dispose();
    releaseLabel(st.labelKey);
  }

  function syncStations() {
    stationPool.forEach(disposeStation);
    stationPool.clear();
    var locs = (SAT.state && SAT.state.locations) || [];
    locs.forEach(function (loc) {
      if (loc.show === false) return;
      var color = loc.color || '#ff5252';
      var dir = geoToScene(loc.latDeg, loc.lonDeg, 1, new THREE.Vector3()).normalize();
      var rSurf = 1 + ((loc.altM || 0) / 1000) * invRe;
      var cone = new THREE.Mesh(coneGeo, new THREE.MeshBasicMaterial({ color: srgbColor(color) }));
      cone.position.copy(dir).multiplyScalar(rSurf + CONE_H / 2);
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir); // tip outward
      var label = makeLabelSprite(loc.name || 'Station', color, LABEL_H_ST);
      label.position.copy(dir).multiplyScalar(rSurf + CONE_H + 0.012);
      scene.add(cone, label);
      stationPool.set(loc.id, { cone: cone, label: label, labelKey: label.userData.labelKey,
                                dir: dir, rSurf: rSurf });
    });
  }

  // ---------- picking ----------
  function onPointerDown(ev) {
    pdX = ev.clientX;
    pdY = ev.clientY;
  }

  function onPointerUp(ev) {
    if (ev.button !== 0 || pdX === null) return;
    var moved = Math.hypot(ev.clientX - pdX, ev.clientY - pdY);
    pdX = pdY = null;
    if (moved > CLICK_SLOP_PX) return; // it was an orbit drag, not a click
    var rect = renderer.domElement.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    mouseNdc.set(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(mouseNdc, camera);
    var targets = [];
    satPool.forEach(function (e) { if (e.pick.visible) targets.push(e.pick); });
    var hits = raycaster.intersectObjects(targets, false);
    try {
      SAT.state.clickSelect(hits.length ? hits[0].object.userData.satId : null);
    } catch (err) { /* ignore */ }
  }

  // ---------- toolbar UI (one-line, 2D-map / sky-chart button style) ----------
  function injectStyle() {
    if (document.getElementById('g3d-style')) return;
    var st = document.createElement('style');
    st.id = 'g3d-style';
    st.textContent = [
      '.g3d-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;}',
      '.g3d-toolbar{position:absolute;top:6px;left:6px;display:flex;gap:3px;',
      ' z-index:10;opacity:.85;}',
      '.g3d-toolbar:hover{opacity:1;}',
      '.g3d-tbtn{min-width:26px;padding:2px 6px;}',
      '.g3d-tbtn.g3d-on{outline:1px solid #4fc3f7;color:#4fc3f7;}'
    ].join('\n');
    document.head.appendChild(st);
  }

  function buildOverlay() {
    var bar = document.createElement('div');
    bar.className = 'g3d-toolbar';
    function tbtn(label, title, onclick) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn small g3d-tbtn';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', onclick);
      bar.appendChild(b);
      return b;
    }
    nightBtn = tbtn('NL', 'night lights', function () {
      writeSetting('showNightLights', !gset().night);
    });
    starsBtn = tbtn('✶', 'stars', function () {
      writeSetting('showStars', !gset().stars);
    });
    followBtn = tbtn('FS', 'follow selected satellite', function () {
      followOn = !followOn;
      followBtn.classList.toggle('g3d-on', followOn);
      requestRender();
    });
    tbtn('⟲', 'reset view', resetView);
    bodyEl.appendChild(bar);
  }

  function resetView() {
    followOn = false;
    if (followBtn) followBtn.classList.remove('g3d-on');
    controls.target.set(0, 0, 0);
    camera.position.copy(HOME_POS);
    camera.up.set(0, 1, 0);
    controls.update();
  }

  // ---------- resize / render loop ----------
  function onResize() {
    if (!renderer) return;
    var w = bodyEl.clientWidth, h = bodyEl.clientHeight;
    if (w < 2 || h < 2) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  // Labels AND markers keep a constant on-screen size: world scale grows with
  // the camera-to-object distance (same behaviour as the pixel-sized 2D map).
  var RING_BASE = 0.075;

  function rescaleLabel(sprite) {
    if (!sprite.visible) return;
    var h = (sprite.userData.baseH || LABEL_H) *
            camera.position.distanceTo(sprite.position) / REF_DIST;
    sprite.scale.set(h * (sprite.userData.aspect || 6), h, 1);
  }

  function rescaleScreenItems() {
    var camPos = camera.position;
    satPool.forEach(function (e, id) {
      rescaleLabel(e.label);
      if (!e.marker.visible) return;
      var k = camPos.distanceTo(e.marker.position) / REF_DIST;
      e.marker.scale.setScalar(k * (id === selectedId ? 1.6 : 1));
      e.pick.scale.setScalar(k); // click target tracks the visual size
    });
    if (ringSprite.visible) {
      var kr = camPos.distanceTo(ringSprite.position) / REF_DIST;
      ringSprite.scale.set(RING_BASE * kr, RING_BASE * kr, 1);
    }
    stationPool.forEach(function (st) {
      var k = camPos.distanceTo(st.cone.position) / REF_DIST;
      st.cone.scale.setScalar(k);
      // keep the scaled cone sitting on the surface, label just above its tip
      st.cone.position.copy(st.dir).multiplyScalar(st.rSurf + CONE_H * k / 2);
      st.label.position.copy(st.dir).multiplyScalar(st.rSurf + (CONE_H + 0.012) * k);
      rescaleLabel(st.label);
    });
  }

  function frame() {
    requestAnimationFrame(frame);
    var open = false;
    try { open = winRef.isOpen(); } catch (e) { open = false; }
    if (!open) {
      wasOpen = false;
      return; // window closed: skip all render work
    }
    if (!wasOpen) {
      wasOpen = true;
      onResize();
      needsFullUpdate = true;
    }
    if (needsFullUpdate) {
      needsFullUpdate = false;
      doUpdate();
    }
    if (followOn && selScenePos) {
      // nadir view: camera rides directly above the selected sat, looking
      // straight down through it at the Earth (zoom still works)
      var dist = Math.max(camera.position.length(), 1.06);
      tmpV.copy(selScenePos).normalize().multiplyScalar(dist);
      camera.position.lerp(tmpV, 0.2);
      controls.target.set(0, 0, 0);
    }
    controls.update();
    rescaleScreenItems();
    renderer.render(scene, camera);
  }

  // ---------- bus handlers ----------
  function onTime(payload) {
    if (payload && payload.date) curDate = payload.date;
    if (payload && payload.jumped) pendingForce = true;
    kick();
  }

  function onSatsChanged() {
    syncSats();
    pendingForce = true; // TLEs may have been replaced in place: rebuild orbit/track lines
    kick();
  }

  function onStateLoaded() {
    applySettings();
    syncSats();
    syncStations();
    selectedId = (SAT.state.selection && SAT.state.selection.satId) || null;
    pendingForce = true;
    kick();
  }

  function onLocationsChanged() {
    syncStations();
    requestRender();
  }

  function onSelectionChanged(payload) {
    selectedId = payload ? payload.satId : null;
    updateSelectionVisuals();
    requestRender();
  }

  function onSettingsChanged(payload) {
    if (payload && payload.section && payload.section !== 'globe3d') return;
    applySettings();
  }

  // ---------- public API ----------
  function init(body, win) {
    bodyEl = body;
    winRef = win;
    win.noScroll = true;

    if (!window.THREE) {
      bodyEl.textContent = '3D view unavailable: three.js failed to load.';
      return;
    }

    invRe = 1 / SAT.prop.Re;
    HOME_POS = new THREE.Vector3(2.2, 1.3, 1.8);
    sunDirVec = new THREE.Vector3(1, 0, 0);
    tmpV = new THREE.Vector3();
    tmpV2 = new THREE.Vector3();
    mouseNdc = new THREE.Vector2();

    injectStyle();

    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    } catch (e) {
      bodyEl.textContent = '3D view unavailable: WebGL context could not be created.';
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x05070c, 1);
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.domElement.className = 'g3d-canvas';
    bodyEl.appendChild(renderer.domElement);
    buildOverlay();

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(45, 1, 0.01, 300);
    camera.position.copy(HOME_POS);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 1.06;
    controls.maxDistance = 8;
    controls.zoomSpeed = 0.6;
    controls.rotateSpeed = 0.55;
    controls.enablePan = false;

    raycaster = new THREE.Raycaster();

    eciGroup = new THREE.Group();
    scene.add(eciGroup);

    markerGeo = new THREE.SphereGeometry(MARKER_R, 10, 8);
    pickGeo = new THREE.SphereGeometry(PICK_R, 8, 6);
    pickMat = new THREE.MeshBasicMaterial({ visible: false }); // raycast-only
    coneGeo = new THREE.ConeGeometry(0.014, CONE_H, 10);

    buildEarth();
    buildStars();
    buildLights();
    buildRingSprite();
    applySettings();

    // Initial content (state may still be loading; 'state-loaded' rebuilds).
    curDate = null;
    try { curDate = SAT.clock.getDate(); } catch (e) { /* set on first tick */ }
    syncSats();
    syncStations();
    selectedId = (SAT.state.selection && SAT.state.selection.satId) || null;
    pendingForce = true;
    needsFullUpdate = true;

    SAT.bus.on('time', onTime);
    SAT.bus.on('sats-changed', onSatsChanged);
    SAT.bus.on('state-loaded', onStateLoaded);
    SAT.bus.on('locations-changed', onLocationsChanged);
    SAT.bus.on('selection-changed', onSelectionChanged);
    SAT.bus.on('settings-changed', onSettingsChanged);

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);

    bodyEl.addEventListener('win-resize', onResize);
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(onResize).observe(bodyEl);
    }
    onResize();
    requestAnimationFrame(frame);
  }

  function requestRender() {
    // Rendering is continuous while the window is open; flag a full scene
    // refresh so the next frame repositions everything.
    needsFullUpdate = true;
  }

  SAT.globe3d = { init: init, requestRender: requestRender };
})();
