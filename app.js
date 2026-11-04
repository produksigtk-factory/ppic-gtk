/* Monitoring PO — PPIC GTK
 * Membaca PO_LINE + PO_SCHEDULE dari Apps Script, menghitung status di browser,
 * dan mengirim hasil upload PO-DET / PO-DEL kembali ke Google Sheet.
 */
(function () {
  'use strict';

  const CFG = window.PPIC_CONFIG || {};
  const PAGE = 100;
  const $ = (id) => document.getElementById(id);

  const state = {
    rows: [],          // baris PO yang sudah dihitung
    knownPOs: new Set(),
    status: 'all',
    month: null,       // 'yyyy-mm' atau 'all'; null = bulan berjalan
    raw: { lines: [], schedules: [] },
    manual: new Map(),
    editLog: [],
    edit: { on: false, user: 'Website', pin: '' },
    follow: new Map(),   // PO|kode → { status, promise, note, time }
    changes: [],
    sup: { rows: [], loaded: false, view: 'all', shown: 100, dbUrl: '', nSup: new Map() },   // Apps Script mewajibkan isian user; nama pengedit tidak dipakai
    shown: PAGE,
    openKey: null,
    parsedDet: null,
    parsedDel: null,
  };

  /* ---------- Format ---------- */
  const nf = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 3 });
  const fmtNum = (v) => (v === '' || v === null || v === undefined || isNaN(v) ? '–' : nf.format(v));
  const df = new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: 'short', year: '2-digit' });
  const fmtDate = (s) => {
    if (!s) return '–';
    const [y, m, d] = s.split('-').map(Number);
    return df.format(new Date(y, m - 1, d));
  };
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const todayStr = () => ymd(new Date()); // yyyy-mm-dd, zona waktu perangkat
  // Tanggal dari Apps Script bisa "2026-11-03" atau teks panjang "Tue Nov 03 2026 00:00:00 GMT+0700"
  const normDate = (v) => {
    const s = String(v ?? '').trim();
    if (!s) return '';
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    const d = new Date(s);
    return isNaN(d) ? '' : ymd(d);
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const STATUS = {
    done: { label: 'Lengkap', cls: 'b-done' },
    late: { label: 'Terlambat', cls: 'b-late' },
    short: { label: 'Kurang kirim', cls: 'b-late' },
    wait: { label: 'Dijadwalkan', cls: 'b-wait' },
    none: { label: 'Belum dijadwalkan', cls: 'b-none' },
  };


  /* ---------- Urutkan lewat judul kolom (semua tabel) ---------- */
  // Klik pertama: arah bawaan kolom; klik kedua: dibalik; klik ketiga: kembali ke urutan semula.
  const colSort = { po: null, sup: null, act: null, log: null, chg: null };
  const DESC_FIRST = new Set(['qty', 'sisa', 'shortage', 'nsched', 'moq', 'max', 'count', 'total', 'price', 'lead', 'lateDays', 'shortValue', '0']);
  const isBlankV = (v) => v === null || v === undefined || v === '' || (typeof v === 'number' && isNaN(v));
  function applyColSort(rows, cs, getters) {
    if (!cs) return rows;
    const g = getters[cs.k] || ((r) => r[cs.k]);
    const sign = cs.dir === 'asc' ? 1 : -1;
    return rows.slice().sort((a, b) => {
      const x = g(a), y = g(b), bx = isBlankV(x), by = isBlankV(y);
      if (bx || by) return bx === by ? 0 : bx ? 1 : -1;            // kosong selalu di bawah
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'id', { numeric: true, sensitivity: 'base' });
      return c * sign;
    });
  }
  function initSortHeaders(table, name, onChange) {
    table.querySelectorAll('th[data-sk]').forEach((th) => {
      th.innerHTML = `<button type="button" class="th-sort" title="Klik untuk mengurutkan">${th.innerHTML}<span class="sort-ind" aria-hidden="true"></span></button>`;
    });
    table.querySelector('thead').addEventListener('click', (e) => {
      const th = e.target.closest('th[data-sk]'); if (!th) return;
      const k = th.dataset.sk, cur = colSort[name];
      if (!cur || cur.k !== k) colSort[name] = { k, dir: DESC_FIRST.has(k) ? 'desc' : 'asc' };
      else if (cur.dir === (DESC_FIRST.has(k) ? 'desc' : 'asc')) colSort[name] = { k, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
      else colSort[name] = null;
      onChange();
    });
  }
  function paintSortHeaders(table, name) {
    const cs = colSort[name];
    table.querySelectorAll('th[data-sk]').forEach((th) => {
      const on = cs && cs.k === th.dataset.sk;
      if (on) th.setAttribute('aria-sort', cs.dir === 'asc' ? 'ascending' : 'descending'); else th.removeAttribute('aria-sort');
      th.classList.toggle('is-sorted', !!on);
    });
  }
  const STATUS_ORDER = { late: 0, short: 1, wait: 2, none: 3, done: 4 };
  const PO_GET = {
    po: (r) => r.po, date: (r) => r.date, supplier: (r) => r.supplier, name: (r) => r.name, qty: (r) => r.qty,
    sisa: (r) => Math.max(0, r.sisa), shortage: (r) => r.shortage || null, nsched: (r) => r.sched.length,
    next: (r) => (r.next ? r.next.date : null), status: (r) => STATUS_ORDER[r.status],
    follow: (r) => (r.follow ? ({ Eskalasi: 0, 'Belum dihubungi': 1, 'Sudah dihubungi': 2, Selesai: 3 })[r.follow.status] : (r.shortage > 0 ? 1 : null)),
  };
  const SUP_GET = {
    name: (x) => x.name, supplier: (x) => x.supplier || null, moq: (x) => x.moq, max: (x) => x.max,
    count: (x) => (x.supplier ? x.count : null), total: (x) => (x.count ? x.total : null), lastDate: (x) => x.lastDate || null,
    price: (x) => (x.price === '' || x.price === null ? null : Number(x.price)), lead: (x) => x.lead,
  };


  /* ---------- Saringan jenis bawaan: RM dan PM ---------- */
  // Setiap membuka website, Monitoring PO, Dashboard, Kalender, dan Beranda menampilkan RM dan PM saja.
  const RMPM = '__RMPM';
  const RMPM_SET = new Set(['RM (Raw)', 'PM (Pack)']);
  const jenisOk = (r, v) => !v || (v === RMPM ? RMPM_SET.has(r.jenis) : r.jenis === v);
  const jenisLabel = (v) => (v === RMPM ? 'RM dan PM' : v);
  function fillJenis(sel, list) {
    const cur = sel.dataset.ready ? sel.value : RMPM;
    sel.innerHTML = `<option value="${RMPM}">RM dan PM</option><option value="">Semua jenis</option>` + list.map((v) => `<option>${esc(v)}</option>`).join('');
    sel.value = cur === RMPM || cur === '' || list.includes(cur) ? cur : RMPM;
    sel.dataset.ready = '1';
  }

  /* ---------- Menu & halaman ---------- */
  // Menu baru cukup ditambah di sini + <section id="view-..."> di index.html + link di menu samping.
  const ROUTES = {
    // actions: 'po' / 'sup' = tampilkan tombol Mode edit, Muat ulang, Buka Google Sheet untuk modul itu
    'beranda':           { view: 'view-beranda',           crumb: 'Monitoring Pekerjaan PPIC', title: 'Beranda',         actions: '' },
    'po/dashboard':      { view: 'view-po-dashboard',      crumb: 'Purchase Order',            title: 'Dashboard PO',    actions: 'po' },
    'po/kalender':       { view: 'view-po-kalender',       crumb: 'Purchase Order',            title: 'Kalender Kedatangan', actions: 'po' },
    'po/perubahan':      { view: 'view-po-perubahan',      crumb: 'Purchase Order',            title: 'Perubahan Data',  actions: 'po' },
    'po/monitoring':     { view: 'view-po-monitoring',     crumb: 'Purchase Order',            title: 'Monitoring PO',   actions: 'po' },
    'po/update':         { view: 'view-po-update',         crumb: 'Purchase Order',            title: 'Update Data PO',  actions: 'po' },
    'po/riwayat':        { view: 'view-po-riwayat',        crumb: 'Purchase Order',            title: 'Riwayat Edit PO', actions: 'po' },
    'po/supplier':       { view: 'view-po-supplier',       crumb: 'Purchase Order',            title: 'Supplier & MoQ',  actions: 'sup' },
  };
  function route() {
    let key = location.hash.replace(/^#\/?/, '') || 'beranda';
    if (key === 'material/supplier') key = 'po/supplier';   // alamat lama
    const r = ROUTES[key] || ROUTES.beranda;
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== r.view; });
    document.querySelectorAll('.menu-item').forEach((a) => {
      const on = a.dataset.route === (ROUTES[key] ? key : 'beranda');
      a.classList.toggle('is-active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    $('crumb').textContent = r.crumb;
    $('pageTitle').textContent = r.title;
    state.route = r;
    $('poActions').hidden = !r.actions;
    $('btnEditMode').hidden = r.actions === 'sup';
    const sheet = r.actions === 'sup' ? (state.sup.dbUrl || CFG.DATABASE_URL) : CFG.SHEET_URL;
    $('lnkSheet').hidden = !sheet;
    if (sheet) $('lnkSheet').href = sheet;
    $('lnkSheet').title = r.actions === 'sup' ? 'Buka Google Sheet DATABASE PPIC (tab SUPPLIER_MATERIAL) di tab baru' : 'Buka Google Sheet MONITORING PO di tab baru';
    $('btnReload').title = r.actions === 'sup' ? 'Hitung ulang daftar supplier dari data PO terbaru dan isian MoQ' : 'Ambil ulang data terbaru dari Google Sheet MONITORING PO';
    document.title = `${r.title} · PPIC Gondowangi`;
    renderFresh();
    closeMenu();
    window.scrollTo(0, 0);
  }
  // ---------- Peringatan data basi ----------
  // Dihitung dalam hari kerja (Senin–Jumat) sejak upload terakhir lewat website.
  // 0–1 hari kerja = terkini, 2 = kuning, 3 atau lebih / belum pernah = merah.
  const FRESH_WARN = 2, FRESH_LATE = 3;
  function workdaysSince(ymdStr) {
    const d = new Date(ymdStr + 'T00:00:00'), t = new Date(todayStr() + 'T00:00:00');
    let n = 0;
    for (d.setDate(d.getDate() + 1); d <= t; d.setDate(d.getDate() + 1)) {
      const w = d.getDay();
      if (w !== 0 && w !== 6) n++;
    }
    return n;
  }
  function renderFresh() {
    const box = $('fresh');
    if (!box) return;
    const r = state.route;
    const show = state.freshLoaded && r && (r.actions || r.view === 'view-beranda');
    box.hidden = !show;
    if (!show) return;
    const up = state.lastUpload;
    let level, title, note;
    if (!up || !up.time) {
      level = 'late';
      title = 'Belum ada upload lewat website.';
      note = 'Catatan perubahan dan ketepatan kirim baru terisi setelah export Odoo di-upload di menu Update Data PO.';
    } else {
      const date = String(up.time).slice(0, 10), clock = String(up.time).slice(11, 16);
      const n = workdaysSince(date);
      const when = date === todayStr() ? `hari ini ${clock}` : `${fmtDate(date)} ${clock}`;
      if (n >= FRESH_LATE) {
        level = 'late';
        title = `Data PO sudah ${n} hari kerja tidak diperbarui.`;
        note = `Upload terakhir ${when}. Status, shortage, dan kalender bisa sudah tidak sesuai Odoo.`;
      } else if (n >= FRESH_WARN) {
        level = 'warn';
        title = `Data PO terakhir diperbarui ${n} hari kerja lalu.`;
        note = `Upload terakhir ${when}. Sebaiknya upload export Odoo terbaru.`;
      } else {
        level = 'ok';
        title = 'Data PO terkini.';
        note = `Upload terakhir ${when}.`;
      }
    }
    box.className = `fresh is-${level}${r.view === 'view-po-update' ? ' on-update' : ''}`;
    $('freshTitle').textContent = title;
    $('freshNote').textContent = note;
  }

  window.addEventListener('hashchange', route);

  document.querySelectorAll('.menu-group-head').forEach((h) => h.addEventListener('click', () => {
    const g = h.closest('.menu-group');
    g.classList.toggle('is-open');
    h.setAttribute('aria-expanded', g.classList.contains('is-open'));
  }));

  // Menu samping di layar kecil
  function openMenu() { $('sidebar').classList.add('is-open'); $('scrim').hidden = false; $('btnMenu').setAttribute('aria-expanded', 'true'); }
  function closeMenu() { $('sidebar').classList.remove('is-open'); $('scrim').hidden = true; $('btnMenu').setAttribute('aria-expanded', 'false'); }
  $('btnMenu').addEventListener('click', () => ($('sidebar').classList.contains('is-open') ? closeMenu() : openMenu()));
  $('scrim').addEventListener('click', closeMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  function renderHome() {
    const rows = state.rows.filter((r) => RMPM_SET.has(r.jenis));
    const today = todayStr();
    const plus7 = ymd(new Date(Date.now() + 7 * 86400000));
    let week = 0;
    const seen = new Set();
    rows.forEach((r) => {
      const k = r.po + '|' + r.code;
      if (r.status === 'done' || seen.has(k)) return; seen.add(k);
      r.sched.forEach((s) => { if (s.status !== 'Done' && s.date >= today && s.date <= plus7) week++; });
    });
    $('hOpen').textContent = nf.format(rows.filter((r) => r.status !== 'done').length);
    $('hLate').textContent = nf.format(rows.filter((r) => r.shortage > 0).length);
    $('hWeek').textContent = nf.format(week);
  }


  /* ---------- Ambil data ---------- */
  async function loadData() {
    if (!CFG.APPS_SCRIPT_URL) { showSetup(); return; }
    $('dataInfo').textContent = 'Memuat data dari Google Sheet…';
    $('btnReload').disabled = true;
    if (!state.rows.length) $('rows').innerHTML = '<tr class="empty"><td colspan="10">Memuat data dari Google Sheet, biasanya 5–10 detik…</td></tr>';
    try {
      const res = await fetch(CFG.APPS_SCRIPT_URL, { method: 'GET' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Respon tidak valid');
      state.raw = { lines: data.lines, schedules: data.schedules };
      setManual(data.manual);
      state.editLog = data.editLog || [];
      setFollow(data.followups);
      state.changes = data.changes || [];
      state.noFollowScript = !Array.isArray(data.followups);
      if (!Array.isArray(data.manual)) state.oldScript = true;   // Apps Script versi lama (belum mendukung edit)
      state.lastUpload = data.lastUpload || null;
      state.freshLoaded = true;
      renderFresh();
      const up = data.lastUpload ? `Upload terakhir ${data.lastUpload.time}` : 'Belum ada upload lewat website';
      $('dataInfo').textContent = `${up} · Data dibaca ${data.readAt}`;
      refreshAll();
    } catch (err) {
      $('dataInfo').textContent = 'Gagal memuat data. Periksa koneksi lalu tekan "Muat ulang data".';
      $('rows').innerHTML = `<tr class="empty"><td colspan="10">Data tidak bisa dimuat: ${esc(err.message)}</td></tr>`;
    } finally {
      $('btnReload').disabled = false;
    }
  }

  function showSetup() {
    $('dataInfo').textContent = 'Website belum terhubung ke Google Sheet';
    const n = $('setupNote');
    n.hidden = false;
    n.innerHTML = `<h2>Website belum terhubung ke Google Sheet MONITORING PO</h2>
      <p>Pasang Apps Script penghubung satu kali, lalu kirim alamat Web App-nya agar dimasukkan ke website.</p>`;
    $('rows').innerHTML = '<tr class="empty"><td colspan="10">Data akan tampil di sini setelah website terhubung.</td></tr>';
    $('btnReload').disabled = true;
  }

  // Tanda PO yang pernah diedit manual: Map po → { lines, sched, time, by }
  function setFollow(list) {
    state.follow = new Map((list || []).map((f) => [f[0] + '|' + f[1], { status: f[2], promise: normDate(f[3]), note: f[4], time: f[5] }]));
  }

  function setManual(list) {
    state.manual = new Map((list || []).map((m) => [m[0], { lines: !!m[1], sched: !!m[2], time: m[3], by: m[4] }]));
  }

  function refreshAll() {
    buildRows(state.raw.lines, state.raw.schedules);
    fillFilterOptions();
    render();
    renderHome();
    renderDash();
    renderChanges();
    renderCal();
    renderLog();
  }

  // Hasil simpan/hapus dari Apps Script: ganti data PO yang berubah saja, tanpa memuat ulang semuanya
  function applyServerUpdate(res) {
    const pos = new Set(res.pos || []);
    state.raw.lines = state.raw.lines.filter((l) => !pos.has(l[0])).concat(res.lines || []);
    state.raw.schedules = state.raw.schedules.filter((s) => !pos.has(s[0])).concat(res.schedules || []);
    setManual(res.manual);
    state.editLog = res.editLog || state.editLog;
    refreshAll();
  }

  /* ---------- Hitung status per baris ---------- */
  function buildRows(lines, schedules) {
    const today = todayStr();
    const schedBy = new Map();
    schedules.forEach((s) => {
      const k = s[0] + '|' + s[1];
      if (!schedBy.has(k)) schedBy.set(k, []);
      schedBy.get(k).push({ n: s[3], qty: s[4], rec: s[5], date: normDate(s[6]), status: s[7], name: s[2] });
    });
    schedBy.forEach((list) => list.sort((a, b) => a.n - b.n));

    const groups = new Map();
    lines.forEach((l, idx) => {
      const k = l[0] + '|' + l[3];
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push({ idx, l });
    });

    const rows = [];
    groups.forEach((items, k) => {
      items.sort((a, b) => a.l[10] - b.l[10]);
      const sched = schedBy.get(k) || [];
      const totalRec = sched.reduce((t, s) => t + (Number(s.rec) || 0), 0);
      const pending = sched.filter((s) => s.status !== 'Done');
      const hasLate = pending.some((s) => s.date && s.date < today);
      const next = pending.filter((s) => s.date).sort((a, b) => (a.date < b.date ? -1 : 1))[0] || null;
      let remain = totalRec;

      // Shortage = qty yang seharusnya sudah datang (jadwal belum Done & tanggal sudah lewat) tetapi belum diterima,
      // ditambah kurang kirim pada jadwal yang sudah Done. Dihitung per PO + kode, dicatat di baris pertama.
      let shortage = 0, oldest = '';
      sched.forEach((s) => {
        const gap = Math.max(0, (Number(s.qty) || 0) - (Number(s.rec) || 0));
        if (!gap) return;
        const overdue = s.status !== 'Done' && s.date && s.date < today;
        if (overdue || s.status === 'Done') {
          shortage += gap; s.short = gap;
          if (s.date && (!oldest || s.date < oldest)) oldest = s.date;
        }
      });
      const lateDays = oldest ? Math.round((new Date(today) - new Date(oldest)) / 86400000) : 0;
      let shortRemain = shortage;   // dibagi berurutan ke baris kode yang sama, seperti qty diterima

      items.forEach(({ idx, l }, i) => {
        const qty = Number(l[6]) || 0;
        const isLast = i === items.length - 1;
        const rec = isLast ? remain : Math.min(qty, remain);   // penerimaan dibagi berurutan ke baris kode yang sama
        remain -= rec;
        const sisa = qty - rec;
        let status;
        if (qty > 0 && sisa <= 0) status = 'done';
        else if (hasLate) status = 'late';
        else if (shortage > 0) status = 'short';
        else if (pending.length) status = 'wait';
        else status = 'none';
        const short = isLast ? shortRemain : Math.min(Math.max(0, sisa), shortRemain);
        shortRemain -= short;
        const price = l[8] === '' ? 0 : Number(l[8]);

        const date = normDate(l[1]);
        rows.push({
          key: k + '|' + l[10], idx,
          po: l[0], date, month: date.slice(0, 7), supplier: l[2], code: l[3], name: l[4], jenis: l[5],
          qty, uom: l[7], price: l[8], kurs: l[9], lineKe: l[10], dupCount: items.length,
          amount: l[8] === '' ? 0 : qty * Number(l[8]),
          pendingDates: pending.map((s) => s.date).filter(Boolean),
          manual: state.manual ? state.manual.get(l[0]) || null : null,
          follow: state.follow ? state.follow.get(k) || null : null,
          rec, sisa, status, sched, next, today, first: i === 0,
          shortage: short, lateDays: short ? lateDays : 0, oldestLate: short ? oldest : '',
          sisaValue: Math.max(0, sisa) * price, shortValue: short * price,
          search: (l[0] + ' ' + l[2] + ' ' + l[3] + ' ' + l[4]).toLowerCase(),
        });
      });
    });

    // Order date terlama di atas; tanggal sama → No PO kecil di atas; urutan baris asli dalam satu PO
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.po < b.po ? -1 : a.po > b.po ? 1 : a.idx - b.idx));
    state.rows = rows;
    state.knownPOs = new Set(lines.map((l) => l[0]));
  }

  /* ---------- Saringan ---------- */
  function fillFilterOptions() {
    const fill = (sel, values, first) => {
      const cur = sel.value;
      sel.innerHTML = `<option value="">${first}</option>` + values.map((v) => `<option>${esc(v)}</option>`).join('');
      sel.value = values.includes(cur) ? cur : '';
    };
    const uniq = (f) => [...new Set(state.rows.map(f).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'id'));
    fillJenis($('fJenis'), uniq((r) => r.jenis));
    fill($('fSupplier'), uniq((r) => r.supplier), 'Semua supplier');
    fill($('fKurs'), uniq((r) => r.kurs), 'Semua kurs');
  }

  const curMonth = () => todayStr().slice(0, 7);
  const activeMonth = () => state.month || curMonth();
  const mf = new Intl.DateTimeFormat('id-ID', { month: 'short', year: 'numeric' });
  const mfLong = new Intl.DateTimeFormat('id-ID', { month: 'long', year: 'numeric' });
  const monthLabel = (m, long) => { const [y, mo] = m.split('-').map(Number); return (long ? mfLong : mf).format(new Date(y, mo - 1, 1)); };

  const ARRIVE = {
    today: 'Dijadwalkan hari ini', week: 'Dalam 7 hari ke depan', month: 'Dijadwalkan bulan ini',
    late: 'Lewat jadwal, belum datang', none: 'Belum ada jadwal',
  };
  function matchArrive(r, v) {
    if (!v) return true;
    if (r.status === 'done') return false;   // baris yang sudah lengkap tidak menunggu kedatangan lagi
    const t = todayStr();
    const d = r.pendingDates;
    if (v === 'none') return r.status !== 'done' && !d.length;
    if (v === 'late') return d.some((x) => x < t);
    if (v === 'today') return d.includes(t);
    if (v === 'week') { const e = ymd(new Date(Date.now() + 7 * 86400000)); return d.some((x) => x >= t && x <= e); }
    if (v === 'month') { const m = t.slice(0, 7); return d.some((x) => x.slice(0, 7) === m); }
    return true;
  }

  const FOLLOW_LABEL = { todo: 'Shortage belum di-follow up', 'promise-late': 'Janji kirim sudah lewat', has: 'Ada catatan follow-up' };
  function matchFollow(r, v) {
    const f = r.follow;
    if (v === 'todo') return r.shortage > 0 && (!f || f.status === 'Belum dihubungi');
    if (v === 'promise-late') return r.status !== 'done' && f && f.promise && f.promise < todayStr();
    if (v === 'has') return !!f;
    return f && f.status === v;
  }

  // Saringan khusus dari klik grafik di Dashboard PO
  function matchDrill(r, dr) {
    if (dr.type === 'arrive') {          // ada jadwal belum Done pada rentang tanggal
      return r.status !== 'done' && r.pendingDates.some((x) => x >= dr.from && x <= dr.to);
    }
    if (dr.type === 'age') return r.shortage > 0 && r.lateDays >= dr.min && r.lateDays <= dr.max;
    return true;
  }

  // Semua saringan kecuali bulan (dipakai juga untuk angka di tab bulan)
  function filteredNoMonth() {
    const q = $('q').value.trim().toLowerCase();
    const jenis = $('fJenis').value, sup = $('fSupplier').value, kurs = $('fKurs').value, arr = $('fArrive').value;
    const man = $('fManual').value, fol = $('fFollow').value;
    const dr = state.drill;
    return state.rows.filter((r) =>
      (!dr || matchDrill(r, dr)) &&
      (!fol || matchFollow(r, fol)) &&
      (!q || q.split(/\s+/).every((w) => r.search.includes(w))) &&
      (!man || (man === 'yes' ? !!r.manual : !r.manual)) &&
      jenisOk(r, jenis) &&
      (!sup || r.supplier === sup) &&
      (!kurs || r.kurs === kurs) &&
      matchArrive(r, arr));
  }
  const byMonth = (rows) => { const m = activeMonth(); return m === 'all' ? rows : rows.filter((r) => r.month === m); };

  const byStatus = (rows, st) => st === 'all' ? rows
    : st === 'open' ? rows.filter((r) => r.status !== 'done')
    : st === 'late' ? rows.filter((r) => r.shortage > 0)
    : rows.filter((r) => r.status === st);

  const SORTS = {
    'date-asc': (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.po < b.po ? -1 : a.po > b.po ? 1 : a.idx - b.idx),
    'date-desc': (a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : a.po > b.po ? -1 : a.po < b.po ? 1 : a.idx - b.idx),
    'next-asc': (a, b) => { const x = a.next ? a.next.date : '9999', y = b.next ? b.next.date : '9999'; return x < y ? -1 : x > y ? 1 : SORTS['date-asc'](a, b); },
    'sisa-desc': (a, b) => (b.sisa - a.sisa) || SORTS['date-asc'](a, b),
    'amount-desc': (a, b) => (b.amount - a.amount) || SORTS['date-asc'](a, b),
    'short-desc': (a, b) => (b.shortValue - a.shortValue) || (b.shortage - a.shortage) || SORTS['date-asc'](a, b),
    'late-desc': (a, b) => (b.lateDays - a.lateDays) || (b.shortValue - a.shortValue) || SORTS['date-asc'](a, b),
  };

  function renderMonthBar(rowsNoMonth) {
    const count = new Map();
    rowsNoMonth.forEach((r) => count.set(r.month, (count.get(r.month) || 0) + 1));
    const cur = curMonth();
    const months = [...new Set(state.rows.map((r) => r.month).filter(Boolean).concat([cur]))].sort();
    const act = activeMonth();
    const btn = (key, label, n, extra) =>
      `<button class="month${key === act ? ' is-active' : ''}${extra || ''}" data-month="${key}" aria-pressed="${key === act}">
        <span class="month-name">${label}</span><span class="month-count">${nf.format(n)} baris</span></button>`;
    $('monthBar').innerHTML =
      btn('all', 'Semua bulan', rowsNoMonth.length, ' month-all') +
      months.map((m) => btn(m, monthLabel(m) + (m === cur ? ' · berjalan' : ''), count.get(m) || 0, m === cur ? ' is-current' : '')).join('');
    const a = $('monthBar').querySelector('.is-active');
    if (a && a.scrollIntoView && !state.monthScrolled) { a.scrollIntoView({ block: 'nearest', inline: 'center' }); state.monthScrolled = true; }
  }

  function renderActiveFilters() {
    const chips = [];
    const m = activeMonth();
    if (m !== 'all') chips.push(['month', `Bulan order: ${monthLabel(m, true)}`]);
    if (state.status !== 'all') chips.push(['status', 'Status: ' + { open: 'Belum lengkap diterima', late: 'Shortage (lewat jadwal / kurang kirim)', done: 'Sudah lengkap' }[state.status]]);
    if ($('q').value.trim()) chips.push(['q', `Cari: "${$('q').value.trim()}"`]);
    if ($('fSupplier').value) chips.push(['fSupplier', 'Supplier: ' + $('fSupplier').value]);
    if ($('fJenis').value) chips.push(['fJenis', 'Jenis: ' + jenisLabel($('fJenis').value)]);
    if ($('fArrive').value) chips.push(['fArrive', 'Jadwal: ' + ARRIVE[$('fArrive').value]]);
    if ($('fKurs').value) chips.push(['fKurs', 'Kurs: ' + $('fKurs').value]);
    if (state.drill) chips.push(['drill', state.drill.label]);
    if ($('fFollow').value) chips.push(['fFollow', 'Follow-up: ' + (FOLLOW_LABEL[$('fFollow').value] || $('fFollow').value)]);
    if ($('fManual').value) chips.push(['fManual', $('fManual').value === 'yes' ? 'Hanya PO yang diedit manual' : 'Hanya PO tanpa edit manual']);
    $('activeFilters').innerHTML = chips.length
      ? '<span class="af-label">Saringan aktif:</span>' + chips.map(([k, t]) =>
          `<button class="chip" data-clear="${k}" title="Hapus saringan ini">${esc(t)}<span class="chip-x" aria-hidden="true">×</span><span class="sr">hapus</span></button>`).join('')
      : '<span class="af-label">Tidak ada saringan, semua baris ditampilkan.</span>';
  }

  /* ---------- Tampilan ---------- */
  function render() {
    const noMonth = filteredNoMonth();
    renderMonthBar(noMonth);
    renderActiveFilters();
    const base = byMonth(noMonth);
    $('cAll').textContent = nf.format(base.length);
    $('cOpen').textContent = nf.format(byStatus(base, 'open').length);
    $('cLate').textContent = nf.format(byStatus(base, 'late').length);
    $('cDone').textContent = nf.format(byStatus(base, 'done').length);
    document.querySelectorAll('.stat').forEach((b) => b.classList.toggle('is-active', b.dataset.status === state.status));

    const rows = applyColSort(byStatus(base, state.status).slice().sort(SORTS[$('fSort').value] || SORTS['date-asc']), colSort.po, PO_GET);
    paintSortHeaders($('rows').closest('table'), 'po');
    const view = rows.slice(0, state.shown);
    const m = activeMonth();
    const where = m === 'all' ? 'semua bulan order' : 'order ' + monthLabel(m, true);
    $('resultInfo').textContent = `Menampilkan ${nf.format(view.length)} dari ${nf.format(rows.length)} baris · ${where}`;

    if (!rows.length) {
      const hint = m !== 'all' ? ' Coba pilih "Semua bulan" atau bulan lain di atas.' : ' Ubah pencarian atau tekan "Reset saringan".';
      $('rows').innerHTML = `<tr class="empty"><td colspan="10">Tidak ada baris yang cocok.${hint}</td></tr>`;
    } else {
      $('rows').innerHTML = view.map(rowHtml).join('');
    }
    $('btnMore').hidden = rows.length <= state.shown;
    state.lastRows = rows;
  }

  function stripHtml(r) {
    const total = Math.max(r.qty, r.sched.reduce((t, s) => t + (Number(s.qty) || 0), 0)) || 1;
    const segs = r.sched.map((s) => {
      const cls = s.status === 'Done' ? 'seg-done' : (s.date && s.date < r.today ? 'seg-late' : 'seg-wait');
      const w = Math.max(3, (Number(s.qty) || 0) / total * 100);
      return `<span class="seg ${cls}" style="width:${w}%" title="Jadwal ${s.n}: ${fmtNum(s.qty)} · ${fmtDate(s.date)} · ${esc(s.status)}"></span>`;
    }).join('');
    const cap = r.sched.length ? `${r.sched.length} jadwal` : 'Belum ada jadwal';
    return `<div class="strip">${segs}</div><div class="strip-cap">${cap}</div>`;
  }

  function rowHtml(r) {
    const st = STATUS[r.status];
    const note = r.dupCount > 1 ? `<span class="note">Kode ini muncul ${r.dupCount}× di PO ini</span>` : '';
    const next = r.next ? `${fmtDate(r.next.date)}<div class="strip-cap">${fmtNum(r.next.qty)} ${esc(r.uom)}</div>` : '–';
    const open = state.openKey === r.key;
    const man = r.manual ? `<span class="tag-manual" title="Terakhir diedit ${esc(r.manual.time)}">Diedit manual</span>` : '';
    let html = `<tr class="row${open ? ' is-open' : ''}" data-key="${esc(r.key)}" tabindex="0" aria-expanded="${open}">
      <td class="po">${esc(r.po)}${man}</td>
      <td class="date">${fmtDate(r.date)}</td>
      <td class="supplier">${esc(r.supplier)}</td>
      <td><div class="mat-name">${esc(r.name)}</div><div class="mat-code">${esc(r.code)}${r.jenis ? ' · ' + esc(r.jenis) : ''}</div>${note}</td>
      <td class="num">${fmtNum(r.qty)} ${esc(r.uom)}<div class="strip-cap">diterima ${fmtNum(r.rec)}</div></td>
      <td class="num">${r.sisa > 0 ? fmtNum(r.sisa) : '0'}</td>
      <td class="num">${r.shortage > 0 ? `<span class="short-qty">${fmtNum(r.shortage)}</span><div class="strip-cap short-cap">${r.lateDays ? r.lateDays + ' hari' : 'kurang kirim'}</div>` : '<span class="muted">–</span>'}</td>
      <td>${stripHtml(r)}</td>
      <td class="date">${next}</td>
      <td><span class="badge ${st.cls}">${st.label}</span>${followChip(r)}</td>
    </tr>`;
    if (open) html += detailHtml(r);
    return html;
  }

  function followChip(r) {
    const f = r.follow;
    if (!f) return r.shortage > 0 ? '<div class="fu fu-todo">Belum di-follow up</div>' : '';
    const late = f.promise && f.promise < todayStr() && r.status !== 'done';
    const cls = f.status === 'Eskalasi' ? 'fu-esc' : f.status === 'Selesai' ? 'fu-done' : f.status === 'Belum dihubungi' ? 'fu-todo' : 'fu-ok';
    return `<div class="fu ${cls}" title="${esc(f.note || '')}">${esc(f.status)}</div>`
      + (f.promise ? `<div class="fu-promise${late ? ' is-late' : ''}">Janji ${fmtDate(f.promise)}${late ? ' · lewat' : ''}</div>` : '');
  }

  function followBox(r) {
    const f = r.follow, ed = state.edit.on;
    const body = f
      ? `<dl class="fu-box-list"><div><dt>Status</dt><dd>${esc(f.status)}</dd></div>
          <div><dt>Janji kirim baru</dt><dd>${f.promise ? fmtDate(f.promise) : '–'}</dd></div>
          <div class="wide"><dt>Catatan</dt><dd>${f.note ? esc(f.note) : '–'}</dd></div></dl>
         <p class="hint">Terakhir diubah ${esc(f.time)}. Tetap tersimpan walaupun data Odoo di-upload ulang.</p>`
      : `<p class="hint">Belum ada follow-up untuk ${esc(r.po)} / ${esc(r.code)}.</p>`;
    return `<div class="fu-box"><div class="fu-box-head"><h4>Follow-up</h4>
      ${ed ? '<button type="button" class="btn btn-sm" data-act="follow">Isi follow-up</button>' : '<span class="hint">Aktifkan Mode edit untuk mengisi.</span>'}</div>${body}</div>`;
  }

  function editFollow(r) {
    if (state.noFollowScript) {
      openDialog({ title: 'Apps Script perlu diperbarui', ok: 'Mengerti', onSubmit: async () => {},
        body: '<p>Follow-up membutuhkan Apps Script versi terbaru. Tempel Code.gs terbaru lalu buat versi deployment baru.</p>' });
      return;
    }
    const f = r.follow || { status: 'Belum dihubungi', promise: '', note: '' };
    openDialog({
      title: `Follow-up · ${r.po}`, ok: 'Simpan follow-up',
      body: `<p class="dlg-lead">${esc(r.code)} · ${esc(r.name)} · ${esc(r.supplier)}${r.shortage > 0 ? ` · shortage ${fmtNum(r.shortage)} ${esc(r.uom)}` : ''}</p>
        <div class="form-grid">
          ${sel('status', 'Status', f.status, ['Belum dihubungi', 'Sudah dihubungi', 'Eskalasi', 'Selesai'])}
          ${fld('promise', 'Janji kirim baru', f.promise, { type: 'date' })}
          <label class="field span-2"><span>Catatan</span><textarea name="note" rows="3" placeholder="Misal: sudah telepon Pak Budi, kirim Jumat pagi">${esc(f.note)}</textarea></label>
        </div>
        <p class="hint">Berlaku untuk semua baris ${esc(r.code)} di ${esc(r.po)}. Kosongkan tanggal bila belum ada janji.</p>`,
      onSubmit: async (fd) => {
        const res = await api('saveFollowup', { data: { po: r.po, code: r.code, status: fd.status, promise: fd.promise, note: fd.note } });
        setFollow(res.followups);
        if (res.editLog) state.editLog = res.editLog;
        refreshAll();
      },
    });
  }

  function detailHtml(r) {
    const amount = r.price === '' ? '–' : fmtNum(r.qty * r.price);
    const ed = state.edit.on;
    const cols = ed ? 6 : 5;
    const rows = r.sched.length ? r.sched.map((s) => {
      const late = s.status !== 'Done' && s.date && s.date < r.today;
      const act = ed ? `<td class="row-actions">
          <button type="button" class="btn-link" data-act="editSched" data-n="${s.n}">Ubah</button>
          <button type="button" class="btn-link danger" data-act="delSched" data-n="${s.n}">Hapus</button></td>` : '';
      return `<tr class="${late ? 'is-late' : ''}"><td>${s.n}</td><td>${fmtDate(s.date)}</td>
        <td class="num">${fmtNum(s.qty)}</td><td class="num">${fmtNum(s.rec)}</td><td>${esc(s.status)}${late ? ' (lewat jadwal)' : ''}${s.short ? ` · <b class="short-qty">shortage ${fmtNum(s.short)}</b>` : ''}</td>${act}</tr>`;
    }).join('') : `<tr><td colspan="${cols}">Belum ada jadwal pengiriman.</td></tr>`;
    const dup = r.dupCount > 1
      ? `<p class="hint">Kode ${esc(r.code)} muncul ${r.dupCount}× di ${esc(r.po)}. Odoo tidak membedakan jadwalnya, jadwal di bawah adalah gabungan; qty diterima dibagi berurutan ke tiap baris.</p>` : '';
    const man = r.manual
      ? `<p class="manual-note">PO ini pernah diedit manual (${[r.manual.lines && 'baris PO', r.manual.sched && 'jadwal'].filter(Boolean).join(' dan ')}) pada ${esc(r.manual.time)}. Saat upload export Odoo berikutnya, Anda akan ditanya mau memakai data Odoo atau mempertahankan edit ini.</p>` : '';
    const tools = ed ? `<div class="detail-tools" data-key="${esc(r.key)}">
        <button type="button" class="btn btn-sm" data-act="editLine">Ubah baris PO</button>
        <button type="button" class="btn btn-sm" data-act="addSched">Tambah jadwal</button>
        <button type="button" class="btn btn-sm btn-danger" data-act="delLine">Hapus baris PO</button>
      </div>` : '';
    return `<tr class="detail"><td colspan="10"><div class="detail-box" data-key="${esc(r.key)}">
      ${tools}
      <div class="detail-meta">
        <span>Harga satuan <b>${r.price === '' ? '–' : fmtNum(r.price)} ${esc(r.kurs)}</b></span>
        <span>Nilai PO baris ini <b>${amount} ${esc(r.kurs)}</b></span>
        <span>Progres <b>${r.qty ? Math.round(Math.min(r.rec, r.qty) / r.qty * 100) : 0}%</b></span>
        ${r.shortage > 0 ? `<span>Shortage <b class="short-qty">${fmtNum(r.shortage)} ${esc(r.uom)}</b>${r.lateDays ? `, terlambat ${r.lateDays} hari sejak ${fmtDate(r.oldestLate)}` : ' (kurang kirim)'}${r.shortValue ? ` · nilai ${fmtNum(Math.round(r.shortValue))} ${esc(r.kurs)}` : ''}</span>` : ''}
      </div>
      ${followBox(r)}
      <table class="sched"><thead><tr><th>Jadwal ke</th><th>Tanggal</th><th class="num">Qty jadwal</th><th class="num">Qty diterima</th><th>Status</th>${ed ? '<th></th>' : ''}</tr></thead>
      <tbody>${rows}</tbody></table>${dup}${man}
    </div></td></tr>`;
  }

  /* ---------- Interaksi monitoring ---------- */
  $('statusRow').addEventListener('click', (e) => {
    const b = e.target.closest('.stat'); if (!b) return;
    state.status = b.dataset.status; state.shown = PAGE; render();
  });
  let t;
  $('q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { state.shown = PAGE; render(); }, 200); });
  ['fJenis', 'fSupplier', 'fKurs', 'fArrive', 'fManual', 'fFollow', 'fSort'].forEach((id) =>
    $(id).addEventListener('change', () => { if (id === 'fSort') colSort.po = null; state.shown = PAGE; render(); }));
  initSortHeaders($('rows').closest('table'), 'po', () => {
    $('fSort').value = colSort.po ? 'col' : 'date-asc';
    state.shown = PAGE; render();
  });

  $('monthBar').addEventListener('click', (e) => {
    const b = e.target.closest('.month'); if (!b) return;
    state.month = b.dataset.month; state.shown = PAGE; state.openKey = null; render();
  });

  $('activeFilters').addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    const k = c.dataset.clear;
    if (k === 'month') state.month = 'all';
    else if (k === 'status') state.status = 'all';
    else if (k === 'drill') state.drill = null;
    else $(k).value = '';
    state.shown = PAGE; render();
  });

  $('btnReset').addEventListener('click', () => {
    ['q', 'fSupplier', 'fKurs', 'fArrive', 'fManual', 'fFollow'].forEach((id) => { $(id).value = ''; });
    $('fJenis').value = RMPM;
    $('fSort').value = 'date-asc';
    colSort.po = null;
    state.drill = null;
    state.status = 'all'; state.month = null; state.shown = PAGE; state.openKey = null; state.monthScrolled = false; render();
  });
  $('btnMore').addEventListener('click', () => { state.shown += PAGE; render(); });
  $('btnReload').addEventListener('click', () => (state.route && state.route.actions === 'sup' ? loadSupplier(true) : loadData()));

  const toggleRow = (tr) => { const k = tr.dataset.key; state.openKey = state.openKey === k ? null : k; render(); };
  $('rows').addEventListener('click', (e) => { const tr = e.target.closest('tr.row'); if (tr) toggleRow(tr); });
  $('rows').addEventListener('keydown', (e) => {
    const tr = e.target.closest('tr.row');
    if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleRow(tr); }
  });

  $('btnExport').addEventListener('click', () => {
    const rows = state.lastRows || [];
    if (!rows.length) return;
    const data = rows.map((r) => ({
      'No PO': r.po, 'Order Date': r.date, 'Supplier': r.supplier, 'Kode': r.code, 'Nama Material': r.name,
      'Jenis': r.jenis, 'Qty Order': r.qty, 'UoM': r.uom, 'Unit Price': r.price, 'Kurs': r.kurs,
      'Diterima': r.rec, 'Sisa': Math.max(0, r.sisa), 'Shortage': r.shortage || '', 'Hari Terlambat': r.lateDays || '',
      'Nilai Shortage': r.shortValue ? Math.round(r.shortValue) : '',
      'Follow-up': r.follow ? r.follow.status : '', 'Janji Kirim': r.follow ? r.follow.promise : '', 'Catatan Follow-up': r.follow ? r.follow.note : '',
      'Jumlah Jadwal': r.sched.length,
      'Jadwal Berikutnya': r.next ? r.next.date : '', 'Qty Jadwal Berikutnya': r.next ? r.next.qty : '',
      'Status': STATUS[r.status].label,
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Monitoring PO');
    XLSX.writeFile(wb, `Monitoring_PO_${todayStr()}.xlsx`);
  });

  /* ================= DASHBOARD PO ================= */
  const DASH = { arrMode: 'count' };
  const fmtRp = (v) => {
    const a = Math.abs(v);
    if (a >= 1e12) return 'Rp ' + nf.format(+(v / 1e12).toFixed(2)) + ' T';
    if (a >= 1e9) return 'Rp ' + nf.format(+(v / 1e9).toFixed(2)) + ' M';
    if (a >= 1e6) return 'Rp ' + nf.format(+(v / 1e6).toFixed(1)) + ' jt';
    return 'Rp ' + nf.format(Math.round(v));
  };
  const dayAdd = (d, n) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return ymd(x); };
  const dmf = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short' });
  const shortDate = (d) => dmf.format(new Date(d + 'T00:00:00'));

  function dashRows() {
    const j = $('dJenis').value, sp = $('dSup').value;
    return state.rows.filter((r) => jenisOk(r, j) && (!sp || r.supplier === sp));
  }

  function fillDashOptions() {
    const keep = (sel, list, first) => {
      const cur = sel.value;
      sel.innerHTML = `<option value="">${first}</option>` + list.map((v) => `<option>${esc(v)}</option>`).join('');
      sel.value = list.includes(cur) ? cur : '';
    };
    const uniq = (f) => [...new Set(state.rows.map(f).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'id'));
    fillJenis($('dJenis'), uniq((r) => r.jenis));
    keep($('dSup'), uniq((r) => r.supplier), 'Semua supplier');
  }

  // Bar vertikal: [{label, value, sub, cls, tip, go}]
  function vbars(el, items, fmt) {
    // Batang "lewat jadwal" yang jauh lebih besar tidak ikut menentukan skala; batangnya dipotong (tanda putus)
    const rest = items.filter((x) => x.cls !== 'is-late').map((x) => x.value);
    const restMax = Math.max(1, ...rest);
    const lateMax = Math.max(0, ...items.filter((x) => x.cls === 'is-late').map((x) => x.value));
    const capped = lateMax > restMax * 1.6;
    const max = capped ? restMax * 1.25 : Math.max(restMax, lateMax);
    const top = items.reduce((m, x, i) => (x.cls !== 'is-late' && x.value > (items[m].cls === 'is-late' ? -1 : items[m].value) ? i : m), 0);
    el.innerHTML = items.map((x, i) => {
      const cut = capped && x.cls === 'is-late';
      const h = cut ? 100 : (x.value ? Math.max(2, x.value / max * 100) : 0);
      return `
      <button class="vbar ${x.cls || ''}${cut ? ' is-cut' : ''}" data-i="${i}" data-tip="${esc(x.tip)}" aria-label="${esc(x.label + ': ' + x.tip)}">
        <span class="vbar-val">${i === top || x.cls === 'is-late' ? (x.value ? fmt(x.value) : '') : ''}</span>
        <span class="vbar-track"><span class="vbar-fill" style="height:${h}%"></span></span>
        <span class="vbar-label">${esc(x.label)}</span>
      </button>`;
    }).join('');
    el._items = items;
  }
  // Bar horizontal: [{label, value, text, cls, tip, go}]
  function hbars(el, items, empty) {
    if (!items.length) { el.innerHTML = `<p class="muted dash-empty">${empty}</p>`; el._items = []; return; }
    const max = Math.max(1, ...items.map((x) => x.value));
    el.innerHTML = items.map((x, i) => `
      <button class="hbar ${x.cls || ''}" data-i="${i}" data-tip="${esc(x.tip)}" aria-label="${esc(x.label + ': ' + x.tip)}">
        <span class="hbar-label">${esc(x.label)}</span>
        <span class="hbar-track"><span class="hbar-fill" style="width:${x.value ? Math.max(1.5, x.value / max * 100) : 0}%"></span></span>
        <span class="hbar-val">${esc(x.text)}</span>
      </button>`).join('');
    el._items = items;
  }

  function renderDash() {
    if (!state.rows.length) return;
    fillDashOptions();
    const rows = dashRows();
    const today = todayStr(), plus7 = dayAdd(today, 7);
    const isIdr = (r) => String(r.kurs).toUpperCase() === 'IDR';

    // KPI
    const open = rows.filter((r) => r.status !== 'done');
    $('kActive').textContent = nf.format(new Set(open.map((r) => r.po)).size);
    $('kActiveSub').textContent = `${nf.format(open.length)} baris belum lengkap · ${nf.format(new Set(open.map((r) => r.supplier)).size)} supplier`;
    $('kOut').textContent = fmtRp(open.filter(isIdr).reduce((t, r) => t + r.sisaValue, 0));
    const other = {};
    open.filter((r) => !isIdr(r) && r.sisaValue).forEach((r) => { other[r.kurs] = (other[r.kurs] || 0) + r.sisaValue; });
    $('kOutSub').textContent = Object.keys(other).length
      ? 'ditambah ' + Object.entries(other).map(([k, v]) => `${k} ${nf.format(Math.round(v))}`).join(' · ')
      : 'semua PO berkurs IDR';
    const sh = rows.filter((r) => r.shortage > 0);
    $('kShort').textContent = fmtRp(sh.filter(isIdr).reduce((t, r) => t + r.shortValue, 0));
    const todo = sh.filter((r) => !r.follow || r.follow.status === 'Belum dihubungi').length;
    $('kShortSub').innerHTML = `${nf.format(sh.length)} baris · ${nf.format(new Set(sh.map((r) => r.supplier)).size)} supplier<br><span class="kpi-warn" data-go="todo">${nf.format(todo)} belum di-follow up</span>`;

    // Jadwal belum Done per minggu (dihitung sekali per PO + kode)
    const groupsFirst = rows.filter((r) => r.first);
    const pend = [];
    groupsFirst.forEach((r) => r.sched.forEach((s) => {
      if (s.status === 'Done' || !s.date) return;
      const gap = Math.max(0, (Number(s.qty) || 0) - (Number(s.rec) || 0));
      pend.push({ date: s.date, value: isIdr(r) && r.price !== '' ? gap * Number(r.price) : 0, r });
    }));
    const wk = pend.filter((p) => p.date >= today && p.date <= plus7);
    $('kWeek').textContent = nf.format(wk.length) + ' jadwal';
    $('kWeekSub').textContent = `${fmtRp(wk.reduce((t, p) => t + p.value, 0))} · ${nf.format(new Set(wk.map((p) => p.r.supplier)).size)} supplier`;

    const dow = (new Date(today + 'T00:00:00').getDay() + 6) % 7;      // 0 = Senin
    const monday = dayAdd(today, -dow);
    const buckets = [{ label: 'Lewat jadwal', from: '0000-01-01', to: dayAdd(today, -1), cls: 'is-late', late: true }];
    for (let i = 0; i < 8; i++) {
      const from = i === 0 ? today : dayAdd(monday, 7 * i), to = dayAdd(monday, 7 * i + 6);
      buckets.push({ label: i === 0 ? 'Minggu ini' : shortDate(from), from, to });
    }
    const after = { label: 'Setelahnya', from: dayAdd(monday, 56), to: '9999-12-31' };
    buckets.push(after);
    const arrItems = buckets.map((b) => {
      const ps = pend.filter((p) => p.date >= b.from && p.date <= b.to);
      const val = ps.reduce((t, p) => t + p.value, 0);
      const range = b.late ? 'sebelum hari ini' : b === after ? `mulai ${shortDate(b.from)}` : `${shortDate(b.from)} – ${shortDate(b.to)}`;
      return {
        label: b.label, cls: b.cls, value: DASH.arrMode === 'count' ? ps.length : val,
        tip: `${range}: ${nf.format(ps.length)} jadwal · ${fmtRp(val)}`,
        go: b.late ? { status: 'late', sort: 'late-desc' }
          : { drill: { type: 'arrive', from: b.from, to: b.to, label: `Jadwal datang ${range}` }, sort: 'next-asc' },
      };
    });
    vbars($('dArrive'), arrItems, DASH.arrMode === 'count' ? (v) => nf.format(v) : fmtRp);

    // Umur shortage
    const ages = [[1, 7, '1–7 hari'], [8, 14, '8–14 hari'], [15, 30, '15–30 hari'], [31, 60, '31–60 hari'], [61, 99999, 'Lebih dari 60 hari']];
    hbars($('dAge'), ages.map(([a, b, label]) => {
      const rs = sh.filter((r) => r.lateDays >= a && r.lateDays <= b);
      const v = rs.filter(isIdr).reduce((t, r) => t + r.shortValue, 0);
      return { label, value: rs.length, text: `${nf.format(rs.length)} baris`, cls: 'is-late',
        tip: `${nf.format(rs.length)} baris · ${fmtRp(v)}`,
        go: { drill: { type: 'age', min: a, max: b, label: `Shortage terlambat ${label}` }, status: 'late', sort: 'late-desc' } };
    }), 'Tidak ada shortage.');

    // Supplier dengan shortage terbesar
    const bySup = new Map();
    sh.forEach((r) => {
      const x = bySup.get(r.supplier) || { v: 0, n: 0 };
      x.v += isIdr(r) ? r.shortValue : 0; x.n++; bySup.set(r.supplier, x);
    });
    hbars($('dSupShort'), [...bySup.entries()].sort((a, b) => b[1].v - a[1].v || b[1].n - a[1].n).slice(0, 8).map(([sup, x]) => ({
      label: sup, value: x.v || x.n, text: x.v ? fmtRp(x.v) : `${x.n} baris`, cls: 'is-late',
      tip: `${nf.format(x.n)} baris shortage · ${fmtRp(x.v)}`, go: { supplier: sup, status: 'late', sort: 'late-desc' },
    })), 'Tidak ada shortage.');

    // Belum lengkap per jenis
    const byJ = new Map();
    open.forEach((r) => { const k = r.jenis || 'Tanpa jenis'; byJ.set(k, (byJ.get(k) || 0) + 1); });
    hbars($('dJenisChart'), [...byJ.entries()].sort((a, b) => b[1] - a[1]).map(([j, n]) => ({
      label: j, value: n, text: `${nf.format(n)} baris`, tip: `${nf.format(n)} baris belum lengkap`,
      go: { jenis: j === 'Tanpa jenis' ? '' : j, status: 'open' },
    })), 'Semua baris sudah lengkap.');

    // Nilai PO per bulan
    const cur = curMonth();
    const months = [];
    for (let i = 11; i >= 0; i--) { const d = new Date(cur + '-01T00:00:00'); d.setMonth(d.getMonth() - i); months.push(ymd(d).slice(0, 7)); }
    vbars($('dMonth'), months.map((m) => {
      const rs = rows.filter((r) => r.month === m);
      const v = rs.filter(isIdr).reduce((t, r) => t + r.amount, 0);
      return { label: new Intl.DateTimeFormat('id-ID', { month: 'short' }).format(new Date(m + '-01T00:00:00')), value: v, cls: m === cur ? 'is-current' : '',
        tip: `${monthLabel(m, true)}: ${fmtRp(v)} · ${nf.format(new Set(rs.map((r) => r.po)).size)} PO`, go: { month: m } };
    }), fmtRp);

    renderDashChanges();

    // Perlu ditindaklanjuti
    const act = applyColSort(sh.slice().sort((a, b) => b.lateDays - a.lateDays || b.shortValue - a.shortValue).slice(0, 12), colSort.act, PO_GET);
    paintSortHeaders($('dAction').closest('table'), 'act');
    $('dAction').innerHTML = act.length ? act.map((r) => `<tr class="row" data-key="${esc(r.key)}" tabindex="0">
        <td class="po">${esc(r.po)}</td><td class="supplier">${esc(r.supplier)}</td>
        <td><div class="mat-name">${esc(r.name)}</div><div class="mat-code">${esc(r.code)}</div></td>
        <td class="num"><span class="short-qty">${fmtNum(r.shortage)}</span> ${esc(r.uom)}</td>
        <td class="num">${r.lateDays} hari</td>
        <td class="num">${r.shortValue ? fmtNum(Math.round(r.shortValue)) + ' ' + esc(r.kurs) : '–'}</td>
        <td>${followChip(r)}</td></tr>`).join('')
      : '<tr class="empty"><td colspan="7">Tidak ada shortage. Semua jadwal yang sudah lewat sudah diterima.</td></tr>';
  }

  // Buka Monitoring PO dengan saringan dari Dashboard
  function goMonitor(go) {
    ['q', 'fArrive', 'fKurs', 'fManual', 'fFollow'].forEach((id) => { $(id).value = ''; });
    if (go.follow) $('fFollow').value = go.follow;
    $('fJenis').value = go.jenis !== undefined ? go.jenis : $('dJenis').value;
    $('fSupplier').value = go.supplier !== undefined ? go.supplier : $('dSup').value;
    if (go.arrive) $('fArrive').value = go.arrive;
    if (go.q) $('q').value = go.q;
    $('fSort').value = go.sort || 'date-asc';
    colSort.po = null;
    state.drill = go.drill || null;
    state.status = go.status || 'all';
    state.month = go.month || 'all';
    state.openKey = go.openKey || null;
    state.shown = PAGE; state.monthScrolled = false;
    location.hash = '#/po/monitoring';
    render();
  }

  ['dJenis', 'dSup'].forEach((id) => $(id).addEventListener('change', renderDash));
  initSortHeaders($('dAction').closest('table'), 'act', renderDash);
  $('dReset').addEventListener('click', () => { $('dJenis').value = RMPM; $('dSup').value = ''; renderDash(); });
  document.querySelectorAll('[data-arrmode]').forEach((b) => b.addEventListener('click', () => {
    DASH.arrMode = b.dataset.arrmode;
    document.querySelectorAll('[data-arrmode]').forEach((x) => x.classList.toggle('is-on', x === b));
    renderDash();
  }));
  $('view-po-dashboard').addEventListener('click', (e) => {
    const k = e.target.closest('[data-go]');
    if (k) {
      const g = k.dataset.go;
      return goMonitor(g === 'short' ? { status: 'late', sort: 'late-desc' } : g === 'todo' ? { status: 'late', follow: 'todo', sort: 'late-desc' }
        : g === 'week' ? { arrive: 'week', sort: 'next-asc' } : { status: 'open' });
    }
    const bar = e.target.closest('.vbar, .hbar');
    if (bar) {
      const it = bar.parentElement._items[Number(bar.dataset.i)];
      if (it && it.chg) { CHG.upload = null; CHG.type = it.chg; CHG.shown = 200; location.hash = '#/po/perubahan'; renderChanges(); return; }
      if (it && it.go) goMonitor(it.go);
      return;
    }
    const tr = e.target.closest('#dAction tr.row');
    if (tr) { const r = state.rows.find((x) => x.key === tr.dataset.key); if (r) goMonitor({ q: r.po, openKey: r.key, jenis: '', supplier: '' }); }
  });
  $('dAction').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.closest('tr.row')) e.target.click(); });

  // Tooltip grafik
  const tip = $('tip');
  const showTip = (el, x, y) => {
    tip.textContent = el.dataset.tip; tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, x - w / 2)) + 'px';
    tip.style.top = Math.max(8, y - h - 12) + 'px';
  };
  $('view-po-dashboard').addEventListener('mousemove', (e) => {
    const el = e.target.closest('[data-tip]');
    if (!el || !el.dataset.tip) { tip.hidden = true; return; }
    showTip(el, e.clientX, e.clientY);
  });
  $('view-po-dashboard').addEventListener('mouseleave', () => { tip.hidden = true; });
  $('view-po-dashboard').addEventListener('focusin', (e) => {
    const el = e.target.closest('[data-tip]'); if (!el) return;
    const b = el.getBoundingClientRect(); showTip(el, b.left + b.width / 2, b.top);
  });
  $('view-po-dashboard').addEventListener('focusout', () => { tip.hidden = true; });

  /* ================= PERUBAHAN DATA (per upload) ================= */
  // Baris LOG_PERUBAHAN: 0 waktu upload, 1 upload sebelumnya, 2 jenis, 3 PO, 4 kode, 5 nama, 6 supplier, 7 lama, 8 baru, 9 tgl jadwal, 10 qty
  const CHG_TYPES = ['PO baru', 'Baris baru', 'Qty order berubah', 'Baris dihapus', 'Jadwal baru', 'Jadwal berubah', 'Jadwal dihapus', 'Diterima'];
  const CHG_CLS = { 'Diterima': 'b-done', 'Baris dihapus': 'b-late', 'Jadwal dihapus': 'b-late', 'Jadwal berubah': 'b-wait', 'Qty order berubah': 'b-wait' };
  const CHG = { upload: null, type: '', shown: 200 };
  const dtf = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fmtStamp = (t) => { const m = String(t).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/); return m ? dtf.format(new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5])) : t; };
  const uploadsList = () => [...new Set(state.changes.map((c) => c[0]))].sort().reverse();
  const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);

  function chgBase() {
    const up = CHG.upload === null ? uploadsList()[0] : CHG.upload;
    return state.changes.filter((c) => !up || c[0] === up);
  }

  function renderChanges() {
    const ups = uploadsList();
    const count = new Map();
    state.changes.forEach((c) => count.set(c[0], (count.get(c[0]) || 0) + 1));
    const cur = CHG.upload === null ? (ups[0] || '') : CHG.upload;
    $('gUpload').innerHTML = ups.length
      ? ups.map((u, i) => `<option value="${esc(u)}"${u === cur ? ' selected' : ''}>${esc(fmtStamp(u))}${i === 0 ? ' (terakhir)' : ''} · ${nf.format(count.get(u))} perubahan</option>`).join('')
        + `<option value=""${cur === '' && ups.length ? ' selected' : ''}>Semua upload</option>`
      : '<option value="">Belum ada</option>';

    const base = chgBase();
    const q = $('gq').value.trim().toLowerCase();
    const searched = base.filter((c) => !q || [c[3], c[4], c[5], c[6]].join(' ').toLowerCase().includes(q));
    const tc = new Map(); searched.forEach((c) => tc.set(c[2], (tc.get(c[2]) || 0) + 1));
    $('gTypes').innerHTML = `<button class="chg-type${CHG.type ? '' : ' is-on'}" data-t="">Semua <b>${nf.format(searched.length)}</b></button>`
      + CHG_TYPES.filter((t) => tc.get(t)).map((t) => `<button class="chg-type${CHG.type === t ? ' is-on' : ''}" data-t="${esc(t)}">${esc(t)} <b>${nf.format(tc.get(t))}</b></button>`).join('');

    let rows = searched.filter((c) => !CHG.type || c[2] === CHG.type);
    rows = applyColSort(rows.slice().sort((a, b) => CHG_TYPES.indexOf(a[2]) - CHG_TYPES.indexOf(b[2]) || a[3].localeCompare(b[3])), colSort.chg, {});
    paintSortHeaders($('gRows').closest('table'), 'chg');
    const view = rows.slice(0, CHG.shown);
    if (!state.changes.length) {
      $('gInfo').textContent = '';
      $('gRows').innerHTML = `<tr class="empty"><td colspan="7">${state.noFollowScript ? 'Apps Script belum versi terbaru, jadi perubahan belum dicatat.' : 'Belum ada perubahan tercatat.'} Perubahan mulai tercatat pada upload export Odoo berikutnya.</td></tr>`;
      $('gMore').hidden = true;
      return;
    }
    const prev = base[0] && base[0][1];
    $('gInfo').textContent = `Menampilkan ${nf.format(view.length)} dari ${nf.format(rows.length)} perubahan` + (cur && prev ? ` · dibanding upload ${fmtStamp(prev)}` : '');
    $('gRows').innerHTML = rows.length ? view.map((c) => {
      let after = esc(c[8]);
      if (c[2] === 'Jadwal berubah' && /^\d{4}-\d{2}-\d{2}$/.test(c[7]) && /^\d{4}-\d{2}-\d{2}$/.test(c[8])) {
        const d = daysBetween(c[7], c[8]);
        after = `${fmtDate(c[8])}<div class="strip-cap ${d > 0 ? 'short-cap' : ''}">${d > 0 ? 'mundur ' + d : 'maju ' + -d} hari</div>`;
      } else if (c[2] === 'Diterima') after = `${esc(c[8])}<div class="strip-cap">+${esc(c[10])}</div>`;
      const before = c[2] === 'Jadwal berubah' && /^\d{4}-/.test(c[7]) ? fmtDate(c[7]) : esc(c[7]);
      return `<tr class="row" data-po="${esc(c[3])}" tabindex="0">
        <td><span class="badge ${CHG_CLS[c[2]] || 'b-none'}">${esc(c[2])}</span>${cur ? '' : `<div class="strip-cap">${esc(fmtStamp(c[0]))}</div>`}</td>
        <td class="po">${esc(c[3])}</td>
        <td><div class="mat-name">${esc(c[5])}</div><div class="mat-code">${esc(c[4])}</div></td>
        <td class="supplier">${esc(c[6])}</td>
        <td class="num old-val">${before || '–'}</td><td class="num">${after || '–'}</td>
        <td class="date">${/^\d{4}-/.test(c[9]) ? fmtDate(c[9]) : '–'}</td></tr>`;
    }).join('') : '<tr class="empty"><td colspan="7">Tidak ada perubahan yang cocok.</td></tr>';
    $('gMore').hidden = rows.length <= CHG.shown;
  }

  $('gUpload').addEventListener('change', () => { CHG.upload = $('gUpload').value; CHG.type = ''; CHG.shown = 200; renderChanges(); });
  let gt;
  $('gq').addEventListener('input', () => { clearTimeout(gt); gt = setTimeout(() => { CHG.shown = 200; renderChanges(); }, 200); });
  $('gTypes').addEventListener('click', (e) => { const b = e.target.closest('.chg-type'); if (!b) return; CHG.type = b.dataset.t; CHG.shown = 200; renderChanges(); });
  $('gMore').addEventListener('click', () => { CHG.shown += 200; renderChanges(); });
  initSortHeaders($('gRows').closest('table'), 'chg', renderChanges);
  $('gRows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr.row'); if (!tr) return;
    goMonitor({ q: tr.dataset.po, jenis: '', supplier: '' });
  });

  // Kartu dashboard: perubahan upload terakhir & ketepatan kirim
  function renderDashChanges() {
    const j = $('dJenis').value, sp = $('dSup').value;
    const jenisOf = new Map(state.rows.map((r) => [r.code, r.jenis]));
    const keep = (c) => jenisOk({ jenis: jenisOf.get(c[4]) || '' }, j) && (!sp || c[6] === sp);
    const ups = uploadsList();
    if (!ups.length) {
      $('dChgSub').textContent = 'Perubahan mulai tercatat pada upload export Odoo berikutnya.';
      hbars($('dChanges'), [], 'Belum ada data perubahan.');
    } else {
      const last = state.changes.filter((c) => c[0] === ups[0] && keep(c));
      const prev = last[0] && last[0][1];
      $('dChgSub').textContent = `Upload ${fmtStamp(ups[0])}` + (prev ? ` dibanding ${fmtStamp(prev)}` : '') + '.';
      const tc = new Map(); last.forEach((c) => tc.set(c[2], (tc.get(c[2]) || 0) + 1));
      hbars($('dChanges'), CHG_TYPES.filter((t) => tc.get(t)).map((t) => ({
        label: t, value: tc.get(t), text: nf.format(tc.get(t)), cls: /dihapus/.test(t) ? 'is-late' : '',
        tip: `${nf.format(tc.get(t))} ${t.toLowerCase()} pada upload terakhir`, chg: t,
      })), 'Tidak ada perubahan untuk saringan ini.');
    }
    // Ketepatan kirim (estimasi): terlambat bila upload sebelumnya sudah melewati tanggal jadwal
    const bySup = new Map();
    state.changes.forEach((c) => {
      if (c[2] !== 'Diterima' || !c[1] || !/^\d{4}-\d{2}-\d{2}/.test(c[9]) || !keep(c)) return;
      const x = bySup.get(c[6]) || { n: 0, ok: 0 };
      x.n++; if (c[1].slice(0, 10) <= c[9]) x.ok++;
      bySup.set(c[6], x);
    });
    hbars($('dOtd'), [...bySup.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 8).map(([sup, x]) => {
      const pct = Math.round(x.ok / x.n * 100);
      return { label: sup, value: pct, text: `${pct}% · ${x.ok}/${x.n}`, cls: pct < 70 ? 'is-late' : '',
        tip: `${x.ok} dari ${x.n} penerimaan tepat waktu`, go: { supplier: sup, jenis: '' } };
    }), 'Belum ada data. Angka muncul setelah ada penerimaan yang terdeteksi di antara dua upload.');
  }

  /* ================= KALENDER KEDATANGAN ================= */
  const CAL = { month: null, day: null };
  const dayLong = new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  function calItems() {
    const j = $('cJenis').value, sp = $('cSup').value, today = todayStr();
    const out = [];
    state.rows.forEach((r) => {
      if (!jenisOk(r, j) || (sp && r.supplier !== sp) || r.status === 'done') return;
      if (r.first) r.sched.forEach((s) => {
        if (s.status === 'Done' || !s.date) return;
        const gap = Math.max(0, (Number(s.qty) || 0) - (Number(s.rec) || 0));
        if (gap) out.push({ date: s.date, r, qty: gap, kind: s.date < today ? 'late' : 'wait' });
      });
      if (r.first && r.follow && r.follow.promise) out.push({ date: r.follow.promise, r, qty: r.shortage || Math.max(0, r.sisa), kind: 'promise' });
    });
    return out;
  }

  function renderCal() {
    if (!state.rows.length) return;
    const uniqS = [...new Set(state.rows.map((r) => r.supplier).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'id'));
    fillJenis($('cJenis'), [...new Set(state.rows.map((r) => r.jenis).filter(Boolean))].sort());
    const cs = $('cSup').value;
    $('cSup').innerHTML = '<option value="">Semua supplier</option>' + uniqS.map((v) => `<option>${esc(v)}</option>`).join('');
    $('cSup').value = uniqS.includes(cs) ? cs : '';

    const today = todayStr();
    const month = CAL.month || today.slice(0, 7);
    const sel = CAL.day || today;
    const items = calItems();
    const byDate = new Map();
    items.forEach((it) => { if (!byDate.has(it.date)) byDate.set(it.date, []); byDate.get(it.date).push(it); });

    $('cTitle').textContent = monthLabel(month, true);
    const first = month + '-01';
    const start = dayAdd(first, -((new Date(first + 'T00:00:00').getDay() + 6) % 7));
    const lastDay = new Date(+month.slice(0, 4), +month.slice(5, 7), 0).getDate();
    const end = dayAdd(month + '-' + String(lastDay).padStart(2, '0'), 6 - ((new Date(month + '-' + String(lastDay).padStart(2, '0') + 'T00:00:00').getDay() + 6) % 7));
    let html = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'].map((d) => `<div class="cal-dow" role="columnheader">${d}</div>`).join('');
    for (let d = start; d <= end; d = dayAdd(d, 1)) {
      const list = byDate.get(d) || [];
      const n = { wait: 0, late: 0, promise: 0 };
      list.forEach((it) => { n[it.kind]++; });
      const cls = ['cal-cell', d.slice(0, 7) !== month ? 'is-other' : '', d === today ? 'is-today' : '', d === sel ? 'is-sel' : '', list.length ? 'has' : ''].join(' ');
      const label = `${dayLong.format(new Date(d + 'T00:00:00'))}: ${n.wait} dijadwalkan, ${n.late} lewat jadwal, ${n.promise} janji kirim`;
      html += `<button class="${cls}" data-d="${d}" role="gridcell" aria-label="${esc(label)}" aria-pressed="${d === sel}">
        <span class="cal-num">${+d.slice(8)}</span>
        <span class="cal-counts">${n.late ? `<span class="cc cc-late">${n.late}</span>` : ''}${n.wait ? `<span class="cc cc-wait">${n.wait}</span>` : ''}${n.promise ? `<span class="cc cc-promise">${n.promise}</span>` : ''}</span>
      </button>`;
    }
    $('cGrid').innerHTML = html;

    // Daftar hari terpilih
    const list = (byDate.get(sel) || []).slice().sort((a, b) => ({ late: 0, promise: 1, wait: 2 })[a.kind] - ({ late: 0, promise: 1, wait: 2 })[b.kind] || a.r.supplier.localeCompare(b.r.supplier));
    const olderLate = items.filter((it) => it.kind === 'late' && it.date < first).length;
    const KIND = { late: ['Lewat jadwal', 'b-late'], wait: ['Dijadwalkan', 'b-wait'], promise: ['Janji kirim baru', 'b-promise'] };
    $('cDay').innerHTML = `<h3>${esc(dayLong.format(new Date(sel + 'T00:00:00')))}</h3>
      <p class="hint">${list.length ? nf.format(list.length) + ' kedatangan · ' + nf.format(new Set(list.map((x) => x.r.supplier)).size) + ' supplier' : 'Tidak ada kedatangan di tanggal ini.'}</p>
      <div class="cal-list">${list.map((it) => `<button class="cal-item" data-key="${esc(it.r.key)}">
          <span class="badge ${KIND[it.kind][1]}">${KIND[it.kind][0]}</span>
          <span class="cal-item-main"><b>${esc(it.r.po)}</b> · ${esc(it.r.supplier)}<br><span class="mat-name">${esc(it.r.name)}</span> <span class="mat-code">${esc(it.r.code)}</span></span>
          <span class="cal-item-qty">${fmtNum(it.qty)} ${esc(it.r.uom)}</span>
        </button>`).join('')}</div>
      ${olderLate ? `<p class="cal-older"><button class="btn btn-ghost btn-sm" data-go-late>${nf.format(olderLate)} jadwal lewat sebelum bulan ini</button></p>` : ''}`;
  }

  $('cGrid').addEventListener('click', (e) => {
    const b = e.target.closest('.cal-cell'); if (!b) return;
    CAL.day = b.dataset.d;
    if (b.dataset.d.slice(0, 7) !== (CAL.month || todayStr().slice(0, 7))) CAL.month = b.dataset.d.slice(0, 7);
    renderCal();
  });
  const shiftMonth = (n) => {
    const m = CAL.month || todayStr().slice(0, 7);
    const d = new Date(m + '-01T00:00:00'); d.setMonth(d.getMonth() + n);
    CAL.month = ymd(d).slice(0, 7);
    CAL.day = CAL.month === todayStr().slice(0, 7) ? todayStr() : CAL.month + '-01';
    renderCal();
  };
  $('cPrev').addEventListener('click', () => shiftMonth(-1));
  $('cNext').addEventListener('click', () => shiftMonth(1));
  $('cToday').addEventListener('click', () => { CAL.month = null; CAL.day = null; renderCal(); });
  ['cJenis', 'cSup'].forEach((id) => $(id).addEventListener('change', renderCal));
  $('cDay').addEventListener('click', (e) => {
    if (e.target.closest('[data-go-late]')) return goMonitor({ status: 'late', sort: 'late-desc', jenis: $('cJenis').value, supplier: $('cSup').value });
    const it = e.target.closest('.cal-item'); if (!it) return;
    const r = state.rows.find((x) => x.key === it.dataset.key);
    if (r) goMonitor({ q: r.po, openKey: r.key, jenis: '', supplier: '' });
  });

  /* ================= EDIT MANUAL ================= */

  const SCHED_STATUS = ['Confirmed', 'Waiting for Shipment', 'Done'];

  async function api(action, payload) {
    const res = await fetch(CFG.APPS_SCRIPT_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action, pin: state.edit.pin, user: state.edit.user }, payload)),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Gagal menyimpan.');
    return data;
  }

  /* ---------- Jendela form ---------- */
  let dlgSubmit = null;
  function openDialog({ title, body, ok = 'Simpan', danger = false, onSubmit }) {
    $('dlgTitle').textContent = title;
    $('dlgBody').innerHTML = body;
    $('dlgError').textContent = '';
    $('dlgOk').textContent = ok;
    $('dlgOk').className = 'btn' + (danger ? ' btn-danger' : '');
    $('dlgOk').disabled = false;
    dlgSubmit = onSubmit;
    $('dlg').showModal();
    const first = $('dlgBody').querySelector('input:not([readonly]), select');
    if (first) first.focus();
  }
  const closeDialog = () => { $('dlg').close(); dlgSubmit = null; };
  $('dlgCancel').addEventListener('click', closeDialog);
  $('dlgForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!dlgSubmit) return closeDialog();
    const fd = Object.fromEntries(new FormData($('dlgForm')).entries());
    $('dlgOk').disabled = true; $('dlgError').textContent = '';
    const label = $('dlgOk').textContent; $('dlgOk').textContent = 'Menyimpan…';
    try { await dlgSubmit(fd); closeDialog(); }
    catch (err) { $('dlgError').textContent = err.message; $('dlgOk').disabled = false; $('dlgOk').textContent = label; }
  });

  const fld = (name, label, value, opt = {}) => {
    const attrs = [`name="${name}"`, `id="f_${name}"`, `value="${esc(value ?? '')}"`];
    if (opt.type) attrs.push(`type="${opt.type}"`); else attrs.push('type="text"');
    if (opt.step) attrs.push(`step="${opt.step}"`);
    if (opt.required) attrs.push('required');
    if (opt.readonly) attrs.push('readonly');
    if (opt.list) attrs.push(`list="${opt.list}"`);
    return `<label class="field${opt.wide ? ' span-2' : ''}"><span>${label}${opt.required ? ' *' : ''}</span><input ${attrs.join(' ')}></label>`;
  };
  const sel = (name, label, value, options) =>
    `<label class="field"><span>${label}</span><select name="${name}">${options.map((o) => `<option${o === value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
  const datalist = (id, values) => `<datalist id="${id}">${[...new Set(values.filter(Boolean))].sort().map((v) => `<option value="${esc(v)}">`).join('')}</datalist>`;

  /* ---------- Mode edit ---------- */
  function setEditMode(on) {
    state.edit.on = on;
    if (!on) state.edit.pin = '';
    $('editBar').hidden = !on;
    $('btnEditMode').textContent = on ? 'Keluar mode edit' : 'Mode edit';
    $('btnEditMode').classList.toggle('is-on', on);
    render();
  }

  $('btnEditMode').addEventListener('click', () => {
    if (state.edit.on) return setEditMode(false);
    if (state.oldScript) {
      openDialog({
        title: 'Apps Script perlu diperbarui', ok: 'Mengerti', onSubmit: async () => {},
        body: '<p>Fitur edit membutuhkan Apps Script versi terbaru di Google Sheet MONITORING PO. Tempel kode Code.gs terbaru lalu buat versi deployment baru (Deploy → Manage deployments → Edit → New version).</p>',
      });
      return;
    }
    openDialog({
      title: 'Masuk mode edit', ok: 'Masuk',
      body: `<p class="dlg-lead">Masukkan PIN (sama dengan PIN upload).</p>
        <div class="form-grid">${fld('pin', 'PIN', '', { type: 'password', required: true })}</div>`,
      onSubmit: async (fd) => {
        state.edit.pin = fd.pin.trim();
        if (!state.edit.pin) throw new Error('Isi PIN.');
        try { await api('verify', {}); } catch (err) { state.edit.pin = ''; throw err; }
        setEditMode(true);
      },
    });
  });
  $('btnEditOff').addEventListener('click', () => setEditMode(false));

  const findRow = (key) => state.rows.find((r) => r.key === key);

  function lineForm(r) {
    const all = state.rows;
    return `<div class="form-grid">
      ${fld('po', 'No PO', r ? r.po : '', { required: true })}
      ${fld('date', 'Order Date', r ? r.date : todayStr(), { type: 'date', required: true })}
      ${fld('supplier', 'Supplier', r ? r.supplier : '', { list: 'dlSup', wide: true })}
      ${fld('code', 'Kode material', r ? r.code : '', { required: true, list: 'dlCode' })}
      ${fld('name', 'Nama material', r ? r.name : '', { wide: true })}
      ${fld('qty', 'Qty order', r ? r.qty : '', { type: 'number', step: 'any', required: true })}
      ${fld('uom', 'UoM', r ? r.uom : '', { list: 'dlUom' })}
      ${fld('price', 'Harga satuan', r ? r.price : '', { type: 'number', step: 'any' })}
      ${fld('kurs', 'Kurs', r ? r.kurs : 'IDR', { list: 'dlKurs' })}
    </div>
    ${datalist('dlSup', all.map((x) => x.supplier))}${datalist('dlCode', all.map((x) => x.code))}
    ${datalist('dlUom', all.map((x) => x.uom))}${datalist('dlKurs', all.map((x) => x.kurs))}
    <p class="hint">Isi kode yang sudah pernah dipakai, maka nama material dan UoM terisi otomatis. Jenis material diambil dari master material.</p>`;
  }

  // Kode material → isi otomatis nama & UoM dari data yang sudah ada
  $('dlgBody').addEventListener('change', (e) => {
    if (e.target.name !== 'code') return;
    const hit = state.rows.find((x) => x.code === e.target.value.trim());
    if (!hit) return;
    const n = $('dlgBody').querySelector('[name="name"]'), u = $('dlgBody').querySelector('[name="uom"]');
    if (n && !n.value) n.value = hit.name;
    if (u && !u.value) u.value = hit.uom;
  });

  const lineData = (fd) => ({ po: fd.po.trim(), date: fd.date, supplier: fd.supplier, code: fd.code.trim(), name: fd.name,
    qty: fd.qty, uom: fd.uom, price: fd.price, kurs: fd.kurs });

  function editLine(r) {
    openDialog({
      title: r ? `Ubah baris PO ${r.po}` : 'Tambah baris PO', ok: r ? 'Simpan perubahan' : 'Tambah baris',
      body: lineForm(r),
      onSubmit: async (fd) => {
        const res = await api('saveLine', { key: r ? { po: r.po, code: r.code, lineKe: r.lineKe } : null, data: lineData(fd) });
        if (r && (fd.po.trim() !== r.po || fd.code.trim() !== r.code)) state.openKey = null;
        applyServerUpdate(res);
      },
    });
  }

  function deleteLine(r) {
    const others = state.rows.filter((x) => x.po === r.po && x.code === r.code && x.key !== r.key).length;
    const withSched = !others && r.sched.length;
    openDialog({
      title: `Hapus baris PO ${r.po}?`, ok: 'Hapus', danger: true,
      body: `<p><b>${esc(r.code)} · ${esc(r.name)}</b> (${fmtNum(r.qty)} ${esc(r.uom)}) akan dihapus dari monitoring.</p>
        ${withSched ? `<p>${r.sched.length} jadwal pengiriman untuk material ini juga ikut dihapus.</p>` : ''}
        <p class="hint">Perubahan tercatat di Riwayat Edit PO. Data bisa kembali bila Anda memilih "pakai data Odoo" saat upload berikutnya.</p>`,
      onSubmit: async () => {
        const res = await api('deleteLine', { key: { po: r.po, code: r.code, lineKe: r.lineKe }, withSchedules: !!withSched });
        state.openKey = null;
        applyServerUpdate(res);
      },
    });
  }

  function editSched(r, s) {
    openDialog({
      title: s ? `Ubah jadwal ke-${s.n} · ${r.po}` : `Tambah jadwal · ${r.po}`, ok: s ? 'Simpan perubahan' : 'Tambah jadwal',
      body: `<p class="dlg-lead">${esc(r.code)} · ${esc(r.name)} · qty order ${fmtNum(r.qty)} ${esc(r.uom)}</p>
        <div class="form-grid">
          ${fld('date', 'Tanggal jadwal', s ? s.date : todayStr(), { type: 'date', required: true })}
          ${sel('status', 'Status', s ? s.status : 'Confirmed', SCHED_STATUS.includes(s && s.status) || !s ? SCHED_STATUS : SCHED_STATUS.concat([s.status]))}
          ${fld('qty', 'Qty jadwal', s ? s.qty : Math.max(0, r.sisa), { type: 'number', step: 'any', required: true })}
          ${fld('rec', 'Qty diterima', s ? s.rec : 0, { type: 'number', step: 'any' })}
        </div>`,
      onSubmit: async (fd) => {
        const res = await api('saveSched', {
          key: s ? { po: r.po, code: r.code, n: s.n } : null,
          data: { po: r.po, code: r.code, name: r.name, date: fd.date, status: fd.status, qty: fd.qty, rec: fd.rec || 0 },
        });
        applyServerUpdate(res);
      },
    });
  }

  function deleteSched(r, s) {
    openDialog({
      title: `Hapus jadwal ke-${s.n}?`, ok: 'Hapus', danger: true,
      body: `<p>Jadwal <b>${fmtDate(s.date)}</b> · ${fmtNum(s.qty)} ${esc(r.uom)} · ${esc(s.status)} untuk ${esc(r.po)} / ${esc(r.code)} akan dihapus.</p>`,
      onSubmit: async () => { applyServerUpdate(await api('deleteSched', { key: { po: r.po, code: r.code, n: s.n } })); },
    });
  }

  $('rows').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b || !state.edit.on) return;
    const box = b.closest('[data-key]'); const r = box && findRow(box.dataset.key); if (!r) return;
    const s = b.dataset.n ? r.sched.find((x) => String(x.n) === b.dataset.n) : null;
    ({ follow: () => editFollow(r), editLine: () => editLine(r), delLine: () => deleteLine(r), addSched: () => editSched(r, null),
       editSched: () => editSched(r, s), delSched: () => deleteSched(r, s) })[b.dataset.act]();
  });
  $('btnAddLine').addEventListener('click', () => editLine(null));

  /* ================= SUPPLIER & MOQ ================= */
  // Baris dari Apps Script (?view=supplier), satu per material + supplier, semuanya dari histori PO:
  // 0 kode, 1 nama, 2 kategori, 3 uom, 4 supplier, 5 utama, 6 sumber, 7 jumlah PO, 8 total qty, 9 MoQ (qty PO terkecil),
  // 10 qty PO terbesar, 11 no PO terakhir, 12 tgl PO terakhir, 13 harga terakhir, 14 kurs, 15 lead time, 16 dihitung
  const SUP = state.sup;
  const blank = (v) => v === '' || v === null || v === undefined;

  function setSupRows(rows, builtAt, dbUrl) {
    SUP.rows = rows.map((r, i) => ({
      i, code: String(r[0]), name: r[1], cat: r[2], uom: r[3], supplier: String(r[4] || ''), main: r[5] === 'Ya',
      count: Number(r[7]) || 0, total: Number(r[8]) || 0, moq: blank(r[9]) ? null : Number(r[9]), max: blank(r[10]) ? null : Number(r[10]),
      lastPo: r[11], lastDate: normDate(r[12]), price: r[13], kurs: r[14], lead: blank(r[15]) ? null : Number(r[15]),
      search: (r[0] + ' ' + r[1] + ' ' + r[4]).toLowerCase(),
    }));
    SUP.nSup = new Map();
    SUP.rows.forEach((x) => { if (x.supplier) SUP.nSup.set(x.code, (SUP.nSup.get(x.code) || 0) + 1); });
    SUP.builtAt = builtAt; if (dbUrl) SUP.dbUrl = dbUrl;
    SUP.loaded = true;
    fillSupOptions();
    renderSup();
    renderSupHome();
    if (state.route && state.route.actions === 'sup' && SUP.dbUrl) $('lnkSheet').href = SUP.dbUrl;
  }

  async function loadSupplier(rebuild) {
    if (!CFG.APPS_SCRIPT_URL) return;
    SUP.loading = true;
    $('btnReload').disabled = true;
    if (!SUP.loaded) $('sRows').innerHTML = '<tr class="empty"><td colspan="9">Menghitung daftar supplier dari histori PO, biasanya 5–15 detik…</td></tr>';
    if (rebuild) $('sInfo').textContent = 'Menghitung ulang dari data PO terbaru…';
    try {
      const res = await fetch(CFG.APPS_SCRIPT_URL + '?view=supplier' + (rebuild ? '&rebuild=1' : ''));
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Respon tidak valid');
      if (!Array.isArray(data.rows)) {
        $('sRows').innerHTML = '<tr class="empty"><td colspan="9">Apps Script di Google Sheet MONITORING PO belum versi terbaru. Tempel kode Code.gs terbaru, lalu Deploy → Manage deployments → Edit → New version → Deploy. Setelah itu tekan "Muat ulang data".</td></tr>';
        $('sInfo').textContent = '';
        return;
      }
      setSupRows(data.rows, data.builtAt, data.databaseUrl);
    } catch (err) {
      $('sRows').innerHTML = `<tr class="empty"><td colspan="9">Data supplier tidak bisa dimuat: ${esc(err.message)}. Tekan "Muat ulang data" untuk mencoba lagi.</td></tr>`;
    } finally {
      SUP.loading = false;
      $('btnReload').disabled = false;
    }
  }

  function fillSupOptions() {
    const cur = $('sSup').value;
    const list = [...new Set(SUP.rows.map((x) => x.supplier).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'id'));
    $('sSup').innerHTML = '<option value="">Semua supplier</option>' + list.map((v) => `<option>${esc(v)}</option>`).join('');
    $('sSup').value = list.includes(cur) ? cur : '';
  }

  function supFiltered() {
    const q = $('sq').value.trim().toLowerCase(), cat = $('sCat').value, sup = $('sSup').value;
    return SUP.rows.filter((x) =>
      (!q || q.split(/\s+/).every((w) => x.search.includes(w))) && (!cat || x.cat === cat) && (!sup || x.supplier === sup));
  }
  const supByView = (rows, v) => v === 'all' ? rows
    : v === 'has' ? rows.filter((x) => x.supplier)
    : v === 'none' ? rows.filter((x) => !x.supplier)
    : rows.filter((x) => (SUP.nSup.get(x.code) || 0) >= 2);
  const countCodes = (rows) => new Set(rows.map((x) => x.code)).size;

  const SUP_SORT = {
    kode: (a, b) => a.code.localeCompare(b.code, 'id', { numeric: true }) || a.i - b.i,
    nama: (a, b) => String(a.name).localeCompare(String(b.name), 'id') || a.i - b.i,
    supplier: (a, b) => (a.supplier ? 0 : 1) - (b.supplier ? 0 : 1) || a.supplier.localeCompare(b.supplier, 'id') || SUP_SORT.kode(a, b),
    last: (a, b) => (b.lastDate || '').localeCompare(a.lastDate || '') || SUP_SORT.kode(a, b),
    count: (a, b) => b.count - a.count || SUP_SORT.kode(a, b),
    lead: (a, b) => (b.lead ?? -1) - (a.lead ?? -1) || SUP_SORT.kode(a, b),
  };

  function renderSup() {
    if (!SUP.loaded) return;
    const base = supFiltered();
    $('sAll').textContent = nf.format(countCodes(base));
    $('sHas').textContent = nf.format(countCodes(supByView(base, 'has')));
    $('sMultiN').textContent = nf.format(countCodes(supByView(base, 'multi')));
    $('sNone').textContent = nf.format(countCodes(supByView(base, 'none')));
    document.querySelectorAll('#supStatusRow .stat').forEach((b) => b.classList.toggle('is-active', b.dataset.sv === SUP.view));

    const sortKey = $('sSort').value;
    const rows = applyColSort(supByView(base, SUP.view).slice().sort(SUP_SORT[sortKey] || SUP_SORT.kode), colSort.sup, SUP_GET);
    paintSortHeaders($('sRows').closest('table'), 'sup');
    const view = rows.slice(0, SUP.shown);
    $('sInfo').textContent = `Menampilkan ${nf.format(view.length)} dari ${nf.format(rows.length)} baris (${nf.format(countCodes(rows))} material)`
      + (SUP.builtAt ? ` · dihitung ${SUP.builtAt}` : '');
    renderSupChips();

    const grouped = colSort.sup ? colSort.sup.k === 'name' : (sortKey === 'kode' || sortKey === 'nama');
    let prev = null;
    $('sRows').innerHTML = rows.length ? view.map((x) => {
      const cont = grouped && prev === x.code; prev = x.code;
      const tag = x.main && (SUP.nSup.get(x.code) || 0) > 1 ? '<span class="tag tag-main">Utama</span>' : '';
      const one = x.count === 1 ? '<div class="strip-cap">dari 1 PO</div>' : '';
      return `<tr class="${cont ? 'cont' : ''}${x.supplier ? '' : ' no-sup'}">
        <td class="mat"><div class="mat-name">${esc(x.name)}</div><div class="mat-code">${esc(x.code)} · ${esc(x.cat)}</div></td>
        <td class="supplier">${x.supplier ? esc(x.supplier) + tag : '<span class="muted">Belum ada riwayat PO</span>'}</td>
        <td class="num moq">${x.moq === null ? '–' : fmtNum(x.moq) + ' ' + esc(x.uom) + one}</td>
        <td class="num">${x.max === null ? '–' : fmtNum(x.max) + ' ' + esc(x.uom)}</td>
        <td class="num">${x.supplier ? fmtNum(x.count) : '–'}</td>
        <td class="num">${x.count ? fmtNum(x.total) + ' ' + esc(x.uom) : '–'}</td>
        <td class="date">${x.lastPo ? `${esc(x.lastPo)}<div class="strip-cap">${fmtDate(x.lastDate)}</div>` : '–'}</td>
        <td class="num">${blank(x.price) ? '–' : fmtNum(x.price) + ' ' + esc(x.kurs)}</td>
        <td class="num">${x.lead === null ? '–' : fmtNum(x.lead) + ' hari'}</td></tr>`;
    }).join('') : '<tr class="empty"><td colspan="9">Tidak ada material yang cocok. Ubah pencarian atau tekan "Reset saringan".</td></tr>';
    $('sMore').hidden = rows.length <= SUP.shown;
    SUP.lastRows = rows;
  }

  function renderSupChips() {
    const chips = [];
    const viewLabel = { has: 'Punya supplier', multi: 'Lebih dari 1 supplier', none: 'Belum ada riwayat PO' }[SUP.view];
    if (viewLabel) chips.push(['view', viewLabel]);
    if ($('sq').value.trim()) chips.push(['sq', `Cari: "${$('sq').value.trim()}"`]);
    if ($('sCat').value) chips.push(['sCat', 'Kategori: ' + $('sCat').value]);
    if ($('sSup').value) chips.push(['sSup', 'Supplier: ' + $('sSup').value]);
    $('sChips').innerHTML = chips.length
      ? '<span class="af-label">Saringan aktif:</span>' + chips.map(([k, t]) =>
          `<button class="chip" data-clear="${k}" title="Hapus saringan ini">${esc(t)}<span class="chip-x" aria-hidden="true">×</span><span class="sr">hapus</span></button>`).join('')
      : '<span class="af-label">Tidak ada saringan, semua material RM dan PM ditampilkan.</span>';
  }

  function renderSupHome() {
    const all = new Set(SUP.rows.map((x) => x.code));
    $('hSupHas').textContent = nf.format(SUP.nSup.size);
    $('hSupMulti').textContent = nf.format([...SUP.nSup.values()].filter((n) => n >= 2).length);
    $('hSupNone').textContent = nf.format(all.size - SUP.nSup.size);
  }

  $('supStatusRow').addEventListener('click', (e) => {
    const b = e.target.closest('.stat'); if (!b) return;
    SUP.view = b.dataset.sv; SUP.shown = PAGE; renderSup();
  });
  let st;
  $('sq').addEventListener('input', () => { clearTimeout(st); st = setTimeout(() => { SUP.shown = PAGE; renderSup(); }, 200); });
  ['sCat', 'sSup', 'sSort'].forEach((id) => $(id).addEventListener('change', () => { if (id === 'sSort') colSort.sup = null; SUP.shown = PAGE; renderSup(); }));
  initSortHeaders($('sRows').closest('table'), 'sup', () => {
    $('sSort').value = colSort.sup ? 'col' : 'kode';
    SUP.shown = PAGE; renderSup();
  });
  $('sChips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    if (c.dataset.clear === 'view') SUP.view = 'all'; else $(c.dataset.clear).value = '';
    SUP.shown = PAGE; renderSup();
  });
  $('sReset').addEventListener('click', () => {
    ['sq', 'sCat', 'sSup'].forEach((id) => { $(id).value = ''; });
    $('sSort').value = 'kode'; colSort.sup = null; SUP.view = 'all'; SUP.shown = PAGE; renderSup();
  });
  $('sMore').addEventListener('click', () => { SUP.shown += PAGE; renderSup(); });
  $('sExport').addEventListener('click', () => {
    const rows = SUP.lastRows || [];
    if (!rows.length) return;
    const data = rows.map((x) => ({
      'Kode': x.code, 'Nama Material': x.name, 'Kategori': x.cat, 'UoM': x.uom, 'Supplier': x.supplier || 'Belum ada riwayat PO',
      'Supplier Utama': x.main && x.supplier ? 'Ya' : '', 'MoQ (Qty PO Terkecil)': x.moq ?? '', 'Qty PO Terbesar': x.max ?? '',
      'Jumlah PO': x.count, 'Total Qty PO': x.total, 'No PO Terakhir': x.lastPo, 'Tgl PO Terakhir': x.lastDate,
      'Harga Terakhir': x.price, 'Kurs': x.kurs, 'Lead Time (hari)': x.lead ?? '',
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Supplier & MoQ');
    XLSX.writeFile(wb, `Supplier_MoQ_${todayStr()}.xlsx`);
  });

  /* ---------- Riwayat edit ---------- */
  function renderLog() {
    const q = $('qLog').value.trim().toLowerCase();
    const rows = applyColSort(state.editLog.filter((r) => !q || [r[0]].concat(r.slice(2)).join(' ').toLowerCase().includes(q)), colSort.log, {});
    paintSortHeaders($('logRows').closest('table'), 'log');
    $('logRows').innerHTML = rows.length ? rows.map((r) => `<tr>
        <td class="date">${esc(r[0])}</td><td>${esc(r[2])}</td><td class="po">${esc(r[3])}</td>
        <td>${esc(r[4])}</td><td>${esc(r[5])}</td><td class="old">${esc(r[6])}</td><td class="new">${esc(r[7])}</td></tr>`).join('')
      : `<tr class="empty"><td colspan="7">${state.editLog.length ? 'Tidak ada riwayat yang cocok.' : 'Belum ada riwayat edit. Perubahan lewat Mode edit akan tampil di sini.'}</td></tr>`;
  }
  $('qLog').addEventListener('input', renderLog);
  initSortHeaders($('logRows').closest('table'), 'log', renderLog);

  /* ---------- Upload: PO yang pernah diedit manual ---------- */
  state.choices = new Map();
  function conflicts() {
    const det = state.parsedDet && state.parsedDet.pos, del = state.parsedDel && state.parsedDel.pos;
    const out = [];
    state.manual.forEach((m, po) => {
      const parts = [];
      if (m.lines && det && det.has(po)) parts.push('lines');
      if (m.sched && del && del.has(po)) parts.push('sched');
      if (parts.length) out.push({ po, parts, time: m.time, by: m.by });
    });
    return out.sort((a, b) => a.po.localeCompare(b.po));
  }

  function renderConflicts() {
    const list = conflicts();
    const box = $('conflictBox');
    [...state.choices.keys()].forEach((po) => { if (!list.some((c) => c.po === po)) state.choices.delete(po); });
    if (!list.length) { box.hidden = true; box.innerHTML = ''; updateSendState(); return; }
    box.hidden = false;
    box.innerHTML = `<h4>${list.length} PO di file ini pernah diedit manual</h4>
      <p>Pilih data mana yang dipakai untuk setiap PO. "Pakai data Odoo" menimpa hasil edit manual; "Pertahankan edit" membiarkan PO itu seperti sekarang (bagian yang diedit tidak diperbarui dari file).</p>
      <div class="conflict-bulk">
        <button type="button" class="btn btn-ghost btn-sm" data-all="odoo">Semua pakai data Odoo</button>
        <button type="button" class="btn btn-ghost btn-sm" data-all="keep">Semua pertahankan edit</button>
      </div>
      <ul class="conflict-list">${list.map((c) => {
        const ch = state.choices.get(c.po);
        const what = c.parts.map((p) => (p === 'lines' ? 'baris PO' : 'jadwal')).join(' dan ');
        return `<li><div><b>${esc(c.po)}</b><span class="hint"> · ${what} diedit ${esc(c.time)}</span></div>
          <div class="choice">
            <label><input type="radio" name="c_${esc(c.po)}" value="odoo" data-po="${esc(c.po)}"${ch === 'odoo' ? ' checked' : ''}> Pakai data Odoo</label>
            <label><input type="radio" name="c_${esc(c.po)}" value="keep" data-po="${esc(c.po)}"${ch === 'keep' ? ' checked' : ''}> Pertahankan edit</label>
          </div></li>`;
      }).join('')}</ul>`;
    updateSendState();
  }
  $('conflictBox').addEventListener('change', (e) => {
    if (e.target.dataset.po) { state.choices.set(e.target.dataset.po, e.target.value); updateSendState(); }
  });
  $('conflictBox').addEventListener('click', (e) => {
    const b = e.target.closest('[data-all]'); if (!b) return;
    conflicts().forEach((c) => state.choices.set(c.po, b.dataset.all));
    renderConflicts();
  });

  function updateSendState() {
    const hasFile = !!(state.parsedDet || state.parsedDel);
    const undecided = conflicts().filter((c) => !state.choices.has(c.po)).length;
    $('btnSend').disabled = !hasFile || undecided > 0;
    $('btnSend').title = undecided ? `Pilih dulu data untuk ${undecided} PO yang pernah diedit manual` : '';
  }

  /* ---------- Upload: baca file Odoo ---------- */
  const DET_COLS = {
    po: 'Order Lines/Order Reference/Order Reference',
    date: 'Order Lines/Order Reference/Order Date',
    sup: 'Order Lines/Order Reference/Supplier',
    code: 'Order Lines/Product/Internal Reference',
    name: 'Order Lines/Product/Name',
    qty: 'Order Lines/Quantity',
    uom: 'Order Lines/Product/Unit of Measure',
    price: 'Order Lines/Unit Price',
    kurs: 'Order Lines/Order Reference/Currency',
  };
  const DEL_COLS = {
    ext: 'External ID',
    po: 'Delivery Schedule/PO Ref/Order Reference',
    prod: 'Delivery Schedule/Plot Delivery Order/Product',
    sq: 'Delivery Schedule/Plot Delivery Order/Scheduled Quantity',
    rq: 'Delivery Schedule/Plot Delivery Order/Received Quantity',
    date: 'Delivery Schedule/Scheduled Date',
    state: 'Delivery Schedule/State',
  };

  async function readSheet(file) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', cellDates: false });
    return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true });
  }

  function colIndex(header, cols) {
    const idx = {}, missing = [];
    Object.entries(cols).forEach(([k, name]) => {
      const i = header.findIndex((h) => String(h).trim() === name);
      if (i < 0) missing.push(name); else idx[k] = i;
    });
    return { idx, missing };
  }

  const txt = (v) => String(v ?? '').trim();
  const numv = (v) => { const s = txt(v); if (s === '') return ''; const n = Number(s); return isNaN(n) ? '' : n; };
  function dateStr(v) {
    if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`; }
    const s = txt(v);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    const m2 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); // d/m/yyyy
    if (m2) return `${m2[3]}-${m2[2].padStart(2, '0')}-${m2[1].padStart(2, '0')}`;
    return '';
  }
  const normCode = (v) => (typeof v === 'number' ? String(Math.round(v)) : txt(v));

  function parseDet(aoa) {
    const { idx, missing } = colIndex(aoa[0] || [], DET_COLS);
    if (missing.length) throw new Error('Ini bukan file PO-DET. Kolom yang tidak ditemukan: ' + missing.join(', '));
    const count = new Map(), rows = [];
    aoa.slice(1).forEach((r) => {
      const po = txt(r[idx.po]); if (!po) return;
      const code = normCode(r[idx.code]);
      const k = po + '|' + code; count.set(k, (count.get(k) || 0) + 1);
      rows.push([po, dateStr(r[idx.date]), txt(r[idx.sup]), code, txt(r[idx.name]),
        numv(r[idx.qty]), txt(r[idx.uom]), numv(r[idx.price]), txt(r[idx.kurs]), count.get(k)]);
    });
    if (!rows.length) throw new Error('File PO-DET tidak berisi baris PO.');
    const pos = new Set(rows.map((r) => r[0]));
    return { rows, pos };
  }

  function parseDel(aoa) {
    const { idx, missing } = colIndex(aoa[0] || [], DEL_COLS);
    if (missing.length) throw new Error('Ini bukan file PO-DEL. Kolom yang tidak ditemukan: ' + missing.join(', '));
    let po = '', date = '', st = '';
    const allPOs = new Set(), count = new Map(), rows = [];
    let cancelled = 0;
    aoa.slice(1).forEach((r) => {
      const ext = txt(r[idx.ext]), ref = txt(r[idx.po]), prod = txt(r[idx.prod]);
      if (ref) { po = ref; date = dateStr(r[idx.date]); st = txt(r[idx.state]); allPOs.add(po); }
      else if (ext) { po = ''; date = ''; st = ''; }          // PO baru tanpa jadwal
      if (!prod || !po) return;
      if (st.toLowerCase() === 'cancelled') { cancelled++; return; }
      const m = prod.match(/^\[([^\]]+)\]\s*(.*)$/);
      if (!m) return;
      const code = m[1].trim(), k = po + '|' + code;
      count.set(k, (count.get(k) || 0) + 1);
      rows.push([po, code, m[2].trim(), count.get(k), numv(r[idx.sq]) || 0, numv(r[idx.rq]) || 0, date, st]);
    });
    if (!allPOs.size) throw new Error('File PO-DEL tidak berisi jadwal pengiriman.');
    return { rows, pos: allPOs, cancelled };
  }

  function bindFile(inputId, nameId, checkId, parser, key) {
    $(inputId).addEventListener('change', async (e) => {
      const file = e.target.files[0];
      state[key] = null;
      $(checkId).className = 'check'; $(checkId).textContent = '';
      $(nameId).textContent = file ? file.name : 'Belum ada file';
      if (file) {
        $(checkId).textContent = 'Membaca file…';
        try {
          const parsed = parser(await readSheet(file));
          parsed.fileName = file.name;
          state[key] = parsed;
          $(checkId).className = 'check ok';
          $(checkId).textContent = summary(key, parsed);
        } catch (err) {
          $(checkId).className = 'check err';
          $(checkId).textContent = err.message;
        }
      }
      renderConflicts();
      $('sendResult').textContent = ''; $('sendResult').className = 'send-result';
    });
  }

  function summary(key, p) {
    const known = state.knownPOs;
    const baru = [...p.pos].filter((x) => !known.has(x)).length;
    const pos = `${nf.format(p.pos.size)} PO` + (known.size ? ` (${nf.format(baru)} baru, ${nf.format(p.pos.size - baru)} sudah ada)` : '');
    if (key === 'parsedDet') return `File terbaca: ${nf.format(p.rows.length)} baris dari ${pos}.`;
    return `File terbaca: ${nf.format(p.rows.length)} jadwal dari ${pos}. ${nf.format(p.cancelled)} jadwal Cancelled tidak dimasukkan.`;
  }

  bindFile('fileDet', 'nameDet', 'checkDet', parseDet, 'parsedDet');
  bindFile('fileDel', 'nameDel', 'checkDel', parseDel, 'parsedDel');

  $('btnSend').addEventListener('click', async () => {
    const out = $('sendResult');
    if (!CFG.APPS_SCRIPT_URL) { out.className = 'send-result err'; out.textContent = 'Website belum terhubung ke Google Sheet.'; return; }
    const pin = $('pin').value.trim();
    if (!pin) { out.className = 'send-result err'; out.textContent = 'Masukkan PIN upload terlebih dahulu.'; $('pin').focus(); return; }
    // PO yang dipilih "Pertahankan edit": bagian yang diedit tidak ikut dikirim
    const keepLines = new Set(), keepSched = new Set();
    conflicts().forEach((c) => {
      if (state.choices.get(c.po) !== 'keep') return;
      if (c.parts.includes('lines')) keepLines.add(c.po);
      if (c.parts.includes('sched')) keepSched.add(c.po);
    });
    const body = { pin, keptPOs: [...new Set([...keepLines, ...keepSched])] };
    if (state.parsedDet) {
      body.lines = state.parsedDet.rows.filter((r) => !keepLines.has(r[0]));
      body.detName = state.parsedDet.fileName;
    }
    if (state.parsedDel) {
      body.schedules = state.parsedDel.rows.filter((r) => !keepSched.has(r[0]));
      body.delPOs = [...state.parsedDel.pos].filter((p) => !keepSched.has(p));
      body.delName = state.parsedDel.fileName;
    }
    if (!(body.lines && body.lines.length) && !(body.delPOs && body.delPOs.length)) {
      out.className = 'send-result err'; out.textContent = 'Tidak ada data yang dikirim: semua PO di file dipilih "Pertahankan edit".'; return;
    }

    $('btnSend').disabled = true;
    out.className = 'send-result'; out.textContent = 'Mengirim ke Google Sheet… jangan tutup halaman ini.';
    try {
      const res = await fetch(CFG.APPS_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      const r = data.result, li = [];
      if (r.lines) li.push(`PO-DET: ${nf.format(r.lines.rows)} baris masuk (${nf.format(r.lines.poBaru)} PO baru, ${nf.format(r.lines.poDiperbarui)} PO diperbarui).`);
      if (r.schedules) li.push(`PO-DEL: ${nf.format(r.schedules.rows)} jadwal masuk untuk ${nf.format(r.schedules.poDiganti)} PO.`);
      if (body.keptPOs.length) li.push(`Edit manual dipertahankan untuk ${nf.format(body.keptPOs.length)} PO: ${body.keptPOs.join(', ')}.`);
      out.className = 'send-result ok';
      out.innerHTML = `Terkirim ke Google Sheet pada ${esc(data.time)}.<ul>${li.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
      ['fileDet', 'fileDel'].forEach((id) => { $(id).value = ''; });
      ['nameDet', 'nameDel'].forEach((id) => { $(id).textContent = 'Belum ada file'; });
      ['checkDet', 'checkDel'].forEach((id) => { $(id).textContent = ''; });
      state.parsedDet = state.parsedDel = null;
      state.choices.clear();
      renderConflicts();
      loadData();
    } catch (err) {
      out.className = 'send-result err';
      out.textContent = 'Gagal mengirim: ' + err.message;
      $('btnSend').disabled = false;
    }
  });

  route();
  loadData();
  loadSupplier(false);
})();
