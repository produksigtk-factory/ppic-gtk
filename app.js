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
    takeout: { label: 'Take out', cls: 'b-takeout' },
    cancel: { label: 'Cancel', cls: 'b-cancel' },
  };
  // Baris yang tidak ditunggu lagi: sudah lengkap, atau di-take out (qty order 0)
  const isClosed = (r) => r.status === 'done' || r.status === 'takeout' || r.status === 'cancel';


  /* ---------- Urutkan lewat judul kolom (semua tabel) ---------- */
  // Klik pertama: arah bawaan kolom; klik kedua: dibalik; klik ketiga: kembali ke urutan semula.
  const colSort = { po: null, sup: null, act: null, log: null, chg: null, mat: null };
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
  const STATUS_ORDER = { late: 0, short: 1, wait: 2, none: 3, done: 4, takeout: 5, cancel: 6 };
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
    'po/perhatian':      { view: 'view-po-perhatian',      crumb: 'Purchase Order',            title: 'Perhatian Khusus', actions: 'po' },
    'po/riwayat':        { view: 'view-po-riwayat',        crumb: 'Purchase Order',            title: 'Riwayat Edit PO', actions: 'po' },
    'mrp/bom':           { view: 'view-mrp-bom',           crumb: 'MRP',                       title: 'Bill of Material', actions: 'mrp' },
    'mrp/material':      { view: 'view-mrp-material',      crumb: 'MRP',                       title: 'Daftar Material', actions: 'mrp' },
    'mrp/dipakai':       { view: 'view-mrp-dipakai',       crumb: 'MRP',                       title: 'Material Dipakai di Mana', actions: 'mrp' },
    'mrp/cek':           { view: 'view-mrp-cek',           crumb: 'MRP',                       title: 'Pemeriksaan Data MRP', actions: 'mrp' },
    'mrp/rencana':       { view: 'view-mrp-rencana',       crumb: 'MRP',                       title: 'Rencana Produksi', actions: 'mrp' },
    'mrp/kebutuhan':     { view: 'view-mrp-kebutuhan',     crumb: 'MRP',                       title: 'Kebutuhan Material', actions: 'mrp' },
    'mrp/proyeksi':      { view: 'view-mrp-proyeksi',      crumb: 'MRP',                       title: 'Proyeksi Stok', actions: 'mrp' },
    'mrp/sku':           { view: 'view-mrp-sku',           crumb: 'MRP',                       title: 'Parameter SKU', actions: 'mrp' },
    'mrp/update':        { view: 'view-mrp-update',        crumb: 'MRP',                       title: 'Update Data MRP', actions: 'mrp' },
    'po/supplier':       { view: 'view-po-supplier',       crumb: 'Purchase Order',            title: 'Supplier & MoQ',  actions: 'sup' },
    'csl/dashboard':     { view: 'view-csl-dashboard',     crumb: 'CSL Personal Care',         title: 'Dashboard CSL',   actions: 'csl' },
    'csl/region':        { view: 'view-csl-region',        crumb: 'CSL Personal Care',         title: 'Review Region',   actions: 'csl' },
    'csl/sku':           { view: 'view-csl-sku',           crumb: 'CSL Personal Care',         title: 'Rekap per SKU',   actions: 'csl' },
    'csl/os':            { view: 'view-csl-os',            crumb: 'CSL Personal Care',         title: 'Sisa SO',         actions: 'csl' },
    'csl/weekly':        { view: 'view-csl-weekly',        crumb: 'CSL Personal Care',         title: 'Weekly Review',   actions: 'csl' },
    'info/glosarium':    { view: 'view-info-glosarium',    crumb: 'Bantuan & Sistem',          title: 'Glosarium',       actions: '' },
    'info/kapasitas':    { view: 'view-info-kapasitas',    crumb: 'Bantuan & Sistem',          title: 'Kapasitas Google Sheet', actions: '' },
    'csl/amount':        { view: 'view-csl-amount',        crumb: 'CSL Personal Care',         title: 'Amount Check',    actions: 'csl' },
    'csl/analisa':       { view: 'view-csl-analisa',       crumb: 'CSL Personal Care',         title: 'Analisa Forecast', actions: 'csl' },
    'csl/suggest':       { view: 'view-csl-suggest',       crumb: 'CSL Personal Care',         title: 'Suggest Forecast', actions: 'csl' },
    'csl/musim':         { view: 'view-csl-musim',         crumb: 'CSL Personal Care',         title: 'Seasonal',        actions: 'csl' },
    'csl/update':        { view: 'view-csl-update',        crumb: 'CSL Personal Care',         title: 'Update Data CSL', actions: 'csl' },
    'csl/cek':           { view: 'view-csl-cek',           crumb: 'CSL Personal Care',         title: 'Pemeriksaan Data CSL', actions: 'csl' },
  };
  function route() {
    let key = location.hash.replace(/^#\/?/, '') || 'beranda';
    if (key === 'material/supplier') key = 'po/supplier';   // alamat lama
    const r = ROUTES[key] || ROUTES.beranda;
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== r.view; });
    // Menu: semua grup tertutup saat website dibuka; grup halaman yang sedang dibuka ikut terbuka
    const activeGroup = document.querySelector(`.menu-item[data-route="${ROUTES[key] ? key : 'beranda'}"]`)?.closest('.menu-group');
    if (activeGroup && !activeGroup.classList.contains('is-open')) {
      activeGroup.classList.add('is-open');
      activeGroup.querySelector('.menu-group-head').setAttribute('aria-expanded', 'true');
    }
    document.querySelectorAll('.menu-item').forEach((a) => {
      const on = a.dataset.route === (ROUTES[key] ? key : 'beranda');
      a.classList.toggle('is-active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    $('crumb').textContent = r.crumb;
    $('pageTitle').textContent = r.title;
    state.route = r;
    state.routeKey = ROUTES[key] ? key : 'beranda';
    const planView = PLAN_KEYS.has(state.routeKey);
    $('poActions').hidden = !r.actions;
    $('btnEditMode').hidden = r.actions === 'sup' || r.actions === 'csl' || (r.actions === 'mrp' && !planView);
    paintEditBtn();
    const sheet = r.actions === 'csl' ? ((window.CSL && window.CSL.sheetUrl()) || CFG.CSL_SHEET_URL) : r.actions === 'sup' ? (state.sup.dbUrl || CFG.DATABASE_URL) : planView ? (P.mrpUrl || CFG.MRP_SHEET_URL) : r.actions === 'mrp' ? (MRP.dbUrl || state.sup.dbUrl || CFG.DATABASE_URL) : CFG.SHEET_URL;
    $('lnkSheet').hidden = !sheet;
    if (sheet) $('lnkSheet').href = sheet;
    $('lnkSheet').title = r.actions === 'csl' ? 'Buka Google Sheet CSL PPIC GTK (SO, DO, forecast) di tab baru' : r.actions === 'sup' ? 'Buka Google Sheet DATABASE PPIC (tab SUPPLIER_MATERIAL) di tab baru'
      : planView ? 'Buka Google Sheet MRP PPIC GTK (rencana, SKU, stok) di tab baru'
      : r.actions === 'mrp' ? 'Buka Google Sheet DATABASE PPIC (MASTER_MATERIAL, BOM_LIST, BOM_DETAIL) di tab baru' : 'Buka Google Sheet MONITORING PO di tab baru';
    $('btnReload').title = r.actions === 'csl' ? 'Ambil data SO-DO dan forecast yang berubah dari Google Sheet CSL PPIC GTK' : r.actions === 'sup' ? 'Hitung ulang daftar supplier dari data PO terbaru dan isian MoQ'
      : r.actions === 'mrp' ? 'Ambil ulang BOM, rencana, dan stok dari Google Sheet' : 'Ambil ulang data terbaru dari Google Sheet MONITORING PO';
    document.title = `${r.title} · PPIC Gondowangi`;
    document.body.classList.toggle('lock-mon', r.view === 'view-po-monitoring');
    if (r.actions === 'mrp') { mrpEnter(key); renderDataInfo(); }
    else if (r.actions === 'csl') { if (window.CSL) window.CSL.enter(state.routeKey); }
    else if (state.routeKey.startsWith('info/')) { if (window.HELP) window.HELP.enter(state.routeKey); }
    else if (state.freshLoaded) renderDataInfo();
    else $('dataInfo').textContent = 'Memuat data…';
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
    const show = state.freshLoaded && r && ((r.actions && r.actions !== 'mrp' && r.actions !== 'csl') || r.view === 'view-beranda');
    box.hidden = !show;
    if (!show) return;
    const ut = uploadTimes();
    const whenOf = (t) => { const d = String(t).slice(0, 10), c = String(t).slice(11, 16); return d === todayStr() ? `hari ini ${c}` : `${fmtDate(d)} ${c}`; };
    let level, title, note;
    if (!ut.det && !ut.del) {
      level = 'late';
      title = 'Belum ada upload lewat website.';
      note = 'Catatan perubahan dan ketepatan kirim baru terisi setelah export Odoo di-upload di menu Update Data PO.';
    } else {
      // Dinilai dari file yang paling lama tidak diperbarui
      const files = [['PO-DET', ut.det], ['PO-DEL', ut.del]].map(([f, t]) => ({ f, t, n: t ? workdaysSince(String(t).slice(0, 10)) : Infinity }));
      const worst = files.reduce((a, b2) => (b2.n > a.n ? b2 : a));
      note = files.map((x) => `${x.f}: ${x.t ? whenOf(x.t) : 'belum pernah'}`).join(' · ') + '.';
      if (worst.n >= FRESH_LATE) {
        level = 'late';
        title = worst.n === Infinity ? `${worst.f} belum pernah di-upload lewat website.` : `${worst.f} sudah ${worst.n} hari kerja tidak diperbarui.`;
        note += worst.f === 'PO-DEL' ? ' Status, shortage, dan kalender bisa sudah tidak sesuai Odoo.' : ' PO dan baris baru dari Odoo bisa belum masuk.';
      } else if (worst.n >= FRESH_WARN) {
        level = 'warn';
        title = `${worst.f} terakhir diperbarui ${worst.n} hari kerja lalu.`;
        note += ' Sebaiknya upload export Odoo terbaru.';
      } else {
        level = 'ok';
        title = 'Data PO terkini.';
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
      if (isClosed(r) || seen.has(k)) return; seen.add(k);
      r.sched.forEach((s) => { if (s.status !== 'Done' && s.date >= today && s.date <= plus7) week++; });
    });
    $('hOpen').textContent = nf.format(rows.filter((r) => !isClosed(r)).length);
    $('hLate').textContent = nf.format(rows.filter((r) => r.shortage > 0).length);
    $('hWeek').textContent = nf.format(week);
  }


  /* ---------- Ambil data ---------- */
  async function loadData() {
    if (!CFG.APPS_SCRIPT_URL) { showSetup(); return; }
    $('dataInfo').textContent = 'Memuat data dari Google Sheet…';
    $('btnReload').disabled = true;
    if (!state.rows.length) $('rows').innerHTML = '<tr class="empty"><td colspan="10">Memuat data dari Google Sheet, biasanya 5–10 detik…</td></tr>';
    state.loadErr = '';
    try {
      const res = await fetch(CFG.APPS_SCRIPT_URL, { method: 'GET' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Respon tidak valid');
      state.raw = { lines: data.lines, schedules: data.schedules };
      setManual(data.manual);
      state.editLog = data.editLog || [];
      setFollow(data.followups);
      setCancel(data.cancels);
      state.noCancelScript = !Array.isArray(data.cancels);
      state.changes = data.changes || [];
      state.noFollowScript = !Array.isArray(data.followups);
      if (!Array.isArray(data.manual)) state.oldScript = true;   // Apps Script versi lama (belum mendukung edit)
      state.lastUpload = data.lastUpload || null;
      state.freshLoaded = true;
      renderFresh();
      state.readAt = data.readAt || '';
      refreshAll();
    } catch (err) {
      state.loadErr = err.message;
      tasksRefresh();
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

  // PO / baris yang di-cancel lewat website: Map "PO|kode" (kode kosong = seluruh PO) → { reason, time, by }
  function setCancel(list) {
    state.cancel = new Map((list || []).map((c) => [c[0] + '|' + c[1], { po: c[0], code: c[1], reason: c[2], time: c[3], by: c[4] }]));
  }
  const cancelOf = (po, code) => (state.cancel ? state.cancel.get(po + '|') || state.cancel.get(po + '|' + code) || null : null);

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
    renderAttention();
    renderDataInfo();
    tasksRefresh();
    if (MRP.loaded) { refreshMrpHome(); if (PLAN_KEYS.has(state.routeKey)) renderPlanView(state.routeKey); }
  }

  // Baris info di bawah judul: kapan terakhir di-upload, kapan terakhir direvisi manual, kapan data dibaca
  function whenText(t) {
    if (!t) return 'belum ada';
    const s = String(t), date = s.slice(0, 10), clock = s.slice(11, 16);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return s;
    return `${date === todayStr() ? 'hari ini' : fmtDate(date)}${clock ? ' ' + clock : ''}`;
  }
  // Waktu upload terakhir per file. Apps Script lama hanya mengirim baris LOG_UPLOAD terakhir.
  function uploadTimes() {
    const up = state.lastUpload;
    if (!up) return { det: '', del: '' };
    if ('detTime' in up) return { det: up.detTime || '', del: up.delTime || '' };
    return { det: up.det ? up.time : '', del: up.del ? up.time : '' };
  }
  function renderDataInfo() {
    if (state.route && (state.route.actions === 'csl' || state.routeKey.startsWith('info/'))) return;   // diisi csl.js / help.js
    if (state.route && state.route.actions === 'mrp') {
      if (MRP.loaded) $('dataInfo').textContent = PLAN_KEYS.has(state.routeKey) && P.ready
        ? `Rencana, SKU, dan stok dibaca dari MRP PPIC GTK ${whenText(MRP.readAt)}${P.stockDate ? ` · stok per ${fmtDate(P.stockDate)}` : ' · belum ada data stok'}`
        : `BOM dan material dibaca dari DATABASE PPIC ${whenText(MRP.readAt)}`;
      return;
    }
    if (!state.freshLoaded) return;
    const ut = uploadTimes();
    const ed = state.editLog && state.editLog[0] && state.editLog[0][0];
    const parts = [`Upload PO-DET: ${whenText(ut.det)}`, `Upload PO-DEL: ${whenText(ut.del)}`, `Revisi manual: ${whenText(ed)}`];
    if (state.readAt) parts.push(`Data dibaca ${whenText(state.readAt)}`);
    $('dataInfo').textContent = parts.join(' · ');
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
      // Baris qty 0 = take out: tidak ikut menerima pembagian qty diterima/shortage (kecuali semua baris take out)
      const activeIdx = items.map((it, i) => ((Number(it.l[6]) || 0) > 0 ? i : -1)).filter((i) => i >= 0);
      const lastActive = activeIdx.length ? activeIdx[activeIdx.length - 1] : items.length - 1;

      items.forEach(({ idx, l }, i) => {
        const qty = Number(l[6]) || 0;
        const takeout = qty <= 0;
        const isLast = i === lastActive;
        const rec = isLast ? remain : (takeout ? 0 : Math.min(qty, remain));   // penerimaan dibagi berurutan ke baris kode yang sama
        remain -= rec;
        const sisa = qty - rec;
        const cancel = cancelOf(l[0], l[3]);
        let status;
        if (cancel) status = 'cancel';
        else if (takeout) status = 'takeout';
        else if (sisa <= 0) status = 'done';
        else if (hasLate) status = 'late';
        else if (shortage > 0) status = 'short';
        else if (pending.length) status = 'wait';
        else status = 'none';
        const short = !activeIdx.length || takeout ? 0 : isLast ? shortRemain : Math.min(Math.max(0, sisa), shortRemain);
        shortRemain -= short;
        const price = l[8] === '' ? 0 : Number(l[8]);

        const date = normDate(l[1]);
        rows.push({
          key: k + '|' + l[10], idx,
          po: l[0], date, month: date.slice(0, 7), supplier: l[2], code: l[3], name: l[4], jenis: l[5],
          qty, uom: l[7], price: l[8], kurs: l[9], lineKe: l[10], dupCount: items.length,
          amount: l[8] === '' ? 0 : qty * Number(l[8]),
          pendingDates: takeout || cancel ? [] : pending.map((s) => s.date).filter(Boolean),
          manual: state.manual ? state.manual.get(l[0]) || null : null,
          follow: state.follow ? state.follow.get(k) || null : null,
          rec, sisa, status, sched, next: takeout || cancel ? null : next, today, first: i === 0, takeout, cancel,
          shortage: cancel ? 0 : short, lateDays: short && !cancel ? lateDays : 0, oldestLate: short && !cancel ? oldest : '',
          sisaValue: cancel ? 0 : Math.max(0, sisa) * price, shortValue: cancel ? 0 : short * price,
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
    if (isClosed(r)) return false;   // baris yang sudah lengkap / take out tidak menunggu kedatangan lagi
    const t = todayStr();
    const d = r.pendingDates;
    if (v === 'none') return !isClosed(r) && !d.length;
    if (v === 'late') return d.some((x) => x < t);
    if (v === 'today') return d.includes(t);
    if (v === 'week') { const e = ymd(new Date(Date.now() + 7 * 86400000)); return d.some((x) => x >= t && x <= e); }
    if (v === 'month') { const m = t.slice(0, 7); return d.some((x) => x.slice(0, 7) === m); }
    return true;
  }

  const DATE_TYPE = { order: 'Tgl order', sched: 'Tgl jadwal kirim', pending: 'Tgl jadwal belum datang' };
  function matchDate(r, type, from, to) {
    if (!from && !to) return true;
    const ok = (x) => !!x && (!from || x >= from) && (!to || x <= to);
    if (type === 'order') return ok(r.date);
    if (type === 'pending') return r.sched.some((s) => s.status !== 'Done' && ok(s.date));
    return r.sched.some((s) => ok(s.date));
  }
  const FOLLOW_LABEL = { todo: 'Shortage belum di-follow up', 'promise-late': 'Janji kirim sudah lewat', has: 'Ada catatan follow-up' };
  function matchFollow(r, v) {
    const f = r.follow;
    if (v === 'todo') return r.shortage > 0 && (!f || f.status === 'Belum dihubungi');
    if (v === 'promise-late') return !isClosed(r) && f && f.promise && f.promise < todayStr();
    if (v === 'has') return !!f;
    return f && f.status === v;
  }

  // Saringan khusus dari klik grafik di Dashboard PO
  function matchDrill(r, dr) {
    if (dr.type === 'arrive') {          // ada jadwal belum Done pada rentang tanggal
      return !isClosed(r) && r.pendingDates.some((x) => x >= dr.from && x <= dr.to);
    }
    if (dr.type === 'age') return r.shortage > 0 && r.lateDays >= dr.min && r.lateDays <= dr.max;
    return true;
  }

  // Semua saringan kecuali bulan (dipakai juga untuk angka di tab bulan)
  function filteredNoMonth(withCancel) {
    const q = $('q').value.trim().toLowerCase();
    const jenis = $('fJenis').value, sup = $('fSupplier').value, kurs = $('fKurs').value, arr = $('fArrive').value;
    const man = $('fManual').value, fol = $('fFollow').value;
    const dType = $('fDateType').value, dFrom = $('fFrom').value, dTo = $('fTo').value;
    const dr = state.drill;
    return state.rows.filter((r) =>
      (!dr || matchDrill(r, dr)) &&
      (!fol || matchFollow(r, fol)) &&
      (!q || q.split(/\s+/).every((w) => r.search.includes(w))) &&
      (!man || (man === 'yes' ? !!r.manual : !r.manual)) &&
      jenisOk(r, jenis) &&
      (!sup || r.supplier === sup) &&
      (!kurs || r.kurs === kurs) &&
      matchArrive(r, arr) &&
      matchDate(r, dType, dFrom, dTo) &&
      (withCancel || r.status !== 'cancel'));        // baris cancel disembunyikan kecuali tombol Cancel dipilih
  }
  const byMonth = (rows) => { const m = activeMonth(); return m === 'all' ? rows : rows.filter((r) => r.month === m); };

  const byStatus = (rows, st) => st === 'all' ? rows.filter((r) => r.status !== 'cancel')
    : st === 'open' ? rows.filter((r) => !isClosed(r))
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
    // Bulan, status, cari, supplier, dan jenis sudah terlihat di baris atas; chip hanya untuk saringan lain
    if (state.drill) chips.push(['drill', state.drill.label]);
    const df = $('fFrom').value, dt = $('fTo').value;
    if (df || dt) chips.push(['date', `${DATE_TYPE[$('fDateType').value]}: ${df ? fmtDate(df) : '…'} – ${dt ? fmtDate(dt) : '…'}`]);
    $('activeFilters').innerHTML = chips.map(([k, t]) =>
      `<button class="chip" data-clear="${k}" title="Hapus saringan ini">${esc(t)}<span class="chip-x" aria-hidden="true">×</span><span class="sr">hapus</span></button>`).join('');
    // Saringan yang sedang dipakai diberi tanda supaya mudah terlihat
    ['q', 'fSupplier', 'fArrive', 'fKurs', 'fFollow', 'fManual', 'fFrom', 'fTo'].forEach((id) => $(id).classList.toggle('is-set', !!$(id).value));
    $('fJenis').classList.toggle('is-set', $('fJenis').value !== RMPM);
  }

  /* ---------- Tampilan ---------- */
  function render() {
    const noMonth = filteredNoMonth(state.status === 'cancel');
    renderMonthBar(noMonth);
    renderActiveFilters();
    const base = byMonth(noMonth);
    const live = base.filter((r) => r.status !== 'cancel');      // angka status tidak menghitung baris cancel
    $('cAll').textContent = nf.format(live.length);
    $('cOpen').textContent = nf.format(byStatus(live, 'open').length);
    $('cLate').textContent = nf.format(byStatus(live, 'late').length);
    $('cDone').textContent = nf.format(byStatus(live, 'done').length);
    const nTake = byStatus(live, 'takeout').length;
    $('cTakeout').textContent = nf.format(nTake);
    $('cTakeout').closest('.stat').hidden = !nTake && state.status !== 'takeout';   // hanya muncul bila ada baris take out
    const nCancel = byMonth(filteredNoMonth(true)).filter((r) => r.status === 'cancel').length;
    $('cCancel').textContent = nf.format(nCancel);
    $('cCancel').closest('.stat').hidden = !nCancel && state.status !== 'cancel';
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
    $('btnMsg').hidden = !$('fSupplier').value;
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
    let html = `<tr class="row${open ? ' is-open' : ''}${r.status === 'takeout' || r.status === 'cancel' ? ' is-takeout' : ''}" data-key="${esc(r.key)}" tabindex="0" aria-expanded="${open}">
      <td class="po">${esc(r.po)}${man}</td>
      <td class="date">${fmtDate(r.date)}</td>
      <td class="supplier">${esc(r.supplier)}</td>
      <td><div class="mat-name">${esc(r.name)}</div><div class="mat-code">${esc(r.code)}${r.jenis ? ' · ' + esc(r.jenis) : ''}</div>${note}</td>
      <td class="num">${fmtNum(r.qty)} ${esc(r.uom)}<div class="strip-cap">diterima ${fmtNum(r.rec)}</div></td>
      <td class="num">${r.sisa > 0 ? fmtNum(r.sisa) : '0'}</td>
      <td class="num">${r.shortage > 0 ? `<span class="short-qty">${fmtNum(r.shortage)}</span><div class="strip-cap short-cap">${r.lateDays ? r.lateDays + ' hari' : 'kurang kirim'}</div>` : '<span class="muted">–</span>'}</td>
      <td>${stripHtml(r)}</td>
      <td class="date">${next}</td>
      <td><span class="badge ${st.cls}" ${r.cancel ? `title="${esc(r.cancel.reason)}"` : ''}>${st.label}${r.cancel && !r.cancel.code ? ' PO' : ''}</span>${r.cancel ? `<div class="cancel-why">${esc(r.cancel.reason)}</div>` : followChip(r)}</td>
    </tr>`;
    if (open) html += detailHtml(r);
    return html;
  }

  function followChip(r) {
    const f = r.follow;
    if (!f) return r.shortage > 0 ? '<div class="fu fu-todo">Belum di-follow up</div>' : '';
    const late = f.promise && f.promise < todayStr() && !isClosed(r);
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
    return `<section class="dt-card fu-box"><div class="fu-box-head"><h4 class="dt-h">Follow-up</h4>
      ${ed ? '<button type="button" class="btn btn-sm" data-act="follow">Isi follow-up</button>' : '<span class="hint">Aktifkan Mode edit untuk mengisi.</span>'}</div>${body}</section>`;
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
        flashRow(state.openKey);
        return `Follow-up ${r.po} / ${r.code} tersimpan ${savedAt(res)}`;
      },
    });
  }

  function detailHtml(r) {
    const ed = state.edit.on;
    const u = esc(r.uom), k = esc(r.kurs);
    const pct = r.qty ? Math.round(Math.min(Math.max(r.rec, 0), r.qty) / r.qty * 100) : 0;
    const money = (v) => (r.price === '' ? '–' : `${fmtNum(Math.round(v))} <small>${k}</small>`);

    // Ringkasan: angka penting dalam kotak-kotak kecil
    const tile = (label, value, sub, cls = '') =>
      `<div class="dt-tile ${cls}"><span class="dt-k">${label}</span><span class="dt-v">${value}</span>${sub ? `<span class="dt-sub">${sub}</span>` : ''}</div>`;
    const tiles = [
      tile('Harga satuan', r.price === '' ? '–' : money(Number(r.price))),
      tile('Nilai baris PO', r.price === '' ? '–' : money(r.qty * Number(r.price))),
      tile('Sudah diterima', `${fmtNum(r.rec)} <small>/ ${fmtNum(r.qty)} ${u}</small>`,
        `<span class="dt-bar"><i style="width:${pct}%"></i></span>${pct}% · sisa ${fmtNum(Math.max(0, r.sisa))} ${u}`),
      r.shortage > 0
        ? tile('Shortage', `${fmtNum(r.shortage)} <small>${u}</small>`,
          (r.lateDays ? `Terlambat ${r.lateDays} hari, sejak ${fmtDate(r.oldestLate)}` : 'Kurang kirim')
          + (r.shortValue ? `<br>Nilai ${fmtNum(Math.round(r.shortValue))} ${k}` : ''), 'is-late')
        : tile('Jadwal berikutnya', r.next ? fmtDate(r.next.date) : '–',
          r.next ? `${fmtNum(r.next.qty)} ${u}` : (r.status === 'done' ? 'Sudah lengkap' : r.status === 'cancel' ? 'Di-cancel, tidak ditunggu' : r.status === 'takeout' ? 'Qty order 0 (take out)' : 'Belum ada jadwal'), r.status === 'done' ? 'is-done' : ''),
    ].join('');

    // Jadwal pengiriman
    const sRows = r.sched.length ? r.sched.map((s) => {
      const late = s.status !== 'Done' && s.date && s.date < r.today;
      const pill = s.status === 'Done' ? '<span class="pill pill-done">Sudah datang</span>'
        : late ? `<span class="pill pill-late">Lewat ${daysBetween(s.date, r.today)} hari</span>`
        : s.date ? '<span class="pill pill-wait">Menunggu</span>' : '<span class="pill">Belum ada tanggal</span>';
      const act = ed ? `<td class="row-actions">
          <button type="button" class="btn-link" data-act="editSched" data-n="${s.n}">Ubah</button>
          <button type="button" class="btn-link danger" data-act="delSched" data-n="${s.n}">Hapus</button></td>` : '';
      return `<tr><td class="c-n">${s.n}</td><td class="c-date">${fmtDate(s.date)}</td>
        <td class="num">${fmtNum(s.qty)}</td><td class="num">${fmtNum(s.rec)}</td>
        <td class="num">${s.short ? `<b class="short-qty">${fmtNum(s.short)}</b>` : '<span class="muted">–</span>'}</td>
        <td>${pill}<span class="odoo-st">${esc(s.status || '')}</span></td>${act}</tr>`;
    }).join('') : `<tr><td colspan="${ed ? 7 : 6}" class="muted">Belum ada jadwal pengiriman.</td></tr>`;

    const notes = [];
    if (r.cancel) notes.push(`<b>Di-cancel ${r.cancel.code ? 'baris ini' : 'seluruh ' + esc(r.po)}</b> pada ${esc(r.cancel.time)}. Alasan: ${esc(r.cancel.reason)}. Tidak dihitung di status, shortage, Dashboard, Kalender, dan MoQ. Tanda cancel tidak tertimpa upload Odoo.`);
    if (r.dupCount > 1) notes.push(`Kode ${esc(r.code)} muncul ${r.dupCount}× di ${esc(r.po)}. Odoo tidak membedakan jadwalnya, jadi jadwal di atas adalah gabungan dan qty diterima dibagi berurutan ke tiap baris.`);
    if (r.manual) notes.push(`PO ini pernah diedit manual (${[r.manual.lines && 'baris PO', r.manual.sched && 'jadwal'].filter(Boolean).join(' dan ')}) pada ${esc(r.manual.time)}. Saat upload export Odoo berikutnya, Anda akan ditanya mau memakai data Odoo atau mempertahankan edit ini.`);

    const tools = ed ? `<div class="detail-tools" data-key="${esc(r.key)}">
        <button type="button" class="btn btn-sm" data-act="editLine">Ubah baris PO</button>
        <button type="button" class="btn btn-sm" data-act="addSched">Tambah jadwal</button>
        <button type="button" class="btn btn-sm btn-danger" data-act="delLine">Hapus baris PO</button>
        <span class="tools-sep" aria-hidden="true"></span>
        ${r.cancel ? `<button type="button" class="btn btn-sm btn-ghost" data-act="uncancel">Aktifkan lagi ${r.cancel.code ? 'baris' : 'PO'}</button>`
          : `<button type="button" class="btn btn-sm btn-cancel" data-act="cancelLine">Cancel baris</button>
             <button type="button" class="btn btn-sm btn-cancel" data-act="cancelPo">Cancel PO ${esc(r.po)}</button>`}
      </div>` : '';
    return `<tr class="detail"><td colspan="10"><div class="detail-box" data-key="${esc(r.key)}">
      ${tools}
      <div class="dt-tiles">${tiles}</div>
      <div class="dt-grid">
        <section class="dt-card">
          <h4 class="dt-h">Jadwal pengiriman <span class="muted">${r.sched.length} jadwal</span></h4>
          <div class="sched-wrap"><table class="sched"><thead><tr><th>Ke</th><th>Tanggal</th><th class="num">Qty jadwal</th><th class="num">Diterima</th><th class="num">Kurang</th><th>Status</th>${ed ? '<th></th>' : ''}</tr></thead>
          <tbody>${sRows}</tbody></table></div>
        </section>
        ${followBox(r)}
      </div>
      ${notes.map((n, i) => `<p class="dt-note${r.cancel && i === 0 ? ' is-cancel' : r.manual && i === notes.length - 1 ? ' is-manual' : ''}">${n}</p>`).join('')}
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
    else if (k === 'date') { $('fFrom').value = ''; $('fTo').value = ''; }
    else $(k).value = '';
    state.shown = PAGE; render();
  });

  $('btnReset').addEventListener('click', () => {
    ['q', 'fSupplier', 'fKurs', 'fArrive', 'fManual', 'fFollow', 'fFrom', 'fTo'].forEach((id) => { $(id).value = ''; });
    $('fDateType').value = 'order';
    $('fJenis').value = RMPM;
    $('fSort').value = 'date-asc';
    colSort.po = null;
    state.drill = null;
    state.status = 'all'; state.month = null; state.shown = PAGE; state.openKey = null; state.monthScrolled = false; render();
  });
  $('btnMore').addEventListener('click', () => { state.shown += PAGE; render(); });
  // Baris berikutnya dimuat otomatis saat tabel digulir mendekati bawah
  $('monWrap').addEventListener('scroll', () => {
    const w = $('monWrap');
    if (!$('btnMore').hidden && w.scrollTop + w.clientHeight > w.scrollHeight - 300) { state.shown += PAGE; render(); }
  }, { passive: true });
  // Saring tanggal: Tgl order, Tgl jadwal kirim (semua), Tgl jadwal belum datang
  const quickRange = (v) => {
    const t = new Date(), y = t.getFullYear(), m = t.getMonth(), d = (x) => ymd(x);
    const add = (n) => { const x = new Date(); x.setDate(x.getDate() + n); return d(x); };
    if (v === 'today') return [d(t), d(t)];
    if (v === 'last7') return [add(-6), d(t)];
    if (v === 'next7') return [d(t), add(7)];
    if (v === 'thism') return [d(new Date(y, m, 1)), d(new Date(y, m + 1, 0))];
    if (v === 'lastm') return [d(new Date(y, m - 1, 1)), d(new Date(y, m, 0))];
    if (v === 'nextm') return [d(new Date(y, m + 1, 1)), d(new Date(y, m + 2, 0))];
    return null;
  };
  const dateChanged = () => {
    if (($('fFrom').value || $('fTo').value) && activeMonth() !== 'all') state.month = 'all';   // supaya tidak bertabrakan dengan tab bulan
    state.shown = PAGE; render();
  };
  $('fQuick').addEventListener('change', () => {
    const r = quickRange($('fQuick').value);
    if (r) { $('fFrom').value = r[0]; $('fTo').value = r[1]; }
    $('fQuick').value = '';
    dateChanged();
  });
  ['fFrom', 'fTo'].forEach((id) => $(id).addEventListener('change', dateChanged));
  $('fDateType').addEventListener('change', () => { if ($('fFrom').value || $('fTo').value) dateChanged(); });
  $('btnMsg').addEventListener('click', () => openSupplierMsg({ supplier: $('fSupplier').value, from: 'mon' }));
  $('btnReload').addEventListener('click', () => (state.route && state.route.actions === 'csl' ? (window.CSL && window.CSL.reload())
    : state.route && state.route.actions === 'sup' ? loadSupplier(true)
    : state.route && state.route.actions === 'mrp' ? loadMrp(true) : loadData()));

  const toggleRow = (tr) => {
    const k = tr.dataset.key; state.openKey = state.openKey === k ? null : k; render();
    if (state.openKey) scrollRowTop(state.openKey);
  };
  // Geser tabel supaya baris yang dibuka ada di atas dan rinciannya terlihat
  function scrollRowTop(key) {
    const w = $('monWrap'), tr = document.querySelector(`#rows tr.row[data-key="${CSS.escape(key)}"]`);
    if (!w || !tr) return;
    const head = w.querySelector('thead');
    const top = tr.getBoundingClientRect().top - w.getBoundingClientRect().top + w.scrollTop - (head ? head.offsetHeight : 0);
    if (w.scrollHeight > w.clientHeight) w.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    else tr.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
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
      'Alasan Cancel': r.cancel ? r.cancel.reason : '',
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
    return state.rows.filter((r) => r.status !== 'cancel' && jenisOk(r, j) && (!sp || r.supplier === sp));
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
    el.innerHTML = items.map((x, i) => {
      const bar = `
      <button class="hbar ${x.cls || ''}" data-i="${i}" data-tip="${esc(x.tip)}" aria-label="${esc(x.label + ': ' + x.tip)}">
        <span class="hbar-label">${esc(x.label)}</span>
        <span class="hbar-track"><span class="hbar-fill" style="width:${x.value ? Math.max(1.5, x.value / max * 100) : 0}%"></span></span>
        <span class="hbar-val">${esc(x.text)}</span>
      </button>`;
      return x.msg ? `<div class="hbar-wrap">${bar}<button class="btn btn-ghost btn-xs" data-msg="${i}" title="Buat pesan follow-up untuk ${esc(x.label)}">Pesan</button></div>` : bar;
    }).join('');
    el._items = items;
  }

  function renderDash() {
    if (!state.rows.length) return;
    fillDashOptions();
    const rows = dashRows();
    const today = todayStr(), plus7 = dayAdd(today, 7);
    const isIdr = (r) => String(r.kurs).toUpperCase() === 'IDR';

    // KPI
    const open = rows.filter((r) => !isClosed(r));
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
      tip: `${nf.format(x.n)} baris shortage · ${fmtRp(x.v)}`, go: { supplier: sup, status: 'late', sort: 'late-desc' }, msg: true,
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
    ['q', 'fArrive', 'fKurs', 'fManual', 'fFollow', 'fFrom', 'fTo'].forEach((id) => { $(id).value = ''; });
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
    const mb = e.target.closest('[data-msg]');
    if (mb) {
      const it = mb.closest('.hbars')._items[Number(mb.dataset.msg)];
      if (it) openSupplierMsg({ supplier: it.label, from: 'dash' });
      return;
    }
    const bar = e.target.closest('.vbar, .hbar');
    if (bar) {
      const box = bar.parentElement._items ? bar.parentElement : bar.closest('.hbars');
      const it = box && box._items[Number(bar.dataset.i)];
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
    const out = [], seen = new Set();
    state.rows.forEach((r) => {
      if (!jenisOk(r, j) || (sp && r.supplier !== sp) || isClosed(r)) return;
      const k = r.po + '|' + r.code;
      if (seen.has(k)) return;          // jadwal dicatat sekali per PO + kode, pada baris pertama yang masih ditunggu
      seen.add(k);
      r.sched.forEach((s) => {
        if (s.status === 'Done' || !s.date) return;
        const gap = Math.max(0, (Number(s.qty) || 0) - (Number(s.rec) || 0));
        if (gap) out.push({ date: s.date, r, qty: gap, kind: s.date < today ? 'late' : 'wait' });
      });
      if (r.follow && r.follow.promise) out.push({ date: r.follow.promise, r, qty: r.shortage || Math.max(0, r.sisa), kind: 'promise' });
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
      const label = `${dayLong.format(new Date(d + 'T00:00:00'))}: ${n.wait} akan datang, ${n.late} lewat jadwal, ${n.promise} janji kirim`;
      html += `<button class="${cls}" data-d="${d}" role="gridcell" aria-label="${esc(label)}" aria-pressed="${d === sel}">
        <span class="cal-num">${+d.slice(8)}</span>
        <span class="cal-counts">${n.late ? `<span class="cc cc-late"><b>${n.late}</b><span class="cc-t"> lewat jadwal</span></span>` : ''}${n.wait ? `<span class="cc cc-wait"><b>${n.wait}</b><span class="cc-t"> akan datang</span></span>` : ''}${n.promise ? `<span class="cc cc-promise"><b>${n.promise}</b><span class="cc-t"> janji kirim</span></span>` : ''}${list.length ? `<span class="cc-sup">${new Set(list.map((it) => it.r.supplier)).size} supplier</span>` : ''}</span>
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



  /* ---------- Perhatian Khusus ---------- */
  // 1) Jadwal di PO-DEL yang PO/kodenya tidak ada di baris PO  2) Total qty jadwal ≠ qty order
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  function orphanGroups(lineKeys, linePOs, schedules) {
    const g = new Map();
    schedules.forEach((x) => {
      const k = x[0] + '|' + x[1];
      if (lineKeys.has(k)) return;
      const o = g.get(k) || { po: x[0], code: x[1], name: x[2], n: 0, qty: 0, rec: 0, first: '', poKnown: linePOs.has(x[0]) };
      o.n++; o.qty += Number(x[4]) || 0; o.rec += Number(x[5]) || 0;
      const d = normDate(x[6]); if (d && (!o.first || d < o.first)) o.first = d;
      g.set(k, o);
    });
    return [...g.values()].sort((a, b) => (a.po < b.po ? -1 : a.po > b.po ? 1 : a.code < b.code ? -1 : 1));
  }
  function attentionData() {
    const lines = state.raw.lines || [], sch = state.raw.schedules || [];
    const lineKeys = new Set(lines.map((l) => l[0] + '|' + l[3]));
    const orphans = orphanGroups(lineKeys, new Set(lines.map((l) => l[0])), sch);
    const sq = new Map();
    sch.forEach((x) => { const k = x[0] + '|' + x[1]; sq.set(k, (sq.get(k) || 0) + (Number(x[4]) || 0)); });
    const groups = new Map();
    state.rows.forEach((r) => {
      if (r.status === 'cancel') return;                // yang di-cancel dicek di daftar tersendiri
      const k = r.po + '|' + r.code;
      const g = groups.get(k) || { r, qty: 0 };
      g.qty += r.qty; groups.set(k, g);
    });
    const mism = [], takeout = [];
    groups.forEach((g, k) => {
      if (g.qty <= 0) {                            // semua baris kode ini take out (qty 0)
        const pend = g.r.sched.filter((x) => x.status !== 'Done').reduce((t, x) => t + Math.max(0, (Number(x.qty) || 0) - (Number(x.rec) || 0)), 0);
        const rec = g.r.sched.reduce((t, x) => t + (Number(x.rec) || 0), 0);
        const nPend = g.r.sched.filter((x) => x.status !== 'Done' && (Number(x.qty) || 0) > (Number(x.rec) || 0)).length;
        if (pend > 0 || rec > 0) takeout.push({ r: g.r, pend, rec, nPend, next: g.r.sched.filter((x) => x.status !== 'Done' && x.date).map((x) => x.date).sort()[0] || '' });
        return;                                    // tidak dihitung lagi di "Total jadwal ≠ qty order"
      }
      if (!sq.has(k)) return;                      // belum ada jadwal: bukan selisih
      const tot = sq.get(k);
      if (!near(tot, g.qty)) mism.push({ r: g.r, qty: g.qty, tot, diff: tot - g.qty });
    });
    const byDate = (a, b) => (a.r.date < b.r.date ? -1 : a.r.date > b.r.date ? 1 : a.r.po < b.r.po ? -1 : a.r.po > b.r.po ? 1 : a.r.idx - b.r.idx);
    mism.sort(byDate); takeout.sort(byDate);
    // Di-cancel di website tetapi di export Odoo masih aktif (qty order > 0)
    const cancelled = [];
    (state.cancel ? [...state.cancel.values()] : []).forEach((c) => {
      const rs = state.rows.filter((r) => r.po === c.po && (!c.code || r.code === c.code));
      const qty = rs.reduce((t, r) => t + r.qty, 0);
      if (!rs.length || qty <= 0) return;
      const seen = new Set(); let pend = 0, rec = 0;
      rs.forEach((r) => {
        const k = r.po + '|' + r.code; if (seen.has(k)) return; seen.add(k);
        r.sched.forEach((x) => { rec += Number(x.rec) || 0; if (x.status !== 'Done') pend += Math.max(0, (Number(x.qty) || 0) - (Number(x.rec) || 0)); });
      });
      cancelled.push({ c, r: rs[0], n: rs.length, qty, uom: rs[0].uom, pend, rec });
    });
    cancelled.sort((a, b) => (a.c.time > b.c.time ? -1 : 1));
    return { orphans, mism, takeout, cancelled };
  }
  function renderAttention() {
    if (!state.rows) return;
    const { orphans, mism, takeout, cancelled } = attentionData();
    const q = ($('aq').value || '').trim().toLowerCase(), j = $('aJenis').value;
    const hit = (t) => !q || q.split(/\s+/).every((w) => t.toLowerCase().includes(w));
    const o = orphans.filter((x) => hit(`${x.po} ${x.code} ${x.name}`));
    const m = mism.filter((x) => jenisOk(x.r, j) && hit(x.r.search));
    const t = takeout.filter((x) => jenisOk(x.r, j) && hit(x.r.search));
    $('aTakeoutN').textContent = nf.format(t.length);
    $('aTakeout').innerHTML = t.length ? t.map((x) => {
      const r = x.r, u = esc(r.uom);
      const ket = [x.pend > 0 ? `Masih ada ${x.nPend} jadwal belum Done (${fmtNum(x.pend)} ${u})` : '', x.rec > 0 ? `Sudah diterima ${fmtNum(x.rec)} ${u}` : ''].filter(Boolean).join('; ');
      return `<tr class="row" data-key="${esc(r.key)}" tabindex="0">
        <td class="po">${esc(r.po)}</td><td class="date">${fmtDate(r.date)}</td><td class="supplier">${esc(r.supplier)}</td>
        <td><div class="mat-name">${esc(r.name)}</div><div class="mat-code">${esc(r.code)}${r.jenis ? ' · ' + esc(r.jenis) : ''}</div></td>
        <td class="num">${x.pend > 0 ? fmtNum(x.pend) + ' ' + u : '–'}</td><td class="date">${x.next ? fmtDate(x.next) : '–'}</td>
        <td class="num">${x.rec > 0 ? fmtNum(x.rec) + ' ' + u : '–'}</td><td>${ket}</td></tr>`;
    }).join('') : '<tr class="empty"><td colspan="8">Tidak ada. Semua baris take out sudah bersih dari jadwal dan penerimaan.</td></tr>';
    const cx = cancelled.filter((x) => jenisOk(x.r, j) || !x.c.code ? hit(`${x.c.po} ${x.c.code} ${x.r.supplier} ${x.c.reason}`) : false);
    $('aCancelN').textContent = nf.format(cx.length);
    $('aCancel').innerHTML = cx.length ? cx.map((x) => {
      const u = x.c.code ? esc(x.uom) : '';
      const ket = ['Di Odoo masih aktif' + (x.c.code ? ` (qty ${fmtNum(x.qty)} ${u})` : ` (${x.n} baris)`),
        x.pend > 0 ? `masih ada jadwal belum Done${x.c.code ? ` ${fmtNum(x.pend)} ${u}` : ''}` : '', x.rec > 0 ? 'sudah ada penerimaan' : ''].filter(Boolean).join('; ');
      return `<tr class="row" data-po="${esc(x.c.po)}" data-code="${esc(x.c.code)}" tabindex="0">
        <td class="po">${esc(x.c.po)}</td><td>${x.c.code ? `<div class="mat-name">${esc(x.r.name)}</div><div class="mat-code">${esc(x.c.code)}</div>` : '<b>Seluruh PO</b>'}</td>
        <td class="supplier">${esc(x.r.supplier)}</td><td>${esc(x.c.reason)}</td><td class="date">${esc(String(x.c.time).slice(0, 16))}</td><td>${ket}.</td></tr>`;
    }).join('') : '<tr class="empty"><td colspan="6">Tidak ada. Semua yang di-cancel sudah tidak aktif di export Odoo.</td></tr>';
    $('aOrphanN').textContent = nf.format(o.length);
    $('aMismatchN').textContent = nf.format(m.length);
    $('aOrphan').innerHTML = o.length ? o.map((x) => `<tr>
        <td class="po">${esc(x.po)}</td>
        <td><div class="mat-name">${esc(x.name)}</div><div class="mat-code">${esc(x.code)}</div></td>
        <td class="num">${x.n}</td><td class="num">${fmtNum(x.qty)}</td><td class="num">${fmtNum(x.rec)}</td>
        <td class="date">${fmtDate(x.first)}</td>
        <td>${x.poKnown ? 'Kode ini tidak ada di baris PO tersebut' : 'PO belum ada di data PO (PO-DET)'}</td></tr>`).join('')
      : '<tr class="empty"><td colspan="7">Tidak ada. Semua jadwal punya baris PO.</td></tr>';
    $('aMismatch').innerHTML = m.length ? m.map((x) => {
      const r = x.r, u = esc(r.uom);
      return `<tr class="row" data-key="${esc(r.key)}" tabindex="0">
        <td class="po">${esc(r.po)}</td><td class="date">${fmtDate(r.date)}</td><td class="supplier">${esc(r.supplier)}</td>
        <td><div class="mat-name">${esc(r.name)}</div><div class="mat-code">${esc(r.code)}${r.jenis ? ' · ' + esc(r.jenis) : ''}</div></td>
        <td class="num">${fmtNum(x.qty)} ${u}</td><td class="num">${fmtNum(x.tot)} ${u}</td>
        <td class="num"><b class="${x.diff > 0 ? 'diff-up' : 'diff-down'}">${x.diff > 0 ? '+' : '−'}${fmtNum(Math.abs(x.diff))}</b></td>
        <td>${x.diff > 0 ? `Jadwal lebih ${fmtNum(x.diff)} ${u} dari order` : `Jadwal kurang ${fmtNum(-x.diff)} ${u} dari order`}</td></tr>`;
    }).join('') : '<tr class="empty"><td colspan="8">Tidak ada. Semua total jadwal sama dengan qty order.</td></tr>';
    // Angka di menu: jadwal tanpa baris PO + selisih untuk RM dan PM
    const badge = orphans.length + mism.filter((x) => jenisOk(x.r, RMPM)).length + takeout.filter((x) => jenisOk(x.r, RMPM)).length + cancelled.length;
    $('attBadge').hidden = !badge;
    $('attBadge').textContent = badge;
  }
  $('aq').addEventListener('input', () => renderAttention());
  $('aJenis').addEventListener('change', () => renderAttention());
  $('aCancel').addEventListener('click', (e) => {
    const tr = e.target.closest('tr.row'); if (!tr) return;
    const r = state.rows.find((x) => x.po === tr.dataset.po && (!tr.dataset.code || x.code === tr.dataset.code));
    state.status = 'cancel';
    if (r) goMonitor({ q: r.po, openKey: r.key, jenis: '', supplier: '', status: 'cancel' });
  });
  $('aTakeout').addEventListener('click', (e) => {
    const tr = e.target.closest('tr.row'); if (!tr) return;
    const r = state.rows.find((x) => x.key === tr.dataset.key);
    if (r) goMonitor({ q: r.po, openKey: r.key, jenis: '', supplier: '' });
  });
  $('aMismatch').addEventListener('click', (e) => {
    const tr = e.target.closest('tr.row'); if (!tr) return;
    const r = state.rows.find((x) => x.key === tr.dataset.key);
    if (r) goMonitor({ q: r.po, openKey: r.key, jenis: '', supplier: '' });
  });

  // Peringatan di halaman Update Data PO: jadwal di file PO-DEL yang belum punya baris PO
  function renderDelWarn() {
    const box = $('delWarn'), del = state.parsedDel;
    if (!del) { box.hidden = true; box.innerHTML = ''; return; }
    const det = state.parsedDet;
    const lines = (state.raw.lines || []).filter((l) => !det || !det.pos.has(l[0]));
    const keys = new Set(lines.map((l) => l[0] + '|' + l[3]));
    const pos = new Set(lines.map((l) => l[0]));
    if (det) det.rows.forEach((l) => { keys.add(l[0] + '|' + l[3]); pos.add(l[0]); });
    const list = orphanGroups(keys, pos, del.rows);
    if (!list.length) { box.hidden = true; box.innerHTML = ''; return; }
    const nPo = new Set(list.map((x) => x.po)).size;
    box.hidden = false;
    box.innerHTML = `<h4>Perhatian: ${nPo} PO / ${list.length} material di PO-DEL belum ada di data PO</h4>
      <p>Jadwalnya tetap disimpan, tetapi belum tampil di Monitoring PO, Dashboard, dan Kalender sampai PO-DET yang memuat PO tersebut di-upload${det ? '' : ' (pilih juga file PO-DET bila ada)'}. Daftar ini juga ada di menu Perhatian Khusus.</p>
      <ul class="warn-list">${list.slice(0, 15).map((x) => `<li><b>${esc(x.po)}</b> · [${esc(x.code)}] ${esc(x.name)} <span class="hint">(${x.n} jadwal${x.poKnown ? ', kode tidak ada di baris PO' : ''})</span></li>`).join('')}</ul>
      ${list.length > 15 ? `<p class="hint">…dan ${list.length - 15} lainnya.</p>` : ''}`;
  }

  /* ---------- Pesan follow-up ke supplier (disalin, dikirim sendiri lewat WA/email) ---------- */
  const dfLong = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtLong = (s) => { if (!s) return '–'; const [y, m, d] = s.split('-').map(Number); return dfLong.format(new Date(y, m - 1, d)); };
  const MSG = {};

  // Baris dasar sesuai asal tombol: tabel Monitoring (tampil / semua PO supplier) atau Dashboard
  function msgBaseRows(o, scope) {
    if (o.from === 'mon' && scope === 'view') return byStatus(byMonth(filteredNoMonth(state.status === 'cancel')), state.status);
    const jenis = o.from === 'mon' ? $('fJenis').value : $('dJenis').value;
    return state.rows.filter((r) => r.supplier === o.supplier && jenisOk(r, jenis));
  }

  // Kelompokkan per PO + kode (kode ganda dalam satu PO digabung)
  function msgItems(rows, mode) {
    const today = todayStr(), groups = new Map();
    rows.forEach((r) => {
      if (isClosed(r)) return;
      const k = r.po + '|' + r.code;
      const g = groups.get(k) || { r, qty: 0 };
      g.qty += mode === 'short' ? r.shortage : Math.max(0, r.sisa);
      groups.set(k, g);
    });
    const items = [];
    groups.forEach((g) => {
      if (!(g.qty > 0)) return;
      const r = g.r;
      let parts = [];
      if (mode === 'short') {
        parts = r.sched.filter((x) => x.short > 0).map((x) => ({
          q: x.short, done: x.status === 'Done', date: x.date, late: x.status !== 'Done' && x.date ? daysBetween(x.date, today) : 0 }));
      } else {
        parts = r.sched.filter((x) => x.status !== 'Done' && (Number(x.qty) || 0) > (Number(x.rec) || 0)).map((x) => ({
          q: (Number(x.qty) || 0) - (Number(x.rec) || 0), done: false, date: x.date, late: x.date && x.date < today ? daysBetween(x.date, today) : 0 }));
      }
      items.push({ r, qty: g.qty, parts, oldest: parts.map((p) => p.date).filter(Boolean).sort()[0] || '9999' });
    });
    items.sort((a, b) => (a.r.date < b.r.date ? -1 : a.r.date > b.r.date ? 1 : a.r.po < b.r.po ? -1 : a.r.po > b.r.po ? 1 : a.r.idx - b.r.idx));
    return items;
  }

  function msgText(sup, items, mode) {
    const h = new Date().getHours();
    const waktu = h < 11 ? 'pagi' : h < 15 ? 'siang' : h < 18 ? 'sore' : 'malam';
    const m = String(sup).match(/^(.*?),\s*(PT|CV|UD|PD|Tbk|Ltd|Co\.?,? Ltd)\.?$/i);
    const nama = m ? `${m[2].length <= 3 ? m[2].toUpperCase() : m[2]} ${m[1]}` : sup;   // "Sumber Kemas, PT" → "PT Sumber Kemas"
    const out = [`Selamat ${waktu} Bapak/Ibu tim ${nama},`, ''];
    out.push(mode === 'short'
      ? 'Kami dari PPIC Gondowangi ingin konfirmasi item PO berikut yang sudah lewat jadwal kirim tetapi belum kami terima lengkap:'
      : 'Kami dari PPIC Gondowangi ingin konfirmasi item PO berikut yang masih belum kami terima lengkap:');
    let po = '', n = 0;
    items.forEach((it) => {
      const r = it.r, u = r.uom ? ' ' + r.uom : '';
      if (r.po !== po) { po = r.po; n = 0; out.push('', `*${r.po}* (order ${fmtLong(r.date)})`); }
      n++;
      out.push(`${n}. [${r.code}] ${r.name}`);
      const multi = it.parts.length > 1;
      const desc = it.parts.map((p) => {
        const q = multi ? `${nf.format(p.q)}${u} ` : '';
        if (p.done) return `${q}kurang kirim dari pengiriman ${fmtLong(p.date)}`;
        if (!p.date) return `${q}belum ada tanggal kirim`;
        return `${q}jadwal ${fmtLong(p.date)}${p.late > 0 ? ` (lewat ${p.late} hari)` : ''}`;
      });
      out.push(`   Kurang ${nf.format(it.qty)}${u}${desc.length ? ' · ' + desc.join('; ') : ' · belum ada jadwal kirim'}`);
      const f = r.follow;
      if (f && f.promise) out.push(`   Janji kirim sebelumnya: ${fmtLong(f.promise)}`);
    });
    out.push('', 'Mohon konfirmasi rencana pengiriman untuk item di atas. Terima kasih.');
    return out.join('\n');
  }

  function openSupplierMsg(o) {
    if (!o.supplier) return;
    MSG.o = o;
    const allSup = msgBaseRows(o, 'all');
    MSG.mode = allSup.some((r) => r.shortage > 0) ? 'short' : 'open';
    MSG.scope = o.from === 'mon' ? 'view' : 'all';
    const scopeSel = o.from === 'mon'
      ? `<label class="field"><span>Ambil dari</span><select id="msgScope">
          <option value="view">Baris yang tampil di tabel</option>
          <option value="all">Semua PO supplier ini</option></select></label>`
      : '';
    openDialog({
      title: 'Pesan follow-up ke supplier',
      ok: 'Tutup', cancel: false, wide: true,
      body: `
        <p class="dlg-lead">${esc(o.supplier)}. Pesan tidak dikirim otomatis: salin lalu kirim sendiri lewat WhatsApp atau email.</p>
        <div class="form-grid">
          <label class="field"><span>Isi pesan</span><select id="msgMode">
            <option value="short">Shortage saja (lewat jadwal / kurang kirim)</option>
            <option value="open">Semua yang belum lengkap</option></select></label>
          ${scopeSel}
        </div>
        <p class="msg-info" id="msgInfo"></p>
        <label class="field msg-field"><span>Pesan (bisa diubah sebelum disalin)</span><textarea id="msgText" rows="14" spellcheck="false"></textarea></label>
        <div class="msg-actions">
          <button type="button" class="btn" id="msgCopy">Salin pesan</button>
          <a class="btn btn-ghost" id="msgWa" target="_blank" rel="noopener">Buka WhatsApp</a>
          <a class="btn btn-ghost" id="msgMail">Buka email</a>
          <span class="msg-copied" id="msgCopied" role="status"></span>
        </div>`,
      onSubmit: null,
    });
    $('msgMode').value = MSG.mode;
    if ($('msgScope')) $('msgScope').value = MSG.scope;
    const regen = () => {
      MSG.mode = $('msgMode').value;
      if ($('msgScope')) MSG.scope = $('msgScope').value;
      const rows = msgBaseRows(o, MSG.scope).filter((r) => r.supplier === o.supplier);
      const items = msgItems(rows, MSG.mode);
      const nPo = new Set(items.map((x) => x.r.po)).size;
      $('msgInfo').textContent = items.length
        ? `${nf.format(nPo)} PO · ${nf.format(items.length)} material`
        : (MSG.mode === 'short' ? 'Tidak ada shortage untuk supplier ini pada pilihan di atas. Pilih "Semua yang belum lengkap" atau "Semua PO supplier ini".'
          : 'Semua item supplier ini sudah lengkap pada pilihan di atas.');
      $('msgText').value = items.length ? msgText(o.supplier, items, MSG.mode) : '';
      syncLinks();
    };
    const syncLinks = () => {
      const t = $('msgText').value, on = !!t.trim();
      $('msgCopy').disabled = !on;
      $('msgWa').href = on ? 'https://wa.me/?text=' + encodeURIComponent(t) : '#';
      $('msgMail').href = on ? `mailto:?subject=${encodeURIComponent('Konfirmasi pengiriman PO - ' + o.supplier)}&body=${encodeURIComponent(t)}` : '#';
      ['msgWa', 'msgMail'].forEach((id) => $(id).classList.toggle('is-disabled', !on));
      $('msgCopied').textContent = '';
    };
    $('msgMode').addEventListener('change', regen);
    if ($('msgScope')) $('msgScope').addEventListener('change', regen);
    $('msgText').addEventListener('input', syncLinks);
    $('msgCopy').addEventListener('click', async () => {
      const t = $('msgText').value;
      try { await navigator.clipboard.writeText(t); }
      catch (e) { $('msgText').select(); document.execCommand('copy'); }
      $('msgCopied').textContent = 'Pesan disalin.';
    });
    regen();
    $('msgText').focus();
  }

  /* ---------- Jendela form ---------- */
  let dlgSubmit = null;
  function openDialog({ title, body, ok = 'Simpan', danger = false, onSubmit, cancel = true, wide = false }) {
    $('dlgCancel').hidden = !cancel;
    $('dlg').classList.toggle('dlg-wide', wide);
    $('dlgTitle').textContent = title;
    $('dlgBody').innerHTML = body;
    $('dlgError').textContent = '';
    $('dlgOk').textContent = ok;
    $('dlgOk').className = 'btn' + (danger ? ' btn-danger' : '');
    $('dlgOk').disabled = false;
    dlgSubmit = onSubmit;
    if (!$('dlg').open) $('dlg').showModal();
    const first = $('dlgBody').querySelector('input:not([readonly]), select');
    if (first) first.focus();
  }
  let dlgBusy = false;
  const closeDialog = () => { if (dlgBusy) return; $('dlg').close(); dlgSubmit = null; };
  $('dlgCancel').addEventListener('click', closeDialog);
  $('dlg').addEventListener('cancel', (e) => { if (dlgBusy) e.preventDefault(); });   // Esc tidak menutup saat sedang menyimpan
  // Tanda sedang menyimpan: tombol dan isian dikunci, ada keterangan dan hitungan detik
  function setDlgBusy(on) {
    dlgBusy = on;
    $('dlgForm').classList.toggle('is-busy', on);
    $('dlgBody').querySelectorAll('input, select, textarea, button').forEach((x) => { x.disabled = on; });
    $('dlgCancel').disabled = on;
    $('dlgSaving').hidden = !on;
    clearInterval(setDlgBusy.t);
    if (on) {
      const t0 = Date.now();
      $('dlgSavingText').textContent = 'Menyimpan ke Google Sheet…';
      setDlgBusy.t = setInterval(() => { $('dlgSavingText').textContent = `Menyimpan ke Google Sheet… ${Math.round((Date.now() - t0) / 1000)} detik`; }, 1000);
    }
  }
  $('dlgForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (dlgBusy) return;
    if (!dlgSubmit) return closeDialog();
    const fd = Object.fromEntries(new FormData($('dlgForm')).entries());
    $('dlgOk').disabled = true; $('dlgError').textContent = '';
    const label = $('dlgOk').textContent; $('dlgOk').textContent = 'Menyimpan…';
    setDlgBusy(true);
    try { const msg = await dlgSubmit(fd); setDlgBusy(false); closeDialog(); if (msg) toast(msg); }
    catch (err) { setDlgBusy(false); $('dlgError').textContent = err.message; $('dlgOk').disabled = false; $('dlgOk').textContent = label; }
  });

  // Pesan singkat di pojok bawah setelah berhasil menyimpan
  function toast(text) {
    const el = $('toast');
    el.textContent = text; el.hidden = false; el.classList.remove('is-out');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.classList.add('is-out'); setTimeout(() => { el.hidden = true; }, 300); }, 4500);
  }
  // Sorot sebentar baris yang baru diubah
  function flashRow(key) {
    if (!key) return;
    requestAnimationFrame(() => {
      const tr = document.querySelector(`#rows tr.row[data-key="${CSS.escape(key)}"]`);
      if (tr) { tr.classList.remove('is-flash'); void tr.offsetWidth; tr.classList.add('is-flash'); }
    });
  }
  const savedAt = (res) => (res && res.time ? String(res.time).slice(11, 16) : '');

  const fld = (name, label, value, opt = {}) => {
    const attrs = [`name="${name}"`, `id="f_${name}"`, `value="${esc(value ?? '')}"`];
    if (opt.type) attrs.push(`type="${opt.type}"`); else attrs.push('type="text"');
    if (opt.step) attrs.push(`step="${opt.step}"`);
    if (opt.type === 'number') attrs.push('min="0"');
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
    document.body.classList.toggle('edit-on', on);
    render();
  }

  $('btnEditMode').addEventListener('click', () => {
    if (state.route && state.route.actions === 'mrp') { if (P.edit) setMrpEdit(false); else askMrpPin(); return; }
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
        if (r) flashRow(state.openKey);
        const changed = (res.editLog || []).filter((x) => x[0] === res.time && x[3] === fd.po.trim()).length;
        return r ? (changed ? `Tersimpan ${savedAt(res)} · baris ${fd.po.trim()} / ${fd.code.trim()} diperbarui` : 'Tidak ada yang berubah.')
          : `Tersimpan ${savedAt(res)} · baris baru ${fd.po.trim()} / ${fd.code.trim()} ditambahkan`;
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
        return `Terhapus ${savedAt(res)} · baris ${r.po} / ${r.code}`;
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
        flashRow(state.openKey);
        return `Tersimpan ${savedAt(res)} · jadwal ${r.po} / ${r.code} ${s ? 'diperbarui' : 'ditambahkan'}`;
      },
    });
  }

  function deleteSched(r, s) {
    openDialog({
      title: `Hapus jadwal ke-${s.n}?`, ok: 'Hapus', danger: true,
      body: `<p>Jadwal <b>${fmtDate(s.date)}</b> · ${fmtNum(s.qty)} ${esc(r.uom)} · ${esc(s.status)} untuk ${esc(r.po)} / ${esc(r.code)} akan dihapus.</p>`,
      onSubmit: async () => {
        const res = await api('deleteSched', { key: { po: r.po, code: r.code, n: s.n } });
        applyServerUpdate(res);
        return `Terhapus ${savedAt(res)} · jadwal ke-${s.n} ${r.po} / ${r.code}`;
      },
    });
  }

  // Cancel PO / baris: ditandai di website (tab PO_CANCEL), wajib alasan, bisa diaktifkan lagi
  const CANCEL_REASONS = ['Supplier tidak sanggup kirim', 'Ganti supplier', 'Salah order / dobel', 'Kebutuhan dibatalkan', 'Harga / spesifikasi tidak sesuai', 'Lainnya'];
  function cancelDialog(r, whole) {
    if (state.noCancelScript) {
      openDialog({ title: 'Apps Script perlu diperbarui', ok: 'Mengerti', onSubmit: async () => {},
        body: '<p>Cancel PO membutuhkan Apps Script versi terbaru. Tempel Code.gs terbaru lalu buat versi deployment baru.</p>' });
      return;
    }
    const lines = state.rows.filter((x) => x.po === r.po && (whole || x.code === r.code));
    const open = lines.filter((x) => !isClosed(x));
    openDialog({
      title: whole ? `Cancel seluruh ${r.po}?` : `Cancel baris ${r.code} di ${r.po}?`, ok: whole ? 'Cancel PO' : 'Cancel baris', danger: true,
      body: `<p class="dlg-lead">${esc(r.supplier)} · ${whole ? `${lines.length} baris material, ${open.length} masih belum lengkap` : `${esc(r.name)} · ${fmtNum(r.qty)} ${esc(r.uom)}`}</p>
        <div class="form-grid">
          <label class="field span-2"><span>Alasan *</span><select name="reason" required><option value="">Pilih alasan…</option>${CANCEL_REASONS.map((x) => `<option>${esc(x)}</option>`).join('')}</select></label>
          <label class="field span-2"><span>Keterangan</span><textarea name="note" rows="2" placeholder="Misal: diganti PO baru ke supplier lain, sudah konfirmasi ke Purchasing"></textarea></label>
        </div>
        <p class="hint">${whole ? 'Semua baris PO ini' : 'Baris ini'} disembunyikan dari tabel dan tidak dihitung di status, shortage, Dashboard, Kalender, maupun MoQ. Data Odoo tidak berubah; tanda cancel tetap ada walau export Odoo di-upload ulang. Bisa diaktifkan lagi kapan saja.</p>`,
      onSubmit: async (fd) => {
        if (!fd.reason) throw new Error('Pilih alasan cancel.');
        if (fd.reason === 'Lainnya' && !fd.note.trim()) throw new Error('Isi keterangan untuk alasan "Lainnya".');
        const reason = fd.reason === 'Lainnya' ? fd.note.trim() : fd.reason + (fd.note.trim() ? ' — ' + fd.note.trim() : '');
        const res = await api('setCancel', { data: { po: r.po, code: whole ? '' : r.code, cancel: true, reason } });
        setCancel(res.cancels);
        if (res.editLog) state.editLog = res.editLog;
        state.openKey = null;
        refreshAll();
        return `${whole ? r.po : r.po + ' / ' + r.code} di-cancel ${savedAt(res)}. Lihat lewat tombol status "Cancel".`;
      },
    });
  }
  function uncancelDialog(r) {
    const c = r.cancel; if (!c) return;
    openDialog({
      title: c.code ? `Aktifkan lagi baris ${c.code} di ${c.po}?` : `Aktifkan lagi ${c.po}?`, ok: 'Aktifkan lagi',
      body: `<p>Di-cancel ${esc(c.time)} dengan alasan: <b>${esc(c.reason)}</b>.</p><p class="hint">${c.code ? 'Baris ini' : 'Semua baris PO ini'} kembali dihitung seperti biasa.</p>`,
      onSubmit: async () => {
        const res = await api('setCancel', { data: { po: c.po, code: c.code, cancel: false } });
        setCancel(res.cancels);
        if (res.editLog) state.editLog = res.editLog;
        refreshAll();
        flashRow(state.openKey);
        return `${c.code ? c.po + ' / ' + c.code : c.po} aktif lagi ${savedAt(res)}`;
      },
    });
  }

  $('rows').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b || !state.edit.on) return;
    const box = b.closest('[data-key]'); const r = box && findRow(box.dataset.key); if (!r) return;
    const s = b.dataset.n ? r.sched.find((x) => String(x.n) === b.dataset.n) : null;
    ({ follow: () => editFollow(r), editLine: () => editLine(r), delLine: () => deleteLine(r), addSched: () => editSched(r, null),
       editSched: () => editSched(r, s), delSched: () => deleteSched(r, s),
       cancelLine: () => cancelDialog(r, false), cancelPo: () => cancelDialog(r, true), uncancel: () => uncancelDialog(r) })[b.dataset.act]();
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
    renderDelWarn();
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
  // Nama kolom export Odoo: label biasa, atau nama teknis (bila export memakai "I want to update data / import-compatible")
  const DET_COLS = {
    po: ['Order Lines/Order Reference/Order Reference', 'order_line/order_id/name'],
    date: ['Order Lines/Order Reference/Order Date', 'order_line/order_id/date_order'],
    sup: ['Order Lines/Order Reference/Supplier', 'order_line/order_id/partner_id'],
    code: ['Order Lines/Product/Internal Reference', 'order_line/product_id/code', 'order_line/product_id/default_code'],
    name: ['Order Lines/Product/Name', 'order_line/product_id/name'],
    qty: ['Order Lines/Quantity', 'order_line/product_qty'],
    uom: ['Order Lines/Product/Unit of Measure', 'order_line/product_id/uom_id', 'order_line/product_uom'],
    price: ['Order Lines/Unit Price', 'order_line/price_unit'],
    kurs: ['Order Lines/Order Reference/Currency', 'order_line/order_id/currency_id'],
  };
  const DEL_COLS = {
    ext: ['External ID', 'id'],
    po: ['Delivery Schedule/PO Ref/Order Reference', 'plot_ids/order_id/name'],
    prod: ['Delivery Schedule/Plot Delivery Order/Product', 'plot_ids/line_ids/product_id'],
    sq: ['Delivery Schedule/Plot Delivery Order/Scheduled Quantity', 'plot_ids/line_ids/scheduled_qty'],
    rq: ['Delivery Schedule/Plot Delivery Order/Received Quantity', 'plot_ids/line_ids/product_qty_actual'],
    date: ['Delivery Schedule/Scheduled Date', 'plot_ids/date'],
    state: ['Delivery Schedule/State', 'plot_ids/state'],
  };

  async function readSheet(file) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', cellDates: false });
    return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true });
  }

  function colIndex(header, cols) {
    const idx = {}, missing = [];
    const head = header.map((h) => String(h).trim());
    Object.entries(cols).forEach(([k, names]) => {
      const i = head.findIndex((h) => names.includes(h));
      if (i < 0) missing.push(names[0]); else idx[k] = i;
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

  /* ================= MRP: BOM & DAFTAR MATERIAL ================= */
  // Data dari DATABASE PPIC lewat Apps Script (?view=mrp). Dimuat saat menu MRP pertama kali dibuka.
  const MRP = { loaded: false, loading: false, sel: null, ver: {}, subVer: {}, open: new Set(), scale: {}, flat: true, kTab: 'notMaster', shown: 200 };
  // Angka desimal apa adanya; lebih dari 3 angka di belakang koma dipotong jadi 3 + "…"
  const NF3 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 3 });
  const NF9 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 9 });
  function numParts(v) {
    const r = Math.round(Number(v) * 1e9) / 1e9;
    const dec = (Math.abs(r).toFixed(9).split('.')[1] || '').replace(/0+$/, '').length;
    const t = Math.trunc(r * 1000) / 1000;
    return { txt: NF3.format(t === 0 ? 0 : t) + (dec > 3 ? '…' : ''), cut: dec > 3, full: r };
  }
  const fmtQ = (v) => (v === '' || v === null || v === undefined ? '–' : numParts(v).txt);

  function mrpEnter(key) {
    if (!MRP.loaded) { loadMrp(false); return; }
    renderMrp(key);
  }
  async function loadMrp(force) {
    if (MRP.loading) return;
    if (MRP.loaded && !force) return;
    MRP.loading = true;
    document.querySelectorAll('[data-mrp-loading]').forEach((x) => { x.hidden = false; x.textContent = 'Memuat BOM dan daftar material dari DATABASE PPIC, biasanya 5–15 detik…'; });
    $('btnReload').disabled = true;
    try {
      // Menu MRP memakai Apps Script sendiri di Google Sheet "MRP PPIC GTK" (config.js → MRP_SCRIPT_URL)
      if (!CFG.MRP_SCRIPT_URL) throw new Error('Apps Script MRP belum terpasang. Pasang Code_MRP.gs di Google Sheet MRP PPIC GTK (Extensions → Apps Script), buat Web app, lalu alamatnya dimasukkan ke website.');
      const res = await fetch(CFG.MRP_SCRIPT_URL);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Respon tidak valid');
      if (!Array.isArray(data.boms)) throw new Error('Apps Script MRP belum versi terbaru. Tempel Code_MRP.gs terbaru, lalu Deploy → Manage deployments → Edit → New version → Deploy.');
      setMrp(data);
      MRP.err = '';
      if (window.TASKS) setTimeout(() => window.TASKS.refresh(), 0);
      document.querySelectorAll('[data-mrp-loading]').forEach((x) => { x.hidden = true; });
      if (state.route && state.route.actions === 'mrp') {
        renderDataInfo();
        if (MRP.dbUrl) { $('lnkSheet').href = MRP.dbUrl; $('lnkSheet').hidden = false; }
        renderMrp(location.hash.replace(/^#\/?/, ''));
      }
    } catch (err) {
      MRP.err = err.message;
      if (window.TASKS) window.TASKS.refresh();
      document.querySelectorAll('[data-mrp-loading]').forEach((x) => { x.hidden = false; x.textContent = 'Data MRP tidak bisa dimuat: ' + err.message; });
    } finally {
      MRP.loading = false;
      $('btnReload').disabled = false;
    }
  }

  function setMrp(d) {
    MRP.dbUrl = d.databaseUrl || MRP.dbUrl;
    MRP.readAt = d.readAt;
    MRP.master = new Map(d.master.map((m) => [m[0], { code: m[0], name: m[1], uom: m[2], kat: m[3] }]));
    const byId = new Map();
    MRP.boms = d.boms.map((b) => {
      const o = { id: b[0], code: b[1], name: b[2], batch: Number(b[3]) || 0, uom: b[4], ref: b[5], note: b[7], comps: [] };
      byId.set(o.id, o); return o;
    });
    d.details.forEach((x) => { const b = byId.get(x[0]); if (b) b.comps.push({ code: x[1], name: x[2], qty: x[3] === '' ? '' : Number(x[3]), uom: x[4], kat: x[5] }); });
    MRP.byProduct = new Map();
    MRP.boms.forEach((b) => { if (!MRP.byProduct.has(b.code)) MRP.byProduct.set(b.code, []); MRP.byProduct.get(b.code).push(b); });
    // Dipakai di: kode material → [{ bom, qty }]
    MRP.usedIn = new Map();
    MRP.boms.forEach((b) => b.comps.forEach((c) => {
      if (!MRP.usedIn.has(c.code)) MRP.usedIn.set(c.code, []);
      MRP.usedIn.get(c.code).push({ bom: b, qty: c.qty, uom: c.uom });
    }));
    MRP.products = [...MRP.byProduct.entries()].map(([code, list]) => {
      const m = MRP.master.get(code);
      return { code, name: (m && m.name) || list[0].name, kat: (m && m.kat) || '', boms: list, search: (code + ' ' + ((m && m.name) || list[0].name)).toLowerCase() };
    }).sort((a, b) => a.code.localeCompare(b.code, 'id', { numeric: true }));
    setPlanData(d);
    MRP.loaded = true;
    MRP.checks = Object.assign(mrpChecks(), planChecks());
    refreshMrpHome();
    const nCheck = Object.values(MRP.checks).reduce((t, c) => t + (c.badge ? c.rows.length : 0), 0);
    $('mrpBadge').hidden = !nCheck; $('mrpBadge').textContent = nCheck;
    $('hMrpProd').textContent = nf.format(MRP.products.length);
    $('hMrpBom').textContent = nf.format(MRP.boms.length);
    const kats = (list) => [...new Set(list.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'id'));
    const fill = (sel, list, first) => { const cur = sel.value; sel.innerHTML = `<option value="">${first}</option>` + list.map((v) => `<option>${esc(v)}</option>`).join(''); sel.value = list.includes(cur) ? cur : ''; };
    fill($('bKat'), kats(MRP.products.map((p) => p.kat || 'Tanpa kategori')), 'Semua kategori');
    fill($('mKat'), kats([...MRP.master.values()].map((m) => m.kat || 'Tanpa kategori')), 'Semua kategori');
    $('uList').innerHTML = [...MRP.master.values()].map((m) => `<option value="${esc(m.code)} · ${esc(m.name)}">`).join('');
  }

  function renderMrp(key) {
    if (!MRP.loaded) return;
    if (key === 'mrp/bom') renderBomList();
    else if (key === 'mrp/material') renderMatList();
    else if (key === 'mrp/dipakai') renderUse();
    else if (key === 'mrp/cek') renderChecks();
    else renderPlanView(key);
  }

  /* ---------- Bill of Material ---------- */
  function renderBomList() {
    const q = $('bq').value.trim().toLowerCase(), k = $('bKat').value;
    const list = MRP.products.filter((p) => (!q || q.split(/\s+/).every((w) => p.search.includes(w))) && (!k || (p.kat || 'Tanpa kategori') === k));
    $('bCount').textContent = `${nf.format(list.length)} produk · ${nf.format(list.reduce((t, p) => t + p.boms.length, 0))} versi BOM`;
    if (!MRP.sel && list.length) MRP.sel = list[0].code;
    $('bList').innerHTML = list.slice(0, 400).map((p) => `<button class="mrp-pitem${p.code === MRP.sel ? ' is-sel' : ''}" data-code="${esc(p.code)}" role="option" aria-selected="${p.code === MRP.sel}">
        <span class="mrp-pcode">${esc(p.code)}</span><span class="mrp-pname">${esc(p.name)}</span>
        <span class="mrp-pmeta">${esc(p.kat || 'Tanpa kategori')}${p.boms.length > 1 ? ` · ${p.boms.length} versi` : ''}</span>
      </button>`).join('') + (list.length > 400 ? `<p class="mrp-count">…${nf.format(list.length - 400)} produk lagi. Persempit pencarian.</p>` : '')
      || '<p class="mrp-empty">Tidak ada produk yang cocok.</p>';
    renderBomDetail();
  }

  const bomVer = (code) => {
    const list = MRP.byProduct.get(code) || [];
    return list.find((b) => b.id === MRP.ver[code]) || list[0];
  };
  const subBom = (code) => {
    const list = MRP.byProduct.get(code) || [];
    return list.find((b) => b.id === MRP.subVer[code]) || list[0];
  };

  // Urai BOM bertingkat. need = qty produk yang dibuat; tiap komponen = qty BOM × need / batch.
  // Komponen yang punya BOM sendiri (ekstrak/bulk) diurai lagi sesuai kebutuhannya.
  function explode(bom, need, depth, path, key) {
    const f = bom.batch ? need / bom.batch : 0;
    return bom.comps.map((c, i) => {
      const q = c.qty === '' ? 0 : c.qty * f;
      const k = key + '/' + i;
      const node = { c, qty: q, per: c.qty, depth, key: k, kids: null, sub: null };
      if (MRP.byProduct.has(c.code) && depth < 6 && !path.has(c.code)) {
        node.sub = subBom(c.code);
        node.kids = explode(node.sub, q, depth + 1, new Set([...path, c.code]), k);
      }
      return node;
    });
  }
  function leaves(nodes, out) {
    nodes.forEach((n) => {
      if (n.kids) return leaves(n.kids, out);
      const o = out.get(n.c.code) || { c: n.c, qty: 0, paths: 0 };
      o.qty += n.qty; o.paths++; out.set(n.c.code, o);
    });
    return out;
  }

  function renderBomDetail() {
    const code = MRP.sel;
    const p = MRP.products.find((x) => x.code === code);
    if (!p) { $('bDetail').innerHTML = '<p class="mrp-empty">Pilih produk di sebelah kiri untuk melihat BOM-nya.</p>'; return; }
    const bom = bomVer(code);
    const need = MRP.scale[code] !== undefined ? MRP.scale[code] : bom.batch;
    const tree = explode(bom, need, 0, new Set([code]), bom.id);
    const multi = tree.some((n) => n.kids);
    const tabs = p.boms.map((b) => `<button class="mrp-ver${b.id === bom.id ? ' is-on' : ''}" data-ver="${esc(b.id)}" title="${esc(b.ref)}">
        <b>${esc(b.id)}</b><span>${esc(b.ref || 'tanpa reference')}</span><span class="muted">${b.comps.length} komponen</span></button>`).join('');

    const rows = [];
    const walk = (nodes, parentOpen) => nodes.forEach((n) => {
      if (!parentOpen) return;
      const open = MRP.open.has(n.key);
      const subs = n.kids ? MRP.byProduct.get(n.c.code) : null;
      const m = MRP.master.get(n.c.code);
      rows.push(`<tr class="lvl-${Math.min(n.depth, 3)}${n.kids ? ' has-sub' : ''}">
        <td class="mrp-code" style="padding-left:${10 + n.depth * 22}px">${n.kids ? `<button class="mrp-tog" data-tog="${esc(n.key)}" aria-expanded="${open}" title="${open ? 'Tutup' : 'Uraikan BOM'} ${esc(n.c.code)}">${open ? '▾' : '▸'}</button>` : '<span class="mrp-tog-sp"></span>'}<button class="btn-link mrp-goto" data-use="${esc(n.c.code)}" title="Lihat pemakaian material ini">${esc(n.c.code)}</button></td>
        <td>${esc((m && m.name) || n.c.name)}${n.kids ? `<div class="mrp-subinfo">Punya BOM sendiri: ${subs.length > 1 ? `<select class="mrp-subsel" data-sub="${esc(n.c.code)}">${subs.map((b) => `<option value="${esc(b.id)}"${b.id === n.sub.id ? ' selected' : ''}>${esc(b.id)} · ${esc(b.ref || '-')}</option>`).join('')}</select>` : `${esc(n.sub.id)} · ${esc(n.sub.ref || '-')}`} (batch ${fmtQ(n.sub.batch)} ${esc(n.sub.uom)})</div>` : ''}</td>
        <td>${esc(n.c.kat || (m && m.kat) || '')}</td>
        <td class="num">${fmtQ(n.per)}</td>
        <td class="num"><b>${fmtQ(n.qty)}</b></td>
        <td>${esc(n.c.uom)}</td></tr>`);
      if (n.kids) walk(n.kids, open);
    });
    walk(tree, true);

    const flat = [...leaves(tree, new Map()).values()].sort((a, b) => b.qty - a.qty);
    let compare = '';
    if (p.boms.length > 1) {
      const codes = [];
      p.boms.forEach((b) => b.comps.forEach((c) => { if (!codes.includes(c.code)) codes.push(c.code); }));
      const val = (b, c) => b.comps.filter((x) => x.code === c).reduce((t, x) => t + (Number(x.qty) || 0), 0);
      compare = `<section class="dt-card mrp-card">
        <h4 class="dt-h">Bandingkan ${p.boms.length} versi BOM <span class="muted">qty per batch; yang berbeda antar versi ditandai</span></h4>
        <div class="sched-wrap"><table class="sched mrp-cmp"><thead><tr><th>Kode</th><th>Nama</th>${p.boms.map((b) => `<th class="num" title="${esc(b.ref)}">${esc(b.id)}<br><span class="muted">${esc(b.ref || '')}</span></th>`).join('')}</tr></thead>
        <tbody>${codes.map((c) => {
          const vs = p.boms.map((b) => val(b, c));
          const diff = vs.some((v) => Math.abs(v - vs[0]) > 1e-9);
          const m = MRP.master.get(c);
          return `<tr class="${diff ? 'is-diff' : ''}"><td>${esc(c)}</td><td>${esc((m && m.name) || (p.boms.flatMap((b) => b.comps).find((x) => x.code === c) || {}).name || '')}</td>${vs.map((v) => `<td class="num">${v ? fmtQ(v) : '<span class="muted">–</span>'}</td>`).join('')}</tr>`;
        }).join('')}</tbody></table></div></section>`;
    }

    $('bDetail').innerHTML = `
      <header class="mrp-head">
        <div><p class="crumb">${esc(p.kat || 'Tanpa kategori')} · ${esc(p.code)}</p><h2>${esc(p.name)}</h2></div>
        <label class="mrp-scale">Hitung untuk
          <input type="number" min="0" step="any" id="bScale" value="${need}"> <span>${esc(bom.uom)}</span>
          ${need !== bom.batch ? `<button class="btn-link" data-reset-scale>kembali ke 1 batch (${fmtQ(bom.batch)})</button>` : ''}
        </label>
      </header>
      <div class="mrp-vers" role="tablist" aria-label="Versi BOM">${tabs}</div>
      <section class="dt-card mrp-card">
        <h4 class="dt-h">Komponen ${esc(bom.id)} <span class="muted">batch ${fmtQ(bom.batch)} ${esc(bom.uom)}${bom.note ? ' · ' + esc(bom.note) : ''}</span>
          ${multi ? '<span class="mrp-tools"><button class="btn-link" data-open-all>Uraikan semua</button> · <button class="btn-link" data-close-all>Tutup semua</button></span>' : ''}</h4>
        <div class="sched-wrap"><table class="sched mrp-tree"><thead><tr><th>Kode</th><th>Nama material</th><th>Kategori</th><th class="num">Qty per batch BOM</th><th class="num">Qty untuk ${fmtQ(need)} ${esc(bom.uom)}</th><th>UoM</th></tr></thead>
        <tbody>${rows.join('') || '<tr><td colspan="6" class="muted">BOM ini belum punya komponen.</td></tr>'}</tbody></table></div>
        ${multi ? '<p class="hint">Baris dengan ▸ adalah ekstrak/bulk yang punya BOM sendiri. Kebutuhannya diurai sesuai qty ekstrak yang dibutuhkan, bukan per batch ekstrak.</p>' : ''}
      </section>
      ${multi ? `<section class="dt-card mrp-card">
        <h4 class="dt-h">Total bahan dasar untuk ${fmtQ(need)} ${esc(bom.uom)} <span class="muted">${flat.length} material setelah semua ekstrak/bulk diurai</span>
          <span class="mrp-tools"><button class="btn-link" data-export-flat>Unduh Excel</button></span></h4>
        <div class="sched-wrap"><table class="sched"><thead><tr><th>Kode</th><th>Nama material</th><th>Kategori</th><th class="num">Total qty</th><th>UoM</th></tr></thead>
        <tbody>${flat.map((x) => { const m = MRP.master.get(x.c.code); return `<tr><td>${esc(x.c.code)}</td><td>${esc((m && m.name) || x.c.name)}</td><td>${esc(x.c.kat || (m && m.kat) || '')}</td><td class="num"><b>${fmtQ(x.qty)}</b></td><td>${esc(x.c.uom)}</td></tr>`; }).join('')}</tbody></table></div>
      </section>` : ''}
      ${compare}`;
    MRP.lastFlat = { p, bom, need, flat, tree };
  }

  $('bq').addEventListener('input', () => renderBomList());
  $('bKat').addEventListener('change', () => renderBomList());
  $('bList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-code]'); if (!b) return;
    MRP.sel = b.dataset.code; renderBomList();
    if (window.innerWidth < 1000) $('bDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('bDetail').addEventListener('click', (e) => {
    const t = e.target;
    const v = t.closest('[data-ver]'); if (v) { MRP.ver[MRP.sel] = v.dataset.ver; MRP.open.clear(); delete MRP.scale[MRP.sel]; return renderBomDetail(); }
    const g = t.closest('[data-tog]'); if (g) { const k = g.dataset.tog; if (MRP.open.has(k)) MRP.open.delete(k); else MRP.open.add(k); return renderBomDetail(); }
    if (t.closest('[data-open-all]')) { const add = (ns) => ns.forEach((n) => { if (n.kids) { MRP.open.add(n.key); add(n.kids); } }); add(MRP.lastFlat.tree); return renderBomDetail(); }
    if (t.closest('[data-close-all]')) { MRP.open.clear(); return renderBomDetail(); }
    if (t.closest('[data-reset-scale]')) { delete MRP.scale[MRP.sel]; return renderBomDetail(); }
    const u = t.closest('[data-use]'); if (u) { MRP.use = u.dataset.use; location.hash = '#/mrp/dipakai'; return; }
    if (t.closest('[data-export-flat]')) {
      const f = MRP.lastFlat;
      const data = f.flat.map((x) => { const m = MRP.master.get(x.c.code); return { 'Kode': x.c.code, 'Nama Material': (m && m.name) || x.c.name, 'Kategori': x.c.kat || (m && m.kat) || '', 'Total Qty': x.qty, 'UoM': x.c.uom }; });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Bahan dasar');
      XLSX.writeFile(wb, `Bahan_dasar_${f.p.code}_${f.bom.id}_${f.need}.xlsx`);
    }
  });
  $('bDetail').addEventListener('change', (e) => {
    const s = e.target.closest('[data-sub]'); if (s) { MRP.subVer[s.dataset.sub] = s.value; return renderBomDetail(); }
  });
  $('bDetail').addEventListener('input', (e) => {
    if (e.target.id !== 'bScale') return;
    const v = Number(e.target.value);
    clearTimeout(MRP.st);
    MRP.st = setTimeout(() => { if (v > 0) { MRP.scale[MRP.sel] = v; renderBomDetail(); const i = $('bScale'); if (i) { i.focus(); i.setSelectionRange && i.type === 'text' && i.setSelectionRange(99, 99); } } }, 500);
  });

  /* ---------- Daftar Material ---------- */
  const MAT_GET = { code: (x) => x.code, name: (x) => x.name, uom: (x) => x.uom, kat: (x) => x.kat, used: (x) => x.used || null, bom: (x) => x.bom || null, openpo: (x) => x.openpo || null };
  function matRows() {
    const open = new Map();
    (state.rows || []).forEach((r) => { if (!isClosed(r) && r.sisa > 0) open.set(r.code, (open.get(r.code) || 0) + r.sisa); });
    return [...MRP.master.values()].map((m) => {
      const used = new Set((MRP.usedIn.get(m.code) || []).map((u) => u.bom.code)).size;
      return { ...m, used, bom: (MRP.byProduct.get(m.code) || []).length, openpo: open.get(m.code) || 0, search: (m.code + ' ' + m.name).toLowerCase() };
    });
  }
  function renderMatList() {
    const q = $('mq').value.trim().toLowerCase(), k = $('mKat').value, u = $('mUse').value;
    let rows = matRows().filter((x) => (!q || q.split(/\s+/).every((w) => x.search.includes(w)))
      && (!k || (x.kat || 'Tanpa kategori') === k)
      && (!u || (u === 'used' ? x.used : u === 'unused' ? !x.used : u === 'hasbom' ? x.bom : x.openpo > 0)));
    rows = applyColSort(rows, colSort.mat, MAT_GET);
    paintSortHeaders($('mTable'), 'mat');
    MRP.matView = rows;
    $('mCount').textContent = `${nf.format(rows.length)} material`;
    $('mRows').innerHTML = rows.slice(0, MRP.shown).map((x) => `<tr class="row" data-mat="${esc(x.code)}" tabindex="0">
        <td class="po">${esc(x.code)}</td><td>${esc(x.name)}</td><td>${esc(x.uom)}</td><td>${esc(x.kat || '–')}</td>
        <td class="num">${x.used ? nf.format(x.used) : '<span class="muted">–</span>'}</td>
        <td class="num">${x.bom ? nf.format(x.bom) : '<span class="muted">–</span>'}</td>
        <td class="num">${x.openpo ? fmtQ(x.openpo) + ' ' + esc(x.uom) : '<span class="muted">–</span>'}</td></tr>`).join('')
      || '<tr class="empty"><td colspan="7">Tidak ada material yang cocok.</td></tr>';
    $('mMore').hidden = rows.length <= MRP.shown;
  }
  ['mq'].forEach((id) => $(id).addEventListener('input', () => { MRP.shown = 200; renderMatList(); }));
  ['mKat', 'mUse'].forEach((id) => $(id).addEventListener('change', () => { MRP.shown = 200; renderMatList(); }));
  $('mReset').addEventListener('click', () => { $('mq').value = ''; $('mKat').value = ''; $('mUse').value = ''; colSort.mat = null; MRP.shown = 200; renderMatList(); });
  $('mMore').addEventListener('click', () => { MRP.shown += 200; renderMatList(); });
  initSortHeaders($('mTable'), 'mat', () => renderMatList());
  $('mRows').addEventListener('click', (e) => {
    const tr = e.target.closest('[data-mat]'); if (!tr) return;
    const code = tr.dataset.mat;
    if (MRP.byProduct.has(code) && !(MRP.usedIn.get(code) || []).length) { MRP.sel = code; location.hash = '#/mrp/bom'; }
    else { MRP.use = code; location.hash = '#/mrp/dipakai'; }
  });
  $('mExport').addEventListener('click', () => {
    const data = (MRP.matView || []).map((x) => ({ 'Kode': x.code, 'Nama Material': x.name, 'UoM': x.uom, 'Kategori': x.kat, 'Dipakai di Produk': x.used, 'Versi BOM Sendiri': x.bom, 'PO Terbuka (Sisa)': x.openpo }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Daftar Material');
    XLSX.writeFile(wb, `Daftar_Material_${todayStr()}.xlsx`);
  });

  /* ---------- Material dipakai di mana ---------- */
  function renderUse() {
    const code = MRP.use;
    if (code && $('uq').value.split(' · ')[0] !== code) { const m = MRP.master.get(code); $('uq').value = m ? `${m.code} · ${m.name}` : code; }
    if (!code) { $('uResult').innerHTML = '<p class="mrp-empty">Pilih material untuk melihat pemakaiannya.</p>'; return; }
    const m = MRP.master.get(code);
    const direct = MRP.usedIn.get(code) || [];
    // Tidak langsung: material dipakai di ekstrak/bulk, lalu ekstrak/bulk itu dipakai di produk lain
    const indirect = [];
    const seen = new Set();
    const up = (prodCode, via, depth) => {
      if (depth > 5) return;
      (MRP.usedIn.get(prodCode) || []).forEach((u) => {
        const k = u.bom.id + '|' + via.join('>');
        if (seen.has(k)) return; seen.add(k);
        indirect.push({ bom: u.bom, via: via.slice(), qty: u.qty, uom: u.uom });
        up(u.bom.code, via.concat([u.bom.code]), depth + 1);
      });
    };
    const directProducts = [...new Set(direct.map((u) => u.bom.code))];
    directProducts.forEach((pc) => up(pc, [pc], 1));
    const prodName = (c) => { const x = MRP.master.get(c); return (x && x.name) || ((MRP.byProduct.get(c) || [])[0] || {}).name || ''; };
    const prodKat = (c) => { const x = MRP.master.get(c); return (x && x.kat) || ''; };
    const openPo = (state.rows || []).filter((r) => r.code === code && !isClosed(r) && r.sisa > 0).reduce((t, r) => t + r.sisa, 0);
    $('uResult').innerHTML = `
      <div class="dt-tiles mrp-utiles">
        <div class="dt-tile"><span class="dt-k">Material</span><span class="dt-v">${esc(code)}</span><span class="dt-sub">${esc((m && m.name) || (direct[0] && direct[0].bom.comps.find((c) => c.code === code) || {}).name || 'Tidak ada di master')}</span></div>
        <div class="dt-tile"><span class="dt-k">Kategori · UoM</span><span class="dt-v">${esc((m && m.kat) || '–')}</span><span class="dt-sub">${esc((m && m.uom) || '')}</span></div>
        <div class="dt-tile"><span class="dt-k">Dipakai langsung di</span><span class="dt-v">${nf.format(directProducts.length)} <small>produk</small></span><span class="dt-sub">${nf.format(direct.length)} versi BOM</span></div>
        <div class="dt-tile"><span class="dt-k">PO terbuka (sisa)</span><span class="dt-v">${openPo ? fmtQ(openPo) : '–'} <small>${esc((m && m.uom) || '')}</small></span><span class="dt-sub">dari Monitoring PO</span></div>
      </div>
      <section class="dt-card mrp-card">
        <h4 class="dt-h">Dipakai langsung <span class="muted">${direct.length} versi BOM</span></h4>
        <div class="sched-wrap"><table class="sched"><thead><tr><th>Produk</th><th>Nama produk</th><th>Kategori</th><th>BOM</th><th class="num">Qty per batch</th><th class="num">Batch</th></tr></thead>
        <tbody>${direct.map((u) => `<tr><td><button class="btn-link" data-bom="${esc(u.bom.code)}" data-ver="${esc(u.bom.id)}">${esc(u.bom.code)}</button></td><td>${esc(prodName(u.bom.code))}</td><td>${esc(prodKat(u.bom.code))}</td><td>${esc(u.bom.id)} <span class="muted">${esc(u.bom.ref || '')}</span></td><td class="num">${fmtQ(u.qty)} ${esc(u.uom)}</td><td class="num">${fmtQ(u.bom.batch)} ${esc(u.bom.uom)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Tidak dipakai langsung di BOM mana pun.</td></tr>'}</tbody></table></div>
      </section>
      ${indirect.length ? `<section class="dt-card mrp-card">
        <h4 class="dt-h">Dipakai tidak langsung <span class="muted">lewat ekstrak/bulk yang memakai material ini</span></h4>
        <div class="sched-wrap"><table class="sched"><thead><tr><th>Produk</th><th>Nama produk</th><th>Kategori</th><th>Lewat</th><th>BOM</th><th class="num">Qty ekstrak/bulk per batch</th></tr></thead>
        <tbody>${indirect.map((u) => `<tr><td><button class="btn-link" data-bom="${esc(u.bom.code)}" data-ver="${esc(u.bom.id)}">${esc(u.bom.code)}</button></td><td>${esc(prodName(u.bom.code))}</td><td>${esc(prodKat(u.bom.code))}</td><td>${u.via.map((c) => `${esc(c)} <span class="muted">${esc(prodName(c))}</span>`).join(' → ')}</td><td>${esc(u.bom.id)}</td><td class="num">${fmtQ(u.qty)} ${esc(u.uom)}</td></tr>`).join('')}</tbody></table></div>
      </section>` : ''}
      ${MRP.byProduct.has(code) ? `<p class="dt-note">Material ini juga punya BOM sendiri (${(MRP.byProduct.get(code) || []).length} versi). <button class="btn-link" data-bom="${esc(code)}">Lihat BOM-nya</button></p>` : ''}`;
  }
  $('uq').addEventListener('change', () => {
    const v = $('uq').value.trim(); const c = v.split(' · ')[0].trim();
    if (MRP.master.has(c) || MRP.usedIn.has(c)) { MRP.use = c; renderUse(); }
    else {
      const hit = [...MRP.master.values()].find((m) => m.name.toLowerCase() === v.toLowerCase());
      if (hit) { MRP.use = hit.code; renderUse(); }
    }
  });
  $('uResult').addEventListener('click', (e) => {
    const b = e.target.closest('[data-bom]'); if (!b) return;
    MRP.sel = b.dataset.bom; if (b.dataset.ver) MRP.ver[MRP.sel] = b.dataset.ver;
    MRP.open.clear(); location.hash = '#/mrp/bom';
  });

  /* ---------- Pemeriksaan data ---------- */
  function mrpChecks() {
    const inMaster = (c) => MRP.master.has(c);
    const compInfo = new Map();
    MRP.boms.forEach((b) => b.comps.forEach((c) => {
      const o = compInfo.get(c.code) || { code: c.code, name: c.name, kat: c.kat, uom: c.uom, boms: new Set(), prods: new Set(), uoms: new Set() };
      o.boms.add(b.id); o.prods.add(b.code); o.uoms.add(c.uom); compInfo.set(c.code, o);
    }));
    const notMaster = [...compInfo.values()].filter((o) => !inMaster(o.code));
    const prodNotMaster = MRP.products.filter((p) => !inMaster(p.code));
    const unused = [...MRP.master.values()].filter((m) => (m.kat === 'RM (Raw)' || m.kat === 'PM (Pack)') && !compInfo.has(m.code));
    const noBom = [...MRP.master.values()].filter((m) => (m.kat === 'FG' || m.kat === 'Ekstrak') && !MRP.byProduct.has(m.code));
    // Satu baris per komponen BOM yang UoM-nya beda dengan master (supaya tahu BOM mana yang harus dicek)
    const uomDiff = [];
    MRP.boms.forEach((b) => b.comps.forEach((c) => {
      const m = MRP.master.get(c.code);
      if (m && m.uom && c.uom && c.uom.toLowerCase() !== m.uom.toLowerCase()) uomDiff.push({ b, c, m });
    }));
    uomDiff.sort((a, b) => a.c.code.localeCompare(b.c.code, 'id', { numeric: true }) || a.b.id.localeCompare(b.b.id));
    const zero = [];
    MRP.boms.forEach((b) => { if (!b.comps.length) zero.push({ b, c: null }); b.comps.forEach((c) => { if (!(Number(c.qty) > 0)) zero.push({ b, c }); }); });
    const noKat = [...MRP.master.values()].filter((m) => !m.kat);
    return {
      notMaster: { label: 'Komponen tidak ada di master', badge: true, rows: notMaster,
        desc: 'Kode material di BOM_DETAIL yang tidak ada di MASTER_MATERIAL. Tambahkan ke master supaya nama, UoM, dan kategorinya jelas.',
        head: ['Kode', 'Nama (dari BOM)', 'Kategori (dari BOM)', 'Dipakai di produk', 'Versi BOM'],
        row: (o) => [o.code, o.name, o.kat, o.prods.size, o.boms.size], use: (o) => o.code },
      prodNotMaster: { label: 'Produk BOM tidak ada di master', badge: true, rows: prodNotMaster,
        desc: 'Kode produk di BOM_LIST yang tidak ada di MASTER_MATERIAL.',
        head: ['Kode produk', 'Nama produk', 'Versi BOM'], row: (p) => [p.code, p.name, p.boms.length], bom: (p) => p.code },
      uomDiff: { label: 'UoM berbeda dengan master', badge: true, rows: uomDiff,
        desc: 'Baris BOM yang satuan komponennya berbeda dengan satuan di master. Cari BOM ID-nya di tab BOM_DETAIL (DATABASE PPIC), lalu samakan UoM dan sesuaikan qty-nya. Klik baris untuk membuka BOM tersebut.',
        head: ['Kode', 'Nama material', 'BOM', 'Produk', 'Qty di BOM', 'UoM di BOM', 'UoM di master'],
        row: (x) => [x.c.code, x.m.name, x.b.id + (x.b.ref ? ' · ' + x.b.ref : ''), x.b.code + ' ' + x.b.name, fmtQ(x.c.qty), x.c.uom, x.m.uom], bom: (x) => x.b.code, ver: (x) => x.b.id },
      zero: { label: 'BOM kosong / qty 0', badge: true, rows: zero,
        desc: 'BOM tanpa komponen, atau komponen dengan qty 0/kosong.',
        head: ['BOM', 'Produk', 'Komponen', 'Qty'], row: (x) => [x.b.id + ' ' + (x.b.ref || ''), x.b.code + ' ' + x.b.name, x.c ? x.c.code + ' ' + x.c.name : '(tidak ada komponen)', x.c ? (x.c.qty === '' ? 'kosong' : x.c.qty) : '–'], bom: (x) => x.b.code },
      noBom: { label: 'FG / Ekstrak tanpa BOM', badge: false, rows: noBom,
        desc: 'Material kategori FG atau Ekstrak di master yang belum punya BOM. Wajar untuk produk yang dibeli jadi atau sudah tidak diproduksi.',
        head: ['Kode', 'Nama', 'Kategori', 'UoM'], row: (m) => [m.code, m.name, m.kat, m.uom], use: (m) => m.code },
      unused: { label: 'RM/PM tidak dipakai di BOM', badge: false, rows: unused,
        desc: 'RM atau PM di master yang tidak muncul di BOM mana pun. Bisa material lama, material baru yang BOM-nya belum dibuat, atau material non-produksi.',
        head: ['Kode', 'Nama', 'Kategori', 'UoM'], row: (m) => [m.code, m.name, m.kat, m.uom], use: (m) => m.code },
      noKat: { label: 'Master tanpa kategori', badge: false, rows: noKat,
        desc: 'Material di master yang kolom kategorinya kosong.',
        head: ['Kode', 'Nama', 'UoM'], row: (m) => [m.code, m.name, m.uom], use: (m) => m.code },
    };
  }
  function renderChecks() {
    const C = Object.assign(MRP.checks, planChecks());
    if (!MRP.kPicked) MRP.kTab = (Object.entries(C).find(([, c]) => c.rows.length) || ['notMaster'])[0];   // buka pemeriksaan pertama yang ada temuannya
    $('kTabs').innerHTML = Object.entries(C).map(([k, c]) => `<button class="chip${k === MRP.kTab ? ' is-on' : ''}" data-k="${k}" role="tab" aria-selected="${k === MRP.kTab}">${esc(c.label)} <b>${nf.format(c.rows.length)}</b></button>`).join('');
    const c = C[MRP.kTab];
    $('kTitle').textContent = `${c.label} (${nf.format(c.rows.length)})`;
    $('kDesc').textContent = c.desc;
    $('kHead').innerHTML = `<tr>${c.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>`;
    $('kRows').innerHTML = c.rows.slice(0, 1000).map((x, i) => `<tr class="row" data-i="${i}" tabindex="0">${c.row(x).map((v) => `<td>${esc(v === undefined ? '' : v)}</td>`).join('')}</tr>`).join('')
      || `<tr class="empty"><td colspan="${c.head.length}">Tidak ada. Data sudah rapi untuk pemeriksaan ini.</td></tr>`;
  }
  $('kTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (!b) return; MRP.kTab = b.dataset.k; MRP.kPicked = true; renderChecks(); });
  $('kRows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-i]'); if (!tr) return;
    const c = MRP.checks[MRP.kTab], x = c.rows[Number(tr.dataset.i)];
    if (c.bom) { MRP.sel = c.bom(x); if (c.ver) MRP.ver[MRP.sel] = c.ver(x); MRP.open.clear(); location.hash = '#/mrp/bom'; }
    else if (c.use) { MRP.use = c.use(x); location.hash = '#/mrp/dipakai'; }
  });

  /* ================= MRP TAHAP 1: RENCANA, KEBUTUHAN, PROYEKSI STOK ================= */
  // Data perencanaan dari Google Sheet "MRP PPIC GTK" (dibaca bersama BOM oleh Apps Script MRP).
  // Hitungan dilakukan di browser: rencana kg → kebutuhan material per week (ekstrak/bulk dipecah) →
  // saldo stok berjalan dengan incoming dari Monitoring PO + incoming manual.
  const P = {
    ready: false, edit: false, pin: '', hz: null, queue: new Map(), qTimer: null, saving: false,
    skus: new Map(), plan: new Map(), stock: new Map(), stockDate: '', stockSrc: '', adj: [], inc: [], weeks: [], log: [],
    parsedStock: null, parsedPlan: null,
  };
  const PLAN_KEYS = new Set(['mrp/rencana', 'mrp/kebutuhan', 'mrp/proyeksi', 'mrp/sku', 'mrp/update']);
  const BULAN_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const BULAN_PANJANG = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const monLabel = (b) => `${BULAN_PANJANG[Number(b.slice(5, 7)) - 1]} ${b.slice(0, 4)}`;
  const monShort = (b) => BULAN_ID[Number(b.slice(5, 7)) - 1];
  const addMonth = (b, n) => { const y = Number(b.slice(0, 4)), m = Number(b.slice(5, 7)) - 1 + n; return `${y + Math.floor(m / 12)}-${String(((m % 12) + 12) % 12 + 1).padStart(2, '0')}`; };
  const parseBatch = (s) => String(s || '').split(/[;,/\s]+/).map(Number).filter((x) => x > 0);
  const normU = (u) => String(u || '').trim().toLowerCase();
  const fq = (v) => { const n = numParts(v); return n.cut ? `<span class="num-cut" title="${NF9.format(n.full)}">${n.txt}</span>` : n.txt; };
  const fmtKg = (v) => (v ? numParts(v).txt : '');

  function setPlanData(d) {
    P.ready = Array.isArray(d.skus);
    P.skus = new Map((d.skus || []).map((r) => [r[0], {
      code: r[0], name: r[1], jenis: r[2] || 'SKU', bom: r[3], batchText: r[4], batch: parseBatch(r[4]),
      aktif: String(r[5] || 'Y').toUpperCase() !== 'N', note: r[6], time: r[7],
    }]));
    P.plan = new Map();
    (d.plan || []).forEach((r) => {
      if (!r[0] || !r[1] || !r[2]) return;
      P.plan.set(`${r[0]}|${r[1]}|${r[2]}`, { bulan: r[0], week: r[1], code: r[2], kg: Number(r[3]) || 0, bom: r[4] || '', src: r[5], time: r[6] });
    });
    const st = d.stock || [];
    P.stockDate = st.reduce((m, r) => (r[0] > m ? r[0] : m), '');
    P.stockSrc = (st.find((r) => r[0] === P.stockDate) || [])[5] || '';
    P.stock = new Map();
    st.filter((r) => r[0] === P.stockDate).forEach((r) => {
      const o = P.stock.get(r[1]) || { qty: 0, uom: r[4], name: r[2] };
      o.qty += Number(r[3]) || 0; P.stock.set(r[1], o);
    });
    P.adj = (d.adj || []).map((r) => ({ id: r[0], date: r[1], code: r[2], qty: Number(r[3]) || 0, note: r[4], time: r[5] }));
    P.inc = (d.inc || []).map((r) => ({ id: r[0], bulan: r[1], week: r[2], code: r[3], qty: Number(r[4]) || 0, note: r[5], time: r[6] }));
    P.weeks = (d.weeks || []).map((r) => ({ bulan: r[0], week: r[1], start: r[2], end: r[3] }));
    P.weekBy = new Map(P.weeks.map((w) => [w.bulan + '|' + w.week, w]));
    P.monthWeeks = new Map();
    P.weeks.forEach((w) => { if (!P.monthWeeks.has(w.bulan)) P.monthWeeks.set(w.bulan, []); P.monthWeeks.get(w.bulan).push(w); });
    P.log = d.log || [];
    P.mrpUrl = d.mrpUrl || CFG.MRP_SHEET_URL;
    P.hz = todayStr().slice(0, 7);   // rentang otomatis: bulan berjalan + 2 bulan
  }

  // ---------- Week ----------
  function weekOfDate(ds) {
    let lo = 0, hi = P.weeks.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, w = P.weeks[mid];
      if (ds < w.start) hi = mid - 1; else if (ds > w.end) lo = mid + 1; else return w;
    }
    return null;
  }
  const wLabel = (w) => `${w.week} ${monShort(w.bulan)}`;
  const wTitle = (w) => `${w.week} ${monLabel(w.bulan)}: ${fmtDate(w.start)} – ${fmtDate(w.end)}`;
  function hzWeeks() {
    const out = [];
    for (let i = 0; i < 3; i++) (P.monthWeeks.get(addMonth(P.hz, i)) || []).forEach((w) => out.push(w));
    return out;
  }
  function fillHz(el) {
    P.hz = todayStr().slice(0, 7);
    const short = (b) => `${monShort(b)} ${b.slice(0, 4)}`;
    el.textContent = `${short(P.hz)} – ${short(addMonth(P.hz, 2))}`;
  }


  // ---------- BOM yang dipakai ----------
  const bomById = (code, id) => (MRP.byProduct.get(code) || []).find((b) => b.id === id);
  function activeBom(code, override) {
    const list = MRP.byProduct.get(code) || [];
    if (!list.length) return null;
    const sku = P.skus.get(code);
    return (override && bomById(code, override)) || (sku && sku.bom && bomById(code, sku.bom)) || list[0];
  }
  // Pecah kebutuhan 1 baris rencana: hasil = { leaves: Map kode→qty, made: Map kode→qty (ekstrak/bulk) }
  // Komponen kategori FG (isi Banded / 2in1 / KIT, atau FG bonus di SKU biasa) tidak dipecah:
  // FG-nya sudah direncanakan sendiri, jadi cukup dicatat sebagai kebutuhan FG.
  const isFg = (code) => normU((MRP.master.get(code) || {}).kat) === 'fg';
  // Satuan rencana: produk rakitan (BOM berisi FG + kemasan saja, tanpa RM/ekstrak/bulk) diisi pcs, lainnya kg
  const unitMemo = new Map();
  function planUnit(code) {
    const bom = activeBom(code);
    if (!bom) return 'kg';
    if (unitMemo.has(bom.id)) return unitMemo.get(bom.id);
    const kats = bom.comps.map((c) => normU((MRP.master.get(c.code) || {}).kat));
    const u = kats.includes('fg') && !kats.some((k) => /raw|ekstrak|bulk/.test(k)) ? 'pcs' : 'kg';
    unitMemo.set(bom.id, u);
    return u;
  }
  function needOf(code, qty, override) {
    const bom = activeBom(code, override);
    if (!bom || !bom.batch) return null;
    // kg: BOM SKU = pcs per batch 1.000 kg (seperti MoQ); pcs: produk rakitan, qty langsung dalam pcs
    const need = planUnit(code) === 'pcs' ? qty : normU(bom.uom) === 'kg' ? qty : (qty / 1000) * bom.batch;
    const leaves = new Map(), made = new Map(), fg = new Map();
    const walk = (b, q, path, depth) => {
      const f = b.batch ? q / b.batch : 0;
      b.comps.forEach((c) => {
        const x = (Number(c.qty) || 0) * f;
        if (!x) return;
        if (isFg(c.code)) fg.set(c.code, (fg.get(c.code) || 0) + x);
        else if (MRP.byProduct.has(c.code) && depth < 6 && !path.has(c.code)) {
          made.set(c.code, (made.get(c.code) || 0) + x);
          walk(activeBom(c.code), x, new Set([...path, c.code]), depth + 1);
        } else leaves.set(c.code, (leaves.get(c.code) || 0) + x);
      });
    };
    walk(bom, need, new Set([code]), 0);
    return { bom, leaves, made, fg };
  }

  // ---------- Ukuran batch ----------
  const batchMemo = new Map();
  function batchOk(kg, sizes) {
    if (!(kg > 0) || !sizes.length) return true;
    const k = Math.round(kg * 1000) / 1000;
    const key = k + '|' + sizes.join(',');
    if (batchMemo.has(key)) return batchMemo.get(key);
    let ok;
    if (!Number.isInteger(k) || k > 200000 || sizes.some((s) => !Number.isInteger(s))) ok = sizes.some((s) => Math.abs(s - k) < 1e-6);
    else {
      const can = new Uint8Array(k + 1); can[0] = 1;
      for (let v = 1; v <= k; v++) for (const s of sizes) if (s <= v && can[v - s]) { can[v] = 1; break; }
      ok = !!can[k];
    }
    batchMemo.set(key, ok);
    return ok;
  }

  // ---------- Hitung kebutuhan ----------
  function computeReq() {
    const weeks = hzWeeks(), n = weeks.length;
    const idx = new Map(weeks.map((w, i) => [w.bulan + '|' + w.week, i]));
    const req = new Map(), made = new Map(), fgReq = new Map(), noBom = new Set();
    const add = (map, code, i, q, sku) => {
      let o = map.get(code);
      if (!o) { o = { code, w: new Array(n).fill(0), total: 0, src: new Map() }; map.set(code, o); }
      o.w[i] += q; o.total += q;
      if (!o.src.has(sku)) o.src.set(sku, new Array(n).fill(0));
      o.src.get(sku)[i] += q;
    };
    P.plan.forEach((p) => {
      const i = idx.get(p.bulan + '|' + p.week);
      if (i === undefined || !(p.kg > 0)) return;
      const r = needOf(p.code, p.kg, p.bom);
      if (!r) { noBom.add(p.code); return; }
      r.leaves.forEach((q, c) => add(req, c, i, q, p.code));
      r.made.forEach((q, c) => add(made, c, i, q, p.code));
      r.fg.forEach((q, c) => add(fgReq, c, i, q, p.code));
    });
    return { weeks, idx, req, made, fg: fgReq, noBom };
  }

  // Incoming dari Monitoring PO: jadwal yang belum Done, sisa qty-nya masuk ke week sesuai tanggal jadwal
  function poIncoming(weeks, s) {
    const n = weeks.length, out = new Map(), uomBad = [];
    if (!n) return { out, uomBad };
    const first = weeks[Math.min(s, n - 1)], lastEnd = weeks[n - 1].end;
    const idx = new Map(weeks.map((w, i) => [w.bulan + '|' + w.week, i]));
    (state.rows || []).forEach((r) => {
      if (!r.first || r.cancel || (r.takeout && r.dupCount === 1)) return;
      r.sched.forEach((sc) => {
        if (sc.status === 'Done' || !sc.date) return;
        const gap = Math.max(0, (Number(sc.qty) || 0) - (Number(sc.rec) || 0));
        if (!gap || sc.date > lastEnd) return;
        const m = MRP.master.get(r.code);
        if (m && m.uom && r.uom && normU(m.uom) !== normU(r.uom)) { uomBad.push({ r, sc, gap, m }); return; }
        let i, late = false;
        if (sc.date < first.start) { i = s; late = true; }
        else { const w = weekOfDate(sc.date); i = w ? idx.get(w.bulan + '|' + w.week) : undefined; if (i === undefined) return; if (i < s) { i = s; late = true; } }
        let o = out.get(r.code);
        if (!o) { o = { w: new Array(n).fill(0), list: [] }; out.set(r.code, o); }
        o.w[i] += gap;
        o.list.push({ po: r.po, supplier: r.supplier, date: sc.date, qty: gap, uom: r.uom, wi: i, late });
      });
    });
    return { out, uomBad };
  }

  function computeProj() {
    const R = computeReq(), weeks = R.weeks, n = weeks.length;
    let s = 0, stockNote = '';
    if (P.stockDate && n) {
      if (P.stockDate > weeks[n - 1].end) { s = n; stockNote = 'after'; }
      else if (P.stockDate >= weeks[0].start) {
        const w = weekOfDate(P.stockDate);
        s = Math.max(0, weeks.findIndex((x) => x === w));
      } else stockNote = 'before';
    }
    const inc = poIncoming(weeks, s);
    const manual = new Map();
    P.inc.forEach((x) => {
      const i = R.idx.get(x.bulan + '|' + x.week);
      if (i === undefined) return;
      const o = manual.get(x.code) || new Array(n).fill(0);
      o[Math.max(i, s)] += x.qty; manual.set(x.code, o);
    });
    const rows = [];
    R.req.forEach((q, code) => {
      const m = MRP.master.get(code) || {};
      const st = P.stock.get(code);
      const adj = P.adj.filter((a) => a.code === code && (!P.stockDate || a.date >= P.stockDate)).reduce((t, a) => t + a.qty, 0);
      const start = (st ? st.qty : 0) + adj;
      const po = inc.out.get(code), man = manual.get(code);
      const saldo = new Array(n).fill(null), inW = new Array(n).fill(0);
      let run = start, firstShort = -1, minS = Infinity, late = false;
      for (let i = s; i < n; i++) {
        inW[i] = (po ? po.w[i] : 0) + (man ? man[i] : 0);
        run += inW[i] - q.w[i];
        saldo[i] = run;
        if (run < -1e-9 && firstShort < 0) firstShort = i;
        if (run < minS) minS = run;
      }
      if (po) late = po.list.some((x) => x.late);
      rows.push({
        code, name: m.name || code, uom: m.uom || '', kat: m.kat || '', start, hasStock: !!st, adj,
        need: q.w, inW, saldo, firstShort, short: minS < 0 ? -minS : 0, total: q.total, src: q.src, po, man, late,
      });
    });
    return { R, weeks, s, rows, stockNote, uomBad: inc.uomBad };
  }

  // ---------- Simpan ke Apps Script MRP ----------
  async function mrpApi(action, payload) {
    if (!CFG.MRP_SCRIPT_URL) throw new Error('Apps Script MRP belum terpasang.');
    const res = await fetch(CFG.MRP_SCRIPT_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action, pin: P.pin }, payload)),
    });
    const data = await res.json();
    if (!data.ok) {
      if (/Aksi tidak dikenal/.test(data.error || '')) throw new Error('Apps Script MRP belum versi terbaru. Tempel Code_MRP.gs terbaru lalu Deploy → Manage deployments → Edit → New version → Deploy.');
      throw new Error(data.error || 'Gagal menyimpan.');
    }
    return data;
  }
  function setMrpEdit(on) {
    P.edit = on;
    if (!on) P.pin = '';
    document.querySelectorAll('.mrp-editbar').forEach((x) => { x.hidden = !on; });
    document.body.classList.toggle('mrp-edit-on', on);
    paintEditBtn();
    renderPlanView(state.routeKey);
  }
  function paintEditBtn() {
    const r = state.route;
    const on = r && r.actions === 'mrp' ? P.edit : state.edit.on;
    $('btnEditMode').textContent = on ? 'Keluar mode edit' : 'Mode edit';
    $('btnEditMode').classList.toggle('is-on', !!on);
  }
  function askMrpPin(after) {
    if (!P.ready) { toast('Apps Script MRP belum versi terbaru, jadi data belum bisa diubah dari website.'); return; }
    openDialog({
      title: 'Masuk mode edit MRP', ok: 'Masuk',
      body: `<p class="dlg-lead">Masukkan PIN Apps Script MRP (UPLOAD_PIN di Google Sheet MRP PPIC GTK).</p>
        <div class="form-grid">${fld('pin', 'PIN', '', { type: 'password', required: true })}</div>`,
      onSubmit: async (fd) => {
        P.pin = fd.pin.trim();
        if (!P.pin) throw new Error('Isi PIN.');
        try { await mrpApi('verify', {}); } catch (err) { P.pin = ''; throw err; }
        setMrpEdit(true);
        if (after) setTimeout(after, 50);
      },
    });
  }
  const needEdit = (after) => { if (P.edit) { after(); return; } askMrpPin(after); };

  // Antrian simpan sel rencana: dikirim berkelompok 0,7 detik setelah ketikan terakhir
  function queuePlan(cell) {
    P.queue.set(`${cell.bulan}|${cell.week}|${cell.kode}`, cell);
    paintPlanSave('wait');
    clearTimeout(P.qTimer);
    P.qTimer = setTimeout(flushPlan, 700);
  }
  async function flushPlan() {
    if (P.saving || !P.queue.size) return;
    const cells = [...P.queue.values()];
    P.queue.clear();
    P.saving = true; paintPlanSave('saving');
    try {
      const res = await mrpApi('savePlan', { cells });
      paintPlanSave('ok', savedAt(res));
    } catch (err) {
      cells.forEach((c) => { if (!P.queue.has(`${c.bulan}|${c.week}|${c.kode}`)) P.queue.set(`${c.bulan}|${c.week}|${c.kode}`, c); });
      paintPlanSave('err', err.message);
    } finally {
      P.saving = false;
      if (P.queue.size && $('plSave').dataset.s !== 'err') flushPlan();
    }
  }
  function paintPlanSave(s, info) {
    const el = $('plSave'); if (!el) return;
    el.dataset.s = s;
    el.className = 'pl-save is-' + s;
    el.innerHTML = s === 'wait' ? 'Menunggu disimpan…' : s === 'saving' ? '<span class="spin" aria-hidden="true"></span> Menyimpan ke Google Sheet…'
      : s === 'ok' ? `Tersimpan${info ? ' ' + esc(info) : ''}` : `Gagal menyimpan: ${esc(info)} <button class="btn-link" id="plRetry">Coba lagi</button>`;
  }

  // ---------- Masuk halaman ----------
  function renderPlanView(key) {
    if (!PLAN_KEYS.has(key) || !MRP.loaded) return;
    document.querySelectorAll('.mrp-old').forEach((x) => { x.hidden = P.ready; });
    if (!P.ready) return;
    if (key === 'mrp/rencana') renderRencana();
    else if (key === 'mrp/kebutuhan') renderKebutuhan();
    else if (key === 'mrp/proyeksi') renderProyeksi();
    else if (key === 'mrp/sku') renderSku();
    else if (key === 'mrp/update') renderMrpUpdate();
  }
  function weekHead(weeks, opts = {}) {
    const months = [];
    weeks.forEach((w) => { const l = months[months.length - 1]; if (l && l.b === w.bulan) l.n++; else months.push({ b: w.bulan, n: 1 }); });
    const lead = opts.lead || '', tail = opts.tail || '';
    return `<tr class="pl-mhead">${lead}${months.map((m) => `<th colspan="${m.n}" class="pl-month">${monLabel(m.b)}</th>`).join('')}${tail ? `<th colspan="${opts.tailN || 1}"></th>` : ''}</tr>`;
  }
  const matCell = (code, name, extra = '') => `<td class="pl-sticky pl-c1"><span class="pl-code">${esc(code)}</span>${extra}<span class="pl-name" title="${esc(name)}">${esc(name)}</span></td>`;
  const kpis = (list) => list.map((k) => `<div class="pk${k.tone ? ' is-' + k.tone : ''}"${k.title ? ` title="${esc(k.title)}"` : ''}><span class="pk-num">${k.num}</span><span class="pk-lbl">${k.lbl}</span></div>`).join('');
  const weekTh = (weeks, extra = () => '') => weeks.map((w, i) => `<th class="num pl-w${wCls(weeks, i)}${extra(i)}" title="${esc(wTitle(w))}">${w.week}<small>${fmtDate(w.start).slice(0, 6)}</small></th>`).join('');
  const wCls = (weeks, i) => (i === 0 || weeks[i - 1].bulan !== weeks[i].bulan ? ' m-start' : '');

  /* ---------- Rencana Produksi ---------- */
  function planRowsList() {
    const codes = new Set();
    P.skus.forEach((k) => { if (k.jenis !== 'Ekstrak' && k.aktif) codes.add(k.code); });
    const weeks = hzWeeks(), keys = new Set(weeks.map((w) => w.bulan + '|' + w.week));
    P.plan.forEach((p) => { if (keys.has(p.bulan + '|' + p.week) && p.kg > 0) codes.add(p.code); });
    return [...codes].sort((a, b) => a.localeCompare(b, 'id', { numeric: true }));
  }
  function renderRencana() {
    fillHz($('plHz'));
    const weeks = hzWeeks();
    const q = $('plQ').value.trim().toLowerCase(), only = $('plOnly').checked;
    const nameOf = (c) => (P.skus.get(c) || {}).name || ((MRP.master.get(c) || {}).name) || ((MRP.byProduct.get(c) || [])[0] || {}).name || '';
    let codes = planRowsList().filter((c) => !q || (c + ' ' + nameOf(c)).toLowerCase().includes(q));
    const cell = (c, w) => P.plan.get(`${w.bulan}|${w.week}|${c}`);
    if (only) codes = codes.filter((c) => weeks.some((w) => (cell(c, w) || {}).kg > 0));
    $('plHead').innerHTML = weekHead(weeks, { lead: '<th class="pl-sticky pl-c1"></th>', tail: true }) +
      `<tr><th class="pl-sticky pl-c1">SKU <small class="pl-thnote">kg; Banded/2in1/KIT dalam pcs · klik untuk BOM per week</small></th>${weekTh(weeks)}<th class="num">Total</th></tr>`;
    const tot = new Array(weeks.length).fill(0);
    let nWarn = 0;
    $('plRows').innerHTML = codes.map((c) => {
      const sku = P.skus.get(c), list = MRP.byProduct.get(c) || [], multi = list.length > 1, pcs = planUnit(c) === 'pcs';
      let rowTot = 0;
      const tds = weeks.map((w, i) => {
        const p = cell(c, w), kg = p ? p.kg : 0;
        if (!pcs) tot[i] += kg;
        rowTot += kg;
        const warn = !pcs && kg > 0 && sku && !batchOk(kg, sku.batch);
        if (warn) nWarn++;
        const b = kg > 0 ? activeBom(c, p.bom) : null;
        const tip = [b ? `BOM terkunci: ${b.id} · ${b.ref || '-'}` : '', warn ? `${fmtKg(kg)} kg bukan kelipatan/gabungan ukuran batch (${sku.batch.join(', ')} kg)` : ''].filter(Boolean).join('\n');
        const t = tip ? ` title="${esc(tip)}"` : '';
        const tag = b && multi ? `<small class="pl-cbom${sku && b.id !== sku.bom ? ' is-diff' : ''}">${esc(b.id.replace('BOM-', ''))}</small>` : '';
        return P.edit
          ? `<td class="num pl-cell${warn ? ' pl-warn' : ''}${wCls(weeks, i)}"${t}><input class="pl-in" inputmode="decimal" data-b="${w.bulan}" data-w="${w.week}" data-c="${esc(c)}" value="${kg || ''}" aria-label="${esc(c)} ${esc(wLabel(w))} ${pcs ? 'pcs' : 'kg'}">${tag}</td>`
          : `<td class="num pl-cell${warn ? ' pl-warn' : ''}${wCls(weeks, i)}"${t}>${fmtKg(kg)}${tag}</td>`;
      }).join('');
      const bomTxt = !list.length ? '<span class="pl-bad pl-sub">Tidak ada BOM</span>' : `<span class="pl-sub">BOM default ${esc(((sku && bomById(c, sku.bom)) || list[0]).id.replace('BOM-', ''))}${multi ? ` · ${list.length} versi` : ''}</span>`;
      const badges = (pcs ? '<span class="pl-unit" title="Produk rakitan (Banded / 2in1 / KIT): diisi dalam pcs; komponen FG-nya tidak dipecah ke bahan baku">pcs</span>' : '') + (sku ? '' : '<span class="pl-tmp" title="Belum ada di Parameter SKU">baru</span>');
      return `<tr data-code="${esc(c)}"${pcs ? ' class="is-pcs"' : ''}>${matCell(c, nameOf(c), badges).replace('</td>', bomTxt + '</td>').replace('class="pl-sticky pl-c1"', 'class="pl-sticky pl-c1 pl-click" tabindex="0" title="Klik untuk melihat / mengubah BOM per week"')}${tds}<td class="num pl-rowtot"><b>${fmtKg(rowTot)}</b>${pcs && rowTot ? ' <small>pcs</small>' : ''}</td></tr>`;
    }).join('') || `<tr class="empty"><td colspan="${weeks.length + 2}">Tidak ada SKU yang cocok.</td></tr>`;
    $('plFoot').innerHTML = `<tr><td class="pl-sticky pl-c1"><b>Total kg</b></td>${tot.map((v, i) => `<td class="num${wCls(weeks, i)}"><b>${fmtKg(v)}</b></td>`).join('')}<td class="num"><b>${fmtKg(tot.reduce((a, b) => a + b, 0))}</b></td></tr>`;
    const nCell = [...P.plan.values()].filter((p) => p.kg > 0 && weeks.some((w) => w.bulan === p.bulan && w.week === p.week)).length;
    const perMon = [0, 1, 2].map((i) => { const b = addMonth(P.hz, i); return { b, kg: [...P.plan.values()].filter((p) => p.bulan === b && planUnit(p.code) !== 'pcs').reduce((t, p) => t + p.kg, 0) }; });
    const pcsTot = [...P.plan.values()].filter((p) => planUnit(p.code) === 'pcs' && weeks.some((w) => w.bulan === p.bulan && w.week === p.week)).reduce((t, p) => t + p.kg, 0);
    $('plKpi').innerHTML = kpis(perMon.map((m) => ({ num: m.kg ? fmtKg(m.kg) : '0', lbl: `kg ${monLabel(m.b)}` }))
      .concat(pcsTot ? [{ num: fmtKg(pcsTot), lbl: 'pcs Banded/2in1/KIT (3 bulan)' }] : [])
      .concat([{ num: nf.format(nWarn), lbl: 'sel bukan ukuran batch', tone: nWarn ? 'warn' : '', title: 'Kg yang tidak bisa disusun dari ukuran batch SKU (sel kuning). Hanya peringatan.' }]));
    $('plInfo').textContent = `${nf.format(codes.length)} SKU ditampilkan · ${nf.format(nCell)} sel berisi rencana`;
  }
  $('plQ').addEventListener('input', renderRencana);
  $('plOnly').addEventListener('change', renderRencana);
  $('plTable').addEventListener('change', (e) => {
    const inp = e.target.closest('.pl-in'); if (!inp) return;
    const raw = inp.value.trim().replace(/\./g, '').replace(',', '.');
    const kg = raw === '' ? 0 : Number(raw);
    if (isNaN(kg) || kg < 0) { inp.classList.add('is-bad'); toast('Isi qty dengan angka.'); return; }
    inp.classList.remove('is-bad');
    const b = inp.dataset.b, w = inp.dataset.w, c = inp.dataset.c, k = `${b}|${w}|${c}`;
    const old = P.plan.get(k);
    const lock = (old && old.bom) || (activeBom(c) || {}).id || '';   // BOM dikunci saat week ini pertama diisi
    if (kg > 0) P.plan.set(k, { bulan: b, week: w, code: c, kg, bom: lock, src: 'Website', time: '' });
    else P.plan.delete(k);
    queuePlan({ bulan: b, week: w, kode: c, kg: kg || '', bom: kg > 0 ? lock : '' });
    // Perbarui total tanpa menggambar ulang tabel (fokus tetap di sel)
    const tr = inp.closest('tr'), sku = P.skus.get(c), td = inp.closest('td');
    const pcsRow = planUnit(c) === 'pcs';
    const warn = !pcsRow && kg > 0 && sku && !batchOk(kg, sku.batch);
    td.classList.toggle('pl-warn', !!warn);
    td.title = warn ? `${fmtKg(kg)} kg bukan kelipatan/gabungan ukuran batch (${sku.batch.join(', ')} kg)` : '';
    const weeks = hzWeeks();
    const rt = weeks.reduce((t, x) => t + ((P.plan.get(`${x.bulan}|${x.week}|${c}`) || {}).kg || 0), 0);
    tr.querySelector('.pl-rowtot').innerHTML = `<b>${fmtKg(rt)}</b>${pcsRow && rt ? ' <small>pcs</small>' : ''}`;
    const tot = weeks.map((x) => [...P.plan.values()].filter((p) => p.bulan === x.bulan && p.week === x.week && planUnit(p.code) !== 'pcs').reduce((t, p) => t + p.kg, 0));
    const tds = $('plFoot').querySelectorAll('td');
    tot.forEach((v, i) => { tds[1 + i].innerHTML = `<b>${fmtKg(v)}</b>`; });
    tds[1 + tot.length].innerHTML = `<b>${fmtKg(tot.reduce((a, x) => a + x, 0))}</b>`;
  });
  $('plTable').addEventListener('keydown', (e) => {
    const inp = e.target.closest('.pl-in'); if (!inp || (e.key !== 'Enter' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault();
    const td = inp.closest('td'), col = [...td.parentNode.children].indexOf(td);
    const tr = e.key === 'ArrowUp' ? td.parentNode.previousElementSibling : td.parentNode.nextElementSibling;
    const next = tr && tr.children[col] && tr.children[col].querySelector('.pl-in');
    if (next) { next.focus(); next.select(); } else inp.blur();
  });
  $('plTable').addEventListener('click', (e) => {
    const td = e.target.closest('td.pl-click'); if (!td) return;
    openWeekBom(td.closest('tr').dataset.code);
  });
  $('plTable').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('td.pl-click')) openWeekBom(e.target.closest('tr').dataset.code); });
  // BOM per week: tiap week yang ada rencananya mengunci satu versi BOM
  function openWeekBom(code) {
    const weeks = hzWeeks(), list = MRP.byProduct.get(code) || [], sku = P.skus.get(code);
    const def = (sku && bomById(code, sku.bom)) || list[0];
    const rows = weeks.map((w) => ({ w, p: P.plan.get(`${w.bulan}|${w.week}|${code}`) })).filter((x) => x.p && x.p.kg > 0);
    const canEdit = P.edit && rows.length && list.length > 1;
    const opt = (sel) => list.map((b) => `<option value="${esc(b.id)}"${b.id === sel ? ' selected' : ''}>${esc(b.id)} · ${esc(b.ref || '-')} · ${b.comps.length} komponen</option>`).join('');
    openDialog({
      title: `BOM per week · ${code}`, ok: canEdit ? 'Simpan' : 'Tutup', cancel: !!canEdit, wide: true,
      body: `<p class="dlg-lead">${esc((sku && sku.name) || ((list[0] || {}).name) || '')}. Setiap week yang ada rencananya mengunci satu versi BOM; versi itu yang dipakai untuk menghitung kebutuhan week tersebut. Rencana baru otomatis memakai BOM default${def ? ` (<b>${esc(def.id)}</b> · ${esc(def.ref || '-')})` : ''} dari Parameter SKU.</p>
        ${!rows.length ? '<p class="muted">Belum ada rencana untuk SKU ini di rentang yang ditampilkan.</p>' : `<div class="table-wrap"><table class="po-table pl-mini"><thead><tr><th>Week</th><th>Tanggal</th><th class="num">Qty ${planUnit(code)}</th><th>BOM terkunci</th></tr></thead><tbody>
        ${rows.map(({ w, p }) => { const b = activeBom(code, p.bom); return `<tr><td><b>${esc(wLabel(w))}</b> ${esc(w.bulan.slice(0, 4))}</td><td>${fmtDate(w.start)} – ${fmtDate(w.end)}</td><td class="num">${fmtKg(p.kg)}</td><td>${canEdit ? `<select class="wb-sel" data-k="${esc(w.bulan + '|' + w.week)}">${opt(b ? b.id : '')}</select>` : `${esc(b ? b.id : '-')} <span class="muted">${esc(b ? b.ref || '' : '')}</span>`}${p.bom && !bomById(code, p.bom) ? ' <span class="pl-bad">(BOM terkunci sebelumnya sudah tidak ada)</span>' : ''}</td></tr>`; }).join('')}
        </tbody></table></div>`}
        ${!P.edit && rows.length && list.length > 1 ? '<p class="hint">Masuk mode edit untuk mengganti BOM per week.</p>' : ''}
        ${canEdit ? '<p class="pj-actions"><button type="button" class="btn btn-sm btn-ghost" id="wbAll">Samakan semua ke BOM default</button></p>' : ''}`,
      onSubmit: canEdit ? async () => {
        const cells = [];
        $('dlgBody').querySelectorAll('.wb-sel').forEach((sel) => {
          const [bulan, week] = sel.dataset.k.split('|'), p = P.plan.get(`${bulan}|${week}|${code}`);
          if (p && p.bom !== sel.value) cells.push({ bulan, week, kode: code, kg: p.kg, bom: sel.value });
        });
        if (!cells.length) return 'Tidak ada perubahan.';
        await mrpApi('savePlan', { cells });
        cells.forEach((c) => { P.plan.get(`${c.bulan}|${c.week}|${code}`).bom = c.bom; });
        setTimeout(renderRencana, 0);
        return `BOM ${cells.length} week tersimpan.`;
      } : null,
    });
    const all = $('dlgBody').querySelector('#wbAll');
    if (all && def) all.addEventListener('click', () => $('dlgBody').querySelectorAll('.wb-sel').forEach((x) => { x.value = def.id; }));
  }
  document.addEventListener('click', (e) => { if (e.target.id === 'plRetry') { paintPlanSave('saving'); flushPlan(); } });
  $('plUpload').addEventListener('click', () => { location.hash = '#/mrp/update'; setTimeout(() => $('planFile').focus(), 100); });
  // Format upload kosong: baris 1 = judul week (kunci lookup), baris 2 = tanggal week
  function downloadPlanTemplate() {
    const weeks = hzWeeks();
    const head = ['KODE', 'NAMA (opsional)'].concat(weeks.map((w) => `${w.week} ${BULAN_PANJANG[Number(w.bulan.slice(5)) - 1].toUpperCase()} ${w.bulan.slice(0, 4)}`));
    const dates = ['Isi kode SKU mulai baris 3', 'Qty kg (Banded/2in1/KIT: pcs)'].concat(weeks.map((w) => `${fmtDate(w.start).slice(0, 6)} – ${fmtDate(w.end).slice(0, 6)}`));
    const ws = XLSX.utils.aoa_to_sheet([head, dates]);
    ws['!cols'] = [{ wch: 14 }, { wch: 38 }].concat(weeks.map(() => ({ wch: 20 })));
    ws['!freeze'] = { xSplit: 2, ySplit: 2 };
    const info = XLSX.utils.aoa_to_sheet([
      ['Format upload rencana produksi (MRP PPIC GTK)'], [''],
      ['1. Isi kode SKU di kolom A mulai baris 3, qty di kolom week. Kolom NAMA boleh dikosongkan.'],
      ['   Satuan qty: kg untuk produk biasa; pcs untuk produk rakitan (Banded / 2in1 / KIT).'],
      ['2. Baris 1 (mis. "W1 NOVEMBER 2026") adalah kunci kolom; jangan diubah. Baris 2 hanya keterangan tanggal.'],
      ['3. Upload di website: MRP → Update Data MRP → Upload rencana produksi.'],
      ['4. Bulan yang ada di file mengganti rencana bulan itu; kode yang tidak ada di DATABASE diberi peringatan.'], [''],
      ['Rentang', `${monLabel(P.hz)} – ${monLabel(addMonth(P.hz, 2))}`], ['Dibuat', todayStr()],
    ]);
    info['!cols'] = [{ wch: 100 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'PLAN WEEKLY');
    XLSX.utils.book_append_sheet(wb, info, 'PETUNJUK');
    XLSX.writeFile(wb, `Format_Upload_Rencana_${monShort(P.hz)}${P.hz.slice(0, 4)}-${monShort(addMonth(P.hz, 2))}${addMonth(P.hz, 2).slice(0, 4)}.xlsx`);
  }
  $('plTpl').addEventListener('click', downloadPlanTemplate);
  $('upTpl').addEventListener('click', downloadPlanTemplate);
  $('plExport').addEventListener('click', () => {
    const weeks = hzWeeks();
    const data = planRowsList().map((c) => {
      const o = { KODE: c, NAMA: (P.skus.get(c) || {}).name || '', SATUAN: planUnit(c), BOM: (activeBom(c) || {}).id || '' };
      weeks.forEach((w) => { o[`${w.week} ${BULAN_PANJANG[Number(w.bulan.slice(5)) - 1].toUpperCase()} ${w.bulan.slice(0, 4)}`] = (P.plan.get(`${w.bulan}|${w.week}|${c}`) || {}).kg || 0; });
      return o;
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'PLAN WEEKLY');
    XLSX.writeFile(wb, `Rencana_Produksi_${P.hz}_${todayStr()}.xlsx`);
  });

  /* ---------- Kebutuhan Material ---------- */
  function renderKebutuhan() {
    fillHz($('kbHz'));
    const R = computeReq(), weeks = R.weeks;
    const q = $('kbQ').value.trim().toLowerCase(), kat = $('kbKat').value, type = $('kbType').value;
    const src = type === 'made' ? R.made : type === 'fg' ? R.fg : R.req;
    let rows = [...src.values()].map((o) => { const m = MRP.master.get(o.code) || {}; return Object.assign({ name: m.name || o.code, uom: m.uom || '', kat: m.kat || 'Tanpa kategori' }, o); });
    const kats = [...new Set(rows.map((r) => r.kat))].sort((a, b) => a.localeCompare(b, 'id'));
    const cur = $('kbKat').value;
    $('kbKat').innerHTML = '<option value="">Semua kategori</option>' + kats.map((k) => `<option${k === cur ? ' selected' : ''}>${esc(k)}</option>`).join('');
    rows = rows.filter((r) => (!q || (r.code + ' ' + r.name).toLowerCase().includes(q)) && (!kat || r.kat === kat))
      .sort((a, b) => a.code.localeCompare(b.code, 'id', { numeric: true }));
    P.kbRows = rows;
    $('kbHead').innerHTML = weekHead(weeks, { lead: '<th class="pl-sticky pl-c1"></th><th></th>', tail: true }) +
      `<tr><th class="pl-sticky pl-c1">Material</th><th>UoM</th>${weekTh(weeks)}<th class="num">Total</th></tr>`;
    $('kbRows').innerHTML = rows.slice(0, 1500).map((r, i) => `<tr class="row" data-i="${i}" tabindex="0">${matCell(r.code, r.name, `<span class="pl-kat">${esc(r.kat)}</span>`)}<td class="pl-uom">${esc(r.uom)}</td>${r.w.map((v, j) => `<td class="num${wCls(weeks, j)}">${v ? fq((v)) : ''}</td>`).join('')}<td class="num"><b>${fq((r.total))}</b></td></tr>`).join('')
      || `<tr class="empty"><td colspan="${weeks.length + 3}">${P.plan.size ? 'Tidak ada kebutuhan di rentang ini.' : 'Belum ada rencana produksi.'}</td></tr>`;
    const byKat = {};
    [...src.values()].forEach((o) => { const k = (MRP.master.get(o.code) || {}).kat || 'Tanpa kategori'; byKat[k] = (byKat[k] || 0) + 1; });
    $('kbKpi').innerHTML = kpis([{ num: nf.format(R.req.size), lbl: 'material dibeli (RM/PM)' }, { num: nf.format(R.made.size), lbl: 'ekstrak/bulk diproduksi' }, { num: nf.format(R.fg.size), lbl: 'FG untuk rakitan/bonus', title: 'Komponen FG di Banded / 2in1 / KIT dan FG bonus; tidak dipecah ke bahan baku' }]
      .concat(Object.entries(byKat).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => ({ num: nf.format(n), lbl: k })))
      .concat(R.noBom.size ? [{ num: nf.format(R.noBom.size), lbl: 'SKU tanpa BOM', tone: 'bad', title: [...R.noBom].join(', ') }] : []));
    $('kbInfo').textContent = `${nf.format(rows.length)} ${type === 'made' ? 'ekstrak/bulk' : type === 'fg' ? 'FG' : 'material'} ditampilkan · klik baris untuk melihat SKU yang memakai`;
  }
  const round4 = (v) => Math.round(v * 10000) / 10000;
  $('kbQ').addEventListener('input', renderKebutuhan);
  $('kbKat').addEventListener('change', renderKebutuhan);
  $('kbType').addEventListener('change', renderKebutuhan);
  $('kbRows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-i]'); if (!tr) return;
    const r = P.kbRows[Number(tr.dataset.i)], weeks = hzWeeks();
    const lines = [...r.src.entries()].sort((a, b) => a[0].localeCompare(b[0], 'id', { numeric: true }));
    openDialog({
      title: `${r.code} · ${r.name}`, ok: 'Tutup', wide: true, cancel: false, onSubmit: null,
      body: `<p class="dlg-lead">Kebutuhan per SKU (${esc(r.uom)}). Termasuk yang lewat ekstrak/bulk.</p>
        <div class="table-wrap"><table class="po-table pl-mini"><thead><tr><th>SKU</th>${weeks.map((w) => `<th class="num" title="${esc(wTitle(w))}">${esc(wLabel(w))}</th>`).join('')}<th class="num">Total</th></tr></thead>
        <tbody>${lines.map(([sku, arr]) => `<tr><td><b>${esc(sku)}</b> ${esc((P.skus.get(sku) || {}).name || '')}</td>${arr.map((v) => `<td class="num">${v ? fq((v)) : ''}</td>`).join('')}<td class="num"><b>${fq((arr.reduce((a, b) => a + b, 0)))}</b></td></tr>`).join('')}</tbody></table></div>`,
    });
  });
  $('kbExport').addEventListener('click', () => {
    const weeks = hzWeeks();
    const data = (P.kbRows || []).map((r) => {
      const o = { KODE: r.code, NAMA: r.name, KATEGORI: r.kat, UoM: r.uom };
      weeks.forEach((w, i) => { o[wLabel(w) + ' ' + w.bulan.slice(0, 4)] = round4(r.w[i]); });
      o.TOTAL = round4(r.total); return o;
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Kebutuhan Material');
    XLSX.writeFile(wb, `Kebutuhan_Material_${P.hz}_${todayStr()}.xlsx`);
  });

  /* ---------- Proyeksi Stok ---------- */
  function renderProyeksi() {
    fillHz($('pjHz'));
    const J = computeProj(), weeks = J.weeks, s = J.s;
    P.proj = J;
    const q = $('pjQ').value.trim().toLowerCase(), mode = $('pjMode').value, kat = $('pjKat').value;
    const kats = [...new Set(J.rows.map((r) => r.kat || 'Tanpa kategori'))].sort((a, b) => a.localeCompare(b, 'id'));
    $('pjKat').innerHTML = '<option value="">Semua kategori</option>' + kats.map((k) => `<option${k === kat ? ' selected' : ''}>${esc(k)}</option>`).join('');
    let rows = J.rows.filter((r) => (!q || (r.code + ' ' + r.name).toLowerCase().includes(q)) && (!kat || (r.kat || 'Tanpa kategori') === kat));
    if (mode === 'short') rows = rows.filter((r) => r.firstShort >= 0);
    rows.sort((a, b) => (a.firstShort < 0) - (b.firstShort < 0) || (a.firstShort - b.firstShort) || b.short - a.short || a.code.localeCompare(b.code, 'id', { numeric: true }));
    P.pjRows = rows;
    const nShort = J.rows.filter((r) => r.firstShort >= 0).length;
    // Keterangan stok
    let note;
    $('pjNoStock').hidden = !!P.stockDate;
    if (!P.stockDate) note = 'Saldo dihitung dari stok 0, jadi hampir semua material terlihat kurang.';
    else if (J.stockNote === 'after') note = `Stok per ${fmtDate(P.stockDate)} lebih baru dari rentang ini. Geser rentang ke bulan stok.`;
    else if (J.stockNote === 'before') note = `Stok per <b>${fmtDate(P.stockDate)}</b> lebih awal dari rentang ini; kebutuhan antara tanggal stok dan awal rentang tidak ikut dihitung.`;
    else note = `Stok awal = stok per <b>${fmtDate(P.stockDate)}</b> (${esc(P.stockSrc || 'upload')}) + koreksi. Perhitungan mulai ${esc(wLabel(weeks[s]))}; week sebelumnya diabaikan.`;
    $('pjNote').innerHTML = note + (J.uomBad.length ? ` · <span class="pl-bad">${J.uomBad.length} jadwal PO tidak dihitung karena UoM PO beda dengan master</span> (lihat Pemeriksaan Data).` : '');
    $('pjHead').innerHTML = weekHead(weeks, { lead: '<th class="pl-sticky pl-c1"></th><th colspan="2"></th>', tail: true, tailN: 2 }) +
      `<tr><th class="pl-sticky pl-c1">Material</th><th>UoM</th><th class="num">Stok awal</th>${weekTh(weeks, (i) => (i < s ? ' is-past' : ''))}<th>Mulai kurang</th><th class="num">Kurang</th></tr>`;
    $('pjRows').innerHTML = rows.slice(0, 1500).map((r, i) => `<tr class="row" data-i="${i}" tabindex="0">${matCell(r.code, r.name, r.late ? '<span class="pl-tmp" title="Ada jadwal PO yang sudah lewat tapi belum datang; dimasukkan ke week pertama">PO telat</span>' : '')}<td class="pl-uom">${esc(r.uom)}</td>
      <td class="num">${r.hasStock || r.adj ? fq((r.start)) : '<span class="muted">0</span>'}</td>
      ${weeks.map((w, j) => {
        if (j < s) return `<td class="num is-past${wCls(weeks, j)}"></td>`;
        const v = r.saldo[j], neg = v < -1e-9;
        const sub = (r.inW[j] ? `<span class="pj-in">+${fq((r.inW[j]))}</span>` : '') + (r.need[j] ? `<span class="pj-out">−${fq((r.need[j]))}</span>` : '');
        return `<td class="num pj-cell${neg ? ' is-neg' : ''}${wCls(weeks, j)}"><b>${fq((v))}</b>${sub ? `<small>${sub}</small>` : ''}</td>`;
      }).join('')}
      <td>${r.firstShort >= 0 ? `<span class="badge b-late">${esc(wLabel(weeks[r.firstShort]))}</span>` : '<span class="badge b-done">Aman</span>'}</td>
      <td class="num">${r.short ? `<b class="pl-bad">${fq((r.short))}</b>` : ''}</td></tr>`).join('')
      || `<tr class="empty"><td colspan="${weeks.length + 5}">${mode === 'short' && J.rows.length ? 'Tidak ada material yang kurang di rentang ini.' : 'Belum ada kebutuhan material di rentang ini.'}</td></tr>`;
    const firstW = J.rows.filter((r) => r.firstShort === s).length;
    const nPo = J.rows.filter((r) => r.po).length, nNoSt = P.stockDate ? J.rows.filter((r) => !r.hasStock).length : 0;
    $('pjKpi').innerHTML = kpis([
      { num: nf.format(nShort), lbl: 'material akan kurang', tone: nShort ? 'bad' : 'ok' },
      { num: nf.format(firstW), lbl: weeks[s] ? `sudah kurang di ${wLabel(weeks[s])}` : 'kurang di week pertama', tone: firstW ? 'bad' : '' },
      { num: nf.format(J.rows.length), lbl: 'material terpakai' },
      { num: nf.format(nPo), lbl: 'punya jadwal PO terbuka' },
    ].concat(P.stockDate ? [{ num: nf.format(nNoSt), lbl: 'tidak ada di file stok', tone: nNoSt ? 'warn' : '', title: 'Stok awalnya dianggap 0' }] : []));
    $('pjInfo').textContent = `${nf.format(rows.length)} material ditampilkan · klik baris untuk rincian, jadwal PO, incoming manual, dan koreksi stok` + (state.rows && state.rows.length ? '' : ' · data PO belum dimuat, incoming PO belum dihitung');
  }
  ['pjQ', 'pjMode', 'pjKat'].forEach((id) => $(id).addEventListener(id === 'pjQ' ? 'input' : 'change', renderProyeksi));
  $('pjRows').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-i]'); if (tr) openProjDetail(P.pjRows[Number(tr.dataset.i)].code); });
  $('pjRows').addEventListener('keydown', (e) => { if (e.key !== 'Enter') return; const tr = e.target.closest('tr[data-i]'); if (tr) openProjDetail(P.pjRows[Number(tr.dataset.i)].code); });
  function openProjDetail(code) {
    const J = computeProj(); P.proj = J;
    const r = J.rows.find((x) => x.code === code); if (!r) return;
    const weeks = J.weeks, s = J.s, vis = weeks.map((w, i) => i).filter((i) => i >= s);
    const row = (label, f, cls = '') => `<tr class="${cls}"><th>${label}</th>${vis.map((i) => `<td class="num">${f(i)}</td>`).join('')}</tr>`;
    const q4 = (v) => (v ? fq((v)) : '');
    const poList = r.po ? r.po.list.slice().sort((a, b) => (a.date < b.date ? -1 : 1)) : [];
    const manList = P.inc.filter((x) => x.code === code), adjList = P.adj.filter((x) => x.code === code);
    const srcList = [...r.src.entries()].map(([sku, arr]) => [sku, arr.reduce((a, b) => a + b, 0)]).sort((a, b) => b[1] - a[1]);
    openDialog({
      title: `${r.code} · ${r.name}`, ok: 'Tutup', wide: true, cancel: false, onSubmit: null,
      body: `<p class="dlg-lead">UoM ${esc(r.uom || '-')} · stok awal <b>${fq((r.start))}</b>${P.stockDate ? ` (stok per ${fmtDate(P.stockDate)}${r.adj ? `, koreksi ${r.adj > 0 ? '+' : ''}${fq((r.adj))}` : ''})` : ' (belum ada data stok)'}</p>
        <div class="table-wrap"><table class="po-table pl-mini pj-detail"><thead><tr><th></th>${vis.map((i) => `<th class="num" title="${esc(wTitle(weeks[i]))}">${esc(wLabel(weeks[i]))}</th>`).join('')}</tr></thead><tbody>
          ${row('Incoming PO', (i) => q4(r.po ? r.po.w[i] : 0))}
          ${row('Incoming manual', (i) => q4(r.man ? r.man[i] : 0))}
          ${row('Kebutuhan', (i) => q4(r.need[i]))}
          ${row('Saldo akhir', (i) => `<b class="${r.saldo[i] < -1e-9 ? 'pl-bad' : ''}">${fq((r.saldo[i]))}</b>`, 'pj-sum')}
        </tbody></table></div>
        <h3 class="pj-h">Jadwal PO yang masuk hitungan (${poList.length})</h3>
        ${poList.length ? `<div class="table-wrap"><table class="po-table pl-mini"><thead><tr><th>No PO</th><th>Supplier</th><th>Jadwal</th><th>Masuk week</th><th class="num">Sisa qty</th></tr></thead><tbody>${poList.map((x) => `<tr><td><button class="btn-link" data-po="${esc(x.po)}">${esc(x.po)}</button></td><td>${esc(x.supplier)}</td><td>${fmtDate(x.date)}${x.late ? ' <span class="badge b-late">telat</span>' : ''}</td><td>${esc(wLabel(weeks[x.wi]))}</td><td class="num">${fmtQ(x.qty)} ${esc(x.uom)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Tidak ada jadwal PO terbuka di rentang ini.</p>'}
        <h3 class="pj-h">Incoming manual (${manList.length})</h3>
        ${manList.length ? `<ul class="pj-list">${manList.map((x) => `<li><b>${x.qty > 0 ? '+' : ''}${fmtQ(x.qty)}</b> · ${esc(x.week)} ${esc(monLabel(x.bulan))} · ${esc(x.note)} <span class="muted">${esc(x.time)}</span>${P.edit ? ` <button class="btn-link danger" data-del-inc="${esc(x.id)}">Hapus</button>` : ''}</li>`).join('')}</ul>` : '<p class="muted">Belum ada.</p>'}
        <h3 class="pj-h">Koreksi stok (${adjList.length})</h3>
        ${adjList.length ? `<ul class="pj-list">${adjList.map((x) => `<li><b>${x.qty > 0 ? '+' : ''}${fmtQ(x.qty)}</b> · ${fmtDate(x.date)} · ${esc(x.note)}${P.stockDate && x.date < P.stockDate ? ' <span class="muted">(sebelum tanggal stok, tidak dihitung)</span>' : ''}${P.edit ? ` <button class="btn-link danger" data-del-adj="${esc(x.id)}">Hapus</button>` : ''}</li>`).join('')}</ul>` : '<p class="muted">Belum ada.</p>'}
        <div class="pj-actions"><button type="button" class="btn btn-sm" id="pjAddInc">Tambah incoming manual</button><button type="button" class="btn btn-sm btn-ghost" id="pjAddAdj">Koreksi stok</button></div>
        <h3 class="pj-h">Dipakai oleh</h3>
        <p class="pj-src">${srcList.map(([sku, v]) => `<span><b>${esc(sku)}</b> ${fq((v))}</span>`).join('')}</p>`,
    });
    const body = $('dlgBody');
    body.querySelector('#pjAddInc').addEventListener('click', () => needEdit(() => incForm(code)));
    body.querySelector('#pjAddAdj').addEventListener('click', () => needEdit(() => adjForm(code)));
    body.querySelectorAll('[data-po]').forEach((b) => b.addEventListener('click', () => { $('dlg').close(); goMonitor({ q: b.dataset.po, jenis: '', supplier: '' }); }));
    body.querySelectorAll('[data-del-inc],[data-del-adj]').forEach((b) => b.addEventListener('click', async () => {
      const kind = b.dataset.delInc ? 'inc' : 'adj', id = b.dataset.delInc || b.dataset.delAdj;
      b.disabled = true; b.textContent = 'Menghapus…';
      try {
        await mrpApi('delRow', { kind, id });
        if (kind === 'inc') P.inc = P.inc.filter((x) => x.id !== id); else P.adj = P.adj.filter((x) => x.id !== id);
        toast('Dihapus.'); renderProyeksi(); openProjDetail(code);
      } catch (err) { b.disabled = false; b.textContent = 'Hapus'; toast('Gagal: ' + err.message); }
    }));
  }
  function incForm(code) {
    const weeks = hzWeeks().filter((w, i) => !P.proj || i >= P.proj.s);
    openDialog({
      title: `Tambah incoming manual · ${code}`, ok: 'Simpan',
      body: `<p class="dlg-lead">Untuk kedatangan di luar jadwal PO (atau koreksi jadwal). Isi minus untuk mengurangi.</p>
        <div class="form-grid">
          <label class="field"><span>Week *</span><select name="wk">${weeks.map((w) => `<option value="${w.bulan}|${w.week}">${esc(wTitle(w))}</option>`).join('')}</select></label>
          ${fld('qty', `Qty (${esc((MRP.master.get(code) || {}).uom || '')}) *`, '', { type: 'number', step: 'any', required: true })}
          ${fld('ket', 'Keterangan *', '', { required: true, wide: true })}
        </div>`,
      onSubmit: async (fd) => {
        const [bulan, week] = fd.wk.split('|'), qty = Number(fd.qty);
        if (!qty) throw new Error('Isi qty.');
        const res = await mrpApi('addInc', { bulan, week, kode: code, qty, ket: fd.ket.trim() });
        P.inc.push({ id: res.id, bulan, week, code, qty, note: fd.ket.trim(), time: res.time });
        setTimeout(() => { renderProyeksi(); openProjDetail(code); }, 0);
        return 'Incoming manual tersimpan.';
      },
    });
    const qi = $('dlgBody').querySelector('[name=qty]'); if (qi) qi.removeAttribute('min');
  }
  function adjForm(code) {
    openDialog({
      title: `Koreksi stok · ${code}`, ok: 'Simpan',
      body: `<p class="dlg-lead">Tambah (+) atau kurangi (−) stok tanpa upload ulang. Dihitung bila tanggalnya sama atau sesudah tanggal stok${P.stockDate ? ` (${fmtDate(P.stockDate)})` : ''}.</p>
        <div class="form-grid">
          ${fld('tanggal', 'Tanggal *', todayStr(), { type: 'date', required: true })}
          ${fld('qty', `Qty +/− (${esc((MRP.master.get(code) || {}).uom || '')}) *`, '', { type: 'number', step: 'any', required: true })}
          ${fld('alasan', 'Alasan *', '', { required: true, wide: true })}
        </div>`,
      onSubmit: async (fd) => {
        const qty = Number(fd.qty);
        if (!qty) throw new Error('Isi qty.');
        const res = await mrpApi('addAdj', { tanggal: fd.tanggal, kode: code, qty, alasan: fd.alasan.trim() });
        P.adj.push({ id: res.id, date: fd.tanggal, code, qty, note: fd.alasan.trim(), time: res.time });
        setTimeout(() => { renderProyeksi(); openProjDetail(code); }, 0);
        return 'Koreksi stok tersimpan.';
      },
    });
    const qi = $('dlgBody').querySelector('[name=qty]'); if (qi) qi.removeAttribute('min');
  }
  $('pjExport').addEventListener('click', () => {
    const J = P.proj; if (!J) return;
    const data = (P.pjRows || []).map((r) => {
      const o = { KODE: r.code, NAMA: r.name, UoM: r.uom, 'STOK AWAL': round4(r.start) };
      J.weeks.forEach((w, i) => {
        if (i < J.s) return;
        const k = wLabel(w) + ' ' + w.bulan.slice(0, 4);
        o[k + ' IN'] = round4(r.inW[i]); o[k + ' KEBUTUHAN'] = round4(r.need[i]); o[k + ' SALDO'] = round4(r.saldo[i]);
      });
      o['MULAI KURANG'] = r.firstShort >= 0 ? wLabel(J.weeks[r.firstShort]) : ''; o.KURANG = round4(r.short);
      return o;
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Proyeksi Stok');
    XLSX.writeFile(wb, `Proyeksi_Stok_${P.hz}_${todayStr()}.xlsx`);
  });

  /* ---------- Parameter SKU ---------- */
  const skuPayload = (k) => ({ kode: k.code, nama: k.name, jenis: k.jenis, bom: k.bom, batch: k.batchText, aktif: k.aktif ? 'Y' : 'N', catatan: k.note });
  async function saveSkuRow(p) {
    const res = await mrpApi('saveSku', { sku: p });
    P.skus.set(p.kode, { code: p.kode, name: p.nama, jenis: p.jenis || 'SKU', bom: p.bom, batchText: p.batch, batch: parseBatch(p.batch), aktif: p.aktif !== 'N', note: p.catatan, time: res.time });
    toast(`${p.kode} tersimpan.`);
    return res;
  }
  function renderSku() {
    const q = $('skQ').value.trim().toLowerCase(), j = $('skJenis').value;
    const rows = [...P.skus.values()].filter((k) => (!q || (k.code + ' ' + k.name).toLowerCase().includes(q)) && (!j || (j === 'off' ? !k.aktif : k.jenis === j)))
      .sort((a, b) => (a.jenis === b.jenis ? a.code.localeCompare(b.code, 'id', { numeric: true }) : a.jenis === 'SKU' ? -1 : 1));
    P.skRows = rows;
    $('skRows').innerHTML = rows.map((k, i) => {
      const list = MRP.byProduct.get(k.code) || [], b = bomById(k.code, k.bom);
      const subs = b ? [...new Set(b.comps.filter((c) => MRP.byProduct.has(c.code)).map((c) => c.code))] : [];
      return `<tr class="row${k.aktif ? '' : ' is-off'}" data-i="${i}" tabindex="0"><td class="mono">${esc(k.code)}</td><td>${esc(k.name)}</td><td>${esc(k.jenis)}</td>
        <td>${b ? `${esc(b.id)} <span class="muted">${esc(b.ref || '')}</span>` : `<span class="pl-bad">${k.bom ? esc(k.bom) + ' tidak ditemukan' : 'belum dipilih'}</span>`}${list.length > 1 ? ` <span class="muted">(${list.length} versi)</span>` : ''}</td>
        <td>${esc(k.batch.join(' · ')) || '<span class="muted">–</span>'}</td>
        <td>${subs.map((c) => `<span class="pl-chip" title="${esc((MRP.master.get(c) || {}).name || '')}">${esc(c)}</span>`).join(' ') || '<span class="muted">–</span>'}</td>
        <td>${k.aktif ? 'Ya' : '<span class="muted">Tidak</span>'}</td><td>${esc(k.note || '')}</td><td class="muted">${esc(k.time || '')}</td></tr>`;
    }).join('') || '<tr class="empty"><td colspan="9">Tidak ada SKU yang cocok.</td></tr>';
    const nS = [...P.skus.values()].filter((k) => k.jenis !== 'Ekstrak' && k.aktif).length;
    $('skInfo').textContent = `${nf.format(nS)} SKU aktif · ${nf.format([...P.skus.values()].filter((k) => k.jenis === 'Ekstrak').length)} ekstrak/bulk · klik baris untuk mengubah (mode edit)`;
  }
  $('skQ').addEventListener('input', renderSku);
  $('skJenis').addEventListener('change', renderSku);
  $('skRows').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-i]'); if (tr) { const k = P.skRows[Number(tr.dataset.i)]; needEdit(() => skuForm(k)); } });
  $('skAdd').addEventListener('click', () => needEdit(() => skuForm(null)));
  function skuForm(k) {
    const isNew = !k;
    const prods = MRP.products.filter((p) => !P.skus.has(p.code));
    openDialog({
      title: isNew ? 'Tambah SKU' : `Ubah ${k.code}`, ok: 'Simpan',
      body: `<div class="form-grid">
          ${isNew ? fld('kode', 'Kode produk *', '', { required: true, list: 'dlSkuProd' }) : fld('kode', 'Kode produk', k.code, { readonly: true })}
          <label class="field"><span>Jenis</span><select name="jenis"><option${!k || k.jenis !== 'Ekstrak' ? ' selected' : ''}>SKU</option><option${k && k.jenis === 'Ekstrak' ? ' selected' : ''}>Ekstrak</option></select></label>
          <label class="field span-2"><span>BOM default (dipakai untuk rencana baru)</span><select name="bom" id="skBomSel"></select></label>
          ${!isNew && k.jenis !== 'Ekstrak' ? `<label class="field span-2 tb-check"><input type="checkbox" name="apply" value="1"> Kunci juga week yang belum lewat (mulai ${esc(fmtDate(todayStr()))}) ke BOM ini</label>` : ''}
          ${fld('batch', 'Ukuran batch (kg), pisahkan dengan ;', k ? k.batchText : '', { wide: true })}
          <label class="field"><span>Aktif</span><select name="aktif"><option value="Y"${!k || k.aktif ? ' selected' : ''}>Ya, tampil di rencana</option><option value="N"${k && !k.aktif ? ' selected' : ''}>Tidak</option></select></label>
          ${fld('catatan', 'Catatan', k ? k.note : '', { wide: true })}
        </div>${isNew ? `<datalist id="dlSkuProd">${prods.map((p) => `<option value="${esc(p.code)}">${esc(p.name)}</option>`).join('')}</datalist>` : ''}
        <p class="hint">Week yang sudah ada rencananya tetap memakai BOM yang terkunci, kecuali dicentang di atas atau diubah lewat klik SKU di Rencana Produksi. Jenis Ekstrak = versi BOM ekstrak/bulk yang dipakai saat dipecah dari SKU.</p>`,
      onSubmit: async (fd) => {
        const code = (fd.kode || '').trim();
        if (!MRP.byProduct.has(code)) throw new Error('Kode ini tidak punya BOM di DATABASE PPIC.');
        const p = MRP.products.find((x) => x.code === code);
        await saveSkuRow({ kode: code, nama: (k && k.name) || (p && p.name) || '', jenis: fd.jenis, bom: fd.bom, batch: fd.batch.trim(), aktif: fd.aktif, catatan: fd.catatan.trim() });
        if (fd.apply) {
          const today = todayStr();
          const cells = [...P.plan.values()].filter((x) => x.code === code && x.kg > 0 && x.bom !== fd.bom && (P.weekBy.get(x.bulan + '|' + x.week) || {}).end >= today)
            .map((x) => ({ bulan: x.bulan, week: x.week, kode: code, kg: x.kg, bom: fd.bom }));
          if (cells.length) { await mrpApi('savePlan', { cells }); cells.forEach((c) => { P.plan.get(`${c.bulan}|${c.week}|${code}`).bom = fd.bom; }); toast(`${cells.length} week ikut dikunci ke ${fd.bom}.`); }
        }
        renderSku();
      },
    });
    const fillBom = () => {
      const code = (isNew ? $('dlgBody').querySelector('[name=kode]').value : k.code).trim();
      const list = MRP.byProduct.get(code) || [];
      $('skBomSel').innerHTML = list.map((b) => `<option value="${esc(b.id)}"${k && b.id === k.bom ? ' selected' : ''}>${esc(b.id)} · ${esc(b.ref || '-')} · ${b.comps.length} komponen</option>`).join('') || '<option value="">Kode belum punya BOM</option>';
    };
    fillBom();
    if (isNew) $('dlgBody').querySelector('[name=kode]').addEventListener('input', fillBom);
  }

  /* ---------- Update Data MRP: upload stok & rencana ---------- */
  function renderMrpUpdate() {
    $('upStockNow').innerHTML = P.stockDate ? `Tersimpan sekarang: stok per <b>${fmtDate(P.stockDate)}</b> · ${nf.format(P.stock.size)} material · ${esc(P.stockSrc)}` : '<b>Belum ada stok tersimpan.</b> Proyeksi Stok menghitung dari stok 0.';
    $('upStockNow').className = 'up-now' + (P.stockDate ? '' : ' is-empty');
    const lastPlan = [...P.plan.values()].reduce((m, p) => (p.time > m ? p.time : m), '');
    $('upPlanNow').className = 'up-now' + (P.plan.size ? '' : ' is-empty');
    $('upPlanNow').innerHTML = P.plan.size ? `Tersimpan sekarang: ${nf.format(P.plan.size)} sel · bulan ${[...new Set([...P.plan.values()].map((p) => p.bulan))].sort().map(monLabel).join(', ')}${lastPlan ? ` · terakhir diubah ${esc(lastPlan)}` : ''}` : 'Belum ada rencana tersimpan.';
    $('upLog').innerHTML = P.log.map((l) => `<tr><td class="muted">${esc(l[0])}</td><td>${esc(l[1])}</td><td>${esc(l[2])}</td></tr>`).join('') || '<tr class="empty"><td colspan="3">Belum ada riwayat.</td></tr>';
  }
  async function readBook(file) {
    const buf = await file.arrayBuffer();
    return XLSX.read(buf, { type: 'array', cellDates: false });
  }
  const sheetRows = (wb, name) => XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: true });

  // Stok: cari kolom kode/produk dan qty di 20 baris pertama
  const ST_CODE = /^(kode|kode material|kode barang|kode produk|code|item code|internal reference|referensi internal|default_code|product\/internal reference|product_id\/default_code)$/i;
  const ST_PROD = /^(product|produk|nama produk|item|product\/display name|product_id|barang)$/i;
  const ST_QTY = /^(on hand|on hand quantity|quantity on hand|qty on hand|quantity|qty|stok|stock|jumlah|kuantitas|available quantity|quantity_available|qty available|saldo)$/i;
  const ST_UOM = /^(uom|unit|unit of measure|satuan|product_uom_id|product\/unit of measure)$/i;
  const ST_NAME = /^(nama|name|nama material|description|deskripsi)$/i;
  function parseStock(wb, fileName) {
    for (const sn of wb.SheetNames) {
      const rows = sheetRows(wb, sn);
      for (let h = 0; h < Math.min(rows.length, 20); h++) {
        const head = rows[h].map((x) => txt(x));
        const iQ = head.findIndex((x) => ST_QTY.test(x));
        const iC = head.findIndex((x) => ST_CODE.test(x)), iP = head.findIndex((x) => ST_PROD.test(x));
        if (iQ < 0 || (iC < 0 && iP < 0)) continue;
        const iU = head.findIndex((x) => ST_UOM.test(x)), iN = head.findIndex((x) => ST_NAME.test(x));
        const agg = new Map(); let skipped = 0;
        rows.slice(h + 1).forEach((r) => {
          let code = iC >= 0 ? normCode(r[iC]) : '';
          let name = iN >= 0 ? txt(r[iN]) : '';
          if (!code && iP >= 0) { const p = txt(r[iP]); const m = p.match(/^\[([^\]]+)\]\s*(.*)$/); if (m) { code = m[1].trim(); name = name || m[2]; } else code = p; }
          const qty = Number(r[iQ]);
          if (!code || isNaN(qty)) { if (code || txt(r[iQ])) skipped++; return; }
          const o = agg.get(code) || { code, name: name || ((MRP.master.get(code) || {}).name || ''), qty: 0, uom: iU >= 0 ? txt(r[iU]) : '' };
          o.qty += qty; agg.set(code, o);
        });
        const m = fileName.match(/(\d{1,2})[-_.](\d{1,2})[-_.](\d{2,4})/);
        let date = '';
        if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; date = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; if (isNaN(new Date(date))) date = ''; }
        return { sheet: sn, head: { qty: head[iQ], code: iC >= 0 ? head[iC] : head[iP] }, rows: [...agg.values()], skipped, date };
      }
    }
    throw new Error('Kolom kode/produk dan qty tidak ditemukan. Pastikan file punya judul kolom seperti "Product" / "Internal Reference" dan "Quantity" / "On Hand".');
  }
  $('stockFile').addEventListener('change', async () => {
    const f = $('stockFile').files[0];
    $('stockName').textContent = f ? f.name : 'Belum ada file';
    $('stockCheck').className = 'check'; $('stockCheck').textContent = '';
    P.parsedStock = null; $('stockSend').disabled = true;
    if (!f) return;
    try {
      const p = parseStock(await readBook(f), f.name);
      p.file = f.name; P.parsedStock = p;
      if (p.date) $('stockDate').value = p.date;
      const notM = p.rows.filter((r) => !MRP.master.has(r.code));
      const uomDiff = p.rows.filter((r) => { const m = MRP.master.get(r.code); return m && r.uom && m.uom && normU(m.uom) !== normU(r.uom); });
      $('stockCheck').className = 'check ok';
      $('stockCheck').innerHTML = `Terbaca dari sheet <b>${esc(p.sheet)}</b> (kolom "${esc(p.head.code)}" dan "${esc(p.head.qty)}"): <b>${nf.format(p.rows.length)}</b> material.`
        + (notM.length ? `<br><span class="pl-bad">${nf.format(notM.length)} kode tidak ada di master</span>: ${esc(notM.slice(0, 12).map((r) => r.code).join(', '))}${notM.length > 12 ? '…' : ''}` : '')
        + (uomDiff.length ? `<br><span class="pl-bad">${nf.format(uomDiff.length)} UoM beda dengan master</span>: ${esc(uomDiff.slice(0, 8).map((r) => `${r.code} (${r.uom} vs ${MRP.master.get(r.code).uom})`).join(', '))}` : '')
        + (p.skipped ? `<br><span class="muted">${nf.format(p.skipped)} baris dilewati (qty bukan angka).</span>` : '');
      $('stockSend').disabled = false;
    } catch (err) { $('stockCheck').className = 'check err'; $('stockCheck').textContent = err.message; }
  });
  $('stockSend').addEventListener('click', () => needEdit(async () => {
    const p = P.parsedStock, date = $('stockDate').value;
    if (!p) return;
    if (!date) { $('stockCheck').className = 'check err'; $('stockCheck').textContent = 'Isi tanggal stok dulu.'; return; }
    $('stockSend').disabled = true; $('stockResult').className = 'send-result'; $('stockResult').textContent = 'Mengirim ke Google Sheet…';
    try {
      const res = await mrpApi('uploadStock', { date, file: p.file, rows: p.rows.map((r) => [r.code, r.name, round4(r.qty), r.uom]) });
      $('stockResult').className = 'send-result ok';
      $('stockResult').textContent = `Tersimpan ${savedAt(res)}: ${nf.format(res.saved)} material, stok per ${fmtDate(date)}.`;
      P.parsedStock = null; $('stockFile').value = ''; $('stockName').textContent = 'Belum ada file';
      loadMrp(true);
    } catch (err) { $('stockResult').className = 'send-result err'; $('stockResult').textContent = 'Gagal: ' + err.message; $('stockSend').disabled = false; }
  }));

  // Rencana: kolom "W1 NOVEMBER" … (seperti PLAN WEEKLY / MPS) atau "2026-11 W1"
  const MON_MAP = { JAN: 1, JANUARI: 1, JANUARY: 1, FEB: 2, FEBRUARI: 2, FEBRUARY: 2, MAR: 3, MARET: 3, MARCH: 3, APR: 4, APRIL: 4, MEI: 5, MAY: 5, JUN: 6, JUNI: 6, JUNE: 6, JUL: 7, JULI: 7, JULY: 7, AGU: 8, AGT: 8, AGS: 8, AGUSTUS: 8, AUG: 8, AUGUST: 8, SEP: 9, SEPT: 9, SEPTEMBER: 9, OKT: 10, OKTOBER: 10, OCT: 10, OCTOBER: 10, NOV: 11, NOVEMBER: 11, DES: 12, DESEMBER: 12, DEC: 12, DECEMBER: 12 };
  function weekHeader(h) {
    const s = txt(h).toUpperCase().replace(/\s+/g, ' ');
    let m = s.match(/^(\d{4})-(\d{2}) ?W([1-5])$/);
    if (m) return { bulan: `${m[1]}-${m[2]}`, week: 'W' + m[3] };
    m = s.match(/^W ?([1-5]) ([A-Z]+)(?: (\d{4}))?$/);
    if (!m || !MON_MAP[m[2]]) return null;
    const mon = MON_MAP[m[2]];
    let y = m[3] ? Number(m[3]) : null;
    if (!y) {   // tanpa tahun: pilih tahun terdekat dari bulan ini (3 bulan ke belakang – 8 bulan ke depan)
      const now = todayStr(), cy = Number(now.slice(0, 4)), cm = Number(now.slice(5, 7));
      y = [cy - 1, cy, cy + 1].find((yy) => { const d = (yy * 12 + mon) - (cy * 12 + cm); return d >= -3 && d <= 8; }) || cy;
    }
    return { bulan: `${y}-${String(mon).padStart(2, '0')}`, week: 'W' + m[1] };
  }
  function parsePlan(wb) {
    const names = wb.SheetNames.slice().sort((a, b) => (/plan weekly/i.test(b) ? 1 : 0) - (/plan weekly/i.test(a) ? 1 : 0));
    for (const sn of names) {
      const rows = sheetRows(wb, sn);
      for (let h = 0; h < Math.min(rows.length, 15); h++) {
        const head = rows[h];
        const iK = head.findIndex((x) => /^kode( sku| produk)?$/i.test(txt(x)));
        if (iK < 0) continue;
        const cols = new Map();
        head.forEach((x, i) => { const w = weekHeader(x); if (w) { const k = w.bulan + '|' + w.week; if (!cols.has(k)) cols.set(k, { i, w }); } });
        if (!cols.size) continue;
        const cells = [], unknown = new Set(), notSku = new Set(), warn = [];
        rows.slice(h + 1).forEach((r) => {
          const code = normCode(r[iK]);
          if (!code || /^total/i.test(code)) return;
          cols.forEach(({ i, w }) => {
            const kg = Number(r[i]);
            if (!(kg > 0)) return;
            if (!MRP.byProduct.has(code)) unknown.add(code);
            else if (!P.skus.has(code)) notSku.add(code);
            const sku = P.skus.get(code);
            if (sku && planUnit(code) !== 'pcs' && !batchOk(kg, sku.batch)) warn.push(`${code} ${w.week} ${monShort(w.bulan)}: ${fmtKg(kg)} kg`);
            cells.push({ bulan: w.bulan, week: w.week, code, kg });
          });
        });
        const months = [...new Set([...cols.values()].map((c) => c.w.bulan))].sort();
        const noWeek = [...cols.values()].filter((c) => !P.weekBy.has(c.w.bulan + '|' + c.w.week)).map((c) => `${c.w.week} ${monLabel(c.w.bulan)}`);
        return { sheet: sn, months, cells, unknown: [...unknown], notSku: [...notSku], warn, noWeek };
      }
    }
    throw new Error('Kolom KODE dan kolom week (mis. "W1 NOVEMBER") tidak ditemukan. Pakai sheet PLAN WEEKLY dari template, atau unduh contoh dari menu Rencana Produksi.');
  }
  $('planFile').addEventListener('change', async () => {
    const f = $('planFile').files[0];
    $('planName').textContent = f ? f.name : 'Belum ada file';
    $('planCheck').className = 'check'; $('planCheck').textContent = '';
    P.parsedPlan = null; $('planSend').disabled = true;
    if (!f) return;
    try {
      const p = parsePlan(await readBook(f)); p.file = f.name; P.parsedPlan = p;
      const kg = p.cells.reduce((t, c) => t + c.kg, 0);
      const before = [...P.plan.values()].filter((x) => p.months.includes(x.bulan));
      $('planCheck').className = 'check ok';
      $('planCheck').innerHTML = `Sheet <b>${esc(p.sheet)}</b> · bulan <b>${p.months.map(monLabel).join(', ')}</b> · <b>${nf.format(p.cells.length)}</b> sel berisi · total <b>${fmtKg(kg)} kg</b> dari ${nf.format(new Set(p.cells.map((c) => c.code)).size)} SKU.`
        + `<br>Rencana yang sekarang tersimpan untuk bulan tersebut (${nf.format(before.length)} sel, ${fmtKg(before.reduce((t, x) => t + x.kg, 0))} kg) akan <b>diganti</b>. Bulan lain tidak berubah.`
        + (p.unknown.length ? `<div class="warn-box up-warn"><b>${p.unknown.length} kode SKU tidak ada di DATABASE (tidak punya BOM):</b> ${esc(p.unknown.join(', '))}<br>Tetap ikut disimpan, tetapi kebutuhan materialnya tidak bisa dihitung sampai BOM-nya ada. Periksa apakah kodenya salah ketik.</div>` : '')
        + (p.notSku.length ? `<br><span class="muted">${p.notSku.length} SKU belum ada di Parameter SKU (BOM dikunci ke versi pertama): ${esc(p.notSku.join(', '))}</span>` : '')
        + (p.warn.length ? `<br><span class="pl-warn-t">${p.warn.length} sel bukan ukuran batch</span>: ${esc(p.warn.slice(0, 8).join(' · '))}${p.warn.length > 8 ? '…' : ''}` : '')
        + (p.noWeek.length ? `<br><span class="pl-bad">Week tidak ada di PEMBAGIAN_WEEK</span>: ${esc(p.noWeek.join(', '))}` : '');
      $('planSend').disabled = !p.cells.length && !before.length;
    } catch (err) { $('planCheck').className = 'check err'; $('planCheck').textContent = err.message; }
  });
  $('planSend').addEventListener('click', () => needEdit(async () => {
    const p = P.parsedPlan; if (!p) return;
    $('planSend').disabled = true; $('planResult').className = 'send-result'; $('planResult').textContent = 'Mengirim ke Google Sheet…';
    try {
      const res = await mrpApi('replacePlan', { months: p.months, file: p.file, rows: p.cells.map((c) => [c.bulan, c.week, c.code, c.kg, ((P.plan.get(`${c.bulan}|${c.week}|${c.code}`) || {}).bom) || (activeBom(c.code) || {}).id || '']) });
      $('planResult').className = 'send-result ok';
      $('planResult').textContent = `Tersimpan ${savedAt(res)}: ${nf.format(res.saved)} sel untuk ${p.months.map(monLabel).join(', ')}.`;
      P.parsedPlan = null; $('planFile').value = ''; $('planName').textContent = 'Belum ada file';
      loadMrp(true);
    } catch (err) { $('planResult').className = 'send-result err'; $('planResult').textContent = 'Gagal: ' + err.message; $('planSend').disabled = false; }
  }));

  // ---------- Pemeriksaan data tambahan (rencana & PO) ----------
  function planChecks() {
    if (!P.ready) return {};
    const weeks = hzWeeks(), keys = new Set(weeks.map((w) => w.bulan + '|' + w.week));
    const planNoBom = [], planBatch = [];
    P.plan.forEach((p) => {
      if (!(p.kg > 0)) return;
      if (!MRP.byProduct.has(p.code)) planNoBom.push(p);
      const sku = P.skus.get(p.code);
      if (sku && planUnit(p.code) !== 'pcs' && !batchOk(p.kg, sku.batch)) planBatch.push({ p, sku });
    });
    const skuBad = [...P.skus.values()].filter((k) => !k.bom || !bomById(k.code, k.bom));
    const lockGone = [...P.plan.values()].filter((p) => p.kg > 0 && (!p.bom || !bomById(p.code, p.bom)) && MRP.byProduct.has(p.code));
    let uomPo = [], noStock = [];
    if (MRP.loaded && P.weeks.length) {
      const J = computeProj();
      uomPo = J.uomBad;
      if (P.stockDate) noStock = J.rows.filter((r) => !r.hasStock);
    }
    planBatch.sort((a, b) => (a.p.bulan + a.p.week + a.p.code).localeCompare(b.p.bulan + b.p.week + b.p.code));
    void keys;
    return {
      planNoBom: { label: 'Rencana: SKU tanpa BOM', badge: true, rows: planNoBom,
        desc: 'Baris rencana produksi yang kodenya tidak punya BOM di DATABASE PPIC, jadi kebutuhannya tidak bisa dihitung.',
        head: ['Bulan', 'Week', 'Kode', 'Qty kg'], row: (p) => [monLabel(p.bulan), p.week, p.code, fmtKg(p.kg)] },
      lockGone: { label: 'Rencana: BOM terkunci tidak ada', badge: true, rows: lockGone,
        desc: 'Baris rencana yang BOM terkuncinya kosong atau sudah tidak ada di DATABASE PPIC. Hitungan memakai BOM default SKU; kunci ulang lewat klik SKU di Rencana Produksi (mode edit).',
        head: ['Bulan', 'Week', 'Kode', 'Qty kg', 'BOM terkunci'], row: (p) => [monLabel(p.bulan), p.week, p.code, fmtKg(p.kg), p.bom || '(kosong)'] },
      skuBad: { label: 'SKU: BOM default tidak valid', badge: true, rows: skuBad,
        desc: 'SKU di Parameter SKU yang BOM default-nya kosong atau sudah tidak ada. Hitungan memakai BOM pertama sampai diperbaiki.',
        head: ['Kode', 'Nama', 'Jenis', 'BOM tersimpan'], row: (k) => [k.code, k.name, k.jenis, k.bom || '(kosong)'], bom: (k) => k.code },
      planBatch: { label: 'Rencana: bukan ukuran batch', badge: false, rows: planBatch,
        desc: 'Qty kg yang tidak bisa disusun dari ukuran batch SKU (Parameter SKU). Hanya peringatan; tetap dihitung.',
        head: ['Bulan', 'Week', 'Kode', 'Qty kg', 'Ukuran batch (kg)'], row: (x) => [monLabel(x.p.bulan), x.p.week, x.p.code, fmtKg(x.p.kg), x.sku.batch.join(', ')] },
      uomPo: { label: 'PO: UoM beda dengan master', badge: true, rows: uomPo,
        desc: 'Jadwal PO terbuka yang satuannya berbeda dengan master material. Tidak dihitung sebagai incoming di Proyeksi Stok sampai satuannya disamakan.',
        head: ['No PO', 'Kode', 'Nama', 'Jadwal', 'Sisa qty', 'UoM PO', 'UoM master'], row: (x) => [x.r.po, x.r.code, x.r.name, fmtDate(x.sc.date), fmtQ(x.gap), x.r.uom, x.m.uom], use: (x) => x.r.code },
      noStock: { label: 'Material terpakai tanpa data stok', badge: false, rows: noStock,
        desc: 'Material yang dibutuhkan rencana tetapi tidak ada di file stok terakhir; stok awalnya dianggap 0.',
        head: ['Kode', 'Nama', 'UoM', 'Kebutuhan di rentang'], row: (r) => [r.code, r.name, r.uom, fq((r.total))], use: (r) => r.code },
    };
  }

  // Kartu MRP di Beranda: jumlah material yang akan kurang
  function refreshMrpHome() {
    if (window.TASKS) setTimeout(() => window.TASKS.refresh(), 0);
    const el = $('hMrpShort'); if (!el) return;
    if (!MRP.loaded || !P.ready) { el.textContent = '–'; return; }
    try { const J = computeProj(); el.textContent = nf.format(J.rows.filter((r) => r.firstShort >= 0).length); } catch (e) { el.textContent = '–'; }
  }

  /* ---------- Tugas di Beranda: anomali PO & MRP (dirender oleh tasks.js) ---------- */
  function poTasks() {
    if (!state.freshLoaded) return null;
    const T = [];
    const rows = state.rows.filter((r) => RMPM_SET.has(r.jenis));
    const uniq = (list) => { const m = new Map(); list.forEach((r) => { const k = r.po + '|' + r.code; if (!m.has(k)) m.set(k, r); }); return [...m.values()]; };
    const ut = uploadTimes();
    [['PO-DET', ut.det], ['PO-DEL', ut.del]].forEach(([f, t]) => {
      const n = t ? workdaysSince(String(t).slice(0, 10)) : Infinity;
      if (n >= FRESH_WARN) T.push({ id: 'po-basi-' + f, proj: 'PO', level: n >= FRESH_LATE ? 'urgent' : 'check',
        title: `Upload export ${f} dari Odoo`, count: n === Infinity ? 0 : n, unit: n === Infinity ? '' : 'hari kerja',
        desc: t ? `Terakhir di-upload ${String(t).slice(0, 16)}. Angka PO di website bisa sudah tidak sesuai Odoo.` : 'Belum pernah di-upload lewat website.',
        link: '#/po/update', linkLabel: 'Update Data PO', keys: [f + String(t).slice(0, 10)], items: [] });
    });
    const short = uniq(rows.filter((r) => r.shortage > 0)).sort((a, b) => (b.lateDays || 0) - (a.lateDays || 0));
    const noFollow = short.filter((r) => !r.follow || r.follow.status === 'Belum dihubungi');
    if (noFollow.length) T.push({ id: 'po-shortage', proj: 'PO', level: 'urgent', title: 'Hubungi supplier: material terlambat / kurang kirim', count: noFollow.length, unit: 'baris PO',
      desc: 'Shortage RM/PM yang belum ada tindak lanjut. Catat hasilnya di Monitoring PO (klik baris → Tindak lanjut).',
      link: '#/po/dashboard', linkLabel: 'Dashboard PO', keys: noFollow.map((r) => r.po + '|' + r.code + '|' + r.shortage),
      items: noFollow.map((r) => `${r.po} · ${r.name} · kurang ${fmtNum(r.shortage)} ${r.uom}${r.lateDays ? ` · ${r.lateDays} hari` : ''} · ${r.supplier}`) });
    const esk = short.filter((r) => r.follow && r.follow.status === 'Eskalasi');
    if (esk.length) T.push({ id: 'po-eskalasi', proj: 'PO', level: 'urgent', title: 'Tindak lanjut berstatus Eskalasi', count: esk.length, unit: 'baris PO',
      desc: 'Shortage yang sudah dieskalasi dan masih belum datang.', link: '#/po/dashboard', linkLabel: 'Dashboard PO', keys: esk.map((r) => r.po + '|' + r.code),
      items: esk.map((r) => `${r.po} · ${r.name} · ${r.supplier}${r.follow.note ? ' · ' + r.follow.note : ''}`) });
    const noSched = uniq(rows.filter((r) => r.status === 'none'));
    if (noSched.length) T.push({ id: 'po-nosched', proj: 'PO', level: 'check', title: 'PO belum punya jadwal kedatangan', count: noSched.length, unit: 'baris PO',
      desc: 'Baris PO RM/PM yang belum dijadwalkan di Odoo, sehingga tidak masuk kalender dan incoming MRP.', link: '#/po/monitoring', linkLabel: 'Monitoring PO',
      keys: noSched.map((r) => r.po + '|' + r.code), items: noSched.map((r) => `${r.po} · ${fmtDate(r.date)} · ${r.name} · ${r.supplier}`) });
    try {
      const a = attentionData();
      const keys = a.orphans.map((x) => 'o' + x.po + x.code).concat(a.mism.filter((x) => jenisOk(x.r, RMPM)).map((x) => 'm' + x.r.po + x.r.code), a.takeout.filter((x) => jenisOk(x.r, RMPM)).map((x) => 't' + x.r.po + x.r.code), a.cancelled.map((x) => 'c' + x.c.po + x.c.code));
      if (keys.length) T.push({ id: 'po-perhatian', proj: 'PO', level: 'check', title: 'Data PO tidak konsisten (Perhatian Khusus)', count: keys.length, unit: 'temuan',
        desc: `Jadwal tanpa baris PO ${a.orphans.length}, total jadwal ≠ qty order ${a.mism.filter((x) => jenisOk(x.r, RMPM)).length}, take out masih berjadwal ${a.takeout.filter((x) => jenisOk(x.r, RMPM)).length}, cancel di website tapi aktif di Odoo ${a.cancelled.length}.`,
        link: '#/po/perhatian', linkLabel: 'Perhatian Khusus', keys, items: [] });
    } catch (e) { /* abaikan */ }
    const today = todayStr(), plus7 = ymd(new Date(Date.now() + 7 * 86400000));
    const week = [];
    uniq(rows.filter((r) => !isClosed(r))).forEach((r) => r.sched.forEach((x) => { if (x.status !== 'Done' && x.date >= today && x.date <= plus7) week.push({ r, x }); }));
    week.sort((a, b) => a.x.date.localeCompare(b.x.date));
    if (week.length) T.push({ id: 'po-week', proj: 'PO', level: 'info', title: 'Kedatangan 7 hari ke depan', count: week.length, unit: 'jadwal',
      desc: 'Siapkan penerimaan di gudang dan pantau supaya tidak terlambat.', link: '#/po/kalender', linkLabel: 'Kalender Kedatangan', noHandle: true, keys: [],
      items: week.map(({ r, x }) => `${fmtDate(x.date)} · ${r.name} · ${fmtNum(Math.max(0, (Number(x.qty) || 0) - (Number(x.rec) || 0)))} ${r.uom} · ${r.supplier}`) });
    return T;
  }
  function mrpTasks() {
    if (!MRP.loaded || !P.ready) return null;
    const T = [];
    const planned = [...P.plan.values()].some((p) => p.kg > 0);
    if (!planned) return T;                     // MRP belum dipakai (hold): tidak ada tugas
    if (!P.stockDate) T.push({ id: 'mrp-stok', proj: 'MRP', level: 'check', title: 'Upload stok RM/PM dari Odoo', count: 0, unit: '', desc: 'Rencana produksi sudah ada tetapi stok belum pernah di-upload; kekurangan dihitung dari stok 0.', link: '#/mrp/update', linkLabel: 'Update Data MRP', keys: ['nostock'], items: [] });
    try {
      const J = computeProj();
      const sh = J.rows.filter((r) => r.firstShort >= 0).sort((a, b) => a.firstShort - b.firstShort);
      if (sh.length) T.push({ id: 'mrp-short', proj: 'MRP', level: 'urgent', title: 'Material akan kurang untuk rencana produksi', count: sh.length, unit: 'material',
        desc: 'Saldo proyeksi minus di salah satu week. Cek PO yang perlu dibuat atau dipercepat.', link: '#/mrp/proyeksi', linkLabel: 'Proyeksi Stok', keys: sh.map((r) => r.code + '|' + r.firstShort),
        items: sh.map((r) => `${r.code} · ${r.name} · kurang ${fmtQ(r.short)} ${r.uom} · mulai ${wLabel(J.weeks[r.firstShort])}`) });
      const ck = planChecks();
      const bad = ['planNoBom', 'lockGone', 'skuBad', 'uomPo'].flatMap((k) => (ck[k] ? ck[k].rows.map((x, i) => k + i) : []));
      if (bad.length) T.push({ id: 'mrp-cek', proj: 'MRP', level: 'check', title: 'Data MRP perlu dirapikan', count: bad.length, unit: 'temuan', desc: 'Rencana tanpa BOM, BOM terkunci hilang, BOM default tidak valid, atau UoM PO beda master.', link: '#/mrp/cek', linkLabel: 'Pemeriksaan Data MRP', keys: bad, items: [] });
    } catch (e) { /* abaikan */ }
    return T;
  }
  window.PPIC_TASKS = Object.assign(window.PPIC_TASKS || {}, { po: poTasks, mrp: mrpTasks });
  // Status pemuatan untuk penanda "website siap dipakai" di Beranda: 'loading' | 'ready' | pesan galat
  window.PPIC_STATUS = Object.assign(window.PPIC_STATUS || {}, {
    po: () => (state.freshLoaded ? 'ready' : state.loadErr ? state.loadErr : 'loading'),
    mrp: () => (MRP.loaded ? 'ready' : MRP.err ? MRP.err : 'loading'),
  });
  const tasksRefresh = () => { if (window.TASKS) window.TASKS.refresh(); };

  // Dipakai modul lain (csl.js)
  window.PPIC_UI = { openDialog, toast, esc, fmtDate, todayStr, ymd, fld, workdaysSince };
  route();
  loadData();
  loadSupplier(false);
  setTimeout(() => loadMrp(false), 300);   // angka MRP di Beranda; halaman MRP langsung siap saat dibuka
})();
