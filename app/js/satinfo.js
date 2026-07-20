/* SAT.ui.satinfo — per-satellite detail window (ⓘ button in the Satellites tree) */
(function () {
  'use strict';
  const MU = 398600.4418;   // km^3/s^2
  const ReEq = 6378.137;    // km

  // CelesTrak SATCAT launch-site codes
  const SITES = {
    AFETR: 'Air Force Eastern Test Range, Florida, USA',
    AFWTR: 'Air Force Western Test Range, California, USA',
    CAS: 'Canaries Airspace (air launch)',
    DLS: 'Dombarovskiy Launch Site, Russia',
    ERAS: 'Eastern Range Airspace (air launch)',
    FRGUI: "Europe's Spaceport, Kourou, French Guiana",
    HGSTR: 'Hammaguira Space Track Range, Algeria',
    JSC: 'Jiuquan Satellite Launch Center, China',
    KODAK: 'Kodiak Launch Complex, Alaska, USA',
    KSCUT: 'Uchinoura Space Center, Japan',
    KWAJ: 'US Army Kwajalein Atoll, Marshall Islands',
    KYMSC: 'Kapustin Yar Missile and Space Complex, Russia',
    NSC: 'Naro Space Center, South Korea',
    PLMSC: 'Plesetsk Missile and Space Complex, Russia',
    RLLB: 'Rocket Lab Launch Base, Mahia, New Zealand',
    SEAL: 'Sea Launch platform (mobile)',
    SEMLS: 'Semnan Satellite Launch Site, Iran',
    SMTS: 'Shahrud Missile Test Site, Iran',
    SNMLP: 'San Marco Launch Platform, Kenya',
    SRILR: 'Satish Dhawan Space Centre, India',
    SUBL: 'Submarine launch (mobile)',
    SVOBO: 'Svobodnyy Launch Complex, Russia',
    TAISC: 'Taiyuan Space Launch Center, China',
    TANSC: 'Tanegashima Space Center, Japan',
    TNGH: 'Tonghae Satellite Launching Ground, North Korea',
    TYMSC: 'Tyuratam (Baikonur), Kazakhstan',
    VOSTO: 'Vostochny Cosmodrome, Russia',
    WLPIS: 'Wallops Island, Virginia, USA',
    WOMRA: 'Woomera, Australia',
    WRAS: 'Western Range Airspace (air launch)',
    WSC: 'Wenchang Satellite Launch Center, China',
    XICLF: 'Xichang Launch Facility, China',
    YAVNE: 'Yavne Launch Facility, Israel',
    YUN: 'Sohae Satellite Launching Station, North Korea',
  };

  let win = null, host = null, current = null;
  const satcatCache = new Map(); // norad -> record|null

  // "98067A" -> "1998-067A"
  function fmtIntl(raw) {
    const m = /^(\d{2})(\d{3})\s*([A-Z]*)$/.exec((raw || '').trim());
    if (!m) return (raw || '').trim() || '—';
    const yy = +m[1];
    return (yy >= 57 ? 1900 + yy : 2000 + yy) + '-' + m[2] + m[3];
  }

  function elements(sat) {
    // SupGP multi-segment sats: show the segment active at the sim time
    const r = SAT.prop.recFor(sat, SAT.clock.getDate());
    if (!r) return null;
    const R2D = 180 / Math.PI;
    const n = r.no_kozai || r.no;            // rad/min
    if (!n) return null;
    const nS = n / 60;                       // rad/s
    const a = Math.cbrt(MU / (nS * nS));     // km
    return {
      smaKm: a,
      ecc: r.ecco,
      incDeg: r.inclo * R2D,
      raanDeg: r.nodeo * R2D,
      aopDeg: r.argpo * R2D,
      maDeg: r.mo * R2D,
      periodMin: 2 * Math.PI / n,
      perKm: a * (1 - r.ecco) - ReEq,
      apoKm: a * (1 + r.ecco) - ReEq,
      epoch: SAT.prop.tleEpoch(sat, SAT.clock.getDate()),
    };
  }

  function ensureWindow() {
    if (win) return;
    const dt = document.getElementById('desktop');
    win = SAT.windows.register({
      id: 'satinfo', title: 'Satellite Info',
      x: Math.round(dt.clientWidth * 0.34), y: Math.round(dt.clientHeight * 0.12),
      w: 430, h: 470, minW: 360, minH: 320, open: false,
      build: body => {
        host = body;
        render(); // shows a hint when no sat picked yet (restored-open case)
      },
    });
  }

  function row(label, value, opts) {
    const U = SAT.util;
    return U.el('tr', null, [
      U.el('td', { class: 'dim', style: 'white-space:nowrap;padding:2px 10px 2px 0;vertical-align:top' }, label),
      U.el('td', { class: 'num', style: 'word-break:break-word' + ((opts && opts.style) || '') }, value),
    ]);
  }

  function render() {
    if (!host) return;
    const U = SAT.util;
    host.innerHTML = '';
    if (!current) {
      host.appendChild(U.el('div', { class: 'msg-empty' },
        'Click a ⓘ button in the Satellites window to inspect a satellite.'));
      return;
    }
    const sat = current;
    const el = elements(sat);
    const intlRaw = (sat.l1 || '').slice(9, 17);
    const f2 = v => (v == null || isNaN(v)) ? '—' : v.toFixed(2);

    const header = U.el('div', { class: 'row', style: 'gap:8px;margin-bottom:6px' }, [
      U.el('span', { style: 'display:inline-block;width:12px;height:12px;border-radius:3px;background:' + (sat.color || '#4fc3f7') }),
      U.el('b', { style: 'font-size:14px' }, sat.name || ('OBJECT ' + sat.norad)),
    ]);

    const idBody = U.el('tbody', null, [
      row('NORAD ID', String(sat.norad)),
      row('Int’l designator', fmtIntl(intlRaw)),
      row('Launch date', '…', {}),
      row('Launch site', '…', {}),
      row('Owner / type', '…', {}),
      row('Epoch (UTC)', el && el.epoch
        ? U.fmtDate(el.epoch) + '  (' + (() => {
            const d = (SAT.clock.getDate() - el.epoch) / 86400000;
            return d >= 0 ? d.toFixed(1) + ' d old' : 'in ' + (-d).toFixed(1) + ' d';
          })() + ')'
        : '—'),
      row('Source', (sat.source || '—') + (sat.fetched ? ' · fetched ' + String(sat.fetched).replace('T', ' ').slice(0, 16) : '')),
    ].concat(sat.segs && sat.segs.length > 1 ? [
      row('SupGP segments', sat.segs.length + ' fitted TLEs, epochs ' +
        String(sat.segs[0].epoch).replace('T', ' ').slice(0, 16) + ' → ' +
        String(sat.segs[sat.segs.length - 1].epoch).replace('T', ' ').slice(0, 16) +
        ' (nearest to clock time is used)'),
    ] : []));
    const launchDateCell = idBody.children[2].children[1];
    const launchSiteCell = idBody.children[3].children[1];
    const ownerCell = idBody.children[4].children[1];

    const elemRows = el ? [
      row('Perigee', f2(el.perKm) + ' km'),
      row('Apogee', f2(el.apoKm) + ' km'),
      row('Period', f2(el.periodMin) + ' min'),
      row('SMA', f2(el.smaKm) + ' km'),
      row('ECC', el.ecc.toFixed(7)),
      row('INC', f2(el.incDeg) + ' °'),
      row('RAAN', f2(el.raanDeg) + ' °'),
      row('AOP', f2(el.aopDeg) + ' °'),
      row('Mean anomaly', f2(el.maDeg) + ' °'),
    ] : [row('Elements', 'TLE could not be parsed')];

    host.appendChild(U.el('div', { class: 'pane' }, [
      header,
      U.el('table', { style: 'border-collapse:collapse;font-size:12px' }, idBody),
      U.el('div', { class: 'sep' }),
      U.el('div', { class: 'dim', style: 'font-size:11px;margin-bottom:2px' },
        'Mean orbital elements at epoch (from TLE)'),
      U.el('table', { style: 'border-collapse:collapse;font-size:12px' },
        U.el('tbody', null, elemRows)),
      U.el('div', { class: 'sep' }),
      U.el('div', { class: 'mono dim', style: 'font-size:10px;white-space:pre;overflow-x:auto' },
        (sat.l1 || '') + '\n' + (sat.l2 || '')),
    ]));

    // SATCAT lookup (launch date/site/owner) — async fill
    const applyRec = rec => {
      if (current !== sat) return; // window has moved on to another sat
      if (!rec) {
        launchDateCell.textContent = '—';
        launchSiteCell.textContent = '—';
        ownerCell.textContent = '—';
        return;
      }
      launchDateCell.textContent = rec.LAUNCH_DATE || '—';
      const site = (rec.LAUNCH_SITE || '').trim();
      launchSiteCell.textContent = site ? (SITES[site] ? site + ' — ' + SITES[site] : site) : '—';
      ownerCell.textContent = [(rec.OWNER || '').trim(), (rec.OBJECT_TYPE || '').trim()]
        .filter(Boolean).join(' / ') || '—';
    };
    if (satcatCache.has(sat.norad)) {
      applyRec(satcatCache.get(sat.norad));
    } else {
      fetch('/api/satcat?norad=' + sat.norad)
        .then(r => r.json())
        .then(d => {
          const rec = (d && d.ok) ? (d.record || null) : null;
          satcatCache.set(sat.norad, rec);
          applyRec(rec);
        })
        .catch(() => {
          if (current === sat) {
            launchDateCell.textContent = 'lookup failed';
            launchSiteCell.textContent = 'lookup failed';
            ownerCell.textContent = '—';
          }
        });
    }
  }

  function show(sat) {
    ensureWindow();
    current = sat;
    win.setTitle('Satellite Info — ' + (sat.name || sat.norad));
    if (host) render();
    win.open();
    win.focus();
  }

  SAT.ui.satinfo = { show };
})();
