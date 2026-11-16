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
    ct: 'line', bdim: { MAT: 'gol', FG: 'brand' }, bsnaps: null, bcats: null,
    kel: 'MAT', all: { MAT: { stok: new Map(), snaps: [] }, FG: { stok: new Map(), snaps: [] } }, selSnap: { MAT: '', FG: '' },
    snap: '', g: '', brand: '', jenis: '', lok: '', q: '', view: 'kat', mvP: 3, mvF: '', mvPar: 80, mvWk: 50, mv: null, mvCache: new Map(), ms: 'v', chart: '', open: new Set(), sheetUrl: '', readAt: '',
  };
  try { const v = JSON.parse(localStorage.getItem('ppic.inv') || '{}'); ['view', 'ms', 'kel', 'pm', 'ct', 'mvP', 'mvPar', 'mvWk'].forEach((k) => { if (v[k]) I[k] = v[k]; }); if (![3, 6, 12].includes(+I.mvP)) I.mvP = 3; I.mvP = +I.mvP; if (I.pm !== 'latest') I.pm = 'date'; if (I.kel !== 'FG') I.kel = 'MAT'; } catch (e) { /* abaikan */ }
  const savePref = () => { try { localStorage.setItem('ppic.inv', JSON.stringify({ view: I.view, ms: I.ms, kel: I.kel, pm: I.pm, ct: I.ct, mvP: I.mvP, mvPar: I.mvPar, mvWk: I.mvWk })); } catch (e) { /* abaikan */ } };

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
    // Stok Material (RM + PM + WIP) dan FG disimpan & dilaporkan terpisah. Baris lama tanpa KELOMPOK: ikut golongan kodenya.
    const kelOf = (v, kode) => { const t = S(v).toUpperCase(); return t === 'FG' ? 'FG' : t ? 'MAT' : golOf(kode) === 'FG' ? 'FG' : 'MAT'; };
    ['MAT', 'FG'].forEach((kel) => { I.all[kel] = { stok: new Map(), snaps: [] }; });
    (d.stok || []).forEach((r) => { const s = S(r[0]); const k = normCode(r[1]); if (!s || !k) return; const A = I.all[kelOf(r[6], k)]; const L = A.stok.get(s) || []; L.push({ kode: k, lok: S(r[2]), qty: Number(r[3]) || 0, src: S(r[4]), note: S(r[5]) }); A.stok.set(s, L); });
    ['MAT', 'FG'].forEach((kel) => {
      const A = I.all[kel];
      const meta = new Map((d.snapshot || []).filter((r) => (S(r[5]).toUpperCase() === 'FG' ? 'FG' : 'MAT') === kel).map((r) => [S(r[0]), { snap: S(r[0]), file: S(r[1]), n: Number(r[2]) || 0, up: S(r[3]), note: S(r[4]) }]));
      A.stok.forEach((L, s) => { if (!meta.has(s)) meta.set(s, { snap: s, file: '', n: L.length, up: '', note: '' }); });
      A.snaps = [...meta.values()].filter((m) => A.stok.has(m.snap)).sort((a, b) => (a.snap < b.snap ? -1 : 1));
    });
    useKel();
    I.loaded = true;
  }
  function useKel() {
    const A = I.all[I.kel];
    I.stok = A.stok; I.snaps = A.snaps;
    if (!I.snaps.some((m) => m.snap === I.selSnap[I.kel])) I.selSnap[I.kel] = I.snaps.length ? I.snaps[I.snaps.length - 1].snap : '';
    I.snap = I.selSnap[I.kel];
  }
  const setSnap = (sn) => { I.snap = sn; I.selSnap[I.kel] = sn; };
  const KEL_LBL = { MAT: 'Material (RM, PM, WIP)', FG: 'FG' };
  const BR_PAL = ['#106a3a', '#2f6db5', '#b07d16', '#8a4fb0', '#c2410c', '#0f766e', '#a8326e', '#5b6b7a'];
  const grpOf = (r) => (I.kel === 'FG' ? (r.brand || 'Tanpa brand') : r.gol);
  const grpLbl = (k) => (I.kel === 'FG' ? k : GOL_LBL[k] || k);
  const grpClr = (k) => { if (I.kel !== 'FG') return GOL_CLR[k] || '#8a94a0'; if (k === 'Lainnya' || k === 'Tanpa brand') return '#8a94a0'; const i = (I.brRank || []).indexOf(k); return i >= 0 && i < BR_PAL.length - 1 ? BR_PAL[i] : '#8a94a0'; };
  // Dasar harga: 'date' = harga terakhir yang berlaku pada/sebelum tanggal snapshot; 'latest' = harga terkini (paling baru) apa pun tanggal snapshotnya
  const priceAtMode = (kode, snap, mode) => { const L = I.harga.get(kode); if (!L || !L.length) return null; if (mode === 'latest') return L[L.length - 1]; const day = snap.slice(0, 10); let p = null; L.forEach((x) => { if (x.from <= day) p = x; }); return p; };
  const priceAt = (kode, snap) => priceAtMode(kode, snap, I.pm);
  const PM_LBL = { date: 'sesuai tanggal snapshot', latest: 'harga terkini' };
  // KATEGORI berpola "BRAND - JENIS" (FG). Tanpa " - " → tanpa brand, jenis = kategori.
  function splitKat(v) {
    const kat = S(v).replace(/\s+/g, ' ').replace(/\s+-\s+/, ' - ');
    const i = kat.indexOf(' - ');
    return i > 0 ? { kat, brand: kat.slice(0, i).trim(), jenis: kat.slice(i + 3).trim() } : { kat, brand: '', jenis: kat };
  }
  const golOf = (kode) => { const g = I.gol.get(kode); return g && GOLS.includes(g.gol) ? g.gol : '?'; };

  /* ---------- Pergerakan FG dari DO CSL: Fast / Slow / Not Move / Dead Stock ---------- */
  // Periode P bulan dihitung mundur dari tanggal snapshot. Fast = masuk Pareto qty (mvPar %) DAN ada DO di ≥ mvWk % minggu.
  // Slow = ada DO tapi bukan Fast. Not Move = tanpa DO di periode, ada DO di periode sebelumnya (s/d 2× P). Dead Stock = tanpa DO 2× P.
  const MV = { F: 'Fast Moving', S: 'Slow Moving', N: 'Not Move', D: 'Dead Stock', X: 'Tanpa data DO' };
  const MV_CLR = { F: '#1e7a46', S: '#c9962b', N: '#d0612a', D: '#8e2b22', X: '#7b8794' };
  const dayN = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 864e5;
  const isoOf = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
  const addMon = (d, k) => { const y = +d.slice(0, 4), m = +d.slice(5, 7) - 1 + k, dd = +d.slice(8, 10); const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); return new Date(Date.UTC(y, m, Math.min(dd, last))).toISOString().slice(0, 10); };
  async function loadMv() {
    if (I.mv && (I.mv.lines || I.mv.loading)) return;
    I.mv = { loading: true };
    try {
      if (!window.CSL || !window.CSL.doOut) throw new Error('modul CSL tidak tersedia');
      const d = await window.CSL.doOut();
      const by = new Map(); d.lines.forEach(([k, dt, q]) => { if (!by.has(k)) by.set(k, []); by.get(k).push([dt, q]); });
      I.mv = { lines: d.lines, by, from: d.from, to: d.to, noDate: d.noDate };
    } catch (e) { I.mv = { err: e.message }; }
    I.mvCache.clear();
    if (I.kel === 'FG') render();
  }
  function mvCalc(snap) {
    if (!I.mv || !I.mv.by || !snap) return null;
    const P = I.mvP, key = `${snap}|${P}|${I.mvPar}|${I.mvWk}`;
    if (I.mvCache.has(key)) return I.mvCache.get(key);
    const end = snap.slice(0, 10), from = isoOf(dayN(addMon(end, -P)) + 1), pFrom = isoOf(dayN(addMon(end, -2 * P)) + 1);
    const nW = Math.max(1, Math.ceil((dayN(end) - dayN(from) + 1) / 7)), f0 = dayN(from);
    const out = new Map(); let tot = 0;
    I.mv.by.forEach((L, k) => {
      const o = { qty: 0, wk: new Set(), last: '', prev: false };
      L.forEach(([dt, q]) => { if (dt > end) return; if (dt > o.last) o.last = dt; if (dt >= from) { o.qty += q; o.wk.add(Math.floor((dayN(dt) - f0) / 7)); } else if (dt >= pFrom) o.prev = true; });
      if (o.qty > 0) tot += o.qty;
      out.set(k, o);
    });
    // Pareto: urut qty terbesar; masuk selama kumulatif sebelum item < batas
    let cum = 0; const lim = tot * I.mvPar / 100;
    [...out].filter(([, o]) => o.qty > 0).sort((a, b) => b[1].qty - a[1].qty).forEach(([, o]) => { o.par = cum < lim - 1e-9; cum += o.qty; });
    out.forEach((o) => { o.nw = o.wk.size; o.fr = o.nw / nW; o.avg = o.qty / P; o.cls = o.qty > 0 ? (o.par && o.fr * 100 >= I.mvWk - 1e-9 ? 'F' : 'S') : o.prev ? 'N' : 'D'; });
    const res = { map: out, from, end, pFrom, nW, P, tot, short: I.mv.from && `${I.mv.from}-01` > pFrom ? (`${I.mv.from}-01` > from ? 'all' : 'prev') : '' };
    I.mvCache.set(key, res);
    return res;
  }
  // Kode yang tidak pernah muncul di DO CSL sama sekali → X (bisa jadi bukan produk CSL Personal Care, atau memang tidak pernah keluar)
  const mvOf = (M, kode) => (M ? (M.map.get(kode) || { qty: 0, nw: 0, fr: 0, avg: 0, last: '', cls: 'X' }) : null);
  const mvChip = (c) => `<span class="inv-mv inv-mv-${c}">${MV[c]}</span>`;

  /* ---------- Hitung per snapshot ---------- */
  // rows: per kode+lokasi; filter mengikuti saringan (golongan, kategori, lokasi, cari)
  function calc(snap, ignoreFilter) {
    const L = I.stok.get(snap) || [], q = I.q.toLowerCase(), MVF = I.kel === 'FG' && I.mvF ? mvCalc(I.snap) : null, MVS = I.kel === 'FG' ? mvCalc(snap) : null;
    const out = [];
    L.forEach((r) => {
      const g = I.gol.get(r.kode), gol = golOf(r.kode), kat = (g && g.kat) || 'Tanpa kategori', brand = (g && g.brand) || '', jenis = (g && g.jenis) || 'Tanpa kategori';
      if (!ignoreFilter) {
        if (I.g && gol !== I.g) return;
        if (I.brand && brand !== I.brand) return;
        if (I.jenis && jenis !== I.jenis) return;
        if (I.lok && r.lok !== I.lok) return;
        if (q && !(r.kode + ' ' + ((g && g.nama) || '')).toLowerCase().includes(q)) return;
        if (I.kel === 'FG' && I.mvF && MVF && mvOf(MVF, r.kode).cls !== I.mvF) return;
      }
      const p = priceAt(r.kode, snap);
      out.push({ kode: r.kode, nama: (g && g.nama) || '', uom: (g && g.uom) || '', gol, kat, brand, jenis, lok: r.lok, qty: r.qty, src: r.src, note: r.note, price: p ? p.h : null, from: p ? p.from : '', val: p ? r.qty * p.h : 0, noPrice: !p, noGol: !g || gol === '?', mv: MVS ? mvOf(MVS, r.kode).cls : '' });
    });
    return out;
  }
  const sumBy = (rows, key) => { const m = new Map(); rows.forEach((r) => { const k = key(r); const o = m.get(k) || { qty: 0, val: 0, n: new Set(), rows: [] }; o.qty += r.qty; o.val += r.val; o.n.add(r.kode); o.rows.push(r); m.set(k, o); }); return m; };
  const prevSnap = () => { const i = I.snaps.findIndex((m) => m.snap === I.snap); return i > 0 ? I.snaps[i - 1].snap : ''; };

  /* ---------- Render ---------- */
  function paintLoading(on) { document.querySelectorAll('[data-inv-loading]').forEach((x) => { x.hidden = !on; }); }
  function render() {
    if (!$('invBody')) return;
    $('dataInfo').textContent = I.loaded ? `Value and Qty Inventory dibaca ${I.readAt ? fSnap(I.readAt.slice(0, 16)) : ''} · ${I.gol.size} kode golongan · ${I.all.MAT.snaps.length} snapshot Material · ${I.all.FG.snaps.length} snapshot FG` : I.err === 'noUrl' ? 'Apps Script inventory belum dipasang' : 'Memuat…';
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
    document.querySelectorAll('#invPm [data-v]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === I.pm)));
    document.querySelectorAll('#invKel [data-v]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === I.kel)));
    $('invGol').hidden = I.kel === 'FG';
    $('invGol').innerHTML = [['', 'Semua'], ['RM', 'RM'], ['PM', 'PM'], ['WIP', 'WIP']].map(([v, t]) => `<button type="button" data-v="${v}" aria-pressed="${v === I.g}">${t}</button>`).join('');
    if (I.kel !== 'FG' && I.view === 'mov') I.view = 'kat';
    $('invViewMov').hidden = I.kel !== 'FG';
    $('invMvBar').hidden = I.kel !== 'FG';
    if (I.kel === 'FG') {
      document.querySelectorAll('#invMvP [data-v]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.v === I.mvP)));
      $('invMvF').value = I.mvF; $('invMvPar').value = I.mvPar; $('invMvWk').value = I.mvWk;
      if (!I.mv) loadMv();
    }
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
      $('invBody').innerHTML = `<div class="inv-empty"><h3>Belum ada data stok ${esc(KEL_LBL[I.kel])}</h3><p>Langkahnya: (1) upload <b>golongan</b> (kode, nama, golongan, kategori, UoM), (2) upload <b>harga</b> dengan tanggal berlaku, (3) upload <b>stok ${I.kel === 'FG' ? 'FG' : 'Material'}</b> dengan tanggal & jam snapshot. Format Excel masing-masing ada di tombol <b>Format</b>.</p><p class="muted">${I.gol.size} kode golongan · ${I.harga.size} kode berharga tersimpan.</p></div>`;
      return;
    }
    const rows = calc(I.snap), pv = prevSnap(), prows = pv ? calc(pv) : null;
    // Warna brand FG mengikuti urutan value snapshot terpilih (6 terbesar berwarna, sisanya abu)
    I.brRank = I.kel === 'FG' ? [...sumBy(all, (r) => r.brand || 'Tanpa brand')].sort((a, b) => b[1].val - a[1].val).map(([k]) => k).filter((k) => k !== 'Tanpa brand') : [];
    const meta = I.snaps.find((m) => m.snap === I.snap);
    $('invInfo').innerHTML = `Stok <b>${esc(KEL_LBL[I.kel])}</b> · snapshot <b>${esc(fSnap(I.snap))}</b>${meta && meta.file ? ` · ${esc(meta.file)}` : ''}${pv ? ` · dibandingkan dengan ${esc(fSnap(pv))}` : ' · snapshot pertama'} · harga: ${I.pm === 'latest' ? 'terkini (harga paling baru, apa pun tanggal snapshotnya)' : `terakhir yang berlaku pada/sebelum ${esc(fDate(I.snap.slice(0, 10)))}`}`;
    renderKpi(rows, prows);
    renderChart();
    $('invBody').innerHTML = (I.kel === 'FG' ? mvNote() : '') + renderWarn(rows) + (I.view === 'kat' ? viewKat(rows, prows) : I.view === 'mat' ? viewMat(rows, prows) : I.view === 'mov' ? viewMov(rows) : viewLok(rows));
  }
  function renderKpi(rows, prows) {
    const tot = rows.reduce((t, r) => t + r.val, 0), ptot = prows ? prows.reduce((t, r) => t + r.val, 0) : NaN;
    const by = sumBy(rows, grpOf), pby = prows ? sumBy(prows, grpOf) : new Map();
    const card = (lbl, v, pvv, sub, g) => `<div class="pk inv-k"${g ? ` style="--gc:${grpClr(g)}"` : ''}><span class="pk-lbl">${lbl}</span><span class="pk-num">${fBig(v)}</span><span class="inv-ksub"><span class="${dCls(delta(v, pvv))}">${isNum(pvv) ? dTxt(delta(v, pvv), fBig) : 'pembanding –'}</span>${sub ? ' · ' + sub : ''}</span></div>`;
    let gl = [...GOLS, '?'].filter((g) => by.has(g));
    if (I.kel === 'FG') {
      gl = [...by.keys()].sort((a, b) => by.get(b).val - by.get(a).val);
      if (gl.length > 6) {
        const rest = gl.slice(5), agg = (m) => { const o = { qty: 0, val: 0, n: new Set() }; rest.forEach((k) => { const x = m.get(k); if (x) { o.qty += x.qty; o.val += x.val; x.n.forEach((c) => o.n.add(c)); } }); return o; };
        by.set('Lainnya', agg(by)); if (prows) pby.set('Lainnya', agg(pby)); gl = gl.slice(0, 5).concat('Lainnya');
      }
    }
    const noP = new Set(rows.filter((r) => r.noPrice).map((r) => r.kode)).size, noG = new Set(rows.filter((r) => r.noGol).map((r) => r.kode)).size;
    const M = I.kel === 'FG' ? mvCalc(I.snap) : null;
    let mvCard = '';
    if (M) {
      const bad = rows.filter((r) => r.qty > 0 && ['S', 'N', 'D'].includes(mvOf(M, r.kode).cls)), bv = bad.reduce((t, r) => t + r.val, 0);
      mvCard = `<button type="button" class="pk inv-k inv-kmv" data-inv-mv="1" style="--gc:${MV_CLR.N}" title="Lihat per pergerakan"><span class="pk-lbl">Slow, Not Move, Dead <small>${fPct(tot ? bv / tot : NaN)}</small></span><span class="pk-num">${fBig(bv)}</span><span class="inv-ksub">${new Set(bad.map((r) => r.kode)).size} kode · periode ${M.P} bln</span></button>`;
    }
    $('invKpi').innerHTML = card('Total value', tot, ptot, `${nf0.format(new Set(rows.map((r) => r.kode)).size)} kode`) + mvCard
      + gl.map((g) => { const o = by.get(g), p = pby.get(g); return card(`${esc(grpLbl(g))}${g === 'Lainnya' ? ' brand' : ''} <small>${fPct(tot ? o.val / tot : NaN)}</small>`, o.val, prows ? (p ? p.val : 0) : NaN, `qty ${fQ(o.qty)} · ${o.n.size} kode`, g); }).join('')
      + (noP || noG ? `<button type="button" class="pk is-warn inv-kw" data-inv-warn="1"><span class="pk-lbl">Perlu dilengkapi</span><span class="pk-num">${noP + noG}</span><span class="inv-ksub">${noP ? `${noP} tanpa harga` : ''}${noP && noG ? ' · ' : ''}${noG ? `${noG} tanpa golongan` : ''}</span></button>` : '');
  }
  function renderWarn(rows) {
    const noP = [...new Map(rows.filter((r) => r.noPrice).map((r) => [r.kode, r])).values()];
    const noG = [...new Map(rows.filter((r) => r.noGol).map((r) => [r.kode, r])).values()];
    const inStok = new Set(calc(I.snap, true).map((r) => r.kode));
    const idle = [...I.gol.values()].filter((g) => !inStok.has(g.kode) && (I.kel === 'FG' ? g.gol === 'FG' : g.gol !== 'FG') && (!I.g || g.gol === I.g));
    if (!noP.length && !noG.length && !idle.length) return '';
    const li = (L, f) => L.slice(0, 300).map(f).join('') + (L.length > 300 ? `<li class="muted">… ${L.length - 300} lagi</li>` : '');
    return `<details class="inv-warn" id="invWarn"${I.openWarn ? ' open' : ''}><summary><b>Perlu dilengkapi</b> <span>${noP.length ? `${noP.length} kode tanpa harga (value 0)` : ''}${noP.length && noG.length ? ' · ' : ''}${noG.length ? `${noG.length} kode tanpa golongan` : ''}${idle.length ? `${noP.length || noG.length ? ' · ' : ''}<span class="muted">${idle.length} kode golongan tidak ada di stok</span>` : ''}</span></summary>
      <div class="inv-wg">
        ${noP.length ? `<div><h4>${I.pm === 'latest' ? 'Belum punya harga sama sekali' : `Tanpa harga berlaku per ${esc(fDate(I.snap.slice(0, 10)))}`}</h4><ul>${li(noP, (r) => `<li><span class="pl-code">${esc(r.kode)}</span> ${esc(r.nama)}${I.harga.has(r.kode) ? ` <small class="muted">(harga baru berlaku ${esc(fDate(I.harga.get(r.kode)[0].from))})</small>` : ''}</li>`)}</ul></div>` : ''}
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
    const MVm = I.kel === 'FG' ? mvCalc(I.snap) : null;
    const by = sumBy(rows, (r) => r.kode), pm = prows ? sumBy(prows, (r) => r.kode) : null;
    const L = [...by].sort((a, b) => b[1].val - a[1].val);
    const shown = L.slice(0, 1500);
    return `<div class="table-wrap inv-tw"><table class="po-table inv-t">${head([['Material'], ['Golongan'], ['Kategori'], ['Lokasi'], ['Qty', 'num'], ['Δ qty', 'num'], ['Harga', 'num'], ['Value', 'num'], ['Δ value', 'num']])}<tbody>
      ${shown.map(([kode, m]) => { const r = m.rows[0], p = pm ? (pm.get(kode) || { val: 0, qty: 0 }) : null; return `<tr><td><button type="button" class="btn-link inv-mat" data-inv-chart="${esc(kode)}"><span class="pl-code">${esc(kode)}</span><span class="pl-name">${esc(r.nama || '(tidak ada di golongan)')}</span></button>${MVm ? ' ' + mvChip(mvOf(MVm, kode).cls) : ''}</td><td><span class="inv-g" style="--gc:${GOL_CLR[r.gol]}">${esc(r.gol === '?' ? '–' : r.gol)}</span></td><td>${esc(r.kat)}</td><td>${m.rows.length > 1 ? `<span title="${esc(m.rows.map((x) => `${x.lok || '(tanpa lokasi)'}: ${fQ(x.qty)}`).join('\n'))}">${m.rows.length} lokasi</span>` : esc(r.lok)}${m.rows.some((x) => x.src === 'manual') ? ' <span class="inv-tag" title="Ada koreksi manual">manual</span>' : ''}</td>
        <td class="num">${fQ(m.qty)} <small class="muted">${esc(r.uom)}</small></td><td class="num">${p ? `<span class="${dCls(m.qty - p.qty)}">${dTxt(m.qty - p.qty, fQ)}</span>` : '–'}</td>
        <td class="num">${r.noPrice ? '<span class="inv-tag">tanpa harga</span>' : `${fRp(r.price)}<div class="muted inv-sm">${esc(fDate(r.from))}</div>`}</td><td class="num"><b>${fRp(m.val)}</b></td><td class="num">${p ? `<span class="${dCls(m.val - p.val)}">${dTxt(m.val - p.val, fRp)}</span>` : '–'}</td></tr>`; }).join('') || '<tr class="empty"><td colspan="9">Tidak ada data pada saringan ini.</td></tr>'}
      </tbody></table></div>${L.length > shown.length ? `<p class="hint">Menampilkan 1.500 dari ${nf0.format(L.length)} kode (value terbesar). Pakai pencarian atau saringan untuk mempersempit.</p>` : ''}`;
  }
  function mvNote() {
    if (!I.mv || I.mv.loading) return `<p class="check inv-mvmsg">Memuat data DO dari CSL Personal Care untuk menghitung Fast / Slow / Not Move / Dead Stock…</p>`;
    if (I.mv.err) return `<p class="check err inv-mvmsg">Pergerakan FG belum bisa dihitung: ${esc(I.mv.err)}</p>`;
    const M = mvCalc(I.snap); if (!M) return '';
    const dFrom = I.mv.from ? fDate(I.mv.from + '-01') : '–';
    return `<p class="mrp-count inv-mvmsg">Pergerakan dihitung dari DO terkirim (Delivered) CSL Personal Care, periode <b>${M.P} bulan</b>: ${esc(fDate(M.from))} – ${esc(fDate(M.end))} (${M.nW} minggu). <b>Fast</b> = masuk ${I.mvPar}% qty DO terbesar dan ada DO di ≥ ${I.mvWk}% minggu · <b>Slow</b> = ada DO selain itu · <b>Not Move</b> = tanpa DO di periode, masih ada DO ${esc(fDate(M.pFrom))} – ${esc(fDate(isoOf(dayN(M.from) - 1)))} · <b>Dead Stock</b> = tanpa DO sejak ${esc(fDate(M.pFrom))}.</p>`
      + (M.short ? `<p class="check warn inv-mvmsg">Data DO di CSL baru tersedia mulai ${esc(dFrom)}. ${M.short === 'all' ? 'Periode ini lebih panjang dari data yang ada, jadi Fast/Slow dihitung dari data yang tersedia saja dan' : ''} Not Move dan Dead Stock belum bisa dibedakan dengan akurat (FG yang tidak keluar dianggap Dead Stock).</p>` : '');
  }
  function viewMov(rows) {
    const M = mvCalc(I.snap);
    if (!M) return '<p class="muted">Menunggu data DO CSL…</p>';
    const z = new Set(rows.map((r) => r.kode)).size;
    rows = rows.filter((r) => r.qty > 0);
    const zero = z - new Set(rows.map((r) => r.kode)).size;
    const tot = rows.reduce((t, r) => t + r.val, 0);
    const by = sumBy(rows, (r) => mvOf(M, r.kode).cls);
    const fm = (v) => (v ? nf1.format(v) : '–');
    let html = '';
    ['F', 'S', 'N', 'D', 'X'].forEach((c) => {
      const o = by.get(c); if (!o) return;
      const open = I.open.has('MV:' + c);
      html += `<tr class="inv-kr inv-mvg${open ? ' is-open' : ''}" data-inv-open="MV:${c}" style="--gc:${MV_CLR[c]}"><td class="inv-chev" aria-hidden="true">${open ? '▾' : '▸'}</td><td colspan="6"><b class="inv-mvt" style="color:${MV_CLR[c]}">${MV[c]}</b> <span class="muted">· ${o.n.size} kode</span></td><td class="num"><b>${fQ(o.qty)}</b></td><td class="num"><b>${fRp(o.val)}</b></td><td class="num">${fPct(tot ? o.val / tot : NaN)}</td><td></td></tr>`;
      if (!open) return;
      [...sumBy(o.rows, (r) => r.kode)].sort((a, b) => b[1].val - a[1].val).forEach(([kode, m]) => {
        const r0 = m.rows[0], x = mvOf(M, kode), cov = x.avg > 0 ? m.qty / x.avg : null;
        html += `<tr class="inv-mr"><td></td><td><button type="button" class="btn-link inv-mat" data-inv-chart="${esc(kode)}"><span class="pl-code">${esc(kode)}</span> ${esc(r0.nama)}</button></td><td>${esc(r0.kat)}</td><td class="num">${x.nw} / ${M.nW}</td><td class="num">${fQ(x.qty)}</td><td class="num">${fQ(x.avg)}</td><td>${x.last ? esc(fDate(x.last)) : '<span class="muted">belum pernah</span>'}</td><td class="num">${fQ(m.qty)} <small class="muted">${esc(r0.uom)}</small></td><td class="num">${fRp(m.val)}</td><td class="num">${fPct(tot ? m.val / tot : NaN)}</td><td class="num">${cov === null ? '–' : fm(cov)}</td></tr>`;
      });
    });
    return `<div class="table-wrap"><table class="po-table inv-t inv-mvtab">${head([['', 'inv-chev'], ['Pergerakan / FG'], ['Brand - jenis'], ['Minggu ada DO', 'num'], [`Qty DO ${M.P} bln`, 'num'], ['Rata-rata DO / bln', 'num'], ['DO terakhir'], ['Stok', 'num'], ['Value', 'num'], ['Porsi', 'num'], ['Stok cukup (bln)', 'num']])}<tbody>${html || '<tr class="empty"><td colspan="11">Tidak ada data pada saringan ini.</td></tr>'}</tbody>
      <tfoot><tr><th colspan="7">Total</th><th class="num">${fQ(rows.reduce((t, r) => t + r.qty, 0))}</th><th class="num">${fRp(tot)}</th><th class="num">100%</th><th></th></tr></tfoot></table></div>
      <p class="hint">Klik baris pergerakan untuk membuka daftar FG. Stok cukup (bln) = stok ÷ rata-rata DO per bulan. Kode FG dicocokkan langsung dengan kode di DO CSL. Grafik "Pergerakan" memakai golongan pergerakan pada tanggal masing-masing snapshot.${zero ? ` ${zero} kode FG dengan stok 0 tidak ditampilkan.` : ''} <b>Tanpa data DO</b> = kode tidak pernah muncul di DO CSL sejak data tersedia (bisa jadi produk di luar CSL Personal Care), jadi tidak dimasukkan ke Dead Stock.</p>`;
  }
  function viewLok(rows) {
    const by = sumBy(rows, (r) => r.lok), tot = rows.reduce((t, r) => t + r.val, 0);
    const gl = [...GOLS, '?'].filter((g) => rows.some((r) => r.gol === g));
    return `<div class="table-wrap"><table class="po-table inv-t">${head([['Lokasi'], ['Kode', 'num'], ...gl.map((g) => [`Value ${esc(GOL_LBL[g])}`, 'num']), ['Total value', 'num'], ['Porsi', 'num']])}<tbody>
      ${[...by].sort((a, b) => b[1].val - a[1].val).map(([lok, o]) => { const g = sumBy(o.rows, (r) => r.gol); return `<tr><td><button type="button" class="btn-link" data-inv-lok="${esc(lok)}">${esc(lok || '(tanpa lokasi)')}</button></td><td class="num">${o.n.size}</td>${gl.map((x) => `<td class="num">${g.has(x) ? fRp(g.get(x).val) : '–'}</td>`).join('')}<td class="num"><b>${fRp(o.val)}</b></td><td class="num">${fPct(tot ? o.val / tot : NaN)}</td></tr>`; }).join('') || '<tr class="empty"><td colspan="9">Tidak ada data.</td></tr>'}
      </tbody></table></div><p class="hint">Klik lokasi untuk menyaring semua tampilan ke lokasi itu.</p>`;
  }

  /* ---------- Grafik & ringkasan pergerakan ---------- */
  const BDIM = { MAT: [['gol', 'Golongan'], ['kat', 'Kategori']], FG: [['brand', 'Brand'], ['jenis', 'Jenis'], ['kat', 'Brand - jenis'], ['mv', 'Pergerakan']] };
  const bKey = (r, dim) => (dim === 'mv' ? (r.mv ? MV[r.mv] : 'Menunggu DO CSL') : dim === 'brand' ? r.brand || 'Tanpa brand' : dim === 'jenis' ? r.jenis : dim === 'gol' ? GOL_LBL[r.gol] || r.gol : r.kat);
  const dimOf = () => { const d = I.bdim[I.kel]; return BDIM[I.kel].some((x) => x[0] === d) ? d : BDIM[I.kel][0][0]; };
  const dimLbl = (d) => (BDIM[I.kel].find((x) => x[0] === d) || ['', ''])[1];
  const SNAP_PAL = ['#c9dccf', '#93bba0', '#5d9a73', '#2f7a4c', '#106a3a', '#0b4a29'];
  const niceUp = (m) => { const p = Math.pow(10, Math.floor(Math.log10(m))), f = m / p; return ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((x) => f <= x + 1e-9) || 10) * p; };
  const C_UP = '#1e7a46', C_DN = '#c0392b', C_TOT = '#24313d';
  // Snapshot terpilih (berlaku untuk semua grafik & ringkasan): default 3 terakhir
  function pickedSnaps() {
    const all = I.snaps.map((m) => m.snap);
    if (!I.bsnaps || !I.bsnaps.length || I.bsnaps.some((x) => !all.includes(x))) I.bsnaps = all.slice(-3);
    return all.filter((x) => I.bsnaps.includes(x));
  }
  const filtTxt = () => [I.kel === 'MAT' && I.g ? GOL_LBL[I.g] : '', I.brand, I.jenis, I.lok, I.q ? `cari "${I.q}"` : ''].filter(Boolean).join(' · ');
  const fmtM = (v) => (I.ms === 'v' ? fBig(v) : fQ(v));
  const pctTxt = (d, a) => (a ? ` (${d >= 0 ? '+' : '−'}${nf1.format(Math.abs(d / a) * 100)}%)` : '');

  /* Ringkasan pergerakan snapshot pertama → terakhir yang dipilih, mengikuti saringan */
  function movement(snaps) {
    if (snaps.length < 2) return null;
    const A = snaps[0], B = snaps[snaps.length - 1], dim = dimOf();
    const per = snaps.map((sn) => sumBy(calc(sn), (r) => r.kode));
    const mA = per[0], mB = per[per.length - 1];
    const codes = new Set([...mA.keys(), ...mB.keys()]);
    let vA = 0, vB = 0, qA = 0, qB = 0, effQ = 0, effP = 0;
    const mats = [], nw = [], gone = [], still = [];
    const cat = new Map();
    codes.forEach((k) => {
      const a = mA.get(k), b = mB.get(k), r0 = (b || a).rows[0];
      const qa = a ? a.qty : 0, qb = b ? b.qty : 0, va = a ? a.val : 0, vb = b ? b.val : 0;
      const pa = (priceAt(k, A) || {}).h || 0, pb = (priceAt(k, B) || {}).h || 0;
      vA += va; vB += vb; qA += qa; qB += qb;
      effQ += (qb - qa) * pa; effP += qb * (pb - pa);
      const m = { kode: k, nama: r0.nama, uom: r0.uom, qa, qb, va, vb, dv: vb - va, dq: qb - qa };
      mats.push(m);
      if (qa <= 0 && qb > 0) nw.push(m);
      if (qa > 0 && qb <= 0) gone.push(m);
      if (qb > 0 && per.every((p) => { const x = p.get(k); return x && Math.abs(x.qty - qb) < 1e-9; })) still.push(m);
      const ck = bKey(r0, dim), c = cat.get(ck) || { va: 0, vb: 0, qa: 0, qb: 0 };
      c.va += va; c.vb += vb; c.qa += qa; c.qb += qb; cat.set(ck, c);
    });
    const key = I.ms === 'v' ? 'v' : 'q';
    const cats = [...cat].map(([k, c]) => ({ k, a: key === 'v' ? c.va : c.qa, b: key === 'v' ? c.vb : c.qb })).map((c) => Object.assign(c, { d: c.b - c.a }));
    const byD = (L, f) => L.slice().sort((x, y) => f(y) - f(x));
    const dk = key === 'v' ? 'dv' : 'dq';
    return {
      A, B, dim, vA, vB, qA, qB, effQ, effP, cats,
      up: byD(mats.filter((m) => m[dk] > 1e-9), (m) => m[dk]).slice(0, 5),
      dn: byD(mats.filter((m) => m[dk] < -1e-9), (m) => -m[dk]).slice(0, 5),
      nw: byD(nw, (m) => m.vb), gone: byD(gone, (m) => m.va), still: byD(still, (m) => m.vb), stillV: still.reduce((t, m) => t + m.vb, 0),
    };
  }
  // Kalimat ringkasan (dipakai di layar & di JPG)
  function sumLines(M) {
    if (!M) return [];
    const L = [], dV = M.vB - M.vA, dQ = M.qB - M.qA, nm = I.kel === 'FG' ? 'FG' : 'Material';
    const per = `${fDate(M.A.slice(0, 10))} → ${fDate(M.B.slice(0, 10))}`;
    L.push({ tone: dV >= 0 ? 'up' : 'dn', t: `Value ${nm} ${dV >= 0 ? 'naik' : 'turun'} ${fRp(Math.abs(dV))}${pctTxt(dV, M.vA)} dari ${fRp(M.vA)} menjadi ${fRp(M.vB)} (${per}); qty ${dQ >= 0 ? 'naik' : 'turun'} ${fQ(Math.abs(dQ))}${pctTxt(dQ, M.qA)}.` });
    if (I.pm === 'date' && Math.abs(M.effP) >= 1) L.push({ tone: '', t: `Penyebab: perubahan qty ${dTxt(M.effQ, fRp)}, perubahan harga ${dTxt(M.effP, fRp)}.` });
    else L.push({ tone: '', t: `Seluruh perubahan value berasal dari perubahan qty${I.pm === 'latest' ? ' (dinilai dengan harga terkini)' : ' (harga tidak berubah)'}.` });
    const cs = M.cats.filter((c) => Math.abs(c.d) > 1e-9), cu = cs.slice().sort((a, b) => b.d - a.d)[0], cd = cs.slice().sort((a, b) => a.d - b.d)[0];
    const lbl = dimLbl(M.dim).toLowerCase();
    if (cd && cd.d < 0) L.push({ tone: 'dn', t: `Penurunan terbesar per ${lbl}: ${cd.k} ${dTxt(cd.d, fmtM)}${pctTxt(cd.d, cd.a)}.` });
    if (cu && cu.d > 0) L.push({ tone: 'up', t: `Kenaikan terbesar per ${lbl}: ${cu.k} ${dTxt(cu.d, fmtM)}${pctTxt(cu.d, cu.a)}.` });
    const mt = (m) => `${m.kode} ${m.nama.length > 38 ? m.nama.slice(0, 37) + '…' : m.nama} (${dTxt(I.ms === 'v' ? m.dv : m.dq, fmtM)})`;
    if (M.dn.length) L.push({ tone: 'dn', t: `Material paling turun: ${M.dn.slice(0, 3).map(mt).join('; ')}.` });
    if (M.up.length) L.push({ tone: 'up', t: `Material paling naik: ${M.up.slice(0, 3).map(mt).join('; ')}.` });
    const ex = [];
    if (M.gone.length) ex.push(`${M.gone.length} kode habis (value awal ${fBig(M.gone.reduce((t, m) => t + m.va, 0))})`);
    if (M.nw.length) ex.push(`${M.nw.length} kode baru masuk (${fBig(M.nw.reduce((t, m) => t + m.vb, 0))})`);
    if (M.still.length) ex.push(`${M.still.length} kode tidak bergerak di semua snapshot terpilih, value tertahan ${fBig(M.stillV)} (${fPct(M.vB ? M.stillV / M.vB : NaN)} dari total)`);
    if (ex.length) L.push({ tone: '', t: ex.join(' · ') + '.' });
    return L;
  }
  function sumHtml(M) {
    if (!M) return '<p class="muted inv-sumn">Pilih minimal 2 snapshot untuk melihat ringkasan pergerakan.</p>';
    const li = (L, f) => L.length ? `<ul>${L.map(f).join('')}</ul>` : '<p class="muted">–</p>';
    const mrow = (m, k) => `<tr><td><button type="button" class="btn-link inv-mat" data-inv-chart="${esc(m.kode)}"><span class="pl-code">${esc(m.kode)}</span><span class="pl-name">${esc(m.nama)}</span></button></td><td class="num ${dCls(k === 'v' ? m.dv : m.dq)}">${dTxt(k === 'v' ? m.dv : m.dq, k === 'v' ? fRp : fQ)}</td><td class="num muted">${fQ(m.qa)} → ${fQ(m.qb)} <small>${esc(m.uom)}</small></td></tr>`;
    const tbl = (L) => (L.length ? `<table class="po-table pl-mini inv-mv"><tbody>${L.map((m) => mrow(m, k)).join('')}</tbody></table>` : '<p class="muted">–</p>');
    const k = I.ms === 'v' ? 'v' : 'q';
    return `<div class="inv-sum"><h4>Ringkasan pergerakan</h4><ul class="inv-suml">${sumLines(M).map((l) => `<li class="${l.tone ? 'is-' + l.tone : ''}">${esc(l.t)}</li>`).join('')}</ul>
      <div class="inv-sumg">
        <div><h5>Paling turun</h5>${tbl(M.dn)}</div>
        <div><h5>Paling naik</h5>${tbl(M.up)}</div>
        <details><summary><b>Kode habis</b> ${M.gone.length} · <b>baru</b> ${M.nw.length} · <b>tidak bergerak</b> ${M.still.length}</summary>
          <h5>Habis</h5>${li(M.gone.slice(0, 30), (m) => `<li><span class="pl-code">${esc(m.kode)}</span> ${esc(m.nama)} <small class="muted">${fRp(m.va)}</small></li>`)}
          <h5>Baru</h5>${li(M.nw.slice(0, 30), (m) => `<li><span class="pl-code">${esc(m.kode)}</span> ${esc(m.nama)} <small class="muted">${fRp(m.vb)}</small></li>`)}
          <h5>Tidak bergerak (value terbesar)</h5>${li(M.still.slice(0, 30), (m) => `<li><span class="pl-code">${esc(m.kode)}</span> ${esc(m.nama)} <small class="muted">${fQ(m.qb)} ${esc(m.uom)} · ${fRp(m.vb)}</small></li>`)}
        </details>
      </div></div>`;
  }

  /* Garis pergerakan */
  function buildLine(W, snaps) {
    const key = I.ms === 'v' ? 'v' : 'q';
    const data = snaps.map((sn) => {
      const rows = calc(sn).filter((r) => !I.chart || r.kode === I.chart);
      const o = { snap: sn, tot: { v: 0, q: 0 } };
      rows.forEach((r) => { const k = grpOf(r); o[k] = o[k] || { v: 0, q: 0 }; o[k].v += r.val; o[k].q += r.qty; o.tot.v += r.val; o.tot.q += r.qty; });
      return o;
    });
    let gl = I.chart ? ['tot'] : [...GOLS, '?'].filter((g) => data.some((d) => d[g]) && (!I.g || g === I.g));
    if (!I.chart && I.kel === 'FG') {
      const cur = data[data.length - 1];
      const keys = [...new Set(data.flatMap((d) => Object.keys(d).filter((k) => k !== 'snap' && k !== 'tot')))].sort((a, b) => (cur[b] ? cur[b].v : 0) - (cur[a] ? cur[a].v : 0));
      gl = keys;
      if (keys.length > 7) { const rest = keys.slice(6); data.forEach((d) => { const o = { v: 0, q: 0 }; rest.forEach((k) => { if (d[k]) { o.v += d[k].v; o.q += d[k].q; } }); d.Lainnya = o; }); gl = keys.slice(0, 6).concat('Lainnya'); }
    }
    const showTot = !I.chart && (I.kel === 'FG' || !I.g) && gl.length > 1;
    const ser = (showTot ? ['tot'] : []).concat(I.chart ? ['tot'] : gl);
    const clr = (s) => (s === 'tot' ? (I.chart ? GOL_CLR[golOf(I.chart)] : C_TOT) : grpClr(s));
    const name = (s) => (s === 'tot' ? (I.chart ? I.chart : 'Total') : grpLbl(s));
    const val = (d, g) => (d[g] ? d[g][key] : 0);
    W = Math.max(W, data.length * 60);
    const H = 280, L = 78, R = 150, T = 14, B = 34;
    const max = Math.max(1, ...data.flatMap((d) => ser.map((g) => val(d, g))));
    const nice = niceUp(max);
    const x = (i) => (data.length === 1 ? L + (W - L - R) / 2 : L + i * (W - L - R) / (data.length - 1));
    const y = (v) => T + (H - T - B) * (1 - v / nice);
    const fmtAx = (v) => (I.ms === 'v' ? fBig(v).replace('Rp ', '') : v >= 1e6 ? nf1.format(v / 1e6) + ' jt' : nf0.format(v));
    let g = '';
    for (let k = 0; k <= 4; k++) { const v = nice * k / 4; g += `<line class="cslc-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="cslc-ax" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${fmtAx(v)}</text>`; }
    const step = Math.ceil(data.length / 12);
    data.forEach((d, i) => { if (i % step === 0 || i === data.length - 1) g += `<text class="cslc-ax" x="${x(i)}" y="${H - 12}" text-anchor="middle">${esc(fDate(d.snap.slice(0, 10)).slice(0, 6))}</text>`; });
    // label akhir garis (nilai terakhir) — dihindarkan saling tumpuk
    const ends = ser.map((s) => ({ s, y: y(val(data[data.length - 1], s)) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
    ser.forEach((s) => {
      const c = clr(s), pts = data.map((d, i) => `${x(i)},${y(val(d, s))}`).join(' ');
      g += `<polyline fill="none" stroke="${c}" stroke-width="2"${s === 'tot' && !I.chart ? ' stroke-dasharray="5 4"' : ''} points="${pts}"/>`;
      data.forEach((d, i) => { g += `<circle cx="${x(i)}" cy="${y(val(d, s))}" r="${d.snap === I.snap ? 5 : 3.5}" fill="${c}" stroke="#fff" stroke-width="2"/>`; });
      const e = ends.find((z) => z.s === s), lv = val(data[data.length - 1], s);
      g += `<text class="inv-bv" x="${x(data.length - 1) + 10}" y="${e.y + 4}" style="fill:${c}">${esc(name(s).length > 12 ? name(s).slice(0, 11) + '…' : name(s))} ${fmtM(lv)}</text>`;
    });
    data.forEach((d, i) => { g += `<rect class="inv-hit" data-i="${i}" x="${x(i) - 18}" y="${T}" width="36" height="${H - T - B}" fill="transparent"/>`; });
    return { W, H, body: g, legend: ser.map((s) => ({ c: clr(s), t: name(s), dash: s === 'tot' && !I.chart })), data, ser, val, name };
  }
  /* Batang per kategori, snapshot berdampingan */
  function buildBar(W, snaps) {
    const dim = dimOf(), key = I.ms === 'v' ? 'val' : 'qty';
    const per = snaps.map((sn) => sumBy(calc(sn), (r) => bKey(r, dim)));
    const last = per[per.length - 1] || new Map();
    const cats = [...new Set(per.flatMap((m) => [...m.keys()]))].sort((a, b) => ((last.get(b) || {})[key] || 0) - ((last.get(a) || {})[key] || 0));
    if (!I.bcats) I.bcats = cats.slice(0, 8);
    const show = cats.filter((c) => I.bcats.includes(c));
    const max = Math.max(1, ...show.flatMap((c) => per.map((m) => (m.get(c) || {})[key] || 0)));
    const pal = snaps.length === 1 ? [SNAP_PAL[4]] : snaps.map((_, i) => SNAP_PAL[Math.round(1 + i * (SNAP_PAL.length - 2) / Math.max(1, snaps.length - 1))]);
    W = Math.max(W, 560);
    const LBL = Math.min(260, Math.max(120, Math.round(W * 0.22))), RT = 250, bh = 14, gap = 3, grp = 16;
    const rowH = snaps.length * (bh + gap) - gap + grp, H = 24 + Math.max(1, show.length) * rowH;
    const x = (v) => LBL + (W - LBL - RT) * (v / max);
    let g = '';
    for (let k = 0; k <= 4; k++) { const xv = LBL + (W - LBL - RT) * k / 4; g += `<line class="cslc-grid" x1="${xv}" x2="${xv}" y1="14" y2="${H - 4}"/><text class="cslc-ax" x="${xv}" y="10" text-anchor="middle">${fmtM(max * k / 4).replace('Rp ', '')}</text>`; }
    show.forEach((c, ci) => {
      const y0 = 20 + ci * rowH, mid = y0 + (snaps.length * (bh + gap)) / 2 + 2;
      g += `<text class="inv-bl" x="${LBL - 10}" y="${mid}" text-anchor="end">${esc(c.length > 34 ? c.slice(0, 33) + '…' : c)}</text>`;
      per.forEach((m, si) => {
        const v = (m.get(c) || {})[key] || 0, yy = y0 + si * (bh + gap), w = Math.max(v > 0 ? 2 : 0, x(v) - LBL);
        g += `<rect class="inv-bar" data-c="${ci}" data-s="${si}" x="${LBL}" y="${yy}" width="${w}" height="${bh}" rx="3" fill="${pal[si]}"/>`;
        if (si === per.length - 1 || per.length <= 2) g += `<text class="inv-bv" x="${LBL + w + 6}" y="${yy + bh - 3}">${fmtM(v)}</text>`;
      });
      if (per.length > 1) {
        const a = (per[0].get(c) || {})[key] || 0, b = (last.get(c) || {})[key] || 0, d = b - a;
        g += `<text class="inv-bd ${dCls(d)}" x="${W - 4}" y="${mid}" text-anchor="end">${dTxt(d, fmtM)}${pctTxt(d, a)}</text>`;
      }
    });
    return { W, H, body: g, legend: snaps.map((sn, i) => ({ c: pal[i], t: fSnap(sn), box: true })), cats, show, per, snaps, empty: !show.length };
  }
  /* Waterfall: total awal → naik/turun per kategori → total akhir */
  function buildWater(W, snaps, M) {
    if (!M) return { W, H: 60, body: `<text class="cslc-ax" x="${W / 2}" y="30" text-anchor="middle">Pilih minimal 2 snapshot.</text>`, legend: [], empty: true };
    const vA = I.ms === 'v' ? M.vA : M.qA, vB = I.ms === 'v' ? M.vB : M.qB;
    let cs = M.cats.filter((c) => Math.abs(c.d) > 1e-9).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
    if (cs.length > 10) { const rest = cs.slice(9); cs = cs.slice(0, 9).concat({ k: `Lainnya (${rest.length})`, d: rest.reduce((t, c) => t + c.d, 0), a: 0 }); }
    cs.sort((a, b) => b.d - a.d);
    const steps = [{ k: fDate(M.A.slice(0, 10)), tot: true, v0: 0, v1: vA }];
    let run = vA;
    cs.forEach((c) => { steps.push({ k: c.k, v0: run, v1: run + c.d, d: c.d, a: c.a }); run += c.d; });
    steps.push({ k: fDate(M.B.slice(0, 10)), tot: true, v0: 0, v1: vB });
    W = Math.max(W, 560);
    const L = 78, R = 16, T = 26, B = 58, H = 340;
    const hi = Math.max(1, ...steps.map((s) => Math.max(s.v0, s.v1))), lo = Math.min(0, ...steps.map((s) => Math.min(s.v0, s.v1)));
    const nice = niceUp(hi);
    const y = (v) => T + (H - T - B) * (1 - (v - lo) / (nice - lo));
    const cw = (W - L - R) / steps.length, bw = Math.min(70, cw * 0.62);
    let g = '';
    for (let k = 0; k <= 4; k++) { const v = lo + (nice - lo) * k / 4; g += `<line class="cslc-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="cslc-ax" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${fmtM(v).replace('Rp ', '')}</text>`; }
    const wrap = (t, n) => { const w = String(t).split(' '), out = ['']; w.forEach((x) => { if ((out[out.length - 1] + ' ' + x).trim().length > n && out[out.length - 1]) out.push(x); else out[out.length - 1] = (out[out.length - 1] + ' ' + x).trim(); }); return out.slice(0, 3); };
    const nch = Math.max(6, Math.floor(cw / 6.6));
    steps.forEach((s, i) => {
      const cx = L + cw * i + cw / 2, top = y(Math.max(s.v0, s.v1)), bot = y(Math.min(s.v0, s.v1));
      const c = s.tot ? C_TOT : s.d >= 0 ? C_UP : C_DN;
      g += `<rect class="inv-wf" data-w="${i}" x="${cx - bw / 2}" y="${top}" width="${bw}" height="${Math.max(1.5, bot - top)}" rx="3" fill="${c}"${s.tot ? '' : ' fill-opacity=".85"'}/>`;
      if (i < steps.length - 1) { const yn = y(s.v1); g += `<line x1="${cx + bw / 2}" x2="${cx + cw - bw / 2}" y1="${yn}" y2="${yn}" stroke="#9aa5b1" stroke-dasharray="3 3"/>`; }
      g += `<text class="inv-bd" x="${cx}" y="${top - 6}" text-anchor="middle" style="fill:${s.tot ? C_TOT : c}">${s.tot ? fmtM(s.v1) : dTxt(s.d, fmtM)}</text>`;
      wrap(s.k, nch).forEach((ln, li) => { g += `<text class="inv-bl" x="${cx}" y="${H - B + 16 + li * 13}" text-anchor="middle"${s.tot ? ' style="font-weight:700"' : ''}>${esc(ln)}</text>`; });
    });
    return { W, H, body: g, steps, legend: [{ c: C_TOT, t: 'Total snapshot', box: true }, { c: C_UP, t: 'Naik', box: true }, { c: C_DN, t: 'Turun', box: true }] };
  }

  function renderChart() {
    const box = $('invChart'); if (!box) return;
    document.querySelectorAll('#invMs [data-v]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === I.ms)));
    document.querySelectorAll('#invCt [data-v]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === I.ct)));
    const mat = I.chart ? I.gol.get(I.chart) : null, f = filtTxt(), nm = I.kel === 'FG' ? 'FG' : 'Material';
    const title = I.chart ? `Pergerakan ${I.chart} ${mat ? mat.nama : ''}` : I.ct === 'bar' ? `${I.ms === 'v' ? 'Value' : 'Qty'} ${nm} per ${dimLbl(dimOf()).toLowerCase()}` : I.ct === 'wf' ? `Penyebab perubahan ${I.ms === 'v' ? 'value' : 'qty'} ${nm} per ${dimLbl(dimOf()).toLowerCase()}` : `Pergerakan ${I.ms === 'v' ? 'value' : 'qty'} ${I.kel === 'FG' ? 'FG per brand' : 'Material per golongan'}`;
    I._title = title + (f ? ' · ' + f : '');
    $('invChartTitle').innerHTML = esc(I._title) + (I.chart ? ' <button type="button" class="btn-link" data-inv-chart="">kembali</button>' : '');
    if (!I.snaps.length) { box.innerHTML = '<p class="muted">Belum ada snapshot.</p>'; return; }
    const snaps = pickedSnaps(), all = I.snaps.map((m) => m.snap), dim = dimOf();
    const M = movement(snaps);
    const W = Math.round(box.clientWidth || 900);
    const C = I.chart || I.ct === 'line' ? buildLine(W, snaps) : I.ct === 'bar' ? buildBar(W, snaps) : buildWater(W, snaps, M);
    I._chart = C; I._sum = sumLines(M); I._snaps = snaps;
    const dimSeg = I.ct !== 'line' && !I.chart ? `<div class="pj-seg" id="invBdim" role="group" aria-label="Kelompokkan per">${BDIM[I.kel].map(([v, t]) => `<button type="button" data-v="${v}" aria-pressed="${v === dim}">${t}</button>`).join('')}</div>` : '';
    const snapPick = `<details class="inv-pick" id="invSnapPick"${I.snapOpen ? ' open' : ''}><summary>Snapshot (${snaps.length}/${all.length})</summary><div class="inv-pa"><button type="button" class="btn-link" data-bsnap-all="1">Semua</button><button type="button" class="btn-link" data-bsnap-all="3">3 terakhir</button><button type="button" class="btn-link" data-bsnap-all="2">2 terakhir</button></div><div class="inv-pl">${all.slice().reverse().map((sn) => `<label><input type="checkbox" data-bsnap="${esc(sn)}"${snaps.includes(sn) ? ' checked' : ''}> ${esc(fSnap(sn))}</label>`).join('')}</div></details>`;
    let catPick = '';
    if (I.ct === 'bar' && !I.chart) {
      const key = I.ms === 'v' ? 'val' : 'qty', last = C.per[C.per.length - 1] || new Map();
      catPick = `<details class="inv-pick" id="invCatPick"${I.catOpen ? ' open' : ''}><summary>${esc(dimLbl(dim))} ditampilkan (${C.show.length}/${C.cats.length})</summary><div class="inv-pa"><button type="button" class="btn-link" data-bcat-all="1">Pilih semua</button><button type="button" class="btn-link" data-bcat-all="0">Kosongkan</button><button type="button" class="btn-link" data-bcat-all="8">8 terbesar</button></div><div class="inv-pl inv-pl2">${C.cats.map((c) => `<label><input type="checkbox" data-bcat="${esc(c)}"${C.show.includes(c) ? ' checked' : ''}> ${esc(c)} <small class="muted">${fmtM((last.get(c) || {})[key] || 0)}</small></label>`).join('')}</div></details>`;
      I._barCats = C.cats;
    }
    const lg = C.legend.map((l) => `<span class="inv-lg"><i style="background:${l.c}${l.box ? ';height:10px;width:14px' : ''}${l.dash ? ';background:repeating-linear-gradient(90deg,' + l.c + ' 0 4px,transparent 4px 7px)' : ''}"></i>${esc(l.t)}</span>`).join('');
    const note = I.ct === 'bar' && snaps.length > 1 ? `<span class="muted">Angka kanan = selisih ${esc(fDate(snaps[0].slice(0, 10)))} → ${esc(fDate(snaps[snaps.length - 1].slice(0, 10)))}</span>` : I.ct === 'wf' && M ? `<span class="muted">${esc(fDate(M.A.slice(0, 10)))} → ${esc(fDate(M.B.slice(0, 10)))}; maks. 10 ${esc(dimLbl(dim).toLowerCase())} dengan perubahan terbesar</span>` : '<span class="muted">Arahkan kursor ke grafik untuk rincian.</span>';
    box.innerHTML = `<div class="inv-bctl">${dimSeg}${snapPick}${catPick}</div><div class="inv-legend">${lg}${note}</div>
      ${C.empty && I.ct === 'bar' ? '<p class="muted">Pilih minimal satu kategori.</p>' : `<div class="inv-cbox"><svg viewBox="0 0 ${C.W} ${C.H}" width="${C.W}" height="${C.H}" role="img" aria-label="${esc(I._title)}">${C.body}</svg><div class="cslc-tip" id="invTip" hidden></div></div>`}
      ${sumHtml(M)}`;
    const svg = box.querySelector('svg'), tip = $('invTip');
    if (svg) {
      const place = (e, w) => { const r = box.querySelector('.inv-cbox').getBoundingClientRect(); tip.style.left = Math.min(e.clientX - r.left + 12, r.width - w) + 'px'; tip.style.top = (e.clientY - r.top + 12) + 'px'; tip.hidden = false; };
      svg.addEventListener('mousemove', (e) => {
        const h = e.target.closest('.inv-hit'), b = e.target.closest('.inv-bar'), w = e.target.closest('.inv-wf');
        if (h && C.data) { const d = C.data[+h.dataset.i]; tip.innerHTML = `<b>${esc(fSnap(d.snap))}</b>` + C.ser.map((s) => `<div>${esc(C.name(s))}: ${I.ms === 'v' ? fRp(C.val(d, s)) : fQ(C.val(d, s))}</div>`).join(''); place(e, 200); return; }
        if (b && C.per) { const c = C.show[+b.dataset.c], si = +b.dataset.s, o = C.per[si].get(c) || { val: 0, qty: 0 }; tip.innerHTML = `<b>${esc(c)}</b><div>${esc(fSnap(C.snaps[si]))}</div><div>Value ${fRp(o.val)}</div><div>Qty ${fQ(o.qty)} · ${o.n ? o.n.size : 0} kode</div>`; place(e, 220); return; }
        if (w && C.steps) { const s = C.steps[+w.dataset.w]; tip.innerHTML = s.tot ? `<b>Total ${esc(s.k)}</b><div>${fmtM(s.v1)}</div>` : `<b>${esc(s.k)}</b><div>${dTxt(s.d, fmtM)}${pctTxt(s.d, s.a)}</div><div class="muted">${fmtM(s.v0)} → ${fmtM(s.v1)} (kumulatif)</div>`; place(e, 220); return; }
        tip.hidden = true;
      });
      svg.addEventListener('mouseleave', () => { tip.hidden = true; });
      svg.addEventListener('click', (e) => { const h = e.target.closest('.inv-hit'); if (h && C.data) { setSnap(C.data[+h.dataset.i].snap); render(); } });
    }
    const bd = box.querySelector('#invBdim'); if (bd) bd.addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b) return; I.bdim[I.kel] = b.dataset.v; I.bcats = null; renderChart(); });
    const cp = box.querySelector('#invCatPick'); if (cp) cp.addEventListener('toggle', (e) => { I.catOpen = e.target.open; });
    const sp = box.querySelector('#invSnapPick'); if (sp) sp.addEventListener('toggle', (e) => { I.snapOpen = e.target.open; });
  }

  /* Unduh JPG: judul + subjudul + legenda + grafik + ringkasan, siap tempel ke PowerPoint */
  function exportJpg() {
    const C = I._chart; if (!C || C.empty) { toast('Belum ada grafik untuk diunduh.'); return; }
    const W = 1600, PAD = 48, cw = W - PAD * 2;
    const snaps = I._snaps || [];
    const C2 = I.chart || I.ct === 'line' ? buildLine(cw, snaps) : I.ct === 'bar' ? buildBar(cw, snaps) : buildWater(cw, snaps, movement(snaps));
    const sc = cw / C2.W;
    const sub = [`Stok ${KEL_LBL[I.kel]}`, snaps.length ? `${fSnap(snaps[0])}${snaps.length > 1 ? ' → ' + fSnap(snaps[snaps.length - 1]) : ''}` : '', `harga ${PM_LBL[I.pm]}`, I.ms === 'v' ? 'Value (Rp)' : 'Qty'].filter(Boolean).join(' · ');
    const wrap = (t, n) => { const w = t.split(' '), out = ['']; w.forEach((x) => { if ((out[out.length - 1] + ' ' + x).length > n && out[out.length - 1]) out.push(x); else out[out.length - 1] = (out[out.length - 1] + ' ' + x).trim(); }); return out; };
    let y = 64, s = '';
    s += `<text x="${PAD}" y="${y}" style="font-size:30px;font-weight:700;fill:#1f2933">${esc(I._title)}</text>`; y += 34;
    s += `<text x="${PAD}" y="${y}" style="font-size:17px;fill:#6b7684">${esc(sub)}</text>`; y += 34;
    let lx = PAD;
    C2.legend.forEach((l) => { s += `<rect x="${lx}" y="${y - 12}" width="18" height="${l.box ? 12 : 4}" rx="2" fill="${l.c}"/><text x="${lx + 26}" y="${y}" style="font-size:16px;fill:#1f2933">${esc(l.t)}</text>`; lx += 26 + l.t.length * 9 + 26; });
    y += 18;
    s += `<g transform="translate(${PAD},${y}) scale(${sc})">${C2.body.replace(/<rect class="inv-hit"[^>]*\/>/g, '')}</g>`; y += C2.H * sc + 36;
    const lines = I._sum || [];
    if (lines.length) {
      s += `<line x1="${PAD}" x2="${W - PAD}" y1="${y - 16}" y2="${y - 16}" stroke="#e1e6eb"/><text x="${PAD}" y="${y + 6}" style="font-size:20px;font-weight:700;fill:#1f2933">Ringkasan</text>`; y += 36;
      lines.forEach((l) => {
        const col = l.tone === 'up' ? C_UP : l.tone === 'dn' ? C_DN : '#1f2933';
        wrap(l.t, 150).forEach((ln, i) => { s += `${i === 0 ? `<circle cx="${PAD + 6}" cy="${y - 6}" r="4" fill="${col}"/>` : ''}<text x="${PAD + 20}" y="${y}" style="font-size:17px;fill:${col}">${esc(ln)}</text>`; y += 25; });
        y += 4;
      });
    }
    y += 10;
    s += `<text x="${PAD}" y="${y}" style="font-size:13px;fill:#9aa5b1">Sumber: Value and Qty Inventory · PPIC Gondowangi · dibuat ${esc(fSnap(nowParts().d + ' ' + nowParts().t))}</text>`; y += 24;
    const css = `text{font-family:Inter,'Segoe UI',Arial,sans-serif}.cslc-grid{stroke:#e7ebf0;stroke-width:1}.cslc-ax{fill:#6b7684;font-size:11px}.inv-bl{fill:#1f2933;font-size:12px}.inv-bv{fill:#6b7684;font-size:11px}.inv-bd{font-size:12px;font-weight:600}.inv-bd.inv-up{fill:${C_UP}}.inv-bd.inv-dn{fill:${C_DN}}.inv-bd.muted{fill:#6b7684}`;
    const H = Math.ceil(y);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><style>${css}</style><rect width="${W}" height="${H}" fill="#fff"/>${s}</svg>`;
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas'), k = 2; cv.width = W * k; cv.height = H * k;
      const cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height); cx.scale(k, k); cx.drawImage(img, 0, 0);
      cv.toBlob((b) => {
        const a = document.createElement('a'); a.href = URL.createObjectURL(b);
        const tag = (snaps.length ? snaps[0].slice(5, 10) + (snaps.length > 1 ? '_' + snaps[snaps.length - 1].slice(5, 10) : '') : '').replace(/-/g, '');
        a.download = `Inventory_${I.kel === 'FG' ? 'FG' : 'Material'}_${I.ct === 'bar' ? 'batang' : I.ct === 'wf' ? 'waterfall' : 'garis'}_${tag}.jpg`;
        document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      }, 'image/jpeg', 0.95);
    };
    img.onerror = () => toast('Gagal membuat gambar.');
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
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
      const fg = kind === 'stokfg', nm = fg ? 'FG' : 'Material (RM, PM, WIP)';
      const L = [...I.gol.values()].filter((g) => (fg ? g.gol === 'FG' : g.gol !== 'FG')).sort((a, b) => a.kode.localeCompare(b.kode, 'id', { numeric: true }));
      sheet(fg ? 'STOK FG' : 'STOK MATERIAL', [['KODE', 'LOKASI', 'QTY'], L.length ? [L[0].kode, fg ? 'FG/Stock' : 'WH/Stock', 100] : ['10002', 'WH/Stock', 125.5]], [14, 24, 12]);
      sheet('PETUNJUK', [['PETUNJUK'], ['Untuk', `Stok ${nm} saja. ${fg ? 'Kode RM/PM/WIP' : 'Kode FG'} di file ini ditolak.`], ['KODE, LOKASI, QTY', 'Wajib KODE dan QTY. LOKASI boleh kosong. Kode + lokasi yang sama dijumlahkan. Baris dengan QTY kosong dilewati.'], ['Export Odoo', 'Boleh juga langsung export stok Odoo yang punya kolom Product/Internal Reference, Location, dan Quantity/On Hand Quantity.'], ['Tanggal & jam', `Dipilih saat upload. Upload ${fg ? 'FG' : 'Material'} dengan tanggal & jam yang sama menimpa snapshot ${fg ? 'FG' : 'Material'} itu (snapshot ${fg ? 'Material' : 'FG'} tidak tersentuh).`]], [18, 100]);
      sheet(fg ? 'DAFTAR FG' : 'DAFTAR MATERIAL', [['KODE', 'NAMA', 'GOLONGAN', 'KATEGORI', 'UOM'], ...L.map((g) => [g.kode, g.nama, g.gol, g.kat, g.uom])], [14, 60, 10, 26, 8]);
      XLSX.writeFile(wb, fg ? 'Format_Stok_FG.xlsx' : 'Format_Stok_Material.xlsx');
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
  function upStok(wb, file, kel) {
    const fg = kel === 'FG', nm = fg ? 'FG' : 'Material (RM, PM, WIP)';
    const A = I.all[kel];
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
      const g0 = I.gol.get(kode);
      if (g0 && (fg ? g0.gol !== 'FG' : g0.gol === 'FG')) { bad.push(`Baris ${t.hi + k + 2} · ${kode}: golongan ${g0.gol}, bukan stok ${nm}${fg ? '' : ' (upload lewat Upload stok FG)'}`); return; }
      if (S(r[iQ]) === '') return;
      const q = num(r[iQ]);
      if (!isNum(q)) { bad.push(`Baris ${t.hi + k + 2} · ${kode}: qty "${S(r[iQ])}" tidak terbaca`); return; }
      const lok = iL >= 0 ? S(r[iL]) : '', key = kode + '\u0001' + lok;
      agg.set(key, [kode, lok, (agg.has(key) ? agg.get(key)[2] : 0) + q]);
    });
    const rows = [...agg.values()];
    const kodes = new Set(rows.map((r) => r[0])), loks = new Set(rows.map((r) => r[1]));
    const noG = [...kodes].filter((k) => !I.gol.has(k));
    const np = nowParts();
    const chk = (d, tm) => { const s = `${d} ${tm}`; const p = [...kodes].filter((k) => !priceAtMode(k, s, 'date')).length, pl = [...kodes].filter((k) => !priceAtMode(k, s, 'latest')).length; const ex = A.stok.has(s); return `<ul class="kfr-ul"><li><b>${rows.length}</b> baris (kode × lokasi) · ${kodes.size} kode · ${loks.size} lokasi</li>${noG.length ? `<li class="pl-bad">${noG.length} kode tidak ada di golongan: ${esc(noG.slice(0, 15).join(', '))}${noG.length > 15 ? '…' : ''}</li>` : ''}<li class="inv-pmc"><b>Dasar harga untuk value</b> (bisa diganti kapan saja di tampilan):<label><input type="radio" name="pm" value="date"${I.pm === 'date' ? ' checked' : ''}> Sesuai tanggal snapshot <span class="${p ? 'pl-bad' : 'muted'}">· ${p ? `${p} kode tanpa harga per ${esc(fDate(d))} (value 0)` : 'semua kode berharga'}</span></label><label><input type="radio" name="pm" value="latest"${I.pm === 'latest' ? ' checked' : ''}> Harga terkini <span class="${pl ? 'pl-bad' : 'muted'}">· ${pl ? `${pl} kode belum punya harga sama sekali (value 0)` : 'semua kode berharga'}</span></label></li>${ex ? `<li class="pl-bad"><b>Snapshot ${esc(fg ? 'FG' : 'Material')} ${esc(fSnap(s))} sudah ada dan akan ditimpa.</b></li>` : ''}</ul>`; };
    review(`Upload stok ${nm}`, `<p class="dlg-lead">File <b>${esc(file)}</b> (sheet ${esc(t.sn)}) sebagai stok <b>${esc(nm)}</b>. Kode + lokasi yang sama dijumlahkan. Snapshot ${fg ? 'Material' : 'FG'} tidak tersentuh.</p>
      <div class="inv-dt"><label class="fld inv-fld"><span>Tanggal snapshot</span><input type="date" name="d" id="invSD" value="${np.d}" required></label><label class="fld inv-fld"><span>Jam</span><input type="time" name="t" id="invST" value="${np.t}" required></label><label class="fld inv-fld inv-note"><span>Catatan (opsional)</span><input type="text" name="note" maxlength="200" placeholder="mis. stock opname akhir bulan"></label></div>
      <div id="invStChk">${chk(np.d, np.t)}</div>
      ${bad.length ? `<details class="kfr-sec is-bad" open><summary><b>Ditolak</b> <span>${bad.length}</span></summary><ul class="kfr-ul">${bad.slice(0, 200).map((b) => `<li>${esc(b)}</li>`).join('')}</ul></details>` : ''}`,
    rows.length, (fd) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(fd.d || '') || !/^\d{2}:\d{2}$/.test(fd.t || '')) throw new Error('Isi tanggal dan jam snapshot.'); if (fd.pm === 'date' || fd.pm === 'latest') I.pm = fd.pm; I.kel = kel; savePref(); I.selSnap[kel] = `${fd.d} ${fd.t}`; return api('saveStok', { kel, snapshot: `${fd.d} ${fd.t}`, rows, file, note: fd.note || '' }); },
    () => { const f = () => { const c = document.querySelector('#invStChk input[name=pm]:checked'); const keep = I.pm; if (c) I.pm = c.value; if ($('invSD').value && $('invST').value) $('invStChk').innerHTML = chk($('invSD').value, $('invST').value); I.pm = keep; }; $('invSD').addEventListener('change', f); $('invST').addEventListener('change', f); });
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
    const kodes = [...new Set([...L.map((r) => r.kode), ...[...I.gol.values()].filter((g) => (I.kel === 'FG' ? g.gol === 'FG' : g.gol !== 'FG')).map((g) => g.kode)])].sort();
    const loks = [...new Set(L.map((r) => r.lok))].sort();
    const line = (i) => `<div class="inv-er" data-i="${i}"><input type="text" name="k${i}" list="invKL" placeholder="Kode" autocomplete="off"><input type="text" name="l${i}" list="invLL" placeholder="Lokasi" autocomplete="off"><input type="text" name="q${i}" inputmode="decimal" placeholder="Qty baru"><span class="muted inv-eo" id="invEo${i}"></span></div>`;
    openDialog({
      title: `Koreksi stok ${I.kel === 'FG' ? 'FG' : 'Material'} · ${fSnap(I.snap)}`, ok: 'Simpan koreksi', wide: true,
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
        return api('editStok', { kel: I.kel, snapshot: I.snap, changes: ch, reason: S(fd.reason) });
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
    $('invSnap').addEventListener('change', () => { setSnap($('invSnap').value); render(); });
    $('invGol').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b) return; I.g = b.dataset.v; render(); });
    $('invView').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b) return; I.view = b.dataset.v; savePref(); render(); });
    $('invMvP').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b) return; I.mvP = +b.dataset.v; savePref(); render(); });
    $('invMvF').addEventListener('change', () => { I.mvF = $('invMvF').value; render(); });
    ['invMvPar', 'invMvWk'].forEach((id) => $(id).addEventListener('change', () => { const v = Math.max(0, Math.min(100, Number($(id).value) || 0)); if (id === 'invMvPar') I.mvPar = v || 80; else I.mvWk = v; savePref(); render(); }));
    $('invKpi').addEventListener('click', (e) => { if (e.target.closest('[data-inv-mv]')) { I.view = 'mov'; savePref(); render(); } });
    $('invPm').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b || b.dataset.v === I.pm) return; I.pm = b.dataset.v; savePref(); render(); });
    $('invChart').addEventListener('change', (e) => {
      const s1 = e.target.closest('[data-bsnap]'); if (s1) { const set = new Set(I.bsnaps); if (s1.checked) set.add(s1.dataset.bsnap); else set.delete(s1.dataset.bsnap); if (!set.size) { s1.checked = true; return; } I.bsnaps = [...set]; I.snapOpen = true; renderChart(); return; }
      const c1 = e.target.closest('[data-bcat]'); if (c1) { const set = new Set(I.bcats); if (c1.checked) set.add(c1.dataset.bcat); else set.delete(c1.dataset.bcat); I.bcats = [...set]; I.catOpen = true; renderChart(); }
    });
    $('invChart').addEventListener('click', (e) => {
      const a = e.target.closest('[data-bcat-all]'); if (a) { const v = a.dataset.bcatAll; I.bcats = v === '1' ? I._barCats.slice() : v === '0' ? [] : I._barCats.slice(0, 8); I.catOpen = true; renderChart(); return; }
      const sa = e.target.closest('[data-bsnap-all]'); if (sa) { const all = I.snaps.map((m) => m.snap), v = sa.dataset.bsnapAll; I.bsnaps = v === '1' ? all : all.slice(-Number(v)); I.snapOpen = true; renderChart(); }
    });
    $('invJpg').addEventListener('click', exportJpg);
    $('invCt').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b || b.dataset.v === I.ct) return; I.ct = b.dataset.v; savePref(); renderChart(); });
    $('invMs').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b) return; I.ms = b.dataset.v; savePref(); renderChart(); });
    $('invBrand').addEventListener('change', () => { I.brand = $('invBrand').value; I.jenis = ''; render(); });
    $('invJenis').addEventListener('change', () => { I.jenis = $('invJenis').value; render(); });
    $('invLok').addEventListener('change', () => { I.lok = $('invLok').value; render(); });
    let tq; $('invQ').addEventListener('input', () => { clearTimeout(tq); tq = setTimeout(() => { I.q = $('invQ').value.trim(); render(); }, 200); });
    $('invEdit').addEventListener('click', editDialog);
    $('invTpl').addEventListener('change', () => { const v = $('invTpl').value; $('invTpl').value = ''; if (v) downloadTpl(v); });
    $('invKel').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b || b.dataset.v === I.kel) return; I.kel = b.dataset.v; I.bsnaps = null; I.bcats = null; I.g = ''; I.brand = ''; I.jenis = ''; I.lok = ''; I.chart = ''; I.open.clear(); savePref(); useKel(); render(); });
    ['gol', 'harga', 'stokmat', 'stokfg'].forEach((k) => {
      const inp = $('invUp-' + k);
      inp.addEventListener('change', async () => {
        const f = inp.files[0]; inp.value = ''; if (!f) return;
        try { const wb = await readBook(f); if (k === 'gol') upGol(wb, f.name); else if (k === 'harga') upHarga(wb, f.name); else upStok(wb, f.name, k === 'stokfg' ? 'FG' : 'MAT'); }
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
    // Sub menu: rep/inv-mat (RM, PM, WIP) dan rep/inv-fg (FG); rep/inventory lama = RM, PM, WIP
    enter(key) {
      bind();
      const kel = /inv-fg$/.test(key || location.hash) ? 'FG' : 'MAT';
      if (kel !== I.kel) { I.kel = kel; I.bsnaps = null; I.bcats = null; I.g = ''; I.brand = ''; I.jenis = ''; I.lok = ''; I.chart = ''; I.open.clear(); savePref(); if (I.loaded) useKel(); }
      const um = $('invUp-stokmat'), uf = $('invUp-stokfg');
      if (um) um.closest('label').hidden = kel === 'FG';
      if (uf) uf.closest('label').hidden = kel !== 'FG';
      render(); if (!I.loaded && !I.loading) load();
    },
    reload() { load(true); },
    sheetUrl() { return I.sheetUrl || CFG.INV_SHEET_URL || ''; },
  };
  // app.js dimuat lebih dulu: bila halaman dibuka langsung di menu ini, masuk sekarang
  if (/^#\/rep\//.test(location.hash)) window.INV.enter();
})();
