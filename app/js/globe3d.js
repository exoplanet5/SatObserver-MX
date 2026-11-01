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
  var TERM_R = 1.003;        // terminator ring radius (just above tracks)
  var TERM_N = 256;
  var DAY_TEX = 'assets/earth_day_8k.webp';   // Blue Marble NG Sept 2004, 8192x4096
  var DAY_TEX_FALLBACK = 'assets/earth_day.jpg';
  var NIGHT_TEX = 'assets/earth_night_8k.webp'; // Black Marble 2016 (VIIRS), 8192x4096
  var NIGHT_TEX_FALLBACK = 'assets/earth_night.jpg';
  var CLICK_SLOP_PX = 5;
  var REF_DIST = 3.126;      // |HOME_POS|: label world-height is defined at this camera distance

  // ---------- module state ----------
  var bodyEl = null, winRef = null;
  var renderer = null, scene = null, camera = null, controls = null, raycaster = null;
  var earthMesh, dayTex, nightTex, phongMat, nightMat, atmoMesh, stars, milkyWay;
  var sunLight, ambientLight, termLine;
  var eciGroup;                       // orbit lines live here; rotation.y = -gmst
  var skyGroup;                       // stars + Milky Way, also rotated by -gmst
  var ringSprite;                     // selection highlight ring
  var markerGeo, pickGeo, coneGeo, pickMat;
  var satPool = new Map();            // satId -> entry
  var stationPool = new Map();        // locId -> {cone,label,labelKey}
  var labelCache = new Map();         // "text|color" -> {tex,aspect,refs}
  var curDate = null, invRe = 1 / 6371.0;
  var selectedId = null, selScenePos = null;
  var pendingForce = false, needsFullUpdate = true, wasOpen = false;
  // render on demand: scene refresh when the clock moved enough, redraw when
  // the scene or camera changed (an idle, paused globe costs nothing)
  var timeDirty = false, needRender = true, lastUpdMs = NaN, lastUpdWall = 0;
  var REBUILD_BUDGET_MS = 4, rebuildDeadline = 0;   // per-update orbit/track refresh budget
  var nightBtn, termBtn, starsBtn, followBtn;
  var followOn = false;
  var pdX = null, pdY = null;
  var HOME_POS = null, Y_AXIS = null; // set in init (THREE not loaded yet here)
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
    return { night: s.showNightLights !== false, stars: s.showStars !== false,
             term: s.showTerminator !== false };
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
    if (termBtn) termBtn.classList.toggle('g3d-on', !!s.term);
    if (starsBtn) starsBtn.classList.toggle('g3d-on', !!s.stars);
    if (earthMesh) earthMesh.material = s.night ? nightMat : phongMat;
    if (stars) stars.visible = s.stars;
    if (milkyWay) milkyWay.visible = s.stars;
    if (termLine) termLine.visible = s.term;
    requestRender();
  }

  // ---------- scene construction ----------
  // 8K WebP where the GPU takes it; the older, smaller JPEG otherwise (or if
  // the WebP cannot be decoded)
  function loadTex(loader, big, url, fallback) {
    var tex = loader.load(big ? url : fallback, requestRender, undefined, function () {
      if (!big) return;
      new THREE.ImageLoader().load(fallback, function (img) {
        tex.image = img;
        tex.needsUpdate = true;
        requestRender();
      });
    });
    return tex;
  }

  function buildEarth() {
    var loader = new THREE.TextureLoader();
    var big = renderer.capabilities.maxTextureSize >= 8192;
    dayTex = loadTex(loader, big, DAY_TEX, DAY_TEX_FALLBACK);
    nightTex = loadTex(loader, big, NIGHT_TEX, NIGHT_TEX_FALLBACK);
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
        // Black Marble colours are natural already (warm lights, moonlit
        // navy terrain): lift the lights (~2x linear) so cities read at globe
        // scale, but keep the faint terrain near its own dark level
        '  vec3 n = texture2D(nightMap, vUv).rgb;',
        '  float L = max(n.r, max(n.g, n.b));',
        '  vec3 night = n * mix(0.85, 2.2, smoothstep(0.03, 0.35, L));',
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

  // ---------- sky: real stars + Milky Way, fixed in the inertial frame ----------
  // Both live in skyGroup (rotation.y = -gmst, like the orbit lines) and are
  // drawn at infinity: the vertex shaders apply only the camera ROTATION, so
  // orbiting the globe never shifts the stars against each other. RA/Dec map
  // to the scene exactly like lon/lat (geoToScene) since ECI is the sky frame.
  var SKY_VS_HEAD = 'vec4 skyPos(vec3 dir, float r) {' +
    '  return projectionMatrix * vec4(mat3(viewMatrix) * (mat3(modelMatrix) * dir) * r, 1.0);' +
    '}\n';

  // B-V colour index -> display RGB: Ballesteros (2012) temperature, then a
  // blackbody fit (T. Helland), pulled 45% toward white — stars look tinted,
  // not painted.
  function bvToRgb(bv) {
    var T = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
    var t = T / 100, r, g, b;
    r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661
                : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = t >= 66 ? 255 : (t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307);
    var c = [r, g, b].map(function (v) { return Math.max(0, Math.min(255, v)) / 255; });
    var mx = Math.max(c[0], c[1], c[2]) || 1;
    return c.map(function (v) { return 0.45 + 0.55 * v / mx; });
  }

  function buildStars() {
    var cat = SAT.bsc5;
    if (!cat || !cat.data) return;
    var bin = atob(cat.data), n = cat.n;
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var dv = new DataView(bytes.buffer);
    var pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    var size = new Float32Array(n), v3 = new THREE.Vector3();
    for (i = 0; i < n; i++) {
      var ra = dv.getUint16(i * 8, true) / 100, de = dv.getInt16(i * 8 + 2, true) / 100;
      var V = dv.getInt16(i * 8 + 4, true) / 100, bvRaw = dv.getInt16(i * 8 + 6, true);
      geoToScene(de, ra, 1, v3);
      pos[i * 3] = v3.x; pos[i * 3 + 1] = v3.y; pos[i * 3 + 2] = v3.z;
      // brightness linear in magnitude (log flux), sprite size likewise
      var k = Math.max(0.25, Math.min(1, 0.25 + 0.75 * (6.8 - V) / 6.3));
      var c = bvToRgb(bvRaw === -32768 ? 0.65 : bvRaw / 1000);
      col[i * 3] = c[0] * k; col[i * 3 + 1] = c[1] * k; col[i * 3 + 2] = c[2] * k;
      size[i] = Math.max(2.2, Math.min(7.5, 2.2 + 0.6 * (6.5 - V)));
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    stars = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: { uScale: { value: renderer.getPixelRatio() } },
      vertexShader: SKY_VS_HEAD + [
        'attribute vec3 aColor;',
        'attribute float aSize;',
        'uniform float uScale;',
        'varying vec3 vColor;',
        'void main() {',
        '  vColor = aColor;',
        '  gl_Position = skyPos(position, 100.0);',
        '  gl_PointSize = aSize * uScale;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'varying vec3 vColor;',
        'void main() {',
        '  vec2 d = gl_PointCoord - 0.5;',
        '  float a = exp(-dot(d, d) * 16.0);',    // soft round PSF
        '  gl_FragColor = vec4(vColor, a);',
        '}'
      ].join('\n'),
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false
    }));
    stars.frustumCulled = false;
    stars.renderOrder = -1;
    stars.visible = gset().stars;
    skyGroup.add(stars);
  }

  // Milky Way: the d3-celestial isophotes (SAT.mwdata, RA/Dec rings) painted
  // into an equirectangular texture, softened, and mapped on a sphere at
  // infinity — same RA/Dec <-> UV layout as the Earth texture's lon/lat.
  function mwTexture() {
    var mw = SAT.mwdata;
    if (!mw || !mw.levels) return null;
    var W = 1024, H = 512;
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var c = cv.getContext('2d');
    c.fillStyle = '#000';
    c.fillRect(0, 0, W, H);
    c.globalCompositeOperation = 'lighter';
    function X(ra) { return (ra + 180) / 360 * W; }
    function Y(de) { return (90 - de) / 180 * H; }
    // north galactic pole: outside every isophote, so its even-odd parity
    // must come out "outside" — a level whose rings say otherwise is flipped
    var gpx = X(192.859 - 360), gpy = Y(27.128);
    mw.levels.forEach(function (lev) {
      var path = new Path2D(), inside = false;
      lev.rings.forEach(function (ring) {
        // unwrap RA along the ring; a ring circling a celestial pole winds
        // once (net +-360) and is closed along the top edge instead
        var pts = [], prev = null;
        ring.forEach(function (p) {
          var ra = p[0];
          if (prev !== null) {
            while (ra - prev > 180) ra -= 360;
            while (ra - prev < -180) ra += 360;
          }
          pts.push([ra, p[1]]);
          prev = ra;
        });
        var close = pts[0][0] - prev;
        while (close > 180) close -= 360;
        while (close < -180) close += 360;
        var wind = Math.round((prev + close - pts[0][0]) / 360);
        for (var k = -1; k <= 1; k++) {
          var poly = pts.map(function (q) { return [X(q[0] + 360 * k), Y(q[1])]; });
          if (wind) {
            var endX = X(pts[0][0] + 360 * wind + 360 * k);
            poly.push([endX, Y(pts[0][1])], [endX, -4], [poly[0][0], -4]);
          }
          path.moveTo(poly[0][0], poly[0][1]);
          for (var j = 1; j < poly.length; j++) path.lineTo(poly[j][0], poly[j][1]);
          path.closePath();
          // even-odd parity of the galactic pole against this polygon
          for (var a = 0, b = poly.length - 1; a < poly.length; b = a++) {
            if ((poly[a][1] > gpy) !== (poly[b][1] > gpy) &&
                gpx < (poly[b][0] - poly[a][0]) * (gpy - poly[a][1]) /
                      (poly[b][1] - poly[a][1]) + poly[a][0]) inside = !inside;
          }
        }
      });
      if (inside) path.rect(-8, -8, W + 16, H + 16);
      c.fillStyle = 'rgba(255,255,255,' + Math.min(1, lev.a * 4.0).toFixed(3) + ')';
      c.fill(path, 'evenodd');
    });
    // soften the contour steps into a diffuse glow (~2°): a real blur where
    // the canvas supports filters, else a 4x down- and up-sample
    var sm = document.createElement('canvas');
    var sc = sm.getContext('2d');
    if (typeof sc.filter === 'string') {
      sm.width = W; sm.height = H;
      sc.filter = 'blur(6px)';
      sc.drawImage(cv, 0, 0);
    } else {
      sm.width = W / 4; sm.height = H / 4;
      sc.imageSmoothingQuality = 'high';
      sc.drawImage(cv, 0, 0, sm.width, sm.height);
    }
    c.globalCompositeOperation = 'copy';
    c.imageSmoothingQuality = 'high';
    c.drawImage(sm, 0, 0, W, H);
    var tex = new THREE.CanvasTexture(cv);
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    return tex;
  }

  function buildMilkyWay() {
    var tex = mwTexture();
    if (!tex) return;
    milkyWay = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, uGain: { value: 0.42 } },
      vertexShader: SKY_VS_HEAD + [
        'varying vec2 vUv;',
        'void main() { vUv = uv; gl_Position = skyPos(position, 150.0); }'
      ].join('\n'),
      fragmentShader: [
        'uniform sampler2D map;',
        'uniform float uGain;',
        'varying vec2 vUv;',
        'void main() {',
        '  float v = texture2D(map, vUv).r;',
        '  gl_FragColor = vec4(vec3(0.60, 0.68, 0.86) * v * uGain, 1.0);',
        '}'
      ].join('\n'),
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      transparent: true, depthWrite: false
    }));
    milkyWay.frustumCulled = false;
    milkyWay.renderOrder = -2;
    milkyWay.visible = gset().stars;
    skyGroup.add(milkyWay);
  }

  // Day/night terminator: a great circle normal to the sun direction, built
  // once in the XZ plane and turned toward the sun every update.
  function buildTerminator() {
    var pos = new Float32Array(TERM_N * 3);
    for (var i = 0; i < TERM_N; i++) {
      var a = i / TERM_N * Math.PI * 2;
      pos[i * 3] = Math.cos(a) * TERM_R;
      pos[i * 3 + 2] = Math.sin(a) * TERM_R;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    termLine = new THREE.LineLoop(g, new THREE.LineBasicMaterial({
      color: srgbColor('#ffd54f'), transparent: true, opacity: 0.75, depthWrite: false
    }));
    termLine.frustumCulled = false;
    termLine.visible = gset().term;
    scene.add(termLine);
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
    termLine.quaternion.setFromUnitVectors(Y_AXIS, sunDirVec);
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

  // Only the lines actually shown are sampled (a label-only sat costs no
  // SGP4 runs here); wantOrbit/wantTrack are remembered so turning a toggle
  // on later triggers a build.
  function rebuildLines(e, nowMs, wantOrbit, wantTrack) {
    e.builtMs = nowMs;
    e.builtOrbit = wantOrbit;
    e.builtTrack = wantTrack;

    // Orbit: ECI samples mapped with the axis swap only; the parent eciGroup's
    // rotation.y = -gmst performs the rigid ECI->ECEF rotation every tick.
    var pts = null;
    if (wantOrbit) {
      try { pts = SAT.prop.orbitEci(e.sat, curDate, ORBIT_N); } catch (err) { pts = null; }
    }
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

    // Ground track: surface polyline in the ECEF/scene frame as independent
    // segments; a null sample (propagation gap) breaks it.
    var gt = null;
    if (wantTrack) {
      try { gt = SAT.prop.groundTrack(e.sat, curDate, 0, 0); } catch (err) { gt = null; }
    }
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

    var wantOrbit = show.orbit !== false, wantTrack = show.groundTrack !== false;
    if (force || e.builtOrbit !== wantOrbit || e.builtTrack !== wantTrack) {
      rebuildLines(e, nowMs, wantOrbit, wantTrack);
    } else if ((wantOrbit || wantTrack) && Math.abs(nowMs - e.builtMs) > e.periodMs / 8) {
      // routine refresh: lines drift slowly, so past the frame's time budget
      // they wait for the next update instead of piling into one long frame
      if (performance.now() < rebuildDeadline) rebuildLines(e, nowMs, wantOrbit, wantTrack);
    }
    e.orbit.visible = wantOrbit && e.orbitCount > 1;
    e.track.visible = wantTrack && e.trackCount > 1;
    e.trackDim.visible = wantTrack && e.trackDimCount > 1;
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
    skyGroup.rotation.y = -gmst;
    updateSun();
    var nowMs = curDate.getTime();
    rebuildDeadline = performance.now() + REBUILD_BUDGET_MS;
    satPool.forEach(function (e) { updateSatEntry(e, nowMs, force); });
    updateSelectionVisuals();
  }

  function doUpdate() {
    var f = pendingForce;
    pendingForce = false;
    timeDirty = false;
    updateScene(f);
    lastUpdMs = curDate ? curDate.getTime() : NaN;
    lastUpdWall = performance.now();
    needRender = true;
  }

  // the next frame refreshes the scene (frame() skips all work while closed)
  function kick() {
    needsFullUpdate = true;
  }

  // Sim time that moves the fastest LEO sat (~7.8 km/s) by ~0.3 px at the
  // current zoom; clock ticks closer together than this skip the (SGP4-heavy)
  // scene refresh. Follow mode rides the satellite: refresh every tick.
  function simStepMs() {
    if (followOn) return 0;
    var surf = Math.max(camera.position.length() - 1, 0.02);
    var kmPerPx = 6371 * 2 * surf * Math.tan(camera.fov * Math.PI / 360) /
                  Math.max(1, bodyEl.clientHeight);
    return 0.3 * kmPerPx / 7.8 * 1000;
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
    termBtn = tbtn('TL', 'terminator line (day/night boundary)', function () {
      writeSetting('showTerminator', !gset().term);
    });
    starsBtn = tbtn('✶', 'stars (Yale Bright Star Catalogue, to mag 6.5) and Milky Way', function () {
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
    needRender = true;
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
    } else if (timeDirty) {
      var ms = curDate ? curDate.getTime() : NaN;
      if (pendingForce || !(Math.abs(ms - lastUpdMs) < simStepMs()) ||
          performance.now() - lastUpdWall >= 250) doUpdate();
    }
    if (followOn && selScenePos) {
      // nadir view: camera rides directly above the selected sat, looking
      // straight down through it at the Earth (zoom still works)
      var dist = Math.max(camera.position.length(), 1.06);
      tmpV.copy(selScenePos).normalize().multiplyScalar(dist);
      if (camera.position.distanceToSquared(tmpV) > 1e-12) needRender = true;
      camera.position.lerp(tmpV, 0.2);
      controls.target.set(0, 0, 0);
    }
    if (controls.update()) needRender = true;   // damping still settling
    if (!needRender) return;
    needRender = false;
    rescaleScreenItems();
    renderer.render(scene, camera);
  }

  // ---------- bus handlers ----------
  function onTime(payload) {
    if (payload && payload.date) curDate = payload.date;
    if (payload && payload.jumped) pendingForce = true;
    timeDirty = true;
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
    Y_AXIS = new THREE.Vector3(0, 1, 0);
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
    // pointer handlers and resetView() run controls.update() themselves
    controls.addEventListener('change', function () { needRender = true; });

    raycaster = new THREE.Raycaster();

    eciGroup = new THREE.Group();
    scene.add(eciGroup);
    skyGroup = new THREE.Group();
    scene.add(skyGroup);

    markerGeo = new THREE.SphereGeometry(MARKER_R, 10, 8);
    pickGeo = new THREE.SphereGeometry(PICK_R, 8, 6);
    pickMat = new THREE.MeshBasicMaterial({ visible: false }); // raycast-only
    coneGeo = new THREE.ConeGeometry(0.014, CONE_H, 10);

    buildEarth();
    buildStars();
    buildMilkyWay();
    buildTerminator();
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
