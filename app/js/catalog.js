/* SAT.ui.catalog — Satellites window: fetched-catalog browser + import + families tree */
(function () {
  'use strict';
  const PALETTE = ['#4fc3f7', '#ffd54f', '#81c784', '#ff8a65', '#ba68c8', '#f06292',
    '#aed581', '#4dd0e1', '#ffb74d', '#e57373', '#9575cd', '#7ad97a'];
  let colorIdx = 0;
  const MU = 398600.4418; // km^3/s^2

  function nextColor() { return PALETTE[(colorIdx++) % PALETTE.length]; }

  // derived orbital quick-look from the TLE lines
  function tleInfo(t) {
    try {
      const incl = parseFloat(t.l2.slice(8, 16));
      const raan = parseFloat(t.l2.slice(17, 25));
      const ecc = parseFloat('0.' + t.l2.slice(26, 33).trim());
      const aop = parseFloat(t.l2.slice(34, 42));
      const n = parseFloat(t.l2.slice(52, 63)); // rev/day
      const periodMin = 1440 / n;
      const a = Math.cbrt(MU / Math.pow(n * 2 * Math.PI / 86400, 2));
      return {
        incl, raan, aop, periodMin,
        intldes: (t.l1.slice(9, 17) || '').trim(),
        apoKm: a * (1 + ecc) - 6378.137,
        perKm: a * (1 - ecc) - 6378.137,
      };
    } catch (e) {
      return { incl: NaN, raan: NaN, aop: NaN, periodMin: NaN, intldes: '',
               apoKm: NaN, perKm: NaN };
    }
  }
  function f2(v) { return isNaN(v) ? '—' : v.toFixed(2); }

  function init(body, win) {
    const U = SAT.util;
    win.noScroll = true;

    const selected = new Set(); // norad ids ticked in catalog
    let filtered = [];

    // ================= catalog section =================
    const srcLine = U.el('div', { class: 'dim', style: 'font-size:11px' }, 'No catalog fetched yet — use the Sources window.');
    const search = U.el('input', { class: 'input', placeholder: 'filter name / NORAD…', style: 'flex:1;min-width:100px' });
    const selInfo = U.el('span', { class: 'dim', style: 'font-size:11px;white-space:nowrap' }, '');

    const famSel = U.el('select', { class: 'select', style: 'max-width:130px' });
    const famNew = U.el('input', { class: 'input', placeholder: 'new family name', style: 'width:120px;display:none' });
    const BIG_IMPORT = 400;   // imports above this ask for a confirming second click
    let importConfirm = false, importConfirmTimer = null;
    const importBtn = U.el('button', { class: 'btn primary small', onclick: doImport }, 'Import ▾');
    function resetImportBtn() {
      importConfirm = false;
      clearTimeout(importConfirmTimer);
      importBtn.textContent = 'Import ▾';
      importBtn.classList.remove('danger');
    }

    function rebuildFamSel() {
      const cur = famSel.value;
      famSel.innerHTML = '';
      SAT.state.families.forEach(f =>
        famSel.appendChild(U.el('option', { value: f.id }, f.name)));
      famSel.appendChild(U.el('option', { value: '__new__' }, '+ new family…'));
      if ([...famSel.options].some(o => o.value === cur)) famSel.value = cur;
      else if (SAT.state.families.length === 0) famSel.value = '__new__';
      famNew.style.display = famSel.value === '__new__' ? '' : 'none';
    }
    famSel.addEventListener('change', () => {
      famNew.style.display = famSel.value === '__new__' ? '' : 'none';
    });

    let noradSort = 0; // 0 = catalog order, 1 = ascending, -1 = descending
    const noradTh = U.el('th', {
      style: 'cursor:pointer', title: 'Click to sort by NORAD number',
      onclick: () => { noradSort = noradSort === 1 ? -1 : 1; renderCatalog(); },
    }, 'NORAD');
    const headCheckbox = headChk();
    const thead = U.el('thead', null, U.el('tr', null, [
      U.el('th', { style: 'width:24px' }, headCheckbox),
      U.el('th', null, 'Name'), noradTh, U.el('th', null, 'INTLDES'),
      U.el('th', null, 'Incl °'), U.el('th', null, 'RAAN °'), U.el('th', null, 'AOP °'),
      U.el('th', null, 'Period min'), U.el('th', null, 'Apo km'), U.el('th', null, 'Per km'),
    ]));
    const tbody = U.el('tbody');
    const capNote = U.el('div', { class: 'dim', style: 'font-size:11px;padding:4px 8px' }, '');
    const catScroll = U.el('div', { style: 'flex:1 1 45%;min-height:60px;overflow:auto' }, [
      U.el('table', { class: 'table' }, [thead, tbody]), capNote,
    ]);

    function headChk() {
      const c = U.el('input', { type: 'checkbox', title: 'select all filtered' });
      c.addEventListener('change', () => {
        if (c.checked) filtered.forEach(t => selected.add(t.norad));
        else filtered.forEach(t => selected.delete(t.norad));
        renderCatalog();
      });
      return c;
    }

    function updateSelInfo() {
      selInfo.textContent = selected.size ? selected.size + ' selected' : '';
      importBtn.disabled = selected.size === 0;
      if (importConfirm && selected.size <= BIG_IMPORT) resetImportBtn();
      // header checkbox reflects how much of the current filter is selected
      const selCount = filtered.reduce((c, t) => c + (selected.has(t.norad) ? 1 : 0), 0);
      headCheckbox.checked = filtered.length > 0 && selCount === filtered.length;
      headCheckbox.indeterminate = selCount > 0 && selCount < filtered.length;
    }

    function renderCatalog() {
      const cat = SAT.state.catalog;
      tbody.innerHTML = '';
      if (!cat || !cat.tles || !cat.tles.length) {
        srcLine.textContent = 'No catalog fetched yet — use the Sources window.';
        filtered = []; capNote.textContent = ''; updateSelInfo();
        return;
      }
      srcLine.textContent = cat.source + ' · ' + (cat.tles.length) + ' objects · fetched ' +
        (cat.fetched || '').replace('T', ' ').slice(0, 16) + ' UTC';
      const q = search.value.trim().toUpperCase();
      filtered = !q ? cat.tles : cat.tles.filter(t =>
        (t.name || '').toUpperCase().includes(q) || String(t.norad).includes(q));
      if (noradSort) filtered = filtered.slice().sort((a, b) => noradSort * (a.norad - b.norad));
      noradTh.textContent = 'NORAD' + (noradSort === 1 ? ' ▲' : noradSort === -1 ? ' ▼' : '');
      const CAP = 500;
      filtered.slice(0, CAP).forEach(t => {
        const info = tleInfo(t);
        const chk = U.el('input', { type: 'checkbox', checked: selected.has(t.norad) });
        chk.addEventListener('change', () => {
          chk.checked ? selected.add(t.norad) : selected.delete(t.norad);
          updateSelInfo();
        });
        const tr = U.el('tr', null, [
          U.el('td', null, chk),
          U.el('td', null, t.name || ('OBJECT ' + t.norad)),
          U.el('td', { class: 'num' }, String(t.norad)),
          U.el('td', { class: 'num' }, info.intldes || '—'),
          U.el('td', { class: 'num' }, f2(info.incl)),
          U.el('td', { class: 'num' }, f2(info.raan)),
          U.el('td', { class: 'num' }, f2(info.aop)),
          U.el('td', { class: 'num' }, f2(info.periodMin)),
          U.el('td', { class: 'num' }, f2(info.apoKm)),
          U.el('td', { class: 'num' }, f2(info.perKm)),
        ]);
        tr.addEventListener('click', e => {
          if (e.target === chk) return;
          chk.checked = !chk.checked;
          chk.dispatchEvent(new Event('change'));
        });
        tbody.appendChild(tr);
      });
      capNote.textContent = filtered.length > CAP
        ? 'Showing first ' + CAP + ' of ' + filtered.length + ' — refine the filter (selection still applies to all filtered).'
        : '';
      updateSelInfo();
    }
    search.addEventListener('input', U.debounce(renderCatalog, 150));

    function doImport() {
      const cat = SAT.state.catalog;
      if (!cat || !selected.size) return;
      // guard: thousands of live satellites will bog down rendering
      if (selected.size > BIG_IMPORT && !importConfirm) {
        importConfirm = true;
        importBtn.textContent = '⚠ Import ' + selected.size + ' — click again';
        importBtn.classList.add('danger');
        clearTimeout(importConfirmTimer);
        importConfirmTimer = setTimeout(resetImportBtn, 5000);
        return;
      }
      resetImportBtn();
      let fam;
      if (famSel.value === '__new__') {
        const name = famNew.value.trim() || (cat.source || 'family').split(':').pop();
        fam = { id: U.uuid('fam'), name, expanded: true, sats: [] };
        SAT.state.families.push(fam);
        famNew.value = '';
      } else {
        fam = SAT.state.families.find(f => f.id === famSel.value);
        if (!fam) return;
      }
      let added = 0, updated = 0;
      cat.tles.filter(t => selected.has(t.norad)).forEach(t => {
        const existing = fam.sats.find(s => s.norad === t.norad);
        if (existing) {
          existing.l1 = t.l1; existing.l2 = t.l2; existing.name = t.name || existing.name;
          if (t.segs) existing.segs = t.segs; else delete existing.segs;
          delete existing._satrec; delete existing._satrecBad;
          delete existing._segRecs; delete existing._segMs;
          existing.source = cat.source; existing.fetched = cat.fetched;
          updated++;
        } else {
          const s = {
            id: U.uuid('s'), norad: t.norad, name: t.name || ('OBJECT ' + t.norad),
            l1: t.l1, l2: t.l2, color: nextColor(),
            // default: label only — user turns tracks/footprints on per sat
            show: { groundTrack: false, orbit: false, footprint: false, label: true },
            source: cat.source, fetched: cat.fetched,
          };
          if (t.segs) s.segs = t.segs;   // SupGP piecewise TLE segments
          fam.sats.push(s);
          added++;
        }
      });
      selected.clear();
      SAT.prop.clearCaches();
      SAT.state.save();
      SAT.bus.emit('sats-changed', {});
      renderCatalog(); rebuildFamSel(); renderFamilies();
      srcLine.textContent = '✓ imported ' + added + ' new' + (updated ? ', updated ' + updated : '') +
        ' → ' + fam.name;
    }

    // ================= families section =================
    const famHost = U.el('div', { style: 'flex:1 1 0;min-height:50px;overflow:auto;padding:6px' });

    async function refreshFamily(fam) {
      if (fam._refreshing || !fam.sats.length) return;
      fam._refreshing = true;
      delete fam._refreshMsg;
      renderFamilies();
      try {
        const r = await fetch('/api/refresh/tle', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          // source lets the backend re-fetch SupGP-imported sats from their file
          body: JSON.stringify({ sats: fam.sats.map(s => ({ norad: s.norad, source: s.source || '' })) }),
        });
        const d = await r.json();
        if (!d || d.ok === false) throw new Error((d && d.error) || 'refresh failed');
        const byNorad = new Map(d.tles.map(t => [t.norad, t]));
        let updated = 0;
        fam.sats.forEach(s => {
          const t = byNorad.get(s.norad);
          if (!t) return;
          s.l1 = t.l1; s.l2 = t.l2;
          // segments must track the refresh source: stale ones would otherwise
          // shadow the fresh l1/l2 during propagation
          if (t.segs) s.segs = t.segs; else delete s.segs;
          if (t.name) s.name = t.name;
          s.fetched = d.fetched;
          delete s._satrec; delete s._satrecBad;
          delete s._segRecs; delete s._segMs;
          updated++;
        });
        SAT.prop.clearCaches();
        fam._refreshMsg = '✓ ' + updated + ' updated' +
          (d.missing && d.missing.length ? ' · ' + d.missing.length + ' not found' : '');
        SAT.state.save();
        SAT.bus.emit('sats-changed', {});
      } catch (e) {
        fam._refreshMsg = '✗ ' + (e && e.message ? e.message : e);
      }
      fam._refreshing = false;
      renderFamilies();
      setTimeout(() => { delete fam._refreshMsg; renderFamilies(); }, 8000);
    }

    const TOGS = [['groundTrack', 'GT', 'ground track'], ['orbit', 'OR', 'orbit (3D globe)'],
                  ['footprint', 'FP', 'footprint'], ['label', 'LB', 'label']];

    function renderFamilies() {
      famHost.innerHTML = '';
      if (!SAT.state.families.length) {
        famHost.appendChild(U.el('div', { class: 'msg-empty' },
          'No satellites imported. Fetch TLEs in Sources, tick objects above, then Import.'));
        return;
      }
      SAT.state.families.forEach(fam => {
        const famEl = U.el('div', { class: 'fam' + (fam.hidden ? ' hid' : '') });
        const caret = U.el('span', { class: 'mono dim' }, fam.expanded ? '▾' : '▸');
        const nameEl = U.el('span', { class: 'fam-name' }, fam.name);
        // visibility: hides the whole family everywhere (markers included)
        // without touching per-sat toggles, so showing again restores the
        // exact previous display state
        const eyeBtn = U.el('span', {
          class: 'tog eye' + (fam.hidden ? '' : ' on'),
          title: fam.hidden
            ? 'family hidden — click to show (each satellite keeps its previous toggles)'
            : 'hide this family everywhere (markers, labels, tracks, passes); toggles are remembered',
          onclick: e => {
            e.stopPropagation();
            fam.hidden = !fam.hidden;
            if (fam.hidden && fam.sats.some(s => s.id === SAT.state.selection.satId)) {
              SAT.state.setSelection(null);
            }
            SAT.state.save(); SAT.bus.emit('sats-changed', {});
            renderFamilies();
          },
        }, '👁');
        // family-wide toggle buttons
        const famTogs = TOGS.map(([key, lbl, title]) => {
          const allOn = fam.sats.length && fam.sats.every(s => s.show[key]);
          const b = U.el('span', {
            class: 'tog' + (allOn ? ' on' : ''), title: 'all ' + title + ' on/off',
            onclick: e => {
              e.stopPropagation();
              const target = !allOn;
              fam.sats.forEach(s => { s.show[key] = target; });
              SAT.state.save(); SAT.bus.emit('sats-changed', {});
              renderFamilies();
            },
          }, lbl);
          return b;
        });
        const delFam = U.el('span', {
          class: 'icon-btn', title: 'remove family',
          onclick: e => {
            e.stopPropagation();
            const had = fam.sats.some(s => s.id === SAT.state.selection.satId);
            SAT.state.families = SAT.state.families.filter(f => f !== fam);
            if (had) SAT.state.setSelection(null);
            SAT.state.save(); SAT.bus.emit('sats-changed', {});
            rebuildFamSel(); renderFamilies();
          },
        }, '🗑');
        const refrBtn = U.el('span', {
          class: 'icon-btn accent',
          title: 'refresh TLEs for this family (SupGP-imported sats from their SupGP file; others via Space-Track if credentials saved, else CelesTrak)',
          onclick: e => { e.stopPropagation(); refreshFamily(fam); },
        }, fam._refreshing ? '…' : '⟳');
        const msg = fam._refreshMsg
          ? U.el('span', { class: 'tag ' + (fam._refreshMsg.startsWith('✗') ? 'warn' : 'ok') }, fam._refreshMsg)
          : null;
        const head = U.el('div', {
          class: 'fam-head',
          onclick: () => { fam.expanded = !fam.expanded; SAT.state.save(); renderFamilies(); },
        }, [caret, nameEl, U.el('span', { class: 'dim' }, '(' + fam.sats.length + ')'), msg,
            U.el('span', { class: 'sat-togs' }, [eyeBtn, famTogs]), refrBtn, delFam]);
        famEl.appendChild(head);

        if (fam.expanded) fam.sats.forEach(sat => {
          const sw = U.el('input', { type: 'color', class: 'swatch', value: sat.color, title: 'color' });
          sw.addEventListener('input', () => {
            // keep this row's DOM alive while the OS color picker drags
            suppressFamilyRender = true;
            sat.color = sw.value; SAT.state.save(); SAT.bus.emit('sats-changed', {});
          });
          sw.addEventListener('change', () => {
            suppressFamilyRender = false;
            renderFamilies();
          });
          sw.addEventListener('click', e => e.stopPropagation());
          const badTle = !SAT.prop.ensureSatrec(sat);
          const nm = U.el('span', {
            class: 'sat-name', title: 'NORAD ' + sat.norad + ' — click to select',
            onclick: () => SAT.state.setSelection(sat.id),
          }, sat.name);
          const infoBtn = U.el('span', {
            class: 'info-tog', title: 'satellite details',
            onclick: e => { e.stopPropagation(); SAT.ui.satinfo.show(sat); },
          }, 'i');
          const togs = TOGS.map(([key, lbl, title]) => U.el('span', {
            class: 'tog' + (sat.show[key] ? ' on' : ''), title,
            onclick: () => {
              sat.show[key] = !sat.show[key];
              SAT.state.save(); SAT.bus.emit('sats-changed', {});
              renderFamilies();
            },
          }, lbl));
          const del = U.el('span', {
            class: 'icon-btn', title: 'remove satellite',
            onclick: () => {
              fam.sats = fam.sats.filter(s => s !== sat);
              if (SAT.state.selection.satId === sat.id) SAT.state.setSelection(null);
              SAT.state.save(); SAT.bus.emit('sats-changed', {});
              renderFamilies();
            },
          }, '✕');
          const row = U.el('div', {
            class: 'sat-row' + (SAT.state.selection.satId === sat.id ? ' sel' : ''),
          }, [sw, nm, U.el('span', { class: 'dim mono', style: 'font-size:10px' }, String(sat.norad)),
              badTle ? U.el('span', { class: 'tag warn', title: 'TLE could not be parsed/propagated — this object will not render' }, 'bad TLE') : null,
              U.el('span', { class: 'sat-togs' }, [infoBtn, togs]), del]);
          famEl.appendChild(row);
        });
        famHost.appendChild(famEl);
      });
    }

    // ================= assembly =================
    // Import/catalog section: foldable (caret header) with its own height
    // splitter; the window's outer resize grip is untouched.
    function catUI() {
      const s = SAT.state.settings;
      if (!s.catalogUI) s.catalogUI = { collapsed: false, height: 0 };
      return s.catalogUI;
    }

    const caret = U.el('span', { class: 'mono dim' }, '▾');
    srcLine.className = 'cat-sec-src';
    const secHeader = U.el('div', {
      class: 'cat-sec-head', title: 'fold / unfold the import section',
      onclick: () => { catUI().collapsed = !catUI().collapsed; applyImportFold(); SAT.state.save(); },
    }, [caret, U.el('b', null, 'Import from catalog'), srcLine]);

    const ctrlHost = U.el('div', { style: 'padding:6px 8px;flex:0 0 auto' },
      U.el('div', { class: 'row' }, [search, selInfo, famSel, famNew, importBtn]));

    const splitter = U.el('div', { class: 'cat-splitter', title: 'drag to resize the import section' });
    splitter.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startY = e.clientY;
      const startH = catScroll.getBoundingClientRect().height;
      const move = ev => {
        const maxH = Math.max(120, body.clientHeight - 160);
        const h = U.clamp(startH + (ev.clientY - startY), 60, maxH);
        catScroll.style.flex = '0 1 ' + Math.round(h) + 'px';
      };
      const up = ev => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        catUI().height = Math.round(catScroll.getBoundingClientRect().height);
        SAT.state.save();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    function applyImportFold() {
      const c = catUI();
      caret.textContent = c.collapsed ? '▸' : '▾';
      ctrlHost.style.display = c.collapsed ? 'none' : '';
      catScroll.style.display = c.collapsed ? 'none' : '';
      splitter.style.display = c.collapsed ? 'none' : '';
      if (!c.collapsed) {
        catScroll.style.flex = c.height > 0 ? ('0 1 ' + c.height + 'px') : '1 1 45%';
      }
    }

    body.appendChild(U.el('div', { style: 'display:flex;flex-direction:column;height:100%' }, [
      secHeader,
      ctrlHost,
      catScroll,
      splitter,
      U.el('div', { style: 'padding:4px 8px;background:var(--bg3);font-size:11px;color:var(--fg-dim);border-bottom:1px solid var(--border);flex:0 0 auto' },
        'Imported families — ⓘ details · GT ground track · OR orbit (3D) · FP footprint · LB label'),
      famHost,
    ]));
    applyImportFold();

    let suppressFamilyRender = false;
    SAT.bus.on('catalog-changed', () => { selected.clear(); renderCatalog(); });
    SAT.bus.on('sats-changed', () => { if (!suppressFamilyRender) renderFamilies(); });
    SAT.bus.on('selection-changed', renderFamilies);
    SAT.bus.on('state-loaded', () => { rebuildFamSel(); renderCatalog(); renderFamilies(); applyImportFold(); });
    rebuildFamSel(); renderCatalog(); renderFamilies();
  }

  SAT.ui.catalog = { init };
})();
