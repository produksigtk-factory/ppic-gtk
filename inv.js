/* Kebutuhan Report — Value and Qty Inventory (RM, PM, FG)
 * Berdiri sendiri: data dari Google Sheet "Value and Qty Inventory (RM, PM, dan FG)" lewat Apps Script Code_INV.gs.
 * Tidak membaca/menulis MRP, PO, CSL, maupun DATABASE PPIC GTK.
 * Value = Qty × harga terakhir yang berlaku pada/sebelum tanggal snapshot (tanpa harga → value 0 + peringatan).
 */
(function () {
  'use strict';
  const CFG = window.PPIC_CONFIG || {};
  const UI = window.PPIC_UI || {};
  const $ = (id) => document.getElementById(id);
  const esc = UI.esc || ((s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const toast = UI.toast || ((t) => console.log(t));
  const openDialog = UI.openDialog;

  const GOLS = ['RM', 'PM', 'FG', 'WIP'];
  const GOL_LBL = { RM: 'RM', PM: 'PM', FG: 'FG', WIP: 'WIP (Ekstrak)', '?': 'Tanpa golongan' };
  const GOL_CLR = { RM: '#2f6db5', PM: '#b07d16', FG: '#106a3a', WIP: '#8a4fb0', '?': '#8a94a0' };
  const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const nf0 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf3 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 3 });
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const fQ = (v) => (!isNum(v) ? '–' : Math.abs(v) < 0.0005 ? '0' : nf3.format(v));
  const fRp = (v) => (!isNum(v) ? '–' : 'Rp ' + nf0.format(Math.round(v)));
  const fBig = (v) => { if (!isNum(v)) return '–'; const a = Math.abs(v); return a >= 1e9 ? 'Rp ' + nf1.format(v / 1e9) + ' M' : a >= 1e6 ? 'Rp ' + nf1.format(v / 1e6) + ' jt' : 'Rp ' + nf0.format(v); };
  const fPct = (v) => (!isNum(v) ? '–' : nf1.format(v * 100) + '%');
  const fDate = (d) => (d ? `${d.slice(8, 10)} ${MON3[+d.slice(5, 7) - 1]} ${d.slice(2, 4)}` : '–');
  const fSnap = (s) => (s ? `${fDate(s.slice(0, 10))} ${s.slice(11, 16)}` : '–');
  const pad = (n) => String(n).padStart(2, '0');
  const nowParts = () => { const d = new Date(); return { d: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, t: `${pad(d.getHours())}:${pad(d.getMinutes())}` }; };
  const S = (v) => (v === null || v === undefined ? '' : String(v).trim());
  const normCode = (v) => { let s = S(v); if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, ''); return s; };
  const num = (v) => {
    if (typeof v === 'number') return v; let t = S(v).replace(/\s/g, ''); if (!t) return NaN;
    if (t.includes('.') && t.includes(',')) t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
    else if (t.includes(',')) t = /^-?\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
    else if (/^-?\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
    const x = Number(t); return isFinite(x) ? x : NaN;
  };
  const delta = (a, b) => (isNum(a) && isNum(b) ? a - b : NaN);
  const dCls = (v) => (!isNum(v) || Math.abs(v) < 0.5 ? 'muted' : v > 0 ? 'inv-up' : 'inv-dn');
  const dTxt = (v, f) => (!isNum(v) ? '–' : (v > 0 ? '+' : v < 0 ? '−' : '') + f(Math.abs(v)));

  /* ---------- State ---------- */
  const I = {
    loaded: false, loading: false, err: '', raw: null,
    gol: new Map(), harga: new Map(), snaps: [], stok: new Map(), log: [],
    snap: '', g: '', brand: '', jenis: '', lok: '', q: '', view: 'kat', ms: 'v', chart: '', open: new Set(), sheetUrl: '', readAt: '',
  };
  try { const v = JSON.parse(localStorage.getItem('ppic.inv') || '{}'); ['view', 'ms'].forEach((k) => { if (v[k]) I[k] = v[k]; }); } catch (e) { /* abaikan */ }
  const savePref = () => { try { localStorage.setItem('ppic.inv', JSON.stringify({ view: I.view, ms: I.ms })); } catch (e) { /* abaikan */ } };

  /* ---------- Apps Script ---------- */
  async function load(force) {
    if (!CFG.INV_SCRIPT_URL) { I.err = 'noUrl'; render(); return; }
    if (I.loading) return;
    I.loading = true; if (!I.loaded || force) paintLoading(true);
    try {
      const res = await fetch(CFG.INV_SCRIPT_URL + (CFG.INV_SCRIPT_URL.includes('?') ? '&' : '?') + 't=' + Date.now());
      const d = await res.json();
      if (!d.ok) throw new Error(d.error || 'Gagal membaca data inventory.');
      ingest(d); I.err = '';
    } catch (e) { I.err = e.message || String(e); }
    I.loading = false; paintLoading(false); render();
  }
  async function api(action, payload) {
    if (!CFG.INV_SCRIPT_URL) throw new Error('Apps Script inventory belum terpasang (config.js INV_SCRIPT_URL).');
    let res;
    try {
      res = await fetch(CFG.INV_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(Object.assign({ action }, payload)) });
    } catch (e) { throw new Error('Tidak bisa menghubungi Google Sheet. Periksa koneksi lalu coba lagi.'); }
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || 'Gagal menyimpan.');
    ingest(d); render();
    return d.message || 'Tersimpan.';
  }
  function ingest(d) {
    I.raw = d; I.sheetUrl = d.sheetUrl || ''; I.readAt = d.readAt || ''; I.log = d.log || [];
    I.gol = new Map();
    (d.golongan || []).forEach((r) => { const k = normCode(r[0]); if (k) I.gol.set(k, Object.assign({ kode: k, nama: S(r[1]), gol: S(r[2]).toUpperCase(), uom: S(r[4]) }, splitKat(r[3]))); });
    I.harga = new Map();
    (d.harga || []).forEach((r) => { const k = normCode(r[0]), h = Number(r[1]); if (!k || !isFinite(h)) return; const L = I.harga.get(k) || []; L.push({ h, from: S(r[2]).slice(0, 10), up: S(r[3]), file: S(r[4]) }); I.harga.set(k, L); });
    I.harga.forEach((L) => L.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.up < b.up ? -1 : 1)));
    I.stok = new Map();
    (d.stok || []).forEach((r) => { const s = S(r[0]); const k = normCode(r[1]); if (!s || !k) return; const L = I.stok.get(s) || []; L.push({ kode: k, lok: S(r[2]), qty: Number(r[3]) || 0, src: S(r[4]), note: S(r[5]) }); I.stok.set(s, L); });
    const meta = new Map((d.snapshot || []).map((r) => [S(r[0]), { snap: S(r[0]), file: S(r[1]), n: Number(r[2]) || 0, up: S(r[3]), note: S(r[4]) }]));
    I.stok.forEach((L, s) => { if (!meta.has(s)) meta.set(s, { snap: s, file: '', n: L.length, up: '', note: '' }); });
    I.snaps = [...meta.values()].filter((m) => I.stok.has(m.snap)).sort((a, b) => (a.snap < b.snap ? -1 : 1));
    if (!I.snaps.some((m) => m.snap === I.snap)) I.snap = I.snaps.length ? I.snaps[I.snaps.length - 1].snap : '';
    I.loaded = true;
  }
  const priceAt = (kode, snap) => { const L = I.harga.get(kode); if (!L) return null; const day = snap.slice(0, 10); let p = null; L.forEach((x) => { if (x.from <= day) p = x; }); return p; };
  // KATEGORI berpola "BRAND - JENIS" (FG). Tanpa " - " → tanpa brand, jenis = kategori.
  function splitKat(v) {
    const kat = S(v).replace(/\s+/g, ' ').replace(/\s+-\s+/, ' - ');
    const i = kat.indexOf(' - ');
    return i > 0 ? { kat, brand: kat.slice(0, i).trim(), jenis: kat.slice(i + 3).trim() } : { kat, brand: '', jenis: kat };
  }
  const golOf = (kode) => { const g = I.gol.get(kode); return g && GOLS.includes(g.gol) ? g.gol : '?'; };

  /* ---------- Hitung per snapshot ---------- */
  // rows: per kode+lokasi; filter mengikuti saringan (golongan, kategori, lokasi, cari)
  function calc(snap, ignoreFilter) {
    const L = I.stok.get(snap) || [], q = I.q.toLowerCase();
    const out = [];
    L.forEach((r) => {
      const g = I.gol.get(r.kode), gol = golOf(r.kode), kat = (g && g.kat) || 'Tanpa kategori', brand = (g && g.brand) || '', jenis = (g && g.jenis) || 'Tanpa kategori';
      if (!ignoreFilter) {
        if (I.g && gol !== I.g) return;
        if (I.brand && brand !== I.brand) return;
        if (I.jenis && jenis !== I.jenis) return;
        if (I.lok && r.lok !== I.lok) return;
        if (q && !(r.kode + ' ' + ((g && g.nama) || '')).toLowerCase().includes(q)) return;
      }
      const p = priceAt(r.kode, snap);
      out.push({ kode: r.kode, nama: (g && g.nama) || '', uom: (g && g.uom) || '', gol, kat, brand, jenis, lok: r.lok, qty: r.qty, src: r.src, note: r.note, price: p ? p.h : null, from: p ? p.from : '', val: p ? r.qty * p.h : 0, noPrice: !p, noGol: !g || gol === '?' });
    });
    return out;
  }
  const sumBy = (rows, key) => { const m = new Map(); rows.forEach((r) => { const k = key(r); const o = m.get(k) || { qty: 0, val: 0, n: new Set(), rows: [] }; o.qty += r.qty; o.val += r.val; o.n.add(r.kode); o.rows.push(r); m.set(k, o); }); return m; };
  const prevSnap = () => { const i = I.snaps.findIndex((m) => m.snap === I.snap); return i > 0 ? I.snaps[i - 1].snap : ''; };

  /* ---------- Render ---------- */
  function paintLoading(on) { document.querySelectorAll('[data-inv-loading]').forEach((x) => { x.hidden = !on; }); }
  function render() {
    if (!$('invBody')) return;
    $('dataInfo').textContent = I.loaded ? `Value and Qty Inventory dibaca ${I.readAt ? fSnap(I.readAt.slice(0, 16)) : ''} · ${I.gol.size} kode golongan · ${I.snaps.length} snapshot` : I.err === 'noUrl' ? 'Apps Script inventory belum dipasang' : 'Memuat…';
    if (I.err === 'noUrl') {
      $('invTop').hidden = true;
      $('invBody').innerHTML = `<div class="warn-box"><h4>Apps Script belum dipasang</h4><p>Buka Google Sheet <b>Value and Qty Inventory (RM, PM, dan FG)</b> → Extensions → Apps Script → tempel <code>Code_INV.gs</code> → Deploy sebagai Web app (Execute as: Me, Who has access: Anyone), lalu kirim URL /exec-nya untuk dipasang di website.</p></div>`;
      return;
    }
    if (I.err && !I.loaded) { $('invTop').hidden = true; $('invBody').innerHTML = `<p class="check err">${esc(I.err)}</p>`; return; }
    if (!I.loaded) return;
    $('invTop').hidden = false;
    // Saringan
    $('invSnap').innerHTML = I.snaps.length ? I.snaps.slice().reverse().map((m) => `<option value="${esc(m.snap)}"${m.snap === I.snap ? ' selected' : ''}>${esc(fSnap(m.snap))}</option>`).join('') : '<option value="">Belum ada snapshot</option>';
    document.querySelectorAll('#invGol [data-v]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === I.g)));
    document.querySelectorAll('#invView [data-v]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === I.view)));
    const all = I.snap ? calc(I.snap, true) : [];
    const pool = all.filter((r) => !I.g || r.gol === I.g);
    const brands = [...new Set(pool.map((r) => r.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'id'));
    if (I.brand && !brands.includes(I.brand)) I.brand = '';
    $('invBrand').innerHTML = '<option value="">Semua brand</option>' + brands.map((k) => `<option${k === I.brand ? ' selected' : ''}>${esc(k)}</option>`).join('');
    $('invBrand').disabled = !brands.length;
    const jen = [...new Set(pool.filter((r) => !I.brand || r.brand === I.brand).map((r) => r.jenis))].sort((a, b) => a.localeCompare(b, 'id'));
    if (I.jenis && !jen.includes(I.jenis)) I.jenis = '';
    $('invJenis').innerHTML = `<option value="">${I.brand ? 'Semua jenis ' + esc(I.brand) : 'Semua jenis / kategori'}</option>` + jen.map((k) => `<option${k === I.jenis ? ' selected' : ''}>${esc(k)}</option>`).join('');
    const loks = [...new Set(all.map((r) => r.lok))].sort((a, b) => a.localeCompare(b, 'id'));
    if (I.lok && !loks.includes(I.lok)) I.lok = '';
    $('invLok').innerHTML = '<option value="">Semua lokasi</option>' + loks.map((k) => `<option value="${esc(k)}"${k === I.lok ? ' selected' : ''}>${esc(k || '(tanpa lokasi)')}</option>`).join('');
    $('invEdit').disabled = !I.snap;
    if (!I.snap) {
      $('invKpi').innerHTML = ''; $('invChart').innerHTML = '';
      $('invBody').innerHTML = `<div class="inv-empty"><h3>Belum ada data stok</h3><p>Langkahnya: (1) upload <b>golongan</b> (kode, nama, golongan, kategori, UoM), (2) upload <b>harga</b> dengan tanggal berlaku, (3) upload <b>stok</b> dengan tanggal & jam snapshot. Format Excel masing-masing ada di tombol <b>Format</b>.</p><p class="muted">${I.gol.size} kode golongan · ${I.harga.size} kode berharga tersimpan.</p></div>`;
      return;
    }
    const rows = calc(I.snap), pv = prevSnap(), prows = pv ? calc(pv) : null;
    const meta = I.snaps.find((m) => m.snap === I.snap);
    $('invInfo').innerHTML = `Snapshot <b>${esc(fSnap(I.snap))}</b>${meta && meta.file ? ` · ${esc(meta.file)}` : ''}${pv ? ` · dibandingkan dengan ${esc(fSnap(pv))}` : ' · snapshot pertama'} · harga: terakhir yang berlaku pada/sebelum ${esc(fDate(I.snap.slice(0, 10)))}`;
    renderKpi(rows, prows);
    renderChart();
    $('invBody').innerHTML = renderWarn(rows) + (I.view === 'kat' ? viewKat(rows, prows) : I.view === 'mat' ? viewMat(rows, prows) : viewLok(rows));
  }
  function renderKpi(rows, prows) {
    const tot = rows.reduce((t, r) => t + r.val, 0), ptot = prows ? prows.reduce((t, r) => t + r.val, 0) : NaN;
    const by = sumBy(rows, (r) => r.gol), pby = prows ? sumBy(prows, (r) => r.gol) : new Map();
    const card = (lbl, v, pvv, sub, g) => `<div class="pk inv-k"${g ? ` style="--gc:${GOL_CLR[g]}"` : ''}><span class="pk-lbl">${lbl}</span><span class="pk-num">${fBig(v)}</span><span class="inv-ksub"><span class="${dCls(delta(v, pvv))}">${isNum(pvv) ? dTxt(delta(v, pvv), fBig) : 'pembanding –'}</span>${sub ? ' · ' + sub : ''}</span></div>`;
    const gl = [...GOLS, '?'].filter((g) => by.has(g));
    const noP = new Set(rows.filter((r) => r.noPrice).map((r) => r.kode)).size, noG = new Set(rows.filter((r) => r.noGol).map((r) => r.kode)).size;
    $('invKpi').innerHTML = card('Total value', tot, ptot, `${nf0.format(new Set(rows.map((r) => r.kode)).size)} kode`)
      + gl.map((g) => { const o = by.get(g), p = pby.get(g); return card(`${GOL_LBL[g]} <small>${fPct(tot ? o.val / tot : NaN)}</small>`, o.val, prows ? (p ? p.val : 0) : NaN, `qty ${fQ(o.qty)} · ${o.n.size} kode`, g); }).join('')
      + (noP || noG ? `<button type="button" class="pk is-warn inv-kw" data-inv-warn="1"><span class="pk-lbl">Perlu dilengkapi</span><span class="pk-num">${noP + noG}</span><span class="inv-ksub">${noP ? `${noP} tanpa harga` : ''}${noP && noG ? ' · ' : ''}${noG ? `${noG} tanpa golongan` : ''}</span></button>` : '');
  }
  function renderWarn(rows) {
    const noP = [...new Map(rows.filter((r) => r.noPrice).map((r) => [r.kode, r])).values()];
    const noG = [...new Map(rows.filter((r) => r.noGol).map((r) => [r.kode, r])).values()];
    const inStok = new Set(calc(I.snap, true).map((r) => r.kode));
    const idle = [...I.gol.values()].filter((g) => !inStok.has(g.kode) && (!I.g || g.gol === I.g));
    if (!noP.length && !noG.length && !idle.length) return '';
    const li = (L, f) => L.slice(0, 300).map(f).join('') + (L.length > 300 ? `<li class="muted">… ${L.length - 300} lagi</li>` : '');
    return `<details class="inv-warn" id="invWarn"${I.openWarn ? ' open' : ''}><summary><b>Perlu dilengkapi</b> <span>${noP.length ? `${noP.length} kode tanpa harga (value 0)` : ''}${noP.length && noG.length ? ' · ' : ''}${noG.length ? `${noG.length} kode tanpa golongan` : ''}${idle.length ? `${noP.length || noG.length ? ' · ' : ''}<span class="muted">${idle.length} kode golongan tidak ada di stok</span>` : ''}</span></summary>
      <div class="inv-wg">
        ${noP.length ? `<div><h4>Tanpa harga berlaku per ${esc(fDate(I.snap.slice(0, 10)))}</h4><ul>${li(noP, (r) => `<li><span class="pl-code">${esc(r.kode)}</span> ${esc(r.nama)}${I.harga.has(r.kode) ? ` <small class="muted">(harga baru berlaku ${esc(fDate(I.harga.get(r.kode)[0].from))})</small>` : ''}</li>`)}</ul></div>` : ''}
        ${noG.length ? `<div><h4>Tanpa golongan (tidak ada di DB_GOLONGAN)</h4><ul>${li(noG, (r) => `<li><span class="pl-code">${esc(r.kode)}</span> ${esc(r.nama)}</li>`)}</ul></div>` : ''}
        ${idle.length ? `<div><h4>Ada di golongan, tidak ada di stok snapshot ini</h4><ul>${li(idle, (g) => `<li><span class="pl-code">${esc(g.kode)}</span> ${esc(g.nama)} <small class="muted">${esc(g.gol)}</small></li>`)}</ul></div>` : ''}
      </div></details>`;
  }
  const head = (cols) => `<thead><tr>${cols.map((c) => `<th${c[1] ? ` class="${c[1]}"` : ''}>${c[0]}</th>`).join('')}</tr></thead>`;
  function viewKat(rows, prows) {
    const tot = rows.reduce((t, r) => t + r.val, 0);
    const dq = (a, b) => (b ? `<span class="${dCls(a.qty - b.qty)}">${dTxt(a.qty - b.qty, fQ)}</span>` : '–');
    const dv = (a, b) => (b ? `<span class="${dCls(a.val - b.val)}">${dTxt(a.val - b.val, fRp)}</span>` : '–');
    const nums = (v, p, tag) => `<${tag} class="num">${v.n.size}</${tag}><${tag} class="num">${fQ(v.qty)}</${tag}><${tag} class="num">${dq(v, p)}</${tag}><${tag} class="num">${fRp(v.val)}</${tag}><${tag} class="num">${dv(v, p)}</${tag}><${tag} class="num">${fPct(tot ? v.val / tot : NaN)}</${tag}>`;
    const Z = { val: 0, qty: 0 };
    const pick = (m, k) => (prows ? (m.get(k) || Z) : null);
    const leafKey = (r) => (r.brand ? `${r.gol}|${r.brand}|${r.jenis}` : `${r.gol}||${r.kat}`);
    const byG = sumBy(rows, (r) => r.gol), pG = prows ? sumBy(prows, (r) => r.gol) : null;
    const byB = sumBy(rows.filter((r) => r.brand), (r) => `${r.gol}|${r.brand}`), pB = prows ? sumBy(prows.filter((r) => r.brand), (r) => `${r.gol}|${r.brand}`) : null;
    const byL = sumBy(rows, leafKey), pL = prows ? sumBy(prows, leafKey) : null;
    const mats = (k, v, pad) => {
      const pm = prows ? sumBy(prows.filter((r) => leafKey(r) === k), (r) => r.kode) : null;
      return [...sumBy(v.rows, (r) => r.kode)].sort((a, b) => b[1].val - a[1].val).map(([kode, m]) => {
        const r0 = m.rows[0], pmv = pick(pm || new Map(), kode);
        return `<tr class="inv-mr"><td></td><td style="padding-left:${pad}px"><button type="button" class="btn-link inv-mat" data-inv-chart="${esc(kode)}" title="Tampilkan pergerakan material ini di grafik"><span class="pl-code">${esc(kode)}</span> ${esc(r0.nama)}</button>${r0.noPrice ? ' <span class="inv-tag">tanpa harga</span>' : ` <small class="muted">@ ${fRp(r0.price)} · ${esc(fDate(r0.from))}</small>`}<div class="muted inv-sm">${m.rows.length > 1 ? m.rows.length + ' lokasi' : esc(r0.lok)}</div></td><td class="num muted">1</td><td class="num">${fQ(m.qty)} <small class="muted">${esc(r0.uom)}</small></td><td class="num">${dq(m, pmv)}</td><td class="num">${fRp(m.val)}</td><td class="num">${dv(m, pmv)}</td><td class="num">${fPct(tot ? m.val / tot : NaN)}</td></tr>`;
      }).join('');
    };
    const leaf = (k, v, label, pad) => {
      const open = I.open.has(k);
      return `<tr class="inv-kr${open ? ' is-open' : ''}" data-inv-open="${esc(k)}"><td class="inv-chev" aria-hidden="true">${open ? '▾' : '▸'}</td><td style="padding-left:${pad}px">${esc(label)}</td>${nums(v, pick(pL || new Map(), k), 'td')}</tr>` + (open ? mats(k, v, pad + 14) : '');
    };
    let html = '';
    [...GOLS, '?'].filter((g) => byG.has(g)).forEach((g) => {
      html += `<tr class="inv-gr" style="--gc:${GOL_CLR[g]}"><th colspan="2">${esc(GOL_LBL[g])}</th>${nums(byG.get(g), pick(pG || new Map(), g), 'th')}</tr>`;
      [...byB].filter(([k]) => k.startsWith(g + '|')).sort((a, b) => b[1].val - a[1].val).forEach(([kb, vb]) => {
        const brand = kb.slice(g.length + 1), open = I.open.has('B:' + kb);
        html += `<tr class="inv-br${open ? ' is-open' : ''}" data-inv-open="B:${esc(kb)}"><td class="inv-chev" aria-hidden="true">${open ? '▾' : '▸'}</td><td>${esc(brand)}</td>${nums(vb, pick(pB || new Map(), kb), 'td')}</tr>`;
        if (open) [...byL].filter(([k]) => k.startsWith(kb + '|')).sort((a, b) => b[1].val - a[1].val).forEach(([k, v]) => { html += leaf(k, v, k.slice(kb.length + 1), 24); });
      });
      [...byL].filter(([k]) => k.startsWith(g + '||')).sort((a, b) => b[1].val - a[1].val).forEach(([k, v]) => { html += leaf(k, v, k.slice(g.length + 2), 10); });
    });
    return `<div class="table-wrap"><table class="po-table inv-t">${head([['', 'inv-chev'], ['Golongan / brand / jenis'], ['Kode', 'num'], ['Qty', 'num'], ['Δ qty', 'num'], ['Value', 'num'], ['Δ value', 'num'], ['Porsi', 'num']])}<tbody>${html || '<tr class="empty"><td colspan="8">Tidak ada data pada saringan ini.</td></tr>'}</tbody>
      <tfoot><tr><th colspan="3">Total</th><th class="num">${fQ(rows.reduce((t, r) => t + r.qty, 0))}</th><th></th><th class="num">${fRp(tot)}</th><th class="num">${prows ? dTxt(tot - prows.reduce((t, r) => t + r.val, 0), fRp) : '–'}</th><th class="num">100%</th></tr></tfoot></table></div>
      <p class="hint">Kategori berpola "BRAND - JENIS" dikelompokkan per brand lalu per jenis. Klik baris untuk membuka isinya; klik material untuk menampilkan pergerakannya di grafik. Qty dijumlah apa adanya, jadi total qty lintas UoM (Kg, Pcs) hanya untuk gambaran.</p>`;
  }
  function viewMat(rows, prows) {
    const by = sumBy(rows, (r) => r.kode), pm = prows ? sumBy(prows, (r) => r.kode) : null;
    const L = [...by].sort((a, b) => b[1].val - a[1].val);
    const shown = L.slice(0, 1500);
    return `<div class="table-wrap inv-tw"><table class="po-table inv-t">${head([['Material'], ['Golongan'], ['Kategori'], ['Lokasi'], ['Qty', 'num'], ['Δ qty', 'num'], ['Harga', 'num'], ['Value', 'num'], ['Δ value', 'num']])}<tbody>
      ${shown.map(([kode, m]) => { const r = m.rows[0], p = pm ? (pm.get(kode) || { val: 0, qty: 0 }) : null; return `<tr><td><button type="button" class="btn-link inv-mat" data-inv-chart="${esc(kode)}"><span class="pl-code">${esc(kode)}</span><span class="pl-name">${esc(r.nama || '(tidak ada di golongan)')}</span></button></td><td><span class="inv-g" style="--gc:${GOL_CLR[r.gol]}">${esc(r.gol === '?' ? '–' : r.gol)}</span></td><td>${esc(r.kat)}</td><td>${m.rows.length > 1 ? `<span title="${esc(m.rows.map((x) => `${x.lok || '(tanpa lokasi)'}: ${fQ(x.qty)}`).join('\n'))}">${m.rows.length} lokasi</span>` : esc(r.lok)}${m.rows.some((x) => x.src === 'manual') ? ' <span class="inv-tag" title="Ada koreksi manual">manual</span>' : ''}</td>
        <td class="num">${fQ(m.qty)} <small class="muted">${esc(r.uom)}</small></td><td class="num">${p ? `<span class="${dCls(m.qty - p.qty)}">${dTxt(m.qty - p.qty, fQ)}</span>` : '–'}</td>
        <td class="num">${r.noPrice ? '<span class="inv-tag">tanpa harga</span>' : `${fRp(r.price)}<div class="muted inv-sm">${esc(fDate(r.from))}</div>`}</td><td class="num"><b>${fRp(m.val)}</b></td><td class="num">${p ? `<span class="${dCls(m.val - p.val)}">${dTxt(m.val - p.val, fRp)}</span>` : '–'}</td></tr>`; }).join('') || '<tr class="empty"><td colspan="9">Tidak ada data pada saringan ini.</td></tr>'}
      </tbody></table></div>${L.length > shown.length ? `<p class="hint">Menampilkan 1.500 dari ${nf0.format(L.length)} kode (value terbesar). Pakai pencarian atau saringan untuk mempersempit.</p>` : ''}`;
  }
  function viewLok(rows) {
    const by = sumBy(rows, (r) => r.lok), tot = rows.reduce((t, r) => t + r.val, 0);
    const gl = [...GOLS, '?'].filter((g) => rows.some((r) => r.gol === g));
    return `<div class="table-wrap"><table class="po-table inv-t">${head([['Lokasi'], ['Kode', 'num'], ...gl.map((g) => [`Value ${esc(GOL_LBL[g])}`, 'num']), ['Total value', 'num'], ['Porsi', 'num']])}<tbody>
      ${[...by].sort((a, b) => b[1].val - a[1].val).map(([lok, o]) => { const g = sumBy(o.rows, (r) => r.gol); return `<tr><td><button type="button" class="btn-link" data-inv-lok="${esc(lok)}">${esc(lok || '(tanpa lokasi)')}</button></td><td class="num">${o.n.size}</td>${gl.map((x) => `<td class="num">${g.has(x) ? fRp(g.get(x).val) : '–'}</td>`).join('')}<td class="num"><b>${fRp(o.val)}</b></td><td class="num">${fPct(tot ? o.val / tot : NaN)}</td></tr>`; }).join('') || '<tr class="empty"><td colspan="9">Tidak ada data.</td></tr>'}
      </tbody></table></div><p class="hint">Klik lokasi untuk menyaring semua tampilan ke lokasi itu.</p>`;
  }

  /* ---------- Grafik pergerakan ---------- */
  function series() {
    // per snapshot: value & qty per golongan (atau satu material bila I.chart diisi), mengikuti saringan
    return I.snaps.map((m) => {
      const rows = calc(m.snap).filter((r) => !I.chart || r.kode === I.chart);
      const o = { snap: m.snap, tot: { v: 0, q: 0 } };
      rows.forEach((r) => { o[r.gol] = o[r.gol] || { v: 0, q: 0 }; o[r.gol].v += r.val; o[r.gol].q += r.qty; o.tot.v += r.val; o.tot.q += r.qty; });
      return o;
    });
  }
  function renderChart() {
    const box = $('invChart'); if (!box) return;
    document.querySelectorAll('#invMs [data-v]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === I.ms)));
    const data = series(), key = I.ms === 'v' ? 'v' : 'q';
    const mat = I.chart ? I.gol.get(I.chart) : null;
    $('invChartTitle').innerHTML = I.chart ? `Pergerakan <span class="pl-code">${esc(I.chart)}</span> ${esc(mat ? mat.nama : '')} <button type="button" class="btn-link" data-inv-chart="">kembali ke per golongan</button>` : `Pergerakan ${I.ms === 'v' ? 'value' : 'qty'} per golongan${I.brand ? ' · ' + esc(I.brand) : ''}${I.jenis ? ' · ' + esc(I.jenis) : ''}${I.lok ? ' · ' + esc(I.lok) : ''}${I.q ? ' · cari "' + esc(I.q) + '"' : ''}`;
    if (!data.length) { box.innerHTML = '<p class="muted">Belum ada snapshot.</p>'; return; }
    const gl = I.chart ? ['tot'] : [...GOLS, '?'].filter((g) => data.some((d) => d[g]) && (!I.g || g === I.g));
    const showTot = !I.chart && !I.g && gl.length > 1;
    const ser = (showTot ? ['tot'] : []).concat(I.chart ? ['tot'] : gl);
    const val = (d, g) => (d[g] ? d[g][key] : 0);
    const W = Math.max(Math.round(box.clientWidth || 900), data.length * 60), H = 260, L = 78, R = 24, T = 14, B = 34;
    const max = Math.max(1, ...data.flatMap((d) => ser.map((g) => val(d, g))));
    const nice = (() => { const p = Math.pow(10, Math.floor(Math.log10(max))); const f = max / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; })();
    const x = (i) => (data.length === 1 ? L + (W - L - R) / 2 : L + i * (W - L - R) / (data.length - 1));
    const y = (v) => T + (H - T - B) * (1 - v / nice);
    const fmtAx = (v) => (I.ms === 'v' ? fBig(v).replace('Rp ', '') : v >= 1e6 ? nf1.format(v / 1e6) + ' jt' : nf0.format(v));
    let g = '';
    for (let k = 0; k <= 4; k++) { const v = nice * k / 4; g += `<line class="cslc-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="cslc-ax" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${fmtAx(v)}</text>`; }
    const step = Math.ceil(data.length / 12);
    data.forEach((d, i) => { if (i % step === 0 || i === data.length - 1) g += `<text class="cslc-ax" x="${x(i)}" y="${H - 12}" text-anchor="middle">${esc(fDate(d.snap.slice(0, 10)).slice(0, 6))}</text>`; });
    ser.forEach((s) => {
      const c = s === 'tot' ? (I.chart ? GOL_CLR[golOf(I.chart)] : '#24313d') : GOL_CLR[s];
      const pts = data.map((d, i) => `${x(i)},${y(val(d, s))}`).join(' ');
      g += `<polyline fill="none" stroke="${c}" stroke-width="2"${s === 'tot' && !I.chart ? ' stroke-dasharray="5 4"' : ''} points="${pts}"/>`;
      data.forEach((d, i) => { g += `<circle cx="${x(i)}" cy="${y(val(d, s))}" r="${d.snap === I.snap ? 5 : 3.5}" fill="${c}" stroke="#fff" stroke-width="2"/>`; });
    });
    data.forEach((d, i) => { g += `<rect class="inv-hit" data-i="${i}" x="${x(i) - 18}" y="${T}" width="36" height="${H - T - B}" fill="transparent"/>`; });
    const lg = ser.map((s) => `<span class="inv-lg"><i style="background:${s === 'tot' ? (I.chart ? GOL_CLR[golOf(I.chart)] : '#24313d') : GOL_CLR[s]}"></i>${s === 'tot' ? (I.chart ? esc(I.chart) : 'Total') : esc(GOL_LBL[s])}</span>`).join('');
    box.innerHTML = `<div class="inv-legend">${lg}<span class="muted">Arahkan kursor ke titik; klik untuk memilih snapshot.</span></div><div class="inv-cbox"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Grafik pergerakan inventory">${g}</svg><div class="cslc-tip" id="invTip" hidden></div></div>`;
    const svg = box.querySelector('svg'), tip = $('invTip');
    svg.addEventListener('mousemove', (e) => {
      const h = e.target.closest('.inv-hit'); if (!h) { tip.hidden = true; return; }
      const d = data[+h.dataset.i];
      tip.innerHTML = `<b>${esc(fSnap(d.snap))}</b>` + ser.map((s) => `<div>${s === 'tot' ? (I.chart ? esc(I.chart) : 'Total') : esc(GOL_LBL[s])}: ${I.ms === 'v' ? fRp(val(d, s)) : fQ(val(d, s))}</div>`).join('');
      const r = box.querySelector('.inv-cbox').getBoundingClientRect();
      tip.style.left = Math.min(e.clientX - r.left + 12, r.width - 200) + 'px'; tip.style.top = (e.clientY - r.top + 12) + 'px'; tip.hidden = false;
    });
    svg.addEventListener('mouseleave', () => { tip.hidden = true; });
    svg.addEventListener('click', (e) => { const h = e.target.closest('.inv-hit'); if (h) { I.snap = data[+h.dataset.i].snap; render(); } });
  }

  /* ---------- Excel ---------- */
  const readBook = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => { try { res(XLSX.read(r.result, { type: 'array', cellDates: false })); } catch (e) { rej(new Error('File tidak bisa dibaca sebagai Excel.')); } }; r.onerror = () => rej(new Error('File tidak bisa dibaca.')); r.readAsArrayBuffer(f); });
  const sheetAoa = (wb, sn) => XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '', raw: true });
  function findTable(wb, need, prefer) {
    const names = wb.SheetNames.slice().sort((a, b) => (prefer.test(b) ? 1 : 0) - (prefer.test(a) ? 1 : 0));
    for (const sn of names) {
      const a = sheetAoa(wb, sn);
      for (let i = 0; i < Math.min(15, a.length); i++) {
        const h = a[i].map((x) => S(x).toUpperCase());
        const idx = need.map((n) => h.findIndex((x) => n.test(x)));
        if (idx[0] >= 0 && idx.slice(1).every((x, k) => x >= 0 || need[k + 1].optional)) return { sn, a, hi: i, idx, h };
      }
    }
    return null;
  }
  const rx = (s, opt) => { const r = new RegExp(s); if (opt) r.optional = true; return r; };
  function downloadTpl(kind) {
    const wb = XLSX.utils.book_new();
    const sheet = (name, aoa, w) => { const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = w.map((x) => ({ wch: x })); XLSX.utils.book_append_sheet(wb, ws, name); };
    if (kind === 'gol') {
      const L = [...I.gol.values()].sort((a, b) => a.kode.localeCompare(b.kode, 'id', { numeric: true }));
      sheet('GOLONGAN', [['KODE', 'NAMA', 'GOLONGAN', 'KATEGORI', 'UOM'], ...(L.length ? L.map((g) => [g.kode, g.nama, g.gol, g.kat, g.uom]) : [['10002', 'Asem', 'RM', 'Bahan herbal', 'Kg']])], [14, 50, 12, 24, 8]);
      sheet('PETUNJUK', [['PETUNJUK'], ['GOLONGAN', 'RM, PM, FG, atau WIP (ekstrak/bulk).'], ['KATEGORI', 'Bebas, sesuai penggolongan Mas (boleh kosong dulu).'], ['Upload', 'Mengganti seluruh isi DB_GOLONGAN. Isi file ini sudah berisi daftar yang tersimpan sekarang.']], [12, 80]);
      XLSX.writeFile(wb, 'Format_Golongan_Inventory.xlsx');
    } else if (kind === 'harga') {
      const day = nowParts().d;
      const L = [...I.gol.values()].sort((a, b) => a.kode.localeCompare(b.kode, 'id', { numeric: true }));
      sheet('HARGA', [['KODE', 'HARGA', 'NAMA (info)', 'GOLONGAN (info)', 'HARGA BERLAKU SEKARANG (info)'], ...(L.length ? L.map((g) => { const p = priceAt(g.kode, day + ' 23:59'); return [g.kode, '', g.nama, g.gol, p ? p.h : '']; }) : [['10002', 25000, 'Asem', 'RM', '']])], [14, 14, 50, 14, 26]);
      sheet('PETUNJUK', [['PETUNJUK'], ['KODE, HARGA', 'Wajib. Harga per UoM (Rp). Baris dengan HARGA kosong diabaikan.'], ['Tanggal berlaku', 'Dipilih saat upload. Snapshot stok memakai harga terakhir yang berlaku pada/sebelum tanggal snapshot.'], ['Kolom (info)', 'Hanya keterangan, tidak ikut disimpan.']], [16, 90]);
      XLSX.writeFile(wb, 'Format_Harga_Inventory.xlsx');
    } else {
      sheet('STOK', [['KODE', 'LOKASI', 'QTY'], ['10002', 'WH/Stock', 125.5]], [14, 24, 12]);
      sheet('PETUNJUK', [['PETUNJUK'], ['KODE, LOKASI, QTY', 'Wajib KODE dan QTY. LOKASI boleh kosong. Kode + lokasi yang sama dijumlahkan.'], ['Export Odoo', 'Boleh juga langsung export stok Odoo yang punya kolom Product/Internal Reference, Location, dan Quantity/On Hand Quantity.'], ['Tanggal & jam', 'Dipilih saat upload. Upload dengan tanggal & jam yang sama menimpa snapshot itu.']], [18, 90]);
      XLSX.writeFile(wb, 'Format_Stok_Inventory.xlsx');
    }
  }

  /* ---------- Upload: golongan ---------- */
  function upGol(wb, file) {
    const t = findTable(wb, [rx('^KODE'), rx('^NAMA', 1), rx('^GOLONGAN'), rx('^KATEGORI', 1), rx('^(UOM|SATUAN)', 1)], /golongan/i);
    if (!t) throw new Error('Kolom KODE dan GOLONGAN tidak ditemukan. Pakai Format → Golongan.');
    const [iK, iN, iG, iC, iU] = t.idx, seen = new Map(), bad = [];
    t.a.slice(t.hi + 1).forEach((r, k) => {
      const kode = normCode(r[iK]); if (!kode) return;
      const gol = S(r[iG]).toUpperCase().replace(/\s.*$/, '');
      if (!GOLS.includes(gol)) { bad.push(`Baris ${t.hi + k + 2} · ${kode}: golongan "${S(r[iG])}" bukan RM/PM/FG/WIP`); return; }
      if (seen.has(kode)) bad.push(`Baris ${t.hi + k + 2} · ${kode}: kode dobel, dipakai baris terakhir`);
      seen.set(kode, [kode, iN >= 0 ? S(r[iN]) : '', gol, iC >= 0 ? splitKat(r[iC]).kat : '', iU >= 0 ? S(r[iU]) : '']);
    });
    const rows = [...seen.values()];
    const add = rows.filter((r) => !I.gol.has(r[0])), chg = rows.filter((r) => { const g = I.gol.get(r[0]); return g && (g.gol !== r[2] || g.kat !== r[3] || g.nama !== r[1] || g.uom !== r[4]); });
    const del = [...I.gol.keys()].filter((k) => !seen.has(k));
    const cnt = {}; rows.forEach((r) => { cnt[r[2]] = (cnt[r[2]] || 0) + 1; });
    const noKat = rows.filter((r) => !r[3]).length;
    review('Upload golongan', `<p class="dlg-lead">File <b>${esc(file)}</b> (sheet ${esc(t.sn)}): <b>${rows.length}</b> kode — ${GOLS.filter((g) => cnt[g]).map((g) => `${g} ${cnt[g]}`).join(' · ')}. Upload ini <b>mengganti seluruh isi DB_GOLONGAN</b>.</p>
      <ul class="kfr-ul"><li>${add.length} kode baru</li><li>${chg.length} kode berubah (golongan/kategori/nama/UoM)</li>${del.length ? `<li class="pl-bad">${del.length} kode lama tidak ada di file (akan terhapus dari golongan): ${esc(del.slice(0, 20).join(', '))}${del.length > 20 ? '…' : ''}</li>` : ''}${noKat ? `<li class="muted">${noKat} kode belum diisi kategori (tampil sebagai "Tanpa kategori")</li>` : ''}</ul>
      ${chg.length ? `<details class="kfr-sec"><summary>Rincian perubahan <span>${chg.length}</span></summary><ul class="kfr-ul">${chg.slice(0, 200).map((r) => { const g = I.gol.get(r[0]); return `<li><span class="pl-code">${esc(r[0])}</span> ${g.gol !== r[2] ? `golongan ${esc(g.gol)} → <b>${esc(r[2])}</b> ` : ''}${g.kat !== r[3] ? `kategori "${esc(g.kat)}" → <b>"${esc(r[3])}"</b>` : ''}</li>`; }).join('')}</ul></details>` : ''}
      ${bad.length ? `<details class="kfr-sec is-bad" open><summary><b>Ditolak / catatan</b> <span>${bad.length}</span></summary><ul class="kfr-ul">${bad.slice(0, 200).map((b) => `<li>${esc(b)}</li>`).join('')}</ul></details>` : ''}`,
    rows.length, () => api('saveGolongan', { rows, file }));
  }
  /* ---------- Upload: harga ---------- */
  function upHarga(wb, file) {
    const t = findTable(wb, [rx('^KODE'), rx('^HARGA$|^HARGA ?\\(|^HARGA SATUAN|^PRICE|^HARGA/')], /harga/i);
    if (!t) throw new Error('Kolom KODE dan HARGA tidak ditemukan. Pakai Format → Harga.');
    const [iK, iH] = t.idx, seen = new Map(), bad = [];
    t.a.slice(t.hi + 1).forEach((r, k) => {
      const kode = normCode(r[iK]); if (!kode) return;
      if (S(r[iH]) === '') return;
      const h = num(r[iH]);
      if (!isNum(h) || h < 0) { bad.push(`Baris ${t.hi + k + 2} · ${kode}: harga "${S(r[iH])}" tidak terbaca`); return; }
      seen.set(kode, [kode, h]);
    });
    const rows = [...seen.values()];
    const day = nowParts().d;
    const body = (from) => {
      const cmp = rows.map((r) => ({ r, p: priceAt(r[0], from + ' 23:59') }));
      const up = cmp.filter((x) => x.p && x.p.h !== x.r[1]), nw = cmp.filter((x) => !x.p), noG = rows.filter((r) => !I.gol.has(r[0]));
      return `<ul class="kfr-ul"><li>${nw.length} kode belum punya harga sebelumnya</li><li>${up.length} kode berubah harga</li><li class="muted">${cmp.length - nw.length - up.length} kode harga sama</li>${noG.length ? `<li class="pl-bad">${noG.length} kode tidak ada di golongan: ${esc(noG.slice(0, 15).map((r) => r[0]).join(', '))}${noG.length > 15 ? '…' : ''}</li>` : ''}</ul>
        ${up.length ? `<details class="kfr-sec"><summary>Perubahan harga <span>${up.length}</span></summary><div class="table-wrap"><table class="po-table pl-mini"><thead><tr><th>Kode</th><th>Nama</th><th class="num">Harga lama</th><th class="num">Harga baru</th><th class="num">Δ</th></tr></thead><tbody>${up.slice(0, 300).map((x) => `<tr><td>${esc(x.r[0])}</td><td>${esc((I.gol.get(x.r[0]) || {}).nama || '')}</td><td class="num">${fRp(x.p.h)} <small class="muted">${esc(fDate(x.p.from))}</small></td><td class="num"><b>${fRp(x.r[1])}</b></td><td class="num ${dCls(x.r[1] - x.p.h)}">${x.p.h ? fPct((x.r[1] - x.p.h) / x.p.h) : '–'}</td></tr>`).join('')}</tbody></table></div></details>` : ''}`;
    };
    review('Upload harga', `<p class="dlg-lead">File <b>${esc(file)}</b> (sheet ${esc(t.sn)}): <b>${rows.length}</b> kode berharga. Riwayat harga lama tetap tersimpan.</p>
      <label class="fld inv-fld"><span>Tanggal berlaku harga</span><input type="date" name="berlaku" id="invBerlaku" value="${day}" required></label>
      <div id="invHrgCmp">${body(day)}</div>
      ${bad.length ? `<details class="kfr-sec is-bad" open><summary><b>Ditolak</b> <span>${bad.length}</span></summary><ul class="kfr-ul">${bad.slice(0, 200).map((b) => `<li>${esc(b)}</li>`).join('')}</ul></details>` : ''}`,
    rows.length, (fd) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(fd.berlaku || '')) throw new Error('Isi tanggal berlaku.'); return api('addHarga', { rows, berlaku: fd.berlaku, file }); },
    () => { $('invBerlaku').addEventListener('change', () => { if (/^\d{4}-\d{2}-\d{2}$/.test($('invBerlaku').value)) $('invHrgCmp').innerHTML = body($('invBerlaku').value); }); });
  }
  /* ---------- Upload: stok ---------- */
  function upStok(wb, file) {
    let t = findTable(wb, [rx('^KODE$|^INTERNAL REFERENCE|^PRODUCT/INTERNAL|^DEFAULT_CODE|^PRODUCT_ID/DEFAULT_CODE'), rx('^LOKASI|^LOCATION', 1), rx('^QTY$|^QTY |^QUANTITY|^ON HAND|^QUANTITY ON HAND|^AVAILABLE')], /stok|stock|quant/i);
    let fromName = false;
    if (!t) { t = findTable(wb, [rx('^PRODUCT$|^PRODUK$'), rx('^LOKASI|^LOCATION', 1), rx('^QTY$|^QUANTITY|^ON HAND|^QUANTITY ON HAND')], /stok|stock|quant/i); fromName = !!t; }
    if (!t) throw new Error('Kolom KODE dan QTY tidak ditemukan. Pakai Format → Stok, atau export Odoo yang memuat Internal Reference/Product, Location, dan Quantity.');
    const [iK, iL, iQ] = t.idx, agg = new Map(), bad = [];
    t.a.slice(t.hi + 1).forEach((r, k) => {
      let kode = S(r[iK]);
      if (fromName) { const m = kode.match(/^\[([^\]]+)\]/); kode = m ? m[1].trim() : ''; }
      kode = normCode(kode);
      if (!kode) { if (S(r[iK]) || S(r[iQ])) bad.push(`Baris ${t.hi + k + 2}: kode kosong / tidak terbaca`); return; }
      const q = num(r[iQ]);
      if (!isNum(q)) { bad.push(`Baris ${t.hi + k + 2} · ${kode}: qty "${S(r[iQ])}" tidak terbaca`); return; }
      const lok = iL >= 0 ? S(r[iL]) : '', key = kode + '\u0001' + lok;
      agg.set(key, [kode, lok, (agg.has(key) ? agg.get(key)[2] : 0) + q]);
    });
    const rows = [...agg.values()];
    const kodes = new Set(rows.map((r) => r[0])), loks = new Set(rows.map((r) => r[1]));
    const noG = [...kodes].filter((k) => !I.gol.has(k));
    const np = nowParts();
    const chk = (d, tm) => { const s = `${d} ${tm}`; const p = [...kodes].filter((k) => !priceAt(k, s)).length; const ex = I.stok.has(s); return `<ul class="kfr-ul"><li><b>${rows.length}</b> baris (kode × lokasi) · ${kodes.size} kode · ${loks.size} lokasi</li>${noG.length ? `<li class="pl-bad">${noG.length} kode tidak ada di golongan: ${esc(noG.slice(0, 15).join(', '))}${noG.length > 15 ? '…' : ''}</li>` : ''}${p ? `<li class="pl-bad">${p} kode belum punya harga berlaku per ${esc(fDate(d))} (value 0)</li>` : ''}${ex ? `<li class="pl-bad"><b>Snapshot ${esc(fSnap(s))} sudah ada dan akan ditimpa.</b></li>` : ''}</ul>`; };
    review('Upload stok', `<p class="dlg-lead">File <b>${esc(file)}</b> (sheet ${esc(t.sn)}). Kode + lokasi yang sama dijumlahkan.</p>
      <div class="inv-dt"><label class="fld inv-fld"><span>Tanggal snapshot</span><input type="date" name="d" id="invSD" value="${np.d}" required></label><label class="fld inv-fld"><span>Jam</span><input type="time" name="t" id="invST" value="${np.t}" required></label><label class="fld inv-fld inv-note"><span>Catatan (opsional)</span><input type="text" name="note" maxlength="200" placeholder="mis. stock opname akhir bulan"></label></div>
      <div id="invStChk">${chk(np.d, np.t)}</div>
      ${bad.length ? `<details class="kfr-sec is-bad" open><summary><b>Ditolak</b> <span>${bad.length}</span></summary><ul class="kfr-ul">${bad.slice(0, 200).map((b) => `<li>${esc(b)}</li>`).join('')}</ul></details>` : ''}`,
    rows.length, (fd) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(fd.d || '') || !/^\d{2}:\d{2}$/.test(fd.t || '')) throw new Error('Isi tanggal dan jam snapshot.'); I.snap = `${fd.d} ${fd.t}`; return api('saveStok', { snapshot: `${fd.d} ${fd.t}`, rows, file, note: fd.note || '' }); },
    () => { const f = () => { if ($('invSD').value && $('invST').value) $('invStChk').innerHTML = chk($('invSD').value, $('invST').value); }; $('invSD').addEventListener('change', f); $('invST').addEventListener('change', f); });
  }
  // Review 2 langkah: langkah 1 isi + tombol lanjut, langkah 2 centang konfirmasi lalu simpan
  function review(title, body, n, save, after) {
    if (!n) { openDialog({ title, body: body + '<p class="check err">Tidak ada baris yang bisa disimpan.</p>', ok: 'Tutup', cancel: false, onSubmit: async () => '' }); return; }
    openDialog({
      title: title + ' · periksa', ok: 'Lanjut', wide: true,
      body: body + '<label class="tb-check kfr-ack"><input type="checkbox" name="ack" id="invAck"> Sudah saya periksa, simpan ke Google Sheet</label>',
      onSubmit: async (fd) => { if (!fd.ack) throw new Error('Centang dulu "Sudah saya periksa".'); return save(fd); },
    });
    $('dlgOk').textContent = 'Simpan'; $('dlgOk').disabled = true;
    $('invAck').addEventListener('change', () => { $('dlgOk').disabled = !$('invAck').checked; });
    if (after) after();
  }

  /* ---------- Koreksi manual ---------- */
  function editDialog() {
    if (!I.snap) return;
    const L = I.stok.get(I.snap) || [];
    const kodes = [...new Set([...L.map((r) => r.kode), ...I.gol.keys()])].sort();
    const loks = [...new Set(L.map((r) => r.lok))].sort();
    const line = (i) => `<div class="inv-er" data-i="${i}"><input type="text" name="k${i}" list="invKL" placeholder="Kode" autocomplete="off"><input type="text" name="l${i}" list="invLL" placeholder="Lokasi" autocomplete="off"><input type="text" name="q${i}" inputmode="decimal" placeholder="Qty baru"><span class="muted inv-eo" id="invEo${i}"></span></div>`;
    openDialog({
      title: `Koreksi stok · ${fSnap(I.snap)}`, ok: 'Simpan koreksi', wide: true,
      body: `<p class="dlg-lead">Ubah qty kode + lokasi yang sudah ada, atau tambah baris baru pada snapshot ini. Tercatat sebagai <b>manual</b> beserta alasannya di LOG.</p>
        <datalist id="invKL">${kodes.map((k) => `<option value="${esc(k)}">${esc((I.gol.get(k) || {}).nama || '')}</option>`).join('')}</datalist><datalist id="invLL">${loks.map((k) => `<option value="${esc(k)}">`).join('')}</datalist>
        <div class="inv-eh"><span>Kode</span><span>Lokasi</span><span>Qty baru</span><span>Saat ini</span></div><div id="invEl">${[0, 1, 2].map(line).join('')}</div>
        <button type="button" class="btn btn-ghost btn-sm" id="invEAdd">+ Baris</button>
        <label class="fld inv-fld"><span>Alasan koreksi (wajib)</span><input type="text" name="reason" maxlength="300" required placeholder="mis. hasil hitung ulang gudang"></label>`,
      onSubmit: async (fd) => {
        const ch = [];
        Object.keys(fd).filter((k) => /^k\d+$/.test(k)).forEach((k) => { const i = k.slice(1), kode = normCode(fd[k]); if (!kode) return; const q = num(fd['q' + i]); if (!isNum(q)) throw new Error(`Qty untuk ${kode} belum diisi / tidak terbaca.`); ch.push({ kode, lokasi: S(fd['l' + i]), qty: q }); });
        if (!ch.length) throw new Error('Isi minimal satu baris.');
        if (!S(fd.reason)) throw new Error('Isi alasan koreksi.');
        return api('editStok', { snapshot: I.snap, changes: ch, reason: S(fd.reason) });
      },
    });
    let n = 3;
    $('invEAdd').addEventListener('click', () => { $('invEl').insertAdjacentHTML('beforeend', line(n++)); });
    $('invEl').addEventListener('input', (e) => {
      const row = e.target.closest('.inv-er'); if (!row) return;
      const i = row.dataset.i, kode = normCode(row.querySelector(`[name=k${i}]`).value), lok = S(row.querySelector(`[name=l${i}]`).value);
      const ex = L.filter((r) => r.kode === kode);
      const hit = ex.find((r) => r.lok === lok);
      $('invEo' + i).textContent = !kode ? '' : hit ? `${fQ(hit.qty)} → ubah` : ex.length ? `ada di ${ex.length} lokasi lain · baris baru` : 'baris baru';
    });
  }

  /* ---------- Event ---------- */
  function bind() {
    if (!$('view-rep-inv') || bind.done) return; bind.done = true;
    $('invSnap').addEventListener('change', () => { I.snap = $('invSnap').value; render(); });
    $('invGol').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b) return; I.g = b.dataset.v; render(); });
    $('invView').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b) return; I.view = b.dataset.v; savePref(); render(); });
    $('invMs').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b) return; I.ms = b.dataset.v; savePref(); renderChart(); });
    $('invBrand').addEventListener('change', () => { I.brand = $('invBrand').value; I.jenis = ''; render(); });
    $('invJenis').addEventListener('change', () => { I.jenis = $('invJenis').value; render(); });
    $('invLok').addEventListener('change', () => { I.lok = $('invLok').value; render(); });
    let tq; $('invQ').addEventListener('input', () => { clearTimeout(tq); tq = setTimeout(() => { I.q = $('invQ').value.trim(); render(); }, 200); });
    $('invEdit').addEventListener('click', editDialog);
    $('invTpl').addEventListener('change', () => { const v = $('invTpl').value; $('invTpl').value = ''; if (v) downloadTpl(v); });
    ['gol', 'harga', 'stok'].forEach((k) => {
      const inp = $('invUp-' + k);
      inp.addEventListener('change', async () => {
        const f = inp.files[0]; inp.value = ''; if (!f) return;
        try { const wb = await readBook(f); (k === 'gol' ? upGol : k === 'harga' ? upHarga : upStok)(wb, f.name); }
        catch (err) { toast(err.message); $('invMsg').className = 'check err'; $('invMsg').textContent = err.message; }
      });
    });
    $('view-rep-inv').addEventListener('click', (e) => {
      const o = e.target.closest('[data-inv-open]'); if (o) { const k = o.dataset.invOpen; if (I.open.has(k)) I.open.delete(k); else I.open.add(k); render(); return; }
      const c = e.target.closest('[data-inv-chart]'); if (c) { I.chart = c.dataset.invChart; renderChart(); if (I.chart) $('invChartCard').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
      const l = e.target.closest('[data-inv-lok]'); if (l) { I.lok = l.dataset.invLok; render(); return; }
      if (e.target.closest('[data-inv-warn]')) { I.openWarn = true; render(); const w = $('invWarn'); if (w) w.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    });
    document.addEventListener('toggle', (e) => { if (e.target && e.target.id === 'invWarn') I.openWarn = e.target.open; }, true);
  }

  window.INV = {
    enter() { bind(); render(); if (!I.loaded && !I.loading) load(); },
    reload() { load(true); },
    sheetUrl() { return I.sheetUrl || CFG.INV_SHEET_URL || ''; },
  };
  // app.js dimuat lebih dulu: bila halaman dibuka langsung di menu ini, masuk sekarang
  if (/^#\/rep\//.test(location.hash)) window.INV.enter();
})();
