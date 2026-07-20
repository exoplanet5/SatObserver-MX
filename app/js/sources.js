/* SAT.ui.sources — TLE sources window: CelesTrak, Space-Track, McCants, paste, cache */
(function () {
  'use strict';

  async function api(path, opts) {
    const r = await fetch(path, opts);
    let data = null;
    try { data = await r.json(); } catch (e) { /* fallthrough */ }
    if (!data) throw new Error('Bad response from backend (' + r.status + ')');
    if (data.ok === false) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
  }

  function acceptPayload(payload, status) {
    SAT.state.catalog = payload;
    SAT.bus.emit('catalog-changed', {});
    const n = payload.count != null ? payload.count : (payload.tles || []).length;
    status.textContent = '✓ ' + n + ' objects loaded from ' + payload.source +
      (payload.stale ? ' (stale cache — network failed)' : '');
    status.className = 'dim';
    const w = SAT.windows.get('catalog');
    if (w) { w.open(); w.focus(); }
  }

  function busy(btn, status, msg) {
    btn.disabled = true;
    status.textContent = msg;
    status.className = 'dim';
  }
  function fail(btn, status, e) {
    btn.disabled = false;
    status.textContent = '✗ ' + (e && e.message ? e.message : e);
    status.className = 'err';
  }

  function init(body, win) {
    const U = SAT.util;
    const tabs = ['CelesTrak', 'CelesTrak SupGP', 'Space-Track', 'McCants', 'Paste TLE', 'Cache'];
    const panes = {};
    const tabBtns = {};
    const tabBar = U.el('div', { class: 'row', style: 'gap:2px;margin-bottom:8px;flex-wrap:wrap' });
    const paneHost = U.el('div');

    function showTab(name) {
      tabs.forEach(t => {
        panes[t].style.display = t === name ? '' : 'none';
        tabBtns[t].classList.toggle('primary', t === name);
      });
      if (name === 'Cache') refreshCache();
    }
    tabs.forEach(t => {
      tabBtns[t] = U.el('button', { class: 'btn small', onclick: () => showTab(t) }, t);
      tabBar.appendChild(tabBtns[t]);
      panes[t] = U.el('div', { style: 'display:none' });
      paneHost.appendChild(panes[t]);
    });

    // ---------- CelesTrak ----------
    {
      const sel = U.el('select', { class: 'select', style: 'min-width:180px' });
      sel.appendChild(U.el('option', { value: '' }, 'loading groups…'));
      api('/api/celestrak/groups').then(d => {
        sel.innerHTML = '';
        d.groups.forEach(g => sel.appendChild(U.el('option', { value: g.id }, g.name)));
        sel.value = 'visual';
      }).catch(e => { sel.innerHTML = ''; sel.appendChild(U.el('option', {}, 'groups unavailable')); });
      const status = U.el('div', { class: 'dim', style: 'margin-top:6px' }, '');
      const go = async (refresh) => {
        if (!sel.value || btn.disabled) return;
        busy(btn, status, 'Fetching ' + sel.value + ' from CelesTrak…');
        btnR.disabled = true; // both triggers share one in-flight request
        try {
          const d = await api('/api/celestrak/tle?group=' + encodeURIComponent(sel.value) +
            (refresh ? '&refresh=1' : ''));
          btn.disabled = false; btnR.disabled = false;
          acceptPayload(d, status);
        } catch (e) { fail(btn, status, e); btnR.disabled = false; }
      };
      const btn = U.el('button', { class: 'btn primary', onclick: () => go(false) }, 'Fetch');
      const btnR = U.el('button', { class: 'btn', title: 'Bypass 2 h cache', onclick: () => go(true) }, '⟳ Force refresh');
      panes['CelesTrak'].appendChild(U.el('div', null, [
        U.el('div', { class: 'row' }, [U.el('span', { class: 'dim' }, 'Group'), sel, btn, btnR]),
        status,
      ]));
    }

    // ---------- CelesTrak SupGP ----------
    {
      const sel = U.el('select', { class: 'select', style: 'min-width:230px;max-width:330px' });
      const fileIn = U.el('input', {
        class: 'input', placeholder: 'manual FILE (optional)', style: 'width:170px',
        title: 'Overrides the list — for a FILE name not (yet) in the index, e.g. a brand-new launch',
      });
      const status = U.el('div', { class: 'dim', style: 'margin-top:6px' }, '');
      const listBtn = U.el('button', {
        class: 'btn small', title: 'Re-scan the CelesTrak supplemental index (launch files appear/expire unscheduled)',
        onclick: () => loadIndex(true),
      }, '⟳ list');
      async function loadIndex(force) {
        sel.innerHTML = '';
        sel.appendChild(U.el('option', { value: '' }, 'loading file list…'));
        listBtn.disabled = true;
        try {
          const d = await api('/api/supgp/index' + (force ? '?refresh=1' : ''));
          sel.innerHTML = '';
          const stable = d.files.filter(f => !f.launch);
          const launch = d.files.filter(f => f.launch);
          const og1 = U.el('optgroup', { label: 'Operators (stable files)' });
          stable.forEach(f => og1.appendChild(U.el('option', { value: f.file }, f.label + '  (' + f.file + ')')));
          sel.appendChild(og1);
          if (launch.length) {
            const og2 = U.el('optgroup', { label: 'Launch-specific (appear/expire with launches)' });
            launch.forEach(f => og2.appendChild(U.el('option', { value: f.file }, f.file + ' — ' + f.label)));
            sel.appendChild(og2);
          }
          if (stable.some(f => f.file === 'iss')) sel.value = 'iss';
          status.textContent = d.files.length + ' files (' + launch.length + ' launch-specific) · index fetched ' +
            (d.fetched || '').replace('T', ' ').slice(0, 16) +
            (d.stale ? ' (stale — network failed)' : '');
          status.className = 'dim';
        } catch (e) {
          sel.innerHTML = '';
          sel.appendChild(U.el('option', { value: '' }, 'file list unavailable — use manual FILE'));
          status.textContent = '✗ ' + (e && e.message ? e.message : e);
          status.className = 'err';
        }
        listBtn.disabled = false;
      }
      loadIndex(false);
      const go = async (refresh) => {
        const file = (fileIn.value.trim() || sel.value || '').toLowerCase();
        if (!file || btn.disabled) return;
        busy(btn, status, 'Fetching SupGP ' + file + ' from CelesTrak…');
        btnR.disabled = true;
        try {
          const d = await api('/api/supgp/tle?file=' + encodeURIComponent(file) +
            (refresh ? '&refresh=1' : ''));
          btn.disabled = false; btnR.disabled = false;
          acceptPayload(d, status);
        } catch (e) { fail(btn, status, e); btnR.disabled = false; }
      };
      const btn = U.el('button', { class: 'btn primary', onclick: () => go(false) }, 'Fetch');
      const btnR = U.el('button', { class: 'btn', title: 'Bypass 2 h cache', onclick: () => go(true) }, '⟳ Force refresh');
      panes['CelesTrak SupGP'].appendChild(U.el('div', null, [
        U.el('div', { class: 'row' }, [U.el('span', { class: 'dim' }, 'File'), sel, listBtn]),
        U.el('div', { class: 'row', style: 'margin-top:6px' }, [fileIn, btn, btnR]),
        U.el('div', { class: 'dim', style: 'font-size:11px;margin-top:4px' },
          'Supplemental GP: TLEs fitted by CelesTrak to operator ephemerides (SpaceX, ISS, CSS, OneWeb…) — ' +
          'usually more accurate than standard GP and available pre-launch/pre-catalog. Multi-segment sets ' +
          '(e.g. ISS, CSS, launch stacks) import as one object per satellite; propagation automatically uses ' +
          'the segment nearest the master-clock time. Family ⟳ re-fetches from the same SupGP file.'),
        status,
      ]));
    }

    // ---------- Space-Track ----------
    {
      const idIn = U.el('input', { class: 'input', placeholder: 'identity (email)', style: 'width:190px' });
      const pwIn = U.el('input', { class: 'input', type: 'password', placeholder: 'password', style: 'width:150px' });
      const saveChk = U.el('input', { type: 'checkbox', checked: true });
      const credNote = U.el('span', { class: 'dim', style: 'font-size:11px' }, '');
      api('/api/spacetrack/config').then(d => {
        if (d.identity) idIn.value = d.identity;
        if (d.hasPassword) credNote.textContent = '(saved credentials on file — leave password blank to use them)';
      }).catch(() => {});
      const qType = U.el('select', { class: 'select' }, [
        U.el('option', { value: 'norad' }, 'NORAD IDs'),
        U.el('option', { value: 'intldes' }, 'INTLDES / COSPAR'),
        U.el('option', { value: 'name' }, 'Name contains'),
        U.el('option', { value: 'latest_all' }, 'Full catalog (on-orbit, epoch <30 d)'),
      ]);
      const Q_HINT = {
        norad: '25544, 100057, …',
        intldes: '2026-162A or 98067A (partial ok)',
        name: 'e.g. LACROSSE',
      };
      const qVal = U.el('input', { class: 'input', placeholder: Q_HINT.norad, style: 'width:220px' });
      qType.addEventListener('change', () => {
        qVal.style.display = qType.value === 'latest_all' ? 'none' : '';
        qVal.placeholder = Q_HINT[qType.value] || '';
      });
      const status = U.el('div', { class: 'dim', style: 'margin-top:6px' }, '');
      const btn = U.el('button', {
        class: 'btn primary', onclick: async () => {
          busy(btn, status, 'Querying Space-Track… (login + query, can take ~10 s)');
          try {
            const d = await api('/api/spacetrack/tle', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                identity: idIn.value.trim() || undefined,
                password: pwIn.value || undefined,
                save: saveChk.checked,
                query: { type: qType.value, value: qVal.value.trim() },
              }),
            });
            btn.disabled = false; pwIn.value = '';
            api('/api/spacetrack/config').then(c => {
              if (c.hasPassword) credNote.textContent = '(saved credentials on file — leave password blank to use them)';
            }).catch(() => {});
            acceptPayload(d, status);
          } catch (e) { fail(btn, status, e); }
        },
      }, 'Fetch');
      panes['Space-Track'].appendChild(U.el('div', null, [
        U.el('div', { class: 'row' }, [idIn, pwIn,
          U.el('label', { class: 'chk' }, [saveChk, 'save']), credNote]),
        U.el('div', { class: 'row' }, [U.el('span', { class: 'dim' }, 'Query'), qType, qVal, btn]),
        U.el('div', { class: 'dim', style: 'font-size:11px;margin-top:4px' },
          'Requires a free space-track.org account. Credentials are stored locally in data/config.json.'),
        status,
      ]));
    }

    // ---------- McCants ----------
    {
      const urlIn = U.el('input', { class: 'input', style: 'width:320px', list: 'mccants-urls', value: 'https://www.mmccants.org/tles/classfd.zip' });
      const dl = U.el('datalist', { id: 'mccants-urls' }, [
        U.el('option', { value: 'https://www.mmccants.org/tles/classfd.zip' }),
        U.el('option', { value: 'https://www.mmccants.org/tles/inttles.zip' }),
        U.el('option', { value: 'https://www.prismnet.com/~mmccants/tles/classfd.zip' }),
      ]);
      const status = U.el('div', { class: 'dim', style: 'margin-top:6px' }, '');
      const btn = U.el('button', {
        class: 'btn primary', onclick: async () => {
          busy(btn, status, 'Downloading ' + urlIn.value + ' …');
          try {
            const d = await api('/api/mccants/tle', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: urlIn.value.trim() }),
            });
            btn.disabled = false;
            acceptPayload(d, status);
          } catch (e) { fail(btn, status, e); }
        },
      }, 'Fetch');
      panes['McCants'].appendChild(U.el('div', null, [
        U.el('div', { class: 'row' }, [U.el('span', { class: 'dim' }, 'Zip / TLE URL'), urlIn, btn, dl]),
        U.el('div', { class: 'dim', style: 'font-size:11px;margin-top:4px' },
          'Mike McCants classified/integrated TLE zips, or any URL serving a .zip/.tle/.txt of TLEs.'),
        status,
      ]));
    }

    // ---------- Paste TLE ----------
    {
      const ta = U.el('textarea', { class: 'input', rows: 8, style: 'width:100%;resize:vertical', placeholder: 'Paste 2-line or 3-line element sets here…' });
      const labelIn = U.el('input', { class: 'input', placeholder: 'label (optional)', style: 'width:160px' });
      const status = U.el('div', { class: 'dim', style: 'margin-top:6px' }, '');
      const btn = U.el('button', {
        class: 'btn primary', onclick: async () => {
          busy(btn, status, 'Parsing…');
          try {
            const d = await api('/api/text/tle', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: ta.value, label: labelIn.value.trim() || 'pasted' }),
            });
            btn.disabled = false;
            acceptPayload(d, status);
          } catch (e) { fail(btn, status, e); }
        },
      }, 'Parse');
      panes['Paste TLE'].appendChild(U.el('div', null, [
        ta,
        U.el('div', { class: 'row', style: 'margin-top:6px' }, [labelIn, btn]),
        status,
      ]));
    }

    // ---------- Cache ----------
    const cacheHost = U.el('div');
    panes['Cache'].appendChild(cacheHost);
    async function refreshCache() {
      cacheHost.innerHTML = '';
      const status = U.el('div', { class: 'dim' }, 'Loading cache list…');
      cacheHost.appendChild(status);
      try {
        const d = await api('/api/cache');
        cacheHost.innerHTML = '';
        if (!d.entries.length) {
          cacheHost.appendChild(U.el('div', { class: 'msg-empty' }, 'No cached TLE sets yet.'));
          return;
        }
        const tbl = U.el('table', { class: 'table' });
        tbl.appendChild(U.el('thead', null, U.el('tr', null,
          ['Source', 'Fetched (UTC)', 'Objects', ''].map(h => U.el('th', null, h)))));
        const tb = U.el('tbody');
        d.entries.sort((a, b) => (b.fetched || '').localeCompare(a.fetched || ''));
        d.entries.forEach(en => {
          const loadBtn = U.el('button', {
            class: 'btn small', onclick: async () => {
              try { acceptPayload(await api('/api/cache/' + encodeURIComponent(en.key)), status); }
              catch (e) { status.textContent = '✗ ' + e.message; status.className = 'err'; }
            },
          }, 'Load');
          const delBtn = U.el('button', {
            class: 'btn small danger', onclick: async () => {
              try { await api('/api/cache/' + encodeURIComponent(en.key), { method: 'DELETE' }); refreshCache(); }
              catch (e) { status.textContent = '✗ ' + e.message; }
            },
          }, '✕');
          tb.appendChild(U.el('tr', null, [
            U.el('td', null, en.source || en.key),
            U.el('td', { class: 'num' }, (en.fetched || '').replace('T', ' ').slice(0, 19)),
            U.el('td', { class: 'num' }, String(en.count != null ? en.count : '—')),
            U.el('td', null, [loadBtn, ' ', delBtn]),
          ]));
        });
        tbl.appendChild(tb);
        cacheHost.appendChild(tbl);
        cacheHost.appendChild(status);
        status.textContent = '';
      } catch (e) {
        status.textContent = '✗ ' + e.message; status.className = 'err';
      }
    }

    body.appendChild(U.el('div', { class: 'pane' }, [tabBar, paneHost]));
    showTab('CelesTrak');
  }

  SAT.ui.sources = { init };
})();
