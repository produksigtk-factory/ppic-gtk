/* CSL Personal Care — PPIC GTK
 * Data SO & DO (export Odoo) disimpan di Google Sheet "CSL PPIC GTK" lewat Apps Script Code_CSL.gs.
 * Website mengambil data per bulan SO dan menyimpannya di browser (IndexedDB) beserta versinya,
 * sehingga yang diunduh ulang hanya bulan yang berubah. Semua hitungan (CSL, region, SKU, sisa SO,
 * weekly review, analisa forecast, suggest) dilakukan di browser, mengikuti rumus template Excel KPI.
 */
(function () {
  'use strict';

  const CFG = window.PPIC_CONFIG || {};
  const UI = window.PPIC_UI || {};
  const $ = (id) => document.getElementById(id);
  const esc = UI.esc || ((s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const toast = UI.toast || ((t) => console.log(t));
  const todayStr = UI.todayStr || (() => new Date().toISOString().slice(0, 10));

  const REGS = ['R1', 'R2', 'R3', 'R4'];
  const MON = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const GRP_LABEL = { ALL: 'Offline + Online', OFFLINE: 'Offline (GTK)', ONLINE: 'Online (BIMS)' };

  /* ---------- Format ---------- */
  const nf0 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf2 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 });
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const fQ = (v) => (!isNum(v) || Math.abs(v) < 0.005 ? '–' : nf0.format(v));          // pcs
  const fQd = (v) => (!isNum(v) ? '–' : Math.abs(v) < 0.005 ? '0' : nf2.format(v));     // pcs dengan desimal
  const fJt = (v) => (!isNum(v) || Math.abs(v) < 500 ? '–' : nf1.format(v / 1e6));      // Rp juta
  const fRp = (v) => (!isNum(v) ? '–' : 'Rp ' + nf0.format(Math.round(v)));
  const fPct = (v) => (!isNum(v) ? '–' : nf1.format(v * 100) + '%');
  const fBig = (v) => {
    if (!isNum(v)) return '–';
    const a = Math.abs(v);
    if (a >= 1e9) return nf1.format(v / 1e9) + ' M';
    if (a >= 1e6) return nf1.format(v / 1e6) + ' jt';
    return nf0.format(v);
  };
  const monLabel = (m) => (m ? `${MON[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}` : '');
  const monShort = (m) => (m ? `${MON3[+m.slice(5, 7) - 1]} ${m.slice(2, 4)}` : '');
  const addMonth = (m, n) => { const d = new Date(+m.slice(0, 4), +m.slice(5, 7) - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
  const fDate = (d) => (d ? `${d.slice(8, 10)} ${MON3[+d.slice(5, 7) - 1]} ${d.slice(2, 4)}` : '–');
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const avg = (a) => (a.length ? sum(a) / a.length : NaN);
  const stdevP = (a) => { if (!a.length) return NaN; const m = avg(a); return Math.sqrt(avg(a.map((x) => (x - m) ** 2))); };
  const stdevS = (a) => { if (a.length < 2) return NaN; const m = avg(a); return Math.sqrt(sum(a.map((x) => (x - m) ** 2)) / (a.length - 1)); };
  const median = (a) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
  const nz = (v) => (isNum(v) ? v : 0);
  const ratio = (a, b) => (b ? a / b : NaN);

  /* ---------- State ---------- */
  const C = {
    loaded: false, loading: false, err: '', progress: '',
    P: {}, paramRows: [], dist: new Map(), kota: [], master: new Map(), names: {}, weeks: [],
    months: [], cache: new Map(), fct: new Map(), fctRows: [], nilai: new Map(), nilaiRows: [], log: [],
    sheetUrl: '', dbUrl: '', readAt: '',
    lines: [], orphans: [], A: null, cancelSisa: false, lastOrphans: [],
    excl: { OFFLINE: new Set(), ONLINE: new Set() },
    route: '',
  };
  const P = (k, d) => (C.P[k] === undefined || C.P[k] === '' ? d : C.P[k]);
  const pNum = (k, d) => { const x = Number(String(P(k, d)).replace(',', '.')); return isFinite(x) ? x : d; };

  /* ---------- Penyimpanan di browser ---------- */
  const IDB = {
    db: null,
    open() {
      if (this.db !== null) return Promise.resolve(this.db);
      return new Promise((res) => {
        try {
          const r = indexedDB.open('ppic-csl', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('months', { keyPath: 'm' });
          r.onsuccess = () => { this.db = r.result; res(this.db); };
          r.onerror = () => { this.db = false; res(false); };
        } catch (e) { this.db = false; res(false); }
      });
    },
    async all() {
      const db = await this.open(); if (!db) return [];
      return new Promise((res) => { try { const q = db.transaction('months').objectStore('months').getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]); } catch (e) { res([]); } });
    },
    async put(o) { const db = await this.open(); if (!db) return; try { db.transaction('months', 'readwrite').objectStore('months').put(o); } catch (e) { /* abaikan */ } },
    async del(m) { const db = await this.open(); if (!db) return; try { db.transaction('months', 'readwrite').objectStore('months').delete(m); } catch (e) { /* abaikan */ } },
    async clear() { const db = await this.open(); if (!db) return; try { db.transaction('months', 'readwrite').objectStore('months').clear(); } catch (e) { /* abaikan */ } },
  };

  /* ---------- Apps Script ---------- */
  async function getJSON(url) {
    const res = await fetch(url);
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || 'Gagal membaca data CSL.');
    return d;
  }
  async function api(action, payload) {
    if (!CFG.CSL_SCRIPT_URL) throw new Error('Apps Script CSL belum terpasang (config.js CSL_SCRIPT_URL).');
    const res = await fetch(CFG.CSL_SCRIPT_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action }, payload)),
    });
    const d = await res.json();
    if (!d.ok) {
      if (/Aksi tidak dikenal/.test(d.error || '')) throw new Error('Apps Script CSL belum versi terbaru. Tempel Code_CSL.gs terbaru lalu Deploy → Manage deployments → Edit → New version.');
      throw new Error(d.error || 'Gagal menyimpan.');
    }
    return d;
  }

  /* ---------- Muat data ---------- */
  function paintLoading() {
    const txt = C.err ? C.err : C.loading ? (C.progress || 'Memuat data CSL…') : '';
    document.querySelectorAll('[data-csl-loading]').forEach((el) => {
      el.hidden = !txt;
      el.textContent = txt;
      el.classList.toggle('is-err', !!C.err);
    });
  }
  function applyMeta(d) {
    C.paramRows = d.params || [];
    C.P = {};
    C.paramRows.forEach((r) => { C.P[r[0]] = r[1]; });
    C.cancelSisa = String(P('CANCEL_SISA', 'TIDAK')).toUpperCase() === 'YA';
    C.dist = new Map((d.dist || []).map((r) => [r[0].trim(), { kode: r[1], region: String(r[2] || '').toUpperCase() }]));
    C.kota = (d.kota || []).filter((r) => r[0]).map((r) => [r[0].toUpperCase(), r[1]]);
    C.master = new Map((d.master || []).map((r) => [r[0], r[1]]));
    C.names = d.names || {};
    C.weeks = (d.weeks || []).map((r) => ({ bulan: r[0], week: r[1], start: r[2], end: r[3] }));
    C.months = (d.months || []).map((r) => ({ bulan: r[0], ver: r[1], so: Number(r[2]) || 0, do: Number(r[3]) || 0, at: r[4] }));
    setFct(d.fct || []);
    setNilai(d.nilai || []);
    C.log = d.log || [];
    C.sheetUrl = d.sheetUrl || ''; C.dbUrl = d.dbUrl || ''; C.readAt = d.readAt || '';
  }
  function setFct(rows) {
    C.fctRows = rows;
    C.fct = new Map();
    rows.forEach((r) => { const k = `${r[0]}|${r[1]}|${String(r[2]).toUpperCase()}`; C.fct.set(k, (C.fct.get(k) || 0) + (Number(r[3]) || 0)); });
  }
  function setNilai(rows) {
    C.nilaiRows = rows;
    C.nilai = new Map(rows.map((r) => [`${r[0]}|${String(r[1]).toUpperCase()}`, Number(r[2]) || 0]));
  }

  async function load(opt = {}) {
    if (C.loading) return;
    C.loading = true; C.err = ''; C.progress = 'Membaca daftar data CSL…'; paintLoading();
    try {
      if (!CFG.CSL_SCRIPT_URL) throw new Error('Apps Script CSL belum terpasang. Tempel apps-script/Code_CSL.gs di Google Sheet CSL PPIC GTK, deploy sebagai Web app, lalu isi CSL_SCRIPT_URL di config.js.');
      const meta = await getJSON(CFG.CSL_SCRIPT_URL + '?action=meta');
      applyMeta(meta);
      if (opt.reset) { await IDB.clear(); C.cache.clear(); }
      if (!C.cache.size) (await IDB.all()).forEach((o) => C.cache.set(o.m, o));
      const want = new Map(C.months.map((m) => [m.bulan, m]));
      [...C.cache.keys()].forEach((m) => { if (!want.has(m)) { C.cache.delete(m); IDB.del(m); } });
      const need = C.months.filter((m) => !C.cache.has(m.bulan) || C.cache.get(m.bulan).ver !== m.ver);
      // Kelompokkan ±9.000 baris per permintaan, 2 permintaan berjalan bersamaan
      const batches = [];
      let cur = [], n = 0;
      need.forEach((m) => { cur.push(m.bulan); n += m.so + m.do; if (n >= 9000) { batches.push(cur); cur = []; n = 0; } });
      if (cur.length) batches.push(cur);
      let done = 0;
      const total = need.length;
      const runOne = async (b) => {
        const d = await getJSON(CFG.CSL_SCRIPT_URL + '?action=months&m=' + encodeURIComponent(b.join(',')));
        Object.keys(d.months || {}).forEach((m) => {
          const o = { m, ver: d.months[m].ver, so: d.months[m].so, do: d.months[m].do };
          C.cache.set(m, o); IDB.put(o);
        });
        done += b.length;
        C.progress = `Mengunduh data SO-DO: ${done} dari ${total} bulan…`; paintLoading();
      };
      if (total) { C.progress = `Mengunduh data SO-DO: 0 dari ${total} bulan…`; paintLoading(); }
      const queue = batches.slice();
      const worker = async () => { while (queue.length) await runOne(queue.shift()); };
      await Promise.all([worker(), worker()]);
      C.progress = 'Menghitung…'; paintLoading();
      build();
      C.loaded = true;
    } catch (err) {
      C.err = 'Data CSL belum bisa dimuat: ' + err.message;
    } finally {
      C.loading = false; paintLoading();
      renderHome();
      if (C.route) render(C.route);
    }
  }

  /* ---------- Susun baris SO + DO ---------- */
  const normSt = (s) => String(s || '').trim().toUpperCase();
  function kotaOf(ref) {
    const u = String(ref || '').toUpperCase();
    for (const [k, v] of C.kota) if (u.includes(k)) return v;
    return '';
  }
  function weekOf(ds) {
    const w = C.weeks;
    let lo = 0, hi = w.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ds < w[mid].start) hi = mid - 1; else if (ds > w[mid].end) lo = mid + 1; else return w[mid].week;
    }
    return '';
  }
  function build() {
    const online = String(P('REGION_ONLINE', 'ONLINE')).toUpperCase();
    const map = new Map();
    const lines = [];
    const orphans = [];
    [...C.cache.keys()].sort().forEach((m) => {
      const o = C.cache.get(m);
      if (!o || !o.so) return;
      const h = o.so.h || {};
      (o.so.l || []).forEach(([no, kode, qty, price]) => {
        const hd = h[no] || ['', '', ''];
        const k = no + '|' + kode;
        let L = map.get(k);
        if (!L) {
          L = { no, kode, date: String(hd[0]).slice(0, 10), m: String(hd[0]).slice(0, 7) || m, dist: hd[1], ref: hd[2], qty: 0, amt: 0, dos: [] };
          map.set(k, L); lines.push(L);
        }
        L.qty += Number(qty) || 0;
        L.amt += (Number(qty) || 0) * (Number(price) || 0);
      });
    });
    [...C.cache.keys()].sort().forEach((m) => {
      const o = C.cache.get(m);
      if (!o || !o.do) return;
      const h = o.do.h || {};
      (o.do.l || []).forEach(([noDO, noSO, kode, batch, qty]) => {
        const hd = h[noDO] || ['', ''];
        const L = map.get(noSO + '|' + kode);
        const d = { no: noDO, date: String(hd[0] || '').slice(0, 10), time: String(hd[0] || ''), st: hd[1], qty: Number(qty) || 0, batch };
        if (!L) { orphans.push(Object.assign({ so: noSO, kode }, d)); return; }
        L.dos.push(d);
      });
    });
    lines.forEach((L) => {
      L.price = L.qty ? L.amt / L.qty : 0;
      const di = C.dist.get(String(L.dist || '').trim());
      L.distKode = di ? di.kode : '';
      L.region = di ? di.region : '';
      L.status = L.region === online ? 'ONLINE' : 'OFFLINE';
      L.kota = kotaOf(L.ref);
      L.week = weekOf(L.date);
    });
    C.lines = lines;
    C.lineMap = map;
    C.orphans = orphans;
    compute();
  }
  // Hitungan DO / DO-OS / SISA per baris (dipanggil ulang bila pilihan Cancelled berubah)
  function compute() {
    C.lines.forEach((L) => {
      let dq = 0, oq = 0, sq = 0, cq = 0, noDate = 0;
      const dlv = {};
      L.dos.forEach((d) => {
        const st = normSt(d.st);
        if (st === 'DELIVERED') {
          if (!d.date) { noDate += d.qty; dq += d.qty; return; }
          const dm = d.date.slice(0, 7);
          dlv[dm] = (dlv[dm] || 0) + d.qty;
          if (dm === L.m) dq += d.qty; else oq += d.qty;
        } else if (st === 'CANCELLED' || st === 'CANCEL') {
          cq += d.qty;
          if (C.cancelSisa) sq += d.qty;
        } else sq += d.qty;
      });
      Object.assign(L, { doQ: dq, osQ: oq, sisaQ: sq, canQ: cq, noDateQ: noDate, dlv });
    });
    aggregate();
  }

  /* ---------- Agregat ---------- */
  // Kelompok: ALL, OFFLINE/ONLINE, region (R1..R4, ONLINE, '?')
  function aggregate() {
    const A = { month: {}, dlvMonth: {}, sku: {}, skuDlv: {}, day: {}, skuDay: {}, skuWeek: {}, codes: new Set(), soMonths: new Set(), lastSo: '', lastDo: '' };
    const add = (obj, key, grps, f, v) => {
      let o = obj[key]; if (!o) o = obj[key] = {};
      grps.forEach((g) => { let x = o[g]; if (!x) x = o[g] = {}; x[f] = (x[f] || 0) + v; });
    };
    C.lines.forEach((L) => {
      const g = ['ALL', L.status, L.region || '?'];
      const p = L.price;
      A.codes.add(L.kode); A.soMonths.add(L.m);
      if (L.date > A.lastSo) A.lastSo = L.date;
      add(A.month, L.m, g, 'so', L.amt);
      add(A.month, L.m, g, 'do', L.doQ * p);
      add(A.month, L.m, g, 'os', L.osQ * p);
      add(A.month, L.m, g, 'sisa', L.sisaQ * p);
      add(A.month, L.m, g, 'can', L.canQ * p);
      const sk = L.m + '|' + L.kode;
      add(A.sku, sk, g, 'so', L.qty);
      add(A.sku, sk, g, 'do', L.doQ);
      add(A.sku, sk, g, 'os', L.osQ);
      add(A.sku, sk, g, 'sisa', L.sisaQ);
      add(A.sku, sk, g, 'can', L.canQ);
      Object.keys(L.dlv).forEach((dm) => {
        add(A.dlvMonth, dm, g, 'amt', L.dlv[dm] * p);
        add(A.skuDlv, L.m + '|' + dm + '|' + L.kode, g, 'q', L.dlv[dm]);
      });
      L.dos.forEach((d) => { if (d.date > A.lastDo) A.lastDo = d.date; });
      add(A.day, L.date, g, 'so', L.amt);
      add(A.skuDay, L.date + '|' + L.kode, g, 'q', L.qty);
      add(A.skuWeek, L.m + '|' + L.week + '|' + L.kode, g, 'q', L.qty);
    });
    C.fct.forEach((v, k) => { const [m, kode] = k.split('|'); A.codes.add(kode); });
    A.monthsAll = [...new Set([...A.soMonths, ...C.fctRows.map((r) => r[0])])].sort();
    A.soList = [...A.soMonths].sort();
    C.A = A;
  }
  const gv = (obj, key, g, f) => { const o = obj[key]; return o && o[g] && o[g][f] ? o[g][f] : 0; };
  const skuV = (m, kode, g, f) => gv(C.A.sku, m + '|' + kode, g, f);
  const dlvV = (soM, dM, kode, g) => gv(C.A.skuDlv, soM + '|' + dM + '|' + kode, g, 'q');
  // Forecast pcs per kelompok
  function fctOf(m, kode, g) {
    const f = (r) => C.fct.get(`${m}|${kode}|${r}`) || 0;
    if (g === 'ALL') return sum(REGS.map(f)) + f('ONLINE');
    if (g === 'OFFLINE') return sum(REGS.map(f));
    return f(g);
  }
  function nilaiOf(m, g) {
    const f = (r) => C.nilai.get(`${m}|${r}`) || 0;
    if (g === 'ALL') return sum(REGS.map(f)) + f('ONLINE');
    if (g === 'OFFLINE') return sum(REGS.map(f));
    return f(g);
  }
  const nameOf = (k) => C.master.get(k) || C.names[k] || '';
  const curMonth = () => todayStr().slice(0, 7);
  const lastSoMonth = () => (C.A && C.A.soList.length ? C.A.soList[C.A.soList.length - 1] : curMonth());

  /* ---------- Pilihan umum ---------- */
  function fillSel(el, opts, keep) {
    const cur = el.dataset.ready ? el.value : keep;
    el.innerHTML = opts.map((o) => `<option value="${esc(o[0])}">${esc(o[1])}</option>`).join('');
    if (opts.some((o) => o[0] === cur)) el.value = cur;
    else if (keep !== undefined && opts.some((o) => o[0] === keep)) el.value = keep;
    el.dataset.ready = '1';
  }
  const grpOpts = (withAll = true) => (withAll ? [['ALL', GRP_LABEL.ALL]] : []).concat([['OFFLINE', GRP_LABEL.OFFLINE], ['ONLINE', GRP_LABEL.ONLINE]]);
  function periodOpts() {
    const years = [...new Set(C.A.soList.map((m) => m.slice(0, 4)))].sort().reverse();
    return [['12', '12 bulan terakhir'], ['24', '24 bulan terakhir']].concat(years.map((y) => [y, 'Tahun ' + y]));
  }
  function periodMonths(v) {
    const list = C.A.soList;
    if (!list.length) return [];
    if (/^\d{4}$/.test(v)) return Array.from({ length: 12 }, (_, i) => `${v}-${String(i + 1).padStart(2, '0')}`);
    const n = Number(v) || 12, end = lastSoMonth();
    return Array.from({ length: n }, (_, i) => addMonth(end, i - n + 1)).filter((m) => m >= list[0]);
  }
  const monthOpts = (list) => list.slice().reverse().map((m) => [m, monLabel(m)]);
  function toExcel(name, sheets) {
    const wb = XLSX.utils.book_new();
    sheets.forEach(([title, aoa]) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), title.slice(0, 31)));
    XLSX.writeFile(wb, `${name}_${todayStr()}.xlsx`);
  }
  const kpis = (list) => list.map((k) => `<div class="pk${k.tone ? ' is-' + k.tone : ''}"${k.title ? ` title="${esc(k.title)}"` : ''}><span class="pk-num">${k.num}</span><span class="pk-lbl">${k.lbl}</span></div>`).join('');
  const cslTone = (v) => (!isNum(v) ? '' : v >= 0.98 ? 'ok' : v >= 0.9 ? 'warn' : 'bad');
  const pctCell = (v) => `<td class="num csl-pct is-${cslTone(v) || 'none'}">${fPct(v)}</td>`;

  /* =====================================================================
     DASHBOARD CSL (GRAFIK CSL)
     ===================================================================== */
  const D = { grp: 'ALL' };
  function csl(m, g) {
    const mo = C.A.month[m] && C.A.month[m][g] || {};
    const so = mo.so || 0, dq = mo.do || 0;
    const dlv = gv(C.A.dlvMonth, m, g, 'amt');
    return { so, do: dq, dos: dlv, sisa: mo.sisa || 0, can: mo.can || 0, os: mo.os || 0, csl: ratio(dq, so), cslOs: ratio(dlv, so) };
  }
  function renderDash() {
    fillSel($('cdMonth'), monthOpts(C.A.soList), lastSoMonth());
    fillSel($('cdPeriod'), periodOpts(), '12');
    const m = $('cdMonth').value;
    const a = csl(m, 'ALL'), off = csl(m, 'OFFLINE'), on = csl(m, 'ONLINE');
    const tgt = pNum('TARGET_CSL', 1);
    $('cdKpi').innerHTML = kpis([
      { num: fPct(a.csl), lbl: `CSL ${monLabel(m)}`, tone: cslTone(a.csl), title: `DO bulan sama ${fRp(a.do)} ÷ SO ${fRp(a.so)} · target ${fPct(tgt)}` },
      { num: fPct(a.cslOs), lbl: 'CSL + OS', title: `Semua DO terkirim di bulan ini ${fRp(a.dos)} ÷ SO ${fRp(a.so)}` },
      { num: fPct(off.csl), lbl: 'CSL Offline (GTK)', tone: cslTone(off.csl) },
      { num: fPct(on.csl), lbl: 'CSL Online (BIMS)', tone: cslTone(on.csl) },
      { num: fBig(a.so), lbl: 'SO bulan ini (Rp)' },
      { num: fBig(a.sisa), lbl: 'Sisa SO bulan ini (Rp)', tone: a.sisa ? 'warn' : '' },
    ]);
    $('cdGrp').innerHTML = ['ALL', 'OFFLINE', 'ONLINE'].map((g) => `<button class="chg-type${D.grp === g ? ' is-on' : ''}" data-g="${g}">${GRP_LABEL[g]}</button>`).join('');
    const months = periodMonths($('cdPeriod').value);
    const useOs = $('cdOs').checked;
    $('cdChartSub').textContent = `${useOs ? 'CSL + OS' : 'CSL'} per bulan, ${monLabel(months[0])} – ${monLabel(months[months.length - 1])}. Garis putus-putus = target ${fPct(tgt)}.`;
    $('cdChart').innerHTML = lineChart(months, ['ALL', 'OFFLINE', 'ONLINE'].map((g) => ({
      name: GRP_LABEL[g], cls: 's-' + g.toLowerCase(),
      vals: months.map((x) => { const r = csl(x, g); return useOs ? r.cslOs : r.csl; }),
    })), tgt);
    const g = D.grp;
    const rows = months.map((x) => csl(x, g));
    $('cdTblTitle').textContent = `${GRP_LABEL[g]} — Rp juta`;
    const head = `<thead><tr><th class="pl-sticky pl-c1">Keterangan</th>${months.map((x) => `<th class="num">${monShort(x)}</th>`).join('')}</tr></thead>`;
    const tr = (lbl, f, cls = '') => `<tr class="${cls}"><td class="pl-sticky pl-c1">${lbl}</td>${rows.map(f).join('')}</tr>`;
    $('cdTable').innerHTML = head + '<tbody>'
      + tr('SO', (r) => `<td class="num" title="${fRp(r.so)}">${fJt(r.so)}</td>`)
      + tr('DO (bulan sama)', (r) => `<td class="num" title="${fRp(r.do)}">${fJt(r.do)}</td>`)
      + tr('DO + OS (terkirim di bulan itu)', (r) => `<td class="num" title="${fRp(r.dos)}">${fJt(r.dos)}</td>`)
      + tr('Sisa SO', (r) => `<td class="num" title="${fRp(r.sisa)}">${fJt(r.sisa)}</td>`)
      + tr('Target CSL', () => `<td class="num">${fPct(tgt)}</td>`, 'csl-muted')
      + tr('% CSL', (r) => pctCell(r.csl), 'csl-strong')
      + tr('% CSL + OS', (r) => pctCell(r.cslOs), 'csl-strong')
      + '</tbody>';
  }
  function lineChart(months, series, target) {
    const W = 920, H = 280, L = 46, R = 26, T = 14, B = 34;
    const all = series.flatMap((s) => s.vals.filter(isNum)).concat([target]);
    const lo = Math.max(0, Math.floor(Math.min(...all, 0.8) * 10) / 10), hi = Math.ceil(Math.max(...all, 1.05) * 10) / 10;
    const x = (i) => L + (months.length <= 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (months.length - 1));
    const y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo || 1));
    let g = '';
    for (let v = lo; v <= hi + 1e-9; v += 0.1) g += `<line class="cslc-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="cslc-ax" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${Math.round(v * 100)}%</text>`;
    months.forEach((m, i) => { if (months.length <= 14 || i % 2 === 0) g += `<text class="cslc-ax" x="${x(i)}" y="${H - 12}" text-anchor="middle">${monShort(m)}</text>`; });
    g += `<line class="cslc-target" x1="${L}" x2="${W - R}" y1="${y(target)}" y2="${y(target)}"/>`;
    series.forEach((s) => {
      let d = '', pen = false;
      s.vals.forEach((v, i) => { if (isNum(v)) { d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; } else pen = false; });
      g += `<path class="cslc-line ${s.cls}" d="${d}"/>`;
      s.vals.forEach((v, i) => { if (isNum(v)) g += `<circle class="cslc-dot ${s.cls}" cx="${x(i)}" cy="${y(v)}" r="4"><title>${esc(s.name)} · ${monLabel(months[i])}: ${fPct(v)}</title></circle>`; });
    });
    const legend = series.map((s) => `<span class="cslc-leg"><i class="${s.cls}"></i>${esc(s.name)}</span>`).join('');
    return `<div class="cslc-legend">${legend}</div><svg class="cslc" viewBox="0 0 ${W} ${H}" role="img" aria-label="Grafik CSL per bulan">${g}</svg>`;
  }

  /* =====================================================================
     REVIEW REGION (REVIEW ALL)
     ===================================================================== */
  function regionRow(m) {
    const cell = (g) => ({ fct: nilaiOf(m, g), so: gv(C.A.month, m, g, 'so'), dos: gv(C.A.dlvMonth, m, g, 'amt') });
    const r = {};
    REGS.concat(['ONLINE']).forEach((g) => { r[g] = cell(g); });
    const tot = (keys) => ({ fct: sum(keys.map((k) => r[k].fct)), so: sum(keys.map((k) => r[k].so)), dos: sum(keys.map((k) => r[k].dos)) });
    r.GTK = tot(REGS); r.TOTAL = tot(REGS.concat(['ONLINE']));
    return r;
  }
  function renderRegion() {
    fillSel($('crPeriod'), periodOpts(), '12');
    const months = periodMonths($('crPeriod').value);
    const view = $('crView').value;
    const keys = view === 'reg' ? REGS : ['GTK', 'ONLINE', 'TOTAL'];
    const label = { GTK: 'Total region (GTK)', ONLINE: 'Online (BIMS)', TOTAL: 'Total semua' };
    const sub = '<th class="num m-start">FCT</th><th class="num">SO</th><th class="num">DO</th><th class="num">CSL</th><th class="num">GAP</th>';
    const head = `<thead><tr><th class="pl-sticky pl-c1" rowspan="2">Bulan</th>${keys.map((g) => `<th colspan="5" class="m-start">${label[g] || g}</th>`).join('')}</tr><tr>${keys.map(() => sub).join('')}</tr></thead>`;
    const c5 = (x) => `<td class="num m-start" title="${fRp(x.fct)}">${fJt(x.fct)}</td><td class="num" title="${fRp(x.so)}">${fJt(x.so)}</td><td class="num" title="${fRp(x.dos)}">${fJt(x.dos)}</td>`
      + pctCell(ratio(x.dos, x.so)) + `<td class="num${x.fct - x.so < 0 ? ' csl-neg' : ''}" title="${fRp(x.fct - x.so)}">${x.fct ? fJt(x.fct - x.so) : '–'}</td>`;
    const rows = months.map((m) => [m, regionRow(m)]);
    const tot = {};
    keys.forEach((g) => { tot[g] = { fct: sum(rows.map((r) => r[1][g].fct)), so: sum(rows.map((r) => r[1][g].so)), dos: sum(rows.map((r) => r[1][g].dos)) }; });
    const body = rows.map(([m, r]) => `<tr class="row" data-m="${m}" title="Klik untuk mengisi forecast Rupiah ${monLabel(m)}"><td class="pl-sticky pl-c1">${monLabel(m)}</td>${keys.map((g) => c5(r[g])).join('')}</tr>`).join('');
    $('crTable').innerHTML = head + `<tbody>${body}</tbody><tfoot><tr><td class="pl-sticky pl-c1"><b>Total periode</b></td>${keys.map((g) => c5(tot[g])).join('')}</tr></tfoot>`;
  }
  function openNilai(m) {
    m = m || curMonth();
    const opts = [...new Set(C.A.monthsAll.concat([curMonth(), addMonth(curMonth(), 1), addMonth(curMonth(), 2)]))].sort().reverse();
    const inp = (g) => `<label class="field"><span>${g === 'ONLINE' ? 'Online (BIMS)' : g} — Rp</span><input type="text" inputmode="numeric" name="v_${g}" value="${C.nilai.has(m + '|' + g) ? nf0.format(C.nilai.get(m + '|' + g)) : ''}"></label>`;
    UI.openDialog({
      title: 'Forecast Rupiah per region', ok: 'Simpan',
      body: `<p class="dlg-lead">Isi nilai forecast (Rp) per region untuk bulan yang dipilih. Kosongkan untuk menghapus.</p>
        <div class="form-grid"><label class="field span-2"><span>Bulan</span><select name="m" id="nlMonth">${opts.map((x) => `<option value="${x}"${x === m ? ' selected' : ''}>${monLabel(x)}</option>`).join('')}</select></label>
        ${REGS.concat(['ONLINE']).map(inp).join('')}</div>`,
      onSubmit: async (fd) => {
        const rows = REGS.concat(['ONLINE']).map((g) => {
          const t = String(fd['v_' + g] || '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
          return [fd.m, g, t === '' ? '' : Number(t)];
        });
        if (rows.some((r) => r[2] !== '' && !isFinite(r[2]))) throw new Error('Isi angka Rupiah yang valid.');
        const res = await api('saveNilai', { rows, source: 'Manual website' });
        setNilai(res.nilai || []);
        render(C.route);
        return `Forecast Rupiah ${monLabel(fd.m)} tersimpan.`;
      },
    });
    const sel = $('nlMonth');
    if (sel) sel.addEventListener('change', () => { openNilai(sel.value); });
  }

  /* =====================================================================
     REKAP PER SKU ((GTK) / (BIMS))
     ===================================================================== */
  function skuMonths() {
    const end = $('csEnd').value || lastSoMonth(), n = Number($('csSpan').value) || 6;
    return Array.from({ length: n }, (_, i) => addMonth(end, i - n + 1));
  }
  function skuRows(g, months, q) {
    const codes = [...C.A.codes].filter((k) => months.some((m) => skuV(m, k, g, 'so') || fctOf(m, k, g)));
    const ql = q.toLowerCase();
    return codes.filter((k) => !ql || k.toLowerCase().includes(ql) || nameOf(k).toLowerCase().includes(ql))
      .map((k) => ({ k, n: nameOf(k), v: months.map((m) => ({ fct: fctOf(m, k, g), so: skuV(m, k, g, 'so'), do: skuV(m, k, g, 'do'), os: skuV(m, k, g, 'os') })) }))
      .sort((a, b) => sum(b.v.map((x) => x.so)) - sum(a.v.map((x) => x.so)) || a.k.localeCompare(b.k));
  }
  function renderSku() {
    fillSel($('csGrp'), grpOpts(), 'OFFLINE');
    fillSel($('csEnd'), monthOpts([...new Set(C.A.monthsAll.concat(C.A.soList))].sort()), lastSoMonth());
    const g = $('csGrp').value, months = skuMonths();
    const rows = skuRows(g, months, $('csQ').value.trim());
    $('csInfo').textContent = `${nf0.format(rows.length)} SKU · ${GRP_LABEL[g]} · ${monLabel(months[0])} – ${monLabel(months[months.length - 1])}`;
    const tot = months.map((_, i) => ({ fct: sum(rows.map((r) => r.v[i].fct)), so: sum(rows.map((r) => r.v[i].so)), do: sum(rows.map((r) => r.v[i].do)), os: sum(rows.map((r) => r.v[i].os)) }));
    const c4 = (x, first) => `<td class="num${first ? ' m-start' : ''}">${fQ(x.fct)}</td><td class="num">${fQ(x.so)}</td><td class="num">${fQ(x.do)}</td><td class="num">${fQ(x.os)}</td>`;
    const head = `<thead><tr><th class="pl-sticky pl-c1" rowspan="2">Kode</th><th class="pl-sticky pl-c2" rowspan="2">Nama produk</th>${months.map((m) => `<th colspan="4" class="m-start">${monLabel(m)}</th>`).join('')}</tr>`
      + `<tr>${months.map(() => '<th class="num m-start">FCT</th><th class="num">SO</th><th class="num">DO</th><th class="num">DO-OS</th>').join('')}</tr>`
      + `<tr class="csl-tot"><th class="pl-sticky pl-c1">Total</th><th class="pl-sticky pl-c2"></th>${tot.map((x) => c4(x, true).replace(/<td/g, '<th').replace(/<\/td>/g, '</th>')).join('')}</tr></thead>`;
    const body = rows.slice(0, 400).map((r) => `<tr><td class="pl-sticky pl-c1">${esc(r.k)}</td><td class="pl-sticky pl-c2" title="${esc(r.n)}">${esc(r.n)}</td>${r.v.map((x) => c4(x, true)).join('')}</tr>`).join('');
    $('csTable').innerHTML = head + `<tbody>${body || `<tr><td colspan="${2 + months.length * 4}" class="csl-empty">Tidak ada data.</td></tr>`}</tbody>`;
  }

  /* =====================================================================
     SISA SO (OS-SO)
     ===================================================================== */
  function osLines(g, q) {
    const ql = q.toLowerCase();
    return C.lines.filter((L) => (L.sisaQ > 0 || L.canQ > 0) && (g === 'ALL' || L.status === g)
      && (!ql || L.kode.toLowerCase().includes(ql) || nameOf(L.kode).toLowerCase().includes(ql) || L.no.toLowerCase().includes(ql) || String(L.dist).toLowerCase().includes(ql)));
  }
  function renderOs() {
    fillSel($('coGrp'), grpOpts(), 'ALL');
    $('coCancel').checked = C.cancelSisa;
    const g = $('coGrp').value, mode = $('coMode').value, q = $('coQ').value.trim();
    const ls = osLines(g, q);
    const sisaL = ls.filter((L) => L.sisaQ > 0);
    const tSisa = sum(sisaL.map((L) => L.sisaQ * L.price)), tCan = sum(ls.map((L) => L.canQ * L.price));
    const nSo = new Set(sisaL.map((L) => L.no)).size;
    const oldest = sisaL.reduce((a, L) => (!a || L.date < a ? L.date : a), '');
    $('coKpi').innerHTML = kpis([
      { num: fBig(tSisa), lbl: 'Sisa SO (Rp)', tone: tSisa ? 'warn' : '' },
      { num: nf0.format(sum(sisaL.map((L) => L.sisaQ))), lbl: 'Sisa SO (pcs)' },
      { num: nf0.format(nSo), lbl: 'SO masih ada sisa' },
      { num: oldest ? fDate(oldest) : '–', lbl: 'SO sisa tertua' },
      { num: fBig(tCan), lbl: `DO Cancelled (Rp)${C.cancelSisa ? ' — ikut sisa' : ''}` },
    ]);
    if (mode === 'sku') {
      const months = [...new Set(sisaL.map((L) => L.m))].sort();
      const by = new Map();
      sisaL.forEach((L) => { let r = by.get(L.kode); if (!r) by.set(L.kode, (r = {})); r[L.m] = (r[L.m] || 0) + L.sisaQ; });
      const rows = [...by.entries()].map(([k, r]) => ({ k, r, t: sum(Object.values(r)) })).sort((a, b) => b.t - a.t);
      $('coInfo').textContent = `${nf0.format(rows.length)} SKU dengan sisa SO · pcs per bulan SO`;
      $('coTable').innerHTML = `<thead><tr><th class="pl-sticky pl-c1">Kode</th><th class="pl-sticky pl-c2">Nama produk</th><th class="num">Total</th>${months.map((m) => `<th class="num">${monShort(m)}</th>`).join('')}</tr>`
        + `<tr class="csl-tot"><th class="pl-sticky pl-c1">Total</th><th class="pl-sticky pl-c2"></th><th class="num">${fQ(sum(rows.map((x) => x.t)))}</th>${months.map((m) => `<th class="num">${fQ(sum(rows.map((x) => x.r[m] || 0)))}</th>`).join('')}</tr></thead>`
        + `<tbody>${rows.map((x) => `<tr><td class="pl-sticky pl-c1">${esc(x.k)}</td><td class="pl-sticky pl-c2" title="${esc(nameOf(x.k))}">${esc(nameOf(x.k))}</td><td class="num"><b>${fQ(x.t)}</b></td>${months.map((m) => `<td class="num">${fQ(x.r[m])}</td>`).join('')}</tr>`).join('') || '<tr><td colspan="3" class="csl-empty">Tidak ada sisa SO.</td></tr>'}</tbody>`;
    } else {
      const rows = ls.slice().sort((a, b) => a.date.localeCompare(b.date) || a.no.localeCompare(b.no));
      $('coInfo').textContent = `${nf0.format(rows.length)} baris SO × produk`;
      const t = todayStr();
      const age = (d) => Math.round((new Date(t) - new Date(d)) / 86400000);
      $('coTable').innerHTML = '<thead><tr><th>No SO</th><th>Tanggal SO</th><th class="num">Umur (hari)</th><th>Distributor</th><th>Region</th><th>Kode</th><th>Nama produk</th><th class="num">Qty SO</th><th class="num">Terkirim</th><th class="num">Sisa</th><th class="num">Cancelled</th><th class="num">Sisa (Rp)</th><th>DO belum terkirim</th></tr></thead>'
        + `<tbody>${rows.slice(0, 1500).map((L) => `<tr><td>${esc(L.no)}</td><td>${fDate(L.date)}</td><td class="num">${age(L.date)}</td><td>${esc(L.dist)}</td><td>${esc(L.region || '?')}</td><td>${esc(L.kode)}</td><td class="csl-name" title="${esc(nameOf(L.kode))}">${esc(nameOf(L.kode))}</td><td class="num">${fQ(L.qty)}</td><td class="num">${fQ(L.doQ + L.osQ)}</td><td class="num"><b>${fQ(L.sisaQ)}</b></td><td class="num">${fQ(L.canQ)}</td><td class="num">${fJt(L.sisaQ * L.price)} jt</td><td>${esc(L.dos.filter((d) => normSt(d.st) !== 'DELIVERED').map((d) => `${d.no} (${d.st})`).join(', '))}</td></tr>`).join('') || '<tr><td colspan="13" class="csl-empty">Tidak ada sisa SO.</td></tr>'}</tbody>`;
    }
  }

  /* =====================================================================
     WEEKLY REVIEW
     ===================================================================== */
  function monthDays(m) {
    const n = new Date(+m.slice(0, 4), +m.slice(5, 7), 0).getDate();
    return Array.from({ length: n }, (_, i) => `${m}-${String(i + 1).padStart(2, '0')}`);
  }
  const HARI = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
  function renderWeekly() {
    fillSel($('cwMonth'), monthOpts(C.A.soList), lastSoMonth());
    const m = $('cwMonth').value, mode = $('cwMode').value, q = $('cwQ').value.trim().toLowerCase();
    const days = monthDays(m);
    const wk = new Map(days.map((d) => [d, weekOf(d)]));
    const weeks = [...new Set(days.map((d) => wk.get(d)).filter(Boolean))];
    const cols = REGS.concat(['ONLINE']);
    $('cwQ').closest('.tb-search').hidden = mode === 'day';
    if (mode === 'day') {
      const dayRows = days.map((d) => ({ d, w: wk.get(d), v: cols.map((g) => gv(C.A.day, d, g, 'so')) }));
      const wRows = weeks.map((w) => ({ w, v: cols.map((_, i) => sum(dayRows.filter((r) => r.w === w).map((r) => r.v[i]))) }));
      const tot = cols.map((_, i) => sum(dayRows.map((r) => r.v[i])));
      const offT = sum(tot.slice(0, 4));
      $('cwBody').innerHTML = `<div class="csl-week-grid">
        <article class="csl-card"><header class="csl-card-head"><h2>SO per hari — ${monLabel(m)}</h2><p class="card-sub">Rp juta, menurut tanggal SO.</p></header>
          <div class="table-wrap"><table class="po-table csl-table csl-small"><thead><tr><th>Tanggal</th><th>Hari</th><th>Week</th>${cols.map((g) => `<th class="num">${g === 'ONLINE' ? 'Online' : g}</th>`).join('')}</tr></thead>
          <tbody>${dayRows.map((r) => `<tr class="${sum(r.v) ? '' : 'csl-muted'}"><td>${fDate(r.d)}</td><td>${HARI[new Date(r.d + 'T00:00:00').getDay()]}</td><td>${esc(r.w)}</td>${r.v.map((v) => `<td class="num" title="${fRp(v)}">${fJt(v)}</td>`).join('')}</tr>`).join('')}</tbody>
          <tfoot><tr><td colspan="3"><b>Total</b></td>${tot.map((v) => `<td class="num"><b>${fJt(v)}</b></td>`).join('')}</tr></tfoot></table></div></article>
        <article class="csl-card"><header class="csl-card-head"><h2>Rekap per week</h2><p class="card-sub">Rp juta. Week dari PEMBAGIAN_WEEK.</p></header>
          <div class="table-wrap"><table class="po-table csl-table csl-small"><thead><tr><th>Week</th>${cols.map((g) => `<th class="num">${g === 'ONLINE' ? 'Online' : g}</th>`).join('')}<th class="num">Total</th></tr></thead>
          <tbody>${wRows.map((r) => `<tr><td>${esc(r.w)}</td>${r.v.map((v) => `<td class="num" title="${fRp(v)}">${fJt(v)}</td>`).join('')}<td class="num"><b>${fJt(sum(r.v))}</b></td></tr>`).join('')}</tbody>
          <tfoot><tr><td><b>Total</b></td>${tot.map((v) => `<td class="num"><b>${fJt(v)}</b></td>`).join('')}<td class="num"><b>${fJt(sum(tot))}</b></td></tr></tfoot></table></div>
          <dl class="csl-dl"><div><dt>SO offline (R1–R4)</dt><dd>${fRp(offT)}</dd></div><div><dt>SO online</dt><dd>${fRp(tot[4])}</dd></div><div><dt>SO semua</dt><dd>${fRp(sum(tot))}</dd></div></dl></article></div>`;
      return;
    }
    const codes = [...C.A.codes].filter((k) => days.some((d) => gv(C.A.skuDay, d + '|' + k, 'ALL', 'q')))
      .filter((k) => !q || k.toLowerCase().includes(q) || nameOf(k).toLowerCase().includes(q)).sort();
    if (mode === 'skuw') {
      const v = (k, w) => gv(C.A.skuWeek, m + '|' + w + '|' + k, 'ALL', 'q');
      $('cwBody').innerHTML = `<p class="mrp-count">${nf0.format(codes.length)} SKU · qty SO (pcs) per week, ${monLabel(m)}</p><div class="table-wrap pl-wrap"><table class="po-table pl-table csl-table"><thead><tr><th class="pl-sticky pl-c1">Kode</th><th class="pl-sticky pl-c2">Nama produk</th>${weeks.map((w) => `<th class="num">${esc(w)}</th>`).join('')}<th class="num">Total</th></tr></thead>
        <tbody>${codes.map((k) => { const vs = weeks.map((w) => v(k, w)); return `<tr><td class="pl-sticky pl-c1">${esc(k)}</td><td class="pl-sticky pl-c2" title="${esc(nameOf(k))}">${esc(nameOf(k))}</td>${vs.map((x) => `<td class="num">${fQ(x)}</td>`).join('')}<td class="num"><b>${fQ(sum(vs))}</b></td></tr>`; }).join('')}</tbody></table></div>`;
    } else {
      $('cwBody').innerHTML = `<p class="mrp-count">${nf0.format(codes.length)} SKU · qty SO (pcs) per hari, ${monLabel(m)}</p><div class="table-wrap pl-wrap"><table class="po-table pl-table csl-table csl-days"><thead><tr><th class="pl-sticky pl-c1" rowspan="2">Kode</th><th class="pl-sticky pl-c2" rowspan="2">Nama produk</th>${days.map((d) => `<th class="num">${HARI[new Date(d + 'T00:00:00').getDay()]}</th>`).join('')}</tr><tr>${days.map((d) => `<th class="num" title="${esc(wk.get(d))}">${+d.slice(8)}</th>`).join('')}</tr></thead>
        <tbody>${codes.map((k) => `<tr><td class="pl-sticky pl-c1">${esc(k)}</td><td class="pl-sticky pl-c2" title="${esc(nameOf(k))}">${esc(nameOf(k))}</td>${days.map((d) => `<td class="num">${fQ(gv(C.A.skuDay, d + '|' + k, 'ALL', 'q'))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    }
  }
  function exportWeekly() {
    const m = $('cwMonth').value, days = monthDays(m), cols = REGS.concat(['ONLINE']);
    const codes = [...C.A.codes].filter((k) => days.some((d) => gv(C.A.skuDay, d + '|' + k, 'ALL', 'q'))).sort();
    const weeks = [...new Set(days.map(weekOf).filter(Boolean))];
    toExcel(`Weekly_Review_${m}`, [
      ['SO per hari (Rp)', [['TANGGAL', 'WEEK'].concat(cols)].concat(days.map((d) => [d, weekOf(d)].concat(cols.map((g) => Math.round(gv(C.A.day, d, g, 'so'))))))],
      ['FG per week (pcs)', [['KODE', 'NAMA'].concat(weeks)].concat(codes.map((k) => [k, nameOf(k)].concat(weeks.map((w) => gv(C.A.skuWeek, m + '|' + w + '|' + k, 'ALL', 'q')))))],
      ['FG per hari (pcs)', [['KODE', 'NAMA'].concat(days)].concat(codes.map((k) => [k, nameOf(k)].concat(days.map((d) => gv(C.A.skuDay, d + '|' + k, 'ALL', 'q')))))],
    ]);
  }

  /* =====================================================================
     ANALISA FORECAST (ANALISA)
     ===================================================================== */
  // 12 bulan sebelum bulan target; bulan yang dikeluarkan disimpan per status
  function winMonths(target) { return Array.from({ length: 12 }, (_, i) => addMonth(target, i - 12)); }
  function activeWin(g, target) { return winMonths(target).filter((m) => !C.excl[g].has(m) && (C.A.soMonths.has(m) || C.fctRows.some((r) => r[0] === m))); }
  // Statistik per SKU — mengikuti kolom CB..DB sheet ANALISA
  function statsOf(kode, g, W) {
    const fc = W.map((m) => fctOf(m, kode, g)), so = W.map((m) => skuV(m, kode, g, 'so'));
    const err = so.map((s, i) => s - fc[i]);
    const pct = so.map((s, i) => (fc[i] === 0 && s === 0 ? 0 : fc[i] === 0 || s === 0 ? null : Math.abs(err[i] / s)));   // null = "Zero Demand"
    const soPos = so.filter((x) => x > 0);
    const E = (v) => (isNum(v) ? v : 0);
    const cm = E(stdevP(soPos)), cp = E(avg(soPos));
    const adi = soPos.length ? W.length / soPos.length : 0;
    const cw = cp ? cm / cp : 0, cx = cw * cw;
    const adiB = pNum('ADI_BATAS', 1.32), cvB = pNum('CV2_BATAS', 0.49);
    const type = !adi || !cx ? 'Undefined' : adi <= adiB && cx <= cvB ? 'Smooth' : adi > adiB && cx <= cvB ? 'Intermittent' : adi <= adiB && cx > cvB ? 'Erratic' : 'Lumpy';
    const z = pNum('SS_Z', 2.33), lead = pNum('SS_LEAD_HARI', 10), per = pNum('SS_PERIODE_HARI', 30), fa = pNum('SS_FAKTOR_AVG', 0.027);
    const errNz = err.filter((x) => x !== 0);
    return {
      kode, W, fc, so, err, pct,
      cb: E(stdevP(so)), ce: E(avg(so)), ch: E(avg(err)), ci: E(avg(err.map(Math.abs))), cj: E(avg(pct.filter(isNum))),
      cm, cp, cn: cp - 2 * cm, co: cp - cm, cq: cp + cm, cr: cp + 2 * cm,
      cs: E(avg(errNz)), ct: E(avg(errNz.map(Math.abs))), cu: E(avg(pct.filter((x) => isNum(x) && x > 0))),
      adi, cw, cx, cy: so.length ? Math.max(...so) : 0, cz: soPos.length ? Math.min(...soPos) : 0, type,
      ss: z * cm * Math.sqrt(lead / per) + z * cp * fa,
      maxAll: Math.max(0, ...fc, ...so),
    };
  }
  function anCodes(g, W, extra = []) {
    return [...C.A.codes].filter((k) => W.some((m) => skuV(m, k, g, 'so') || fctOf(m, k, g)) || extra.includes(k)).sort();
  }
  function renderAnalisa() {
    fillSel($('caGrp'), grpOpts(false), 'OFFLINE');
    const tOpts = [...new Set(C.A.monthsAll.concat([curMonth(), addMonth(curMonth(), 1)]))].sort();
    fillSel($('caMonth'), monthOpts(tOpts), lastSoMonth());
    const g = $('caGrp').value, target = $('caMonth').value;
    const all = winMonths(target);
    const W = activeWin(g, target);
    $('caWin').innerHTML = all.map((m) => {
      const has = C.A.soMonths.has(m) || C.fctRows.some((r) => r[0] === m);
      const on = has && !C.excl[g].has(m);
      return `<button class="chg-type${on ? ' is-on' : ''}" data-m="${m}" ${has ? '' : 'disabled title="Belum ada data"'}>${monShort(m)}</button>`;
    }).join('');
    // Global (kolom E..O)
    const codes = anCodes(g, W);
    const gl = W.map((m) => { const f = sum(codes.map((k) => fctOf(m, k, g))), s = sum(codes.map((k) => skuV(m, k, g, 'so'))); return { m, f, s, e: s - f }; });
    const gs = gl.map((x) => x.s), gAvg = avg(gs), gSd = stdevS(gs);
    const gMape = avg(gl.filter((x) => x.s).map((x) => Math.abs(x.e / x.s)));
    $('caKpi').innerHTML = kpis([
      { num: nf0.format(codes.length), lbl: 'SKU dianalisa' },
      { num: nf0.format(W.length), lbl: 'Bulan dipakai' },
      { num: fQ(avg(gl.map((x) => x.e))), lbl: 'Bias total / bulan (pcs)', title: 'Rata-rata (SO − FCT)' },
      { num: fQ(avg(gl.map((x) => Math.abs(x.e)))), lbl: 'MAD total (pcs)' },
      { num: fPct(gMape), lbl: 'MAPE total', tone: gMape > 0.3 ? 'warn' : '' },
    ]);
    $('caGlobal').innerHTML = `<thead><tr><th>Bulan</th><th class="num">FCT</th><th class="num">SO</th><th class="num">−2σ</th><th class="num">−1σ</th><th class="num">AVG</th><th class="num">1σ</th><th class="num">2σ</th><th class="num">Error</th><th class="num">|Error|</th><th class="num">% Error</th></tr></thead><tbody>`
      + gl.map((x) => `<tr><td>${monLabel(x.m)}</td><td class="num">${fQ(x.f)}</td><td class="num">${fQ(x.s)}</td><td class="num">${fQ(gAvg - 2 * gSd)}</td><td class="num">${fQ(gAvg - gSd)}</td><td class="num">${fQ(gAvg)}</td><td class="num">${fQ(gAvg + gSd)}</td><td class="num">${fQ(gAvg + 2 * gSd)}</td><td class="num${x.e < 0 ? ' csl-neg' : ''}">${fQ(x.e)}</td><td class="num">${fQ(Math.abs(x.e))}</td><td class="num">${x.s ? fPct(Math.abs(x.e / x.s)) : '–'}</td></tr>`).join('')
      + `</tbody><tfoot><tr><td><b>Total / rata-rata</b></td><td class="num"><b>${fQ(sum(gl.map((x) => x.f)))}</b></td><td class="num"><b>${fQ(sum(gs))}</b></td><td colspan="3"></td><td class="num">σ ${fQ(gSd)}</td><td colspan="2"></td><td class="num">${fQ(avg(gl.map((x) => Math.abs(x.e))))}</td><td class="num">${fPct(gMape)}</td></tr></tfoot>`;
    const q = $('caQ').value.trim().toLowerCase();
    const st = codes.filter((k) => !q || k.toLowerCase().includes(q) || nameOf(k).toLowerCase().includes(q)).map((k) => statsOf(k, g, W));
    C.anLast = { g, W, target, st };
    $('caInfo').textContent = `${nf0.format(st.length)} SKU · ${GRP_LABEL[g]} · ${W.length} bulan (${W.map(monShort).join(', ')})`;
    const th = (t, title, cls = 'num') => `<th class="${cls}"${title ? ` title="${esc(title)}"` : ''}>${t}</th>`;
    $('caTable').innerHTML = `<thead><tr><th class="pl-sticky pl-c1" rowspan="2">Kode</th><th class="pl-sticky pl-c2" rowspan="2">Nama produk</th><th colspan="5" class="m-start">Termasuk nol</th><th colspan="10" class="m-start">Tanpa nol</th><th colspan="6" class="m-start">Hasil</th></tr><tr>`
      + th('AVG SO', 'Rata-rata SO semua bulan', 'num m-start') + th('STDEV', 'STDEV.P SO') + th('BIAS', 'Rata-rata (SO − FCT)') + th('MAD', 'Rata-rata |SO − FCT|') + th('MAPE', 'Rata-rata |SO − FCT| ÷ SO (bulan FCT & SO > 0)')
      + th('AVG', 'Rata-rata SO > 0', 'num m-start') + th('σ', 'STDEV.P SO > 0') + th('−2σ') + th('−1σ') + th('1σ') + th('2σ') + th('BIAS', 'Rata-rata error ≠ 0') + th('MAD') + th('MAPE', 'Tanpa Zero Demand') + th('CV²')
      + th('ADI', 'Jumlah bulan ÷ bulan SO > 0', 'num m-start') + th('MAX') + th('MIN', 'SO > 0 terkecil') + th('TIPE', '', '') + th('SAFETY STOCK', 'z·σ·√(lead/periode) + z·AVG·faktor') + th('Bulan', 'Bulan dengan SO > 0')
      + '</tr></thead><tbody>'
      + st.map((s) => `<tr class="row" data-k="${esc(s.kode)}"><td class="pl-sticky pl-c1">${esc(s.kode)}</td><td class="pl-sticky pl-c2" title="${esc(nameOf(s.kode))}">${esc(nameOf(s.kode))}</td>`
        + `<td class="num m-start">${fQ(s.ce)}</td><td class="num">${fQ(s.cb)}</td><td class="num${s.ch < 0 ? ' csl-neg' : ''}">${fQ(s.ch)}</td><td class="num">${fQ(s.ci)}</td><td class="num">${fPct(s.cj)}</td>`
        + `<td class="num m-start">${fQ(s.cp)}</td><td class="num">${fQ(s.cm)}</td><td class="num">${fQ(s.cn)}</td><td class="num">${fQ(s.co)}</td><td class="num">${fQ(s.cq)}</td><td class="num">${fQ(s.cr)}</td><td class="num${s.cs < 0 ? ' csl-neg' : ''}">${fQ(s.cs)}</td><td class="num">${fQ(s.ct)}</td><td class="num">${fPct(s.cu)}</td><td class="num">${fQd(s.cx)}</td>`
        + `<td class="num m-start">${fQd(s.adi)}</td><td class="num">${fQ(s.cy)}</td><td class="num">${fQ(s.cz)}</td><td><span class="csl-type t-${s.type.toLowerCase()}">${s.type}</span></td><td class="num">${fQ(s.ss)}</td><td class="num">${s.so.filter((x) => x > 0).length}/${s.W.length}</td></tr>`).join('')
      + '</tbody>';
  }
  function openStat(kode) {
    const a = C.anLast; if (!a) return;
    const s = a.st.find((x) => x.kode === kode); if (!s) return;
    UI.openDialog({
      title: `${kode} — FCT vs SO`, ok: 'Tutup', cancel: false, wide: true, onSubmit: async () => {},
      body: `<p class="dlg-lead">${esc(nameOf(kode))} · ${GRP_LABEL[a.g]} · tipe <b>${s.type}</b></p>
        <div class="table-wrap"><table class="po-table csl-table csl-small"><thead><tr><th>Bulan</th><th class="num">FCT</th><th class="num">SO</th><th class="num">Error (SO − FCT)</th><th class="num">|Error|</th><th class="num">% Error</th></tr></thead><tbody>
        ${s.W.map((m, i) => `<tr><td>${monLabel(m)}</td><td class="num">${fQ(s.fc[i])}</td><td class="num">${fQ(s.so[i])}</td><td class="num${s.err[i] < 0 ? ' csl-neg' : ''}">${fQ(s.err[i])}</td><td class="num">${fQ(Math.abs(s.err[i]))}</td><td class="num">${s.pct[i] === null ? 'Zero Demand' : fPct(s.pct[i])}</td></tr>`).join('')}
        </tbody></table></div>`,
    });
  }

  /* =====================================================================
     SUGGEST FORECAST (SUG-GTK / SUG-BIMS) + RESUME
     ===================================================================== */
  // Satu baris SUG untuk kode, status g, bulan FCT m — rumus kolom C..AZ
  function sugRow(kode, g, m, s) {
    const prev = addMonth(m, -1), next = addMonth(m, 1);
    const c = fctOf(m, kode, g), h = skuV(m, kode, g, 'so'), n = skuV(m, kode, g, 'do');
    const sOs = dlvV(prev, m, kode, g);          // DO-OS: SO bulan lalu yang terkirim bulan ini
    const xOs = dlvV(m, next, kode, g);          // OS-DO: SO bulan ini yang terkirim bulan depan
    const ac = h - n - xOs;
    const type = s.type.toUpperCase();
    const range = !isNum(c) ? '' : c < s.cn ? '<-2σ' : c < s.co ? '-2σ <> -1σ' : c < s.cp ? '-1σ <> AVG' : c < s.cq ? 'AVG <> 1σ' : c <= s.cr ? '1σ <> 2σ' : '>2σ';
    const bias = s.cs, up = bias < 0 ? 'DOWN' : bias > 0 ? 'UP' : '';
    const mx = s.cy, gap = mx - c, mape = s.cu, buf = s.ss;
    let rType = null;
    if (type === 'SMOOTH') rType = mape < 0.2 ? c : up === 'DOWN' ? c + bias * 0.7 + buf : c - Math.abs(bias) * 0.5;
    else if (type === 'LUMPY') rType = mape > 0.7 ? s.cp + s.cq : up === 'DOWN' ? c + bias * 0.5 + 0.5 * buf : c;
    else if (type === 'ERRATIC') rType = mape > 1 ? s.cp + 1.5 * s.cq : up === 'DOWN' ? Math.max(c, s.cp + s.cq) : c;
    else if (type === 'INTERMITTENT') rType = Math.max(c, s.maxAll, s.ce * 0.97);
    const rRange = range === '>2σ' ? Math.min(c, s.cp) : range === '1σ <> 2σ' ? c - 0.3 * Math.abs(bias) : range === 'AVG <> 1σ' ? c
      : range === '-1σ <> AVG' ? c + 0.2 * buf : range === '-2σ <> -1σ' ? c + 0.5 * buf + 0.3 * gap : range === '<-2σ' ? Math.max(c, s.cp + 1.5 * s.cq) + buf : c;
    let rBias = null;
    if (c) {
      const r = Math.abs(bias / c);
      rBias = up === 'UP' ? (r < 0.1 ? c + bias * 0.2 : r < 0.3 ? c + bias * 0.5 : c + bias * 0.7)
        : (r < 0.1 ? c - Math.abs(bias) * 0.1 : r < 0.3 ? c - Math.abs(bias) * 0.5 : c - Math.abs(bias) * 0.7);
    }
    const rGap = gap > c * 0.5 ? c + 0.3 * gap : c;
    const rMape = mape < 0.2 ? c + bias * 0.3 : mape < 0.4 ? c + bias * 0.5 : mape < 0.7 ? c + bias * 0.7 + buf : Math.max(c, s.cp + s.cq) + buf;
    const rules = [rType, rRange, rBias, rGap, rMape].filter(isNum);
    const mn = rules.length ? Math.min(...rules) : 0, mxR = rules.length ? Math.max(...rules) : 0;
    const av = rules.length ? avg(rules) : 0, md = rules.length ? median(rules) : 0;
    const fin = rules.length ? av + buf : 0;
    const fNext = fctOf(next, kode, g);
    return {
      kode, c, h, gapPct: c ? (h - c) / c : 0, n, sOs, xOs, ac, type: s.type, range, bias, up, mx, gap, mape, buf,
      rType, rRange, rBias, rGap, rMape, mn, av, md, mxR, fin, gapAct: fin - h, fNext, gapSug: fin - c - fNext, sugVsSo: fin ? (h - fin) / fin : 0,
    };
  }
  const SUG_COLS = [
    ['c', 'FCT', 'Forecast bulan ini (pcs)'], ['h', 'SO', 'SO bulan ini'], ['gapPct', 'FC vs SO', '(SO − FCT) ÷ FCT', 'pct'], ['n', 'DO', 'Terkirim di bulan yang sama'],
    ['sOs', 'DO-OS', 'SO bulan lalu yang terkirim bulan ini'], ['xOs', 'OS-DO', 'SO bulan ini yang terkirim bulan depan'], ['ac', 'Sisa SO', 'SO − DO − OS-DO'],
    ['type', 'Tipe', 'Klasifikasi demand (Analisa)', 'txt', 'g1'], ['range', 'Range', 'Posisi FCT terhadap AVG ± σ (tanpa nol)', 'txt'], ['bias', 'Bias', 'Rata-rata error ≠ 0'], ['up', 'Arah', 'UP bila bias > 0', 'txt'],
    ['mx', 'Max', 'SO terbesar 12 bulan'], ['gap', 'Gap', 'Max − FCT'], ['mape', 'MAPE', 'Tanpa Zero Demand', 'pct'], ['buf', 'Buffer', 'Safety stock'],
    ['rType', 'Tipe', 'Aturan menurut tipe demand', 'q', 'g2'], ['rRange', 'Range', 'Aturan menurut posisi σ'], ['rBias', 'Bias', 'Aturan menurut besar bias'], ['rGap', 'Max gap', 'FCT + 30% gap bila gap > 50% FCT'], ['rMape', 'MAPE', 'Aturan menurut MAPE'],
    ['mn', 'Min', '', 'q', 'g3'], ['av', 'Rata-rata', ''], ['md', 'Median', ''], ['mxR', 'Max', ''], ['fin', 'Rata + buffer', 'Final suggest = rata-rata 5 aturan + buffer', 'fin'], ['gapAct', 'Gap aktual', 'Suggest − SO'],
    ['fNext', 'FCT bln depan', 'Forecast bulan berikutnya', 'q', 'g4'], ['gapSug', 'Gap', 'Suggest − FCT − FCT bulan depan (seperti Excel)'], ['sugVsSo', 'Sug vs SO', '(SO − suggest) ÷ suggest', 'pct'],
  ];
  // Tampilan ringkas: kolom inti, final suggest di depan
  const SUG_SHORT = ['c', 'h', 'n', 'ac', 'fin', 'gapAct', 'fNext', 'type', 'mape', 'bias', 'buf'];
  function sugData(g, m) {
    const W = activeWin(g, m);
    const codes = anCodes(g, W, [...C.A.codes].filter((k) => fctOf(m, k, g) || skuV(m, k, g, 'so')));
    return codes.map((k) => sugRow(k, g, m, statsOf(k, g, W)));
  }
  function renderSuggest() {
    fillSel($('cgGrp'), grpOpts(false), 'OFFLINE');
    const tOpts = [...new Set(C.A.monthsAll.concat([curMonth(), addMonth(curMonth(), 1)]))].sort();
    fillSel($('cgMonth'), monthOpts(tOpts), lastSoMonth());
    const mode = $('cgMode').value, g = $('cgGrp').value, m = $('cgMonth').value, q = $('cgQ').value.trim().toLowerCase(), showAll = $('cgAll').checked;
    $('cgGrp').closest('.tb-field').hidden = mode === 'res';
    $('cgCols').closest('.tb-field').hidden = mode === 'res';
    const filt = (k) => !q || k.toLowerCase().includes(q) || nameOf(k).toLowerCase().includes(q);
    if (mode === 'res') {
      const off = new Map(sugData('OFFLINE', m).map((r) => [r.kode, r])), on = new Map(sugData('ONLINE', m).map((r) => [r.kode, r]));
      const codes = [...new Set([...off.keys(), ...on.keys()])].filter(filt)
        .filter((k) => showAll || [off.get(k), on.get(k)].some((r) => r && (r.c || r.h))).sort();
      const z = { c: 0, h: 0, n: 0 };
      const blk = (r) => { r = r || z; return `<td class="num m-start">${fQ(r.c)}</td><td class="num">${fQ(r.h)}</td><td class="num${r.c && r.h < r.c ? ' csl-neg' : ''}">${r.c ? fPct((r.h - r.c) / r.c) : '–'}</td><td class="num">${fQ(r.n)}</td>${pctCell(r.h ? r.n / r.h : NaN)}`; };
      const tot = (mp) => ({ c: sum(codes.map((k) => (mp.get(k) || z).c)), h: sum(codes.map((k) => (mp.get(k) || z).h)), n: sum(codes.map((k) => (mp.get(k) || z).n)) });
      const both = (k) => { const a = off.get(k) || z, b = on.get(k) || z; return { c: a.c + b.c, h: a.h + b.h, n: a.n + b.n }; };
      const tOff = tot(off), tOn = tot(on), tAll = { c: tOff.c + tOn.c, h: tOff.h + tOn.h, n: tOff.n + tOn.n };
      $('cgInfo').textContent = `${nf0.format(codes.length)} SKU · Resume ${monLabel(m)} (pcs)`;
      const sub = '<th class="num m-start">FCT</th><th class="num">SO</th><th class="num">FC vs SO</th><th class="num">DO</th><th class="num">DO vs SO</th>';
      $('cgTable').innerHTML = `<thead><tr><th class="pl-sticky pl-c1" rowspan="2">Kode</th><th class="pl-sticky pl-c2" rowspan="2">Nama produk</th><th colspan="5" class="m-start">Gondowangi (offline)</th><th colspan="5" class="m-start">Buana (online)</th><th colspan="5" class="m-start">Gondowangi + Buana</th></tr><tr>${sub}${sub}${sub}</tr>`
        + `<tr class="csl-tot"><th class="pl-sticky pl-c1">Total</th><th class="pl-sticky pl-c2"></th>${(blk(tOff) + blk(tOn) + blk(tAll)).replace(/<td/g, '<th').replace(/<\/td>/g, '</th>')}</tr></thead>`
        + `<tbody>${codes.map((k) => `<tr><td class="pl-sticky pl-c1">${esc(k)}</td><td class="pl-sticky pl-c2" title="${esc(nameOf(k))}">${esc(nameOf(k))}</td>${blk(off.get(k))}${blk(on.get(k))}${blk(both(k))}</tr>`).join('')}</tbody>`;
      C.sugLast = { mode, m, codes, off, on };
      return;
    }
    const rows = sugData(g, m).filter((r) => filt(r.kode) && (showAll || r.c || r.h)).sort((a, b) => b.c - a.c || b.h - a.h);
    C.sugLast = { mode, g, m, rows };
    const W = activeWin(g, m);
    $('cgInfo').textContent = `${nf0.format(rows.length)} SKU · Suggest ${monLabel(m)} · ${GRP_LABEL[g]} · statistik ${W.length} bulan`;
    const short = $('cgCols').value === 'short';
    const COLS = short ? SUG_SHORT.map((k, i) => { const c = SUG_COLS.find((x) => x[0] === k).slice(); c[4] = ['c', 'fin', 'type'].includes(k) ? 'g' : ''; if (k === 'fin') c[1] = 'Final suggest'; return c; }) : SUG_COLS;
    let h1 = '<th class="pl-sticky pl-c1" rowspan="2">Kode</th><th class="pl-sticky pl-c2" rowspan="2">Nama produk</th>';
    const grp = short ? [['Bulan ini (pcs)', 4], ['Suggest', 3], ['Dasar perhitungan', 4]] : [['Bulan ini (pcs)', 7], ['Hasil analisa', 8], ['Aturan penyesuaian', 5], ['Final suggest', 6], ['Bulan berikutnya', 3]];
    grp.forEach(([t, n]) => { h1 += `<th colspan="${n}" class="m-start">${t}</th>`; });
    const h2 = COLS.map((c, i) => `<th class="${c[3] === 'txt' ? '' : 'num'}${i === 0 || c[4] ? ' m-start' : ''}"${c[2] ? ` title="${esc(c[2])}"` : ''}>${c[1]}</th>`).join('');
    const cell = (r, c, i) => {
      const v = r[c[0]], start = i === 0 || c[4] ? ' m-start' : '';
      if (c[3] === 'txt') return `<td class="${start.trim()}">${c[0] === 'type' ? `<span class="csl-type t-${String(v).toLowerCase()}">${esc(v)}</span>` : esc(v || '')}</td>`;
      if (c[3] === 'pct') return `<td class="num${start}">${fPct(v)}</td>`;
      if (c[3] === 'fin') return `<td class="num csl-fin${start}"><b>${fQ(v)}</b></td>`;
      return `<td class="num${start}${isNum(v) && v < 0 ? ' csl-neg' : ''}">${v === null ? '' : fQ(v)}</td>`;
    };
    const totKeys = new Set(['c', 'h', 'n', 'sOs', 'xOs', 'ac', 'fin', 'gapAct', 'fNext']);
    const tot = COLS.map((c, i) => `<th class="num${i === 0 || c[4] ? ' m-start' : ''}">${totKeys.has(c[0]) ? fQ(sum(rows.map((r) => nz(r[c[0]])))) : ''}</th>`).join('');
    $('cgTable').innerHTML = `<thead><tr>${h1}</tr><tr>${h2}</tr><tr class="csl-tot"><th class="pl-sticky pl-c1">Total</th><th class="pl-sticky pl-c2"></th>${tot}</tr></thead>`
      + `<tbody>${rows.map((r) => `<tr><td class="pl-sticky pl-c1">${esc(r.kode)}</td><td class="pl-sticky pl-c2" title="${esc(nameOf(r.kode))}">${esc(nameOf(r.kode))}</td>${COLS.map((c, i) => cell(r, c, i)).join('')}</tr>`).join('')}</tbody>`;
  }
  function exportSuggest() {
    const s = C.sugLast; if (!s) return;
    if (s.mode === 'res') {
      const z = { c: 0, h: 0, n: 0 };
      toExcel(`Resume_${s.m}`, [['Resume', [['KODE', 'NAMA', 'GTK FCT', 'GTK SO', 'GTK DO', 'BIMS FCT', 'BIMS SO', 'BIMS DO', 'TOTAL FCT', 'TOTAL SO', 'TOTAL DO']]
        .concat(s.codes.map((k) => { const a = s.off.get(k) || z, b = s.on.get(k) || z; return [k, nameOf(k), a.c, a.h, a.n, b.c, b.h, b.n, a.c + b.c, a.h + b.h, a.n + b.n]; }))]]);
      return;
    }
    toExcel(`Suggest_${s.g}_${s.m}`, [['Suggest', [['KODE', 'NAMA'].concat(SUG_COLS.map((c) => c[1]))].concat(s.rows.map((r) => [r.kode, nameOf(r.kode)].concat(SUG_COLS.map((c) => (r[c[0]] === null ? '' : r[c[0]])))))]]);
  }

  /* =====================================================================
     SEASONAL INDEX
     ===================================================================== */
  function seasons() {
    return C.paramRows.filter((r) => /^MUSIM:/i.test(r[0])).map((r) => ({
      key: r[0], name: r[0].replace(/^MUSIM:/i, ''),
      months: String(r[1] ?? '').split(/[^\d]+/).map(Number).filter((x) => x >= 1 && x <= 12),
    }));
  }
  function renderMusim() {
    fillSel($('cmGrp'), grpOpts(), 'ALL');
    const years = [...new Set(C.A.soList.map((m) => m.slice(0, 4)))].sort().reverse();
    fillSel($('cmYear'), years.map((y) => [y, y]), years[0]);
    const g = $('cmGrp').value, y = $('cmYear').value;
    const ss = seasons();
    $('cmBody').innerHTML = ss.map((s) => {
      const ms = s.months.map((x) => `${y}-${String(x).padStart(2, '0')}`);
      const top = [...C.A.codes].map((k) => ({ k, q: sum(ms.map((m) => skuV(m, k, g, 'so'))) })).filter((x) => x.q > 0).sort((a, b) => b.q - a.q).slice(0, 10);
      const tot = sum(top.map((x) => x.q));
      return `<article class="csl-card csl-season"><header class="csl-card-head"><h2><button class="btn-link" data-season="${esc(s.key)}" title="Ubah bulan musim">${esc(s.name)}</button></h2><p class="card-sub">${s.months.map((x) => MON3[x - 1]).join(', ') || 'belum ada bulan'} ${y}</p></header>
        <ol class="csl-top">${top.map((x) => `<li><span class="csl-top-k">${esc(x.k)}</span><span class="csl-top-n" title="${esc(nameOf(x.k))}">${esc(nameOf(x.k))}</span><span class="csl-top-q">${fQ(x.q)}</span><span class="csl-bar" style="--w:${tot ? Math.round((x.q / top[0].q) * 100) : 0}%"></span></li>`).join('') || '<li class="csl-empty">Belum ada SO.</li>'}</ol></article>`;
    }).join('') || '<p class="csl-empty">Belum ada musim di PARAMETER.</p>';
  }
  function editSeason(key) {
    const r = C.paramRows.find((x) => x[0] === key);
    UI.openDialog({
      title: 'Bulan musim', ok: 'Simpan',
      body: `<p class="dlg-lead">${esc(key.replace(/^MUSIM:/i, ''))}: isi angka bulan 1–12, pisah koma (mis. 3,4).</p><div class="form-grid">${UI.fld('v', 'Bulan', String(r ? r[1] : ''), { required: true, wide: true })}</div>`,
      onSubmit: async (fd) => {
        const v = String(fd.v).split(/[^\d]+/).map(Number).filter((x) => x >= 1 && x <= 12).join(',');
        if (!v) throw new Error('Isi minimal satu bulan.');
        const res = await api('saveParam', { key, value: "'" + v });
        C.paramRows = res.params; C.paramRows.forEach((x) => { C.P[x[0]] = x[1]; });
        renderMusim();
        return 'Bulan musim tersimpan.';
      },
    });
  }

  /* =====================================================================
     PEMERIKSAAN DATA
     ===================================================================== */
  const CK = { tab: 'dist' };
  function checks() {
    const L = C.lines;
    const dist = new Map(), ref = new Map(), code = new Map();
    L.forEach((x) => {
      if (!x.region) { const o = dist.get(x.dist) || { n: 0, amt: 0, last: '' }; o.n++; o.amt += x.amt; if (x.date > o.last) o.last = x.date; dist.set(x.dist, o); }
      if (!x.kota) { const k = String(x.ref || '').split('/').pop() || x.ref; const o = ref.get(k) || { n: 0, ex: x.ref, last: '' }; o.n++; if (x.date > o.last) o.last = x.date; ref.set(k, o); }
      if (!C.master.has(x.kode)) { const o = code.get(x.kode) || { n: 0, q: 0 }; o.n++; o.q += x.qty; code.set(x.kode, o); }
    });
    const t = todayStr();
    const noDo = L.filter((x) => !x.dos.length && (new Date(t) - new Date(x.date)) / 86400000 > 3);
    const over = L.filter((x) => x.doQ + x.osQ > x.qty + 1e-6);
    const noDate = L.filter((x) => x.noDateQ > 0);
    return [
      { id: 'dist', label: 'Distributor belum terdaftar', desc: 'Nama distributor di SO tidak ada di DATABASE PPIC GTK → DISTRIBUTOR, jadi region tidak diketahui (dihitung Offline, region "?"). Tambahkan nama persis seperti di Odoo.',
        head: ['Nama distributor (Odoo)', 'Baris SO', 'Nilai SO', 'SO terakhir'], rows: [...dist.entries()].sort((a, b) => b[1].amt - a[1].amt).map(([k, o]) => [esc(k || '(kosong)'), nf0.format(o.n), fRp(o.amt), fDate(o.last)]) },
      { id: 'ref', label: 'Order ref tanpa kota', desc: 'Order ref tidak memuat satu pun KODE REF di DATABASE → KOTA_REF.',
        head: ['Bagian akhir order ref', 'Contoh order ref', 'Baris SO', 'SO terakhir'], rows: [...ref.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, o]) => [esc(k || '(kosong)'), esc(o.ex), nf0.format(o.n), fDate(o.last)]) },
      { id: 'code', label: 'Kode tidak ada di MASTER', desc: 'Kode produk di SO yang belum ada di MASTER_MATERIAL (nama diambil dari SO).',
        head: ['Kode', 'Nama di SO', 'Baris SO', 'Qty'], rows: [...code.entries()].map(([k, o]) => [esc(k), esc(C.names[k] || ''), nf0.format(o.n), nf0.format(o.q)]) },
      { id: 'orphan', label: 'DO tanpa SO', desc: 'DO yang SO-nya belum ada di data. Dari upload terakhir di sesi ini: tidak disimpan — upload SO-nya dulu lalu upload ulang DO.',
        head: ['No SO', 'Baris DO'], rows: (C.lastOrphans || []).map((r) => [esc(r[0]), nf0.format(r[1])]) },
      { id: 'nodo', label: 'SO belum ada DO', desc: 'Baris SO lebih dari 3 hari tanpa DO sama sekali (tidak terhitung terkirim maupun sisa).',
        head: ['No SO', 'Tanggal', 'Distributor', 'Kode', 'Qty', 'Nilai'], rows: noDo.slice(0, 500).map((x) => [esc(x.no), fDate(x.date), esc(x.dist), esc(x.kode), nf0.format(x.qty), fRp(x.amt)]) },
      { id: 'over', label: 'DO melebihi SO', desc: 'Total qty Delivered lebih besar dari qty SO.',
        head: ['No SO', 'Kode', 'Qty SO', 'Terkirim', 'DO'], rows: over.map((x) => [esc(x.no), esc(x.kode), nf0.format(x.qty), nf0.format(x.doQ + x.osQ), esc(x.dos.map((d) => d.no).join(', '))]) },
      { id: 'nodate', label: 'Delivered tanpa tanggal', desc: 'DO berstatus Delivered tetapi tanggal kirim kosong (dihitung terkirim di bulan SO).',
        head: ['No SO', 'Kode', 'Qty', 'DO'], rows: noDate.map((x) => [esc(x.no), esc(x.kode), nf0.format(x.noDateQ), esc(x.dos.filter((d) => !d.date).map((d) => d.no).join(', '))]) },
    ];
  }
  function renderCek() {
    const list = checks();
    const cur = list.find((x) => x.id === CK.tab) || list[0];
    $('ckTabs').innerHTML = list.map((x) => `<button class="chg-type${x.id === cur.id ? ' is-on' : ''}" data-t="${x.id}">${x.label} <b>${nf0.format(x.rows.length)}</b></button>`).join('');
    $('ckTitle').textContent = cur.label;
    $('ckDesc').textContent = cur.desc;
    $('ckHead').innerHTML = `<tr>${cur.head.map((h) => `<th>${h}</th>`).join('')}</tr>`;
    $('ckRows').innerHTML = cur.rows.map((r) => `<tr>${r.map((v) => `<td>${v}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${cur.head.length}" class="csl-empty">Tidak ada temuan.</td></tr>`;
  }
  function paintBadge() {
    const b = $('cslBadge'); if (!b || !C.loaded) return;
    const n = checks().filter((x) => ['dist', 'code', 'over'].includes(x.id)).reduce((a, x) => a + x.rows.length, 0);
    b.hidden = !n; b.textContent = n;
  }

  /* =====================================================================
     UPDATE DATA: upload SO / DO / forecast
     ===================================================================== */
  const U = { so: null, do: null, fc: null };
  async function readRows(file) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', cellDates: false });
    return { wb, rows: (name) => XLSX.utils.sheet_to_json(wb.Sheets[name || wb.SheetNames[0]], { header: 1, defval: '', raw: true }) };
  }
  // Tanggal dari Excel: angka serial, "2026-10-31", "2026-10-31 06:42:26", "31/10/2026"
  function toDT(v) {
    if (v === '' || v === null || v === undefined) return '';
    if (typeof v === 'number') {
      const ms = Math.round((v - 25569) * 86400000), d = new Date(ms);
      const p = (x) => String(x).padStart(2, '0');
      const s = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
      return v % 1 ? `${s} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : s;
    }
    const t = String(v).trim();
    let m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
    if (m) return m[4] ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : `${m[1]}-${m[2]}-${m[3]}`;
    m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` + (m[4] ? ` ${m[4].padStart(2, '0')}:${m[5]}` : '');
    return '';
  }
  function shiftWib(dt) {
    if (!/\d{2}:\d{2}$/.test(dt)) return dt;
    const d = new Date(dt.replace(' ', 'T') + ':00Z');
    d.setUTCHours(d.getUTCHours() + 7);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  }
  const numOf = (v) => { if (typeof v === 'number') return v; const x = Number(String(v).replace(/\s/g, '').replace(/,(?=\d{3}\b)/g, '')); return isFinite(x) ? x : 0; };
  function findHead(rows, test) {
    for (let i = 0; i < Math.min(rows.length, 15); i++) if (test(rows[i].map((x) => String(x).trim().toLowerCase()))) return i;
    return -1;
  }
  const colOf = (h, fn) => h.findIndex(fn);

  async function parseSO(file) {
    const { rows } = await readRows(file);
    const r = rows();
    const hi = findHead(r, (h) => h.some((x) => x.endsWith('product_uom_qty') || x.endsWith('date_order')));
    let c;
    if (hi >= 0) {
      const h = r[hi].map((x) => String(x).trim().toLowerCase());
      c = {
        date: colOf(h, (x) => x.endsWith('date_order')), dist: colOf(h, (x) => x.endsWith('partner_id')), ref: colOf(h, (x) => x.endsWith('client_order_ref')),
        no: colOf(h, (x) => x.endsWith('order_id/name') || x === 'name' || x.endsWith('order reference')), kode: colOf(h, (x) => x.endsWith('product_id/code') || x.endsWith('default_code')),
        nama: colOf(h, (x) => x.endsWith('product_id/name')), qty: colOf(h, (x) => x.endsWith('product_uom_qty')), price: colOf(h, (x) => x.endsWith('price_unit')),
      };
    } else c = { date: 1, dist: 2, ref: 3, no: 4, kode: 5, nama: 6, qty: 7, price: 8 };   // urutan kolom export Odoo (B..I), seperti VBA
    const miss = Object.entries(c).filter(([k, v]) => v < 0 && k !== 'nama').map(([k]) => k);
    if (miss.length) throw new Error('Kolom tidak ditemukan: ' + miss.join(', ') + '. Pakai export sale.order dari Odoo.');
    const out = [];
    let last = { date: '', dist: '', ref: '', no: '' };
    let bad = 0;
    r.slice(hi + 1).forEach((x) => {
      const kode = String(x[c.kode] || '').trim();
      const no = String(x[c.no] || '').trim();
      if (no && no !== last.no) last = { no, date: toDT(x[c.date]).slice(0, 10), dist: String(x[c.dist] || '').trim(), ref: String(x[c.ref] || '').trim() };
      if (!kode) return;
      const rec = [no || last.no, (toDT(x[c.date]) || last.date).slice(0, 10), String(x[c.dist] || '').trim() || last.dist, String(x[c.ref] || '').trim() || last.ref, kode, c.nama >= 0 ? String(x[c.nama] || '').trim() : '', numOf(x[c.qty]), numOf(x[c.price])];
      if (!rec[0] || !/^\d{4}-\d{2}-\d{2}$/.test(rec[1])) { bad++; return; }
      out.push(rec);
    });
    return { rows: out, bad, file: file.name };
  }
  async function parseDO(file) {
    const { rows } = await readRows(file);
    const r = rows();
    const hi = findHead(r, (h) => h.some((x) => x.endsWith('product_qty') || x === 'date_done'));
    let c;
    if (hi >= 0) {
      const h = r[hi].map((x) => String(x).trim().toLowerCase());
      c = {
        no: colOf(h, (x) => x === 'name' || x === 'reference'), date: colOf(h, (x) => x === 'date_done' || x.endsWith('/date_done')), kode: colOf(h, (x) => x.endsWith('product_id/code')),
        batch: colOf(h, (x) => x.includes('prodlot') || x.includes('lot_id')), qty: colOf(h, (x) => x.endsWith('product_qty') || x.endsWith('quantity_done')),
        so: colOf(h, (x) => x.endsWith('sale_line_id/order_id') || x === 'origin'), st: colOf(h, (x) => x === 'state' || x === 'status'),
      };
    } else c = { no: 1, date: 2, kode: 3, batch: 4, qty: 5, so: 6, st: 7 };
    const miss = Object.entries(c).filter(([k, v]) => v < 0 && k !== 'batch').map(([k]) => k);
    if (miss.length) throw new Error('Kolom tidak ditemukan: ' + miss.join(', ') + '. Pakai export stock.picking.out dari Odoo.');
    const utc = String(P('JAM_ODOO_UTC', '')).toUpperCase() === 'YA';
    const out = [];
    let last = { no: '', date: '', st: '', so: '' };
    r.slice(hi + 1).forEach((x) => {
      const no = String(x[c.no] || '').trim();
      if (no) last = { no, date: toDT(x[c.date]), st: String(x[c.st] || '').trim(), so: String(x[c.so] || '').trim() };
      const kode = String(x[c.kode] || '').trim();
      if (!kode || !last.no) return;
      let dt = no ? last.date : (toDT(x[c.date]) || last.date);
      if (utc) dt = shiftWib(dt);
      out.push([last.no, dt, String(x[c.so] || '').trim() || last.so, kode, c.batch >= 0 ? String(x[c.batch] || '').trim() : '', numOf(x[c.qty]), String(x[c.st] || '').trim() || last.st]);
    });
    return { rows: out, file: file.name, utc };
  }
  function checkSO(p) {
    const nos = new Set(p.rows.map((r) => r[0]));
    const exist = new Set(C.lines.map((L) => L.no));
    const months = [...new Set(p.rows.map((r) => r[1].slice(0, 7)))].sort();
    const unkDist = [...new Set(p.rows.map((r) => r[2]).filter((d) => !C.dist.has(d)))];
    const unkCode = [...new Set(p.rows.map((r) => r[4]).filter((k) => !C.master.has(k)))];
    const amt = sum(p.rows.map((r) => r[6] * r[7]));
    const nEx = [...nos].filter((n) => exist.has(n)).length;
    let html = `<p class="ok">${nf0.format(nos.size)} SO · ${nf0.format(p.rows.length)} baris · ${fRp(amt)} · bulan ${months.map(monShort).join(', ')}${nEx ? ` · ${nf0.format(nEx)} SO sudah ada → diganti` : ''}.</p>`;
    if (p.bad) html += `<p class="err">${p.bad} baris dilewati karena No SO / tanggal kosong.</p>`;
    if (unkDist.length) html += `<p class="warn">Distributor belum ada di DATABASE (region tidak diketahui): ${unkDist.slice(0, 6).map(esc).join('; ')}${unkDist.length > 6 ? ` dan ${unkDist.length - 6} lagi` : ''}.</p>`;
    if (unkCode.length) html += `<p class="warn">Kode belum ada di MASTER_MATERIAL: ${unkCode.slice(0, 10).map(esc).join(', ')}${unkCode.length > 10 ? '…' : ''}.</p>`;
    return html;
  }
  function checkDO(p) {
    const nos = new Set(p.rows.map((r) => r[0]));
    const exist = new Set(C.lines.map((L) => L.no));
    const upSo = U.so ? new Set(U.so.rows.map((r) => r[0])) : new Set();
    const orph = [...new Set(p.rows.map((r) => r[2]).filter((s) => !exist.has(s) && !upSo.has(s)))];
    const st = {};
    p.rows.forEach((r) => { st[r[6] || '(kosong)'] = (st[r[6] || '(kosong)'] || 0) + 1; });
    const dates = p.rows.map((r) => r[1]).filter(Boolean).sort();
    let html = `<p class="ok">${nf0.format(nos.size)} DO · ${nf0.format(p.rows.length)} baris · ${Object.entries(st).map(([k, v]) => `${esc(k)} ${nf0.format(v)}`).join(', ')}${dates.length ? ` · kirim ${fDate(dates[0].slice(0, 10))} – ${fDate(dates[dates.length - 1].slice(0, 10))}` : ''}.</p>`;
    html += p.utc ? '<p class="hint">Jam date_done digeser +7 jam ke WIB (PARAMETER JAM_ODOO_UTC = YA).</p>'
      : String(P('JAM_ODOO_UTC', '')).toUpperCase() !== 'TIDAK' ? '<p class="warn">Zona jam Odoo belum dipastikan (Pengaturan → Jam date_done). Saat ini jam dipakai apa adanya.</p>' : '';
    if (orph.length) html += `<p class="warn">${orph.length} SO belum ada di data (DO-nya tidak akan disimpan): ${orph.slice(0, 8).map(esc).join(', ')}${orph.length > 8 ? '…' : ''}. Upload SO-nya dulu.</p>`;
    return html;
  }
  // Kirim bertahap: tiap bagian berisi SO/DO utuh, maksimal ±4.000 baris
  function chunkBy(rows, keyIdx, max) {
    const groups = new Map();
    rows.forEach((r) => { const k = r[keyIdx]; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
    const out = [];
    let cur = [];
    [...groups.values()].forEach((g) => { if (cur.length && cur.length + g.length > max) { out.push(cur); cur = []; } cur = cur.concat(g); });
    if (cur.length) out.push(cur);
    return out;
  }
  async function sendChunks(kind, p, btn, resEl) {
    const action = kind === 'so' ? 'upsertSO' : 'upsertDO';
    // SO diurutkan per bulan supaya penulisan di Sheet sebagian besar berupa tambahan di bawah
    const rows = p.rows.slice().sort((a, b) => (kind === 'so' ? a[1].localeCompare(b[1]) : 0));
    const parts = chunkBy(rows, kind === 'so' ? 0 : 0, 4000);
    btn.disabled = true;
    let saved = 0;
    const orphans = new Map();
    const t0 = Date.now();
    try {
      for (let i = 0; i < parts.length; i++) {
        resEl.className = 'send-result';
        resEl.textContent = `Menyimpan bagian ${i + 1} dari ${parts.length}… (${Math.round((Date.now() - t0) / 1000)} detik)`;
        const res = await api(action, { rows: parts[i], file: p.file, part: parts.length > 1 ? `bagian ${i + 1}/${parts.length}` : '' });
        saved += res.saved || 0;
        (res.orphans || []).forEach(([k, n]) => orphans.set(k, (orphans.get(k) || 0) + n));
      }
      if (kind === 'do') C.lastOrphans = [...orphans.entries()];
      resEl.className = 'send-result ok';
      resEl.textContent = `Tersimpan ${nf0.format(saved)} baris${orphans.size ? ` · ${orphans.size} SO tidak ditemukan (lihat Pemeriksaan Data → DO tanpa SO)` : ''}. Memuat ulang data…`;
      U[kind] = null;
      await load();
      resEl.textContent = `Tersimpan ${nf0.format(saved)} baris${orphans.size ? ` · ${orphans.size} SO tidak ditemukan` : ''}.`;
      toast(`${kind === 'so' ? 'SO' : 'DO'} tersimpan: ${nf0.format(saved)} baris.`);
    } catch (err) {
      resEl.className = 'send-result err';
      resEl.textContent = `Gagal di bagian berikutnya: ${err.message} — bagian yang sudah tersimpan tetap ada; upload ulang file yang sama aman (data diganti, tidak dobel).`;
      btn.disabled = false;
    }
  }

  // Forecast pcs: BULAN, KODE, (NAMA), R1..R4, ONLINE
  function monthFrom(v) {
    if (typeof v === 'number') return toDT(v).slice(0, 7);
    const t = String(v || '').trim().toUpperCase();
    let m = t.match(/^(\d{4})-(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;
    m = t.match(/([A-Z]+)\s+(\d{4})/);
    if (m) { const i = MON.findIndex((x) => x.toUpperCase().startsWith(m[1].slice(0, 3))); if (i >= 0) return `${m[2]}-${String(i + 1).padStart(2, '0')}`; }
    return '';
  }
  async function parseFc(file) {
    const { wb, rows } = await readRows(file);
    const name = wb.SheetNames.find((n) => /fct|forecast|pcs/i.test(n)) || wb.SheetNames[0];
    const r = rows(name);
    const hi = findHead(r, (h) => h.includes('kode') && (h.includes('r1') || h.includes('online')));
    if (hi < 0) throw new Error('Judul kolom tidak ditemukan. Pakai format: BULAN, KODE, NAMA, R1, R2, R3, R4, ONLINE.');
    const h = r[hi].map((x) => String(x).trim().toUpperCase());
    const ci = { m: h.indexOf('BULAN'), k: h.indexOf('KODE') };
    const regs = REGS.concat(['ONLINE']).map((g) => [g, h.indexOf(g)]).filter((x) => x[1] >= 0);
    const out = [];
    const months = new Set();
    let bad = 0;
    r.slice(hi + 1).forEach((x) => {
      const k = String(x[ci.k] || '').trim();
      if (!k) return;
      const m = ci.m >= 0 ? monthFrom(x[ci.m]) : $('cuTplMonth').value;
      if (!m) { bad++; return; }
      months.add(m);
      regs.forEach(([g, i]) => { const v = numOf(x[i]); if (v) out.push([m, k, g, v]); });
    });
    if (!months.size) throw new Error('Tidak ada baris forecast.');
    return { rows: out, months: [...months].sort(), bad, file: file.name };
  }
  function checkFc(p) {
    const per = {};
    p.rows.forEach((r) => { per[r[2]] = (per[r[2]] || 0) + r[3]; });
    const unk = [...new Set(p.rows.map((r) => r[1]).filter((k) => !C.master.has(k)))];
    let html = `<p class="ok">${p.months.map(monLabel).join(', ')} · ${nf0.format(new Set(p.rows.map((r) => r[1])).size)} SKU · ${REGS.concat(['ONLINE']).map((g) => `${g} ${nf0.format(per[g] || 0)}`).join(' · ')} pcs. Forecast bulan tersebut diganti seluruhnya.</p>`;
    if (p.bad) html += `<p class="err">${p.bad} baris tanpa BULAN yang valid dilewati.</p>`;
    if (unk.length) html += `<p class="warn">Kode belum ada di MASTER_MATERIAL: ${unk.slice(0, 10).map(esc).join(', ')}${unk.length > 10 ? '…' : ''}.</p>`;
    return html;
  }
  function downloadFcTpl() {
    const m = $('cuTplMonth').value;
    const from = addMonth(m, -12);
    const codes = [...C.A.codes].filter((k) => C.A.soList.some((x) => x >= from && skuV(x, k, 'ALL', 'so')) || fctOf(m, k, 'ALL')).sort();
    const aoa = [['BULAN', 'KODE', 'NAMA', 'R1', 'R2', 'R3', 'R4', 'ONLINE']]
      .concat(codes.map((k) => [m, k, nameOf(k)].concat(REGS.concat(['ONLINE']).map((g) => C.fct.get(`${m}|${k}|${g}`) || ''))));
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 9 }, { wch: 10 }, { wch: 60 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, ws, 'FCT PCS');
    XLSX.writeFile(wb, `Format_Forecast_${m}.xlsx`);
  }
  function bindFile(inp, nameEl, checkEl, sendBtn, resEl, kind, parser, checker) {
    $(inp).addEventListener('change', async () => {
      const f = $(inp).files[0];
      $(resEl).textContent = '';
      if (!f) return;
      $(nameEl).textContent = f.name;
      $(checkEl).innerHTML = '<p>Membaca file…</p>';
      $(sendBtn).disabled = true;
      try {
        const p = await parser(f);
        U[kind] = p;
        $(checkEl).innerHTML = checker(p);
        $(sendBtn).disabled = !p.rows.length;
      } catch (err) {
        U[kind] = null;
        $(checkEl).innerHTML = `<p class="err">${esc(err.message)}</p>`;
      }
      $(inp).value = '';
    });
  }
  function renderUpdate() {
    const opts = [...new Set(C.A.monthsAll.concat([curMonth(), addMonth(curMonth(), 1), addMonth(curMonth(), 2)]))].sort().reverse();
    fillSel($('cuTplMonth'), opts.map((m) => [m, monLabel(m)]), addMonth(curMonth(), 1));
    const utc = String(P('JAM_ODOO_UTC', '')).toUpperCase();
    const last = (a) => (C.log.find((r) => r[1] === a) || [])[0];
    $('cuParams').innerHTML = `
      <label class="field"><span>Jam <em>date_done</em> di export DO</span><select data-param="JAM_ODOO_UTC">
        <option value="BELUM DICEK"${utc !== 'YA' && utc !== 'TIDAK' ? ' selected' : ''}>Belum dicek (dipakai apa adanya)</option>
        <option value="YA"${utc === 'YA' ? ' selected' : ''}>UTC — geser +7 jam ke WIB</option>
        <option value="TIDAK"${utc === 'TIDAK' ? ' selected' : ''}>Sudah WIB</option></select></label>
      <label class="field"><span>DO Cancelled</span><select data-param="CANCEL_SISA">
        <option value="TIDAK"${!C.cancelSisa ? ' selected' : ''}>Dipisah (tidak dihitung sisa)</option>
        <option value="YA"${C.cancelSisa ? ' selected' : ''}>Dihitung sisa SO (seperti Excel lama)</option></select></label>
      <label class="field"><span>Target CSL (%)</span><input type="number" min="0" max="200" step="0.1" data-param="TARGET_CSL" value="${nf2.format(pNum('TARGET_CSL', 1) * 100).replace(',', '.')}"></label>
      <dl class="csl-dl"><div><dt>Upload SO terakhir</dt><dd>${esc(last('Upload SO') || '–')}</dd></div><div><dt>Upload DO terakhir</dt><dd>${esc(last('Upload DO') || '–')}</dd></div>
      <div><dt>SO tersimpan</dt><dd>${nf0.format(C.lines.length)} baris · ${C.A.soList.length} bulan</dd></div><div><dt>Data sampai</dt><dd>SO ${fDate(C.A.lastSo)} · DO ${fDate(C.A.lastDo)}</dd></div></dl>`;
    $('cuLog').innerHTML = C.log.map((r) => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td><td class="num">${isNum(r[3]) ? nf0.format(r[3]) : ''}</td><td>${esc(r[4])}</td></tr>`).join('') || '<tr><td colspan="5" class="csl-empty">Belum ada riwayat.</td></tr>';
  }

  /* =====================================================================
     Beranda, info, routing
     ===================================================================== */
  function renderHome() {
    if (!$('hCsl')) return;
    if (!C.loaded || !C.A || !C.A.soList.length) return;
    const m = lastSoMonth(), a = csl(m, 'ALL');
    $('hCslLbl').textContent = `CSL ${monLabel(m)}`;
    $('hCsl').textContent = fPct(a.csl);
    $('hCslOs').textContent = fPct(a.cslOs);
    $('hCslSisa').textContent = fBig(sum(C.lines.map((L) => L.sisaQ * L.price)));
    paintBadge();
  }
  function renderInfo() {
    const el = $('dataInfo'); if (!el) return;
    if (!C.loaded) { el.textContent = C.err ? 'Data CSL belum termuat' : 'Memuat data CSL…'; return; }
    el.textContent = `Dibaca dari CSL PPIC GTK ${String(C.readAt).slice(0, 16)} · SO s/d ${fDate(C.A.lastSo)} · DO s/d ${fDate(C.A.lastDo)} · ${nf0.format(C.lines.length)} baris SO`;
  }
  const RENDER = {
    'csl/dashboard': renderDash, 'csl/region': renderRegion, 'csl/sku': renderSku, 'csl/os': renderOs, 'csl/weekly': renderWeekly,
    'csl/analisa': renderAnalisa, 'csl/suggest': renderSuggest, 'csl/musim': renderMusim, 'csl/update': renderUpdate, 'csl/cek': renderCek,
  };
  function render(key) {
    renderInfo();
    if (!C.loaded) { paintLoading(); return; }
    const f = RENDER[key];
    if (!f) return;
    try { f(); } catch (err) { console.error(err); toast('Gagal menampilkan halaman: ' + err.message); }
  }
  function enter(key) {
    C.route = key;
    const lnk = $('lnkSheet');
    if (lnk && (C.sheetUrl || CFG.CSL_SHEET_URL)) { lnk.hidden = false; lnk.href = C.sheetUrl || CFG.CSL_SHEET_URL; }
    if (!C.loaded && !C.loading) { load(); }
    paintLoading();
    render(key);
  }

  /* ---------- Event ---------- */
  const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
  const rerender = () => render(C.route);
  ['cdMonth', 'cdPeriod', 'cdOs', 'crPeriod', 'crView', 'csGrp', 'csEnd', 'csSpan', 'coGrp', 'coMode', 'cwMonth', 'cwMode', 'caGrp', 'caMonth', 'cgMode', 'cgCols', 'cgGrp', 'cgMonth', 'cgAll', 'cmGrp', 'cmYear']
    .forEach((id) => on(id, 'change', rerender));
  let qT;
  ['csQ', 'coQ', 'cwQ', 'caQ', 'cgQ'].forEach((id) => on(id, 'input', () => { clearTimeout(qT); qT = setTimeout(rerender, 200); }));
  on('cdGrp', 'click', (e) => { const b = e.target.closest('[data-g]'); if (!b) return; D.grp = b.dataset.g; renderDash(); });
  on('crTable', 'click', (e) => { const tr = e.target.closest('tr[data-m]'); if (tr) openNilai(tr.dataset.m); });
  on('crNilai', 'click', () => openNilai(curMonth()));
  on('crExport', 'click', () => {
    const months = periodMonths($('crPeriod').value);
    const head = ['BULAN'].concat(...REGS.map((g) => [`${g} FCT`, `${g} SO`, `${g} DO`]), ['GTK FCT', 'GTK SO', 'GTK DO', 'GTK CSL', 'ONLINE FCT', 'ONLINE SO', 'ONLINE DO', 'ONLINE CSL', 'TOTAL FCT', 'TOTAL SO', 'TOTAL DO', 'TOTAL CSL']);
    toExcel('Review_Region', [['Review Region', [head].concat(months.map((m) => {
      const r = regionRow(m), b = (x) => [Math.round(x.fct), Math.round(x.so), Math.round(x.dos)];
      return [m].concat(...REGS.map((g) => b(r[g])), b(r.GTK), [ratio(r.GTK.dos, r.GTK.so) || ''], b(r.ONLINE), [ratio(r.ONLINE.dos, r.ONLINE.so) || ''], b(r.TOTAL), [ratio(r.TOTAL.dos, r.TOTAL.so) || '']);
    }))]]);
  });
  on('csExport', 'click', () => {
    const g = $('csGrp').value, months = skuMonths(), rows = skuRows(g, months, $('csQ').value.trim());
    toExcel(`Rekap_SKU_${g}`, [['Rekap SKU', [['KODE', 'NAMA'].concat(...months.map((m) => [`${m} FCT`, `${m} SO`, `${m} DO`, `${m} DO-OS`]))]
      .concat(rows.map((r) => [r.k, r.n].concat(...r.v.map((x) => [x.fct, x.so, x.do, x.os]))))]]);
  });
  on('coCancel', 'change', () => { C.cancelSisa = $('coCancel').checked; compute(); renderOs(); renderHome(); });
  on('coExport', 'click', () => {
    const ls = osLines($('coGrp').value, $('coQ').value.trim());
    toExcel('Sisa_SO', [['Sisa SO', [['NO SO', 'TANGGAL', 'DISTRIBUTOR', 'REGION', 'KODE', 'NAMA', 'QTY SO', 'TERKIRIM', 'SISA', 'CANCELLED', 'SISA RP']]
      .concat(ls.map((L) => [L.no, L.date, L.dist, L.region, L.kode, nameOf(L.kode), L.qty, L.doQ + L.osQ, L.sisaQ, L.canQ, Math.round(L.sisaQ * L.price)]))]]);
  });
  on('cwExport', 'click', exportWeekly);
  on('caWin', 'click', (e) => {
    const b = e.target.closest('[data-m]'); if (!b || b.disabled) return;
    const g = $('caGrp').value, s = C.excl[g];
    if (s.has(b.dataset.m)) s.delete(b.dataset.m); else s.add(b.dataset.m);
    renderAnalisa();
  });
  on('caTable', 'click', (e) => { const tr = e.target.closest('tr[data-k]'); if (tr) openStat(tr.dataset.k); });
  on('caExport', 'click', () => {
    const a = C.anLast; if (!a) return;
    toExcel(`Analisa_${a.g}_${a.target}`, [['Analisa', [['KODE', 'NAMA', 'AVG SO', 'STDEV', 'BIAS', 'MAD', 'MAPE', 'AVG >0', 'STDEV >0', '-2σ', '-1σ', '1σ', '2σ', 'BIAS >0', 'MAD >0', 'MAPE >0', 'ADI', 'CV', 'CV²', 'MAX', 'MIN', 'TIPE', 'SAFETY STOCK']]
      .concat(a.st.map((s) => [s.kode, nameOf(s.kode), s.ce, s.cb, s.ch, s.ci, s.cj, s.cp, s.cm, s.cn, s.co, s.cq, s.cr, s.cs, s.ct, s.cu, s.adi, s.cw, s.cx, s.cy, s.cz, s.type, s.ss])),
      ], ['FCT vs SO', [['KODE', 'NAMA'].concat(...a.W.map((m) => [`${m} FCT`, `${m} SO`]))].concat(a.st.map((s) => [s.kode, nameOf(s.kode)].concat(...a.W.map((m, i) => [s.fc[i], s.so[i]]))))]]);
  });
  on('cgExport', 'click', exportSuggest);
  on('cmBody', 'click', (e) => { const b = e.target.closest('[data-season]'); if (b) editSeason(b.dataset.season); });
  on('ckTabs', 'click', (e) => { const b = e.target.closest('[data-t]'); if (!b) return; CK.tab = b.dataset.t; renderCek(); });

  bindFile('cuSoFile', 'cuSoName', 'cuSoCheck', 'cuSoSend', 'cuSoResult', 'so', parseSO, checkSO);
  bindFile('cuDoFile', 'cuDoName', 'cuDoCheck', 'cuDoSend', 'cuDoResult', 'do', parseDO, checkDO);
  bindFile('cuFcFile', 'cuFcName', 'cuFcCheck', 'cuFcSend', 'cuFcResult', 'fc', parseFc, checkFc);
  on('cuSoSend', 'click', () => { if (U.so) sendChunks('so', U.so, $('cuSoSend'), $('cuSoResult')); });
  on('cuDoSend', 'click', () => { if (U.do) sendChunks('do', U.do, $('cuDoSend'), $('cuDoResult')); });
  on('cuFcSend', 'click', async () => {
    const p = U.fc; if (!p) return;
    const btn = $('cuFcSend'), res = $('cuFcResult');
    btn.disabled = true; res.className = 'send-result'; res.textContent = 'Menyimpan…';
    try {
      const d = await api('saveFct', { months: p.months, rows: p.rows, file: p.file });
      setFct(d.fct || []); aggregate();
      res.className = 'send-result ok'; res.textContent = `Tersimpan ${nf0.format(d.saved)} baris forecast.`;
      U.fc = null;
      toast('Forecast tersimpan.');
    } catch (err) { res.className = 'send-result err'; res.textContent = err.message; btn.disabled = false; }
  });
  on('cuTpl', 'click', downloadFcTpl);
  on('cuParams', 'change', async (e) => {
    const el = e.target.closest('[data-param]'); if (!el) return;
    const key = el.dataset.param;
    let value = el.value;
    if (key === 'TARGET_CSL') { const v = Number(value); if (!isFinite(v) || v <= 0) { toast('Isi target CSL yang valid.'); return; } value = v / 100; }
    el.disabled = true;
    try {
      const res = await api('saveParam', { key, value });
      C.paramRows = res.params; C.P = {}; C.paramRows.forEach((r) => { C.P[r[0]] = r[1]; });
      if (key === 'CANCEL_SISA') { C.cancelSisa = value === 'YA'; compute(); }
      toast('Pengaturan tersimpan.');
      renderUpdate(); renderHome();
    } catch (err) { toast(err.message); }
    el.disabled = false;
  });
  on('cuReset', 'click', () => { C.loaded = false; load({ reset: true }); });

  window.CSL = {
    enter, reload: () => load(), sheetUrl: () => C.sheetUrl || CFG.CSL_SHEET_URL || '',
    _state: C, _sug: sugRow, _stats: statsOf,
  };
  // Halaman CSL dibuka langsung lewat alamat; selain itu muat di belakang untuk angka Beranda
  const k0 = location.hash.replace(/^#\/?/, '');
  if (k0.startsWith('csl/')) enter(k0);
  else if (CFG.CSL_SCRIPT_URL) setTimeout(() => { if (!C.loaded && !C.loading) load(); }, 3000);
})();
