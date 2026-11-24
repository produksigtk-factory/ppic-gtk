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
    'po/followup':       { view: 'view-po-followup',       crumb: 'Purchase Order',            title: 'Follow Up PO',    actions: 'po' },
    'po/perhatian':      { view: 'view-po-perhatian',      crumb: 'Purchase Order',            title: 'Perhatian Khusus', actions: 'po' },
    'po/riwayat':        { view: 'view-po-riwayat',        crumb: 'Purchase Order',            title: 'Riwayat Edit PO', actions: 'po' },
    'mrp/bom':           { view: 'view-mrp-bom',           crumb: 'MRP',                       title: 'Bill of Material', actions: 'mrp' },
    'mrp/material':      { view: 'view-mrp-material',      crumb: 'MRP',                       title: 'Daftar Material', actions: 'mrp' },
    'mrp/dipakai':       { view: 'view-mrp-dipakai',       crumb: 'MRP',                       title: 'Material Dipakai di Mana', actions: 'mrp' },
    'mrp/cek':           { view: 'view-mrp-cek',           crumb: 'MRP',                       title: 'Pemeriksaan Data MRP', actions: 'mrp' },
    'mrp/rencana':       { view: 'view-mrp-rencana',       crumb: 'MRP',                       title: 'Rencana Produksi', actions: 'mrp' },
    'mrp/konfirmasi':    { view: 'view-mrp-konfirmasi',    crumb: 'MRP',                       title: 'Konfirmasi Produksi', actions: 'mrp' },
    'mrp/harian':        { view: 'view-mrp-harian',        crumb: 'MRP',                       title: 'Plotting Harian',     actions: 'mrp' },
    'mrp/kalender':      { view: 'view-mrp-kalender',      crumb: 'MRP',                       title: 'Kalender Produksi',   actions: 'mrp' },
    'mrp/kebutuhan':     { view: 'view-mrp-kebutuhan',     crumb: 'MRP',                       title: 'Kebutuhan Material', actions: 'mrp' },
    'mrp/suggest':       { view: 'view-mrp-suggest',       crumb: 'MRP',                       title: 'Suggest Produksi', actions: 'mrp' },
    'mrp/proyeksi':      { view: 'view-mrp-proyeksi',      crumb: 'MRP',                       title: 'Proyeksi Stok', actions: 'mrp' },
    'mrp/rakitan':       { view: 'view-mrp-rakitan',       crumb: 'MRP',                       title: 'BoM Banded/2in1/KIT', actions: 'mrp' },
    'mrp/sku':           { view: 'view-mrp-sku',           crumb: 'MRP',                       title: 'Parameter SKU', actions: 'mrp' },
    'mrp/update':        { view: 'view-mrp-update',        crumb: 'MRP',                       title: 'Update Data MRP', actions: 'mrp' },
    'po/supplier':       { view: 'view-po-supplier',       crumb: 'Purchase Order',            title: 'Supplier & MoQ',  actions: 'sup' },
    'csl/dashboard':     { view: 'view-csl-dashboard',     crumb: 'CSL Personal Care',         title: 'Dashboard CSL',   actions: 'csl' },
    'cslb/dashboard':     { view: 'view-csl-dashboard',     crumb: 'CSL Beauty',                title: 'Dashboard CSL',   actions: 'csl' },
    'csl/region':        { view: 'view-csl-region',        crumb: 'CSL Personal Care',         title: 'Review Region',   actions: 'csl' },
    'cslb/region':        { view: 'view-csl-region',        crumb: 'CSL Beauty',                title: 'Review Region',   actions: 'csl' },
    'csl/sku':           { view: 'view-csl-sku',           crumb: 'CSL Personal Care',         title: 'Rekap per SKU',   actions: 'csl' },
    'cslb/sku':           { view: 'view-csl-sku',           crumb: 'CSL Beauty',                title: 'Rekap per SKU',   actions: 'csl' },
    'csl/sellin':        { view: 'view-csl-sellin',        crumb: 'CSL Personal Care',         title: 'Sell In',         actions: 'csl' },
    'cslb/sellin':        { view: 'view-csl-sellin',        crumb: 'CSL Beauty',                title: 'Sell In',         actions: 'csl' },
    'csl/os':            { view: 'view-csl-os',            crumb: 'CSL Personal Care',         title: 'Sisa SO',         actions: 'csl' },
    'cslb/os':            { view: 'view-csl-os',            crumb: 'CSL Beauty',                title: 'Sisa SO',         actions: 'csl' },
    'csl/weekly':        { view: 'view-csl-weekly',        crumb: 'CSL Personal Care',         title: 'Weekly Review',   actions: 'csl' },
    'cslb/weekly':        { view: 'view-csl-weekly',        crumb: 'CSL Beauty',                title: 'Weekly Review',   actions: 'csl' },
    'pr/rekap':          { view: 'view-pr-rekap',          crumb: 'Purchase Request',          title: 'Rekap PR',        actions: 'po' },
    'pr/form':           { view: 'view-pr-form',           crumb: 'Purchase Request',          title: 'Formulir PR',     actions: 'po' },
    'pr/pengganti':      { view: 'view-pr-subs',           crumb: 'Purchase Request',          title: 'Material Pengganti', actions: 'po' },
    'prlt/rekap':        { view: 'view-pr-rekap',          crumb: 'PR Lead Time Panjang',      title: 'Rekap PR LT Panjang', actions: 'po' },
    'prlt/form':         { view: 'view-pr-form',           crumb: 'PR Lead Time Panjang',      title: 'Formulir PR LT Panjang', actions: 'po' },
    'prlt/material':     { view: 'view-prlt-mat',          crumb: 'PR Lead Time Panjang',      title: 'Material LT & Saran Buka PO', actions: 'po' },
    'info/glosarium':    { view: 'view-info-glosarium',    crumb: 'Bantuan & Sistem',          title: 'Glosarium',       actions: '' },
    'info/kapasitas':    { view: 'view-info-kapasitas',    crumb: 'Bantuan & Sistem',          title: 'Kapasitas Google Sheet', actions: '' },
    'csl/amount':        { view: 'view-csl-amount',        crumb: 'CSL Personal Care',         title: 'Amount Check',    actions: 'csl' },
    'cslb/amount':        { view: 'view-csl-amount',        crumb: 'CSL Beauty',                title: 'Amount Check',    actions: 'csl' },
    'csl/analisa':       { view: 'view-csl-analisa',       crumb: 'CSL Personal Care',         title: 'Analisa Forecast', actions: 'csl' },
    'cslb/analisa':       { view: 'view-csl-analisa',       crumb: 'CSL Beauty',                title: 'Analisa Forecast', actions: 'csl' },
    'csl/suggest':       { view: 'view-csl-suggest',       crumb: 'CSL Personal Care',         title: 'Suggest Forecast', actions: 'csl' },
    'cslb/suggest':       { view: 'view-csl-suggest',       crumb: 'CSL Beauty',                title: 'Suggest Forecast', actions: 'csl' },
    'csl/musim':         { view: 'view-csl-musim',         crumb: 'CSL Personal Care',         title: 'Seasonal',        actions: 'csl' },
    'cslb/musim':         { view: 'view-csl-musim',         crumb: 'CSL Beauty',                title: 'Seasonal',        actions: 'csl' },
    'csl/update':        { view: 'view-csl-update',        crumb: 'CSL Personal Care',         title: 'Update Data CSL', actions: 'csl' },
    'cslb/update':        { view: 'view-csl-update',        crumb: 'CSL Beauty',                title: 'Update Data CSL', actions: 'csl' },
    'csl/cek':           { view: 'view-csl-cek',           crumb: 'CSL Personal Care',         title: 'Pemeriksaan Data CSL', actions: 'csl' },
    'cslb/cek':           { view: 'view-csl-cek',           crumb: 'CSL Beauty',                title: 'Pemeriksaan Data CSL', actions: 'csl' },
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
    const sheet = r.actions === 'csl' ? ((window.CSL && window.CSL.sheetUrl()) || (state.routeKey.startsWith('cslb/') ? CFG.CSL_BEAUTY_SHEET_URL : CFG.CSL_SHEET_URL)) : r.actions === 'sup' ? (state.sup.dbUrl || CFG.DATABASE_URL) : planView ? (P.mrpUrl || CFG.MRP_SHEET_URL) : r.actions === 'mrp' ? (MRP.dbUrl || state.sup.dbUrl || CFG.DATABASE_URL) : CFG.SHEET_URL;
    $('lnkSheet').hidden = !sheet;
    if (sheet) $('lnkSheet').href = sheet;
    $('lnkSheet').title = r.actions === 'csl' ? `Buka Google Sheet ${state.routeKey.startsWith('cslb/') ? 'CSL Beauty' : 'CSL Personal Care'} (SO, DO, forecast) di tab baru` : r.actions === 'sup' ? 'Buka Google Sheet DATABASE PPIC (tab SUPPLIER_MATERIAL) di tab baru'
      : planView ? 'Buka Google Sheet MRP PPIC GTK (rencana, SKU, stok) di tab baru'
      : r.actions === 'mrp' ? 'Buka Google Sheet DATABASE PPIC (MASTER_MATERIAL, BOM_LIST, BOM_DETAIL) di tab baru' : 'Buka Google Sheet MONITORING PO di tab baru';
    $('btnReload').title = r.actions === 'csl' ? `Ambil data SO-DO dan forecast yang berubah dari Google Sheet ${state.routeKey.startsWith('cslb/') ? 'CSL Beauty' : 'CSL Personal Care'}` : r.actions === 'sup' ? 'Hitung ulang daftar supplier dari data PO terbaru dan isian MoQ'
      : r.actions === 'mrp' ? 'Ambil ulang BOM, rencana, dan stok dari Google Sheet' : 'Ambil ulang data terbaru dari Google Sheet MONITORING PO';
    document.title = `${r.title} · PPIC Gondowangi`;
    document.body.classList.toggle('lock-mon', r.view === 'view-po-monitoring');
    if (r.actions === 'mrp') { mrpEnter(key); renderDataInfo(); }
    if (key === 'pr/form' || key === 'pr/rekap' || key === 'prlt/form' || key === 'prlt/rekap') { if (PRF.mode !== PRM()) { PRF.kode = ''; PRF.mode = PRM(); } prApplyMode(); }
    if (key === 'pr/form' || key === 'prlt/form') prEnter();
    if (key === 'pr/rekap' || key === 'prlt/rekap') renderPrRekap();
    if (key === 'po/followup') renderFu();
    if (key === 'pr/pengganti') renderSubs();
    if (key === 'prlt/material') renderLtMat();
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


  /* ---------- Simpanan data di browser (IndexedDB) ---------- */
  // Data PO terakhir disimpan di browser supaya halaman langsung terisi saat dibuka;
  // data terbaru tetap diambil dari Google Sheet dan menggantikannya (hitungan tidak berubah).
  const KV = {
    db: null,
    open() {
      if (this.db !== null) return Promise.resolve(this.db);
      return new Promise((res) => {
        try {
          const r = indexedDB.open('ppic-cache', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('kv');
          r.onsuccess = () => { this.db = r.result; res(this.db); };
          r.onerror = () => { this.db = false; res(false); };
        } catch (e) { this.db = false; res(false); }
      });
    },
    async get(k) {
      const db = await this.open(); if (!db) return null;
      return new Promise((res) => { try { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); } catch (e) { res(null); } });
    },
    async set(k, v) { const db = await this.open(); if (!db) return; try { db.transaction('kv', 'readwrite').objectStore('kv').put(v, k); } catch (e) { /* abaikan */ } },
  };

  /* ---------- Ambil data ---------- */
  function applyPoData(data) {
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
    state.readAt = data.readAt || '';
    state.noPrScript = !Array.isArray(data.pr);
    setPrData(data.pr || []);
    state.noLampScript = !Array.isArray(data.prLamp);
    setPrLamp(data.prLamp || []);
    state.noPrStatusScript = !Array.isArray(data.prStatus);
    setPrStatus(data.prStatus || []);
    state.noPrHitungScript = !Array.isArray(data.prHitung);
    setPrHitung(data.prHitung || []);
  }
  async function loadData(fresh) {
    if (!CFG.APPS_SCRIPT_URL) { showSetup(); return; }
    $('dataInfo').textContent = 'Memuat data dari Google Sheet…';
    $('btnReload').disabled = true;
    state.loadErr = '';
    // Tampilkan dulu simpanan terakhir (bila ada) selama data terbaru diambil
    if (!state.rows.length) {
      const cached = await KV.get('po');
      if (cached && cached.ok && !state.freshLoaded) {
        try {
          applyPoData(cached);
          state.fromCache = true;
          refreshAll();
          $('dataInfo').textContent = `Menampilkan data tersimpan (dibaca ${whenText(cached.readAt)}) · sedang mengambil data terbaru…`;
        } catch (e) { state.rows = []; }
      }
      if (!state.rows.length) $('rows').innerHTML = '<tr class="empty"><td colspan="10">Memuat data dari Google Sheet, biasanya 5–10 detik…</td></tr>';
    }
    try {
      const res = await fetch(CFG.APPS_SCRIPT_URL + (fresh ? '?fresh=1' : ''), { method: 'GET' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Respon tidak valid');
      applyPoData(data);
      state.fromCache = false;
      state.freshLoaded = true;
      renderFresh();
      refreshAll();
      if (state.parsedDet || state.parsedDel) renderConflicts();   // pilihan PO yang pernah diedit dihitung ulang dari data terbaru
      KV.set('po', data);
    } catch (err) {
      state.loadErr = err.message;
      tasksRefresh();
      $('dataInfo').textContent = state.fromCache ? `Data terbaru gagal dimuat (${err.message}). Yang tampil adalah data tersimpan — tekan "Muat ulang data".` : 'Gagal memuat data. Periksa koneksi lalu tekan "Muat ulang data".';
      if (!state.rows.length) $('rows').innerHTML = `<tr class="empty"><td colspan="10">Data tidak bisa dimuat: ${esc(err.message)}</td></tr>`;
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
    renderFu();
    renderLog();
    renderAttention();
    renderDataInfo();
    tasksRefresh();
    if (MRP.loaded) { refreshMrpHome(); if (PLAN_KEYS.has(state.routeKey)) renderPlanView(state.routeKey); }
    renderPrViews();
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
      <td class="po">${esc(r.po)}${man}${state.prByPo && state.prByPo.has(r.po) ? [...state.prByPo.get(r.po)].map((k) => `<span class="pr-tag" title="Purchase Request">${esc(k)}</span>`).join('') : ''}</td>
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
      const kfS = P.incKMap ? P.incKMap.get(r.po + '|' + r.code + '|' + s.n) : null;
      const arrS = P.incK ? incArrOf(r.po, r.code, s.n) : [];
      const pill = s.status === 'Done' ? '<span class="pill pill-done">Sudah datang</span>'
        : arrS.length && (Number(s.qty) || 0) - (Number(s.rec) || 0) > 0 ? '<span class="pill pill-inc" title="Sudah datang sebagian; sisanya Incoming di tanggal jadwal">Datang sebagian</span>'
        : kfS && !kfS.datang && (Number(s.qty) || 0) - (Number(s.rec) || 0) > 0 ? '<span class="pill pill-inc" title="Dikonfirmasi incoming di Proyeksi Stok">Incoming</span>'
        : late ? `<span class="pill pill-late">Lewat ${daysBetween(s.date, r.today)} hari</span>`
        : s.date ? '<span class="pill pill-wait">Menunggu</span>' : '<span class="pill">Belum ada tanggal</span>';
      const act = ed ? `<td class="row-actions">
          <button type="button" class="btn-link" data-act="editSched" data-n="${s.n}">Ubah</button>
          <button type="button" class="btn-link danger" data-act="delSched" data-n="${s.n}">Hapus</button></td>` : '';
      // Konfirmasi incoming (Proyeksi Stok MRP): hanya jadwal yang belum Done, ada sisa, dan tanggalnya belum lewat
      const sisa = (Number(s.qty) || 0) - (Number(s.rec) || 0), kf = P.incKMap ? P.incKMap.get(r.po + '|' + r.code + '|' + s.n) : null;
      const kAttr = `data-inck="${esc(r.po)}|${esc(r.code)}|${s.n}" data-inck-date="${esc(s.date || '')}" data-inck-sisa="${sisa}"`;
      const gapO = P.incK && !r.cancel ? incOdooGap(r.po, r.code, s) : 0;
      const gapTxt = gapO ? `<small class="pl-bad" title="Diterima dari upload Odoo lebih besar dari total kedatangan yang dikonfirmasi di website. Stok terkini belum bertambah untuk selisih ini sampai dikonfirmasi atau ada upload stok baru.">Diterima Odoo +${fmtNum(gapO)} belum dikonfirmasi</small>${ed ? `<button type="button" class="btn-link" data-incodoo="${esc(r.po)}|${esc(r.code)}|${s.n}|${gapO}">Catat sebagai kedatangan</button>` : ''}` : '';
      const inc = r.cancel ? '<span class="muted">–</span>'
        : arrS.length ? arrS.map((a) => `<button type="button" class="pj-kbtn is-on" data-inck="${esc(r.po)}|${esc(r.code)}|${esc(a.ke)}" data-inck-date="${esc(s.date || '')}" data-inck-sisa="${sisa}">✓ ${fmtNum(a.qty)}</button><small class="muted">datang ${fmtDate(a.datang)}</small>`).join('')
          + (s.status !== 'Done' && sisa > 0 ? `<small class="muted">sisa ${fmtNum(sisa)} incoming ${s.date ? fmtDate(s.date) : ''}</small><button type="button" class="btn-link" data-incarr="${esc(r.po)}|${esc(r.code)}|${s.n}">+ Kedatangan berikutnya</button>` : '') + gapTxt
        : gapTxt ? (s.status !== 'Done' && sisa > 0 ? `<button type="button" class="pj-kbtn" ${kAttr}>Konfirmasi</button>` : '') + gapTxt
        : kf ? `<button type="button" class="pj-kbtn is-on" ${kAttr}>✓ ${fmtNum(kf.qty)}</button>${kf.datang ? `<small class="muted">datang ${fmtDate(kf.datang)}</small>` : s.status === 'Done' || !(sisa > 0) ? '<small class="muted">sudah diterima</small>' : kf.week ? `<small class="muted">datang ${esc(kf.week)} ${esc(monShort(kf.bulan))}</small>` : ''}`
        : s.status !== 'Done' && sisa > 0 ? `<button type="button" class="pj-kbtn" ${kAttr}>Konfirmasi</button>` : '<span class="muted">–</span>';
      return `<tr><td class="c-n">${s.n}</td><td class="c-date">${fmtDate(s.date)}</td>
        <td class="num">${fmtNum(s.qty)}</td><td class="num">${fmtNum(s.rec)}</td>
        <td class="num">${s.short ? `<b class="short-qty">${fmtNum(s.short)}</b>` : '<span class="muted">–</span>'}</td>
        <td>${pill}<span class="odoo-st">${esc(s.status || '')}</span></td><td>${inc}</td>${act}</tr>`;
    }).join('') : `<tr><td colspan="${ed ? 8 : 7}" class="muted">Belum ada jadwal pengiriman.</td></tr>`;

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
          <div class="sched-wrap"><table class="sched"><thead><tr><th>Ke</th><th>Tanggal</th><th class="num">Qty jadwal</th><th class="num">Diterima</th><th class="num">Kurang</th><th>Status</th><th title="Konfirmasi incoming untuk Proyeksi Stok (MRP)">Incoming</th>${ed ? '<th></th>' : ''}</tr></thead>
          <tbody>${sRows}</tbody></table></div>
        </section>
        ${followBox(r)}
      </div>
      ${notes.map((n, i) => `<p class="dt-note${r.cancel && i === 0 ? ' is-cancel' : r.manual && i === notes.length - 1 ? ' is-manual' : ''}">${n}</p>`).join('')}
    </div></div>`;
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
    : state.route && state.route.actions === 'mrp' ? loadMrp('fresh') : loadData(true)));

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

  /* ================= FOLLOW UP PO ================= */
  // Jadwal belum Done yang sudah lewat + yang jatuh tempo s/d akhir bulan depan, per supplier
  const FU = { st: '' };
  const fuEnd = () => { const d = new Date(); return ymd(new Date(d.getFullYear(), d.getMonth() + 2, 0)); };
  function fuItems() {
    const today = todayStr(), end = fuEnd(), out = [], seen = new Set();
    state.rows.forEach((r) => {
      if (isClosed(r)) return;
      const k = r.po + '|' + r.code; if (seen.has(k)) return; seen.add(k);
      r.sched.forEach((s) => {
        if (s.status === 'Done' || !s.date || s.date > end) return;
        const gap = Math.max(0, (Number(s.qty) || 0) - (Number(s.rec) || 0)); if (!(gap > 1e-9)) return;
        out.push({ r, s, gap, late: s.date < today, d: daysBetween(today, s.date) });
      });
    });
    return out;
  }
  function fuGroups() {
    const j = $('fuJenis').value, sp = $('fuSup').value, q = $('fuQ').value.trim().toLowerCase();
    const all = fuItems().filter((x) => jenisOk(x.r, j));
    const list = all.filter((x) => (!sp || x.r.supplier === sp) && (!FU.st || (FU.st === 'late') === x.late)
      && (!q || `${x.r.po} ${x.r.code} ${x.r.name} ${x.r.supplier}`.toLowerCase().includes(q)));
    const m = new Map();
    list.forEach((x) => { const g = m.get(x.r.supplier) || { sup: x.r.supplier || '(tanpa supplier)', items: [] }; g.items.push(x); m.set(x.r.supplier, g); });
    const gs = [...m.values()];
    gs.forEach((g) => { g.items.sort((a, b) => a.s.date.localeCompare(b.s.date) || a.r.po.localeCompare(b.r.po)); g.nLate = g.items.filter((x) => x.late).length; g.worst = Math.min(...g.items.map((x) => x.d)); });
    gs.sort((a, b) => a.worst - b.worst || a.sup.localeCompare(b.sup));
    return { all, list, gs };
  }
  function fuTable(gs, print) {
    const ed = state.edit.on && !print, u = (x) => ` <small>${esc(x.r.uom || '')}</small>`;
    return gs.map((g) => `<section class="fu-grp"><h3 class="fu-gh">${esc(g.sup)}<span>${g.items.length} jadwal${g.nLate ? ` · <b class="pl-bad">${g.nLate} terlambat</b>` : ''}</span></h3>
      <table class="po-table fu-t"><thead><tr><th class="c-po">No PO</th><th class="c-d">Tgl PO</th><th>Material</th><th class="num c-n">Qty PO</th><th class="num c-k">Ke</th><th class="c-d">Jadwal</th><th class="num c-n">Qty jadwal</th><th class="num c-n">Sudah datang</th><th class="num c-n">Kurang</th><th class="c-st">Status</th>${print ? '<th class="fu-hasil">Hasil follow up</th>' : '<th class="c-act"></th>'}</tr></thead><tbody>
      ${g.items.map((x) => `<tr class="${x.late ? 'is-late' : ''}"><td class="mono">${print ? esc(x.r.po) : `<button type="button" class="btn-link pr-po" data-gopo="${esc(x.r.po)}" data-gocode="${esc(x.r.code)}" title="Buka ${esc(x.r.po)} di Monitoring PO">${esc(x.r.po)}</button>`}</td><td class="date">${fmtDate(x.r.date)}</td>
        <td><b>${esc(x.r.code)}</b> ${esc(x.r.name)}</td><td class="num">${fmtNum(x.r.qty)}${u(x)}</td><td class="num">${esc(x.s.n)}</td><td class="date">${fmtDate(x.s.date)}</td>
        <td class="num">${fmtNum(Number(x.s.qty) || 0)}</td><td class="num">${fmtNum(Number(x.s.rec) || 0)}</td><td class="num"><b>${fmtNum(x.gap)}</b>${u(x)}</td>
        <td>${x.late ? `<span class="pill pill-late">Lewat ${-x.d} hari</span>` : `<span class="pill pill-wait">${x.d ? x.d + ' hari lagi' : 'Hari ini'}</span>`}</td>
        ${print ? '<td class="fu-hasil"></td>' : `<td class="fu-act"><button type="button" class="btn-link pr-po" data-gopo="${esc(x.r.po)}" data-gocode="${esc(x.r.code)}">Buka PO</button>${ed ? `<button type="button" class="btn-link" data-fu="${esc(x.r.po)}|${esc(x.r.code)}">Follow up</button>` : ''}</td>`}</tr>`).join('')}
      </tbody></table></section>`).join('');
  }
  function renderFu() {
    if (!$('fuBody') || !state.rows.length) return;
    if (!$('fuJenis').dataset.ready) fillJenis($('fuJenis'), [...new Set(state.rows.map((r) => r.jenis).filter(Boolean))].sort());
    const sups = [...new Set(fuItems().map((x) => x.r.supplier).filter(Boolean))].sort(), cur = $('fuSup').value;
    $('fuSup').innerHTML = '<option value="">Semua supplier</option>' + sups.map((v) => `<option${v === cur ? ' selected' : ''}>${esc(v)}</option>`).join('');
    document.querySelectorAll('#fuSt [data-st]').forEach((b) => b.classList.toggle('is-on', b.dataset.st === FU.st));
    const { list, gs } = fuGroups(), nL = list.filter((x) => x.late).length;
    $('fuSum').innerHTML = `<b>${nL}</b> jadwal terlambat · <b>${list.length - nL}</b> akan datang s/d ${fmtDate(fuEnd())} · ${gs.length} supplier`;
    $('fuBody').innerHTML = gs.length ? fuTable(gs, false) : '<p class="empty-note">Tidak ada jadwal yang perlu di-follow up untuk filter ini.</p>';
    $('fuPdf').disabled = $('fuPrint').disabled = $('fuXls').disabled = !gs.length;
  }
  ['fuQ', 'fuSup', 'fuJenis'].forEach((id) => $(id).addEventListener(id === 'fuQ' ? 'input' : 'change', renderFu));
  $('fuSt').addEventListener('click', (e) => { const b = e.target.closest('[data-st]'); if (!b) return; FU.st = b.dataset.st; renderFu(); });
  $('fuBody').addEventListener('click', (e) => { const b = e.target.closest('[data-fu]'); if (!b) return; const [po, code] = b.dataset.fu.split('|'); const r = state.rows.find((x) => x.po === po && x.code === code); if (r) editFollow(r); });
  const fuFilt = () => { const sp = $('fuSup').value, j = $('fuJenis').value, q = $('fuQ').value.trim(); return [sp && 'Supplier: ' + sp, j !== RMPM && 'Jenis: ' + jenisLabel(j), FU.st && (FU.st === 'late' ? 'Hanya terlambat' : 'Hanya akan datang'), q && 'Cari: ' + q].filter(Boolean).join(' · '); };
  const fuStamp = (now) => `${fmtDate(ymd(now))} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  // Unduh PDF langsung (jsPDF + autotable, dimuat saat pertama dipakai)
  let pdfLibP = null;
  const loadJs = (src) => new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = src; sc.onload = res; sc.onerror = () => rej(new Error('Pustaka PDF tidak bisa dimuat. Periksa koneksi lalu coba lagi.')); document.head.appendChild(sc); });
  const loadPdfLib = () => pdfLibP || (pdfLibP = (window.jspdf ? Promise.resolve() : loadJs('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'))
    .then(() => (window.jspdf && window.jspdf.jsPDF.API.autoTable ? null : loadJs('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js')))
    .then(() => window.jspdf.jsPDF).catch((e) => { pdfLibP = null; throw e; }));
  $('fuPdf').addEventListener('click', async () => {
    const { list, gs } = fuGroups(); if (!gs.length) return;
    const btn = $('fuPdf'), lbl = btn.textContent; btn.disabled = true; btn.textContent = 'Menyiapkan PDF…';
    try {
      const JsPDF = await loadPdfLib(), doc = new JsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      const now = new Date(), nL = list.filter((x) => x.late).length, W = doc.internal.pageSize.getWidth(), M = 10, filt = fuFilt();
      const t = (v) => String(v == null ? '' : v).replace(/[–—]/g, '-');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.text('Follow Up Purchase Order', M, 15);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
      doc.text(t(`Terlambat dan akan datang s/d ${fmtDate(fuEnd())}${filt ? ' · ' + filt : ''}`), M, 20.5);
      doc.text(t(`Dicetak ${fuStamp(now)}`), W - M, 15, { align: 'right' });
      doc.text(`${nL} terlambat · ${list.length - nL} akan datang · ${gs.length} supplier`, W - M, 20.5, { align: 'right' });
      doc.setLineWidth(0.5); doc.line(M, 23, W - M, 23);
      let y = 29;
      gs.forEach((g) => {
        if (y > doc.internal.pageSize.getHeight() - 30) { doc.addPage(); y = 14; }
        doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.text(t(g.sup), M, y);
        const tw = doc.getTextWidth(t(g.sup)); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
        doc.setTextColor(110); doc.text(`${g.items.length} jadwal`, M + tw + 3, y);
        if (g.nLate) { doc.setTextColor(192, 57, 43); doc.text(`· ${g.nLate} terlambat`, M + tw + 3 + doc.getTextWidth(`${g.items.length} jadwal `), y); }
        doc.setTextColor(0);
        doc.autoTable({
          startY: y + 2, margin: { left: M, right: M }, theme: 'plain',
          head: [['No PO', 'Tgl PO', 'Material', 'Qty PO', 'Ke', 'Jadwal', 'Qty jadwal', 'Sudah datang', 'Kurang', 'Status', 'Hasil follow up']],
          body: g.items.map((x) => [x.r.po, fmtDate(x.r.date), `${x.r.code}  ${x.r.name || ''}`, `${fmtNum(x.r.qty)} ${x.r.uom || ''}`, String(x.s.n), fmtDate(x.s.date), fmtNum(Number(x.s.qty) || 0), fmtNum(Number(x.s.rec) || 0), `${fmtNum(x.gap)} ${x.r.uom || ''}`, x.late ? `Lewat ${-x.d} hari` : x.d ? `${x.d} hari lagi` : 'Hari ini', ''].map(t)),
          styles: { font: 'helvetica', fontSize: 8, cellPadding: { top: 1.6, bottom: 1.6, left: 1.5, right: 1.5 }, lineColor: [205, 205, 205], lineWidth: { bottom: 0.2 }, valign: 'top' },
          headStyles: { fontStyle: 'bold', textColor: [70, 70, 70], fillColor: [240, 242, 240], lineWidth: { bottom: 0.4 }, lineColor: [60, 60, 60] },
          columnStyles: { 0: { cellWidth: 20 }, 1: { cellWidth: 17 }, 2: { cellWidth: 'auto' }, 3: { cellWidth: 22, halign: 'right' }, 4: { cellWidth: 7, halign: 'right' }, 5: { cellWidth: 17 }, 6: { cellWidth: 18, halign: 'right' }, 7: { cellWidth: 19, halign: 'right' }, 8: { cellWidth: 22, halign: 'right', fontStyle: 'bold' }, 9: { cellWidth: 26 }, 10: { cellWidth: 40, lineWidth: { bottom: 0.2, left: 0.2 } } },
          didParseCell: (d) => { if (d.section === 'head' && [3, 4, 6, 7, 8].includes(d.column.index)) d.cell.styles.halign = 'right'; if (d.section === 'body' && d.column.index === 9 && g.items[d.row.index].late) { d.cell.styles.textColor = [192, 57, 43]; d.cell.styles.fontStyle = 'bold'; } },
        });
        y = doc.lastAutoTable.finalY + 8;
      });
      const n = doc.internal.getNumberOfPages();
      for (let i = 1; i <= n; i++) { doc.setPage(i); doc.setFontSize(8); doc.setTextColor(120); doc.text(`Halaman ${i} dari ${n}`, W - M, doc.internal.pageSize.getHeight() - 6, { align: 'right' }); }
      doc.save(`Follow-Up-PO-${ymd(now)}.pdf`);
    } catch (e) { toast(e.message || String(e)); } finally { btn.disabled = false; btn.textContent = lbl; }
  });
  // Unduh Excel berformat (ExcelJS, dimuat saat pertama dipakai): Follow Up (per supplier) · Pivot (rumus COUNTIFS) · Data (Excel Table)
  let xjsP = null;
  const loadExcelJs = () => xjsP || (xjsP = (window.ExcelJS ? Promise.resolve() : loadJs('https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js')).then(() => window.ExcelJS).catch((e) => { xjsP = null; throw new Error('Pustaka Excel tidak bisa dimuat. Periksa koneksi lalu coba lagi.'); }));
  $('fuXls').addEventListener('click', async () => {
    const { list, gs } = fuGroups(); if (!gs.length) return;
    const btn = $('fuXls'), lbl = btn.textContent; btn.disabled = true; btn.textContent = 'Menyiapkan Excel…';
    try {
      const EJ = await loadExcelJs(), wb = new EJ.Workbook(), now = new Date(), end = fuEnd(), today = todayStr();
      wb.creator = 'PPIC Gondowangi'; wb.created = now;
      const GREEN = 'FF1F5F3A', GREEN_L = 'FFE8F3EC', RED = 'FFB3261E', RED_L = 'FFFCEDEB', GREY = 'FF6B7280', LINE = 'FFD9DED9';
      const dt = (s) => (s ? new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10))) : null);   // ExcelJS menulis tanggal sebagai UTC
      const monL = (b) => `${monShort(b)} ${b.slice(0, 4)}`;
      const nL = list.filter((x) => x.late).length, filt = fuFilt();
      const thin = { style: 'thin', color: { argb: LINE } };
      const head = (row) => { row.eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } }; c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }; c.border = { top: thin, bottom: thin, left: thin, right: thin }; }); row.height = 30; };
      const titleBlock = (ws, title, span) => {
        ws.mergeCells(1, 1, 1, span); ws.getCell(1, 1).value = title; ws.getCell(1, 1).font = { bold: true, size: 15, color: { argb: GREEN } };
        ws.mergeCells(2, 1, 2, span); ws.getCell(2, 1).value = `Terlambat dan akan datang s/d ${fmtDate(end)}${filt ? ' · ' + filt : ''} · dicetak ${fuStamp(now)}`; ws.getCell(2, 1).font = { size: 9.5, color: { argb: GREY } };
        ws.mergeCells(3, 1, 3, span); ws.getCell(3, 1).value = `${nL} jadwal terlambat · ${list.length - nL} akan datang · ${gs.length} supplier`; ws.getCell(3, 1).font = { size: 10, bold: true };
        ws.getRow(1).height = 22;
      };
      // ---- Sheet 3: Data (dibuat dulu supaya rumus Pivot bisa merujuk) ----
      const flat = gs.flatMap((g) => g.items.map((x) => ({ g, x })));
      const wsF = wb.addWorksheet('Follow Up', { views: [{ state: 'frozen', ySplit: 5, showGridLines: false }], properties: { tabColor: { argb: GREEN } } });
      const wsP = wb.addWorksheet('Pivot', { views: [{ showGridLines: false }], properties: { tabColor: { argb: 'FFC9962B' } } });
      const wsM = wb.addWorksheet('Pivot Material', { views: [{ state: 'frozen', ySplit: 6, showGridLines: false }], properties: { tabColor: { argb: 'FFC0392B' } } });
      const wsD = wb.addWorksheet('Data', { views: [{ state: 'frozen', ySplit: 1 }], properties: { tabColor: { argb: 'FF9AA5B1' } } });
      const dCols = [['Supplier', 34], ['No PO', 12], ['Tgl PO', 11], ['Kode', 10], ['Material', 40], ['Jenis', 8], ['Qty PO', 12], ['UoM', 7], ['Ke', 5], ['Jadwal', 11], ['Bulan jadwal', 12], ['Qty jadwal', 12], ['Sudah datang', 12], ['Kurang', 12], ['Status', 12], ['Hari terlambat', 10], ['Hari lagi', 9]];
      dCols.forEach(([, w], i) => { wsD.getColumn(i + 1).width = w; });
      wsD.addTable({ name: 'DataFollowUp', ref: 'A1', headerRow: true, style: { theme: 'TableStyleMedium7', showRowStripes: true },
        columns: dCols.map(([n]) => ({ name: n, filterButton: true })),
        rows: flat.map(({ x }) => [x.r.supplier || '(tanpa supplier)', x.r.po, dt(x.r.date), x.r.code, x.r.name || '', x.r.jenis || '', Number(x.r.qty) || 0, x.r.uom || '', Number(x.s.n) || x.s.n, dt(x.s.date), x.late ? 'Terlambat' : monL(x.s.date.slice(0, 7)), Number(x.s.qty) || 0, Number(x.s.rec) || 0, sgR3(x.gap), x.late ? 'Terlambat' : 'Akan datang', x.late ? -x.d : null, x.late ? null : x.d]) });
      ['C', 'J'].forEach((c) => { wsD.getColumn(c).numFmt = 'dd mmm yy'; }); ['G', 'L', 'M', 'N'].forEach((c) => { wsD.getColumn(c).numFmt = '#,##0.###'; });
      const N = flat.length + 1, rg = (c) => `Data!$${c}$2:$${c}$${N}`;
      // ---- Sheet 1: Follow Up ----
      const fCols = [['No PO', 12], ['Tgl PO', 10], ['Kode', 9], ['Material', 38], ['Qty PO', 11], ['UoM', 6], ['Ke', 4], ['Jadwal', 10], ['Qty jadwal', 11], ['Sudah datang', 11], ['Kurang', 11], ['Status', 13], ['Hari', 7], ['Hasil follow up', 34]];
      fCols.forEach(([, w], i) => { wsF.getColumn(i + 1).width = w; });
      titleBlock(wsF, 'Follow Up Purchase Order', fCols.length);
      head(wsF.getRow(5)); wsF.getRow(5).values = fCols.map(([n]) => n); head(wsF.getRow(5));
      let r = 6;
      gs.forEach((g) => {
        wsF.mergeCells(r, 1, r, fCols.length);
        const c = wsF.getCell(r, 1); c.value = { richText: [{ text: g.sup, font: { bold: true, size: 11, color: { argb: GREEN } } }, { text: `   ${g.items.length} jadwal${g.nLate ? ` · ${g.nLate} terlambat` : ''}`, font: { size: 9.5, color: { argb: g.nLate ? RED : GREY } } }] };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN_L } }; c.border = { top: { style: 'thin', color: { argb: 'FF9FC3AC' } } }; wsF.getRow(r).height = 20; r++;
        g.items.forEach((x) => {
          const row = wsF.getRow(r);
          row.values = [x.r.po, dt(x.r.date), x.r.code, x.r.name || '', Number(x.r.qty) || 0, x.r.uom || '', Number(x.s.n) || x.s.n, dt(x.s.date), Number(x.s.qty) || 0, Number(x.s.rec) || 0, sgR3(x.gap), x.late ? 'Terlambat' : 'Akan datang', x.late ? -x.d : x.d, ''];
          row.eachCell({ includeEmpty: true }, (cc, ci) => {
            cc.border = { bottom: thin }; cc.font = { size: 10 }; cc.alignment = { vertical: 'top', wrapText: ci === 4 };
            if (x.late) cc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: RED_L } };
          });
          [2, 8].forEach((ci) => { row.getCell(ci).numFmt = 'dd mmm yy'; row.getCell(ci).alignment = { vertical: 'top', horizontal: 'center' }; }); row.getCell(7).alignment = { vertical: 'top', horizontal: 'center' }; row.getCell(3).alignment = { vertical: 'top', indent: 1 }; [5, 9, 10, 11].forEach((ci) => { row.getCell(ci).numFmt = '#,##0.###'; });
          row.getCell(11).font = { size: 10, bold: true };
          row.getCell(12).font = { size: 10, bold: true, color: { argb: x.late ? RED : GREEN } };
          row.getCell(13).value = x.late ? `${-x.d} hr lewat` : x.d ? `${x.d} hr lagi` : 'hari ini'; row.getCell(13).font = { size: 9.5, color: { argb: x.late ? RED : GREY } };
          row.getCell(14).border = { bottom: thin, left: thin, right: thin };
          r++;
        });
        r++;
      });
      wsF.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 }, printTitlesRow: '5:5' };
      wsF.headerFooter.oddFooter = '&L&8Follow Up PO&R&8Halaman &P dari &N';
      // ---- Sheet 2: Pivot (rumus membaca sheet Data) ----
      const sups = gs.map((g) => g.sup);
      const mons = [...new Set(list.filter((x) => !x.late).map((x) => x.s.date.slice(0, 7)))].sort();
      titleBlock(wsP, 'Pivot Follow Up PO', 2 + Math.max(4, mons.length + 2));
      wsP.getColumn(1).width = 38; for (let i = 2; i <= 9; i++) wsP.getColumn(i).width = 14;
      const section = (top, title, heads, rowFn, totFn) => {
        wsP.getCell(top, 1).value = title; wsP.getCell(top, 1).font = { bold: true, size: 12, color: { argb: GREEN } };
        const hr = wsP.getRow(top + 1); hr.values = heads; head(hr);
        sups.forEach((sp, i) => {
          const rr = wsP.getRow(top + 2 + i); rr.getCell(1).value = sp; rowFn(rr, top + 2 + i, sp);
          rr.eachCell({ includeEmpty: true }, (cc, ci) => { if (ci > heads.length) return; cc.border = { bottom: thin }; cc.font = Object.assign({ size: 10 }, cc.font && cc.font.bold ? { bold: true } : {}); if (ci > 1) { cc.alignment = { horizontal: 'center' }; cc.numFmt = '#,##0'; } });
          if (i % 2) rr.eachCell({ includeEmpty: true }, (cc, ci) => { if (ci <= heads.length) cc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F9F7' } }; });
        });
        const last = top + 1 + sups.length, tr = wsP.getRow(last + 1); tr.getCell(1).value = 'Total'; totFn(tr, top + 2, last);
        tr.eachCell({ includeEmpty: true }, (cc, ci) => { if (ci > heads.length) return; cc.font = { bold: true, size: 10 }; cc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN_L } }; cc.border = { top: { style: 'medium', color: { argb: GREEN } } }; if (ci > 1) { cc.alignment = { horizontal: 'center' }; cc.numFmt = '#,##0'; } });
        return { first: top + 2, last };
      };
      const cnt = (sp, ex) => list.filter((x) => (x.r.supplier || '(tanpa supplier)') === sp && ex(x)).length;
      const L = (i) => String.fromCharCode(64 + i);
      // 1) Supplier × Status
      const s1 = section(5, 'Jumlah jadwal per supplier & status', ['Supplier', 'Terlambat', 'Akan datang', 'Total', 'Terlambat terlama (hari)'],
        (rr, i, sp) => {
          rr.getCell(2).value = { formula: `COUNTIFS(${rg('A')},$A${i},${rg('O')},"Terlambat")`, result: cnt(sp, (x) => x.late) };
          rr.getCell(3).value = { formula: `COUNTIFS(${rg('A')},$A${i},${rg('O')},"Akan datang")`, result: cnt(sp, (x) => !x.late) };
          rr.getCell(4).value = { formula: `B${i}+C${i}`, result: cnt(sp, () => true) };
          const mx = Math.max(0, ...list.filter((x) => (x.r.supplier || '(tanpa supplier)') === sp && x.late).map((x) => -x.d));
          rr.getCell(5).value = { formula: `IFERROR(MAXIFS(${rg('P')},${rg('A')},$A${i}),0)`, result: mx };
        },
        (tr, a, b) => { ['B', 'C', 'D'].forEach((c) => { tr.getCell(c).value = { formula: `SUM(${c}${a}:${c}${b})` }; }); tr.getCell('E').value = { formula: `MAX(E${a}:E${b})` }; });
      // 2) Supplier × Bulan jatuh tempo
      const t2 = s1.last + 4, heads2 = ['Supplier', 'Terlambat', ...mons.map(monL), 'Total'];
      const s2 = section(t2, 'Jumlah jadwal per bulan jatuh tempo', heads2,
        (rr, i, sp) => {
          rr.getCell(2).value = { formula: `COUNTIFS(${rg('A')},$A${i},${rg('K')},"Terlambat")`, result: cnt(sp, (x) => x.late) };
          mons.forEach((m, k) => { rr.getCell(3 + k).value = { formula: `COUNTIFS(${rg('A')},$A${i},${rg('K')},"${monL(m)}")`, result: cnt(sp, (x) => !x.late && x.s.date.slice(0, 7) === m) }; });
          const lc = L(2 + mons.length); rr.getCell(3 + mons.length).value = { formula: `SUM(B${i}:${lc}${i})`, result: cnt(sp, () => true) };
        },
        (tr, a, b) => { for (let k = 2; k <= 3 + mons.length; k++) tr.getCell(k).value = { formula: `SUM(${L(k)}${a}:${L(k)}${b})` }; });
      // heatmap ringan
      const heat = (ref, color) => wsP.addConditionalFormatting({ ref, rules: [{ type: 'colorScale', priority: 1, cfvo: [{ type: 'min' }, { type: 'max' }], color: [{ argb: 'FFFFFFFF' }, { argb: color }] }] });
      heat(`B${s1.first}:B${s1.last}`, 'FFF4B4AC'); heat(`E${s1.first}:E${s1.last}`, 'FFF4B4AC'); heat(`C${s1.first}:C${s1.last}`, 'FFB9DEC6');
      heat(`B${s2.first}:B${s2.last}`, 'FFF4B4AC'); if (mons.length) heat(`C${s2.first}:${L(2 + mons.length)}${s2.last}`, 'FFF6D99A');
      wsP.getCell(s2.last + 3, 1).value = 'Angka di sheet ini berupa rumus COUNTIFS yang membaca sheet Data. Untuk PivotTable sendiri: klik tabel di sheet Data → Insert → PivotTable.';
      wsP.getCell(s2.last + 3, 1).font = { italic: true, size: 9, color: { argb: GREY } };
      wsP.pageSetup = { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
      // ---- Sheet Pivot Material ----
      const mCols = [['Kode', 10], ['Material', 40], ['UoM', 7], ['PO', 6], ['Terlambat', 11], ['Akan datang', 11], ['Total kurang', 14], ['Kurang terlambat', 14], ['Terlambat terlama (hari)', 13], ['Supplier', 46]];
      mCols.forEach(([, w], i) => { wsM.getColumn(i + 1).width = w; });
      titleBlock(wsM, 'Pivot per Material', mCols.length);
      wsM.getCell(5, 1).value = 'Jumlah jadwal dan qty kurang per material (satuan per material sama, jadi qty bisa dijumlahkan)'; wsM.getCell(5, 1).font = { bold: true, size: 12, color: { argb: GREEN } };
      const hm = wsM.getRow(6); hm.values = mCols.map(([n]) => n); head(hm);
      const mm = new Map();
      list.forEach((x) => { const k = x.r.code; let o = mm.get(k); if (!o) { o = { code: k, name: x.r.name || '', uom: x.r.uom || '', po: new Set(), sup: new Set(), late: 0, wait: 0, kur: 0, kurL: 0, max: 0 }; mm.set(k, o); }
        o.po.add(x.r.po); o.sup.add(x.r.supplier || '(tanpa supplier)'); if (x.late) { o.late++; o.kurL += x.gap; o.max = Math.max(o.max, -x.d); } else o.wait++; o.kur += x.gap; });
      const ML = [...mm.values()].sort((a2, b2) => b2.max - a2.max || b2.kurL - a2.kurL || b2.kur - a2.kur || a2.code.localeCompare(b2.code));
      ML.forEach((o, k) => {
        const i = 7 + k, rr = wsM.getRow(i);
        rr.values = [o.code, o.name, o.uom, o.po.size,
          { formula: `COUNTIFS(${rg('D')},$A${i},${rg('O')},"Terlambat")`, result: o.late },
          { formula: `COUNTIFS(${rg('D')},$A${i},${rg('O')},"Akan datang")`, result: o.wait },
          { formula: `SUMIFS(${rg('N')},${rg('D')},$A${i})`, result: sgR3(o.kur) },
          { formula: `SUMIFS(${rg('N')},${rg('D')},$A${i},${rg('O')},"Terlambat")`, result: sgR3(o.kurL) },
          { formula: `IFERROR(MAXIFS(${rg('P')},${rg('D')},$A${i}),0)`, result: o.max },
          [...o.sup].join(', ')];
        rr.eachCell({ includeEmpty: true }, (cc, ci) => {
          if (ci > mCols.length) return;
          cc.border = { bottom: thin }; cc.font = { size: 10 }; cc.alignment = { vertical: 'top', wrapText: ci === 2 || ci === 10, horizontal: [3, 4, 5, 6, 9].includes(ci) ? 'center' : undefined };
          if ([7, 8].includes(ci)) cc.numFmt = '#,##0.###'; if (ci === 8) cc.font = { size: 10, bold: true, color: { argb: o.kurL ? RED : 'FF111111' } };
          if (k % 2) cc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F9F7' } };
        });
      });
      const mF = 7, mL = 6 + ML.length;
      const trm = wsM.getRow(mL + 1); trm.getCell(1).value = 'Total'; trm.getCell(2).value = `${ML.length} material`;
      trm.getCell(5).value = { formula: `SUM(E${mF}:E${mL})` }; trm.getCell(6).value = { formula: `SUM(F${mF}:F${mL})` }; trm.getCell(9).value = { formula: `MAX(I${mF}:I${mL})` };
      trm.eachCell({ includeEmpty: true }, (cc, ci) => { if (ci > mCols.length) return; cc.font = { bold: true, size: 10 }; cc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN_L } }; cc.border = { top: { style: 'medium', color: { argb: GREEN } } }; if ([5, 6, 9].includes(ci)) cc.alignment = { horizontal: 'center' }; });
      const heatM = (ref, color) => wsM.addConditionalFormatting({ ref, rules: [{ type: 'colorScale', priority: 1, cfvo: [{ type: 'min' }, { type: 'max' }], color: [{ argb: 'FFFFFFFF' }, { argb: color }] }] });
      heatM(`E${mF}:E${mL}`, 'FFF4B4AC'); heatM(`I${mF}:I${mL}`, 'FFF4B4AC'); heatM(`F${mF}:F${mL}`, 'FFB9DEC6');
      wsM.getCell(mL + 3, 1).value = 'Total kurang tidak dijumlahkan antar material karena satuannya berbeda. Angka berupa rumus yang membaca sheet Data.';
      wsM.getCell(mL + 3, 1).font = { italic: true, size: 9, color: { argb: GREY } };
      wsM.autoFilter = { from: { row: 6, column: 1 }, to: { row: mL, column: mCols.length } };
      wsM.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '6:6' };
      const buf = await wb.xlsx.writeBuffer();
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      a.download = `Follow-Up-PO-${ymd(now)}.xlsx`; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    } catch (e) { toast(e.message || String(e)); } finally { btn.disabled = false; btn.textContent = lbl; }
  });
  $('fuPrint').addEventListener('click', () => {
    const { list, gs } = fuGroups(); if (!gs.length) return;
    let root = document.getElementById('fuPrintRoot');
    if (!root) { root = document.createElement('div'); root.id = 'fuPrintRoot'; document.body.appendChild(root); }
    const nL = list.filter((x) => x.late).length, now = new Date(), filt = fuFilt();
    root.innerHTML = `<header class="fu-ph"><div><h1>Follow Up Purchase Order</h1><p>Terlambat dan akan datang s/d ${fmtDate(fuEnd())}${filt ? ' · ' + esc(filt) : ''}</p></div><p>Dicetak ${fuStamp(now)}<br><b>${nL}</b> terlambat · <b>${list.length - nL}</b> akan datang · ${gs.length} supplier</p></header>${fuTable(gs, true)}`;
    document.body.classList.add('printing-fu');
    const t0 = document.title; document.title = 'Follow-Up-PO-' + ymd(now);
    const done = () => { document.body.classList.remove('printing-fu'); document.title = t0; window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print(); setTimeout(done, 1000);
  });

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
        const kf0 = P.incKMap ? P.incKMap.get(r.po + '|' + r.code + '|' + s.n) : null, kf = kf0 && !kf0.datang ? kf0 : null;   // dikonfirmasi di Proyeksi Stok → "Incoming"
        if (gap) out.push({ date: s.date, r, qty: kf ? Math.min(kf.qty, gap) : gap, kind: kf ? 'inc' : s.date < today ? 'late' : 'wait', kf });
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
      const n = { wait: 0, late: 0, promise: 0, inc: 0 };
      list.forEach((it) => { n[it.kind]++; });
      const cls = ['cal-cell', d.slice(0, 7) !== month ? 'is-other' : '', d === today ? 'is-today' : '', d === sel ? 'is-sel' : '', list.length ? 'has' : ''].join(' ');
      const label = `${dayLong.format(new Date(d + 'T00:00:00'))}: ${n.wait} akan datang, ${n.late} lewat jadwal, ${n.promise} janji kirim, ${n.inc} incoming`;
      html += `<button class="${cls}" data-d="${d}" role="gridcell" aria-label="${esc(label)}" aria-pressed="${d === sel}">
        <span class="cal-num">${+d.slice(8)}</span>
        <span class="cal-counts">${n.late ? `<span class="cc cc-late"><b>${n.late}</b><span class="cc-t"> lewat jadwal</span></span>` : ''}${n.wait ? `<span class="cc cc-wait"><b>${n.wait}</b><span class="cc-t"> akan datang</span></span>` : ''}${n.promise ? `<span class="cc cc-promise"><b>${n.promise}</b><span class="cc-t"> janji kirim</span></span>` : ''}${n.inc ? `<span class="cc cc-inc"><b>${n.inc}</b><span class="cc-t"> incoming</span></span>` : ''}${list.length ? `<span class="cc-sup">${new Set(list.map((it) => it.r.supplier)).size} supplier</span>` : ''}</span>
      </button>`;
    }
    $('cGrid').innerHTML = html;

    // Daftar hari terpilih
    const ORD = { late: 0, promise: 1, wait: 2, inc: 3 };
    const list = (byDate.get(sel) || []).slice().sort((a, b) => ORD[a.kind] - ORD[b.kind] || a.r.supplier.localeCompare(b.r.supplier));
    const olderLate = items.filter((it) => it.kind === 'late' && it.date < first).length;
    const KIND = { late: ['Lewat jadwal', 'b-late'], wait: ['Dijadwalkan', 'b-wait'], promise: ['Janji kirim baru', 'b-promise'], inc: ['Incoming', 'b-inc'] };
    CAL.list = list; CAL.sel = sel;
    $('cDay').innerHTML = `<h3>${esc(dayLong.format(new Date(sel + 'T00:00:00')))}</h3>
      <p class="hint">${list.length ? nf.format(list.length) + ' kedatangan · ' + nf.format(new Set(list.map((x) => x.r.supplier)).size) + ' supplier' : 'Tidak ada kedatangan di tanggal ini.'}</p>
      ${(() => { const n = list.filter((x) => x.kind === 'inc').length; return n && sel === today ? `<div class="cal-recv"><button type="button" class="btn btn-sm" data-cal-recv>Tandai semua Incoming hari ini sudah datang (${n})</button></div>` : ''; })()}
      ${list.length ? `<div class="cal-img-btns"><button type="button" class="btn btn-sm" data-cal-img="dl">Unduh gambar</button><button type="button" class="btn btn-ghost btn-sm" data-cal-img="copy">Salin gambar</button><span class="muted">untuk follow up purchasing · ikut filter jenis &amp; supplier</span></div>` : ''}
      <div class="cal-list">${list.map((it) => `<button class="cal-item" data-key="${esc(it.r.key)}">
          <span class="badge ${KIND[it.kind][1]}">${KIND[it.kind][0]}</span>
          <span class="cal-item-main"><b>${esc(it.r.po)}</b> · ${esc(it.r.supplier)}<br><span class="mat-name">${esc(it.r.name)}</span> <span class="mat-code">${esc(it.r.code)}</span></span>
          <span class="cal-item-qty">${fmtNum(it.qty)} ${esc(it.r.uom)}${it.kf && it.kf.week ? `<small>datang ${esc(it.kf.week)} ${esc(monShort(it.kf.bulan))}</small>` : ''}</span>
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
    const ib = e.target.closest('[data-cal-img]'); if (ib) { calImage(ib.dataset.calImg, ib); return; }
    if (e.target.closest('[data-cal-recv]')) { calRecvAll(); return; }
    if (e.target.closest('[data-go-late]')) return goMonitor({ status: 'late', sort: 'late-desc', jenis: $('cJenis').value, supplier: $('cSup').value });
    const it = e.target.closest('.cal-item'); if (!it) return;
    const r = state.rows.find((x) => x.key === it.dataset.key);
    if (r) goMonitor({ q: r.po, openKey: r.key, jenis: '', supplier: '' });
  });

  /* ---------- Kalender: tandai semua Incoming hari ini sudah datang ---------- */
  // Untuk tiap jadwal Incoming (dikonfirmasi di Proyeksi Stok) di tanggal hari ini: Diterima di Monitoring PO += qty konfirmasi
  // (Done bila penuh) dan konfirmasi diberi tanggal datang hari ini.
  function calRecvAll() {
    const today = todayStr(), items = (CAL.list || []).filter((x) => x.kind === 'inc' && x.date === today && x.kf);
    if (!items.length) return;
    if (!P.hasIncK) { toast('Apps Script MRP perlu diperbarui dulu.'); return; }
    needEdit(() => openDialog({
      title: `Tandai ${items.length} Incoming sudah datang`, ok: 'Tandai sudah datang', wide: true,
      body: `<p class="dlg-lead">Kolom <b>Diterima</b> di Monitoring PO diisi sebesar qty konfirmasi dan konfirmasi diberi tanggal datang <b>${fmtDate(today)}</b>.</p>
        <div class="table-wrap"><table class="po-table pl-mini"><thead><tr><th>No PO</th><th>Kode</th><th>Material</th><th>Supplier</th><th class="num">Qty jadwal</th><th class="num">Diterima sekarang</th><th class="num">Qty datang</th></tr></thead><tbody>
        ${items.map((x) => { const sc = x.r.sched.find((y) => String(y.n) === String(x.kf.ke)) || {}; return `<tr><td><b>${esc(x.r.po)}</b></td><td>${esc(x.r.code)}</td><td>${esc(x.r.name)}</td><td>${esc(x.r.supplier)}</td><td class="num">${fmtNum(sc.qty)}</td><td class="num">${fmtNum(sc.rec || 0)}</td><td class="num"><b>${fmtNum(x.kf.qty)}</b> ${esc(x.r.uom)}</td></tr>`; }).join('')}
        </tbody></table></div>
        ${!state.edit.on ? `<div class="form-grid">${fld('popin', 'PIN Monitoring PO (untuk mengisi Diterima)', '', { type: 'password', required: true })}</div>` : ''}
        <p class="hint">Bisa dibatalkan per jadwal lewat tombol ✓ di Proyeksi Stok / Monitoring PO (hilangkan centang "Sudah datang").</p>`,
      onSubmit: async (fd) => {
        const pinOld = state.edit.pin;
        if (!state.edit.on) { state.edit.pin = String(fd.popin || '').trim(); if (!state.edit.pin) throw new Error('Isi PIN Monitoring PO.'); }
        const done = [];
        try {
          for (const x of items) {
            const k = x.kf, sc = x.r.sched.find((y) => String(y.n) === String(k.ke));
            if (!sc || k.datang) continue;
            const rec = round4((Number(sc.rec) || 0) + k.qty), q = Number(sc.qty) || 0;
            const r2 = await api('saveSched', { key: { po: k.po, code: k.code, n: Number(k.ke) }, data: { po: k.po, code: k.code, name: x.r.name, date: sc.date, status: rec >= q - 1e-9 ? 'Done' : (sc.status || 'Confirmed'), qty: q, rec } });
            applyServerUpdate(r2);
            const res = await mrpApi('setIncK', { po: k.po, kode: k.code, ke: k.ke, qty: k.qty, tgl: k.tgl || sc.date || '', note: k.note || '', bulan: '', week: '', datang: today });
            setIncK(res.incK || []);
            done.push(`${k.po}/${k.code}`);
          }
        } catch (err) {
          throw new Error((done.length ? `Sudah tersimpan: ${done.join(', ')}. ` : '') + 'Berhenti karena: ' + err.message);
        } finally { if (!state.edit.on) state.edit.pin = pinOld; }
        setTimeout(renderCal, 0);
        return `${done.length} jadwal ditandai sudah datang.`;
      },
    }));
  }

  /* ---------- Kalender: gambar daftar kedatangan (follow up purchasing) ---------- */
  function calCanvas() {
    const list = CAL.list || [], sel = CAL.sel, jenisSel = $('cJenis'), sup = $('cSup').value;
    const jenisTxt = jenisSel.options[jenisSel.selectedIndex] ? jenisSel.options[jenisSel.selectedIndex].text : 'Semua jenis';
    const KIND = { late: ['Lewat jadwal', '#b42318', '#fdecea'], wait: ['Dijadwalkan', '#1d5fa8', '#e8f0fb'], promise: ['Janji kirim baru', '#7a4d00', '#fff4dd'], inc: ['Incoming', '#1f6b35', '#e3f1e6'] };
    // kelompok per supplier (supaya mudah diteruskan per supplier)
    const groups = new Map();
    list.forEach((it) => { const g = groups.get(it.r.supplier) || []; g.push(it); groups.set(it.r.supplier, g); });
    const S = 2, W = 1180, PAD = 28, RH = 34, GH = 34;
    const cols = [{ t: 'Status', w: 130 }, { t: 'No PO', w: 110 }, { t: 'Kode', w: 80 }, { t: 'Material', w: 0 }, { t: 'Tgl order', w: 100 }, { t: 'Sisa datang', w: 140, r: true }];
    const fixed = cols.reduce((t, c) => t + c.w, 0); cols[3].w = W - PAD * 2 - fixed;
    const H = PAD + 30 + 22 + 22 + 18 + RH + groups.size * GH + list.length * RH + 46;
    const cv = document.createElement('canvas'); cv.width = W * S; cv.height = H * S;
    const g = cv.getContext('2d'); g.scale(S, S);
    const F = (w, sz) => `${w} ${sz}px Inter, "Segoe UI", Arial, sans-serif`;
    const fit = (t, w) => { t = String(t || ''); if (g.measureText(t).width <= w) return t; while (t.length && g.measureText(t + '…').width > w) t = t.slice(0, -1); return t + '…'; };
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    let y = PAD + 22;
    g.fillStyle = '#0b4f2b'; g.font = F(700, 22); g.fillText('Jadwal Kedatangan Material', PAD, y);
    g.fillStyle = '#1b2b3f'; g.font = F(600, 16); y += 26; g.fillText(dayLong.format(new Date(sel + 'T00:00:00')), PAD, y);
    g.fillStyle = '#5b6878'; g.font = F(400, 13); y += 22;
    g.fillText(`Jenis: ${jenisTxt} · Supplier: ${sup || 'Semua supplier'} · ${nf.format(list.length)} kedatangan · ${nf.format(groups.size)} supplier`, PAD, y);
    y += 18;
    // kepala tabel
    let x = PAD; g.fillStyle = '#eef3f0'; g.fillRect(PAD, y, W - PAD * 2, RH);
    g.fillStyle = '#334155'; g.font = F(600, 12.5);
    cols.forEach((c) => { g.textAlign = c.r ? 'right' : 'left'; g.fillText(c.t, c.r ? x + c.w - 10 : x + 10, y + 22); x += c.w; }); g.textAlign = 'left';
    y += RH;
    groups.forEach((items, supName) => {
      g.fillStyle = '#f6f8fa'; g.fillRect(PAD, y, W - PAD * 2, GH);
      g.fillStyle = '#0b4f2b'; g.font = F(700, 13.5); g.fillText(fit(supName || '(tanpa supplier)', W - PAD * 2 - 140), PAD + 10, y + 22);
      g.fillStyle = '#5b6878'; g.font = F(400, 12); g.textAlign = 'right'; g.fillText(`${items.length} item`, W - PAD - 10, y + 22); g.textAlign = 'left';
      y += GH;
      items.forEach((it) => {
        g.strokeStyle = '#e3e8ee'; g.beginPath(); g.moveTo(PAD, y + RH - 0.5); g.lineTo(W - PAD, y + RH - 0.5); g.stroke();
        let cx = PAD; const k = KIND[it.kind];
        g.font = F(600, 11.5); const bw = g.measureText(k[0]).width + 14;
        g.fillStyle = k[2]; g.beginPath(); if (g.roundRect) g.roundRect(cx + 10, y + 8, bw, 19, 9); else g.rect(cx + 10, y + 8, bw, 19); g.fill();
        g.fillStyle = k[1]; g.fillText(k[0], cx + 17, y + 21.5); cx += cols[0].w;
        g.fillStyle = '#1b2b3f'; g.font = F(700, 13); g.fillText(it.r.po, cx + 10, y + 22); cx += cols[1].w;
        g.font = F(500, 12.5); g.fillStyle = '#5b6878'; g.fillText(it.r.code, cx + 10, y + 22); cx += cols[2].w;
        g.fillStyle = '#1b2b3f'; g.font = F(400, 13); g.fillText(fit(it.r.name, cols[3].w - 20), cx + 10, y + 22); cx += cols[3].w;
        g.fillStyle = '#5b6878'; g.font = F(400, 12); g.fillText(it.r.date ? fmtDate(it.r.date) : '', cx + 10, y + 22); cx += cols[4].w;
        g.fillStyle = '#1b2b3f'; g.font = F(700, 13.5); g.textAlign = 'right'; g.fillText(`${fmtNum(it.qty)} ${it.r.uom || ''}`, cx + cols[5].w - 10, y + 22); g.textAlign = 'left';
        y += RH;
      });
    });
    g.fillStyle = '#8a96a5'; g.font = F(400, 11.5);
    g.fillText(`Dibuat dari Monitoring PO · data PO dibaca ${state.readAt ? whenText(state.readAt) : '-'} · ${new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })}`, PAD, H - 18);
    return cv;
  }
  async function calImage(mode, btn) {
    if (!(CAL.list || []).length) return;
    const cv = calCanvas();
    const blob = await new Promise((ok) => cv.toBlob(ok, 'image/png'));
    const sup = $('cSup').value, jenisSel = $('cJenis');
    const jt = jenisSel.options[jenisSel.selectedIndex] ? jenisSel.options[jenisSel.selectedIndex].text : '';
    const name = `Kedatangan_${CAL.sel}_${(sup || 'Semua-supplier').replace(/[^\w.-]+/g, '-')}_${jt.replace(/[^\w.-]+/g, '-')}.png`;
    if (mode === 'copy') {
      try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('Gambar disalin. Tempel (Ctrl+V) di WhatsApp / email.'); return; }
      catch (err) { toast('Browser tidak mengizinkan salin gambar, jadi gambar diunduh.'); }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    if (btn) { const t = btn.textContent; btn.textContent = 'Terunduh ✓'; setTimeout(() => { btn.textContent = t; }, 1500); }
  }

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
  let dlgSeq = 0;   // nomor dialog: listener khusus satu dialog tidak ikut terpanggil di dialog berikutnya
  function openDialog({ title, body, ok = 'Simpan', danger = false, onSubmit, cancel = true, wide = false }) {
    dlgSeq++;
    $('dlgCancel').hidden = !cancel;
    $('dlg').classList.toggle('dlg-wide', !!wide); $('dlg').classList.toggle('dlg-xwide', wide === 'x');
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
    renderPrViews();
  }

  $('btnEditMode').addEventListener('click', () => {
    if (state.route && state.route.actions === 'mrp') { if (P.edit) setMrpEdit(false); else askMrpPin(); return; }
    if (state.edit.on) return setEditMode(false);
    if (!state.freshLoaded) { toast('Tunggu sampai data terbaru selesai dimuat, baru mode edit bisa dipakai.'); return; }
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
    if (!state.freshLoaded) { out.className = 'send-result err'; out.textContent = 'Tunggu sampai data PO terbaru selesai dimuat (lihat penanda di Beranda), lalu kirim lagi.'; return; }
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
      const res = await fetch(CFG.MRP_SCRIPT_URL + (force === 'fresh' ? '?fresh=1' : ''));
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
    // Nama versi BOM yang ditampilkan = Reference (BOM ID tidak ditampilkan). Reference kosong/kembar diberi nomor urut.
    MRP.byProduct.forEach((list) => {
      const base = (b) => (b.ref && b.ref !== 'Empty Ref' ? b.ref : 'tanpa reference');
      const cnt = {}; list.forEach((b) => { cnt[base(b)] = (cnt[base(b)] || 0) + 1; });
      const seen = {}; list.forEach((b) => { const k = base(b); seen[k] = (seen[k] || 0) + 1; b.lbl = cnt[k] > 1 ? `${k} (${seen[k]})` : k; });
    });
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
        <b>${esc(refOf(b))}</b><span class="muted">${b.comps.length} komponen</span></button>`).join('');

    const rows = [];
    const walk = (nodes, parentOpen) => nodes.forEach((n) => {
      if (!parentOpen) return;
      const open = MRP.open.has(n.key);
      const subs = n.kids ? MRP.byProduct.get(n.c.code) : null;
      const m = MRP.master.get(n.c.code);
      rows.push(`<tr class="lvl-${Math.min(n.depth, 3)}${n.kids ? ' has-sub' : ''}">
        <td class="mrp-code" style="padding-left:${10 + n.depth * 22}px">${n.kids ? `<button class="mrp-tog" data-tog="${esc(n.key)}" aria-expanded="${open}" title="${open ? 'Tutup' : 'Uraikan BOM'} ${esc(n.c.code)}">${open ? '▾' : '▸'}</button>` : '<span class="mrp-tog-sp"></span>'}<button class="btn-link mrp-goto" data-use="${esc(n.c.code)}" title="Lihat pemakaian material ini">${esc(n.c.code)}</button></td>
        <td>${esc((m && m.name) || n.c.name)}${n.kids ? `<div class="mrp-subinfo">Punya BOM sendiri: ${subs.length > 1 ? `<select class="mrp-subsel" data-sub="${esc(n.c.code)}">${subs.map((b) => `<option value="${esc(b.id)}"${b.id === n.sub.id ? ' selected' : ''}>${esc(refOf(b))}</option>`).join('')}</select>` : `${esc(refOf(n.sub))}`} (batch ${fmtQ(n.sub.batch)} ${esc(n.sub.uom)})</div>` : ''}</td>
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
        <div class="sched-wrap"><table class="sched mrp-cmp"><thead><tr><th>Kode</th><th>Nama</th>${p.boms.map((b) => `<th class="num" title="${esc(b.ref)}">${esc(refOf(b))}</th>`).join('')}</tr></thead>
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
        <h4 class="dt-h">Komponen ${esc(refOf(bom))} <span class="muted">batch ${fmtQ(bom.batch)} ${esc(bom.uom)}${bom.note ? ' · ' + esc(bom.note) : ''}</span>
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

  /* ---------- Tambah BoM: upload export BoM Odoo → BOM_LIST & BOM_DETAIL di DATABASE PPIC GTK ---------- */
  const bomNum = (v) => { if (typeof v === 'number') return v; const t = String(v || '').trim(); if (!t) return 0; const x = Number(/,\d{1,6}$/.test(t) && !/\.\d{3},/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '')); return isFinite(x) ? x : 0; };
  function parseOdooBom(rows) {
    const hi = rows.findIndex((r, i) => i < 10 && r.some((v) => String(v).trim() === 'bom_lines/product_id/code'));
    if (hi < 0) throw new Error('Kolom bom_lines/product_id/code tidak ditemukan. Gunakan export BoM Odoo (mrp.bom) dengan kolom seperti contoh.');
    const h = rows[hi].map((v) => String(v).trim());
    const col = (...names) => { for (const n of names) { const i = h.indexOf(n); if (i >= 0) return i; } return -1; };
    const c = {
      id: col('id'), code: col('product_id/code', 'product_tmpl_id/default_code', 'product_id/default_code'), name: col('product_id/name', 'product_tmpl_id/name'),
      batch: col('product_qty'), ref: col('code'), lc: col('bom_lines/product_id/code', 'bom_lines/product_id/default_code'), ln: col('bom_lines/product_id/name'),
      lq: col('bom_lines/product_qty'), lu: col('bom_lines/product_id/uom_po_id', 'bom_lines/product_uom_id', 'bom_lines/product_id/uom_id'),
    };
    const miss = ['code', 'batch', 'lc', 'lq'].filter((k) => c[k] < 0);
    if (miss.length) throw new Error('Kolom wajib tidak ada: ' + miss.map((k) => ({ code: 'product_id/code', batch: 'product_qty', lc: 'bom_lines/product_id/code', lq: 'bom_lines/product_qty' })[k]).join(', '));
    const out = [];
    let cur = null;
    for (let i = hi + 1; i < rows.length; i++) {
      const r = rows[i], g = (k) => (c[k] >= 0 ? String(r[c[k]] === undefined || r[c[k]] === null ? '' : r[c[k]]).trim() : '');
      if (g('code') || (c.id >= 0 && g('id'))) {
        cur = { odoo: g('id').replace(/^__export__\./, ''), code: g('code'), name: g('name'), batch: bomNum(r[c.batch]), ref: g('ref'), lines: [] };
        out.push(cur);
      }
      if (!cur || !g('lc')) continue;
      cur.lines.push([g('lc'), g('ln'), bomNum(r[c.lq]), g('lu')]);
    }
    return out.filter((b) => b.code);
  }
  function bomCheck(b) {
    const same = (MRP.byProduct.get(b.code) || []);
    const warn = [], info = [];
    const dupRef = same.filter((x) => (x.ref || '').trim().toLowerCase() === (b.ref || '').trim().toLowerCase());
    const dupOdoo = b.odoo ? MRP.boms.filter((x) => (x.note || '').includes(b.odoo)) : [];
    if (dupRef.length) warn.push(`Produk ${b.code} dengan Reference "${b.ref || '(kosong)'}" sudah ada: ${dupRef.map((x) => x.id).join(', ')}`);
    if (dupOdoo.length) warn.push(`BoM Odoo ${b.odoo} sudah pernah di-upload: ${dupOdoo.map((x) => x.id).join(', ')}`);
    if (!dupRef.length && same.length) info.push(`Versi baru — sudah ada ${same.length} versi (${same.map((x) => x.lbl || x.ref).join(', ')})`);
    if (!same.length) info.push('Produk baru di DATABASE');
    // UoM BoM: ikut versi yang sudah ada; produk baru → Pcs bila ada komponen Pcs (FG), selain itu Kg (ekstrak/bulk)
    b.uom = same.length ? same[0].uom : (b.lines.some((l) => normU(l[3]) === 'pcs' || normU(l[3]) === 'unit') ? 'Pcs' : 'Kg');
    if (!b.name) b.name = ((MRP.master.get(b.code) || {}).name) || (same[0] && same[0].name) || '';
    const noMaster = [], badU = [], zero = [];
    b.lines.forEach((l) => {
      const m = MRP.master.get(l[0]);
      l[4] = m ? m.kat : (MRP.byProduct.has(l[0]) ? 'Ekstrak/bulk' : '');
      if (!m && !MRP.byProduct.has(l[0])) noMaster.push(l[0]);
      if (m && m.uom && l[3] && normU(m.uom) !== normU(l[3])) badU.push(`${l[0]} (${l[3]} vs master ${m.uom})`);
      if (!l[2]) zero.push(l[0]);
    });
    if (noMaster.length) warn.push(`Belum ada di MASTER_MATERIAL: ${noMaster.join(', ')} — bisa ikut ditambahkan (lihat daftar di bawah)`);
    if (badU.length) warn.push(`UoM beda dengan master: ${badU.join(', ')}`);
    if (zero.length) warn.push(`Qty 0 (tidak disimpan): ${zero.join(', ')}`);
    if (!(b.batch > 0)) warn.push('Qty batch kosong / 0');
    b.dup = dupRef.length > 0 || dupOdoo.length > 0;
    b.bad = !(b.batch > 0) || !b.lines.some((l) => l[2]);
    return { warn, info };
  }
  function bomAddDialog() {
    const st = { list: [], file: '', mats: new Map() };
    const KATS = [...new Set(['RM (Raw)', 'PM (Pack)', 'Ekstrak', 'FG', 'Service'].concat([...MRP.master.values()].map((m) => m.kat).filter(Boolean)))];
    const UOMS = [...new Set(['Kg', 'Pcs', 'Rol', 'Set', 'Liter(s)'].concat([...MRP.master.values()].map((m) => m.uom).filter(Boolean)))];
    const paintMat = () => {
      const el = $('bomUpMat'); if (!el) return;
      if (!st.mats.size) { el.innerHTML = st.list.length ? '<p class="bomup-i">Semua kode sudah ada di MASTER_MATERIAL.</p>' : ''; return; }
      el.innerHTML = `<div class="bomup bomup-mat"><p class="bomup-h"><b>${st.mats.size} kode belum ada di MASTER_MATERIAL</b> <span class="muted">· yang dicentang ikut ditambahkan ke MASTER_MATERIAL (hanya bila dipakai BoM yang dicentang). Periksa nama, UoM, dan kategorinya.</span></p>
        <table class="po-table pl-mini"><thead><tr><th></th><th>Kode</th><th>Nama</th><th>UoM</th><th>Kategori</th><th>Asal</th></tr></thead><tbody>
        ${[...st.mats.values()].map((m) => `<tr><td><input type="checkbox" data-mon="${esc(m.code)}"${m.on ? ' checked' : ''} aria-label="Tambahkan ${esc(m.code)}"></td><td class="mono">${esc(m.code)}</td>
          <td><input type="text" class="bomup-in" data-mnm="${esc(m.code)}" value="${esc(m.name)}"></td>
          <td><select data-muom="${esc(m.code)}">${UOMS.map((u) => `<option${normU(u) === normU(m.uom) ? ' selected' : ''}>${esc(u)}</option>`).join('')}${UOMS.some((u) => normU(u) === normU(m.uom)) || !m.uom ? '' : `<option selected>${esc(m.uom)}</option>`}</select></td>
          <td><select data-mkat="${esc(m.code)}">${KATS.map((k) => `<option${k === m.kat ? ' selected' : ''}>${esc(k)}</option>`).join('')}</select></td><td class="muted">${esc(m.role)}</td></tr>`).join('')}
        </tbody></table></div>`;
    };
    const paint = () => {
      const el = $('bomUpList'); if (!el) return;
      if (!st.list.length) { el.innerHTML = ''; return; }
      el.innerHTML = `<p class="dlg-lead">${st.list.length} BoM di file · centang yang akan ditambahkan. Yang sudah ada (produk + Reference sama, atau BoM Odoo yang sama) <b>tidak dicentang</b>; centang bila memang ingin ditambah sebagai versi baru.</p>`
        + st.list.map((b, i) => `<div class="bomup${b.dup ? ' is-dup' : ''}${b.bad ? ' is-bad' : ''}">
          <label class="bomup-h"><input type="checkbox" data-bi="${i}"${b.on ? ' checked' : ''}${b.bad ? ' disabled' : ''}>
            <b>${esc(b.code)}</b> ${esc(b.name)} <span class="muted">· Ref <b>${esc(b.ref || '(kosong)')}</b> · batch ${fmtQ(b.batch)} ${esc(b.uom)} · ${b.lines.filter((l) => l[2]).length} komponen</span></label>
          ${b.chk.warn.map((w) => `<p class="bomup-w">⚠ ${esc(w)}</p>`).join('')}${b.chk.info.map((w) => `<p class="bomup-i">${esc(w)}</p>`).join('')}
          <details><summary>Lihat komponen</summary><table class="po-table pl-mini"><thead><tr><th>Kode</th><th>Material</th><th>Kategori</th><th class="num">Qty</th><th>UoM</th></tr></thead><tbody>
          ${b.lines.map((l) => `<tr${l[2] ? '' : ' class="muted"'}><td class="mono">${esc(l[0])}</td><td>${esc(l[1])}</td><td>${esc(l[4] || '–')}</td><td class="num">${fmtQ(l[2])}</td><td>${esc(l[3])}</td></tr>`).join('')}
          </tbody></table></details></div>`).join('');
      $('dlgOk').disabled = !st.list.some((b) => b.on);
      $('dlgOk').textContent = `Tambahkan ${st.list.filter((b) => b.on).length} BoM`;
    };
    openDialog({
      title: 'Tambah BoM dari export Odoo', ok: 'Tambahkan', wide: true,
      body: `<p class="dlg-lead">Upload file export BoM Odoo (Bill of Materials → Export: product_id/code, product_qty, code, bom_lines/…). Satu file boleh berisi beberapa BoM. Disimpan sebagai BoM baru di DATABASE PPIC GTK (BOM_LIST &amp; BOM_DETAIL); BoM lama tidak diubah.</p>
        <label class="file-drop" for="bomUpFile"><input type="file" id="bomUpFile" accept=".xls,.xlsx"><span class="file-btn">Pilih file BoM Odoo</span><span class="file-name" id="bomUpName">Belum ada file</span></label>
        <div id="bomUpList"></div><div id="bomUpMat"></div>`,
      onSubmit: async () => {
        const sel = st.list.filter((b) => b.on);
        if (!sel.length) throw new Error('Pilih minimal satu BoM.');
        const used = new Set(); sel.forEach((b) => { used.add(b.code); b.lines.forEach((l) => { if (l[2]) used.add(l[0]); }); });
        const mats = [...st.mats.values()].filter((m) => m.on && used.has(m.code));
        const bad = mats.filter((m) => !m.name);
        if (bad.length) throw new Error('Nama material baru masih kosong: ' + bad.map((m) => m.code).join(', '));
        const katOf = (code, k) => { const m = st.mats.get(code); return m && m.on ? m.kat : k === 'Ekstrak/bulk' ? '' : k; };
        const res = await mrpApi('addBoms', { file: st.file, master: mats.map((m) => [m.code, m.name, m.uom, m.kat]),
          boms: sel.map((b) => ({ code: b.code, name: b.name, batch: b.batch, uom: b.uom, ref: b.ref, odoo: b.odoo, lines: b.lines.filter((l) => l[2]).map((l) => { const m = st.mats.get(l[0]); return [l[0], m && m.on ? m.name : l[1], l[2], m && m.on ? m.uom : l[3], katOf(l[0], l[4])]; }) })) });
        await loadMrp('fresh');
        const nm = (res.addedMaster || []).length;
        return `${(res.added || []).length} BoM ditambahkan: ${(res.added || []).map((x) => x[0] + ' ' + x[1]).join(', ')}${nm ? ` · ${nm} material baru masuk MASTER_MATERIAL` : ''}`;
      },
    });
    $('dlgOk').disabled = true;
    const seq = dlgSeq, body = $('dlgBody');
    body.addEventListener('change', async (e) => {
      if (seq !== dlgSeq) return;
      const cb = e.target.closest('[data-bi]');
      if (cb) { st.list[Number(cb.dataset.bi)].on = cb.checked; paint(); return; }
      const t = e.target, mk = t.dataset.mon || t.dataset.mnm || t.dataset.muom || t.dataset.mkat;
      if (mk && st.mats.has(mk)) {
        const m = st.mats.get(mk);
        if (t.dataset.mon) m.on = t.checked; else if (t.dataset.mnm) m.name = t.value.trim(); else if (t.dataset.muom) m.uom = t.value; else m.kat = t.value;
        return;
      }
      if (e.target.id !== 'bomUpFile') return;
      const f = e.target.files[0]; if (!f) return;
      $('bomUpName').textContent = f.name; st.file = f.name; $('dlgError').textContent = '';
      try {
        const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true });
        st.list = parseOdooBom(rows);
        if (!st.list.length) throw new Error('Tidak ada BoM yang terbaca di file ini.');
        st.list.forEach((b) => { b.chk = bomCheck(b); b.on = !b.dup && !b.bad; });
        // Kode yang belum ada di MASTER_MATERIAL: produk BoM & komponen → bisa langsung ditambahkan
        st.mats = new Map();
        st.list.forEach((b) => {
          if (!MRP.master.has(b.code) && !st.mats.has(b.code)) st.mats.set(b.code, { code: b.code, name: b.name, uom: b.uom, kat: normU(b.uom) === 'kg' ? 'Ekstrak' : 'FG', role: 'produk BoM', on: true });
          b.lines.forEach((l) => {
            if (MRP.master.has(l[0]) || st.mats.has(l[0])) return;
            const u = normU(l[3]);
            st.mats.set(l[0], { code: l[0], name: l[1], uom: l[3], kat: MRP.byProduct.has(l[0]) ? 'Ekstrak' : u === 'kg' || u === 'liter(s)' ? 'RM (Raw)' : 'PM (Pack)', role: 'komponen', on: true });
          });
        });
      } catch (err) { st.list = []; st.mats = new Map(); $('dlgError').textContent = err.message; }
      paint(); paintMat();
    });
  }
  $('bAdd').addEventListener('click', () => needEdit(bomAddDialog));

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
  const MAT_GET = { code: (x) => x.code, name: (x) => x.name, uom: (x) => x.uom, kat: (x) => x.kat, used: (x) => x.used || null, bom: (x) => x.bom || null };
  function matRows() {
    return [...MRP.master.values()].map((m) => {
      const used = new Set((MRP.usedIn.get(m.code) || []).map((u) => u.bom.code)).size;
      return { ...m, used, bom: (MRP.byProduct.get(m.code) || []).length, search: (m.code + ' ' + m.name).toLowerCase() };
    });
  }
  function renderMatList() {
    const q = $('mq').value.trim().toLowerCase(), k = $('mKat').value, u = $('mUse').value;
    let rows = matRows().filter((x) => (!q || q.split(/\s+/).every((w) => x.search.includes(w)))
      && (!k || (x.kat || 'Tanpa kategori') === k)
      && (!u || (u === 'used' ? x.used : u === 'unused' ? !x.used : u === 'hasbom' ? x.bom : true)));
    rows = applyColSort(rows, colSort.mat, MAT_GET);
    paintSortHeaders($('mTable'), 'mat');
    MRP.matView = rows;
    $('mCount').textContent = `${nf.format(rows.length)} material`;
    $('mRows').innerHTML = rows.slice(0, MRP.shown).map((x) => `<tr class="row" data-mat="${esc(x.code)}" tabindex="0">
        <td class="po">${esc(x.code)}</td><td>${esc(x.name)}</td><td>${esc(x.uom)}</td><td>${esc(x.kat || '–')}</td>
        <td class="num">${x.used ? nf.format(x.used) : '<span class="muted">–</span>'}</td>
        <td class="num">${x.bom ? nf.format(x.bom) : '<span class="muted">–</span>'}</td></tr>`).join('')
      || '<tr class="empty"><td colspan="6">Tidak ada material yang cocok.</td></tr>';
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
    const data = (MRP.matView || []).map((x) => ({ 'Kode': x.code, 'Nama Material': x.name, 'UoM': x.uom, 'Kategori': x.kat, 'Dipakai di Produk': x.used, 'Versi BOM Sendiri': x.bom }));
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
    $('uResult').innerHTML = `
      <div class="dt-tiles mrp-utiles">
        <div class="dt-tile"><span class="dt-k">Material</span><span class="dt-v">${esc(code)}</span><span class="dt-sub">${esc((m && m.name) || (direct[0] && direct[0].bom.comps.find((c) => c.code === code) || {}).name || 'Tidak ada di master')}</span></div>
        <div class="dt-tile"><span class="dt-k">Kategori · UoM</span><span class="dt-v">${esc((m && m.kat) || '–')}</span><span class="dt-sub">${esc((m && m.uom) || '')}</span></div>
        <div class="dt-tile"><span class="dt-k">Dipakai langsung di</span><span class="dt-v">${nf.format(directProducts.length)} <small>produk</small></span><span class="dt-sub">${nf.format(direct.length)} versi BOM</span></div>
      </div>
      <section class="dt-card mrp-card">
        <h4 class="dt-h">Dipakai langsung <span class="muted">${direct.length} versi BOM</span></h4>
        <div class="sched-wrap"><table class="sched"><thead><tr><th>Produk</th><th>Nama produk</th><th>Kategori</th><th>BOM</th><th class="num">Qty per batch</th><th class="num">Batch</th></tr></thead>
        <tbody>${direct.map((u) => `<tr><td><button class="btn-link" data-bom="${esc(u.bom.code)}" data-ver="${esc(u.bom.id)}">${esc(u.bom.code)}</button></td><td>${esc(prodName(u.bom.code))}</td><td>${esc(prodKat(u.bom.code))}</td><td>${esc(refOf(u.bom))}</td><td class="num">${fmtQ(u.qty)} ${esc(u.uom)}</td><td class="num">${fmtQ(u.bom.batch)} ${esc(u.bom.uom)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Tidak dipakai langsung di BOM mana pun.</td></tr>'}</tbody></table></div>
      </section>
      ${indirect.length ? `<section class="dt-card mrp-card">
        <h4 class="dt-h">Dipakai tidak langsung <span class="muted">lewat ekstrak/bulk yang memakai material ini</span></h4>
        <div class="sched-wrap"><table class="sched"><thead><tr><th>Produk</th><th>Nama produk</th><th>Kategori</th><th>Lewat</th><th>BOM</th><th class="num">Qty ekstrak/bulk per batch</th></tr></thead>
        <tbody>${indirect.map((u) => `<tr><td><button class="btn-link" data-bom="${esc(u.bom.code)}" data-ver="${esc(u.bom.id)}">${esc(u.bom.code)}</button></td><td>${esc(prodName(u.bom.code))}</td><td>${esc(prodKat(u.bom.code))}</td><td>${u.via.map((c) => `${esc(c)} <span class="muted">${esc(prodName(c))}</span>`).join(' → ')}</td><td>${esc(refOf(u.bom))}</td><td class="num">${fmtQ(u.qty)} ${esc(u.uom)}</td></tr>`).join('')}</tbody></table></div>
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
        desc: 'Baris BOM yang satuan komponennya berbeda dengan satuan di master. Cari produk dan Reference-nya di tab BOM_LIST / BOM_DETAIL (DATABASE PPIC), lalu samakan UoM dan sesuaikan qty-nya. Klik baris untuk membuka BOM tersebut.',
        head: ['Kode', 'Nama material', 'BOM', 'Produk', 'Qty di BOM', 'UoM di BOM', 'UoM di master'],
        row: (x) => [x.c.code, x.m.name, refOf(x.b), x.b.code + ' ' + x.b.name, fmtQ(x.c.qty), x.c.uom, x.m.uom], bom: (x) => x.b.code, ver: (x) => x.b.id },
      zero: { label: 'BOM kosong / qty 0', badge: true, rows: zero,
        desc: 'BOM tanpa komponen, atau komponen dengan qty 0/kosong.',
        head: ['BOM', 'Produk', 'Komponen', 'Qty'], row: (x) => [refOf(x.b), x.b.code + ' ' + x.b.name, x.c ? x.c.code + ' ' + x.c.name : '(tidak ada komponen)', x.c ? (x.c.qty === '' ? 'kosong' : x.c.qty) : '–'], bom: (x) => x.b.code },
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
  // saldo stok berjalan dengan incoming manual.
  const P = {
    ready: false, edit: false, pin: '', hz: null, queue: new Map(), mqueue: new Map(), qTimer: null, saving: false, planMon: new Map(),
    skus: new Map(), plan: new Map(), stock: new Map(), stockDate: '', stockSrc: '', adj: [], inc: [], weeks: [], log: [],
    parsedStock: null, parsedPlan: null,
  };
  const PLAN_KEYS = new Set(['mrp/rencana', 'mrp/konfirmasi', 'mrp/harian', 'mrp/kalender', 'mrp/kebutuhan', 'mrp/proyeksi', 'mrp/suggest', 'mrp/sku', 'mrp/update', 'mrp/rakitan']);
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
    P.hasPlanMon = Array.isArray(d.planMon);
    P.planMon = new Map();
    (d.planMon || []).forEach((r) => { if (r[0] && r[1] && Number(r[2]) > 0) P.planMon.set(`${r[0]}|${r[1]}`, { bulan: r[0], code: r[1], qty: Number(r[2]), src: r[3], time: r[4] }); });
    const st = d.stock || [];
    P.stockDate = st.reduce((m, r) => (r[0] > m ? r[0] : m), '');
    P.stockSrc = (st.find((r) => r[0] === P.stockDate) || [])[5] || '';
    P.stockHist = new Map();
    st.forEach((r) => { if (!r[0]) return; let m = P.stockHist.get(r[0]); if (!m) P.stockHist.set(r[0], (m = new Map())); const o = m.get(r[1]) || { qty: 0, uom: r[4], name: r[2] }; o.qty += Number(r[3]) || 0; m.set(r[1], o); });
    P.stock = new Map();
    st.filter((r) => r[0] === P.stockDate).forEach((r) => {
      const o = P.stock.get(r[1]) || { qty: 0, uom: r[4], name: r[2] };
      o.qty += Number(r[3]) || 0; P.stock.set(r[1], o);
    });
    // Stok Gantung (upload sendiri): Stok Tersedia = Stok Awal − Stok Gantung
    P.hasGantung = Array.isArray(d.gantung);
    const gt = d.gantung || [];
    P.gantungDate = gt.reduce((m, r) => (r[0] > m ? r[0] : m), '');
    P.gantungSrc = (gt[0] || [])[5] || '';
    P.gantung = new Map();
    gt.forEach((r) => { P.gantung.set(r[1], (P.gantung.get(r[1]) || 0) + (Number(r[3]) || 0)); });
    P.adj = (d.adj || []).map((r) => ({ id: r[0], date: r[1], code: r[2], qty: Number(r[3]) || 0, note: r[4], time: r[5] }));
    // Konfirmasi Produksi (MO Odoo)
    P.hasKonf = Array.isArray(d.konf);
    P.konf = new Map((d.konf || []).map((r) => [r[0], { no: r[0], code: r[1], name: r[2], qty: Number(r[3]) || 0, uom: r[4], bom: r[5], kg: r[6] === '' ? '' : Number(r[6]) || 0,
      bulan: r[7], week: r[8], ek: r[9], ekKg: r[10] === '' ? '' : Number(r[10]) || 0, moEk: r[11], note: r[12], time: r[13], tgl: r[14] || '' }]));
    P.kfDraft = new Map(); P.kfDel = new Set();
    P.hasCons = Array.isArray(d.cons); setCons(d.cons || []);
    P.inc = (d.inc || []).map((r) => ({ id: r[0], bulan: r[1], week: r[2], code: r[3], qty: Number(r[4]) || 0, note: r[5], time: r[6] }));
    P.hasIncK = Array.isArray(d.incK); setIncK(d.incK || []);
    P.hasRakitan = Array.isArray(d.rakitan); setRakitan(d.rakitan || []);
    P.hasPakai = Array.isArray(d.rakitanPakai); setPakai(d.rakitanPakai || []);
    P.hasKurang = Array.isArray(d.kurang); setKurang(d.kurang || []);
    P.hasSubs = Array.isArray(d.subs); setSubs(d.subs || []);
    P.hasLt = Array.isArray(d.lt); setLt(d.lt || []);
    setTimeout(() => { if (state.routeKey === 'po/kalender') renderCal(); else if (state.routeKey === 'po/monitoring' && state.rows.length) render(); }, 0);
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
  // ---------- Pilihan bulan (centang) — sama untuk Rencana, Kebutuhan, Proyeksi ----------
  const MON_KEY = 'ppic-mrp-bulan';
  function selMonths() {
    if (!P.monSel) {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(MON_KEY) || 'null'); } catch (e) { saved = null; }
      const cur = todayStr().slice(0, 7);
      P.monSel = new Set(Array.isArray(saved) && saved.length ? saved : [0, 1, 2].map((i) => addMonth(cur, i)));
    }
    const list = [...P.monSel].filter((b) => P.monthWeeks.has(b)).sort();
    return list.length ? list : [todayStr().slice(0, 7)];
  }
  function setMonths(list) {
    P.monSel = new Set(list);
    try { localStorage.setItem(MON_KEY, JSON.stringify([...P.monSel])); } catch (e) { /* abaikan */ }
  }
  // Bulan yang bisa dipilih: yang ada di PEMBAGIAN_WEEK, 12 bulan ke belakang s.d. 12 bulan ke depan + bulan yang ada rencananya
  function availMonths() {
    const cur = todayStr().slice(0, 7), lo = addMonth(cur, -12), hi = addMonth(cur, 12);
    const set = new Set([...P.monthWeeks.keys()].filter((b) => b >= lo && b <= hi));
    P.plan.forEach((p) => { if (P.monthWeeks.has(p.bulan)) set.add(p.bulan); });
    return [...set].sort();
  }
  function hzWeeks() {
    const out = [];
    selMonths().forEach((b) => (P.monthWeeks.get(b) || []).forEach((w) => out.push(w)));
    return out;
  }
  // Week berurutan dari bulan pertama s.d. bulan terakhir yang dicentang (saldo berjalan Proyeksi Stok)
  function spanWeeks() {
    const m = selMonths(), out = [];
    for (let b = m[0]; b <= m[m.length - 1]; b = addMonth(b, 1)) (P.monthWeeks.get(b) || []).forEach((w) => out.push(w));
    return out;
  }
  const monsText = (list) => {
    const short = (b) => `${monShort(b)} ${b.slice(0, 4)}`;
    const contiguous = list.every((b, i) => !i || addMonth(list[i - 1], 1) === b);
    if (list.length === 1) return short(list[0]);
    if (contiguous) return `${short(list[0])} – ${short(list[list.length - 1])}`;
    return list.length <= 3 ? list.map(short).join(', ') : `${list.length} bulan: ${short(list[0])} … ${short(list[list.length - 1])}`;
  };
  function fillHz(el) {
    const list = selMonths();
    P.hz = list[0];
    el.textContent = monsText(list);
    el.title = 'Bulan yang ditampilkan: ' + list.map(monLabel).join(', ') + '. Klik untuk memilih bulan.';
  }
  function pickMonths() {
    const all = availMonths(), sel = new Set(selMonths()), cur = todayStr().slice(0, 7);
    const years = [...new Set(all.map((b) => b.slice(0, 4)))];
    openDialog({
      title: 'Pilih bulan yang ditampilkan', ok: 'Tampilkan',
      body: `<p class="dlg-lead">Berlaku untuk Rencana Produksi, Kebutuhan Material, dan Proyeksi Stok. Proyeksi Stok tetap menghitung saldo berjalan melewati bulan yang tidak dicentang.</p>
        ${years.map((y) => `<fieldset class="mon-year"><legend>${y}</legend><div class="mon-grid">${all.filter((b) => b.startsWith(y)).map((b) => `<label class="mon-chk${b === cur ? ' is-now' : ''}"><input type="checkbox" name="m" value="${b}"${sel.has(b) ? ' checked' : ''}> ${esc(BULAN_PANJANG[Number(b.slice(5)) - 1])}${b === cur ? ' <small>(bulan ini)</small>' : ''}</label>`).join('')}</div></fieldset>`).join('')}
        <p class="pj-actions"><button type="button" class="btn btn-sm btn-ghost" data-mq="3">Bulan ini + 2 bulan</button><button type="button" class="btn btn-sm btn-ghost" data-mq="1">Bulan ini saja</button><button type="button" class="btn btn-sm btn-ghost" data-mq="0">Kosongkan</button></p>`,
      onSubmit: async () => {
        const list = [...$('dlgBody').querySelectorAll('input[name=m]:checked')].map((x) => x.value);
        if (!list.length) throw new Error('Centang minimal satu bulan.');
        setMonths(list);
        setTimeout(() => renderPlanView(state.routeKey), 0);
        return `${list.length} bulan ditampilkan.`;
      },
    });
    const seq = dlgSeq;
    $('dlgBody').addEventListener('click', (e) => {
      if (seq !== dlgSeq) return;
      const b = e.target.closest('[data-mq]'); if (!b) return;
      const n = Number(b.dataset.mq), want = new Set([0, 1, 2].slice(0, n).map((i) => addMonth(cur, i)));
      $('dlgBody').querySelectorAll('input[name=m]').forEach((x) => { x.checked = want.has(x.value); });
    });
  }
  ['plHz', 'kbHz', 'pjHz'].forEach((id) => { const el = $(id); if (el) el.addEventListener('click', pickMonths); });


  // ---------- BOM yang dipakai ----------
  const refOf = (b) => (b ? b.lbl || b.ref || '?' : '?');   // tampilkan Reference, bukan BOM ID
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
    const skR = P.skus && P.skus.get(code);
    if (skR && skR.rakitan) return needRakitan(code, qty, bom);
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

  // ---------- Produk rakitan: material dipecah sampai ekstrak; hanya baris "Ya digunakan" yang dihitung ----------
  function setPakai(list) { P.pakai = new Set((list || []).map((r) => r[0] + '|' + r[1] + '|' + r[2])); }
  // Daftar material per 1 pcs produk rakitan. sumber = 'RAKITAN' (kemasan langsung) atau kode FG asal.
  function rkLines(code, bom) {
    const b = bom || activeBom(code); if (!b || !b.batch) return [];
    const out = [];
    const push = (src, c, q, fgBom) => {
      const kind = isFg(c.code) ? 'fg' : (MRP.byProduct.has(c.code) ? 'ek' : 'leaf');
      out.push({ src, code: c.code, name: c.name, uom: c.uom, q, kind, fgBom });
    };
    b.comps.forEach((c) => {
      const q1 = (Number(c.qty) || 0) / b.batch;
      if (!q1) return;
      if (isFg(c.code)) {
        const fb = activeBom(c.code);
        if (!fb || !fb.batch) { out.push({ src: c.code, code: c.code, name: c.name, uom: c.uom, q: q1, kind: 'fg', noBom: true }); return; }
        fb.comps.forEach((y) => { const q = (Number(y.qty) || 0) * (q1 / fb.batch); if (q) push(c.code, y, q, fb); });
      } else push('RAKITAN', c, q1);
    });
    return out;
  }
  // PM dobel: kode yang ada di PM tambahan (langsung di BoM rakitan) dan juga di pecahan salah satu FG
  function rkDobel(lines) {
    const pm = new Set(lines.filter((l) => l.src === 'RAKITAN').map((l) => l.code));
    return new Set(lines.filter((l) => l.src !== 'RAKITAN' && pm.has(l.code)).map((l) => l.code));
  }
  function needRakitan(code, pcs, bom) {
    const leaves = new Map(), made = new Map(), fg = new Map();
    const add = (m, c, x) => m.set(c, (m.get(c) || 0) + x);
    const walk = (b, q, path, depth) => {
      const f = b && b.batch ? q / b.batch : 0;
      (b ? b.comps : []).forEach((c) => {
        const x = (Number(c.qty) || 0) * f; if (!x) return;
        if (isFg(c.code)) add(fg, c.code, x);
        else if (MRP.byProduct.has(c.code) && depth < 6 && !path.has(c.code)) { add(made, c.code, x); walk(activeBom(c.code), x, new Set([...path, c.code]), depth + 1); }
        else add(leaves, c.code, x);
      });
    };
    rkLines(code, bom).forEach((l) => {
      if (!P.pakai || !P.pakai.has(code + '|' + l.src + '|' + l.code)) return;
      const x = l.q * pcs;
      if (l.kind === 'fg') add(fg, l.code, x);
      else if (l.kind === 'ek') { add(made, l.code, x); walk(activeBom(l.code), x, new Set([code, l.code]), 1); }
      else add(leaves, l.code, x);
    });
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
  // Catatan Mode Plan: MO yang menggantikan plan & MO dengan BoM beda dari default Parameter SKU
  function pjMoNote(R) {
    const m = R.mo; if (!m) return '';
    const bl = (id, code) => { const b = bomById(code, id); return b ? refOf(b) : id; };
    let t = `<br><b>Mode Plan:</b> SKU-week yang sudah ada MO di Konfirmasi Produksi dihitung dari MO (kg MO × BoM MO), sisanya dari plan.${m.used.length ? ` ${nf.format(m.used.length)} MO dipakai.` : ' Belum ada MO di rentang ini.'}`;
    if (m.diff.length) t += ` <span class="pl-warn-t">⚠ ${nf.format(m.diff.length)} MO memakai BoM beda dengan default Parameter SKU:</span> ${m.diff.slice(0, 8).map((d) => `${esc(d.no)} ${esc(d.code)} (BoM ${esc(bl(d.bom, d.code))}, default ${esc(bl(d.def, d.code))})`).join(' · ')}${m.diff.length > 8 ? ' …' : ''}`;
    if (m.noKg.length) t += ` <span class="pl-bad">${nf.format(m.noKg.length)} MO tanpa konversi kg (tidak dihitung):</span> ${esc(m.noKg.slice(0, 6).join(', '))}`;
    return t;
  }
  function computeReq(weeksArg) {
    const weeks = weeksArg || hzWeeks(), n = weeks.length;
    const idx = new Map(weeks.map((w, i) => [w.bulan + '|' + w.week, i]));
    const req = new Map(), made = new Map(), fgReq = new Map(), noBom = new Set();
    const add = (map, code, i, q, sku) => {
      let o = map.get(code);
      if (!o) { o = { code, w: new Array(n).fill(0), total: 0, src: new Map() }; map.set(code, o); }
      o.w[i] += q; o.total += q;
      if (!o.src.has(sku)) o.src.set(sku, new Array(n).fill(0));
      o.src.get(sku)[i] += q;
    };
    const run = (code, i, qty, bomId) => {
      const r = needOf(code, qty, bomId);
      if (!r) { noBom.add(code); return; }
      r.leaves.forEach((q, c) => add(req, c, i, q, code));
      r.made.forEach((q, c) => add(made, c, i, q, code));
      r.fg.forEach((q, c) => add(fgReq, c, i, q, code));
    };
    // MO di Konfirmasi Produksi menggantikan plan per SKU-week: MO dihitung dengan BoM MO (dari Odoo),
    // sisa plan yang belum ada MO-nya dengan BoM plan/default. MO di week tanpa plan tetap dihitung.
    const kc = konfByCell(), done = new Set();
    const mo = { used: [], diff: [], noKg: [] };
    const runMo = (r, i) => {
      const q = planUnit(r.code) === 'pcs' ? Number(r.qty) || 0 : Number(r.kg) || 0;
      if (!(q > 0)) { mo.noKg.push(r.no); return; }
      const def = activeBom(r.code);
      mo.used.push(r.no);
      if (r.bom && def && r.bom !== def.id) mo.diff.push({ no: r.no, code: r.code, bom: r.bom, def: def.id });
      run(r.code, i, q, r.bom || undefined);
    };
    P.plan.forEach((p) => {
      const i = idx.get(p.bulan + '|' + p.week);
      if (i === undefined) return;
      const key = p.bulan + '|' + p.week + '|' + p.code, k = kc.get(key);
      let rest = p.kg > 0 ? p.kg : 0;
      if (k) { done.add(key); k.list.forEach((r) => runMo(r, i)); rest = Math.max(0, rest - k.q); }
      if (rest > 1e-9) run(p.code, i, rest, p.bom);
    });
    kc.forEach((k, key) => {
      if (done.has(key)) return;
      const i = idx.get(key.split('|').slice(0, 2).join('|'));
      if (i !== undefined) k.list.forEach((r) => runMo(r, i));
    });
    return { weeks, idx, req, made, fg: fgReq, noBom, mo };
  }

  // PC (Products to Consume) & CP (Consumed Products) per MO dari Odoo
  function setCons(arr) {
    P.cons = arr.map((r) => ({ jenis: r[0], mo: r[1], sku: r[2], mat: r[3], name: r[4], qty: Number(r[5]) || 0, uom: r[6], file: r[7], time: r[8] }));
  }
  // Material yang dilewati di Mode PC + CP: ekstrak/bulk (dihitung lewat MO ekstraknya sendiri) dan komponen FG
  const consSkip = (mat) => kfIsEk(mat) || isFg(mat) || (MRP.byProduct.has(mat) && !isFg(mat));
  // PC/CP per material per week; week MO diambil dari Konfirmasi Produksi
  function consByWeek(R, s) {
    const n = R.weeks.length, m = new Map();
    const W = { nokonf: new Set(), noweek: new Set(), outside: new Set(), before: new Set(), skip: new Set() };
    (P.cons || []).forEach((c) => {
      if (!c.mat) return;
      const k = P.konf.get(c.mo);
      if (!k) { W.nokonf.add(c.mo); return; }
      if (!k.week) { W.noweek.add(c.mo); return; }
      if (consSkip(c.mat)) { W.skip.add(c.mat); return; }
      const i = R.idx.get(k.bulan + '|' + k.week);
      if (i === undefined) { W.outside.add(c.mo); return; }
      if (i < s) { W.before.add(c.mo); return; }
      let o = m.get(c.mat);
      if (!o) { o = { pc: new Array(n).fill(0), cp: new Array(n).fill(0), list: [], name: c.name, uom: c.uom }; m.set(c.mat, o); }
      o[c.jenis === 'CP' ? 'cp' : 'pc'][i] += c.qty;
      o.list.push({ i, jenis: c.jenis, mo: c.mo, sku: c.sku, qty: c.qty });
    });
    return { m, W };
  }

  // PO per material (hanya tampilan, tidak menambah saldo): lewat tanggal, per week (mulai week berjalan), belum dijadwalkan
  function poByMat(R) {
    const n = R.weeks.length, today = todayStr(), m = new Map(), W = { outside: 0, kLate: 0, kDone: 0, kOut: 0, matched: new Set() };
    const groups = new Map();
    (state.rows || []).forEach((r) => { const k = r.po + '|' + r.code; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
    const get = (code) => { let o = m.get(code); if (!o) { o = { late: 0, unsched: 0, w: new Array(n).fill(0), inc: new Array(n).fill(0), list: [], kFlags: [] }; m.set(code, o); } return o; };
    // week berjalan (index di rentang); konfirmasi yang week datangnya sudah lewat dipindah ke sini
    const tw = weekOfDate(today); let cw = tw ? R.idx.get(tw.bulan + '|' + tw.week) : undefined;
    if (cw === undefined) cw = R.weeks.findIndex((w) => w.end >= today);
    if (cw < 0) cw = undefined;
    groups.forEach((rs) => {
      const act = rs.filter((r) => !r.cancel && !r.takeout);
      if (!act.length) return;
      const r0 = rs[0], code = r0.code, sched = r0.sched || [];
      const base = { po: r0.po, supplier: r0.supplier, uom: r0.uom, orderDate: r0.date };
      sched.forEach((x) => {
        const kk = r0.po + '|' + code + '|' + x.n;
        let kf = P.incKMap ? P.incKMap.get(kk) : null;
        if (kf) W.matched.add(kk);
        // kedatangan yang sudah dikonfirmasi (konfirmasi utama "sudah datang" + kedatangan berikutnya ke "n#2", "n#3", …)
        const arr = incArrOf(r0.po, code, x.n);
        arr.forEach((a) => {
          W.matched.add(r0.po + '|' + code + '|' + a.ke);
          // sudah datang (Diterima diisi dari konfirmasi): tetap menambah stok sampai stok baru di-upload dengan tanggal ≥ tanggal datang
          const o = get(code), inStock = P.stockDate && P.stockDate >= a.datang;
          let ti; const wd = weekOfDate(a.datang); if (wd) ti = R.idx.get(wd.bulan + '|' + wd.week);
          if (ti === undefined || (cw !== undefined && ti < cw)) ti = cw;
          const rv = Object.assign({ kind: 'recv', date: x.date, datang: a.datang, ke: a.ke, konf: a.qty, inStock }, base);
          if (!inStock && ti !== undefined) { o.inc[ti] += a.qty; rv.incI = ti; }
          o.recv = o.recv || []; o.recv.push(rv);
        });
        const sisa = (Number(x.qty) || 0) - (Number(x.rec) || 0);
        // sudah datang sebagian: sisa jadwal tetap Incoming di tanggal jadwal yang sama (week berjalan bila sudah lewat)
        if (kf && kf.datang) kf = null;
        if (arr.length && !kf && x.status !== 'Done' && sisa > 1e-9) kf = { qty: sisa, note: 'Sisa setelah kedatangan sebagian', bulan: '', week: '', auto: true };
        if (x.status === 'Done' || !(sisa > 1e-9)) { if (kf) { W.kDone++; get(code).kFlags.push(Object.assign({ t: 'Jadwal sudah Done / sudah diterima', date: x.date, ke: x.n, konf: kf.qty }, base)); } return; }
        const o = get(code), it = Object.assign({ date: x.date, qty: Number(x.qty) || 0, rec: Number(x.rec) || 0, sisa, ke: x.n, konf: kf ? kf.qty : 0, kNote: kf ? kf.note : '', kAuto: !!(kf && kf.auto) }, base);
        if (!x.date || x.date < today) { o.late += sisa; it.kind = 'late'; }
        else {
          const w = weekOfDate(x.date), i = w ? R.idx.get(w.bulan + '|' + w.week) : undefined;
          if (i === undefined) { it.kind = 'out'; W.outside++; } else { o.w[i] += sisa; it.kind = 'w'; it.i = i; }
        }
        if (kf) {
          // week datang: pilihan saat konfirmasi, atau week tanggal jadwal; yang sudah lewat → week berjalan
          let ti;
          if (kf.bulan && kf.week) {
            const wk = P.weeks.find((w) => w.bulan === kf.bulan && w.week === kf.week);
            if (wk && wk.end < today) { ti = cw; it.moved = true; } else ti = R.idx.get(kf.bulan + '|' + kf.week);
          } else if (it.kind === 'late') { ti = cw; it.moved = true; }
          else if (it.kind === 'w') ti = it.i;
          if (ti !== undefined && cw !== undefined && ti < cw) { ti = cw; it.moved = true; }
          if (ti === undefined) { W.kOut++; it.kFlag = 'Week datang di luar rentang bulan: tidak dihitung'; }
          else { it.eff = Math.min(kf.qty, sisa); o.inc[ti] += it.eff; it.incI = ti; }
          it.kWeek = kf.week ? `${kf.week} ${monShort(kf.bulan)}` : '';
        }
        o.list.push(it);
      });
      const ord = act.reduce((t, r) => t + (Number(r.qty) || 0), 0), sch = sched.reduce((t, x) => t + (Number(x.qty) || 0), 0);
      if (ord - sch > 1e-9) { const o = get(code); o.unsched += ord - sch; o.list.push(Object.assign({ kind: 'none', date: '', qty: ord, rec: 0, sisa: ord - sch, sch }, base)); }
    });
    // konfirmasi yang jadwalnya tidak ada lagi di data PO (PO cancel / take out / dihapus)
    W.orphan = (P.incK || []).filter((k) => !W.matched.has(k.po + '|' + k.code + '|' + k.ke));
    W.orphan.forEach((k) => get(k.code).kFlags.push({ t: 'PO cancel / jadwal tidak ada lagi di Monitoring PO', po: k.po, ke: k.ke, date: k.tgl, konf: k.qty, supplier: '' }));
    return { m, W };
  }

  // opt.all = true: semua MASTER_MATERIAL ikut (yang tidak dipakai di rentang ini tetap tampil dengan saldo stok + incoming)
  const pjOpt = () => ({ all: !!($('pjMode') && $('pjMode').value === 'master') });
  function computeProj(opt = {}) {
    const R = computeReq(opt.weeks || spanWeeks()), weeks = R.weeks, n = weeks.length;   // saldo berjalan lewat bulan yang tidak dicentang
    let s = 0, stockNote = '';
    if (P.stockDate && n) {
      if (P.stockDate > weeks[n - 1].end) { s = n; stockNote = 'after'; }
      else if (P.stockDate >= weeks[0].start) {
        const w = weekOfDate(P.stockDate);
        s = Math.max(0, weeks.findIndex((x) => x === w));
      } else stockNote = 'before';
    }
    const rows = [], moMode = P.pjCalc === 'mo', C = moMode ? consByWeek(R, s) : null, PO = poByMat(R);
    const codes = new Set(R.req.keys()); if (C) C.m.forEach((v, code) => codes.add(code));
    // Pengurangan manual ADD/FOH/RS per week (tanggal sebelum week stok → masuk week pertama perhitungan)
    const kur = new Map();
    (P.kurang || []).forEach((x) => {
      const w = weekOfDate(x.tgl); let i = w ? R.idx.get(w.bulan + '|' + w.week) : undefined;
      if (i === undefined) { if (x.tgl && R.weeks.length && x.tgl < R.weeks[0].start) i = s; else return; }
      if (i < s) i = s;
      if (!kur.has(x.code)) kur.set(x.code, new Array(n).fill(0));
      kur.get(x.code)[i] += x.qty; codes.add(x.code);
    });
    const used = new Set(codes);
    if (opt.all) { MRP.master.forEach((v, code) => codes.add(code)); PO.m.forEach((v, code) => codes.add(code)); (P.stock || new Map()).forEach((v, code) => codes.add(code)); }
    const zero = new Array(n).fill(0);
    codes.forEach((code) => {
      const q = R.req.get(code) || { w: zero, total: 0, src: new Map() };
      const cs = C ? C.m.get(code) : null;
      const m = MRP.master.get(code) || (cs ? { name: cs.name, uom: cs.uom } : {});
      const st = P.stock.get(code);
      const adj = P.adj.filter((a) => a.code === code && (!P.stockDate || a.date >= P.stockDate)).reduce((t, a) => t + a.qty, 0);
      const awal = (st ? st.qty : 0) + adj, gant = (P.gantung && P.gantung.get(code)) || 0;
      const start = awal - gant;   // Stok Tersedia = Stok Awal − Stok Gantung → dipakai untuk saldo
      const man = null, pin = PO.m.get(code);   // Incoming = jadwal PO yang dikonfirmasi (Konfirmasi incoming)
      const saldo = new Array(n).fill(null), inW = new Array(n).fill(0), outW = kur.get(code) || zero;
      let run = start, firstShort = -1, minS = Infinity;
      for (let i = s; i < n; i++) {
        inW[i] = pin ? pin.inc[i] : 0;
        run += inW[i] - (moMode ? (cs ? cs.pc[i] + cs.cp[i] : 0) : q.w[i]) - outW[i];
        saldo[i] = run;
        if (run < -1e-9 && firstShort < 0) firstShort = i;
        if (run < minS) minS = run;
      }
      rows.push({
        code, name: m.name || code, uom: m.uom || '', kat: m.kat || '', start, awal, gant, hasStock: !!st, adj,
        need: q.w, inW, saldo, firstShort, short: minS < 0 ? -minS : 0, total: q.total, src: q.src, man,
        pc: cs ? cs.pc : zero, cp: cs ? cs.cp : zero, moList: cs ? cs.list : [], po: PO.m.get(code) || null, outW, used: used.has(code),
      });
    });
    return { R, weeks, s, rows, stockNote, moMode, C, PO };
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
    if (state.routeKey === 'pr/pengganti') renderSubs();
    if (state.routeKey === 'prlt/material') renderLtMat();
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
  function queueMonth(cell) {
    P.mqueue.set(`${cell.bulan}|${cell.kode}`, cell);
    paintPlanSave('wait');
    clearTimeout(P.qTimer);
    P.qTimer = setTimeout(flushPlan, 700);
  }
  async function flushPlan() {
    if (P.saving || (!P.queue.size && !P.mqueue.size)) return;
    const cells = [...P.queue.values()], monthCells = [...P.mqueue.values()];
    P.queue.clear(); P.mqueue.clear();
    P.saving = true; paintPlanSave('saving');
    try {
      const res = await mrpApi('savePlan', monthCells.length ? { cells, monthCells } : { cells });
      if (monthCells.length && res.monthSaved === undefined) {
        cells.length = 0;   // plan per week sudah tersimpan
        throw new Error('Plan bulan belum bisa disimpan: Apps Script MRP perlu diperbarui (Code_MRP.gs terbaru → Deploy → Manage deployments → New version).');
      }
      paintPlanSave('ok', savedAt(res));
    } catch (err) {
      cells.forEach((c) => { if (!P.queue.has(`${c.bulan}|${c.week}|${c.kode}`)) P.queue.set(`${c.bulan}|${c.week}|${c.kode}`, c); });
      monthCells.forEach((c) => { if (!P.mqueue.has(`${c.bulan}|${c.kode}`)) P.mqueue.set(`${c.bulan}|${c.kode}`, c); });
      paintPlanSave('err', err.message);
    } finally {
      P.saving = false;
      if ((P.queue.size || P.mqueue.size) && $('plSave').dataset.s !== 'err') flushPlan();
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
    else if (key === 'mrp/konfirmasi') renderKonf();
    else if (key === 'mrp/harian') renderHarian();
    else if (key === 'mrp/kalender') renderKalender();
    else if (key === 'mrp/kebutuhan') renderKebutuhan();
    else if (key === 'mrp/proyeksi') renderProyeksi();
    else if (key === 'mrp/suggest') renderSuggest();
    else if (key === 'mrp/sku') renderSku();
    else if (key === 'mrp/update') renderMrpUpdate();
    else if (key === 'mrp/rakitan') renderRakitan();
  }
  // Header tabel per week yang seragam (seperti Rencana Produksi): baris bulan → baris week + rentang tanggal → baris sub-kolom
  // lead/tail: [{ html, cls, title }] (rowspan 2); subs: [{ label, cls, title }]; cellCls(i): kelas tambahan per week
  function gridHead(weeks, { lead = [], subs, tail = [], cellCls = () => '' }) {
    const months = [];
    weeks.forEach((w) => { const l = months[months.length - 1]; if (l && l.b === w.bulan) l.n++; else months.push({ b: w.bulan, n: 1 }); });
    const n = subs.length, at = (o) => `${o.cls ? ` class="${o.cls}"` : ''}${o.title ? ` title="${esc(o.title)}"` : ''}`;
    return `<tr class="pl-mhead">${lead.map((l, i) => `<th${i === 0 ? ' class="pl-sticky pl-c1"' : ''}></th>`).join('')}${months.map((m) => `<th colspan="${m.n * n}" class="pl-month">${monLabel(m.b)}</th>`).join('')}${tail.length ? `<th colspan="${tail.length}"></th>` : ''}</tr>`
      + `<tr class="pl-whead">${lead.map((l) => `<th rowspan="2"${at(l)}>${l.html}</th>`).join('')}${weeks.map((w, i) => `<th colspan="${n}" class="pl-w pl-wgrp w-start${wCls(weeks, i)}${cellCls(i)}" title="${esc(wTitle(w))}">${w.week}<small>${fmtDate(w.start).slice(0, 6)} – ${fmtDate(w.end).slice(0, 6)}</small></th>`).join('')}${tail.map((t) => `<th rowspan="2"${at(t)}>${t.html}</th>`).join('')}</tr>`
      + `<tr class="pl-shead">${weeks.map((w, i) => subs.map((sb, j) => `<th class="num wsub${n > 1 ? ' wsub-m' : ''}${sb.cls ? ' ' + sb.cls : ''}${j === 0 ? ' w-start' + wCls(weeks, i) : ''}${cellCls(i)}"${sb.title ? ` title="${esc(sb.title)}"` : ''}>${sb.label}</th>`).join('')).join('')}</tr>`;
  }
  const matCell = (code, name, extra = '') => `<td class="pl-sticky pl-c1"><span class="pl-code">${esc(code)}</span>${extra}<span class="pl-name" title="${esc(name)}">${esc(name)}</span></td>`;
  const kpis = (list) => list.map((k) => `<div class="pk${k.tone ? ' is-' + k.tone : ''}"${k.title ? ` title="${esc(k.title)}"` : ''}><span class="pk-num">${k.num}</span><span class="pk-lbl">${k.lbl}</span></div>`).join('');
  const wCls = (weeks, i) => (i === 0 || weeks[i - 1].bulan !== weeks[i].bulan ? ' m-start' : '');

  /* ---------- Rencana Produksi ---------- */
  function planRowsList() {
    const codes = new Set();
    P.skus.forEach((k) => { if (k.jenis !== 'Ekstrak' && k.aktif) codes.add(k.code); });
    const weeks = hzWeeks(), keys = new Set(weeks.map((w) => w.bulan + '|' + w.week));
    P.plan.forEach((p) => { if (keys.has(p.bulan + '|' + p.week) && p.kg > 0) codes.add(p.code); });
    const mons = new Set(weeks.map((w) => w.bulan));
    P.planMon.forEach((o) => { if (mons.has(o.bulan)) codes.add(o.code); });
    return [...codes].sort((a, b) => a.localeCompare(b, 'id', { numeric: true }));
  }
  // Konfirmasi Produksi per SKU-week (MO tersimpan): kg (pcs untuk Banded/KIT) + daftar MO
  function konfByCell() {
    const m = new Map();
    (P.konf || new Map()).forEach((r) => {
      if (!r.week || !r.bulan || kfIsEk(r.code)) return;
      const k = `${r.bulan}|${r.week}|${r.code}`, o = m.get(k) || { q: 0, list: [] };
      o.q += planUnit(r.code) === 'pcs' ? (Number(r.qty) || 0) : (Number(r.kg) || 0);
      o.list.push(r); m.set(k, o);
    });
    return m;
  }
  // Status Plan vs Konfirmasi: sesuai bila selisih ≤ 1% plan
  function konfStatus(plan, kf) {
    if (!(kf > 0)) return plan > 0 ? { cls: 'kf-none', t: 'Belum ada MO' } : null;
    if (!(plan > 0)) return { cls: 'kf-out', t: 'Di luar rencana (tidak ada plan di week ini)' };
    const d = kf - plan;
    if (Math.abs(d) <= plan * 0.01) return { cls: 'kf-match', t: 'Sesuai plan' };
    return d < 0 ? { cls: 'kf-less', t: `Kurang ${fmtKg(-d)} dari plan` } : { cls: 'kf-more', t: `Lebih ${fmtKg(d)} dari plan` };
  }
  // ---- Plan satu bulan: pembanding Σ plan week di bulan yang sama (toleransi 1%) ----
  const sumWeekOf = (b, c) => { let t = 0; P.plan.forEach((p) => { if (p.bulan === b && p.code === c) t += p.kg; }); return t; };
  const sumKonfOf = (b, c, KF) => { let t = 0; (KF || konfByCell()).forEach((o, k) => { const [bb, , cc] = k.split('|'); if (bb === b && cc === c) t += o.q; }); return t; };
  function monStatus(pm, sw) {
    if (!(pm > 0) && !(sw > 0)) return null;
    if (!(pm > 0)) return { cls: 'pm-nomon', ic: '?', t: `Belum ada Plan bulan · Σ week ${fmtKg(sw)}` };
    if (!(sw > 0)) return { cls: 'pm-none', ic: '–', t: 'Belum dibagi ke week' };
    const d = sw - pm;
    if (Math.abs(d) <= pm * 0.01) return { cls: 'pm-match', ic: '✓', t: `Sesuai: Σ week ${fmtKg(sw)}` };
    return d < 0 ? { cls: 'pm-less', ic: '▼', t: `Σ week ${fmtKg(sw)} · kurang ${fmtKg(-d)} dari Plan bulan` } : { cls: 'pm-more', ic: '▲', t: `Σ week ${fmtKg(sw)} · lebih ${fmtKg(d)} dari Plan bulan` };
  }
  function pmCell(c, b, KF) {
    const o = P.planMon.get(`${b}|${c}`), pm = o ? o.qty : 0, sw = sumWeekOf(b, c), kq = sumKonfOf(b, c, KF), st = monStatus(pm, sw);
    const pct = pm > 0 && kq > 0 ? kq / pm : NaN;
    const tip = [st ? st.t : '', kq > 0 ? `Konfirmasi (MO) sebulan ${fmtKg(kq)}${isFinite(pct) ? ` · ${nf.format(Math.round(pct * 100))}% dari Plan bulan` : ''}` : '', o && o.src ? `Sumber: ${o.src}${o.time ? ' · ' + o.time : ''}` : ''].filter(Boolean).join('\n');
    const val = P.edit
      ? `<input class="pl-in pl-min" inputmode="decimal" data-b="${b}" data-c="${esc(c)}" value="${pm || ''}" aria-label="${esc(c)} Plan bulan ${esc(monLabel(b))}">`
      : `<span class="pm-v">${fmtKg(pm) || (sw > 0 ? '<span class="kf-dash">–</span>' : '')}</span>`;
    return `<td class="num pl-pm m-start${st ? ' ' + st.cls : ''}" data-b="${b}" data-c="${esc(c)}"${tip ? ` title="${esc(tip)}"` : ''}>${val}${st ? `<i class="pm-ic" aria-hidden="true">${st.ic}</i>` : ''}${kq > 0 && isFinite(pct) ? `<small>MO ${nf.format(Math.round(pct * 100))}%</small>` : ''}</td>`;
  }
  function renderRencana() {
    fillHz($('plHz'));
    const weeks = hzWeeks();
    const KF = konfByCell(), kfOf = (c, w) => KF.get(`${w.bulan}|${w.week}|${c}`);
    const q = $('plQ').value.trim().toLowerCase(), only = $('plOnly').checked;
    const nameOf = (c) => (P.skus.get(c) || {}).name || ((MRP.master.get(c) || {}).name) || ((MRP.byProduct.get(c) || [])[0] || {}).name || '';
    const allCodes = new Set(planRowsList());
    KF.forEach((o, k) => { const [b, w, c] = k.split('|'); if (weeks.some((x) => x.bulan === b && x.week === w)) allCodes.add(c); });   // MO di luar rencana tetap tampil
    let codes = [...allCodes].sort((a, b) => a.localeCompare(b, 'id', { numeric: true })).filter((c) => !q || (c + ' ' + nameOf(c)).toLowerCase().includes(q));
    const cell = (c, w) => P.plan.get(`${w.bulan}|${w.week}|${c}`);
    if (only) codes = codes.filter((c) => weeks.some((w) => (cell(c, w) || {}).kg > 0 || kfOf(c, w) || P.planMon.has(`${w.bulan}|${c}`)));
    const months = []; weeks.forEach((w) => { const l = months[months.length - 1]; if (l && l.b === w.bulan) l.n++; else months.push({ b: w.bulan, n: 1 }); });
    const mS = (i) => i === 0 || weeks[i - 1].bulan !== weeks[i].bulan;
    $('plHead').innerHTML = `<tr class="pl-mhead"><th class="pl-sticky pl-c1"></th>${months.map((m) => `<th colspan="${m.n * 2 + 1}" class="pl-month">${monLabel(m.b)}</th>`).join('')}<th colspan="2"></th></tr>`
      + `<tr class="pl-whead"><th class="pl-sticky pl-c1" rowspan="2">SKU <small class="pl-thnote">kg; Banded/2in1/KIT dalam pcs · klik untuk BOM per week</small></th>${weeks.map((w, i) => `${mS(i) ? `<th rowspan="2" class="num pl-pmh m-start" title="Plan satu bulan, dibandingkan dengan jumlah plan semua week di ${esc(monLabel(w.bulan))}: ✓ sesuai · ▼ Σ week kurang · ▲ Σ week lebih · – belum dibagi ke week · ? belum ada Plan bulan. MO % = Konfirmasi sebulan dibanding Plan bulan.">Plan bulan<small>vs Σ week</small></th>` : ''}<th colspan="2" class="pl-w pl-wgrp" title="${esc(wTitle(w))}">${w.week}<small>${fmtDate(w.start).slice(0, 6)} – ${fmtDate(w.end).slice(0, 6)}</small></th>`).join('')}<th colspan="2" class="pl-wgrp">Total</th></tr>`
      + `<tr class="pl-shead">${weeks.map(() => `<th class="num pl-sp" title="Rencana dari MPS">Plan</th><th class="num pl-sk" title="Total MO terkonfirmasi (Konfirmasi Produksi) di week ini">Konfirmasi</th>`).join('')}<th class="num pl-sp">Plan</th><th class="num pl-sk">Konfirmasi</th></tr>`;
    const tot = new Array(weeks.length).fill(0), totK = new Array(weeks.length).fill(0);
    let nWarn = 0;
    $('plRows').innerHTML = codes.map((c) => {
      const sku = P.skus.get(c), list = MRP.byProduct.get(c) || [], multi = list.length > 1, pcs = planUnit(c) === 'pcs';
      let rowTot = 0, rowK = 0;
      const tds = weeks.map((w, i) => {
        const p = cell(c, w), kg = p ? p.kg : 0, kf = kfOf(c, w), kq = kf ? kf.q : 0;
        if (!pcs) { tot[i] += kg; totK[i] += kq; }
        rowTot += kg; rowK += kq;
        const st = konfStatus(kg, kq);
        const kTd = `<td class="num pl-kf${st ? ' ' + st.cls : ''}${kf ? ' pl-kfclick' : ''}" data-b="${w.bulan}" data-w="${w.week}" data-c="${esc(c)}"${st ? ` title="${esc(st.t + (kf ? ' · MO: ' + kf.list.map((x) => x.no).join(', ') : ''))}"` : ''}>${kq ? fmtKg(kq) : (kg > 0 ? '<span class="kf-dash">–</span>' : '')}${kf ? `<small>${kf.list.length} MO</small>` : ''}</td>`;
        const warn = !pcs && kg > 0 && sku && !batchOk(kg, sku.batch);
        if (warn) nWarn++;
        const b = kg > 0 ? activeBom(c, p.bom) : null;
        const tip = [b ? `BOM terkunci: ${refOf(b)}` : '', warn ? `${fmtKg(kg)} kg bukan kelipatan/gabungan ukuran batch (${sku.batch.join(', ')} kg)` : ''].filter(Boolean).join('\n');
        const t = tip ? ` title="${esc(tip)}"` : '';
        const tag = b && multi ? `<small class="pl-cbom${sku && b.id !== sku.bom ? ' is-diff' : ''}">${esc(refOf(b))}</small>` : '';
        return (mS(i) ? pmCell(c, w.bulan, KF) : '') + (P.edit
          ? `<td class="num pl-cell${warn ? ' pl-warn' : ''}"${t}><input class="pl-in" inputmode="decimal" data-b="${w.bulan}" data-w="${w.week}" data-c="${esc(c)}" value="${kg || ''}" aria-label="${esc(c)} ${esc(wLabel(w))} ${pcs ? 'pcs' : 'kg'}">${tag}</td>`
          : `<td class="num pl-cell${warn ? ' pl-warn' : ''}"${t}>${fmtKg(kg)}${tag}</td>`) + kTd;
      }).join('');
      const bomTxt = !list.length ? '<span class="pl-bad pl-sub">Tidak ada BOM</span>' : `<span class="pl-sub">BOM default ${esc(refOf((sku && bomById(c, sku.bom)) || list[0]))}${multi ? ` · ${list.length} versi` : ''}</span>`;
      const badges = (pcs ? '<span class="pl-unit" title="Produk rakitan (Banded / 2in1 / KIT): diisi dalam pcs; komponen FG-nya tidak dipecah ke bahan baku">pcs</span>' : '') + (sku ? '' : '<span class="pl-tmp" title="Belum ada di Parameter SKU">baru</span>');
      return `<tr data-code="${esc(c)}"${pcs ? ' class="is-pcs"' : ''}>${matCell(c, nameOf(c), badges).replace('</td>', bomTxt + '</td>').replace('class="pl-sticky pl-c1"', 'class="pl-sticky pl-c1 pl-click" tabindex="0" title="Klik untuk melihat / mengubah BOM per week"')}${tds}<td class="num pl-rowtot"><b>${fmtKg(rowTot)}</b>${pcs && rowTot ? ' <small>pcs</small>' : ''}</td><td class="num pl-kf pl-rowkf"><b>${fmtKg(rowK)}</b>${pcs && rowK ? ' <small>pcs</small>' : ''}</td></tr>`;
    }).join('') || `<tr class="empty"><td colspan="${weeks.length * 2 + months.length + 3}">Tidak ada SKU yang cocok.</td></tr>`;
    paintPlanFoot(tot, totK);
    const nCell = [...P.plan.values()].filter((p) => p.kg > 0 && weeks.some((w) => w.bulan === p.bulan && w.week === p.week)).length;
    const perMon = selMonths().map((b) => { return { b, kg: [...P.plan.values()].filter((p) => p.bulan === b && planUnit(p.code) !== 'pcs').reduce((t, p) => t + p.kg, 0) }; });
    const pcsTot = [...P.plan.values()].filter((p) => planUnit(p.code) === 'pcs' && weeks.some((w) => w.bulan === p.bulan && w.week === p.week)).reduce((t, p) => t + p.kg, 0);
    $('plKpi').innerHTML = kpis(perMon.map((m) => ({ num: m.kg ? fmtKg(m.kg) : '0', lbl: `kg ${monLabel(m.b)}` }))
      .concat(pcsTot ? [{ num: fmtKg(pcsTot), lbl: 'pcs Banded/2in1/KIT (bulan dipilih)' }] : [])
      .concat([{ num: nf.format(nWarn), lbl: 'sel bukan ukuran batch', tone: nWarn ? 'warn' : '', title: 'Kg yang tidak bisa disusun dari ukuran batch SKU (sel kuning). Hanya peringatan.' }]));
    // ringkasan konfirmasi di rentang ini
    let nMatch = 0, nLess = 0, nNone = 0, nOut = 0;
    const seen = new Set([...P.plan.keys()].concat([...KF.keys()]));
    seen.forEach((k) => {
      const [b, w, c] = k.split('|'); if (!weeks.some((x) => x.bulan === b && x.week === w)) return;
      const st = konfStatus((P.plan.get(k) || {}).kg || 0, (KF.get(k) || {}).q || 0); if (!st) return;
      if (st.cls === 'kf-match') nMatch++; else if (st.cls === 'kf-none') nNone++; else if (st.cls === 'kf-out') nOut++; else nLess++;
    });
    const pmSum = months.map((m) => {
      const cs = new Set(); P.planMon.forEach((o) => { if (o.bulan === m.b) cs.add(o.code); }); P.plan.forEach((p) => { if (p.bulan === m.b && p.kg > 0) cs.add(p.code); });
      const n = { 'pm-match': 0, 'pm-less': 0, 'pm-more': 0, 'pm-none': 0, 'pm-nomon': 0 };
      if (!cs.size) return '';
      cs.forEach((c) => { const st = monStatus((P.planMon.get(`${m.b}|${c}`) || {}).qty || 0, sumWeekOf(m.b, c)); if (st) n[st.cls]++; });
      return `<span class="pm-sum"><b>Plan bulan ${esc(monLabel(m.b))}:</b> <span class="kf-chip pm-match">${n['pm-match']} sesuai</span>${n['pm-less'] ? ` <span class="kf-chip pm-less">${n['pm-less']} Σ week kurang</span>` : ''}${n['pm-more'] ? ` <span class="kf-chip pm-more">${n['pm-more']} Σ week lebih</span>` : ''}${n['pm-none'] ? ` <span class="kf-chip pm-none">${n['pm-none']} belum dibagi ke week</span>` : ''}${n['pm-nomon'] ? ` <span class="kf-chip pm-nomon">${n['pm-nomon']} tanpa Plan bulan</span>` : ''}</span>`;
    }).join('');
    $('plInfo').innerHTML = (P.hasPlanMon ? '' : '<span class="pl-bad">Plan bulan belum terbaca: perbarui Apps Script MRP (Code_MRP.gs) lalu Deploy versi baru.</span><br>') + `<span class="pm-sums">${pmSum}</span>` + `${nf.format(codes.length)} SKU ditampilkan · ${nf.format(nCell)} sel berisi rencana · Konfirmasi: <span class="kf-chip kf-match">${nf.format(nMatch)} sesuai</span> <span class="kf-chip kf-less">${nf.format(nLess)} beda qty</span> <span class="kf-chip kf-none">${nf.format(nNone)} belum ada MO</span> <span class="kf-chip kf-out">${nf.format(nOut)} di luar rencana</span>`;
  }
  function paintPlanFoot(tot, totK) {
    const weeks = hzWeeks(), sum = (a) => a.reduce((x, y) => x + y, 0);
    if (!totK) { const KF = konfByCell(); totK = weeks.map((w) => [...KF.entries()].filter(([k]) => k.startsWith(`${w.bulan}|${w.week}|`) && planUnit(k.split('|')[2]) !== 'pcs').reduce((t, [, o]) => t + o.q, 0)); }
    const pmTot = (b) => { let t = 0; P.planMon.forEach((o) => { if (o.bulan === b && planUnit(o.code) !== 'pcs') t += o.qty; }); return t; };
    $('plFoot').innerHTML = `<tr><td class="pl-sticky pl-c1"><b>Total kg</b></td>${tot.map((v, i) => `${i === 0 || weeks[i - 1].bulan !== weeks[i].bulan ? `<td class="num pl-pm m-start"><b>${fmtKg(pmTot(weeks[i].bulan))}</b></td>` : ''}<td class="num"><b>${fmtKg(v)}</b></td><td class="num pl-kf"><b>${fmtKg(totK[i])}</b></td>`).join('')}<td class="num"><b>${fmtKg(sum(tot))}</b></td><td class="num pl-kf"><b>${fmtKg(sum(totK))}</b></td></tr>`;
  }
  // Klik sel Konfirmasi: daftar MO di SKU-week itu
  $('plTable').addEventListener('click', (e) => {
    const td = e.target.closest('td.pl-kfclick'); if (!td) return;
    const k = `${td.dataset.b}|${td.dataset.w}|${td.dataset.c}`, kf = konfByCell().get(k); if (!kf) return;
    const plan = (P.plan.get(k) || {}).kg || 0, st = konfStatus(plan, kf.q), pcs = planUnit(td.dataset.c) === 'pcs', u = pcs ? 'pcs' : 'kg';
    const wk = P.weekBy.get(td.dataset.b + '|' + td.dataset.w);
    openDialog({
      title: `Konfirmasi ${td.dataset.c} · ${wk ? wLabel(wk) + ' ' + wk.bulan.slice(0, 4) : td.dataset.w}`, ok: 'Tutup', cancel: false, onSubmit: null,
      body: `<p class="dlg-lead">Plan <b>${fmtKg(plan) || 0} ${u}</b> · Konfirmasi <b>${fmtKg(kf.q)} ${u}</b> · <span class="kf-chip ${st.cls}">${esc(st.t)}</span></p>
        <div class="table-wrap"><table class="po-table pl-mini"><thead><tr><th>No. MO</th><th class="num">Qty</th><th class="num">Konversi kg</th><th>MO Ekstrak</th></tr></thead><tbody>
        ${kf.list.map((r) => `<tr><td><b>${esc(r.no)}</b></td><td class="num">${fmtQ(r.qty)} ${esc(r.uom)}</td><td class="num">${r.kg !== '' ? fmtKg(r.kg) : '–'}</td><td>${esc(r.moEk || '–')}</td></tr>`).join('')}</tbody></table></div>
        <p class="pj-actions"><a class="btn btn-sm btn-ghost" href="#/mrp/konfirmasi" id="plToKf">Buka Konfirmasi Produksi</a></p>`,
    });
    const a = $('dlgBody').querySelector('#plToKf'); if (a) a.addEventListener('click', () => { $('dlg').close(); $('kfQ').value = td.dataset.c; });
  });
  $('plQ').addEventListener('input', renderRencana);
  $('plOnly').addEventListener('change', renderRencana);
  $('plTable').addEventListener('change', (e) => {
    const inp = e.target.closest('.pl-in'); if (!inp) return;
    const raw = inp.value.trim().replace(/\./g, '').replace(',', '.');
    const kg = raw === '' ? 0 : Number(raw);
    if (isNaN(kg) || kg < 0) { inp.classList.add('is-bad'); toast('Isi qty dengan angka.'); return; }
    inp.classList.remove('is-bad');
    if (inp.classList.contains('pl-min')) {
      const b = inp.dataset.b, c = inp.dataset.c;
      if (kg > 0) P.planMon.set(`${b}|${c}`, { bulan: b, code: c, qty: kg, src: 'Website', time: '' }); else P.planMon.delete(`${b}|${c}`);
      queueMonth({ bulan: b, kode: c, qty: kg || '' });
      refreshPm(inp.closest('tr'), b, c, true);
      paintPlanFoot(hzWeeks().map((x) => [...P.plan.values()].filter((p) => p.bulan === x.bulan && p.week === x.week && planUnit(p.code) !== 'pcs').reduce((t, p) => t + p.kg, 0)));
      return;
    }
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
    paintPlanFoot(tot);
    refreshPm(tr, b, c, false);
    // status konfirmasi di sel sebelahnya
    const kTd = td.nextElementSibling;
    if (kTd && kTd.classList.contains('pl-kf')) {
      const kf = konfByCell().get(k), st = konfStatus(kg, kf ? kf.q : 0);
      kTd.className = `num pl-kf${st ? ' ' + st.cls : ''}${kf ? ' pl-kfclick' : ''}`;
      kTd.title = st ? st.t : '';
      if (!kf) kTd.innerHTML = kg > 0 ? '<span class="kf-dash">–</span>' : '';
    }
  });
  // Perbarui sel Plan bulan satu baris tanpa menggambar ulang tabel (fokus input tetap)
  function refreshPm(tr, b, c, keepInput) {
    const td = tr && tr.querySelector(`td.pl-pm[data-b="${b}"]`); if (!td) return;
    const tmp = document.createElement('tbody'); tmp.innerHTML = `<tr>${pmCell(c, b)}</tr>`;
    const nt = tmp.querySelector('td');
    if (keepInput) { td.className = nt.className; td.title = nt.title; td.querySelectorAll('.pm-ic, small').forEach((x) => x.remove()); [...nt.childNodes].filter((x) => !(x.matches && x.matches('input, .pm-v'))).forEach((x) => td.appendChild(x)); }
    else td.replaceWith(nt);
  }
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
    const opt = (sel) => list.map((b) => `<option value="${esc(b.id)}"${b.id === sel ? ' selected' : ''}>${esc(refOf(b))} · ${b.comps.length} komponen</option>`).join('');
    openDialog({
      title: `BOM per week · ${code}`, ok: canEdit ? 'Simpan' : 'Tutup', cancel: !!canEdit, wide: true,
      body: `<p class="dlg-lead">${esc((sku && sku.name) || ((list[0] || {}).name) || '')}. Setiap week yang ada rencananya mengunci satu versi BOM; versi itu yang dipakai untuk menghitung kebutuhan week tersebut. Rencana baru otomatis memakai BOM default${def ? ` (<b>${esc(refOf(def))}</b>)` : ''} dari Parameter SKU.</p>
        ${!rows.length ? '<p class="muted">Belum ada rencana untuk SKU ini di rentang yang ditampilkan.</p>' : `<div class="table-wrap"><table class="po-table pl-mini"><thead><tr><th>Week</th><th>Tanggal</th><th class="num">Qty ${planUnit(code)}</th><th>BOM terkunci</th></tr></thead><tbody>
        ${rows.map(({ w, p }) => { const b = activeBom(code, p.bom); return `<tr><td><b>${esc(wLabel(w))}</b> ${esc(w.bulan.slice(0, 4))}</td><td>${fmtDate(w.start)} – ${fmtDate(w.end)}</td><td class="num">${fmtKg(p.kg)}</td><td>${canEdit ? `<select class="wb-sel" data-k="${esc(w.bulan + '|' + w.week)}">${opt(b ? b.id : '')}</select>` : `${esc(b ? refOf(b) : '-')}`}${p.bom && !bomById(code, p.bom) ? ' <span class="pl-bad">(BOM terkunci sebelumnya sudah tidak ada)</span>' : ''}</td></tr>`; }).join('')}
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
    const weeks = hzWeeks(), MU = (b) => `${BULAN_PANJANG[Number(b.slice(5)) - 1].toUpperCase()} ${b.slice(0, 4)}`;
    const head = ['KODE', 'NAMA (opsional)'], dates = ['Isi kode SKU mulai baris 3', 'Qty kg (Banded/2in1/KIT: pcs)'];
    weeks.forEach((w, i) => {
      if (i === 0 || weeks[i - 1].bulan !== w.bulan) { head.push(`PLAN ${MU(w.bulan)}`); dates.push('Plan satu bulan'); }
      head.push(`${w.week} ${MU(w.bulan)}`); dates.push(`${fmtDate(w.start).slice(0, 6)} – ${fmtDate(w.end).slice(0, 6)}`);
    });
    const ws = XLSX.utils.aoa_to_sheet([head, dates]);
    ws['!cols'] = [{ wch: 14 }, { wch: 38 }].concat(head.slice(2).map(() => ({ wch: 20 })));
    ws['!freeze'] = { xSplit: 2, ySplit: 2 };
    const info = XLSX.utils.aoa_to_sheet([
      ['Format upload rencana produksi (MRP PPIC GTK)'], [''],
      ['1. Isi kode SKU di kolom A mulai baris 3, qty di kolom week. Kolom NAMA boleh dikosongkan.'],
      ['   Satuan qty: kg untuk produk biasa; pcs untuk produk rakitan (Banded / 2in1 / KIT).'],
      ['2. Baris 1 (mis. "W1 NOVEMBER 2026") adalah kunci kolom; jangan diubah. Baris 2 hanya keterangan tanggal.'],
      ['   Kolom "PLAN NOVEMBER 2026" = plan satu bulan (pembanding jumlah plan week). Boleh dikosongkan/dihapus bila belum ada.'],
      ['3. Upload di website: MRP → Update Data MRP → Upload rencana produksi.'],
      ['4. Bulan yang ada di file mengganti rencana bulan itu; kode yang tidak ada di DATABASE diberi peringatan.'], [''],
      ['Bulan', selMonths().map(monLabel).join(', ')], ['Dibuat', todayStr()],
    ]);
    info['!cols'] = [{ wch: 100 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'PLAN WEEKLY');
    XLSX.utils.book_append_sheet(wb, info, 'PETUNJUK');
    XLSX.writeFile(wb, `Format_Upload_Rencana_${selMonths().map((b) => monShort(b) + b.slice(0, 4)).join('-')}.xlsx`);
  }
  $('plTpl').addEventListener('click', downloadPlanTemplate);
  $('upTpl').addEventListener('click', downloadPlanTemplate);
  $('plExport').addEventListener('click', () => {
    const weeks = hzWeeks();
    const data = planRowsList().map((c) => {
      const o = { KODE: c, NAMA: (P.skus.get(c) || {}).name || '', SATUAN: planUnit(c), BOM: activeBom(c) ? refOf(activeBom(c)) : '' };
      weeks.forEach((w, i) => {
        const MU = `${BULAN_PANJANG[Number(w.bulan.slice(5)) - 1].toUpperCase()} ${w.bulan.slice(0, 4)}`;
        if (i === 0 || weeks[i - 1].bulan !== w.bulan) o[`PLAN ${MU}`] = (P.planMon.get(`${w.bulan}|${c}`) || {}).qty || 0;
        o[`${w.week} ${MU}`] = (P.plan.get(`${w.bulan}|${w.week}|${c}`) || {}).kg || 0;
      });
      return o;
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'PLAN WEEKLY');
    XLSX.writeFile(wb, `Rencana_Produksi_${P.hz}_${todayStr()}.xlsx`);
  });

  /* ---------- Konfirmasi Produksi (LIST_MO Odoo) ---------- */
  const kfIsEk = (code) => normU((MRP.master.get(code) || {}).kat) === 'ekstrak' || (P.skus.get(code) || {}).jenis === 'Ekstrak';
  // Hitung BOM, konversi kg, dan kebutuhan ekstrak untuk 1 MO (BOM default Parameter SKU)
  function kfCalc(code, qty, uom, bomId) {
    const bom = activeBom(code, bomId);
    const o = { bom: bom ? bom.id : '', kg: '', ek: '', ekKg: '', note: '' };
    if (!bom) { o.note = 'Kode tidak punya BOM di DATABASE PPIC'; return o; }
    if (kfIsEk(code)) { o.kg = normU(uom) === 'kg' ? qty : (normU(bom.uom) === 'kg' ? qty : ''); return o; }
    if (planUnit(code) === 'pcs') { o.note = 'Banded/KIT: tidak dikonversi ke kg'; return o; }
    const pcs = normU(uom) !== 'kg';
    o.kg = pcs ? (bom.batch ? Math.round((qty * 1000 / bom.batch) * 100) / 100 : '') : qty;
    const ekComps = bom.comps.filter((c) => MRP.byProduct.has(c.code) && !isFg(c.code));
    if (ekComps.length) {
      const c = ekComps[0];
      o.ek = c.code;
      // qty ekstrak di BOM = per batch BOM (batch dalam pcs untuk SKU)
      o.ekKg = bom.batch ? ((pcs ? qty : (qty / 1000) * bom.batch) / bom.batch) * (Number(c.qty) || 0) : '';   // kebutuhan ekstrak tanpa pembulatan
      if (ekComps.length > 1) o.note = `BOM memakai ${ekComps.length} ekstrak/bulk; yang dihitung ${c.code}`;
    }
    return o;
  }
  const kfRows = () => {
    const m = new Map(P.konf); P.kfDraft.forEach((r, no) => m.set(no, r)); P.kfDel.forEach((no) => m.delete(no));
    return [...m.values()];
  };
  const kfWeeks = () => { const cur = todayStr().slice(0, 7), lo = addMonth(cur, -2), hi = addMonth(cur, 4); return P.weeks.filter((w) => w.bulan >= lo && w.bulan <= hi); };
  // Peringatan per MO SKU (sama dengan file Excel)
  function kfWarn(r, all) {
    if (!r.bom) return { lvl: 'bad', t: r.note || 'Kode tidak punya BOM' };
    if (!r.ek) return r.week ? { lvl: 'ok', t: 'OK' } : { lvl: 'todo', t: 'Pilih Plotting Week' };
    const eks = all.filter((x) => x.code === r.ek);
    if (!r.moEk) return { lvl: 'todo', t: eks.length ? 'Pilih MO ekstrak' : `Belum ada MO ${ekShortK(r.ek)} di daftar` };
    const mo = all.find((x) => x.no === r.moEk);
    if (!mo) return { lvl: 'bad', t: `MO ${r.moEk} tidak ada di daftar` };
    if (mo.code !== r.ek) return { lvl: 'bad', t: `MO ${r.moEk} bukan untuk ${ekShortK(r.ek)}` };
    const cap = Number(mo.kg !== '' ? mo.kg : mo.qty) || 0;
    if ((Number(r.ekKg) || 0) > cap + kfTol(cap)) return { lvl: 'bad', t: `Kebutuhan ${fmtKg(r.ekKg)} kg melebihi hasil MO ${fmtKg(cap)} kg` };
    const tot = all.filter((x) => x.moEk === r.moEk).reduce((t, x) => t + (Number(x.ekKg) || 0), 0);
    if (tot > cap + kfTol(cap)) return { lvl: 'bad', t: `Total pemakaian MO ${r.moEk} (${fmtKg(tot)} kg) melebihi hasilnya (${fmtKg(cap)} kg)` };
    if (!r.week) return { lvl: 'todo', t: 'Pilih Plotting Week' };
    return { lvl: 'ok', t: 'OK' };
  }
  // Usulan pembaruan BoM default Parameter SKU dari MO yang masih berjalan (week berjalan / mendatang / belum dipilih week-nya)
  function kfBomCands() {
    const today = todayStr(), by = new Map();
    kfRows().forEach((r) => {
      const sk = P.skus.get(r.code);
      if (!sk || sk.rakitan || !r.bom || !bomById(r.code, r.bom)) return;
      if (r.week) { const w = P.weekBy.get(r.bulan + '|' + r.week); if (w && w.end < today) return; }
      if (!by.has(r.code)) by.set(r.code, new Map());
      const m = by.get(r.code); if (!m.has(r.bom)) m.set(r.bom, []); m.get(r.bom).push(r.no);
    });
    const out = [];
    by.forEach((m, code) => {
      const def = (activeBom(code) || {}).id || '';
      const ids = [...m.keys()];
      if (ids.length === 1 && ids[0] === def) return;
      out.push({ code, def, opts: ids.map((id) => ({ id, mos: m.get(id) })), conflict: ids.length > 1 });
    });
    return out.sort((a, b) => a.code.localeCompare(b.code, 'id', { numeric: true }));
  }
  function kfBomDialog() {
    const C = kfBomCands();
    if (!C.length) { toast('BoM semua MO sudah sama dengan default Parameter SKU.'); return; }
    const today = todayStr(), wk = weekOfDate(today);
    const bl = (code, id) => esc(refOf(bomById(code, id)));
    openDialog({
      title: 'Perbarui BoM default Parameter SKU', ok: 'Terapkan', wide: true,
      body: `<p class="dlg-lead">BoM dari MO (Odoo) yang beda dengan default di Parameter SKU. Yang dipilih menjadi BoM default baru dan berlaku untuk plan <b>mulai week berjalan${wk ? ` (${esc(wLabel(wk))} ${wk.bulan.slice(0, 4)})` : ''}</b> dan seterusnya; week yang sudah lewat tetap memakai BoM lama.</p>
        ${C.map((c, i) => { const sk = P.skus.get(c.code) || {}; return `<div class="bomup${c.conflict ? ' is-dup' : ''}"><p class="bomup-h"><b>${esc(c.code)}</b> ${esc(sk.name || '')} <span class="muted">· default sekarang <b>${bl(c.code, c.def)}</b></span></p>
          ${c.conflict ? '<p class="bomup-w">⚠ MO SKU ini memakai BoM berbeda-beda — pilih salah satu.</p>' : ''}
          <div class="kfb-opts">${c.opts.map((o) => `<label class="tb-check"><input type="radio" name="b${i}" value="${esc(o.id)}"${!c.conflict && o.id !== c.def ? ' checked' : ''}> BoM <b>${bl(c.code, o.id)}</b>${o.id === c.def ? ' <span class="muted">(default sekarang)</span>' : ''} <span class="muted">· MO ${esc(o.mos.slice(0, 6).join(', '))}${o.mos.length > 6 ? '…' : ''}</span></label>`).join('')}
          ${c.opts.some((o) => o.id === c.def) ? '' : `<label class="tb-check"><input type="radio" name="b${i}" value=""${c.conflict ? ' checked' : ''}> Tetap <b>${bl(c.code, c.def)}</b> <span class="muted">(tidak diubah)</span></label>`}</div></div>`; }).join('')}`,
      onSubmit: async (fd) => {
        const ch = C.map((c, i) => ({ c, to: fd['b' + i] || '' })).filter((x) => x.to && x.to !== x.c.def);
        if (!ch.length) return 'Tidak ada yang diubah.';
        const cells = [];
        for (const { c, to } of ch) {
          const sk = P.skus.get(c.code);
          await saveSkuRow({ kode: c.code, nama: sk.name, jenis: sk.jenis, bom: to, batch: sk.batchText || '', aktif: sk.aktif ? 'Y' : 'N', catatan: sk.note || '' });
          [...P.plan.values()].filter((x) => x.code === c.code && x.kg > 0 && x.bom !== to && (P.weekBy.get(x.bulan + '|' + x.week) || {}).end >= today)
            .forEach((x) => cells.push({ bulan: x.bulan, week: x.week, kode: c.code, kg: x.kg, bom: to }));
        }
        if (cells.length) { await mrpApi('savePlan', { cells }); cells.forEach((x) => { P.plan.get(`${x.bulan}|${x.week}|${x.kode}`).bom = x.bom; }); }
        renderKonf();
        return `${ch.length} SKU memakai BoM baru (${ch.map((x) => `${x.c.code} → ${refOf(bomById(x.c.code, x.to))}`).join(', ')}) · ${cells.length} week plan ikut diperbarui.`;
      },
    });
  }
  // BoM MO ≠ default Parameter SKU → tetap dipakai, diberi tanda
  const kfBomTag = (r, b) => { const d = activeBom(r.code); return d && b && d.id !== b.id ? ` <small class="kf-bomdiff" title="BoM default di Parameter SKU: ${esc(refOf(d))}. Perhitungan memakai BoM MO ini.">≠ default ${esc(refOf(d))}</small>` : ''; };
  const ekShortK = (code) => ((MRP.master.get(code) || {}).name || code);
  /* ---------- Konfirmasi Produksi manual (tanpa No MO): nomor sementara MAN-YYMM-NNN ---------- */
  const isMan = (no) => /^MAN-/i.test(String(no || ''));
  const manTag = (no) => (isMan(no) ? ' <span class="kf-man" title="Input manual, belum ada MO di Odoo">Manual</span>' : '');
  function manNextNo(skip = 0) {
    const d = new Date(), pre = `MAN-${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}-`;
    let max = 0;
    new Set([...P.konf.keys(), ...P.kfDraft.keys()]).forEach((no) => { if (String(no).startsWith(pre)) max = Math.max(max, Number(String(no).slice(pre.length)) || 0); });
    return pre + String(max + 1 + skip).padStart(3, '0');
  }
  const kfCodeList = () => { const codes = new Map(); P.skus.forEach((v, c) => codes.set(c, v.name || '')); MRP.byProduct.forEach((l, c) => { if (!codes.has(c)) codes.set(c, ((MRP.master.get(c) || {}).name) || (l[0] || {}).name || ''); }); return codes; };
  const kfBomOpts = (code, cur) => { const list = MRP.byProduct.get(code) || [], def = activeBom(code); if (!list.length) return '<option value="">(kode tidak punya BOM)</option>';
    return list.map((b) => `<option value="${esc(b.id)}"${b.id === (cur || (def && def.id)) ? ' selected' : ''}>${esc(refOf(b))}${def && b.id === def.id ? ' (default)' : ''}${b.batch ? ` · batch ${fmtQ(b.batch)} ${esc(b.uom || '')}` : ''}</option>`).join(''); };
  const kfWkOpts = (sel) => `<option value="">–</option>` + kfWeeks().map((w) => `<option value="${w.bulan}|${w.week}"${sel === w.bulan + '|' + w.week ? ' selected' : ''}>${esc(wLabel(w))} ${w.bulan.slice(0, 4)} · ${fmtDate(w.start).slice(0, 6)}–${fmtDate(w.end).slice(0, 6)}</option>`).join('');
  function kfManDialog() {
    const codes = kfCodeList(), cur = weekOfDate(todayStr()), curK = cur ? cur.bulan + '|' + cur.week : '';
    const no = manNextNo();
    openDialog({
      title: 'Tambah produksi manual (tanpa No MO)', ok: 'Tambah', wide: true,
      body: `<p class="dlg-lead">Nomor sementara <b>${esc(no)}</b>. Dihitung seperti MO (Proyeksi Stok Mode Plan, Plotting Harian, Kalender, status plan). Hubungkan ke MO Odoo begitu MO-nya terbit.</p>
        <div class="form-grid kf-ed">
          <label class="field"><span>Kode produk *</span><input name="code" list="kfManCodes" required autocomplete="off" placeholder="SKU atau kode ekstrak"></label>
          <label class="field"><span>Nama produk</span><input name="name" readonly></label>
          <div class="field"><span>Hitung dari</span><div class="pj-seg kfm-u" role="radiogroup" aria-label="Satuan input"><label><input type="radio" name="uom" value="Pcs" checked> Pcs</label><label><input type="radio" name="uom" value="Kg"> Kg</label></div></div>
          <label class="field"><span id="kfManQl">Qty (pcs) *</span><input name="qty" inputmode="decimal" required></label>
          <label class="field full"><span>BoM</span><select name="bom"><option value="">(isi kode produk dulu)</option></select></label>
          <label class="field"><span>Plotting Week</span><select name="wk">${kfWkOpts(curK)}</select></label>
          <label class="field"><span>Tanggal produksi (opsional)</span><input type="date" name="tgl"></label>
          <label class="field full"><span>Catatan</span><input name="note" placeholder="mis. menunggu MO dari Odoo"></label>
        </div><datalist id="kfManCodes">${[...codes].map(([c, n]) => `<option value="${esc(c)}">${esc(n)}</option>`).join('')}</datalist>
        <p class="check" id="kfManCalc"></p>
        <div class="kfm-ek" id="kfManEk" hidden></div>`,
      onSubmit: async (fd) => {
        const code = String(fd.code || '').trim(), qty = Number(String(fd.qty || '').replace(',', '.'));
        if (!code || !MRP.byProduct.has(code)) throw new Error('Kode produk wajib diisi dan harus punya BoM di DATABASE.');
        if (!(qty > 0)) throw new Error('Qty harus lebih dari 0.');
        let [bulan, week] = String(fd.wk || '').split('|'); bulan = bulan || ''; week = week || '';
        const tgl = fd.tgl || '';
        if (tgl) { const w = weekOfDate(tgl); if (!w) throw new Error('Tanggal produksi belum ada di PEMBAGIAN_WEEK.'); bulan = w.bulan; week = w.week; }
        const uom = fd.uom || 'Pcs';
        const c = kfCalc(code, qty, uom, fd.bom);
        const name = codes.get(code) || ((MRP.master.get(code) || {}).name) || '';
        const row = { no, code, name, qty, uom, bom: c.bom, kg: c.kg, ek: c.ek, ekKg: c.ekKg, note: [fd.note, c.note].filter(Boolean).join(' · '), bulan, week, tgl, moEk: '' };
        let msg = `${no} ${code} ditambahkan`;
        if (c.ek) {
          const mode = fd.ekmode || 'new';
          if (mode === 'new') {
            const eno = manNextNo(1);
            let [eb, ew] = String(fd.ekwk || '').split('|');
            const ec = kfCalc(c.ek, c.ekKg, 'Kg');
            P.kfDraft.set(eno, { no: eno, code: c.ek, name: ekShortK(c.ek), qty: c.ekKg, uom: 'Kg', bom: ec.bom, kg: c.ekKg, ek: '', ekKg: '', note: `Ekstrak untuk ${no}`, bulan: eb || bulan, week: ew || week, tgl: '', moEk: '' });
            row.moEk = eno; msg += ` + ekstrak manual ${eno} ${c.ek} ${fmtKg(c.ekKg)} kg`;
          } else if (mode === 'pick') row.moEk = fd.ekmo || '';
        }
        P.kfDraft.set(no, row);
        renderKonf();
        return `${msg}. Klik "Simpan perubahan" untuk menyimpan ke Google Sheet.`;
      },
    });
    const body = $('dlgBody'), seq = dlgSeq, f = (n) => body.querySelector(`[name=${n}]`);
    const getU = () => (body.querySelector('[name=uom]:checked') || {}).value || 'Pcs';
    const setU = (u) => { const r = body.querySelector(`[name=uom][value=${u}]`); if (r) r.checked = true; };
    let lastCode = '';
    const calc = () => {
      if (seq !== dlgSeq) return;
      const code = f('code').value.trim(), qty = Number(String(f('qty').value).replace(',', '.')) || 0;
      if (code !== lastCode) {
        lastCode = code;
        f('name').value = codes.get(code) || ((MRP.master.get(code) || {}).name) || '';
        f('bom').innerHTML = MRP.byProduct.has(code) ? kfBomOpts(code, '') : '<option value="">(kode tidak punya BOM)</option>';
        if (MRP.byProduct.has(code)) setU(kfIsEk(code) ? 'Kg' : 'Pcs');
        const pcsOnly = planUnit(code) === 'pcs';
        body.querySelector('[name=uom][value=Kg]').disabled = pcsOnly; body.querySelector('[name=uom][value=Pcs]').disabled = kfIsEk(code);
        if (pcsOnly) setU('Pcs');
      }
      if (f('tgl').value) { const w = weekOfDate(f('tgl').value); if (w) f('wk').value = w.bulan + '|' + w.week; }
      const u = getU(); $('kfManQl').textContent = `Qty (${u.toLowerCase()}) *`;
      const ok = MRP.byProduct.has(code), c = ok ? kfCalc(code, qty, u, f('bom').value) : null;
      // padanan satuan lain: pcs ↔ kg dari batch BoM (batch BoM SKU = pcs per 1.000 kg)
      const b = ok ? activeBom(code, f('bom').value) : null;
      const other = !ok || !qty || kfIsEk(code) || planUnit(code) === 'pcs' || !b || !b.batch ? '' : u === 'Kg' ? `= <b>${fmtQ(Math.ceil(qty * b.batch / 1000 - 1e-9))} pcs</b> <span class="muted">(dibulatkan ke atas)</span>` : `= <b>${fmtKg(c.kg)} kg</b>`;
      $('kfManCalc').innerHTML = !code ? 'Isi kode produk dan qty.' : !ok ? '<span class="pl-bad">Kode tidak punya BoM di DATABASE PPIC.</span>'
        : `${kfIsEk(code) ? '<b>Produksi ekstrak</b> · ' : ''}${qty ? `${fmtQ(qty)} ${u.toLowerCase()} ${other}` : 'Isi qty'}${planUnit(code) === 'pcs' && !kfIsEk(code) ? ' · Banded/KIT dihitung dalam pcs' : ''}${kfIsEk(code) ? '' : c.ek ? ` · ekstrak dibutuhkan <b>${esc(c.ek)} ${esc(ekShortK(c.ek))} ${fmtKg(c.ekKg)} kg</b>` : ' · tidak perlu ekstrak'}`;
      const ekBox = $('kfManEk');
      if (c && c.ek && qty > 0) {
        const prev = { mode: (body.querySelector('[name=ekmode]:checked') || {}).value || 'new', wk: (f('ekwk') || {}).value, mo: (f('ekmo') || {}).value };
        const eks = kfRows().filter((x) => x.code === c.ek);
        ekBox.hidden = false;
        ekBox.innerHTML = `<b>Ekstrak ${esc(c.ek)} · butuh ${fmtKg(c.ekKg)} kg</b>
          <label class="tb-check"><input type="radio" name="ekmode" value="new"${prev.mode === 'new' ? ' checked' : ''}> Buat produksi ekstrak manual ${fmtKg(c.ekKg)} kg (${esc(manNextNo(1))}) di week <select name="ekwk">${kfWkOpts(prev.wk !== undefined ? prev.wk : f('wk').value)}</select></label>
          <label class="tb-check"><input type="radio" name="ekmode" value="pick"${prev.mode === 'pick' ? ' checked' : ''}${eks.length ? '' : ' disabled'}> Pakai MO ekstrak yang ada <select name="ekmo"${eks.length ? '' : ' disabled'}>${eks.map((x) => `<option value="${esc(x.no)}"${x.no === prev.mo ? ' selected' : ''}>${esc(x.no)} · ${fmtKg(x.kg !== '' ? x.kg : x.qty)} kg${x.week ? ' · ' + esc(x.week) + ' ' + monShort(x.bulan) : ''}</option>`).join('') || '<option>(belum ada)</option>'}</select></label>
          <label class="tb-check"><input type="radio" name="ekmode" value="none"${prev.mode === 'none' ? ' checked' : ''}> Nanti saja</label>`;
      } else { ekBox.hidden = true; ekBox.innerHTML = ''; }
    };
    body.addEventListener('input', (e) => { if (!e.target.closest('#kfManEk')) calc(); });
    body.addEventListener('change', (e) => { if (!e.target.closest('#kfManEk')) calc(); });
    calc();
  }
  // Hubungkan baris manual ke MO Odoo: week / tanggal / MO ekstrak dibawa bila MO asli belum punya; baris manual dihapus
  function kfLink(manNo, realNo) {
    const m = kfGet(manNo), r = kfGet(realNo); if (!m || !r) return false;
    const patch = {};
    if (!r.week && m.week) { patch.bulan = m.bulan; patch.week = m.week; if (m.tgl) patch.tgl = m.tgl; }
    else if (!r.tgl && m.tgl && r.bulan === m.bulan && r.week === m.week) patch.tgl = m.tgl;
    if (!r.moEk && m.moEk && r.ek && r.ek === m.ek) patch.moEk = m.moEk;
    if (Object.keys(patch).length) kfTouch(realNo, patch);
    kfRows().filter((x) => x.moEk === manNo).forEach((x) => kfTouch(x.no, { moEk: realNo }));
    if (P.konf.has(manNo)) P.kfDel.add(manNo);
    P.kfDraft.delete(manNo);
    return true;
  }
  const kfLinkCands = (m, pool) => pool.filter((x) => !isMan(x.no) && x.code === m.code)
    .sort((a, b) => ((b.bulan === m.bulan && b.week === m.week) - (a.bulan === m.bulan && a.week === m.week)) || Math.abs((Number(a.qty) || 0) - (Number(m.qty) || 0)) - Math.abs((Number(b.qty) || 0) - (Number(m.qty) || 0)));
  function kfLinkDialog(manNo) {
    const m = kfGet(manNo); if (!m) return;
    const c = kfLinkCands(m, kfRows());
    openDialog({
      title: `Hubungkan ${manNo} ke MO Odoo`, ok: 'Hubungkan',
      body: `<p class="dlg-lead"><b>${esc(m.code)}</b> ${esc(m.name)} · ${fmtQ(m.qty)} ${esc(m.uom)}${m.week ? ` · ${esc(m.week)} ${monShort(m.bulan)}` : ''}${m.tgl ? ` · ${esc(dayLbl(m.tgl))}` : ''}</p>
        ${c.length ? `<label class="field"><span>MO Odoo</span><select name="real">${c.map((x) => `<option value="${esc(x.no)}">${esc(x.no)} · ${fmtQ(x.qty)} ${esc(x.uom)}${x.week ? ' · ' + esc(x.week) + ' ' + monShort(x.bulan) : ' · tanpa week'}${x.bulan === m.bulan && x.week === m.week ? ' (week sama)' : ''}</option>`).join('')}</select></label>
          <p class="hint">Baris manual dihapus. Week, tanggal produksi, dan MO ekstrak dari baris manual dibawa ke MO Odoo bila MO itu belum punya.${kfIsEk(m.code) ? ' MO SKU yang memakai ekstrak manual ini ikut pindah ke MO ekstrak Odoo.' : ''}</p>`
          : `<p class="check err">Belum ada MO Odoo dengan kode ${esc(m.code)}. Upload LIST_MO terbaru dulu.</p>`}`,
      onSubmit: async (fd) => {
        if (!fd.real) throw new Error('Pilih MO Odoo.');
        kfLink(manNo, fd.real); renderKonf();
        return `${manNo} dihubungkan ke MO ${fd.real}. Klik "Simpan perubahan" untuk menyimpan.`;
      },
    });
    if (!c.length) $('dlgOk').disabled = true;
  }
  // Toleransi selisih pembulatan: lebih sedikit dari hasil MO (≤ 1% atau ≤ 1 kg) dianggap aman
  const kfTol = (cap) => Math.max(1, cap * 0.01);
  function renderKonf() {
    const all = kfRows(), edit = P.edit && P.hasKonf;
    const q = $('kfQ').value.trim().toLowerCase(), show = $('kfShow').value;
    const sku = all.filter((r) => !kfIsEk(r.code)), eks = all.filter((r) => kfIsEk(r.code));
    const weeks = kfWeeks();
    const wOpts = (r) => `<option value="">–</option>` + weeks.map((w) => `<option value="${w.bulan}|${w.week}"${r.bulan === w.bulan && r.week === w.week ? ' selected' : ''}>${esc(wLabel(w))} ${w.bulan.slice(0, 4)} · ${fmtDate(w.start).slice(0, 2)}–${fmtDate(w.end).slice(0, 6)}</option>`).join('')
      + (r.week && !weeks.some((w) => w.bulan === r.bulan && w.week === r.week) ? `<option selected value="${r.bulan}|${r.week}">${esc(r.week)} ${esc(monLabel(r.bulan))}</option>` : '');
    const wTxt = (r) => (r.week ? `${r.week} ${monShort(r.bulan)} ${r.bulan.slice(0, 4)}` : '<span class="muted">–</span>');
    // Plan di week yang dipilih vs total MO (termasuk perubahan belum disimpan)
    const kfAt = new Map(); sku.forEach((x) => { if (!x.week) return; const k = `${x.bulan}|${x.week}|${x.code}`; kfAt.set(k, (kfAt.get(k) || 0) + (planUnit(x.code) === 'pcs' ? Number(x.qty) || 0 : Number(x.kg) || 0)); });
    const planTxt = (r) => {
      if (!r.week) return '';
      const k = `${r.bulan}|${r.week}|${r.code}`, plan = (P.plan.get(k) || {}).kg || 0, st = konfStatus(plan, kfAt.get(k) || 0);
      return `<small class="kf-plan"><span class="kf-chip ${st ? st.cls : ''}" title="${esc(st ? st.t : '')}">Plan ${fmtKg(plan) || 0} · MO ${fmtKg(kfAt.get(k) || 0)}</span></small>`;
    };
    const cm = new Map(); (P.cons || []).forEach((c) => { const o = cm.get(c.mo) || {}; o[c.jenis] = true; cm.set(c.mo, o); });
    const consTag = (no) => { const o = cm.get(no); return o ? `<small class="kf-cons">${o.PC ? '<span>PC</span>' : ''}${o.CP ? '<span>CP</span>' : ''}</small>` : ''; };
    { const C = kfBomCands(), nC = C.filter((c) => c.conflict).length;
      $('kfBomNote').hidden = !C.length;
      if (C.length) $('kfBomNote').innerHTML = `⚠ <b>${C.length} SKU</b> memakai BoM di MO yang beda dengan default Parameter SKU${nC ? ` (${nC} di antaranya MO-nya memakai BoM berbeda-beda)` : ''}: ${esc(C.slice(0, 6).map((c) => c.code).join(', '))}${C.length > 6 ? '…' : ''}. <button type="button" class="btn btn-sm" id="kfBomBtn">Tinjau &amp; perbarui Parameter SKU</button>`; }
    let list = sku.map((r) => ({ r, w: kfWarn(r, all) }));
    if (show === 'ek') list = [];
    if (show === 'todo') list = list.filter((x) => x.w.lvl !== 'ok');
    if (q) list = list.filter(({ r }) => (r.no + ' ' + r.code + ' ' + r.name).toLowerCase().includes(q));
    list.sort((a, b) => a.r.no.localeCompare(b.r.no, 'id', { numeric: true }));
    $('kfRows').innerHTML = list.map(({ r, w }) => {
      const b = bomById(r.code, r.bom), dirty = P.kfDraft.has(r.no) ? ' is-dirty' : '';
      const moOpts = `<option value="">–</option>` + eks.filter((x) => x.code === r.ek).map((x) => `<option value="${esc(x.no)}"${x.no === r.moEk ? ' selected' : ''}>${esc(x.no)} · ${fmtKg(x.kg !== '' ? x.kg : x.qty)} kg</option>`).join('')
        + (r.moEk && !eks.some((x) => x.no === r.moEk && x.code === r.ek) ? `<option selected value="${esc(r.moEk)}">${esc(r.moEk)}</option>` : '');
      return `<tr class="kf-row${dirty}" data-no="${esc(r.no)}"><td><b>${esc(r.no)}</b>${manTag(r.no)}${consTag(r.no)}</td><td><span class="pl-code">${esc(r.code)}</span><span class="pl-name" title="${esc(r.name)}">${esc(r.name)}</span></td>
        <td class="num">${fmtQ(r.qty)} <small class="muted">${esc(r.uom)}</small></td><td>${b ? esc(refOf(b)) + kfBomTag(r, b) : (r.bom ? '<span class="pl-bad">versi dihapus</span>' : '<span class="muted">–</span>')}</td>
        <td class="num">${r.kg !== '' ? `<b>${fmtKg(r.kg)}</b>` : '<span class="muted">pcs</span>'}</td>
        <td>${edit ? `<select class="kf-week">${wOpts(r)}</select>` : wTxt(r)}${r.tgl ? `<small class="kf-tgl">Tgl ${esc(dayLbl(r.tgl))}</small>` : ''}${planTxt(r)}</td>
        <td>${r.ek ? `${esc(r.ek)} <span class="muted">${esc(ekShortK(r.ek))}</span>` : '<span class="muted">Tidak perlu</span>'}</td>
        <td class="num">${r.ek ? fmtKg(r.ekKg) : ''}</td>
        <td>${r.ek ? (edit ? `<select class="kf-moek">${moOpts}</select>` : (r.moEk ? `<b>${esc(r.moEk)}</b>` : '<span class="muted">–</span>')) : ''}</td>
        <td><span class="kf-w kf-${w.lvl}">${esc(w.t)}</span>${r.note && r.bom ? `<small class="muted kf-note">${esc(r.note)}</small>` : ''}</td>
        <td class="kf-act">${edit ? `${isMan(r.no) ? '<button type="button" class="btn-link kf-link" title="Ganti baris manual dengan MO dari Odoo">Hubungkan ke MO</button> ' : ''}<button type="button" class="btn-link kf-edit" title="Ubah No MO, produk, qty, BOM">Ubah</button> <button type="button" class="btn-link danger kf-del" title="Hapus MO ini dari daftar">Hapus</button>` : ''}</td></tr>`;
    }).join('') || `<tr class="empty"><td colspan="11">${all.length ? 'Tidak ada MO yang cocok.' : 'Belum ada data. Upload file LIST_MO dari Odoo.'}</td></tr>`;
    // MO ekstrak
    $('kfEkRows').innerHTML = (show === 'sku' ? [] : eks).filter((r) => !q || (r.no + ' ' + r.code + ' ' + r.name).toLowerCase().includes(q)).sort((a, b) => a.no.localeCompare(b.no)).map((r) => {
      const users = sku.filter((x) => x.moEk === r.no), used = users.reduce((t, x) => t + (Number(x.ekKg) || 0), 0), cap = Number(r.kg !== '' ? r.kg : r.qty) || 0, sisa = cap - used;
      const st = !users.length ? '<span class="kf-w kf-todo">Belum dipakai</span>' : sisa < -kfTol(cap) ? `<span class="kf-w kf-bad">Melebihi hasil (kurang ${fmtKg(-sisa)} kg)</span>` : '<span class="kf-w kf-ok">OK</span>';
      return `<tr class="kf-row${P.kfDraft.has(r.no) ? ' is-dirty' : ''}" data-no="${esc(r.no)}"><td><b>${esc(r.no)}</b>${manTag(r.no)}${consTag(r.no)}</td><td>${esc(r.code)} <span class="muted">${esc(r.name)}</span></td><td class="num">${fmtKg(cap)}</td>
        <td>${edit ? `<select class="kf-week">${wOpts(r)}</select>` : wTxt(r)}</td><td class="num">${fmtKg(used) || 0}</td><td class="num${sisa < -kfTol(cap) ? ' pl-bad' : ''}">${fmtKg(sisa) || 0}</td>
        <td>${users.map((x) => `${esc(x.no)} <span class="muted">${esc(x.code)}</span>`).join(', ') || '<span class="muted">–</span>'}</td><td>${st}${edit ? ` ${isMan(r.no) ? '<button type="button" class="btn-link kf-link">Hubungkan ke MO</button> ' : ''}<button type="button" class="btn-link kf-edit">Ubah</button> <button type="button" class="btn-link danger kf-del">Hapus</button>` : ''}</td></tr>`;
    }).join('') || '<tr class="empty"><td colspan="8">Belum ada MO ekstrak.</td></tr>';
    const ws = sku.map((r) => kfWarn(r, all));
    const nBad = ws.filter((w) => w.lvl === 'bad').length, nTodo = ws.filter((w) => w.lvl === 'todo').length;
    const kgTot = sku.reduce((t, r) => t + (Number(r.kg) || 0), 0);
    $('kfKpi').innerHTML = kpis([{ num: nf.format(sku.length), lbl: 'MO SKU' }, { num: nf.format(eks.length), lbl: 'MO ekstrak' }, { num: fmtKg(kgTot) || '0', lbl: 'kg total (konversi)' },
      { num: nf.format(nTodo), lbl: 'perlu dilengkapi', tone: nTodo ? 'warn' : '' }, { num: nf.format(nBad), lbl: 'peringatan', tone: nBad ? 'bad' : 'ok' }]);
    const nDirty = P.kfDraft.size + P.kfDel.size;
    $('kfInfo').innerHTML = `${nf.format(list.length)} MO SKU ditampilkan` + (nDirty ? ` · <b class="pl-warn-t">${nf.format(nDirty)} perubahan belum disimpan</b>` : '')
      + (!P.hasKonf ? ' · <span class="pl-bad">Apps Script MRP perlu diperbarui supaya Konfirmasi Produksi bisa disimpan</span>' : (!P.edit ? ' · masuk mode edit untuk memilih week & MO ekstrak' : ''))
      + (() => { const n = (j) => new Set((P.cons || []).filter((c) => c.jenis === j).map((c) => c.mo)).size; return ` · PC tersimpan ${nf.format(n('PC'))} MO, CP ${nf.format(n('CP'))} MO`; })();
    paintConsNow();
    $('kfSaveBtn').hidden = !(P.edit && P.hasKonf);
    $('kfSaveBtn').disabled = !nDirty;
    $('kfSaveBtn').textContent = nDirty ? `Simpan perubahan (${nDirty})` : 'Simpan perubahan';
  }
  ['kfQ', 'kfShow'].forEach((id) => $(id).addEventListener(id === 'kfQ' ? 'input' : 'change', renderKonf));
  const kfGet = (no) => P.kfDraft.get(no) || P.konf.get(no);
  const kfTouch = (no, patch) => { const r = kfSyncTgl(Object.assign({}, kfGet(no), patch)); P.kfDraft.set(no, r); };
  // Tanggal produksi (Plotting Harian) ↔ Plotting Week saling terhubung:
  // tanggal diisi → week ikut tanggal; week diganti ke week lain → tanggal dikosongkan; week kosong + ada tanggal → week dari tanggal
  function kfSyncTgl(r) {
    if (!r.tgl) return r;
    const w = weekOfDate(r.tgl);
    if (!w) return r;
    if (!r.week) { r.bulan = w.bulan; r.week = w.week; }
    else if (r.bulan !== w.bulan || r.week !== w.week) r.tgl = '';
    return r;
  }
  ['kfRows', 'kfEkRows'].forEach((id) => {
    $(id).addEventListener('change', (e) => {
      const tr = e.target.closest('tr[data-no]'); if (!tr) return;
      const no = tr.dataset.no;
      if (e.target.matches('.kf-week')) { const [bulan, week] = (e.target.value || '|').split('|'); kfTouch(no, { bulan: bulan || '', week: week || '' }); }
      if (e.target.matches('.kf-moek')) kfTouch(no, { moEk: e.target.value });
      renderKonf();
    });
    $(id).addEventListener('click', (e) => {
      const lk = e.target.closest('.kf-link'); if (lk) { kfLinkDialog(lk.closest('tr[data-no]').dataset.no); return; }
      const ed = e.target.closest('.kf-edit'); if (ed) { kfEditDialog(ed.closest('tr[data-no]').dataset.no); return; }
      const b = e.target.closest('.kf-del'); if (!b) return;
      const no = b.closest('tr[data-no]').dataset.no;
      if (P.konf.has(no)) P.kfDel.add(no);
      P.kfDraft.delete(no);
      // MO SKU yang memakai MO ekstrak ini dikosongkan pilihannya
      kfRows().filter((x) => x.moEk === no).forEach((x) => kfTouch(x.no, { moEk: '' }));
      renderKonf();
    });
  });
  // Ubah No MO, produk, qty, UoM, BOM satu MO (masuk draft; tersimpan saat "Simpan perubahan")
  function kfEditDialog(no) {
    const r0 = kfGet(no); if (!r0) return;
    const codes = new Map(); P.skus.forEach((v, c) => codes.set(c, v.name || '')); MRP.byProduct.forEach((l, c) => { if (!codes.has(c)) codes.set(c, ((MRP.master.get(c) || {}).name) || (l[0] || {}).name || ''); });
    const bomOpts = (code, cur) => { const list = MRP.byProduct.get(code) || [], def = activeBom(code); if (!list.length) return '<option value="">(kode tidak punya BOM)</option>';
      return list.map((b) => `<option value="${esc(b.id)}"${b.id === (cur || (def && def.id)) ? ' selected' : ''}>${esc(refOf(b))}${def && b.id === def.id ? ' (default)' : ''}${b.batch ? ` · batch ${fmtQ(b.batch)} ${esc(b.uom || '')}` : ''}</option>`).join(''); };
    openDialog({
      title: `Ubah MO ${no}`, ok: 'Terapkan',
      body: `<div class="form-grid kf-ed">
          <label class="field"><span>No MO *</span><input name="no" value="${esc(r0.no)}" required></label>
          <label class="field"><span>Kode produk *</span><input name="code" value="${esc(r0.code)}" list="kfEdCodes" required autocomplete="off"></label>
          <label class="field full"><span>Nama produk</span><input name="name" value="${esc(r0.name)}" readonly></label>
          <label class="field"><span>Qty *</span><input name="qty" value="${esc(String(r0.qty))}" inputmode="decimal" required></label>
          <label class="field"><span>UoM</span><select name="uom">${['Pcs', 'Kg'].map((u) => `<option${normU(r0.uom) === normU(u) ? ' selected' : ''}>${u}</option>`).join('')}${['pcs', 'kg'].includes(normU(r0.uom)) || !r0.uom ? '' : `<option selected>${esc(r0.uom)}</option>`}</select></label>
          <label class="field full"><span>BOM (Reference)</span><select name="bom">${bomOpts(r0.code, r0.bom)}</select></label>
        </div><datalist id="kfEdCodes">${[...codes].map(([c, n]) => `<option value="${esc(c)}">${esc(n)}</option>`).join('')}</datalist>
        <p class="check" id="kfEdCalc"></p>
        <p class="hint">Konversi kg dan kebutuhan ekstrak dihitung ulang dari BOM yang dipilih. Week tetap; MO ekstrak dikosongkan bila ekstrak berubah. Perubahan baru tersimpan setelah klik <b>Simpan perubahan</b>.</p>`,
      onSubmit: async (fd) => {
        const nno = String(fd.no || '').trim(), code = String(fd.code || '').trim(), qty = Number(String(fd.qty).replace(',', '.'));
        if (!nno || !code) throw new Error('No MO dan kode produk wajib diisi.');
        if (!(qty > 0)) throw new Error('Qty harus lebih dari 0.');
        if (nno !== no && kfRows().some((x) => x.no === nno)) throw new Error(`No MO ${nno} sudah ada di daftar.`);
        const c = kfCalc(code, qty, fd.uom, fd.bom);
        const name = codes.get(code) || ((MRP.master.get(code) || {}).name) || r0.name;
        const row = Object.assign({}, r0, { no: nno, code, name, qty, uom: fd.uom, bom: c.bom, kg: c.kg, ek: c.ek, ekKg: c.ekKg, note: c.note, moEk: c.ek === r0.ek ? r0.moEk : '' });
        if (nno !== no) {
          if (P.konf.has(no)) P.kfDel.add(no);
          P.kfDraft.delete(no); P.kfDel.delete(nno);
          kfRows().filter((x) => x.moEk === no).forEach((x) => kfTouch(x.no, { moEk: nno }));   // MO SKU yang memakai MO ekstrak ini ikut pindah
        }
        P.kfDraft.set(nno, row);
        renderKonf();
        return `MO ${nno} diubah. Klik "Simpan perubahan" untuk menyimpan ke Google Sheet.`;
      },
    });
    const body = $('dlgBody'), seq = dlgSeq;
    const calc = () => {
      if (seq !== dlgSeq) return;
      const f = (n) => body.querySelector(`[name=${n}]`), code = f('code').value.trim(), qty = Number(String(f('qty').value).replace(',', '.')) || 0;
      const c = kfCalc(code, qty, f('uom').value, f('bom').value);
      $('kfEdCalc').innerHTML = !MRP.byProduct.has(code) ? '<span class="pl-bad">Kode tidak punya BOM di DATABASE PPIC.</span>'
        : `Konversi: <b>${c.kg !== '' ? fmtKg(c.kg) + ' kg' : 'tidak dikonversi (pcs)'}</b>${c.ek ? ` · ekstrak ${esc(c.ek)} <b>${fmtKg(c.ekKg)} kg</b>` : ' · tidak perlu ekstrak'}${c.note ? ` · <span class="muted">${esc(c.note)}</span>` : ''}`;
    };
    body.querySelector('[name=code]').addEventListener('input', (e) => {
      const code = e.target.value.trim();
      body.querySelector('[name=name]').value = codes.get(code) || ((MRP.master.get(code) || {}).name) || '';
      body.querySelector('[name=bom]').innerHTML = bomOpts(code, '');
      calc();
    });
    ['qty', 'uom', 'bom'].forEach((n) => body.querySelector(`[name=${n}]`).addEventListener(n === 'qty' ? 'input' : 'change', calc));
    calc();
  }
  const kfSaveDrafts = () => needEdit(async () => {
    const rows = [...P.kfDraft.values()].map((r) => [r.no, r.code, r.name, r.qty, r.uom, r.bom, r.kg, r.bulan || '', r.week || '', r.ek || '', r.ekKg, r.moEk || '', r.note || '', r.tgl || '']);
    const del = [...P.kfDel];
    if (!rows.length && !del.length) return;
    $('kfSaveBtn').disabled = true; paintKf('saving');
    try {
      const res = await mrpApi('saveKonf', { rows, del, file: P.kfFile || '' });
      P.konf = new Map((res.konf || []).map((r) => [r[0], { no: r[0], code: r[1], name: r[2], qty: Number(r[3]) || 0, uom: r[4], bom: r[5], kg: r[6] === '' ? '' : Number(r[6]) || 0,
        bulan: r[7], week: r[8], ek: r[9], ekKg: r[10] === '' ? '' : Number(r[10]) || 0, moEk: r[11], note: r[12], time: r[13], tgl: r[14] || '' }]));
      P.kfDraft.clear(); P.kfDel.clear(); P.kfFile = '';
      paintKf('ok', `${res.added} MO baru, ${res.updated} diubah${res.deleted ? ', ' + res.deleted + ' dihapus' : ''}`);
      toast('Konfirmasi produksi tersimpan.');
    } catch (err) { paintKf('err', err.message); }
    renderKonf(); if (state.routeKey === 'mrp/harian') renderHarian();
  });
  $('kfSaveBtn').addEventListener('click', kfSaveDrafts);
  function paintKf(s, info) {
    const el = $('kfSave'); if (!el) return;
    const el2 = $('phSave'); if (el2) { el2.className = 'pl-save is-' + s; el2.innerHTML = s === 'saving' ? '<span class="spin" aria-hidden="true"></span> Menyimpan ke Google Sheet…' : s === 'ok' ? `Tersimpan: ${esc(info)}` : `Gagal menyimpan: ${esc(info)}`; }
    el.className = 'pl-save is-' + s;
    el.innerHTML = s === 'saving' ? '<span class="spin" aria-hidden="true"></span> Menyimpan ke Google Sheet…' : s === 'ok' ? `Tersimpan: ${esc(info)}` : `Gagal menyimpan: ${esc(info)}`;
  }
  // Upload LIST_MO (Odoo) atau file Konfirmasi Produksi yang sudah diisi
  // Dua gaya export Odoo dikenali: nama tampilan (Reference, Product/Internal Reference, …) dan nama teknis / import-compatible (name, product_id/code, …)
  const KF_NO = /^(reference|name|no\.? ?mo|nomor mo|mo)$/i, KF_PROD = /^(product|produk|product_id)$/i, KF_CODE = /^(kode|kode produk|code|product\/internal reference|product\/default code|product_id\/code|product_id\/default_code)$/i, KF_NAME = /^(nama produk|nama|product\/name|product_id\/name)$/i;
  const KF_BREF = /^(bill of material\/reference|bom reference|bom ref|reference bom|bom_id\/code|bom_id\/reference)$/i;
  const KF_QTY = /^(product quantity|qty|quantity|jumlah|product_qty|quantity to produce)$/i, KF_UOM = /^(product unit of measure(\/unit of measure)?|uom|unit of measure|satuan|product_uom\/name|product_uom_id\/name|product_uom|product_uom_id)$/i, KF_WEEK = /^(plotting week|week)$/i, KF_MOEK = /^(mo ekstrak dipakai|mo ekstrak)$/i, KF_TGL = /^(tanggal|tanggal produksi|tgl|date|scheduled date|date_planned_start|date_start)$/i;
  function parseKonf(wb) {
    for (const sn of wb.SheetNames) {
      const a = sheetRows(wb, sn);
      for (let h = 0; h < Math.min(a.length, 10); h++) {
        const head = a[h].map((x) => txt(x));
        const f = (re) => head.findIndex((x) => re.test(x));
        const iNo = f(KF_NO), iP = f(KF_PROD), iC = f(KF_CODE), iN = f(KF_NAME), iQ = f(KF_QTY), iU = f(KF_UOM), iW = f(KF_WEEK), iM = f(KF_MOEK), iR = f(KF_BREF), iT = f(KF_TGL);
        if (iNo < 0 || iQ < 0 || (iP < 0 && iC < 0)) continue;
        const out = [];
        a.slice(h + 1).forEach((r) => {
          const no = txt(r[iNo]); if (!no) return;
          let code = iC >= 0 ? normCode(r[iC]) : '', name = iN >= 0 ? txt(r[iN]) : '';
          if (!code && iP >= 0) { const p = txt(r[iP]); const m = p.match(/^\[([^\]]+)\]\s*(.*)$/); if (m) { code = m[1].trim(); name = name || m[2]; } else code = p; }
          let bulan = '', week = '';
          if (iW >= 0) { const m = txt(r[iW]).match(/^(W[1-5])\s+([A-Za-z]+)\s+(\d{4})/i); if (m) { const mi = MON_MAP[m[2].toUpperCase()]; if (mi) { week = m[1].toUpperCase(); bulan = `${m[3]}-${String(mi).padStart(2, '0')}`; } } }
          out.push({ no, code, name, qty: Number(String(r[iQ]).replace(',', '.')) || 0, uom: iU >= 0 ? txt(r[iU]) : '', bulan, week, moEk: iM >= 0 ? txt(r[iM]) : '', bref: iR >= 0 ? txt(r[iR]) : null, tgl: iT >= 0 ? mxDate(r[iT]) : '' });
        });
        return { sheet: sn, rows: out, hasRef: iR >= 0, hasTgl: iT >= 0 };
      }
    }
    const h0 = wb.SheetNames.length ? (sheetRows(wb, wb.SheetNames[0])[0] || []).map((x) => txt(x)).filter(Boolean) : [];
    throw new Error(`Kolom tidak dikenali. Butuh kolom No MO (Reference / name), Kode produk (Product/Internal Reference / product_id/code) dan Qty (Product Quantity / product_qty). Kolom di file: ${h0.slice(0, 12).join(', ') || '(kosong)'}.`);
  }
  // Upload PC / CP export Odoo (kolom name, product_id/code, move_lines[2]/product_id/code, …/product_qty, …/uom_id)
  function parseCons(wb) {
    for (const sn of wb.SheetNames) {
      const rows = sheetRows(wb, sn);
      for (let h = 0; h < Math.min(rows.length, 10); h++) {
        const H = rows[h].map((x) => txt(x).toLowerCase());
        const mc = H.findIndex((x) => /^move_lines2?\/product_id\/code$/.test(x));
        const iName = H.indexOf('name');
        if (mc < 0 || iName < 0) continue;
        const pre = H[mc].replace('/product_id/code', '');
        const jenis = pre === 'move_lines2' ? 'CP' : 'PC';
        const iSku = H.indexOf('product_id/code'), iMn = H.indexOf(pre + '/product_id/name'), iQ = H.indexOf(pre + '/product_qty'), iU = H.indexOf(pre + '/product_id/uom_id');
        if (iQ < 0) throw new Error(`Kolom ${pre}/product_qty tidak ditemukan.`);
        const code = (v) => txt(v).replace(/\.0+$/, '');
        const mos = new Map(), out = [];
        let cur = null;
        for (let i = h + 1; i < rows.length; i++) {
          const r = rows[i];
          if (txt(r[iName])) { cur = { mo: code(r[iName]), sku: iSku >= 0 ? code(r[iSku]) : '' }; mos.set(cur.mo, cur.sku); }
          const mat = code(r[mc]);
          if (!cur || !mat) continue;
          out.push([cur.mo, cur.sku, mat, iMn >= 0 ? txt(r[iMn]) : '', Number(r[iQ]) || 0, iU >= 0 ? txt(r[iU]) : '']);
        }
        if (!mos.size) throw new Error('Tidak ada No MO di file.');
        return { jenis, sheet: sn, mos: [...mos.entries()], rows: out };
      }
    }
    throw new Error('Format tidak dikenali. Pakai export Odoo PC (move_lines) atau CP (move_lines2).');
  }
  // Dua kolom upload: PC dan CP (bisa salah satu atau keduanya), disimpan bersamaan
  P.consUp = { PC: null, CP: null };
  function consSummary(p) {
    const noK = p.mos.filter(([mo]) => !P.konf.has(mo)).map(([mo]) => mo);
    const noW = p.mos.filter(([mo]) => P.konf.has(mo) && !P.konf.get(mo).week).map(([mo]) => mo);
    const emp = p.mos.filter(([mo]) => !p.rows.some((r) => r[0] === mo)).map(([mo]) => mo);
    const old = new Set((P.cons || []).filter((c) => c.jenis === p.jenis).map((c) => c.mo));
    const nRep = p.mos.filter(([mo]) => old.has(mo)).length, nSkip = p.rows.filter((r) => consSkip(r[2])).length;
    const cut = (a) => esc(a.slice(0, 8).join(', ')) + (a.length > 8 ? '…' : '');
    return `Terbaca <b>${nf.format(p.mos.length)}</b> MO, <b>${nf.format(p.rows.length)}</b> baris material · ${nf.format(p.mos.length - nRep)} MO baru, ${nf.format(nRep)} MO diganti.`
      + (emp.length ? `<br>${nf.format(emp.length)} MO tanpa baris material (dianggap 0): ${cut(emp)}` : '')
      + (nSkip ? `<br>${nf.format(nSkip)} baris ekstrak/bulk/FG disimpan tapi dilewati di Proyeksi (dihitung lewat MO-nya sendiri).` : '')
      + (noK.length ? `<br><span class="pl-bad">${nf.format(noK.length)} MO belum ada di Konfirmasi Produksi</span> (belum ikut Proyeksi): ${cut(noK)}` : '')
      + (noW.length ? `<br><span class="pl-warn-t">${nf.format(noW.length)} MO belum dipilih week-nya</span>: ${cut(noW)}` : '');
  }
  function paintConsNow() {
    ['PC', 'CP'].forEach((j) => {
      const list = (P.cons || []).filter((c) => c.jenis === j), mos = new Set(list.map((c) => c.mo));
      const last = list.reduce((m, c) => (c.time > m ? c.time : m), '');
      $(j.toLowerCase() + 'Now').textContent = mos.size ? `Tersimpan sekarang: ${nf.format(mos.size)} MO · terakhir ${last}` : 'Belum ada data tersimpan.';
    });
    $('consSend').disabled = !(P.consUp && (P.consUp.PC || P.consUp.CP));
  }
  ['PC', 'CP'].forEach((J) => {
    const k = J.toLowerCase();
    $(k + 'File').addEventListener('change', async () => {
      const f = $(k + 'File').files[0];
      P.consUp[J] = null; $(k + 'Name').textContent = f ? f.name : 'Belum ada file';
      $('consResult').textContent = '';
      if (f) {
        try {
          const p = parseCons(await readBook(f));
          if (p.jenis !== J) throw new Error(`File ini berisi ${p.jenis} (${p.jenis === 'PC' ? 'move_lines' : 'move_lines2'}), bukan ${J}. Pilih di kolom ${p.jenis}.`);
          p.file = f.name; P.consUp[J] = p;
          $(k + 'Check').className = 'check ok'; $(k + 'Check').innerHTML = consSummary(p);
        } catch (err) { $(k + 'Check').className = 'check err'; $(k + 'Check').textContent = err.message; }
      } else { $(k + 'Check').className = 'check'; $(k + 'Check').textContent = ''; }
      paintConsNow();
    });
  });
  $('consSend').addEventListener('click', () => needEdit(async () => {
    if (!P.hasCons) { $('consResult').className = 'send-result err'; $('consResult').textContent = 'Apps Script MRP perlu diperbarui dulu (versi dengan PC/CP).'; return; }
    const todo = ['PC', 'CP'].filter((j) => P.consUp[j]); if (!todo.length) return;
    $('consSend').disabled = true; $('consResult').className = 'send-result'; $('consResult').textContent = 'Mengirim ke Google Sheet…';
    const done = [];
    try {
      for (const j of todo) {
        const p = P.consUp[j];
        const res = await mrpApi('uploadCons', { jenis: j, file: p.file, mos: p.mos, rows: p.rows.map((r) => [r[0], r[1], r[2], r[3], round4(r[4]), r[5]]) });
        setCons(res.cons || []); done.push(`${j} ${nf.format(res.mos)} MO`);
        P.consUp[j] = null; const k = j.toLowerCase();
        $(k + 'File').value = ''; $(k + 'Name').textContent = 'Belum ada file'; $(k + 'Check').className = 'check'; $(k + 'Check').textContent = '';
      }
      $('consResult').className = 'send-result ok';
      $('consResult').textContent = `Tersimpan: ${done.join(', ')}. Lihat di Proyeksi Stok → Mode PC + CP.`;
    } catch (err) {
      $('consResult').className = 'send-result err';
      $('consResult').textContent = (done.length ? `Tersimpan: ${done.join(', ')}. ` : '') + 'Gagal: ' + err.message;
    }
    renderKonf(); paintConsNow();
  }));
  $('kfFile').addEventListener('change', async () => {
    const file = $('kfFile').files[0]; if (!file) return;
    $('kfCheck').className = 'check'; $('kfCheck').textContent = '';
    try {
      if (!MRP.loaded || !P.ready) throw new Error('Data BOM belum termuat. Tunggu sebentar lalu coba lagi.');
      const p = parseKonf(await readBook(file));
      const prop = { file: file.name, sheet: p.sheet, hasRef: p.hasRef, hasTgl: p.hasTgl, items: [], same: 0, held: [], noBom: [], bomDiff: [], missing: [], autoWk: [], links: [] };
      // Kolom Reference BoM (Odoo): BoM MO = versi dengan Reference sama; tidak ada di DATABASE → MO ditahan
      const refKey = (v) => String(v || '').trim().toLowerCase().replace(/^empty ref$/, '');
      const inFile = new Set();
      p.rows.forEach((x) => {
        inFile.add(x.no);
        const old = kfGet(x.no);
        let useBom = old && old.code === x.code ? old.bom : '';
        if (p.hasRef) {
          const m = (MRP.byProduct.get(x.code) || []).filter((b) => refKey(b.ref) === refKey(x.bref));
          if (!m.length) { prop.held.push(x); return; }
          useBom = m[0].id;
          const d = activeBom(x.code); if (d && d.id !== useBom) prop.bomDiff.push(`${x.no} ${x.code} (${refOf(m[0])} ≠ default ${refOf(d)})`);
        }
        const c = kfCalc(x.code, x.qty, x.uom, useBom);
        if (!c.bom) prop.noBom.push(x.code);
        // Tanggal dari file (Odoo) → tanggal produksi + week otomatis; tanpa tanggal → week lama, atau week berjalan (mis. Banded)
        let bulan = '', week = '', tgl = '', auto = false;
        const wt = x.tgl ? weekOfDate(x.tgl) : null;
        if (x.tgl && wt) { tgl = x.tgl; bulan = wt.bulan; week = wt.week; }
        else if (x.week) { bulan = x.bulan; week = x.week; tgl = old && old.tgl ? old.tgl : ''; }
        else if (old && old.week) { bulan = old.bulan; week = old.week; tgl = old.tgl || ''; }
        else { const w = weekOfDate(todayStr()); if (w) { bulan = w.bulan; week = w.week; auto = true; } }
        const row = kfSyncTgl({ no: x.no, code: x.code, name: x.name || (MRP.master.get(x.code) || {}).name || '', qty: x.qty, uom: x.uom, bom: c.bom, kg: c.kg, ek: c.ek, ekKg: c.ekKg, note: c.note,
          bulan, week, tgl, moEk: x.moEk || (old ? old.moEk : '') });
        if (auto) prop.autoWk.push(x.no);
        if (!old) { prop.items.push({ type: 'new', no: x.no, row, on: true, auto }); return; }
        const changes = kfDiff(old, row);
        if (!changes.length) { prop.same++; return; }
        const merged = kfSyncTgl(Object.assign({}, old, row));
        prop.items.push({ type: 'upd', no: x.no, row: merged, old, changes, tglCleared: old.tgl && !merged.tgl ? old.tgl : '', tglOdoo: old.tgl && merged.tgl && x.tgl && old.tgl !== merged.tgl ? old.tgl : '', on: true, auto, restore: P.kfDel.has(x.no) });
      });
      prop.missing = [...P.konf.values()].filter((r) => !isMan(r.no) && !inFile.has(r.no) && !P.kfDel.has(r.no)).map((r) => r.no);
      // Pasangan MO manual (MAN-…) ↔ MO baru di file, dipakai bila memilih "Perbarui jadwal manual"
      prop.pair = kfPairMan(prop);
      P.kfFile = file.name;
      $('kfCheck').className = 'check ok';
      $('kfCheck').innerHTML = `File <b>${esc(file.name)}</b> (sheet ${esc(p.sheet)}): <b>${nf.format(p.rows.length)}</b> MO · ${nf.format(prop.items.filter((i) => i.type === 'new').length)} baru, ${nf.format(prop.items.filter((i) => i.type === 'upd').length)} berubah, ${nf.format(prop.same)} sama${prop.held.length ? `, <span class="pl-bad">${nf.format(prop.held.length)} ditahan</span>` : ''}. `
        + (prop.items.length ? '<b>Periksa perubahan di panel review</b> sebelum disimpan. <button type="button" class="btn-link" data-kfreopen="1">Buka panel review</button>' : 'Tidak ada yang perlu disimpan.');
      P.kfProp = prop;
      if (prop.pair.length) needEdit(() => kfModeDialog(prop));
      else if (prop.items.length || prop.held.length) needEdit(() => kfReview1(prop));
    } catch (err) { $('kfCheck').className = 'check err'; $('kfCheck').textContent = err.message; }
    $('kfFile').value = '';
    renderKonf();
  });
  /* ---------- Pasangkan MO manual (MAN-…) dengan MO Odoo baru di file: kode + tanggal (+ qty), boleh dipecah ---------- */
  function kfPairMan(prop) {
    const cands = prop.items.filter((i) => i.type === 'new').map((i) => i.row);
    const near = (a, b) => Math.abs(a - b) <= Math.max(1, Math.abs(b) * 0.01);
    const used = new Set(), res = new Map();
    const mans = kfRows().filter((r) => isMan(r.no));
    const sku = mans.filter((m) => !kfIsEk(m.code)).sort((a, b) => (a.tgl || '9').localeCompare(b.tgl || '9') || a.no.localeCompare(b.no, 'id', { numeric: true }));
    const pool = (m) => cands.filter((c) => !used.has(c.no) && !kfIsEk(c.code) && c.code === m.code);
    const sameDay = (m, c) => m.tgl && c.tgl === m.tgl, sameWk = (m, c) => m.week && c.bulan === m.bulan && c.week === m.week;
    const flags = (m, arr) => {
      const f = [], q = arr.reduce((t, c) => t + (Number(c.qty) || 0), 0);
      if (arr.length > 1) f.push(`Dipecah jadi ${arr.length} MO (${arr.map((c) => fmtQ(c.qty)).join(' + ')})`);
      if (!near(q, Number(m.qty) || 0)) f.push(`Qty manual ${fmtQ(m.qty)} → Odoo ${fmtQ(q)} ${m.uom || ''}`.trim());
      const d = [...new Set(arr.map((c) => c.tgl).filter(Boolean))];
      if (d.length && (d.length > 1 || d[0] !== m.tgl)) f.push(`Tanggal manual ${m.tgl ? dayLbl(m.tgl) : '–'} → Odoo ${d.map(dayLbl).join(', ')}`);
      return f;
    };
    const take = (m, arr) => { arr.forEach((c) => used.add(c.no)); res.set(m.no, { to: arr.map((c) => c.no), flags: flags(m, arr) }); };
    const subset = (p, q) => { const n = Math.min(p.length, 10); let best = null;
      for (let k = 1; k < (1 << n); k++) { const a = p.filter((_, i) => k & (1 << i)); if (a.length < 2) continue; if (near(a.reduce((t, c) => t + (Number(c.qty) || 0), 0), q) && (!best || a.length < best.length)) best = a; }
      return best; };
    const byQ = (m) => (a, b) => Math.abs(a.qty - m.qty) - Math.abs(b.qty - m.qty);
    sku.forEach((m) => { if (res.has(m.no)) return; const c = pool(m).find((x) => sameDay(m, x) && near(x.qty, m.qty)); if (c) take(m, [c]); });
    sku.forEach((m) => { if (res.has(m.no)) return; const s = subset(pool(m).filter((x) => sameDay(m, x)), Number(m.qty) || 0); if (s) take(m, s); });
    sku.forEach((m) => { if (res.has(m.no)) return; const c = pool(m).filter((x) => sameWk(m, x) && near(x.qty, m.qty)).sort((a, b) => (a.tgl || '').localeCompare(b.tgl || ''))[0]; if (c) take(m, [c]); });
    sku.forEach((m) => { if (res.has(m.no)) return; const s = subset(pool(m).filter((x) => sameWk(m, x)), Number(m.qty) || 0); if (s) take(m, s); });
    sku.forEach((m) => { if (res.has(m.no)) return; const c = pool(m).filter((x) => sameDay(m, x)).sort(byQ(m))[0]; if (c) take(m, [c]); });
    // Ekstrak manual: diganti MO ekstrak Odoo (kode sama, tanggal terdekat) bila semua MO SKU pemakainya ikut diganti
    const ekC = cands.filter((c) => kfIsEk(c.code)), dd = (a, b) => (a && b ? Math.abs(new Date(a) - new Date(b)) : 9e15);
    const ekOut = [];
    mans.filter((m) => kfIsEk(m.code)).forEach((e) => {
      const users = sku.filter((m) => m.moEk === e.no);
      if (!users.length || !users.every((u) => res.has(u.no))) return;
      const c = ekC.filter((x) => x.code === e.code && x.bulan === e.bulan && x.week === e.week).sort((a, b) => dd(a.tgl, e.tgl) - dd(b.tgl, e.tgl))[0];
      if (c) ekOut.push({ e, c });
    });
    const ekSum = new Map(); ekOut.forEach(({ e, c }) => ekSum.set(c.no, (ekSum.get(c.no) || 0) + (Number(e.qty) || 0)));
    ekOut.forEach(({ e, c }) => {
      const f = [], tot = ekSum.get(c.no) || 0, n = ekOut.filter((x) => x.c.no === c.no).length;
      if (n > 1) f.push(`Digabung: ${n} ekstrak manual (${fmtKg(tot)} kg) → ${c.no} ${fmtKg(c.qty)} kg`);
      else if (!near(Number(c.qty) || 0, tot)) f.push(`Kg manual ${fmtKg(tot)} → Odoo ${fmtKg(c.qty)}`);
      if (c.tgl && e.tgl && c.tgl !== e.tgl) f.push(`Tanggal manual ${dayLbl(e.tgl)} → Odoo ${dayLbl(c.tgl)}`);
      res.set(e.no, { to: [c.no], flags: f, ek: true });
    });
    return mans.filter((m) => res.has(m.no) || (!kfIsEk(m.code) && cands.some((c) => c.code === m.code)))
      .map((m) => { const r = res.get(m.no) || { to: [], flags: [] }; const opts = cands.filter((c) => c.code === m.code).map((c) => c.no);
        return { man: m.no, m, ek: kfIsEk(m.code), to: r.to.join(','), sugg: r.to.join(','), flags: r.flags, cands: opts }; })
      .sort((a, b) => (a.ek - b.ek) || a.man.localeCompare(b.man, 'id', { numeric: true }));
  }
  const kfManOf = (prop, no) => { const l = (prop.links || []).find((x) => x.to && x.to.split(',').includes(no)); return l ? `<small class="kf-manof">ganti ${esc(l.man)}</small>` : ''; };
  function kfModeDialog(prop) {
    const nOk = prop.pair.filter((l) => l.sugg).length, nSku = prop.pair.filter((l) => l.sugg && !l.ek).length, nEk = nOk - nSku;
    const nNew = prop.items.filter((i) => i.type === 'new').length;
    openDialog({
      title: 'Upload LIST_MO · pilih jenis upload', ok: 'Lanjut ke review',
      body: `<p class="dlg-lead">File <b>${esc(prop.file)}</b> berisi <b>${nNew}</b> MO baru. <b>${nSku}</b> MO manual${nEk ? ` (+ ${nEk} ekstrak manual)` : ''} punya pasangan MO Odoo di file ini (kode & tanggal sama).</p>
        <label class="kf-mode"><input type="radio" name="mode" value="man" checked><span><b>Perbarui jadwal manual</b><small>MO manual (MAN-…) diganti MO Odoo pasangannya. Qty & tanggal mengikuti Odoo; perbedaan ditandai di review. MO yang tidak punya pasangan tetap ditambahkan sebagai MO baru.</small></span></label>
        <label class="kf-mode"><input type="radio" name="mode" value="new"><span><b>Upload LIST_MO baru</b><small>MO di file ditambahkan / diperbarui saja. MO manual tidak disentuh.</small></span></label>`,
      onSubmit: async (fd) => {
        prop.mode = fd.mode === 'new' ? 'new' : 'man';
        prop.links = prop.mode === 'man' ? prop.pair.map((l) => Object.assign({}, l)) : [];
        setTimeout(() => kfReview1(prop), 0);
        return '';
      },
    });
  }
  /* ---------- Upload LIST_MO: verifikasi 2 langkah (1. review & pilih, 2. konfirmasi & simpan) ---------- */
  const KF_FLD = [['code', 'Kode'], ['qty', 'Qty'], ['uom', 'UoM'], ['bom', 'BoM'], ['kg', 'Konversi kg'], ['wk', 'Plotting Week'], ['tgl', 'Tanggal produksi'], ['moEk', 'MO Ekstrak']];
  const kfWkTxt = (r) => (r.week ? `${r.week} ${monShort(r.bulan)} ${r.bulan.slice(0, 4)}` : '–');
  const kfFv = (r, f) => (f === 'wk' ? kfWkTxt(r) : f === 'bom' ? (r.bom ? (bomById(r.code, r.bom) ? refOf(bomById(r.code, r.bom)) : r.bom) : '–') : f === 'kg' ? (r.kg !== '' && r.kg !== undefined ? fmtKg(r.kg) : '–') : f === 'qty' ? fmtQ(r.qty) : f === 'tgl' ? (r.tgl ? dayLbl(r.tgl) : '–') : String(r[f] ?? '') || '–');
  function kfDiff(o, n) {
    const out = [];
    KF_FLD.forEach(([f, l]) => {
      const a = f === 'wk' ? (o.bulan || '') + '|' + (o.week || '') : String(o[f] ?? ''), b = f === 'wk' ? (n.bulan || '') + '|' + (n.week || '') : String(n[f] ?? '');
      if (f === 'kg' ? Math.abs((Number(o.kg) || 0) - (Number(n.kg) || 0)) > 1e-6 || (o.kg === '') !== (n.kg === '') : a !== b) out.push([l, kfFv(o, f), kfFv(n, f)]);
    });
    return out;
  }
  function kfReview1(prop) {
    const nw = prop.items.filter((i) => i.type === 'new'), up = prop.items.filter((i) => i.type === 'upd');
    const cb = (i) => `<input type="checkbox" data-kfi="${prop.items.indexOf(i)}"${i.on ? ' checked' : ''} aria-label="Pilih ${esc(i.no)}">`;
    const sec = (t, n, body, cls = '', all = '') => `<details class="kfr-sec${cls}" open><summary><b>${t}</b> <span>${n}</span>${all ? ` <span class="kfr-all"><button type="button" class="btn-link" data-kfall="${all}|1">Pilih semua</button> · <button type="button" class="btn-link" data-kfall="${all}|0">Kosongkan</button></span>` : ''}</summary>${body}</details>`;
    openDialog({
      title: `Review upload LIST_MO${prop.mode === 'man' ? ' · perbarui jadwal manual' : prop.mode === 'new' ? ' · LIST_MO baru' : ''} · langkah 1 dari 2`, ok: 'Lanjut ke konfirmasi', wide: true,
      body: `<p class="dlg-lead">File <b>${esc(prop.file)}</b>. Periksa perubahan di bawah, hapus centang yang <b>tidak</b> ingin disimpan. Belum ada yang disimpan sampai langkah 2.</p>
        <div class="kfr-sum">
          <span class="kfr-pill is-new">${nw.length} baru</span><span class="kfr-pill is-upd">${up.length} berubah</span><span class="kfr-pill">${prop.same} sama</span>
          ${prop.held.length ? `<span class="kfr-pill is-bad">${prop.held.length} ditahan</span>` : ''}${prop.missing.length ? `<span class="kfr-pill">${prop.missing.length} tersimpan tapi tidak ada di file</span>` : ''}
        </div>
        ${up.length ? sec('MO berubah', `${up.length} MO · nilai lama → baru`, `<table class="po-table pl-mini kfr-t"><thead><tr><th></th><th>No. MO</th><th>Produk</th><th>Perubahan</th></tr></thead><tbody>
          ${up.map((i) => `<tr><td>${cb(i)}</td><td><b>${esc(i.no)}</b></td><td><span class="pl-code">${esc(i.row.code)}</span><span class="pl-name">${esc(i.row.name)}</span></td>
            <td>${i.changes.map(([l, a, b]) => `<div class="kfr-ch"><span>${esc(l)}</span> <s>${esc(a)}</s> → <b>${esc(b)}</b></div>`).join('')}${i.tglCleared ? `<div class="kfr-warn">⚠ Tanggal produksi ${esc(dayLbl(i.tglCleared))} dikosongkan (week berubah)</div>` : ''}${i.tglOdoo ? `<div class="kfr-warn">⚠ Tanggal di website ${esc(dayLbl(i.tglOdoo))} diganti tanggal Odoo ${esc(dayLbl(i.row.tgl))}</div>` : ''}${i.restore ? '<div class="kfr-warn">MO ini sebelumnya ditandai hapus — akan dikembalikan</div>' : ''}</td></tr>`).join('')}
          </tbody></table>`, '', 'upd') : ''}
        ${nw.length ? sec('MO baru', `${nw.length} MO`, `<table class="po-table pl-mini kfr-t"><thead><tr><th></th><th>No. MO</th><th>Produk</th><th class="num">Qty</th><th>BoM</th><th class="num">Konversi kg</th><th>Plotting Week</th><th>Tanggal</th></tr></thead><tbody>
          ${nw.map((i) => `<tr><td>${cb(i)}</td><td><b>${esc(i.no)}</b>${kfManOf(prop, i.no)}</td><td><span class="pl-code">${esc(i.row.code)}</span><span class="pl-name">${esc(i.row.name)}</span></td><td class="num">${fmtQ(i.row.qty)} ${esc(i.row.uom)}</td><td>${esc(kfFv(i.row, 'bom'))}</td><td class="num">${esc(kfFv(i.row, 'kg'))}</td><td>${esc(kfWkTxt(i.row))}${i.auto ? '<small class="muted"> (tanpa tanggal → week berjalan)</small>' : ''}</td><td>${i.row.tgl ? esc(dayLbl(i.row.tgl)) : '<span class="muted">–</span>'}</td></tr>`).join('')}
          </tbody></table>`, '', 'new') : ''}
        ${prop.links.length ? sec('Ganti MO manual dengan MO Odoo', `${prop.links.filter((l) => l.to).length} dari ${prop.links.length} baris manual dipasangkan`, `<table class="po-table pl-mini kfr-t"><thead><tr><th>Manual</th><th>Produk</th><th>Diganti dengan</th></tr></thead><tbody>
          ${prop.links.map((l, k) => { const opt = (v, t) => `<option value="${esc(v)}"${v === l.to ? ' selected' : ''}>${esc(t)}</option>`;
            const lbl = (no) => { const x = prop.items.find((i) => i.no === no); const r = x ? x.row : kfGet(no); return r ? `${no} · ${fmtQ(r.qty)} ${r.uom}${r.tgl ? ' · ' + dayLbl(r.tgl) : r.week ? ' · ' + r.week + ' ' + monShort(r.bulan) : ''}` : no; };
            const opts = [opt('', 'Biarkan (jangan diganti)')].concat(l.sugg && l.sugg.includes(',') ? [opt(l.sugg, l.sugg.split(',').join(' + ') + ' (dipecah)')] : [], l.cands.map((no) => opt(no, lbl(no))));
            return `<tr${l.ek ? ' class="kfr-ek"' : ''}><td><b>${esc(l.man)}</b>${l.ek ? ' <small class="muted">ekstrak</small>' : ''}<small class="muted"> ${l.ek ? fmtKg(l.m.qty) + ' kg' : fmtQ(l.m.qty) + ' ' + esc(l.m.uom)}${l.m.tgl ? ' · ' + esc(dayLbl(l.m.tgl)) : l.m.week ? ' · ' + esc(l.m.week) + ' ' + monShort(l.m.bulan) : ''}</small></td><td><span class="pl-code">${esc(l.m.code)}</span><span class="pl-name">${esc(l.m.name)}</span></td>
            <td><select data-kfl="${k}">${opts.join('')}</select>${l.to && l.to === l.sugg ? l.flags.map((f) => `<div class="kfr-warn">⚠ ${esc(f)}</div>`).join('') : ''}</td></tr>`; }).join('')}
          </tbody></table><p class="hint">Baris manual yang diganti dihapus. Qty & tanggal mengikuti MO Odoo; MO SKU yang memakai ekstrak manual ikut pindah ke MO ekstrak Odoo.</p>`, ' is-q') : ''}
        ${prop.held.length ? sec('Ditahan — tidak disimpan', `${prop.held.length} MO · Reference BoM belum ada di DATABASE`, `<ul class="kfr-ul">${prop.held.map((x) => `<li><b>${esc(x.no)}</b> ${esc(x.code)} — BoM "${esc(x.bref || '(kosong)')}". Tambahkan lewat Bill of Material → Tambah BoM, lalu upload ulang.</li>`).join('')}</ul>`, ' is-bad') : ''}
        ${prop.bomDiff.length ? sec('BoM beda dengan default Parameter SKU', `${prop.bomDiff.length} MO · tetap dipakai`, `<ul class="kfr-ul">${prop.bomDiff.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`, ' is-warn') : ''}
        ${prop.noBom.length ? sec('Kode tanpa BoM', `${new Set(prop.noBom).size} kode`, `<p class="kfr-p">${esc([...new Set(prop.noBom)].join(', '))}</p>`, ' is-warn') : ''}
        ${prop.missing.length ? sec('Tersimpan tapi tidak ada di file', `${prop.missing.length} MO · tidak dihapus`, `<p class="kfr-p">${esc(prop.missing.slice(0, 80).join(', '))}${prop.missing.length > 80 ? ' …' : ''}</p><p class="hint">Hanya informasi. Hapus manual di tabel bila MO memang sudah tidak berlaku.</p>`) : ''}`,
      onSubmit: async () => {
        const sel = prop.items.filter((i) => i.on);
        if (!sel.length && !prop.links.some((l) => l.to)) throw new Error('Tidak ada MO yang dipilih.');
        setTimeout(() => kfReview2(prop), 0);
        return '';
      },
    });
    const seq = dlgSeq;
    const paintOk = () => { const n = prop.items.filter((i) => i.on).length, nl = prop.links.filter((l) => l.to).length; $('dlgOk').textContent = `Lanjut ke konfirmasi (${n} MO${nl ? ` · ${nl} manual diganti` : ''})`; $('dlgOk').disabled = !n && !nl; };
    $('dlgBody').addEventListener('change', (e) => {
      if (seq !== dlgSeq) return;
      const l = e.target.closest('[data-kfl]'); if (l) { prop.links[Number(l.dataset.kfl)].to = l.value; const t = l.closest('td'); t.querySelectorAll('.kfr-warn').forEach((x) => { x.hidden = l.value !== prop.links[Number(l.dataset.kfl)].sugg; }); paintOk(); return; }
      const c = e.target.closest('[data-kfi]'); if (!c) return; prop.items[Number(c.dataset.kfi)].on = c.checked; paintOk(); });
    $('dlgBody').addEventListener('click', (e) => {
      if (seq !== dlgSeq) return; const b = e.target.closest('[data-kfall]'); if (!b) return; e.preventDefault();
      const [t, v] = b.dataset.kfall.split('|');
      prop.items.forEach((i, k) => { if (i.type === t) { i.on = v === '1'; const c = $('dlgBody').querySelector(`[data-kfi="${k}"]`); if (c) c.checked = i.on; } });
      paintOk();
    });
    paintOk();
  }
  function kfReview2(prop) {
    const sel = prop.items.filter((i) => i.on), nw = sel.filter((i) => i.type === 'new'), up = sel.filter((i) => i.type === 'upd');
    const nTgl = up.filter((i) => i.tglCleared).length, nBom = up.filter((i) => i.changes.some((c) => c[0] === 'BoM')).length, nQty = up.filter((i) => i.changes.some((c) => c[0] === 'Qty')).length, nWk = up.filter((i) => i.changes.some((c) => c[0] === 'Plotting Week')).length;
    openDialog({
      title: 'Konfirmasi simpan · langkah 2 dari 2', ok: `Simpan ke Google Sheet`,
      body: `<p class="dlg-lead">Yang akan disimpan ke KONFIRMASI_PRODUKSI:</p>
        <ul class="kfr-ul kfr-big">
          <li><b>${nw.length}</b> MO baru</li>
          <li><b>${up.length}</b> MO diperbarui${up.length ? ` — qty berubah ${nQty}, BoM berubah ${nBom}, week berubah ${nWk}` : ''}</li>
          ${nTgl ? `<li class="kfr-warn">⚠ <b>${nTgl}</b> MO tanggal produksinya dikosongkan (week berubah) — plot ulang di Plotting Harian</li>` : ''}
          ${prop.links.some((l) => l.to) ? `<li><b>${prop.links.filter((l) => l.to).length}</b> baris manual diganti MO Odoo (baris manual dihapus): ${esc(prop.links.filter((l) => l.to).map((l) => l.man + ' → ' + l.to.split(',').join(' + ')).join(', '))}</li>` : ''}
          ${prop.links.some((l) => l.to && l.to === l.sugg && l.flags.length) ? `<li class="kfr-warn">⚠ <b>${prop.links.filter((l) => l.to && l.to === l.sugg && l.flags.length).length}</b> pasangan qty / tanggalnya berbeda dari manual — mengikuti Odoo</li>` : ''}
          ${sel.some((i) => i.tglOdoo) ? `<li class="kfr-warn">⚠ <b>${sel.filter((i) => i.tglOdoo).length}</b> MO tanggal produksinya diganti tanggal Odoo</li>` : ''}
          ${prop.held.length ? `<li class="pl-bad">${prop.held.length} MO ditahan, tidak ikut disimpan</li>` : ''}
          ${prop.items.length - sel.length ? `<li class="muted">${prop.items.length - sel.length} MO tidak dicentang, tidak disimpan</li>` : ''}
        </ul>
        <p class="hint">Proyeksi Stok, Plotting Harian, dan Kalender Produksi akan memakai data baru ini setelah tersimpan.</p>
        <label class="tb-check kfr-ack"><input type="checkbox" name="ack" id="kfAck"> Saya sudah memeriksa perubahan di langkah 1</label>`,
      onSubmit: async (fd) => {
        if (!fd.ack) throw new Error('Centang dulu "Saya sudah memeriksa perubahan".');
        sel.forEach((i) => { if (i.restore) P.kfDel.delete(i.no); P.kfDraft.set(i.no, i.row); });
        prop.links.filter((l) => l.to).forEach((l) => l.to.split(',').forEach((t) => { if (kfGet(t)) kfLink(l.man, t); }));
        P.kfProp = null;
        setTimeout(() => kfSaveDrafts(), 0);
        return '';
      },
    });
    const seq = dlgSeq;
    $('dlgOk').disabled = true;
    $('dlgBody').addEventListener('change', (e) => { if (seq !== dlgSeq) return; if (e.target.id === 'kfAck') $('dlgOk').disabled = !e.target.checked; });
  }
  $('kfCheck').addEventListener('click', (e) => { if (e.target.closest('[data-kfreopen]') && P.kfProp) needEdit(() => kfReview1(P.kfProp)); });
  $('kfManBtn').addEventListener('click', () => needEdit(kfManDialog));
  /* ---------- Upload manual (Excel: KODE, TONASE, TANGGAL) → baris MAN + ekstrak manual, review 2 langkah ---------- */
  const mxDate = (v) => {
    if (v === '' || v === null || v === undefined) return '';
    if (typeof v === 'number') { const d = new Date(Math.round((v - 25569) * 86400000)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; }
    const t = String(v).trim(); let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
    if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
    return '';
  };
  const mxNum = (v) => { if (typeof v === 'number') return v; let t = String(v || '').trim().replace(/\s/g, ''); if (!t) return 0;
    if (t.includes('.') && t.includes(',')) t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
    else if (t.includes(',')) t = /^\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
    else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
    const x = Number(t); return isFinite(x) ? x : 0; };
  function manTemplate() {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([['KODE', 'TONASE', 'TANGGAL'], ['GNAA002', 1500, '18/11/2026']]);
    ws['!cols'] = [{ wch: 14 }, { wch: 12 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, ws, 'MANUAL');
    const info = [['PETUNJUK'], ['KODE', 'Kode SKU / ekstrak (harus punya BoM di DATABASE PPIC).'], ['TONASE', 'Dalam kg. Dikonversi ke pcs (dibulatkan ke atas), lalu kg dihitung ulang dari pcs (2 desimal). Untuk Banded/2in1/KIT angka ini dibaca sebagai pcs. Untuk kode ekstrak = kg.'],
      ['TANGGAL', 'Wajib. Tanggal produksi (dd/mm/yyyy). Plotting Week ikut tanggal.'], ['Ekstrak', 'SKU yang butuh ekstrak otomatis dibuatkan produksi ekstrak manual dengan tanggal yang sama, sebesar kebutuhan ekstrak (tanpa pembulatan).'], ['Hapus baris contoh sebelum upload.'], [], ['KODE', 'NAMA', 'JENIS', 'BoM DEFAULT', 'BATCH (pcs per 1.000 kg)']];
    [...P.skus.values()].sort((a, b) => a.code.localeCompare(b.code, 'id', { numeric: true })).forEach((s) => { const b = activeBom(s.code); info.push([s.code, s.name || '', s.rakitan ? 'Rakitan (pcs)' : s.jenis || '', b ? refOf(b) : '', b && !kfIsEk(s.code) ? b.batch : '']); });
    const wi = XLSX.utils.aoa_to_sheet(info); wi['!cols'] = [{ wch: 14 }, { wch: 60 }, { wch: 14 }, { wch: 14 }, { wch: 22 }];
    XLSX.utils.book_append_sheet(wb, wi, 'PETUNJUK');
    XLSX.writeFile(wb, 'Format_Konfirmasi_Manual.xlsx');
  }
  function parseManXl(wb) {
    const sn = wb.SheetNames.find((n) => /manual/i.test(n)) || wb.SheetNames[0];
    const a = sheetRows(wb, sn);
    const hi = a.findIndex((r, i) => i < 10 && r.some((x) => /^kode$/i.test(txt(x))) && r.some((x) => /^tonase/i.test(txt(x))));
    if (hi < 0) throw new Error('Kolom KODE, TONASE, TANGGAL tidak ditemukan. Pakai tombol "Format manual" untuk mengunduh format.');
    const h = a[hi].map((x) => txt(x).toLowerCase()), iK = h.findIndex((x) => x === 'kode'), iT = h.findIndex((x) => x.startsWith('tonase')), iD = h.findIndex((x) => x.startsWith('tanggal'));
    const out = [], bad = [];
    const existing = kfRows().filter((r) => isMan(r.no));
    a.slice(hi + 1).forEach((r, k) => {
      const line = hi + k + 2, code = normCode(r[iK]), ton = mxNum(r[iT]), tgl = iD >= 0 ? mxDate(r[iD]) : '';
      if (!code && !ton) return;
      const err = !code ? 'KODE kosong' : !MRP.byProduct.has(code) ? `${code} tidak punya BoM di DATABASE` : !(ton > 0) ? 'TONASE kosong / 0' : !tgl ? 'TANGGAL kosong / tidak terbaca' : !weekOfDate(tgl) ? `Tanggal ${tgl} belum ada di PEMBAGIAN_WEEK` : '';
      if (err) { bad.push({ line, code, t: err }); return; }
      const w = weekOfDate(tgl), name = (P.skus.get(code) || {}).name || (MRP.master.get(code) || {}).name || ((MRP.byProduct.get(code) || [])[0] || {}).name || '';
      let qty, uom, pcs = '', mode;
      if (kfIsEk(code)) { qty = ton; uom = 'Kg'; mode = 'ek'; }
      else if (planUnit(code) === 'pcs') { qty = Math.ceil(ton - 1e-9); uom = 'Pcs'; mode = 'pcs'; }
      else { const b = activeBom(code); if (!b || !b.batch) { bad.push({ line, code, t: 'BoM tanpa batch, tidak bisa dikonversi' }); return; } pcs = Math.ceil(ton * b.batch / 1000 - 1e-9); qty = pcs; uom = 'Pcs'; mode = 'kg'; }
      const c = kfCalc(code, qty, uom);
      const dup = existing.find((x) => x.code === code && x.tgl === tgl && Math.abs((Number(x.qty) || 0) - qty) < 1e-6);
      out.push({ line, code, name, ton, tgl, bulan: w.bulan, week: w.week, qty, uom, mode, c, dup: dup ? dup.no : '', on: !dup });
    });
    return { sheet: sn, rows: out, bad };
  }
  function manReview1(p, file) {
    const tr = (x, i) => `<tr${x.dup ? ' class="kfr-dup"' : ''}><td><input type="checkbox" data-mxi="${i}"${x.on ? ' checked' : ''}></td><td><span class="pl-code">${esc(x.code)}</span><span class="pl-name">${esc(x.name)}</span>${x.dup ? `<div class="kfr-warn">⚠ Mirip ${esc(x.dup)} (kode, tanggal & qty sama)</div>` : ''}</td>
      <td class="num">${x.mode === 'pcs' ? fmtQ(x.ton) + ' <small class="muted">pcs</small>' : fmtQ(x.ton) + ' <small class="muted">kg</small>'}</td>
      <td class="num">${x.mode === 'kg' ? `<b>${fmtQ(x.qty)}</b> pcs` : x.mode === 'pcs' ? `<b>${fmtQ(x.qty)}</b> pcs` : '–'}</td>
      <td class="num">${x.c.kg !== '' ? `<b>${fmtKg(x.c.kg)}</b>` : '<span class="muted">pcs</span>'}</td>
      <td>${esc(dayLbl(x.tgl))} <small class="muted">${esc(x.week)} ${monShort(x.bulan)}</small></td>
      <td>${x.c.ek ? `${esc(ekShortK(x.c.ek))}<div><b>${fmtQ(x.c.ekKg)}</b> kg <small class="muted">manual baru</small></div>` : x.mode === 'ek' ? '<span class="muted">(produksi ekstrak)</span>' : '<span class="muted">–</span>'}</td></tr>`;
    openDialog({
      title: 'Review upload manual · langkah 1 dari 2', ok: 'Lanjut ke konfirmasi', wide: true,
      body: `<p class="dlg-lead">File <b>${esc(file)}</b> (sheet ${esc(p.sheet)}). Tonase → pcs (dibulatkan ke atas) → kg dari pcs (2 desimal). SKU yang butuh ekstrak dibuatkan ekstrak manual di tanggal yang sama. Belum ada yang disimpan.</p>
        <div class="kfr-sum"><span class="kfr-pill is-new">${p.rows.length} baris terbaca</span>${p.rows.filter((x) => x.c.ek).length ? `<span class="kfr-pill">${p.rows.filter((x) => x.c.ek).length} + ekstrak manual</span>` : ''}${p.rows.filter((x) => x.dup).length ? `<span class="kfr-pill is-upd">${p.rows.filter((x) => x.dup).length} mirip yang sudah ada</span>` : ''}${p.bad.length ? `<span class="kfr-pill is-bad">${p.bad.length} ditolak</span>` : ''}</div>
        ${p.rows.length ? `<div class="mx-wrap"><table class="po-table pl-mini kfr-t"><thead><tr><th></th><th>Produk</th><th class="num">Tonase</th><th class="num">Pcs</th><th class="num">Konversi kg</th><th>Tanggal</th><th>Ekstrak</th></tr></thead><tbody>${p.rows.map(tr).join('')}</tbody></table></div>` : ''}
        ${p.bad.length ? `<details class="kfr-sec is-bad" open><summary><b>Ditolak — tidak disimpan</b> <span>${p.bad.length} baris</span></summary><ul class="kfr-ul">${p.bad.map((b) => `<li>Baris ${b.line}${b.code ? ' · ' + esc(b.code) : ''}: ${esc(b.t)}</li>`).join('')}</ul></details>` : ''}`,
      onSubmit: async () => { const sel = p.rows.filter((x) => x.on); if (!sel.length) throw new Error('Tidak ada baris yang dipilih.'); setTimeout(() => manReview2(p, file), 0); return ''; },
    });
    const seq = dlgSeq, paint = () => { const n = p.rows.filter((x) => x.on).length; $('dlgOk').textContent = `Lanjut ke konfirmasi (${n})`; $('dlgOk').disabled = !n; };
    $('dlgBody').addEventListener('change', (e) => { if (seq !== dlgSeq) return; const c = e.target.closest('[data-mxi]'); if (c) { p.rows[Number(c.dataset.mxi)].on = c.checked; paint(); } });
    paint();
  }
  function manReview2(p, file) {
    const sel = p.rows.filter((x) => x.on), nEk = sel.filter((x) => x.c.ek).length;
    const kg = sel.reduce((t, x) => t + (Number(x.c.kg) || 0), 0);
    openDialog({
      title: 'Konfirmasi simpan · langkah 2 dari 2', ok: 'Simpan ke Google Sheet',
      body: `<ul class="kfr-ul kfr-big"><li><b>${sel.length}</b> baris produksi manual (total ${fmtKg(kg)} kg)</li>${nEk ? `<li><b>${nEk}</b> produksi ekstrak manual dibuat otomatis, tanggal sama dengan SKU-nya</li>` : ''}${p.rows.length - sel.length ? `<li class="muted">${p.rows.length - sel.length} baris tidak dicentang</li>` : ''}${p.bad.length ? `<li class="pl-bad">${p.bad.length} baris ditolak</li>` : ''}</ul>
        <p class="hint">Nomor MAN-… dibuat berurutan. Baris manual ikut dihitung di Proyeksi Stok (Mode Plan), Plotting Harian, Kalender, dan status plan.</p>
        <label class="tb-check kfr-ack"><input type="checkbox" name="ack" id="mxAck"> Saya sudah memeriksa hasil konversi di langkah 1</label>`,
      onSubmit: async (fd) => {
        if (!fd.ack) throw new Error('Centang dulu "Saya sudah memeriksa".');
        sel.forEach((x) => {
          const no = manNextNo();
          P.kfDraft.set(no, { no });
          const row = { no, code: x.code, name: x.name, qty: x.qty, uom: x.uom, bom: x.c.bom, kg: x.c.kg, ek: x.c.ek, ekKg: x.c.ekKg, note: [`Upload manual ${file}`, x.c.note].filter(Boolean).join(' · '), bulan: x.bulan, week: x.week, tgl: x.tgl, moEk: '' };
          if (x.c.ek) {
            const eno = manNextNo(), ec = kfCalc(x.c.ek, x.c.ekKg, 'Kg');
            P.kfDraft.set(eno, { no: eno, code: x.c.ek, name: ekShortK(x.c.ek), qty: x.c.ekKg, uom: 'Kg', bom: ec.bom, kg: x.c.ekKg, ek: '', ekKg: '', note: `Ekstrak untuk ${no}`, bulan: x.bulan, week: x.week, tgl: x.tgl, moEk: '' });
            row.moEk = eno;
          }
          P.kfDraft.set(no, row);
        });
        P.kfFile = file;
        setTimeout(() => kfSaveDrafts(), 0);
        return '';
      },
    });
    const seq = dlgSeq; $('dlgOk').disabled = true;
    $('dlgBody').addEventListener('change', (e) => { if (seq !== dlgSeq) return; if (e.target.id === 'mxAck') $('dlgOk').disabled = !e.target.checked; });
  }
  $('kfManTpl').addEventListener('click', manTemplate);
  $('kfManFile').addEventListener('change', async () => {
    const f = $('kfManFile').files[0]; if (!f) return;
    try {
      const p = parseManXl(await readBook(f));
      $('kfCheck').className = 'check ok';
      $('kfCheck').innerHTML = `Upload manual <b>${esc(f.name)}</b>: ${p.rows.length} baris terbaca${p.bad.length ? `, <span class="pl-bad">${p.bad.length} ditolak</span>` : ''}. Periksa di panel review sebelum disimpan.`;
      if (p.rows.length || p.bad.length) needEdit(() => manReview1(p, f.name));
    } catch (err) { $('kfCheck').className = 'check err'; $('kfCheck').textContent = err.message; }
    $('kfManFile').value = '';
  });

  $('kfBomNote').addEventListener('click', (e) => { if (e.target.closest('#kfBomBtn')) needEdit(kfBomDialog); });
  $('kfExport').addEventListener('click', () => {
    const all = kfRows();
    const data = all.sort((a, b) => kfIsEk(a.code) - kfIsEk(b.code) || a.no.localeCompare(b.no, 'id', { numeric: true })).map((r) => {
      const b = bomById(r.code, r.bom), w = kfIsEk(r.code) ? null : kfWarn(r, all);
      return { 'No. MO': r.no, Kode: r.code, 'Nama Produk': r.name, Qty: r.qty, UoM: r.uom, 'BOM (Reference)': b ? refOf(b) : '', 'Konversi kg': r.kg, 'Plotting Week': r.week ? `${r.week} ${monShort(r.bulan)} ${r.bulan.slice(0, 4)}` : '',
        'Kode Ekstrak': r.ek || '', 'Kebutuhan Ekstrak (kg)': r.ek ? r.ekKg : '', 'MO Ekstrak dipakai': r.moEk || '', Peringatan: w ? w.t : (kfIsEk(r.code) ? 'MO ekstrak' : '') };
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'KONFIRMASI PRODUKSI');
    XLSX.writeFile(wb, `Konfirmasi_Produksi_${todayStr()}.xlsx`);
  });

  /* ---------- Kebutuhan Material ---------- */
  function renderKebutuhan() {
    fillHz($('kbHz'));
    const now = $('kbBasis').value === 'now';
    $('kbHz').hidden = now; $('kbType').disabled = now; if (now) $('kbType').value = 'buy';
    let R;
    if (now) {
      const B = stkBase(), req = new Map();
      B.M.forEach((o, code) => { if (isFg(code) || kfIsEk(code)) return; const tot = o.w.reduce((t, x) => t + x, 0); if (tot > 1e-9) req.set(code, { code, w: o.w, total: tot, src: o.skuW }); });
      R = { weeks: stkHeadCols(B), req, made: new Map(), fg: new Map(), noBom: B.info.noBom, now: B };
    } else R = computeReq();
    const weeks = R.weeks;
    const q = $('kbQ').value.trim().toLowerCase(), kat = $('kbKat').value, type = $('kbType').value;
    const src = type === 'made' ? R.made : type === 'fg' ? R.fg : R.req;
    let rows = [...src.values()].map((o) => { const m = MRP.master.get(o.code) || {}; return Object.assign({ name: m.name || o.code, uom: m.uom || '', kat: m.kat || 'Tanpa kategori' }, o); });
    const kats = [...new Set(rows.map((r) => r.kat))].sort((a, b) => a.localeCompare(b, 'id'));
    const cur = $('kbKat').value;
    $('kbKat').innerHTML = '<option value="">Semua kategori</option>' + kats.map((k) => `<option${k === cur ? ' selected' : ''}>${esc(k)}</option>`).join('');
    rows = rows.filter((r) => (!q || (r.code + ' ' + r.name).toLowerCase().includes(q)) && (!kat || r.kat === kat))
      .sort((a, b) => a.code.localeCompare(b.code, 'id', { numeric: true }));
    P.kbRows = rows;
    $('kbHead').innerHTML = gridHead(weeks, { lead: [{ html: 'Material', cls: 'pl-sticky pl-c1' }, { html: 'UoM' }],
      subs: [{ label: 'Kebutuhan', title: 'Kebutuhan material di week ini' }], tail: [{ html: 'Total', cls: 'num' }] });
    $('kbRows').innerHTML = rows.slice(0, 1500).map((r, i) => `<tr class="row" data-i="${i}" tabindex="0">${matCell(r.code, r.name, `<span class="pl-kat">${esc(r.kat)}</span>`)}<td class="pl-uom">${esc(r.uom)}</td>${r.w.map((v, j) => `<td class="num w-start${wCls(weeks, j)}">${v ? fq((v)) : ''}</td>`).join('')}<td class="num"><b>${fq((r.total))}</b></td></tr>`).join('')
      || `<tr class="empty"><td colspan="${weeks.length + 3}">${P.plan.size ? 'Tidak ada kebutuhan di rentang ini.' : 'Belum ada rencana produksi.'}</td></tr>`;
    const byKat = {};
    [...src.values()].forEach((o) => { const k = (MRP.master.get(o.code) || {}).kat || 'Tanpa kategori'; byKat[k] = (byKat[k] || 0) + 1; });
    $('kbKpi').innerHTML = kpis([{ num: nf.format(R.req.size), lbl: 'material dibeli (RM/PM)' }, { num: nf.format(R.made.size), lbl: 'ekstrak/bulk diproduksi' }, { num: nf.format(R.fg.size), lbl: 'FG untuk rakitan/bonus', title: 'Komponen FG di Banded / 2in1 / KIT dan FG bonus; tidak dipecah ke bahan baku' }]
      .concat(Object.entries(byKat).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => ({ num: nf.format(n), lbl: k })))
      .concat(R.noBom.size ? [{ num: nf.format(R.noBom.size), lbl: 'SKU tanpa BOM', tone: 'bad', title: [...R.noBom].join(', ') }] : []));
    $('kbInfo').innerHTML = `${nf.format(rows.length)} ${type === 'made' ? 'ekstrak/bulk' : type === 'fg' ? 'FG' : 'material'} ditampilkan · klik baris untuk melihat SKU yang memakai` + (R.now ? `<br>Kebutuhan mulai ${esc(fmtDate(R.now.tm))}: MO Plotting Harian bulan berjalan per week (Banded/2in1/KIT tidak dihitung) + Plan bulan penuh untuk bulan berikutnya. Sama dengan Proyeksi Stok mode Stok terkini dan Formulir PR.` : pjMoNote(R));
    P.kbWeeks = weeks;
  }
  const round4 = (v) => Math.round(v * 10000) / 10000;
  $('kbQ').addEventListener('input', renderKebutuhan);
  $('kbKat').addEventListener('change', renderKebutuhan);
  $('kbType').addEventListener('change', renderKebutuhan);
  $('kbBasis').addEventListener('change', renderKebutuhan);
  $('kbRows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-i]'); if (!tr) return;
    const r = P.kbRows[Number(tr.dataset.i)], weeks = P.kbWeeks || hzWeeks();
    const lines = [...r.src.entries()].sort((a, b) => a[0].localeCompare(b[0], 'id', { numeric: true }));
    openDialog({
      title: `${r.code} · ${r.name}`, ok: 'Tutup', wide: true, cancel: false, onSubmit: null,
      body: `<p class="dlg-lead">Kebutuhan per SKU (${esc(r.uom)}). Termasuk yang lewat ekstrak/bulk.</p>
        <div class="table-wrap"><table class="po-table pl-mini"><thead><tr><th>SKU</th>${weeks.map((w) => `<th class="num" title="${esc(wTitle(w))}">${esc(wLabel(w))}</th>`).join('')}<th class="num">Total</th></tr></thead>
        <tbody>${lines.map(([sku, arr]) => `<tr><td><b>${esc(sku)}</b> ${esc((P.skus.get(sku) || {}).name || '')}</td>${arr.map((v) => `<td class="num">${v ? fq((v)) : ''}</td>`).join('')}<td class="num"><b>${fq((arr.reduce((a, b) => a + b, 0)))}</b></td></tr>`).join('')}</tbody></table></div>`,
    });
  });
  $('kbExport').addEventListener('click', () => {
    const weeks = P.kbWeeks || hzWeeks();
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
    $('pjHz').hidden = P.pjCalc === 'now';
    if (P.pjCalc === 'now') return renderProyeksiNow();
    const J = computeProj(pjOpt()), weeks = J.weeks, s = J.s;
    P.proj = J;
    const q = $('pjQ').value.trim().toLowerCase(), mode = $('pjMode').value, kat = $('pjKat').value;
    const kats = [...new Set(J.rows.map((r) => r.kat || 'Tanpa kategori'))].sort((a, b) => a.localeCompare(b, 'id'));
    $('pjKat').innerHTML = '<option value="">Semua kategori</option>' + kats.map((k) => `<option${k === kat ? ' selected' : ''}>${esc(k)}</option>`).join('');
    let rows = J.rows.filter((r) => (!q || (r.code + ' ' + r.name).toLowerCase().includes(q)) && (!kat || (r.kat || 'Tanpa kategori') === kat));
    if (mode === 'short') rows = rows.filter((r) => r.firstShort >= 0);
    rows.sort((a, b) => (a.firstShort < 0) - (b.firstShort < 0) || (a.firstShort - b.firstShort) || b.short - a.short || (!a.used) - (!b.used) || a.code.localeCompare(b.code, 'id', { numeric: true }));
    P.pjRows = rows;
    const nShort = J.rows.filter((r) => r.firstShort >= 0).length;
    // Keterangan stok
    let note;
    $('pjNoStock').hidden = !!P.stockDate;
    if (!P.stockDate) note = 'Saldo dihitung dari stok 0, jadi hampir semua material terlihat kurang.';
    else if (J.stockNote === 'after') note = `Stok per ${fmtDate(P.stockDate)} lebih baru dari rentang ini. Geser rentang ke bulan stok.`;
    else if (J.stockNote === 'before') note = `Stok per <b>${fmtDate(P.stockDate)}</b> lebih awal dari rentang ini; kebutuhan antara tanggal stok dan awal rentang tidak ikut dihitung.`;
    else note = `Stok awal = stok per <b>${fmtDate(P.stockDate)}</b> (${esc(P.stockSrc || 'upload')}) + koreksi; stok tersedia = stok awal − stok gantung${P.gantungDate ? ` (per ${fmtDate(P.gantungDate)})` : ' (belum ada stok gantung)'}. Perhitungan mulai ${esc(wLabel(weeks[s]))}; week sebelumnya diabaikan.`;
    if (!J.moMode) note += pjMoNote(J.R);
    if (J.moMode) {
      const W = J.C.W, nMo = new Set((P.cons || []).map((c) => c.mo)).size;
      note += `<br><b>Mode PC + CP:</b> saldo = stok tersedia − (PC + CP) per week; week MO dari Konfirmasi Produksi. Plan hanya pembanding. Baris ekstrak di MO produk dilewati (RM-nya dihitung dari MO ekstrak).`
        + (!nMo ? ' <span class="pl-bad">Belum ada data PC/CP. Upload di menu Konfirmasi Produksi.</span>' : '')
        + (W.nokonf.size ? ` <span class="pl-bad">${nf.format(W.nokonf.size)} MO tidak ada di Konfirmasi Produksi</span> (${esc([...W.nokonf].slice(0, 6).join(', '))}${W.nokonf.size > 6 ? '…' : ''}).` : '')
        + (W.noweek.size ? ` <span class="pl-bad">${nf.format(W.noweek.size)} MO belum dipilih week-nya</span> (${esc([...W.noweek].slice(0, 6).join(', '))}).` : '')
        + (W.outside.size ? ` ${nf.format(W.outside.size)} MO di luar rentang bulan.` : '')
        + (W.before.size ? ` ${nf.format(W.before.size)} MO sebelum week stok (tidak dihitung).` : '');
    }
    {
      const poRead = state.readAt ? whenText(state.readAt) : '', poUp = (state.lastUpload && (state.lastUpload.detTime || state.lastUpload.time)) || '';
      note += `<br><b>PO</b> (informasi; hanya jadwal yang dikonfirmasi masuk <b>Incoming</b> dan menambah saldo — klik angka PO bergaris titik untuk konfirmasi): ${state.rows && state.rows.length ? `data PO upload ${poUp ? esc(fmtDate(poUp.slice(0, 10))) : '-'}${P.stockDate ? ` · stok per ${fmtDate(P.stockDate)}` : ''}${poRead ? ` · dibaca ${esc(poRead)}` : ''}. Jadwal Done, PO cancel, dan take out tidak dihitung.` : '<span class="pl-bad">data PO belum dimuat</span>.'}`;
    }
    $('pjNote').innerHTML = note;
    // hanya week di bulan yang dicentang yang ditampilkan; saldo tetap dihitung lewat bulan di antaranya
    const ms = new Set(selMonths()), vis = weeks.map((w, j) => j).filter((j) => ms.has(weeks[j].bulan)), VW = vis.map((j) => weeks[j]);
    if (J.moMode) return renderProyeksiMo(J, rows, vis, VW, mode);
    const AF = pjAfter(VW); P.pjAfter = AF;
    $('pjHead').innerHTML = gridHead(VW, { lead: PJ_LEAD, tail: [AF.th].concat(PJ_TAIL), cellCls: (k) => (vis[k] < s ? ' is-past' : ''),
      subs: [PJ_INC_SUB, PJ_KUR_SUB, PJ_PO_SUB, { label: 'Saldo', cls: 'pj-ssal', title: 'Saldo akhir week (tebal) = saldo sebelumnya + incoming − kebutuhan (di bawahnya) − ADD/FOH/RS' }] });
    $('pjRows').innerHTML = rows.slice(0, PJ_MAX).map((r, i) => `<tr class="row" data-i="${i}" tabindex="0">${pjLead(r)}
      ${vis.map((j, k) => {
        if (j < s) return `<td class="num is-past w-start${wCls(VW, k)}"></td>` + '<td class="is-past"></td>'.repeat(3);
        const v = r.saldo[j], neg = v < -1e-9;
        const sub = r.need[j] ? `<span class="pj-out">−${fq((r.need[j]))}</span>` : '';
        return pjIncCell(r, j, k, VW, true) + pjKurCell(r, j) + pjPoCell(r, j) + `<td class="num pj-cell${neg ? ' is-neg' : ''}"><b>${fq((v))}</b>${sub ? `<small>${sub}</small>` : ''}</td>`;
      }).join('')}
      <td class="num pj-poa">${poQ(AF.qty(r))}</td>
      <td data-v="${r.firstShort >= 0 ? r.firstShort : 9999}">${r.firstShort >= 0 ? `<span class="badge b-late">${esc(wLabel(weeks[r.firstShort]))}</span>` : '<span class="badge b-done">Aman</span>'}</td>
      <td class="num">${r.short ? `<b class="pl-bad">${fq((r.short))}</b>` : ''}</td></tr>`).join('')
      || `<tr class="empty"><td colspan="${VW.length * 4 + 7}">${mode === 'short' && J.rows.length ? 'Tidak ada material yang kurang di rentang ini.' : 'Belum ada kebutuhan material di rentang ini.'}</td></tr>`;
    pjKpis(J);
  }
  const PJ_MAX = 4000;
  function pjKpis(J) {
    const s = J.s, weeks = J.weeks, nShort = J.rows.filter((r) => r.firstShort >= 0).length, rows = P.pjRows;
    const firstW = J.rows.filter((r) => r.firstShort === s).length;
    const nNoSt = P.stockDate ? J.rows.filter((r) => r.used && !r.hasStock).length : 0;
    $('pjKpi').innerHTML = kpis([
      { num: nf.format(nShort), lbl: 'material akan kurang', tone: nShort ? 'bad' : 'ok' },
      { num: nf.format(firstW), lbl: weeks[s] ? `sudah kurang di ${wLabel(weeks[s])}` : 'kurang di week pertama', tone: firstW ? 'bad' : '' },
      { num: nf.format(J.rows.filter((r) => r.used).length), lbl: 'material terpakai' },
    ].concat(P.stockDate ? [{ num: nf.format(J.rows.filter((r) => r.used && !r.hasStock).length), lbl: 'tidak ada di file stok', tone: nNoSt ? 'warn' : '', title: 'Material terpakai yang stok awalnya dianggap 0' }] : []));
    const nUn = rows.filter((r) => !r.used).length;
    $('pjInfo').textContent = `${nf.format(rows.length)} material ditampilkan${nUn ? ` (${nf.format(nUn)} tidak dipakai di rentang ini)` : ''}${rows.length > PJ_MAX ? ` · baris pertama ${nf.format(PJ_MAX)} saja, persempit dengan cari / kategori` : ''} · klik baris untuk rincian, incoming manual, dan koreksi stok`;
  }
  // Kolom kiri Proyeksi yang ringkas: material (+UoM) dan stok tersedia (awal − gantung di bawahnya)
  const PJ_LEAD = [{ html: 'Material', cls: 'pl-sticky pl-c1' }, { html: 'Stok tersedia<small>awal − gantung</small>', cls: 'num pj-stk', title: 'Stok Tersedia = Stok Awal (stok upload + koreksi) − Stok Gantung; dipakai sebagai saldo awal' },
    { html: 'PO lewat<small>tanggal</small>', cls: 'num pj-pol', title: 'Sisa qty jadwal PO yang belum Done dan tanggalnya sudah lewat (informasi, tidak menambah saldo)' },
    { html: 'PO belum<small>dijadwalkan</small>', cls: 'num pj-pon', title: 'Qty order PO yang belum dibagi ke jadwal kirim (informasi, tidak menambah saldo)' }];
  const PJ_INC_SUB = { label: 'Incoming', cls: 'pj-sinc', title: 'Jadwal PO yang sudah dikonfirmasi datang di week ini; menambah saldo. Klik untuk konfirmasi' };
  // Sel Incoming / PO: klik → daftar jadwal PO di week itu untuk dikonfirmasi
  const pjIncCell = (r, j, k, VW, first) => `<td class="num pj-sinc${first ? ' w-start' + wCls(VW, k) : ''}${r.po && r.po.w[j] ? ' pj-pow' : ''}" data-v="${r.inW[j] || 0}"${r.po && r.po.w[j] ? ` data-pow="${j}" title="Klik untuk konfirmasi incoming"` : ''}>`
    + (r.inW[j] ? `<b class="pj-in">+${fq(r.inW[j])}</b>` : '') + '</td>';
  const pjPoCell = (r, j) => `<td class="num pj-spo${r.po && r.po.w[j] ? ' pj-pow' : ''}"${r.po && r.po.w[j] ? ` data-pow="${j}" title="Klik untuk konfirmasi incoming"` : ''}>${r.po ? poQ(r.po.w[j]) : ''}</td>`;
  const PJ_KUR_SUB = { label: 'ADD/FOH/RS', cls: 'pj-skur', title: 'Pengurangan stok manual (ADD / FOH / RS) di week ini; mengurangi saldo. Klik untuk melihat / menambah' };
  const pjKurCell = (r, j) => `<td class="num pj-skur pj-kurc" data-kur="${j}" data-v="${r.outW[j] || 0}" title="${P.edit ? 'Klik untuk menambah / melihat permintaan' : 'Klik untuk melihat permintaan'}">${r.outW[j] ? `<b class="pj-out">−${fq(r.outW[j])}</b>` : ''}</td>`;
  const PJ_PO_SUB = { label: 'PO', cls: 'pj-spo', title: 'Sisa qty jadwal PO yang jatuh di week ini (informasi, tidak menambah saldo)' };
  const poQ = (v) => (v > 1e-9 ? fq(v) : '');
  const PJ_TAIL = [{ html: 'Mulai kurang' }, { html: 'Kurang', cls: 'num' }];
  // Kolom "PO <bulan berikutnya> dst": jadwal PO sesudah week terakhir yang ditampilkan (mengikuti filter bulan)
  function pjAfter(VW) {
    const end = VW.length ? VW[VW.length - 1].end : '';
    const b = VW.length ? VW[VW.length - 1].bulan : todayStr().slice(0, 7);
    let [y, m] = b.split('-').map(Number); m++; if (m > 12) { m = 1; y++; }
    const nb = `${y}-${String(m).padStart(2, '0')}`;
    return {
      end, label: `${monShort(nb)} ${y}`,
      th: { html: `PO ${monShort(nb)} ${y}<small>dst</small>`, cls: 'num pj-poa', title: `Sisa qty jadwal PO mulai ${monLabel(nb)} dan sesudahnya, setelah bulan yang ditampilkan (informasi, tidak menambah saldo)` },
      qty: (r) => (r.po && end ? r.po.list.reduce((t, x) => t + ((x.kind === 'w' || x.kind === 'out') && x.date > end ? x.sisa : 0), 0) : 0),
    };
  }
  const pjLead = (r) => matCell(r.code, r.name, (r.uom ? `<span class="pj-uom">${esc(r.uom)}</span>` : '') + (r.used ? '' : '<span class="pj-unused" title="Tidak ada kebutuhan di rentang ini">tidak dipakai</span>'))
    + `<td class="num pj-stk"><b class="${r.start < -1e-9 ? 'pl-bad' : ''}">${fq(r.start)}</b>${r.gant ? `<small>${fq(r.awal)} − <span class="pj-gtx">${fq(r.gant)}</span></small>` : ''}</td>`
    + `<td class="num pj-pol">${r.po ? poQ(r.po.late) : ''}</td><td class="num pj-pon">${r.po ? poQ(r.po.unsched) : ''}</td>`;
  // Mode PC + CP: tiap week Plan | PC | CP | Saldo
  function renderProyeksiMo(J, rows, vis, VW, mode) {
    const s = J.s, weeks = J.weeks, q0 = (v) => (Math.abs(v) > 1e-12 ? fq(v) : '');
    const AF = pjAfter(VW); P.pjAfter = AF;
    $('pjHead').innerHTML = gridHead(VW, { lead: PJ_LEAD, tail: [AF.th].concat(PJ_TAIL), cellCls: (k) => (vis[k] < s ? ' is-past' : ''),
      subs: [{ label: 'Plan', cls: 'pj-sp', title: 'Kebutuhan MPS (pembanding)' }, { label: 'PC', cls: 'pj-spc', title: 'Products to Consume: belum dikonsumsi' },
        { label: 'CP', cls: 'pj-scp', title: 'Consumed Products: sudah dikonsumsi' }, PJ_INC_SUB, PJ_KUR_SUB, PJ_PO_SUB, { label: 'Saldo', cls: 'pj-ssal', title: 'Stok tersedia + incoming − (PC + CP) − ADD/FOH/RS berjalan' }] });
    $('pjRows').innerHTML = rows.slice(0, PJ_MAX).map((r, i) => `<tr class="row" data-i="${i}" tabindex="0">${pjLead(r)}
      ${vis.map((j, k) => {
        if (j < s) return `<td class="num is-past w-start${wCls(VW, k)}"></td>` + '<td class="is-past"></td>'.repeat(6);
        const v = r.saldo[j], neg = v < -1e-9;
        return `<td class="num pj-sp w-start${wCls(VW, k)}">${q0(r.need[j])}</td><td class="num pj-spc">${q0(r.pc[j])}</td><td class="num pj-scp">${q0(r.cp[j])}</td>${pjIncCell(r, j, k, VW, false)}${pjKurCell(r, j)}${pjPoCell(r, j)}`
          + `<td class="num pj-cell${neg ? ' is-neg' : ''}"><b>${fq(v)}</b></td>`;
      }).join('')}
      <td class="num pj-poa">${poQ(AF.qty(r))}</td>
      <td data-v="${r.firstShort >= 0 ? r.firstShort : 9999}">${r.firstShort >= 0 ? `<span class="badge b-late">${esc(wLabel(weeks[r.firstShort]))}</span>` : '<span class="badge b-done">Aman</span>'}</td>
      <td class="num">${r.short ? `<b class="pl-bad">${fq(r.short)}</b>` : ''}</td></tr>`).join('')
      || `<tr class="empty"><td colspan="${VW.length * 7 + 7}">${mode === 'short' && J.rows.length ? 'Tidak ada material yang kurang di rentang ini.' : 'Belum ada kebutuhan material di rentang ini.'}</td></tr>`;
    pjKpis(J);
  }
  /* ---------- Proyeksi Stok · mode Stok terkini (sama dengan Formulir PR & Lampiran Perhitungan) ---------- */
  // Kolom stkBase → bentuk "week" untuk gridHead (bulan berikutnya = satu kolom Plan bulan)
  const stkHeadCols = (B) => B.cols.map((c) => ({ bulan: c.bulan, week: c.kind === 'm' ? 'Plan bulan' : (c.week || 'Sisa') + (c.part ? ' (sisa)' : ''), start: c.d, end: c.de }));
  function stkNote(B) {
    const age = Math.round((new Date(B.today + 'T00:00:00') - new Date(B.d0 + 'T00:00:00')) / 86400000), I = B.info;
    let t = `<b>Stok terkini per ${esc(fmtDate(B.today))}</b> = stok upload ${esc(fmtDate(B.d0))} + koreksi − stok gantung + incoming dikonfirmasi datang − pemakaian MO Plotting Harian (${nf.format(I.moPast)} MO) − ADD/FOH/RS sampai hari ini.`
      + ` <b>Kebutuhan</b> mulai ${esc(fmtDate(B.tm))}: MO Plotting Harian bulan berjalan (${nf.format(I.moFut)} MO) + Plan bulan penuh untuk bulan berikutnya. Saldo = stok terkini + PO terjadwal − kebutuhan − ADD/FOH/RS. PO telat / tanpa jadwal dipisah.`;
    if (age > 7) t += ` <span class="pl-warn-t">⚠ Stok yang dipakai sudah ${age} hari (per ${esc(fmtDate(B.d0))}); upload stok terbaru supaya stok terkini lebih tepat.</span>`;
    if (I.moNoDate.length) t += ` <span class="pl-warn-t">${nf.format(I.moNoDate.length)} MO belum ada tanggal produksi (dihitung sebagai kebutuhan di week-nya):</span> ${esc(I.moNoDate.slice(0, 8).join(', '))}${I.moNoDate.length > 8 ? '…' : ''}.`;
    if (I.moSkip) t += ` ${nf.format(I.moSkip)} MO Banded/2in1/KIT tidak dihitung.`;
    if (I.monFallback.length) t += ` <span class="pl-warn-t">Plan bulan kosong, dipakai Σ plan week:</span> ${esc(I.monFallback.slice(0, 8).join(', '))}${I.monFallback.length > 8 ? '…' : ''}.`;
    if (I.noBom.size) t += ` <span class="pl-bad">${nf.format(I.noBom.size)} SKU tanpa BoM tidak dihitung:</span> ${esc([...I.noBom].slice(0, 8).join(', '))}.`;
    return t;
  }
  function renderProyeksiNow() {
    const B = stkBase(), H = stkHeadCols(B), n = B.n;
    const q = $('pjQ').value.trim().toLowerCase(), mode = $('pjMode').value, kat = $('pjKat').value;
    const codes = new Set();
    B.M.forEach((v, c) => codes.add(c));
    if (mode !== 'short') { (P.stock || new Map()).forEach((v, c) => codes.add(c)); poIdx.rows !== state.rows && poRowsOf(''); (poIdx.map || new Map()).forEach((v, c) => { if (MRP.master.has(c)) codes.add(c); }); }
    if (mode === 'master') MRP.master.forEach((v, c) => codes.add(c));
    const all = [];
    codes.forEach((code) => {
      if (isFg(code) || kfIsEk(code)) return;
      const d = prCalc(code, 'all', []); if (!d) return;
      const m = MRP.master.get(code) || {}, used = B.M.has(code);
      const fs = d.cols.findIndex((c) => c.sal < -1e-9);
      all.push({ code, name: d.nama || m.name || code, uom: d.uom, kat: m.kat || 'Tanpa kategori', d, used, firstShort: fs, short: fs >= 0 ? -d.deep : 0 });
    });
    const kats = [...new Set(all.map((r) => r.kat))].sort((a, b) => a.localeCompare(b, 'id'));
    $('pjKat').innerHTML = '<option value="">Semua kategori</option>' + kats.map((k) => `<option${k === kat ? ' selected' : ''}>${esc(k)}</option>`).join('');
    let rows = all.filter((r) => (!q || (r.code + ' ' + r.name).toLowerCase().includes(q)) && (!kat || r.kat === kat));
    if (mode === 'short') rows = rows.filter((r) => r.firstShort >= 0);
    rows.sort((a, b) => (a.firstShort < 0) - (b.firstShort < 0) || (a.firstShort - b.firstShort) || b.short - a.short || (!a.used) - (!b.used) || a.code.localeCompare(b.code, 'id', { numeric: true }));
    P.pjRows = rows; P.pjNow = { B, H };
    $('pjNoStock').hidden = !!P.stockDate;
    $('pjNote').innerHTML = stkNote(B);
    $('pjHead').innerHTML = gridHead(H, {
      lead: [{ html: 'Material', cls: 'pl-sticky pl-c1' }, { html: `Stok terkini<small>per ${esc(fmtDate(B.today).slice(0, 6))}</small>`, cls: 'num pj-stk', title: 'Stok awal + koreksi − gantung + incoming − pemakaian MO − ADD/FOH/RS sampai hari ini (rincian di bawah angka)' },
        { html: 'PO telat<small>/ tanpa jadwal</small>', cls: 'num pj-pol', title: 'Sisa PO yang jadwalnya sudah lewat atau belum dijadwalkan (tidak menambah saldo per kolom)' }],
      subs: [{ label: 'Kebutuhan', cls: 'pj-skur', title: 'MO Plotting Harian (bulan berjalan) atau Plan bulan (bulan berikutnya)' }, { label: 'PO', cls: 'pj-spo', title: 'Sisa jadwal PO di kolom ini; menambah saldo' }, { label: 'Saldo', cls: 'pj-ssal', title: 'Saldo = saldo sebelumnya + PO − kebutuhan − ADD/FOH/RS' }],
      tail: [{ html: 'PO setelah<small>MPS</small>', cls: 'num pj-poa' }].concat(PJ_TAIL) });
    const f0 = (v) => (Math.abs(v) > 1e-9 ? fq(v) : '');
    $('pjRows').innerHTML = rows.slice(0, PJ_MAX).map((r, i) => {
      const d = r.d, ln = d.poLate + d.poNone;
      return `<tr class="row" data-i="${i}" tabindex="0">${matCell(r.code, r.name, (r.uom ? `<span class="pj-uom">${esc(r.uom)}</span>` : '') + (r.used ? '' : '<span class="pj-unused" title="Tidak ada kebutuhan">tidak dipakai</span>'))}
        <td class="num pj-stk"><b class="${d.stok < -1e-9 ? 'pl-bad' : ''}">${fq(d.stok)}</b><small title="stok awal + koreksi − gantung / + incoming / − pemakaian MO / − ADD">${fq(d.awal + d.koreksi - d.gantung)}${d.incPast ? ` +${fq(d.incPast)}` : ''}${d.pakaiPast ? ` −${fq(d.pakaiPast)}` : ''}${d.addPast ? ` −${fq(d.addPast)}` : ''}</small></td>
        <td class="num pj-pol">${f0(ln)}</td>
        ${d.cols.map((c, k) => `<td class="num pj-skur w-start${wCls(H, k)}">${c.need || c.add ? `<span class="pj-out">−${fq(c.need + c.add)}</span>` : ''}</td><td class="num pj-spo">${f0(c.po)}</td><td class="num pj-cell${c.sal < -1e-9 ? ' is-neg' : ''}"><b>${fq(c.sal)}</b></td>`).join('')}
        <td class="num pj-poa">${f0(d.poAfter)}</td>
        <td data-v="${r.firstShort >= 0 ? r.firstShort : 9999}">${r.firstShort >= 0 ? `<span class="badge b-late">${esc(d.cols[r.firstShort].lf || d.cols[r.firstShort].l)}</span>` : '<span class="badge b-done">Aman</span>'}</td>
        <td class="num">${r.short ? `<b class="pl-bad">${fq(r.short)}</b>` : ''}</td></tr>`;
    }).join('') || `<tr class="empty"><td colspan="${n * 3 + 6}">${mode === 'short' ? 'Tidak ada material yang kurang.' : 'Belum ada kebutuhan material.'}</td></tr>`;
    const nShort = all.filter((r) => r.firstShort >= 0).length, first = all.filter((r) => r.firstShort === 0).length;
    $('pjKpi').innerHTML = kpis([{ num: nf.format(nShort), lbl: 'material akan kurang', tone: nShort ? 'bad' : 'ok' }, { num: nf.format(first), lbl: `sudah kurang di ${B.cols[0].l}`, tone: first ? 'bad' : '' },
      { num: nf.format(B.M.size), lbl: 'material terpakai' }, { num: esc(fmtDate(B.d0).slice(0, 6)), lbl: 'tanggal stok upload' }]);
    $('pjInfo').textContent = `${nf.format(rows.length)} material ditampilkan${rows.length > PJ_MAX ? ` · baris pertama ${nf.format(PJ_MAX)} saja` : ''} · klik baris untuk rincian`;
  }
  function openNowDetail(code) {
    const d = prCalc(code, 'all', []); if (!d) return;
    const B = stkBase(), mm = B.M.get(code), u = esc(d.uom || '');
    const mos = mm ? mm.mos.filter((x) => x.ref) : [];
    const past = mos.filter((x) => x.past), fut = mos.filter((x) => !x.past);
    const moT = (L) => L.length ? `<table class="po-table pl-mini"><thead><tr><th>MO</th><th>SKU</th><th class="num">Pemakaian ${u}</th></tr></thead><tbody>${L.map((x) => { const k = P.konf.get(x.ref); return `<tr><td><b>${esc(x.ref)}</b><small>${k && k.tgl ? esc(fmtDate(k.tgl)) : 'tanpa tanggal'}</small></td><td>${esc(x.sku)}</td><td class="num">${fq(x.q)}</td></tr>`; }).join('')}</tbody></table>` : '<p class="muted">Tidak ada.</p>';
    const skuL = mm ? [...mm.skuW.entries()].sort((a, b) => b[1].reduce((t, x) => t + x, 0) - a[1].reduce((t, x) => t + x, 0)) : [];
    openDialog({ title: `${code} · ${d.nama}`, ok: 'Tutup', cancel: false, wide: true, onSubmit: null,
      body: `<p class="dlg-lead">Stok terkini per <b>${esc(fmtDate(d.at))}</b>: stok ${esc(fmtDate(d.stokDate))} <b>${fq(d.awal)}</b>${d.koreksi ? ` + koreksi ${fq(d.koreksi)}` : ''}${d.gantung ? ` − gantung ${fq(d.gantung)}` : ''} + incoming <b>${fq(d.incPast)}</b> − pemakaian MO <b>${fq(d.pakaiPast)}</b> − ADD/FOH/RS <b>${fq(d.addPast)}</b> = <b>${fq(d.stok)} ${u}</b>.
        Kebutuhan ${esc(B.cols[0].l)} s/d ${esc(d.last)}: <b>${fq(d.butuh)}</b> · OS PO <b>${fq(d.ospo)}</b> → ${d.kurang < -1e-9 ? `<b class="pl-bad">kurang ${fq(-d.kurang)}</b>` : `sisa <b>${fq(d.kurang)}</b>`} ${u}.</p>
        <div class="table-wrap"><table class="po-table pl-mini"><thead><tr><th>Kebutuhan per SKU</th>${d.cols.map((c) => `<th class="num">${esc(c.l)}</th>`).join('')}<th class="num">Total</th></tr></thead><tbody>
        ${skuL.map(([sku, arr]) => `<tr><td><b>${esc(sku)}</b> ${esc((P.skus.get(sku) || {}).name || '')}</td>${arr.map((v) => `<td class="num">${v ? fq(v) : ''}</td>`).join('')}<td class="num"><b>${fq(arr.reduce((t, x) => t + x, 0))}</b></td></tr>`).join('') || `<tr class="empty"><td colspan="${d.cols.length + 2}">Tidak ada kebutuhan.</td></tr>`}
        <tr><th>Saldo</th>${d.cols.map((c) => `<td class="num${c.sal < -1e-9 ? ' pl-bad' : ''}"><b>${fq(c.sal)}</b></td>`).join('')}<td></td></tr></tbody></table></div>
        <h4>Pemakaian MO s/d hari ini (memotong stok)</h4>${moT(past)}
        <h4>MO bulan berjalan yang belum berjalan</h4>${moT(fut)}
        <p class="pj-actions"><button type="button" class="btn btn-sm btn-ghost" id="nowOld">Koreksi stok, incoming manual &amp; rincian PO (Mode Plan)</button></p>`,
    });
    const b = $('dlgBody').querySelector('#nowOld'); if (b) b.addEventListener('click', () => { $('dlg').close(); setTimeout(() => openProjDetail(code), 0); });
  }
  // pilihan mode hitung Proyeksi (diingat per browser); bawaan: Stok terkini
  const PJ_CALC_KEY = 'ppic-pj-calc2';
  try { const v = localStorage.getItem(PJ_CALC_KEY); P.pjCalc = v === 'mo' || v === 'plan' ? v : 'now'; } catch (e) { P.pjCalc = 'now'; }
  const paintPjCalc = () => document.querySelectorAll('#pjCalc button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.calc === P.pjCalc)));
  paintPjCalc();
  $('pjCalc').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-calc]'); if (!b || b.dataset.calc === P.pjCalc) return;
    P.pjCalc = b.dataset.calc; paintPjCalc();
    try { localStorage.setItem(PJ_CALC_KEY, P.pjCalc); } catch (err) { /* abaikan */ }
    renderProyeksi();
  });
  ['pjQ', 'pjMode', 'pjKat'].forEach((id) => $(id).addEventListener(id === 'pjQ' ? 'input' : 'change', renderProyeksi));
  $('pjRows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-i]'); if (!tr) return;
    const code = P.pjRows[Number(tr.dataset.i)].code, pw = e.target.closest('[data-pow]'), kc = e.target.closest('[data-kur]');
    if (P.pjCalc === 'now') { openNowDetail(code); return; }
    if (kc) pjKurDialog(code, Number(kc.dataset.kur));
    else if (pw) pjWeekPoDialog(code, Number(pw.dataset.pow)); else openProjDetail(code);
  });
  $('pjRows').addEventListener('keydown', (e) => { if (e.key !== 'Enter' || e.target.closest('input')) return; const tr = e.target.closest('tr[data-i]'); if (tr) (P.pjCalc === 'now' ? openNowDetail : openProjDetail)(P.pjRows[Number(tr.dataset.i)].code); });
  function openProjDetail(code) {
    const J = computeProj(pjOpt()); P.proj = J;
    P.incKBack = () => openProjDetail(code);
    const r = J.rows.find((x) => x.code === code); if (!r) return;
    const weeks = J.weeks, s = J.s, vis = weeks.map((w, i) => i).filter((i) => i >= s);
    const row = (label, f, cls = '') => `<tr class="${cls}"><th>${label}</th>${vis.map((i) => `<td class="num">${f(i)}</td>`).join('')}</tr>`;
    const q4 = (v) => (v ? fq((v)) : '');
    const adjList = P.adj.filter((x) => x.code === code);
    const srcList = [...r.src.entries()].map(([sku, arr]) => [sku, arr.reduce((a, b) => a + b, 0)]).sort((a, b) => b[1] - a[1]);
    openDialog({
      title: `${r.code} · ${r.name}`, ok: 'Tutup', wide: true, cancel: false, onSubmit: null,
      body: `<p class="dlg-lead">UoM ${esc(r.uom || '-')} · stok awal <b>${fq((r.awal))}</b>${P.stockDate ? ` (stok per ${fmtDate(P.stockDate)}${r.adj ? `, koreksi ${r.adj > 0 ? '+' : ''}${fq((r.adj))}` : ''})` : ' (belum ada data stok)'} − stok gantung <b>${fq(r.gant)}</b> = stok tersedia <b>${fq(r.start)}</b></p>
        <div class="table-wrap"><table class="po-table pl-mini pj-detail"><thead><tr><th></th>${vis.map((i) => `<th class="num" title="${esc(wTitle(weeks[i]))}">${esc(wLabel(weeks[i]))}</th>`).join('')}</tr></thead><tbody>
          ${row('Incoming (PO dikonfirmasi)', (i) => (r.inW[i] ? `<b class="pj-in">+${fq(r.inW[i])}</b>` : ''), 'pj-incrow')}
          ${row(J.moMode ? 'Plan (pembanding)' : 'Kebutuhan', (i) => q4(r.need[i]), J.moMode ? 'muted' : '')}
          ${J.moMode ? row('PC (belum dikonsumsi)', (i) => q4(r.pc[i])) + row('CP (sudah dikonsumsi)', (i) => q4(r.cp[i])) : ''}
          ${row('ADD/FOH/RS (manual)', (i) => (r.outW[i] ? `<b class="pj-out">−${fq(r.outW[i])}</b>` : ''), 'pj-kurrow')}
          ${row('PO (info, tidak dihitung)', (i) => q4(r.po ? r.po.w[i] : 0), 'pj-porow')}
          ${row('Saldo akhir', (i) => `<b class="${r.saldo[i] < -1e-9 ? 'pl-bad' : ''}">${fq((r.saldo[i]))}</b>`, 'pj-sum')}
        </tbody></table></div>
        ${pjPoListHtml(r, weeks)}
        ${J.moMode ? pjMoListHtml(r, weeks) : ''}
        <h3 class="pj-h">Koreksi stok (${adjList.length})</h3>
        ${adjList.length ? `<ul class="pj-list">${adjList.map((x) => `<li><b>${x.qty > 0 ? '+' : ''}${fmtQ(x.qty)}</b> · ${fmtDate(x.date)} · ${esc(x.note)}${P.stockDate && x.date < P.stockDate ? ' <span class="muted">(sebelum tanggal stok, tidak dihitung)</span>' : ''}${P.edit ? ` <button class="btn-link danger" data-del-adj="${esc(x.id)}">Hapus</button>` : ''}</li>`).join('')}</ul>` : '<p class="muted">Belum ada.</p>'}
        <div class="pj-actions"><button type="button" class="btn btn-sm btn-ghost" id="pjAddAdj">Koreksi stok</button></div>
        <h3 class="pj-h">Dipakai oleh</h3>
        <p class="pj-src">${srcList.map(([sku, v]) => `<span><b>${esc(sku)}</b> ${fq((v))}</span>`).join('')}</p>`,
    });
    const body = $('dlgBody');
    body.querySelectorAll('[data-gopo]').forEach((b) => b.addEventListener('click', () => {
      const po = b.dataset.gopo, c = b.dataset.gocode;
      const row = state.rows.find((x) => x.po === po && x.code === c && !x.cancel) || state.rows.find((x) => x.po === po && x.code === c);
      $('dlg').close();
      goMonitor({ q: po + ' ' + c, openKey: row ? row.key : null, jenis: '', supplier: '' });
      if (row) setTimeout(() => scrollRowTop(row.key), 300);
    }));
    body.querySelector('#pjAddAdj').addEventListener('click', () => needEdit(() => adjForm(code)));
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
  /* ---------- Pengurangan stok manual ADD / FOH / RS ---------- */
  function setKurang(list) { P.kurang = (list || []).map((r) => ({ id: r[0], tgl: r[1], code: r[2], qty: Number(r[3]) || 0, ket: r[4], time: r[5] })); }
  function pjKurDialog(code, j) {
    const J = P.proj || computeProj(), w = J.weeks[j], m = MRP.master.get(code) || {};
    const inWeek = (x) => { const ww = weekOfDate(x.tgl); let i = ww ? J.R.idx.get(ww.bulan + '|' + ww.week) : undefined; if (i === undefined && x.tgl && J.weeks.length && x.tgl < J.weeks[0].start) i = J.s; if (i !== undefined && i < J.s) i = J.s; return i === j; };
    const L = (P.kurang || []).filter((x) => x.code === code && inWeek(x)).sort((a, b) => (a.tgl < b.tgl ? -1 : 1));
    const ed = P.edit, def = todayStr() >= w.start && todayStr() <= w.end ? todayStr() : w.start;
    openDialog({
      title: `ADD/FOH/RS · ${code} · ${wLabel(w)} ${w.bulan.slice(0, 4)}`, ok: ed ? 'Tambah permintaan' : 'Tutup', cancel: ed, wide: true,
      body: `<p class="dlg-lead">${esc(m.name || '')} · ${esc(wTitle(w))} · total <b>${fq(L.reduce((t, x) => t + x.qty, 0))} ${esc(m.uom || '')}</b></p>
        ${L.length ? `<div class="table-wrap"><table class="po-table pl-mini"><thead><tr><th>Tanggal</th><th class="num">Qty</th><th>Keterangan / peminta</th><th>Dicatat</th>${ed ? '<th></th>' : ''}</tr></thead><tbody>
          ${L.map((x) => `<tr><td>${fmtDate(x.tgl)}${x.tgl < w.start ? ' <small class="muted">(sebelum tanggal stok, dihitung di week ini)</small>' : ''}</td><td class="num"><b>${fq(x.qty)}</b></td><td>${esc(x.ket)}</td><td class="muted">${esc(x.time)}</td>${ed ? `<td><button type="button" class="btn-link danger" data-kurdel="${esc(x.id)}">Hapus</button></td>` : ''}</tr>`).join('')}
          </tbody></table></div>` : '<p class="muted">Belum ada permintaan di week ini.</p>'}
        ${ed ? `<h3 class="pj-h">Tambah permintaan</h3><div class="form-grid">${fld('tgl', 'Tanggal permintaan *', def, { type: 'date', required: true })}${fld('qty', `Qty (${esc(m.uom || '')}) *`, '', { type: 'number', step: 'any', required: true })}${fld('ket', 'Keterangan / peminta (ADD / FOH / RS …)', '', { wide: true })}</div>` : '<p class="hint">Masuk Mode edit (PIN MRP) untuk menambah atau menghapus.</p>'}`,
      onSubmit: ed ? async (fd) => {
        if (!P.hasKurang) throw new Error('Apps Script MRP perlu diperbarui (versi dengan ADD/FOH/RS).');
        const qty = Number(fd.qty); if (!(qty > 0)) throw new Error('Qty harus lebih dari 0.');
        const res = await mrpApi('saveKurang', { tanggal: fd.tgl, kode: code, qty, ket: (fd.ket || '').trim() });
        setKurang(res.kurang || []); renderProyeksi();
        setTimeout(() => pjKurDialog(code, j), 0);
        return 'Permintaan dicatat.';
      } : async () => '',
    });
    const b = $('dlgBody'), seq = dlgSeq;
    b.addEventListener('click', async (e) => {
      if (seq !== dlgSeq) return;
      const d = e.target.closest('[data-kurdel]'); if (!d) return;
      d.disabled = true; d.textContent = 'Menghapus…';
      try { const res = await mrpApi('delKurang', { id: d.dataset.kurdel }); setKurang(res.kurang || []); renderProyeksi(); pjKurDialog(code, j); toast('Permintaan dihapus.'); }
      catch (err) { d.disabled = false; d.textContent = 'Hapus'; toast('Gagal: ' + err.message); }
    });
  }
  // Format Excel & upload ADD/FOH/RS
  const KUR_HEAD = ['TANGGAL', 'KODE', 'NAMA MATERIAL', 'QTY', 'UoM', 'KETERANGAN'];
  $('kurTpl').addEventListener('click', () => {
    const ws = XLSX.utils.aoa_to_sheet([KUR_HEAD, [todayStr(), '', '', '', '', 'ADD / FOH / RS - peminta']]);
    ws['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 40 }, { wch: 10 }, { wch: 6 }, { wch: 40 }];
    const info = XLSX.utils.aoa_to_sheet([['Petunjuk'], ['Satu baris = satu permintaan. Wajib: TANGGAL (tanggal permintaan, yyyy-mm-dd), KODE material, QTY (> 0).'],
      ['NAMA MATERIAL & UoM hanya pembantu, boleh kosong. KETERANGAN: jenis (ADD / FOH / RS) dan peminta / no. dokumen.'],
      ['Upload menambahkan baris (tidak mengganti data lama). Baris yang persis sama (tanggal, kode, qty, keterangan) dilewati.'],
      ['Week dihitung dari TANGGAL; tanggal sebelum tanggal stok dihitung di week pertama Proyeksi Stok.']]);
    const mat = XLSX.utils.json_to_sheet([...MRP.master.values()].filter((m) => /raw|pack|ekstrak/i.test(m.kat || '')).map((m) => ({ KODE: m.code, 'NAMA MATERIAL': m.name, KATEGORI: m.kat, UoM: m.uom })));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'ADD FOH RS'); XLSX.utils.book_append_sheet(wb, info, 'PETUNJUK'); XLSX.utils.book_append_sheet(wb, mat, 'DAFTAR MATERIAL');
    XLSX.writeFile(wb, `Format_ADD_FOH_RS_${todayStr()}.xlsx`);
  });
  const xlDay = (v) => {
    if (v === '' || v === null || v === undefined) return '';
    if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); return d ? `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}` : ''; }
    const t = String(v).trim(); let mm = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (mm) return `${mm[1]}-${mm[2].padStart(2, '0')}-${mm[3].padStart(2, '0')}`;
    mm = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); return mm ? `${mm[3]}-${mm[2].padStart(2, '0')}-${mm[1].padStart(2, '0')}` : '';
  };
  $('kurFile').addEventListener('change', async () => {
    const f = $('kurFile').files[0]; $('kurFile').value = ''; if (!f) return;
    try {
      const wb = await readBook(f), sn = wb.SheetNames.find((x) => /add|foh|rs/i.test(x)) || wb.SheetNames[0], A = sheetRows(wb, sn);
      const h = A.findIndex((r) => r.some((x) => txt(x).toUpperCase() === 'TANGGAL') && r.some((x) => txt(x).toUpperCase() === 'KODE'));
      if (h < 0) throw new Error('Kolom TANGGAL dan KODE tidak ditemukan. Pakai "Format ADD/FOH/RS".');
      const H = A[h].map((x) => txt(x).toUpperCase()), ix = (nm) => H.indexOf(nm);
      const rows = [], bad = [], unk = new Set();
      A.slice(h + 1).forEach((r, i) => {
        const kode = txt(r[ix('KODE')]).replace(/\.0+$/, ''), qty = Number(String(r[ix('QTY')] ?? '').replace(',', '.')), tgl = xlDay(r[ix('TANGGAL')]);
        if (!kode && !r[ix('QTY')]) return;
        if (!tgl || !kode || !(qty > 0)) { bad.push(h + i + 2); return; }
        if (!MRP.master.has(kode)) unk.add(kode);
        rows.push([tgl, kode, qty, ix('KETERANGAN') >= 0 ? txt(r[ix('KETERANGAN')]) : '']);
      });
      if (!rows.length) throw new Error('Tidak ada baris yang lengkap (TANGGAL, KODE, QTY).');
      needEdit(() => openDialog({
        title: `Upload ADD/FOH/RS · ${f.name}`, ok: 'Simpan ke Google Sheet',
        body: `<p class="dlg-lead">Terbaca <b>${nf.format(rows.length)}</b> permintaan, total qty ${fq(rows.reduce((t, r) => t + r[2], 0))}. Baris ditambahkan ke data lama; baris yang persis sama dilewati.</p>
          ${bad.length ? `<p class="pl-bad">${bad.length} baris dilewati karena TANGGAL/KODE/QTY tidak lengkap (baris ${bad.slice(0, 10).join(', ')}${bad.length > 10 ? '…' : ''}).</p>` : ''}
          ${unk.size ? `<p class="pl-warn-t">Kode tidak ada di Daftar Material: ${esc([...unk].slice(0, 10).join(', '))} (tetap disimpan).</p>` : ''}`,
        onSubmit: async () => {
          if (!P.hasKurang) throw new Error('Apps Script MRP perlu diperbarui (versi dengan ADD/FOH/RS).');
          const res = await mrpApi('uploadKurang', { rows, file: f.name });
          setKurang(res.kurang || []); if (PLAN_KEYS.has(state.routeKey)) renderPlanView(state.routeKey);
          return `${res.added} permintaan ditambahkan${res.skipped ? `, ${res.skipped} dilewati` : ''}.`;
        },
      }));
    } catch (err) { toast('Upload gagal: ' + err.message); }
  });

  /* ---------- Konfirmasi incoming (jadwal PO → Incoming Proyeksi Stok) ---------- */
  function setIncK(list) {
    P.incK = (list || []).map((r) => ({ po: r[0], code: r[1], ke: String(r[2]), qty: Number(r[3]) || 0, tgl: r[4], note: r[5], time: r[6], bulan: r[7] || '', week: r[8] || '', datang: r[9] || '' }));
    P.incKMap = new Map(P.incK.map((k) => [k.po + '|' + k.code + '|' + k.ke, k]));
  }
  // Sel konfirmasi di daftar jadwal PO (x: item poByMat)
  function incKCell(x, code) {
    if (x.kind === 'none') return '<span class="muted">belum dijadwalkan</span>';
    const k = `data-inck="${esc(x.po)}|${esc(code)}|${esc(x.ke)}" data-inck-date="${esc(x.date || '')}" data-inck-sisa="${x.sisa}"`;
    const wl = P.proj && x.incI !== undefined ? P.proj.weeks[x.incI] : null;
    if (x.kAuto) return `<span class="pj-kbtn is-on is-auto" title="Sudah datang sebagian; sisanya tetap Incoming di tanggal jadwal">Sisa ${fq(x.konf)} incoming</span>${wl ? `<small class="muted">datang ${esc(wLabel(wl))}${x.moved ? ' (week berjalan)' : ''}</small>` : ''} <button type="button" class="btn-link" data-incarr="${esc(x.po)}|${esc(code)}|${esc(x.ke)}">+ Kedatangan berikutnya</button>`;
    if (x.konf) return `<button type="button" class="pj-kbtn is-on" ${k} title="${esc(x.kNote || '')}">✓ ${fq(x.konf)}${x.eff !== undefined && x.eff < x.konf - 1e-9 ? ` <small>(dihitung ${fq(x.eff)})</small>` : ''}</button>`
      + (wl ? `<small class="muted">datang ${esc(wLabel(wl))}${x.moved ? ' (dipindah ke week berjalan)' : ''}</small>` : '') + (x.kFlag ? `<small class="pl-bad">${esc(x.kFlag)}</small>` : '');
    return `<button type="button" class="pj-kbtn" ${k}>Konfirmasi</button>`;
  }
  /* ---------- Beberapa kedatangan dalam satu jadwal ----------
   * Konfirmasi utama memakai kunci jadwal "n"; kedatangan berikutnya "n#2", "n#3", … (selalu berstatus sudah datang). */
  function incArrOf(po, code, n) {
    const b = String(n);
    return (P.incK || []).filter((k) => k.po === po && k.code === code && k.datang && (k.ke === b || k.ke.startsWith(b + '#'))).sort((a, c) => a.datang.localeCompare(c.datang) || a.ke.localeCompare(c.ke, 'id', { numeric: true }));
  }
  // Diterima di Odoo melebihi total kedatangan yang dikonfirmasi website (stok terkini belum bertambah untuk selisihnya)
  function incOdooGap(po, code, s) {
    if (!P.stockDate || !s.date || s.date < P.stockDate) return 0;
    const g = (Number(s.rec) || 0) - incArrOf(po, code, s.n).reduce((t, a) => t + a.qty, 0);
    return g > 1e-6 ? round4(g) : 0;
  }
  // Selisih Diterima Odoo dicatat sebagai kedatangan (tanpa mengubah kolom Diterima — sudah terisi dari Odoo)
  function incOdooDialog(po, code, n, gap) {
    if (!P.hasIncK) { toast('Apps Script MRP perlu diperbarui (versi dengan konfirmasi incoming).'); return; }
    needEdit(() => {
      const pr = state.rows.find((x) => x.po === po && x.code === code && x.sched && x.sched.some((y) => String(y.n) === String(n)));
      const sc = pr ? pr.sched.find((y) => String(y.n) === String(n)) : null, today = todayStr();
      const arr = incArrOf(po, code, n), main = P.incKMap.get(po + '|' + code + '|' + n);
      const ke = !main ? String(n) : `${n}#${arr.reduce((t, a) => Math.max(t, Number(a.ke.split('#')[1]) || 1), 1) + 1}`;
      openDialog({
        title: `Catat kedatangan dari Diterima Odoo · ${po}`, ok: 'Catat',
        body: `<p class="dlg-lead"><b>${esc(code)}</b> ${esc(pr ? pr.name : '')} · jadwal ke-${esc(n)}${sc && sc.date ? ' · ' + fmtDate(sc.date) : ''}. Diterima di Odoo ${fmtNum(sc ? sc.rec : 0)}, yang sudah dikonfirmasi di website ${fmtNum(arr.reduce((t, a) => t + a.qty, 0))}.</p>
          <div class="form-grid">${fld('qty', 'Qty datang *', String(gap), { type: 'number', step: 'any', required: true })}${fld('datang', 'Tanggal datang *', sc && sc.date && sc.date <= today ? sc.date : today, { type: 'date', required: true })}</div>
          <p class="hint">Kolom Diterima di Monitoring PO tidak diubah (sudah terisi dari Odoo). Stok terkini bertambah sebesar qty ini sampai ada upload stok dengan tanggal ≥ tanggal datang.</p>`,
        onSubmit: async (fd) => {
          const qty = Number(fd.qty), dt = String(fd.datang || '');
          if (!(qty > 0) || qty > gap + 1e-9) throw new Error(`Qty harus lebih dari 0 dan maksimal ${fmtNum(gap)}.`);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dt) || dt > today) throw new Error('Tanggal datang wajib diisi dan tidak boleh setelah hari ini.');
          if (main && !main.datang) await mrpApi('setIncK', { po, kode: code, ke: String(n), qty: 0 });   // konfirmasi rencana lama digantikan kedatangan ini
          const res = await mrpApi('setIncK', { po, kode: code, ke: main && !main.datang ? String(n) : ke, qty, tgl: sc ? sc.date || '' : '', note: 'Dari Diterima Odoo', bulan: '', week: '', datang: dt });
          setIncK(res.incK || []);
          setTimeout(() => { if (state.routeKey === 'po/monitoring') render(); if (PLAN_KEYS.has(state.routeKey)) renderPlanView(state.routeKey); }, 0);
          return 'Kedatangan dicatat.';
        },
      });
    });
  }
  function incArrDialog(po, code, n, ke, after) {
    if (!P.hasIncK) { toast('Apps Script MRP perlu diperbarui (versi dengan konfirmasi incoming).'); return; }
    needEdit(() => {
      const pr = state.rows.find((x) => x.po === po && x.code === code && x.sched && x.sched.some((y) => String(y.n) === String(n)));
      const sc = pr ? pr.sched.find((y) => String(y.n) === String(n)) : null;
      if (!sc) { toast('Jadwal PO tidak ditemukan. Muat ulang data lalu coba lagi.'); return; }
      const k = ke ? P.incKMap.get(po + '|' + code + '|' + ke) : null, m = MRP.master.get(code) || {}, today = todayStr();
      const sisa = round4((Number(sc.qty) || 0) - (Number(sc.rec) || 0)), maxQ = round4(sisa + (k ? k.qty : 0));
      const arr = incArrOf(po, code, n);
      const nextKe = ke || `${n}#${arr.reduce((t, a) => Math.max(t, Number(a.ke.split('#')[1]) || 1), 1) + 1}`;
      openDialog({
        title: `${k ? 'Ubah kedatangan' : 'Kedatangan berikutnya'} · ${po}`, ok: 'Simpan kedatangan',
        body: `<p class="dlg-lead"><b>${esc(code)}</b> ${esc(m.name || pr.name || '')} · jadwal ke-${esc(n)} · ${sc.date ? fmtDate(sc.date) : 'tanpa tanggal'} · qty jadwal ${fq(sc.qty)} · sudah diterima ${fq(sc.rec || 0)} · sisa <b>${fq(sisa)} ${esc(m.uom || pr.uom || '')}</b></p>
          ${arr.length ? `<p class="hint">Kedatangan tercatat: ${arr.map((a) => `${fmtDate(a.datang)} ${fq(a.qty)}${a.ke === ke ? ' (yang diubah)' : ''}`).join(' · ')}</p>` : ''}
          <div class="form-grid">${fld('qty', `Qty datang (${esc(m.uom || pr.uom || '')}) *`, k ? String(k.qty) : String(sisa), { type: 'number', step: 'any', required: true })}
          ${fld('datang', 'Tanggal datang *', k ? k.datang : today, { type: 'date', required: true })}
          ${fld('note', 'Catatan', k ? k.note : '', { wide: true })}</div>
          ${!state.edit.on ? `<div class="form-grid">${fld('popin', 'PIN Monitoring PO (untuk mengisi Diterima)', '', { type: 'password', required: true })}</div>` : ''}
          ${k ? '<label class="chk"><input type="checkbox" name="hapus" value="1"> Hapus kedatangan ini (Diterima di Monitoring PO dikurangi lagi)</label>' : ''}
          <p class="hint">Kolom Diterima di Monitoring PO bertambah sebesar qty ini; jadwal otomatis Done bila total diterima ≥ qty jadwal. Stok terkini bertambah sampai ada upload stok dengan tanggal ≥ tanggal datang. Sisa jadwal tetap Incoming di tanggal jadwal yang sama.</p>`,
        onSubmit: async (fd) => {
          const del = fd.hapus === '1', qty = del ? 0 : Number(fd.qty), dt = String(fd.datang || '');
          if (!del && !(qty > 0)) throw new Error('Isi qty lebih dari 0, atau centang "Hapus kedatangan ini".');
          if (qty > maxQ + 1e-9) throw new Error(`Qty melebihi sisa jadwal (${fq(maxQ)}).`);
          if (!del && (!/^\d{4}-\d{2}-\d{2}$/.test(dt) || dt > today)) throw new Error('Tanggal datang wajib diisi dan tidak boleh setelah hari ini.');
          const recDelta = qty - (k ? k.qty : 0);
          if (Math.abs(recDelta) > 1e-9) {
            const pinOld = state.edit.pin;
            if (!state.edit.on) { state.edit.pin = String(fd.popin || '').trim(); if (!state.edit.pin) throw new Error('Isi PIN Monitoring PO untuk mengisi kolom Diterima.'); }
            try {
              const rec = Math.max(0, round4((Number(sc.rec) || 0) + recDelta)), q = Number(sc.qty) || 0;
              const status = rec >= q - 1e-9 ? 'Done' : (sc.status === 'Done' ? 'Waiting for Shipment' : sc.status || 'Confirmed');
              const r2 = await api('saveSched', { key: { po, code, n: Number(n) }, data: { po, code, name: pr.name, date: sc.date, status, qty: q, rec } });
              applyServerUpdate(r2);
            } finally { if (!state.edit.on) state.edit.pin = pinOld; }
          }
          const res = await mrpApi('setIncK', { po, kode: code, ke: nextKe, qty, tgl: sc.date || '', note: (fd.note || '').trim(), bulan: '', week: '', datang: del ? '' : dt });
          setIncK(res.incK || []);
          setTimeout(() => { if (PLAN_KEYS.has(state.routeKey)) renderPlanView(state.routeKey); if (state.routeKey === 'po/monitoring') render(); if (after) after(); }, 0);
          return del ? 'Kedatangan dihapus.' : 'Kedatangan tersimpan & Diterima di Monitoring PO diperbarui.';
        },
      });
    });
  }
  // Dialog isi qty konfirmasi satu jadwal; after() dipanggil setelah tersimpan (mis. buka lagi rincian)
  function incKDialog(po, code, ke, date, sisa, after) {
    if (!P.hasIncK) { toast('Apps Script MRP perlu diperbarui (versi dengan konfirmasi incoming).'); return; }
    if (String(ke).includes('#')) { const [n] = String(ke).split('#'); incArrDialog(po, code, n, ke, after); return; }
    needEdit(() => {
      const k = P.incKMap.get(po + '|' + code + '|' + ke), m = MRP.master.get(code) || {}, today = todayStr();
      const pr = state.rows.find((x) => x.po === po && x.code === code && x.sched && x.sched.some((y) => String(y.n) === String(ke)));
      const sc = pr ? pr.sched.find((y) => String(y.n) === String(ke)) : null;
      const wasRecv = !!(k && k.datang), maxQ = sisa + (wasRecv ? k.qty : 0);   // konfirmasi "sudah datang" lama sudah masuk Diterima
      // pilihan week datang: week berjalan s.d. ±6 bulan; default = pilihan lama / week tanggal jadwal (bila belum lewat) / week berjalan
      const opts = P.weeks.filter((w) => w.end >= today && w.bulan <= addMonth(today.slice(0, 7), 6));
      const sw = date && date >= today ? weekOfDate(date) : null, cur = opts[0];
      const defKey = k && k.week ? k.bulan + '|' + k.week : sw ? sw.bulan + '|' + sw.week : cur ? cur.bulan + '|' + cur.week : '';
      const late = !date || date < today;
      openDialog({
        title: `Konfirmasi incoming · ${po}`, ok: 'Simpan konfirmasi',
        body: `<p class="dlg-lead"><b>${esc(code)}</b> ${esc(m.name || '')} · jadwal ke-${esc(ke)} · ${date ? fmtDate(date) : 'tanpa tanggal'} · sisa jadwal <b>${fq(sisa)} ${esc(m.uom || '')}</b></p>
          ${late ? '<p class="check err">Jadwal ini sudah lewat tanggal. Pilih perkiraan week barang datang.</p>' : ''}
          <div class="form-grid">${fld('qty', `Qty yang dikonfirmasi datang (${esc(m.uom || '')}) *`, k ? String(k.qty) : String(round4(sisa)), { type: 'number', step: 'any', required: true })}
          <label class="field"><span>Perkiraan week datang *</span><select name="wk">${opts.map((w) => `<option value="${w.bulan}|${w.week}"${w.bulan + '|' + w.week === defKey ? ' selected' : ''}>${esc(wLabel(w))} ${w.bulan.slice(0, 4)} · ${fmtDate(w.start).slice(0, 6)}–${fmtDate(w.end).slice(0, 6)}${sw && w === sw ? ' (tanggal jadwal)' : ''}${w === cur ? ' (week berjalan)' : ''}</option>`).join('')}</select></label>
          ${fld('note', 'Catatan', k ? k.note : '', { wide: true })}</div>
          <label class="chk pj-datang"><input type="checkbox" name="datang" value="1"${wasRecv ? ' checked' : ''}${sc ? '' : ' disabled'}> <span><b>Sudah datang hari ini</b> — kolom Diterima di Monitoring PO ikut terisi qty ini${sc ? '' : ' (jadwal tidak ditemukan di data PO)'}</span></label>
          ${!state.edit.on ? `<div class="form-grid pj-popin" hidden>${fld('popin', 'PIN Monitoring PO (untuk mengisi Diterima)', '', { type: 'password' })}</div>` : ''}
          ${k ? `<label class="chk"><input type="checkbox" name="hapus" value="1"> Batalkan konfirmasi ini${wasRecv ? ' (Diterima di Monitoring PO dikurangi lagi)' : ''}</label>` : ''}
          <p class="hint">Qty maksimal sebesar sisa jadwal. Incoming masuk ke week datang yang dipilih dan ikut berkurang bila sisa jadwal berkurang (barang sudah diterima). Bila week datang sudah lewat dan barang belum diterima, incoming otomatis pindah ke week berjalan.</p>`,
        onSubmit: async (fd) => {
          const del = fd.hapus === '1', qty = del ? 0 : Number(fd.qty), recv = !del && fd.datang === '1';
          if (!del && !(qty > 0)) throw new Error('Isi qty lebih dari 0, atau centang "Batalkan konfirmasi".');
          if (qty > maxQ + 1e-9) throw new Error(`Qty melebihi sisa jadwal (${fq(maxQ)}).`);
          // Diterima di Monitoring PO: tambah qty baru, kurangi qty "sudah datang" lama (bila ada)
          const recDelta = (recv ? qty : 0) - (wasRecv ? k.qty : 0);
          if (Math.abs(recDelta) > 1e-9) {
            if (!sc) throw new Error('Jadwal PO tidak ditemukan. Muat ulang data lalu coba lagi.');
            const pinOld = state.edit.pin;
            if (!state.edit.on) { state.edit.pin = String(fd.popin || '').trim(); if (!state.edit.pin) throw new Error('Isi PIN Monitoring PO untuk mengisi kolom Diterima.'); }
            try {
              const rec = Math.max(0, round4((Number(sc.rec) || 0) + recDelta)), q = Number(sc.qty) || 0;
              const status = rec >= q - 1e-9 ? 'Done' : (sc.status === 'Done' ? 'Waiting for Shipment' : sc.status || 'Confirmed');
              const r2 = await api('saveSched', { key: { po, code, n: Number(ke) }, data: { po, code, name: pr.name, date: sc.date, status, qty: q, rec } });
              applyServerUpdate(r2);
            } finally { if (!state.edit.on) state.edit.pin = pinOld; }
          }
          const [wb, ww] = String(fd.wk || '|').split('|'), sameAsSched = sw && wb === sw.bulan && ww === sw.week;
          const res = await mrpApi('setIncK', { po, kode: code, ke, qty, tgl: date || '', note: (fd.note || '').trim(), bulan: recv || sameAsSched ? '' : wb, week: recv || sameAsSched ? '' : ww, datang: recv ? (wasRecv ? k.datang : today) : '' });
          setIncK(res.incK || []);
          setTimeout(() => { if (PLAN_KEYS.has(state.routeKey)) renderPlanView(state.routeKey); if (state.routeKey === 'po/monitoring') render(); if (after) after(); }, 0);
          return del ? 'Konfirmasi dibatalkan.' : recv ? 'Incoming dikonfirmasi & Diterima di Monitoring PO diisi.' : 'Incoming dikonfirmasi.';
        },
      });
      const b = $('dlgBody'), cb = b.querySelector('[name=datang]'), pin = b.querySelector('.pj-popin');
      const sync = () => { if (pin) pin.hidden = !cb.checked || (wasRecv && cb.checked); const wk = b.querySelector('[name=wk]'); if (wk) wk.closest('.field').hidden = cb.checked; };
      if (cb) { cb.addEventListener('change', sync); sync(); }
      const hp = b.querySelector('[name=hapus]');
      if (hp && wasRecv && pin) hp.addEventListener('change', () => { pin.hidden = !hp.checked && !(cb.checked !== wasRecv); });
    });
  }
  async function incKDelete(po, code, ke, after) {
    if (!P.hasIncK) return;
    const kk = P.incKMap && P.incKMap.get(po + '|' + code + '|' + ke);
    if (kk && kk.datang) { incKDialog(po, code, ke, kk.tgl, 0, after); return; }
    needEdit(async () => {
      try { const res = await mrpApi('setIncK', { po, kode: code, ke, qty: 0 }); setIncK(res.incK || []); toast('Konfirmasi dihapus.'); if (PLAN_KEYS.has(state.routeKey)) renderPlanView(state.routeKey); if (after) after(); }
      catch (err) { toast('Gagal: ' + err.message); }
    });
  }
  // Klik tombol konfirmasi di mana pun (rincian material, daftar week, Monitoring PO)
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-inck]');
    if (b) {
      e.preventDefault(); e.stopPropagation();
      const [po, code, ke] = b.dataset.inck.split('|'), back = b.closest('#dlgBody') ? (P.incKBack || null) : null;
      incKDialog(po, code, ke, b.dataset.inckDate, Number(b.dataset.inckSisa) || 0, back);
      return;
    }
    const o = e.target.closest('[data-incodoo]');
    if (o) { e.preventDefault(); e.stopPropagation(); const [po, code, n, q] = o.dataset.incodoo.split('|'); incOdooDialog(po, code, n, Number(q)); return; }
    const a = e.target.closest('[data-incarr]');
    if (a) { e.preventDefault(); e.stopPropagation(); const [po, code, n] = a.dataset.incarr.split('|'); incArrDialog(po, code, n, null, a.closest('#dlgBody') ? (P.incKBack || null) : null); return; }
    const d = e.target.closest('[data-inck-del]');
    if (d) { const [po, code, ke] = d.dataset.inckDel.split('|'); incKDelete(po, code, ke, d.closest('#dlgBody') ? P.incKBack : null); }
  }, true);
  // Daftar jadwal PO di satu week untuk satu material (klik sel PO / Incoming)
  function pjWeekPoDialog(code, j) {
    const J = computeProj(pjOpt()); P.proj = J;
    const r = J.rows.find((x) => x.code === code); if (!r || !r.po) return;
    const w = J.weeks[j], L = r.po.list.filter((x) => (x.kind === 'w' && x.i === j) || x.incI === j).sort((a, b) => (a.date < b.date ? -1 : 1));
    P.incKBack = () => pjWeekPoDialog(code, j);
    openDialog({
      title: `${r.code} · PO ${wLabel(w)} ${w.bulan.slice(0, 4)}`, ok: 'Tutup', wide: true, cancel: false, onSubmit: null,
      body: `<p class="dlg-lead">${esc(r.name)} · ${esc(wTitle(w))} · PO terjadwal di week ini <b>${fq(r.po.w[j])}</b> · Incoming dikonfirmasi <b>${fq(r.inW[j] || 0)}</b> ${esc(r.uom)}</p>
        <div class="table-wrap"><table class="po-table pl-mini"><thead><tr><th>No PO</th><th>Supplier</th><th>Jadwal ke</th><th>Tgl jadwal</th><th class="num">Qty</th><th class="num">Diterima</th><th class="num">Sisa</th><th>Konfirmasi incoming</th></tr></thead><tbody>
        ${L.map((x) => `<tr><td><button type="button" class="btn-link pr-po" data-gopo="${esc(x.po)}" data-gocode="${esc(r.code)}">${esc(x.po)}</button></td><td>${esc(x.supplier)}</td><td class="num">${esc(x.ke)}</td><td>${fmtDate(x.date)}</td>
          <td class="num">${fq(x.qty)}</td><td class="num">${x.rec ? fq(x.rec) : ''}</td><td class="num"><b>${fq(x.sisa)}</b></td><td>${incKCell(x, r.code)}</td></tr>`).join('')}
        </tbody></table></div>${P.edit ? '' : '<p class="hint">Konfirmasi memakai Mode edit (PIN MRP).</p>'}`,
    });
  }
  function pjPoListHtml(r, weeks) {
    const L = r.po ? r.po.list.slice() : [];
    const ord = { late: 0, w: 1, out: 2, none: 3 };
    L.sort((a, b) => ord[a.kind] - ord[b.kind] || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const ket = (x) => (x.kind === 'late' ? '<span class="badge b-late">Lewat tanggal</span>' : x.kind === 'none' ? '<span class="badge b-none">Belum dijadwalkan</span>'
      : x.kind === 'out' ? `<span class="muted">${P.pjAfter && x.date > P.pjAfter.end ? 'PO ' + esc(P.pjAfter.label) + ' dst' : 'di luar rentang'}</span>` : esc(wLabel(weeks[x.i])));
    const uomBad = L.filter((x) => x.uom && r.uom && normU(x.uom) !== normU(r.uom));
    const F = r.po ? r.po.kFlags : [], RV = r.po && r.po.recv ? r.po.recv : [];
    const recvHtml = RV.length ? `<h3 class="pj-h">Sudah datang (dikonfirmasi) <small class="muted">menambah stok sampai stok baru di-upload</small></h3><ul class="pj-list">${RV.map((x) => `<li><b>${esc(x.po)}</b> jadwal ke-${esc(String(x.ke).replace('#', ' · kedatangan ke-'))} · ${esc(x.supplier)} · datang ${fmtDate(x.datang)} · <b>+${fq(x.konf)}</b> ${x.inStock ? '<span class="muted">(sudah termasuk stok per ' + fmtDate(P.stockDate) + ', tidak dihitung lagi)</span>' : (x.incI !== undefined && P.proj ? '→ Incoming ' + esc(wLabel(P.proj.weeks[x.incI])) : '')} <button type="button" class="pj-kbtn is-on" data-inck="${esc(x.po)}|${esc(r.code)}|${esc(x.ke)}" data-inck-date="${esc(x.date || '')}" data-inck-sisa="0">Ubah</button></li>`).join('')}</ul>` : '';
    return recvHtml + `<h3 class="pj-h">PO (${L.length}) <small class="muted">hanya jadwal yang dikonfirmasi menambah saldo (Incoming)</small></h3>` + (L.length ? `<div class="table-wrap"><table class="po-table pl-mini"><thead><tr><th>No PO</th><th>Supplier</th><th>Tgl jadwal</th><th>Masuk ke</th><th class="num">Qty</th><th class="num">Diterima</th><th class="num">Sisa</th><th>UoM</th><th>Konfirmasi incoming</th></tr></thead><tbody>
      ${L.map((x) => `<tr><td><button type="button" class="btn-link pj-golink" data-gopo="${esc(x.po)}" data-gocode="${esc(r.code)}" title="Buka ${esc(x.po)} di Monitoring PO"><b>${esc(x.po)}</b></button></td><td>${esc(x.supplier)}</td><td>${x.date ? fmtDate(x.date) : '<span class="muted">–</span>'}</td><td>${ket(x)}</td>
        <td class="num">${x.kind === 'none' ? `${fq(x.qty)} <small class="muted">order, ${fq(x.sch)} terjadwal</small>` : fq(x.qty)}</td><td class="num">${x.rec ? fq(x.rec) : ''}</td><td class="num"><b>${fq(x.sisa)}</b></td>
        <td${x.uom && r.uom && normU(x.uom) !== normU(r.uom) ? ' class="pl-bad" title="UoM PO berbeda dengan UoM material"' : ''}>${esc(x.uom || '')}</td>
        <td>${incKCell(x, r.code)}</td></tr>`).join('')}
      </tbody></table></div>${uomBad.length ? `<p class="pl-bad">UoM PO berbeda dengan UoM material (${esc(r.uom)}). Periksa satuannya.</p>` : ''}` : '<p class="muted">Tidak ada PO terbuka untuk material ini.</p>')
      + (F.length ? `<p class="pl-bad">Konfirmasi incoming yang tidak dihitung: ${F.map((f) => `${esc(f.po)} jadwal ${esc(f.ke)} (${fq(f.konf)}) — ${esc(f.t)}${P.edit && P.incKMap && P.incKMap.has(f.po + '|' + r.code + '|' + f.ke) ? ` <button type="button" class="btn-link danger" data-inck-del="${esc(f.po)}|${esc(r.code)}|${esc(f.ke)}">Hapus konfirmasi</button>` : ''}`).join('; ')}</p>` : '');
  }
  function pjMoListHtml(r, weeks) {
    const by = new Map();
    r.moList.forEach((x) => { const k = x.mo; const o = by.get(k) || { mo: x.mo, sku: x.sku, i: x.i, pc: 0, cp: 0 }; o[x.jenis === 'CP' ? 'cp' : 'pc'] += x.qty; by.set(k, o); });
    const list = [...by.values()].sort((a, b) => a.i - b.i || a.mo.localeCompare(b.mo, 'id', { numeric: true }));
    const name = (c) => ((P.skus.get(c) || MRP.master.get(c) || {}).name || '');
    return `<h3 class="pj-h">Rincian per No MO (${list.length})</h3>` + (list.length ? `<div class="table-wrap"><table class="po-table pl-mini"><thead><tr><th>No MO</th><th>Kode SKU</th><th>Week</th><th class="num">PC</th><th class="num">CP</th><th class="num">PC + CP</th></tr></thead><tbody>
      ${list.map((o) => `<tr><td><b>${esc(o.mo)}</b></td><td><span class="pl-code">${esc(o.sku)}</span> <span class="muted">${esc(name(o.sku))}</span></td><td>${esc(wLabel(weeks[o.i]))}</td><td class="num">${o.pc ? fq(o.pc) : ''}</td><td class="num">${o.cp ? fq(o.cp) : ''}</td><td class="num"><b>${fq(o.pc + o.cp)}</b></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">Tidak ada MO yang memakai material ini.</p>');
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
  /* ---------- Plotting Harian: 1 MO = 1 tanggal produksi; kebutuhan & saldo stok per hari ---------- */
  const HARI = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
  const dayList = (w) => { const out = []; const [y, m, d] = w.start.split('-').map(Number); for (let t = new Date(y, m - 1, d); ymd(t) <= w.end; t.setDate(t.getDate() + 1)) out.push(ymd(t)); return out; };
  const dayLbl = (ds) => { const [y, m, d] = ds.split('-').map(Number); return `${HARI[new Date(y, m - 1, d).getDay()]} ${d} ${monShort(ds.slice(0, 7))}`; };
  const moQ = (r) => (planUnit(r.code) === 'pcs' ? Number(r.qty) || 0 : Number(r.kg) || 0);
  function phWeek() {
    const sel = $('phWeek'), today = todayStr();
    if (!sel.options.length) {
      const cur = weekOfDate(today);
      sel.innerHTML = P.weeks.map((w) => `<option value="${w.bulan}|${w.week}">${esc(wLabel(w))} ${w.bulan.slice(0, 4)} · ${fmtDate(w.start).slice(0, 6)}–${fmtDate(w.end).slice(0, 6)}</option>`).join('');
      if (cur) sel.value = cur.bulan + '|' + cur.week;
    }
    return P.weekBy.get(sel.value) || null;
  }
  // Hitung harian untuk 1 week: kebutuhan per tanggal (MO bertanggal → tanggalnya; MO tanpa tanggal & sisa plan → hari pertama),
  // incoming (tanggal datang → tanggalnya; selebihnya hari pertama), ADD/FOH/RS (tanggalnya). Saldo awal = saldo Proyeksi Stok akhir week sebelumnya.
  /* Plotting Harian basis "MO": sama dengan Stok terkini / Formulir PR — hanya MO Plotting Harian (plan per week tidak dihitung).
   * Saldo awal week = stok upload + koreksi − gantung + incoming − pemakaian MO − ADD/FOH/RS dari tanggal stok s/d sehari sebelum week.
   * Banded / 2in1 / KIT tidak dihitung. MO tanpa tanggal di week ini = "Belum dijadwalkan". */
  function harianCalcMo(wk) {
    const days = dayList(wk), nd = days.length, today = todayStr();
    const dates = [...(P.stockHist || new Map()).keys()].filter((d) => d <= today).sort();
    const d0 = dates.pop() || P.stockDate || '';
    const keep = P.pjCalc; P.pjCalc = 'plan';
    let J; try { J = computeProj({ weeks: [wk], all: false }); } finally { P.pjCalc = keep; }
    if (!d0 || wk.end < d0) return { days, J, j: 0, rows: [], before: true };
    const ws = wk.start, sh = (P.stockHist || new Map()).get(d0) || new Map();
    const M = new Map(), mk = (c) => { let o = M.get(c); if (!o) { o = { pre: 0, need: new Array(nd + 1).fill(0), inc: new Array(nd).fill(0), out: new Array(nd).fill(0), preIn: 0, preOut: 0, src: [], det: [] }; M.set(c, o); } return o; };
    const di = (t) => days.indexOf(t);
    P.konf.forEach((r) => {
      if (kfIsEk(r.code) || planUnit(r.code) === 'pcs') return;
      const q = Number(r.kg) || 0; if (!(q > 0)) return;
      const t = r.tgl || '';
      let at;   // -1 = sebelum week (memotong saldo awal), 0..nd-1 = hari, nd = belum dijadwalkan
      if (t) { if (t < d0 || t > wk.end) return; at = t < ws ? -1 : di(t); if (at < 0 && t >= ws) return; }
      else if (r.bulan === wk.bulan && r.week === wk.week) at = nd;
      else { const w0 = P.weekBy && P.weekBy.get(r.bulan + '|' + r.week); if (w0 && w0.start < ws && w0.end >= d0) at = -1; else return; }   // MO belum bertanggal di week sebelumnya: tetap memotong saldo awal
      const n = needOf(r.code, q, r.bom || undefined); if (!n) return;
      const lbl = `MO ${r.no} · ${r.code} ${fmtKg(q)} kg${t ? '' : ' (belum bertanggal)'}`;
      n.leaves.forEach((v, c) => {
        const o = mk(c);
        if (at === -1) { o.pre += v; return; }
        if (at < 0 || t && t < d0) return;
        o.need[at] += v;
        // rincian per MO untuk dialog Keluar: MO, SKU, qty MO, BoM MO, pemakaian material
        (o.det[at] || (o.det[at] = [])).push({ no: r.no, sku: r.code, name: r.name || (P.skus.get(r.code) || MRP.master.get(r.code) || {}).name || '', kg: q, tgl: t, bom: n.bom || null, v });
        void lbl;
      });
    });
    (P.incK || []).forEach((x) => { const d = x.datang || x.tgl; if (!d || d < d0 || d > wk.end) return; const o = mk(x.code); if (d < ws) o.preIn += x.qty; else { const i = di(d); if (i >= 0) o.inc[i] += x.qty; } });
    (P.kurang || []).forEach((x) => { const d = x.tgl; if (!d || d < d0 || d > wk.end) return; const o = mk(x.code); if (d < ws) o.preOut += x.qty; else { const i = di(d); if (i >= 0) o.out[i] += x.qty; } });
    const jr = new Map(J.rows.map((r) => [r.code, r]));
    const rows = [];
    M.forEach((o, code) => {
      const wNeed = o.need.reduce((t, x) => t + x, 0), wIn = o.inc.reduce((t, x) => t + x, 0), wOut = o.out.reduce((t, x) => t + x, 0);
      if (!(wNeed || wIn || wOut)) return;
      if (isFg(code) || kfIsEk(code)) return;
      const m = MRP.master.get(code) || {}, st = sh.get(code), r0 = jr.get(code) || {};
      const awal = (st ? st.qty : 0) + P.adj.filter((a) => a.code === code && a.date >= d0).reduce((t, a) => t + a.qty, 0) - ((P.gantung && P.gantung.get(code)) || 0);
      const open = awal + o.preIn - o.pre - o.preOut;
      const un = o.need[nd], inclUn = !!P.phInclUn, sal = []; let run = open, short = -1;
      for (let i = 0; i < nd; i++) {
        if (days[i] < d0) { sal.push(null); continue; }
        run += o.inc[i] - o.need[i] - o.out[i] - (inclUn && i === 0 ? un : 0); sal.push(run); if (run < -1e-9 && short < 0) short = i;
      }
      const end = open + wIn - wNeed - wOut;
      if (short < 0 && end < -1e-9) short = nd;
      rows.push({ code, name: m.name || (st && st.name) || code, uom: m.uom || (st && st.uom) || '', kat: m.kat || '', po: r0.po || null, open, need: o.need, un, end, inc: o.inc, out: o.out, sal, short, wNeed, src: o.src, det: o.det, fix: 0 });
    });
    return { days, J, j: 0, rows, before: false, d0 };
  }
  function harianCalc(wk, basis) {
    if (basis !== 'cons') return harianCalcMo(wk);
    // index nd = "Belum dijadwalkan" (sisa plan tanpa MO, MO tanpa tanggal) — tidak dipotong per hari kecuali P.phInclUn
    const days = dayList(wk), nd = days.length, di = (t) => { const i = t ? days.indexOf(t) : -1; return i < 0 ? nd : i; };
    const weeks = P.weeks.filter((w) => w.start <= wk.end && (!P.stockDate || w.end >= P.stockDate));
    const keep = P.pjCalc; P.pjCalc = basis === 'cons' ? 'mo' : 'plan';
    let J;
    try { J = computeProj({ weeks: weeks.length ? weeks : [wk] }); } finally { P.pjCalc = keep; }
    const j = J.R.idx.get(wk.bulan + '|' + wk.week);
    // src: kode → index hari → Map(label → qty), untuk rincian "Keluar" saat sel diklik
    const need = new Map(), src = new Map(), add = (code, i, q, lbl) => { if (!q) return; let a = need.get(code); if (!a) need.set(code, (a = new Array(nd + 1).fill(0))); a[i] += q;
      if (lbl) { let m = src.get(code); if (!m) src.set(code, (m = [])); const d = m[i] || (m[i] = new Map()); d.set(lbl, (d.get(lbl) || 0) + q); } };
    const moDay = new Map();   // no MO → index hari
    if (basis === 'cons') {
      (P.cons || []).forEach((c) => {
        if (!c.mat || consSkip(c.mat)) return;
        const k = P.konf.get(c.mo); if (!k || k.bulan !== wk.bulan || k.week !== wk.week) return;
        add(c.mat, di(k.tgl), c.qty, `MO ${c.mo} · ${c.sku || k.code} · ${c.jenis}${k.tgl ? '' : ' (belum bertanggal)'}`);
      });
    } else {
      const kc = konfByCell(), runN = (code, i, q, bom, lbl) => { const r = needOf(code, q, bom); if (r) r.leaves.forEach((v, c) => add(c, i, v, lbl)); };
      P.plan.forEach((p) => {
        if (p.bulan !== wk.bulan || p.week !== wk.week || !(p.kg > 0)) return;
        const k = kc.get(`${p.bulan}|${p.week}|${p.code}`), rest = p.kg - (k ? k.q : 0);
        if (rest > 1e-9) runN(p.code, nd, rest, p.bom, `Sisa plan ${p.code} ${fmtKg(rest)} ${planUnit(p.code) === 'pcs' ? 'pcs' : 'kg'}${k ? ` (plan ${fmtKg(p.kg)} − MO ${fmtKg(k.q)})` : ' (belum ada MO)'}`);
      });
      P.konf.forEach((r) => {
        if (r.bulan !== wk.bulan || r.week !== wk.week || kfIsEk(r.code)) return;
        const q = moQ(r); if (q > 0) runN(r.code, di(r.tgl), q, r.bom || undefined, `MO ${r.no} · ${r.code} ${fmtKg(q)} ${planUnit(r.code) === 'pcs' ? 'pcs' : 'kg'}${r.tgl ? '' : ' (belum bertanggal)'}`);
      });
    }
    P.konf.forEach((r) => { if (r.bulan === wk.bulan && r.week === wk.week) moDay.set(r.no, r.tgl ? di(r.tgl) : -1); });
    if (j === undefined) return { days, J, j, rows: [], before: true };
    const rows = [];
    J.rows.forEach((r) => {
      const wNeed = J.moMode ? r.pc[j] + r.cp[j] : r.need[j], wIn = r.inW[j], wOut = r.outW[j];
      const dn = (need.get(r.code) || new Array(nd + 1).fill(0)).slice();
      const sn = dn.reduce((t, x) => t + x, 0); if (Math.abs(wNeed - sn) > 1e-6) dn[nd] += wNeed - sn;   // selaras dengan Proyeksi Stok
      const dIn = new Array(nd).fill(0), dOut = new Array(nd).fill(0);
      let dated = 0;
      (P.incK || []).forEach((x) => { if (x.code === r.code && x.datang && days.includes(x.datang)) { dIn[days.indexOf(x.datang)] += x.qty; dated += x.qty; } });
      if (dated > wIn + 1e-9) { dIn.fill(0); dIn[0] = wIn; } else dIn[0] += wIn - dated;
      let dOutDated = 0;
      (P.kurang || []).forEach((x) => { if (x.code === r.code && days.includes(x.tgl)) { dOut[days.indexOf(x.tgl)] += x.qty; dOutDated += x.qty; } });
      dOut[0] += Math.max(0, wOut - dOutDated);
      if (!(wNeed || wIn || wOut) && !r.used) return;
      if (!(wNeed || wIn || wOut)) return;
      const open = j === J.s ? r.start : j > J.s ? r.saldo[j - 1] : null;
      const un = dn[nd], inclUn = !!P.phInclUn;
      const sal = []; let run = open, short = -1;
      for (let i = 0; i < nd; i++) { if (run === null) { sal.push(null); continue; } run += dIn[i] - dn[i] - dOut[i] - (inclUn && i === 0 ? un : 0); sal.push(run); if (run < -1e-9 && short < 0) short = i; }
      const end = open === null ? null : open + dIn.reduce((t, x) => t + x, 0) - dn.reduce((t, x) => t + x, 0) - dOut.reduce((t, x) => t + x, 0);
      if (short < 0 && end !== null && end < -1e-9) short = nd;
      rows.push({ code: r.code, name: r.name, uom: r.uom, kat: r.kat, po: r.po, open, need: dn, un, end, inc: dIn, out: dOut, sal, short, wNeed, src: src.get(r.code) || [], fix: Math.abs(wNeed - sn) > 1e-6 ? wNeed - sn : 0 });
    });
    return { days, J, j, rows, before: j < J.s };
  }
  // Batch ekstrak → MO SKU yang memakainya (kolom MO Ekstrak dipakai); dihitung ulang tiap 300 ms supaya ringan
  let phEkMap = null, phEkAt = 0;
  function phEkUsers() {
    if (!phEkMap || Date.now() - phEkAt > 300) { phEkMap = new Map(); kfRows().forEach((x) => { if (x.moEk) { const L = phEkMap.get(x.moEk) || []; L.push(x); phEkMap.set(x.moEk, L); } }); phEkAt = Date.now(); }
    return phEkMap;
  }
  function phChip(r, edit, extra) { const dirty = P.kfDraft.has(r.no) ? ' is-dirty' : '', ek = kfIsEk(r.code);
      let ekTxt = '', ekTip = '';
      if (ek) {
        const us = (phEkUsers().get(r.no) || []).slice().sort((a, b) => String(a.tgl || '9').localeCompare(String(b.tgl || '9')) || a.no.localeCompare(b.no, 'id', { numeric: true }));
        const cap = Number(r.kg !== '' ? r.kg : r.qty) || 0, used = us.reduce((t, x) => t + (Number(x.ekKg) || 0), 0);
        ekTxt = us.length ? `<span class="ph-ekf">untuk ${us.slice(0, 2).map((x) => esc(x.no)).join(', ')}${us.length > 2 ? ` +${us.length - 2}` : ''}${cap ? ` · ${nf.format(Math.round(used / cap * 100))}%` : ''}</span>` : '<span class="ph-ekf is-none">belum dipakai MO SKU</span>';
        ekTip = us.length ? ` · dipakai: ${us.map((x) => `${x.no} ${x.code} ${fmtKg(x.ekKg) || 0} kg${x.tgl ? ' (' + dayLbl(x.tgl) + ')' : ''}`).join('; ')}` : ' · belum dipakai MO SKU';
      } else if (r.ek) {
        ekTxt = r.moEk ? `<span class="ph-ekf">ekstrak ${esc(r.moEk)}</span>` : '<span class="ph-ekf is-none">ekstrak belum dipilih</span>';
        ekTip = r.moEk ? ` · pakai batch ekstrak ${r.moEk} (${fmtKg(r.ekKg) || 0} kg)` : ' · batch ekstrak belum dipilih';
      }
      return `<button type="button" class="ph-chip${dirty}${ek ? ' is-ek' : ''}${extra || ''}" data-no="${esc(r.no)}"${edit ? ' draggable="true"' : ''} title="${esc(r.no + ' · ' + r.code + ' ' + r.name + ekTip)}${edit ? ' · seret ke hari lain atau klik untuk ubah tanggal' : ''}"><b>${esc(r.no)}</b>${isMan(r.no) ? '<i class="kf-mant">M</i>' : ''} <small>${planUnit(r.code) === 'pcs' ? fmtQ(r.qty) + ' pcs' : (r.kg !== '' ? fmtKg(r.kg) : fmtQ(r.qty)) + ' kg'}</small><span class="ph-cc">${esc(r.code)} ${esc(r.name)}</span>${ekTxt}</button>`;
  }
  // Kolom Belum diplot: semua MO tanpa tanggal (semua week, tanpa week, termasuk ekstrak), dikelompokkan per week; punya kotak cari sendiri
  function phPaintUn() {
    const wk = phWeek(); if (!wk) return;
    const edit = P.edit && P.hasKonf, q1 = $('phQ').value.trim().toLowerCase(), q2 = $('phUnQ').value.trim().toLowerCase();
    const m = (r, q) => !q || (r.no + ' ' + r.code + ' ' + r.name + ' ' + (r.week ? r.week + ' ' + monShort(r.bulan) : 'tanpa week')).toLowerCase().includes(q);
    const allUn = kfRows().filter((r) => !r.tgl), un = allUn.filter((r) => m(r, q1) && m(r, q2));
    const today = todayStr(), grp = new Map();
    un.forEach((r) => { const k = r.week ? r.bulan + '|' + r.week : ''; if (!grp.has(k)) grp.set(k, []); grp.get(k).push(r); });
    const gInfo = (k) => {
      if (!k) return { ord: 3, lbl: 'Tanpa week', sub: '' };
      const w = P.weekBy.get(k), sel = k === wk.bulan + '|' + wk.week;
      const lbl = w ? `${wLabel(w)} ${w.bulan.slice(0, 4)}` : k.replace('|', ' ');
      if (sel) return { ord: 0, lbl, sub: 'week ini · dihitung di hari pertama' };
      if (w && w.end < today) return { ord: 2, lbl, sub: 'sudah lewat' };
      return { ord: 1, lbl, sub: '' };
    };
    const groups = [...grp.keys()].map((k) => Object.assign({ k, list: grp.get(k) }, gInfo(k)))
      .sort((a, b) => a.ord - b.ord || (a.ord === 2 ? b.k.localeCompare(a.k) : a.k.localeCompare(b.k)));
    groups.forEach((g) => g.list.sort((a, b) => a.no.localeCompare(b.no, 'id', { numeric: true })));
    const searching = !!(q1 || q2);
    $('phUnHead').innerHTML = `<b>Belum diplot · ${searching ? `${nf.format(un.length)} dari ` : ''}${nf.format(allUn.length)} MO</b><small>${edit ? 'Seret ke hari untuk memberi tanggal; week ikut berubah' : 'Masuk Mode edit untuk menyeret ke hari'}</small>`;
    $('phUnList').innerHTML = groups.map((g) => `<details class="ph-grp${g.ord === 2 ? ' is-past' : ''}"${searching || g.ord === 0 || groups.length <= 3 ? ' open' : ''}><summary><b>${esc(g.lbl)}</b> <span>${g.list.length} MO${g.sub ? ' · ' + esc(g.sub) : ''}</span></summary>${g.list.map((r) => phChip(r, edit, '')).join('')}</details>`).join('')
      || `<p class="ph-empty">${searching ? 'Tidak ada MO yang cocok.' : 'Semua MO sudah punya tanggal produksi.'}</p>`;
  }
  function renderHarian() {
    const wk = phWeek(); if (!wk) return;
    const edit = P.edit && P.hasKonf, basis = P.phBasis || 'plan';
    document.querySelectorAll('#phBasis [data-b]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.b === basis)));
    $('phBasis').querySelector('[data-b="cons"]').disabled = !P.hasCons;
    const nDirty = P.kfDraft.size + P.kfDel.size;
    $('phSaveBtn').hidden = !edit; $('phSaveBtn').disabled = !nDirty; $('phSaveBtn').textContent = nDirty ? `Simpan perubahan (${nDirty})` : 'Simpan perubahan';
    const all = kfRows(), days = dayList(wk), q = $('phQ').value.trim().toLowerCase();
    const inWk = all.filter((r) => r.bulan === wk.bulan && r.week === wk.week);
    const hit = (r) => !q || (r.no + ' ' + r.code + ' ' + r.name).toLowerCase().includes(q);
    const chip = (r) => phChip(r, edit, q ? (hit(r) ? ' is-hit' : ' is-dim') : '');
    const tot = (list) => { const kg = list.filter((r) => planUnit(r.code) !== 'pcs').reduce((t, r) => t + (Number(r.kg !== '' ? r.kg : r.qty) || 0), 0), pcs = list.filter((r) => planUnit(r.code) === 'pcs').reduce((t, r) => t + (Number(r.qty) || 0), 0);
      return [kg ? fmtKg(kg) + ' kg' : '', pcs ? fmtQ(pcs) + ' pcs' : ''].filter(Boolean).join(' · ') || '–'; };
    $('phBoard').classList.toggle('is-edit', edit); $('phBoard').classList.toggle('is-tall', !!P.phTall);
    $('phTall').textContent = P.phTall ? 'Ringkas papan' : 'Perbesar papan';
    $('phDays').innerHTML = days.map((d) => { const L = inWk.filter((r) => r.tgl === d); return `<div class="ph-day${d === todayStr() ? ' is-today' : ''}" data-day="${d}"><div class="ph-dh"><b>${esc(dayLbl(d))}</b><small>${L.length} MO · ${tot(L)}</small></div><div class="ph-list">${L.map(chip).join('') || '<p class="ph-empty">–</p>'}</div></div>`; }).join('');
    phPaintUn();
    // Kebutuhan & saldo per hari (atau bulan berikutnya dari Plan bulan)
    document.querySelectorAll('#phView [data-v]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === (P.phView || 'day'))));
    $('phBasis').hidden = $('phInclUn').closest('label').hidden = P.phView === 'next';
    if (P.phView === 'next') { renderHarianNext(); return; }
    const H = harianCalc(wk, basis); P.ph = H;
    const show = $('phShow').value;
    let rows = H.rows;
    const qm = $('phMQ').value.trim().toLowerCase();
    if (qm) rows = rows.filter((r) => (r.code + ' ' + r.name).toLowerCase().includes(qm));
    rows = rows.filter(phGrpOk);
    if (show === 'short') rows = rows.filter((r) => r.short >= 0);
    rows.sort((a, b) => (a.short < 0) - (b.short < 0) || a.short - b.short || a.code.localeCompare(b.code, 'id', { numeric: true }));
    P.phVis = rows;
    $('phInfo').innerHTML = H.j === undefined ? 'Week ini di luar data week (PEMBAGIAN_WEEK).'
      : H.before ? `<span class="pl-bad">Week ini sebelum tanggal stok (${fmtDate(P.stockDate)}), saldo harian tidak bisa dihitung.</span>`
      : `${nf.format(rows.length)} material · basis ${basis === 'cons' ? 'PC + CP' : `MO Plotting Harian (stok ${esc(fmtDate(H.d0 || P.stockDate))} − pemakaian MO bertanggal; plan per week tidak dihitung; Banded/2in1/KIT tidak dihitung — sama dengan Formulir PR & Proyeksi Stok mode Stok terkini)`} · saldo harian ${P.phInclUn ? 'termasuk' : 'tanpa'} MO yang belum bertanggal`;
    $('phHead').innerHTML = `<tr><th class="pl-sticky pl-c1" rowspan="2">Material</th><th class="num ph-open" rowspan="2">Saldo awal</th>${days.map((d) => `<th class="num m-start ph-dayh${d === todayStr() ? ' si-cur' : ''}" colspan="2">${esc(dayLbl(d))}</th>`).join('')}<th class="num m-start ph-unh" rowspan="2" title="${basis === 'cons' ? 'Sisa plan tanpa MO + MO tanpa tanggal produksi' : 'MO week ini yang belum ada tanggal produksi'}">Belum<br>dijadwalkan</th><th class="num ph-endh" rowspan="2" title="Saldo setelah semua kebutuhan week ini, termasuk yang belum dijadwalkan">Saldo akhir<br>week</th></tr>
      <tr>${days.map((d) => `<th class="num m-start ph-sub${d === todayStr() ? ' si-cur' : ''}">Keluar</th><th class="num ph-sub${d === todayStr() ? ' si-cur' : ''}">Saldo</th>`).join('')}</tr>`;
    const cell = (r, i) => { const o = r.need[i] + r.out[i], s2 = r.sal[i];
      return `<td class="num m-start${o ? ' ph-out' : ''}" data-c="${esc(r.code)}" data-i="${i}"${o ? ' title="Klik untuk rincian"' : ''}>${o ? fmtQ(o) : ''}${i === 0 && P.phInclUn && r.un ? `<small class="ph-unin">−${fmtQ(r.un)} blm dijadwalkan</small>` : ''}${r.inc[i] ? `<small class="ph-in">+${fmtQ(r.inc[i])}</small>` : ''}</td><td class="num ${s2 !== null && s2 < -1e-9 ? 'pl-neg' : ''}">${s2 === null ? '–' : fmtQ(s2)}</td>`; };
    $('phRows').innerHTML = rows.slice(0, 1500).map((r) => `<tr>${matCell(r.code, r.name, (r.uom ? `<span class="pj-uom">${esc(r.uom)}</span>` : '') + phPoTag(r) + phSubTag(r.code))}<td class="num ph-open">${r.open === null ? '–' : fmtQ(r.open)}</td>${days.map((d, i) => cell(r, i)).join('')}<td class="num m-start ph-unc${r.un ? ' ph-out' : ''}" data-c="${esc(r.code)}" data-i="${days.length}"${r.un ? ' title="Klik untuk rincian"' : ''}>${r.un ? fmtQ(r.un) : ''}</td><td class="num ph-end${r.end !== null && r.end < -1e-9 ? ' pl-neg' : ''}">${r.end === null ? '–' : fmtQ(r.end)}</td></tr>`).join('')
      || `<tr class="empty"><td colspan="${4 + days.length * 2}">${show === 'short' ? 'Tidak ada material yang kurang di week ini.' : 'Tidak ada kebutuhan material di week ini.'}</td></tr>`;
  }
  // Filter RM / PM (kategori material di Daftar Material: "RM (…)", "PM (…)")
  const phGrp = (code) => { const t = String((MRP.master.get(code) || {}).kat || '').trim().toUpperCase(); return t.startsWith('RM') ? 'RM' : t.startsWith('PM') ? 'PM' : 'X'; };
  // Label material lama yang punya Material Pengganti (angka tetap per BoM; penggantian hanya di perhitungan PR)
  const phSubTag = (c) => (P.subs || []).filter((y) => y.aktif && y.lama === c).map((x) => `<span class="ph-subtag" title="Material Pengganti: di perhitungan PR, kebutuhan ${x.skus.length ? 'SKU ' + esc(x.skus.join(', ')) : 'semua SKU'} dibeli sebagai ${esc(x.baru)}. Angka di Plotting Harian tetap mengikuti BoM.">diganti → ${esc(x.baru)}${x.skus.length ? ' (SKU tertentu)' : ''}</span>`).join('');
  const phGrpOk = (r) => { const g = $('phGrp').value; return !g || phGrp(r.code) === g; };
  /* Plotting Harian · bulan berikutnya: saldo akhir bulan berjalan (MO harian) lalu Plan bulan tiap bulan berikutnya — sama dengan Lampiran PR */
  function renderHarianNext() {
    P.ph = null;
    const B = stkBase(), mi = B.cols.map((c, i) => i).filter((i) => B.cols[i].kind === 'm'), lastW = B.cols.map((c) => c.kind).lastIndexOf('w');
    const show = $('phShow').value, qm = $('phMQ').value.trim().toLowerCase();
    if (!mi.length) {
      $('phInfo').innerHTML = 'Belum ada Plan bulan untuk bulan-bulan berikutnya. Isi kolom Plan bulan di Rencana Produksi.';
      $('phHead').innerHTML = ''; $('phRows').innerHTML = ''; P.phNext = null; return;
    }
    const rows = [];
    B.M.forEach((o, code) => {
      if (isFg(code) || kfIsEk(code) || !mi.some((i) => o.w[i] > 1e-9)) return;
      const d = prCalc(code, 'all', []); if (!d) return;
      const open = lastW >= 0 ? d.cols[lastW].sal : d.stok;
      const fi = mi.find((i) => d.cols[i].sal < -1e-9);
      rows.push({ code, name: d.nama || code, uom: d.uom, d, open, short: fi === undefined ? -1 : fi, deep: Math.min(0, ...mi.map((i) => d.cols[i].sal)), ln: d.poLate + d.poNone });
    });
    let L = rows.filter((r) => (!qm || (r.code + ' ' + r.name).toLowerCase().includes(qm)) && phGrpOk(r));
    if (show === 'short') L = L.filter((r) => r.short >= 0);
    L.sort((a, b) => (a.short < 0) - (b.short < 0) || a.short - b.short || a.deep - b.deep || a.code.localeCompare(b.code, 'id', { numeric: true }));
    P.phNext = { B, mi, rows: L };
    const nS = rows.filter((r) => phGrpOk(r) && (r.short >= 0 || r.open < -1e-9)).length;
    $('phInfo').innerHTML = `${nf.format(L.length)} material · <b>${nS}</b> akan kurang · saldo awal = saldo akhir ${esc(monLabel(B.cur))} (stok terkini − MO Plotting Harian + PO terjadwal), lalu Plan bulan × BoM aktif (Banded/2in1/KIT tidak dihitung) — sama dengan Lampiran PR & Proyeksi Stok mode Stok terkini`;
    $('phHead').innerHTML = `<tr><th class="pl-sticky pl-c1" rowspan="2">Material</th><th class="num ph-open" rowspan="2" title="Saldo setelah semua MO Plotting Harian bulan berjalan dan PO terjadwal s/d akhir bulan">Saldo akhir<br>${esc(monShort(B.cur))} ${B.cur.slice(2, 4)}</th>${mi.map((i) => `<th class="num m-start" colspan="3">${esc(B.cols[i].lf)} <small>(Plan bulan)</small></th>`).join('')}<th class="num m-start" rowspan="2" title="PO yang jadwalnya sudah lewat atau belum dijadwalkan; tidak menambah saldo">PO telat /<br>tanpa jadwal</th><th rowspan="2">Mulai kurang</th></tr>
      <tr>${mi.map(() => '<th class="num m-start ph-sub">Kebutuhan</th><th class="num ph-sub">PO</th><th class="num ph-sub">Saldo</th>').join('')}</tr>`;
    const f0 = (v) => (Math.abs(v) > 1e-9 ? fmtQ(v) : '');
    $('phRows').innerHTML = L.slice(0, 1500).map((r) => `<tr data-next="${esc(r.code)}">${matCell(r.code, r.name, (r.uom ? `<span class="pj-uom">${esc(r.uom)}</span>` : '') + phSubTag(r.code))}<td class="num ph-open${r.open < -1e-9 ? ' pl-neg' : ''}">${fmtQ(r.open)}</td>${mi.map((i) => { const c = r.d.cols[i]; return `<td class="num m-start${c.need ? ' ph-out' : ''}" data-nx="${esc(r.code)}" title="Klik untuk rincian per SKU">${f0(c.need + c.add)}</td><td class="num">${f0(c.po) ? `<span class="ph-in">+${f0(c.po)}</span>` : ''}</td><td class="num${c.sal < -1e-9 ? ' pl-neg' : ''}"><b>${fmtQ(c.sal)}</b></td>`; }).join('')}<td class="num m-start">${f0(r.ln)}</td><td>${r.open < -1e-9 ? `<span class="badge b-late" title="Saldo sudah minus sebelum bulan berikutnya">${esc(monLabel(B.cur))}</span>` : r.short >= 0 ? `<span class="badge b-late">${esc(r.d.cols[r.short].lf)}</span>` : '<span class="badge b-done">Aman</span>'}</td></tr>`).join('')
      || `<tr class="empty"><td colspan="${4 + mi.length * 3}">${show === 'short' ? 'Tidak ada material yang kurang di bulan berikutnya.' : 'Tidak ada kebutuhan dari Plan bulan.'}</td></tr>`;
  }
  // PO atas material (dari Monitoring PO): penanda di kolom material + rincian saat material diketuk
  const phPoOpen = (po) => (po ? po.list.filter((x) => x.sisa > 1e-9) : []);
  function phPoTag(r) {
    const L = phPoOpen(r.po), wk = phWeek();
    if (!L.length) return '<span class="ph-po is-none" title="Tidak ada PO berjalan">PO –</span>';
    const inWk = wk && L.some((x) => x.date && x.date >= wk.start && x.date <= wk.end), late = L.some((x) => x.kind === 'late');
    return `<span class="ph-po${late ? ' is-late' : inWk ? ' is-wk' : ''}" title="${L.length} jadwal PO berjalan${late ? ' · ada yang terlambat' : ''}${inWk ? ' · ada yang dijadwalkan week ini' : ''}">PO ${L.length}</span>`;
  }
  function phPoDialog(code) {
    const H = P.ph; if (!H) return;
    const r = H.rows.find((x) => x.code === code); if (!r) return;
    const wk = phWeek(), L = phPoOpen(r.po).slice().sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999')), RV = (r.po && r.po.recv) || [];
    const tot = (f) => L.reduce((t, x) => t + (Number(x[f]) || 0), 0);
    const when = (x) => (x.kind === 'none' ? '<span class="muted">Belum dijadwalkan</span>' : x.date ? `${esc(fmtDate(x.date))}${wk && x.date >= wk.start && x.date <= wk.end ? ' <span class="ph-po is-wk">week ini</span>' : ''}` : '–');
    const st = (x) => (x.kind === 'late' ? '<span class="kf-w kf-bad">Terlambat</span>' : x.kind === 'none' ? '<span class="kf-w kf-todo">Belum dijadwalkan</span>' : x.kind === 'out' || (wk && x.date > wk.end) ? '<span class="kf-w">Mendatang</span>' : '<span class="kf-w kf-ok">Terjadwal week ini</span>');
    const kf = (x) => (x.konf ? `<b>${fmtQ(x.konf)}</b>${x.kWeek ? ` · datang ${esc(x.kWeek)}` : ''}${x.moved ? ' <small class="muted">(dipindah ke week berjalan)</small>' : ''}${x.kFlag ? `<div class="pl-bad">${esc(x.kFlag)}</div>` : ''}` : '<span class="muted">Belum dikonfirmasi</span>');
    const short = r.sal.some((v) => v !== null && v < -1e-9) || (r.end !== null && r.end < -1e-9);
    openDialog({
      title: `PO ${code} · ${r.name}`, ok: 'Buka di Proyeksi Stok', wide: true,
      body: `<div class="kp-nums ph-pon"><span>Saldo awal ${esc(wLabel(wk))} <b>${r.open === null ? '–' : fmtQ(r.open)}</b></span><span>Keluar week ini <b>${fmtQ(r.need.reduce((t, x) => t + x, 0) + r.out.reduce((t, x) => t + x, 0))}</b></span><span class="${r.end !== null && r.end < -1e-9 ? 'pl-bad' : ''}">Saldo akhir week <b>${r.end === null ? '–' : fmtQ(r.end)}</b></span><span>PO berjalan <b>${fmtQ(tot('sisa'))} ${esc(r.uom)}</b></span></div>
        ${short && !L.length ? '<p class="check err">Material ini akan kurang di week ini dan <b>tidak ada PO berjalan</b>. Perlu dibuatkan PR / PO.</p>' : ''}
        ${L.length ? `<table class="po-table pl-mini kp-at"><thead><tr><th>No PO</th><th>Supplier</th><th>Jadwal datang</th><th class="num">Sisa</th><th>Status</th><th>Konfirmasi incoming</th></tr></thead><tbody>
          ${L.map((x) => `<tr${x.kind === 'late' ? ' class="kp-late"' : ''}><td><b>${esc(x.po)}</b>${x.ke ? ` <small class="muted">ke-${esc(x.ke)}</small>` : ''}</td><td>${esc(x.supplier || '')}</td><td>${when(x)}</td><td class="num">${fmtQ(x.sisa)}</td><td>${st(x)}</td><td>${kf(x)}</td></tr>`).join('')}
          <tr class="csl-tot"><th colspan="3">Total PO berjalan</th><th class="num">${fmtQ(tot('sisa'))}</th><th></th><th class="num">${fmtQ(L.reduce((t, x) => t + (Number(x.eff !== undefined ? x.eff : x.konf) || 0), 0))} dikonfirmasi</th></tr></tbody></table>`
          : '<p class="check">Tidak ada PO berjalan untuk material ini.</p>'}
        ${RV.length ? `<h3 class="kp-h">Sudah datang (dikonfirmasi)</h3><ul class="kfr-ul">${RV.map((x) => `<li><b>${esc(x.po)}</b> ke-${esc(x.ke)} · ${esc(x.supplier || '')} · datang ${esc(fmtDate(x.datang))} · +${fmtQ(x.konf)}${x.inStock ? ' <span class="muted">(sudah termasuk stok)</span>' : ''}</li>`).join('')}</ul>` : ''}
        ${L.length ? `<div class="ph-copy"><button type="button" class="btn btn-sm btn-ghost" id="phPoCopy">Salin tabel untuk email</button><label class="tb-check"><input type="checkbox" id="phPoCopyKf"> sertakan konfirmasi incoming</label><span class="muted" id="phPoCopyMsg"></span></div>` : ''}
        <p class="hint">Hanya jadwal PO yang <b>dikonfirmasi incoming</b> yang menambah saldo (Plotting Harian & Proyeksi Stok). Konfirmasi incoming dilakukan di Proyeksi Stok.</p>`,
      onSubmit: async () => { location.hash = '#/mrp/proyeksi'; setTimeout(() => { try { openProjDetail(code); } catch (e) { /* abaikan */ } }, 400); return ''; },
    });
    phPoCopyBind(code, r, L, wk);
  }
  // Salin tabel PO ke clipboard: HTML bergaya inline (rapi saat ditempel di Gmail / Outlook) + teks bertab (Excel / teks biasa)
  function phPoCopyBind(code, r, L, wk) {
    const btn = $('phPoCopy'); if (!btn) return;
    btn.addEventListener('click', async () => {
      const withKf = $('phPoCopyKf').checked;
      const fmtQ = (v) => (v === '' || v === null || v === undefined ? '–' : (Number(v) || 0).toLocaleString('id-ID', { maximumFractionDigits: 3 }));
      const stTxt = (x) => (x.kind === 'late' ? 'Terlambat' : x.kind === 'none' ? 'Belum dijadwalkan' : x.kind === 'out' || (wk && x.date > wk.end) ? 'Mendatang' : 'Terjadwal week ini');
      const dTxt = (x) => (x.kind === 'none' || !x.date ? 'Belum dijadwalkan' : fmtDate(x.date));
      const kTxt = (x) => (x.konf ? `${fmtQ(x.konf)}${x.kWeek ? ' (datang ' + x.kWeek + ')' : ''}` : 'Belum dikonfirmasi');
      const head = ['No', 'No PO', 'Supplier', 'Jadwal datang', `Sisa (${r.uom || ''})`, 'Status'].concat(withKf ? ['Konfirmasi incoming'] : []);
      const rows = L.map((x, i) => [String(i + 1), x.po + (x.ke ? ` (ke-${x.ke})` : ''), x.supplier || '', dTxt(x), fmtQ(x.sisa), stTxt(x)].concat(withKf ? [kTxt(x)] : []));
      const tot = fmtQ(L.reduce((t, x) => t + (Number(x.sisa) || 0), 0));
      const title = `${code} - ${r.name}`;
      const td = 'border:1px solid #9aa5a0;padding:4px 8px;font-family:Arial,sans-serif;font-size:13px;vertical-align:top;';
      const numCol = 4;
      const html = `<p style="font-family:Arial,sans-serif;font-size:13px;margin:0 0 6px"><b>${esc(title)}</b></p>`
        + `<table style="border-collapse:collapse;border:1px solid #9aa5a0"><thead><tr>${head.map((h) => `<th style="${td}background:#e6efe9;text-align:left">${esc(h)}</th>`).join('')}</tr></thead><tbody>`
        + rows.map((c, i) => `<tr>${c.map((v, j) => `<td style="${td}${j === numCol ? 'text-align:right;white-space:nowrap;' : ''}${j === 5 && L[i].kind === 'late' ? 'color:#b3261e;font-weight:bold;' : ''}">${esc(v)}</td>`).join('')}</tr>`).join('')
        + `<tr><td colspan="4" style="${td}font-weight:bold">Total sisa PO</td><td style="${td}text-align:right;font-weight:bold;white-space:nowrap">${esc(tot)}</td><td colspan="${head.length - 5}" style="${td}"></td></tr></tbody></table>`;
      const text = [title, head.join('\t'), ...rows.map((c) => c.join('\t')), ['', '', '', 'Total sisa PO', tot].join('\t')].join('\n');
      const msg = $('phPoCopyMsg');
      try {
        if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
          await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
        } else {
          const box = document.createElement('div'); box.contentEditable = 'true'; box.style.cssText = 'position:fixed;left:-9999px;top:0'; box.innerHTML = html; document.body.appendChild(box);
          const rg = document.createRange(); rg.selectNodeContents(box); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(rg);
          const ok = document.execCommand('copy'); sel.removeAllRanges(); box.remove(); if (!ok) throw new Error('copy');
        }
        msg.textContent = 'Tabel disalin. Tempel (Ctrl+V) di email.'; toast('Tabel PO disalin. Tempel (Ctrl+V) di email.');
      } catch (e) { msg.textContent = 'Gagal menyalin otomatis. Blok tabel di atas lalu tekan Ctrl+C.'; }
    });
  }
  $('phRows').addEventListener('click', (e) => { const td = e.target.closest('td.pl-c1'); if (td) { const c = td.querySelector('.pl-code'); if (c) phPoDialog(c.textContent.trim()); } });
  // Rincian sel Keluar: dari MO / sisa plan / PC-CP mana, ADD/FOH/RS
  function phOutDialog(code, i) {
    const H = P.ph; if (!H) return;
    const r = H.rows.find((x) => x.code === code); if (!r) return;
    const isUn = i === H.days.length, d = H.days[i], m = r.src[i] || new Map(), list = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const kur = isUn ? [] : (P.kurang || []).filter((x) => x.code === code && x.tgl === d);
    const det = (r.det && r.det[i]) || [], tot = r.need[i] + (r.out[i] || 0);
    const pct = (v) => (tot > 1e-9 ? `${(Math.round((v / tot) * 1000) / 10).toString().replace('.', ',')}%` : '–');
    const tr = (a, b) => `<tr><td colspan="${det.length ? 5 : 1}">${esc(a)}</td><td class="num">${fmtQ(b)}</td>${det.length ? `<td class="num">${pct(b)}</td>` : ''}</tr>`;
    // material masuk langsung dari BoM MO, atau lewat ekstrak / bulk mana
    const via = (bom) => {
      if (!bom) return '–';
      const direct = bom.comps.some((c) => String(c.code).trim() === code), out = [];
      bom.comps.forEach((c) => { const k = String(c.code).trim(); if (k !== code && MRP.byProduct.has(k) && !isFg(k)) { const nn = needOf(k, 1000); if (nn && nn.leaves.has(code)) out.push(`${k} ${(MRP.master.get(k) || {}).name || ''}`.trim()); } });
      return [direct ? 'langsung' : '', ...out.map((x) => 'lewat ' + x)].filter(Boolean).join(' + ') || '–';
    };
    const detRows = det.slice().sort((a, b) => b.v - a.v).map((x) => `<tr><td class="mono">${esc(x.no)}${x.tgl ? '' : '<small class="muted">belum bertanggal</small>'}</td><td><b>${esc(x.sku)}</b><small class="muted">${esc(x.name)}</small></td><td class="num">${fmtKg(x.kg)} kg</td><td>${esc(via(x.bom))}${x.bom ? `<small class="muted">BoM ${esc(refOf(x.bom))}</small>` : ''}</td><td class="num">${x.kg ? (x.v / x.kg).toLocaleString('id-ID', { maximumSignificantDigits: 4 }) : '–'}</td><td class="num"><b>${fmtQ(x.v)}</b></td><td class="num">${pct(x.v)}</td></tr>`).join('');
    openDialog({
      title: isUn ? `Belum dijadwalkan ${code} · ${wLabel(phWeek())}` : `Keluar ${code} · ${dayLbl(d)}`, ok: 'Tutup', cancel: false, wide: det.length ? 'x' : false,
      body: `<p class="dlg-lead"><b>${esc(r.name)}</b> · ${esc(r.uom)}</p>
        <div class="table-wrap"><table class="po-table pl-mini ph-out-t"><thead><tr>${det.length ? `<th>No MO</th><th>SKU</th><th class="num">Qty MO</th><th>Material masuk</th><th class="num">${esc(r.uom)} / kg produk</th><th class="num">Pemakaian ${esc(code)}</th><th class="num">Porsi</th>` : '<th>Asal</th><th class="num">Qty</th>'}</tr></thead><tbody>
        ${detRows}
        ${list.map(([k, v]) => tr(k, v)).join('')}
        ${isUn && r.fix ? tr('Penyesuaian agar sama dengan total week di Proyeksi Stok', r.fix) : ''}
        ${kur.map((x) => tr(`ADD/FOH/RS ${x.ket || ''}`.trim(), x.qty)).join('')}
        ${i === 0 && r.out[0] - kur.reduce((t, x) => t + x.qty, 0) > 1e-9 ? tr('ADD/FOH/RS tanggal sebelumnya / tanpa tanggal di week ini', r.out[0] - kur.reduce((t, x) => t + x.qty, 0)) : ''}
        <tr class="csl-tot"><th${det.length ? ' colspan="5"' : ''}>Total</th><th class="num">${fmtQ(tot)}</th>${det.length ? '<th class="num">100%</th>' : ''}</tr></tbody></table></div>
        <p class="hint">Pemakaian = qty MO × ${esc(r.uom)} ${esc(code)} per kg produk dari BoM MO (Reference BoM di Konfirmasi Produksi; lewat ekstrak/bulk dihitung sampai bahan baku). Porsi = bagian setiap MO dari total keluar. ${isUn ? 'Sisa plan tanpa MO dan MO tanpa tanggal produksi: begitu MO keluar dan diplot tanggalnya, pindah ke hari produksinya.' : ''}</p>`,
      onSubmit: async () => '',
    });
  }
  $('phRows').addEventListener('click', (e) => { const nx = e.target.closest('td[data-nx]'); if (nx) { openNowDetail(nx.dataset.nx); return; } const td = e.target.closest('td.ph-out'); if (td) phOutDialog(td.dataset.c, Number(td.dataset.i)); });
  $('phGrp').addEventListener('change', renderHarian);
  $('phView').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b || b.dataset.v === (P.phView || 'day')) return; P.phView = b.dataset.v; renderHarian(); });
  function phDateDialog(no) {
    const r = kfGet(no); if (!r) return;
    openDialog({
      title: `Tanggal produksi ${no}`, ok: 'Terapkan',
      body: `<p class="dlg-lead"><b>${esc(r.code)}</b> ${esc(r.name)} · ${fmtQ(r.qty)} ${esc(r.uom)}. Plotting Week ikut tanggal yang dipilih.</p>
        <label class="field"><span>Tanggal produksi</span><input type="date" name="tgl" value="${esc(r.tgl || '')}"></label>
        <p class="hint">Kosongkan untuk mengembalikan ke "Belum diplot" (week tetap).</p>`,
      onSubmit: async (fd) => { phSetDate(no, fd.tgl || ''); return ''; },
    });
  }
  function phSetDate(no, tgl) {
    if (!tgl) { kfTouch(no, { tgl: '' }); renderHarian(); return; }
    const w = weekOfDate(tgl);
    if (!w) { toast('Tanggal itu belum ada di PEMBAGIAN_WEEK.'); renderHarian(); return; }
    kfTouch(no, { tgl, bulan: w.bulan, week: w.week });
    renderHarian();
  }
  $('phWeek').addEventListener('change', renderHarian);
  ['phPrev', 'phNext'].forEach((id, k) => $(id).addEventListener('click', () => { const sel = $('phWeek'), i = sel.selectedIndex + (k ? 1 : -1); if (i >= 0 && i < sel.options.length) { sel.selectedIndex = i; renderHarian(); } }));
  $('phToday').addEventListener('click', () => { const w = weekOfDate(todayStr()); if (w) { $('phWeek').value = w.bulan + '|' + w.week; renderHarian(); } });
  $('phShow').addEventListener('change', renderHarian);
  $('phQ').addEventListener('input', () => { $('phQMsg').hidden = true; renderHarian(); });
  // Enter di kotak cari: langsung ke No MO — pindah ke week-nya, sorot kartunya; tidak ada → peringatan
  $('phQ').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const t = $('phQ').value.trim(); if (!t) return;
    const all = kfRows(), lc = t.toLowerCase();
    const r = all.find((x) => x.no.toLowerCase() === lc) || all.filter((x) => x.no.toLowerCase().includes(lc)).sort((a, b) => a.no.length - b.no.length)[0];
    const msg = $('phQMsg');
    if (!r) { msg.className = 'ph-qmsg is-err'; msg.textContent = `⚠ MO "${t}" tidak ditemukan di Konfirmasi Produksi. Cek nomornya, atau upload LIST_MO terbaru.`; msg.hidden = false; return; }
    let note;
    if (r.week) { const k = r.bulan + '|' + r.week; if ($('phWeek').value !== k) { $('phWeek').value = k; } note = r.tgl ? `${r.no} · ${dayLbl(r.tgl)} (${r.week} ${monShort(r.bulan)})` : `${r.no} · ${r.week} ${monShort(r.bulan)} · belum diberi tanggal (lihat kolom Belum diplot)`; }
    else note = `${r.no} · belum punya week maupun tanggal (lihat kolom Belum diplot → Tanpa week)`;
    $('phQ').value = r.no;
    renderHarian();
    msg.className = 'ph-qmsg is-ok'; msg.textContent = `✓ ${note} — ${r.code} ${r.name}`; msg.hidden = false;
    const el = document.querySelector(`#phBoard .ph-chip[data-no="${CSS.escape(r.no)}"]`);
    if (el) { const g = el.closest('details'); if (g) g.open = true; el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); el.classList.add('is-flash'); setTimeout(() => el.classList.remove('is-flash'), 2200); }
  });
  $('phUnQ').addEventListener('input', phPaintUn);
  $('phMQ').addEventListener('input', renderHarian);
  $('phInclUn').addEventListener('change', (e) => { P.phInclUn = e.target.checked; renderHarian(); });
  $('phTall').addEventListener('click', () => { P.phTall = !P.phTall; renderHarian(); });
  $('phBasis').addEventListener('click', (e) => { const b = e.target.closest('[data-b]'); if (!b || b.disabled) return; P.phBasis = b.dataset.b; renderHarian(); });
  $('phSaveBtn').addEventListener('click', kfSaveDrafts);
  $('phBoard').addEventListener('click', (e) => { const c = e.target.closest('.ph-chip'); if (!c) return; if (!(P.edit && P.hasKonf)) { toast('Masuk Mode edit untuk mengubah tanggal.'); return; } phDateDialog(c.dataset.no); });
  // Drag & drop: seret MO (papan atau tabel "belum diplot") ke kolom hari; ke "Belum diplot" = kosongkan tanggal
  const phDragStart = (e) => {
    const el = e.target.closest('[data-no][draggable="true"]'); if (!el) return;
    e.dataTransfer.setData('text/plain', el.dataset.no); e.dataTransfer.effectAllowed = 'move';
    el.classList.add('is-dragging'); $('phBoard').classList.add('is-dragging');
  };
  const phDragEnd = (e) => {
    const el = e.target.closest('[data-no]'); if (el) el.classList.remove('is-dragging');
    $('phBoard').classList.remove('is-dragging'); document.querySelectorAll('.ph-day.is-over').forEach((x) => x.classList.remove('is-over'));
  };
  $('phBoard').addEventListener('dragstart', phDragStart); $('phBoard').addEventListener('dragend', phDragEnd);
  $('phBoard').addEventListener('dragover', (e) => {
    const d = e.target.closest('.ph-day'); if (!d || !(P.edit && P.hasKonf)) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.ph-day.is-over').forEach((x) => { if (x !== d) x.classList.remove('is-over'); });
    d.classList.add('is-over');
  });
  $('phBoard').addEventListener('dragleave', (e) => { const d = e.target.closest('.ph-day'); if (d && !d.contains(e.relatedTarget)) d.classList.remove('is-over'); });
  $('phBoard').addEventListener('drop', (e) => {
    const d = e.target.closest('.ph-day'); if (!d) return;
    e.preventDefault(); d.classList.remove('is-over');
    const no = e.dataTransfer.getData('text/plain'); if (!no || !(P.edit && P.hasKonf)) return;
    const r = kfGet(no); if (!r || (r.tgl || '') === d.dataset.day) return;
    phSetDate(no, d.dataset.day);
    toast(d.dataset.day ? `${no} → ${dayLbl(d.dataset.day)}` : `${no} dikembalikan ke Belum diplot`);
  });
  // Unduh Excel tabel "Kebutuhan material & saldo stok per hari" — sesuai yang tampil (filter RM/PM, yang akan kurang, pencarian)
  $('phTblExport').addEventListener('click', () => {
    const grpTxt = ({ RM: 'RM', PM: 'PM', X: 'Lainnya' })[$('phGrp').value] || 'RM & PM';
    const wb = XLSX.utils.book_new();
    if (P.phView === 'next') {
      const N = P.phNext; if (!N || !N.rows.length) { toast('Tidak ada material untuk diunduh.'); return; }
      const data = N.rows.map((r) => { const o = { KODE: r.code, NAMA: r.name, GOLONGAN: phGrp(r.code), UoM: r.uom, [`SALDO AKHIR ${monLabel(N.B.cur).toUpperCase()}`]: round4(r.open) };
        N.mi.forEach((i) => { const c = r.d.cols[i], k = c.lf.toUpperCase(); o[k + ' KEBUTUHAN'] = round4(c.need + c.add); o[k + ' PO'] = round4(c.po); o[k + ' SALDO'] = round4(c.sal); });
        o['PO TELAT/TANPA JADWAL'] = round4(r.ln); o['MULAI KURANG'] = r.short >= 0 ? r.d.cols[r.short].lf : ''; return o; });
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Bulan berikutnya');
      XLSX.writeFile(wb, `Kebutuhan_Saldo_Bulan_Berikutnya_${grpTxt.replace(/\W+/g, '')}_${todayStr()}.xlsx`); return;
    }
    const H = P.ph, rows = P.phVis || []; if (!H || !rows.length) { toast('Tidak ada material untuk diunduh.'); return; }
    const data = rows.map((r) => { const o = { KODE: r.code, NAMA: r.name, GOLONGAN: phGrp(r.code), UoM: r.uom, 'SALDO AWAL': round4(r.open) };
      H.days.forEach((d, i) => { const k = dayLbl(d).toUpperCase(); o[k + ' KEBUTUHAN'] = round4(r.need[i]); o[k + ' INCOMING'] = round4(r.inc[i]); o[k + ' ADD/FOH/RS'] = round4(r.out[i]); o[k + ' SALDO'] = round4(r.sal[i]); });
      o['BELUM DIJADWALKAN'] = round4(r.un); o['SALDO AKHIR WEEK'] = round4(r.end); o['MULAI KURANG'] = r.short < 0 ? '' : H.days[r.short] ? dayLbl(H.days[r.short]) : 'Akhir week';
      return o; });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Saldo per hari');
    const wk = phWeek(); XLSX.writeFile(wb, `Kebutuhan_Saldo_Harian_${wk.bulan}_${wk.week}_${grpTxt.replace(/\W+/g, '')}.xlsx`);
  });
  $('phExport').addEventListener('click', () => {
    if (P.phView === 'next') {
      const N = P.phNext; if (!N || !N.rows.length) return;
      const data = N.rows.map((r) => { const o = { KODE: r.code, NAMA: r.name, UoM: r.uom, [`SALDO AKHIR ${monLabel(N.B.cur).toUpperCase()}`]: round4(r.open) };
        N.mi.forEach((i) => { const c = r.d.cols[i], k = c.lf.toUpperCase(); o[k + ' KEBUTUHAN'] = round4(c.need + c.add); o[k + ' PO'] = round4(c.po); o[k + ' SALDO'] = round4(c.sal); });
        o['PO TELAT/TANPA JADWAL'] = round4(r.ln); o['MULAI KURANG'] = r.short >= 0 ? r.d.cols[r.short].lf : ''; return o; });
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Bulan berikutnya');
      XLSX.writeFile(wb, `Kebutuhan_Plan_Bulan_${todayStr()}.xlsx`); return;
    }
    const H = P.ph; if (!H || !H.rows.length) return;
    const data = H.rows.map((r) => { const o = { KODE: r.code, NAMA: r.name, UoM: r.uom, 'SALDO AWAL': round4(r.open) };
      H.days.forEach((d, i) => { const k = dayLbl(d).toUpperCase(); o[k + ' KEBUTUHAN'] = round4(r.need[i]); o[k + ' INCOMING'] = round4(r.inc[i]); o[k + ' ADD/FOH/RS'] = round4(r.out[i]); o[k + ' SALDO'] = round4(r.sal[i]); });
      o['BELUM DIJADWALKAN'] = round4(r.un); o['SALDO AKHIR WEEK'] = round4(r.end);
      return o; });
    const mos = kfRows().filter((r) => r.tgl && H.days.includes(r.tgl)).sort((a, b) => a.tgl.localeCompare(b.tgl)).map((r) => ({ TANGGAL: r.tgl, 'NO MO': r.no, KODE: r.code, NAMA: r.name, QTY: r.qty, UoM: r.uom, 'KONVERSI KG': r.kg }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(mos.length ? mos : [{ TANGGAL: '' }]), 'Jadwal MO');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Saldo Harian');
    const wk = phWeek(); XLSX.writeFile(wb, `Plotting_Harian_${wk.bulan}_${wk.week}.xlsx`);
  });

  /* ---------- Kalender Produksi: review bulanan MO yang sudah diplot tanggal (read-only) ---------- */
  function kpMonth() {
    const sel = $('kpMonth'), cur = todayStr().slice(0, 7);
    if (!sel.options.length || sel.dataset.n !== String(P.konf.size)) {
      const ms = new Set([...P.monthWeeks.keys()]); P.konf.forEach((r) => { if (r.tgl) ms.add(r.tgl.slice(0, 7)); });
      const list = [...ms].sort(), keep = sel.value;
      sel.innerHTML = list.map((m) => `<option value="${m}">${esc(monLabel(m))}</option>`).join('');
      sel.value = keep && list.includes(keep) ? keep : list.includes(cur) ? cur : list[list.length - 1] || cur;
      sel.dataset.n = String(P.konf.size);
    }
    return sel.value;
  }
  const kpQtyTxt = (list) => { const kg = list.filter((r) => planUnit(r.code) !== 'pcs').reduce((t, r) => t + (Number(r.kg !== '' ? r.kg : r.qty) || 0), 0), pcs = list.filter((r) => planUnit(r.code) === 'pcs').reduce((t, r) => t + (Number(r.qty) || 0), 0);
    return [kg ? fmtKg(kg) + ' kg' : '', pcs ? fmtQ(pcs) + ' pcs' : ''].filter(Boolean).join(' · '); };
  function kpWeekSel() {
    const sel = $('kpWeek');
    if (!sel.options.length) {
      const cur = weekOfDate(todayStr());
      sel.innerHTML = P.weeks.map((w) => `<option value="${w.bulan}|${w.week}">${esc(wLabel(w))} ${w.bulan.slice(0, 4)} · ${fmtDate(w.start).slice(0, 6)}–${fmtDate(w.end).slice(0, 6)}</option>`).join('');
      if (cur) sel.value = cur.bulan + '|' + cur.week;
    }
    return P.weekBy.get(sel.value) || null;
  }
  function renderKalender() {
    const view = P.kpView || 'month';
    document.querySelectorAll('#kpView [data-v]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === view)));
    $('kpMonthL').hidden = view !== 'month'; $('kpWeekL').hidden = view !== 'week';
    $('kpThis').textContent = view === 'week' ? 'Week ini' : 'Bulan ini';
    if (view === 'week') { kpRenderWeek(); return; }
    $('kpGrid').classList.remove('is-week');
    const m = kpMonth(); if (!m) return;
    const q = $('kpQ').value.trim().toLowerCase(), jenis = $('kpJenis').value, today = todayStr();
    const all = [...P.konf.values()].filter((r) => jenis === 'all' || (jenis === 'ek' ? kfIsEk(r.code) : !kfIsEk(r.code)));
    const hit = (r) => !q || (r.no + ' ' + r.code + ' ' + r.name).toLowerCase().includes(q);
    const byDay = new Map(); all.forEach((r) => { if (r.tgl) { if (!byDay.has(r.tgl)) byDay.set(r.tgl, []); byDay.get(r.tgl).push(r); } });
    // Baris kalender: minggu Min–Sab yang mencakup bulan ini
    const [y, mo] = m.split('-').map(Number), first = new Date(y, mo - 1, 1), last = new Date(y, mo, 0);
    const start = new Date(first); start.setDate(1 - first.getDay());
    const rows = []; for (let d = new Date(start); d <= last || d.getDay() !== 0; d.setDate(d.getDate() + 1)) { if (d.getDay() === 0) rows.push([]); rows[rows.length - 1].push(ymd(d)); if (rows.length > 6) break; }
    const inMonth = all.filter((r) => r.tgl && r.tgl.slice(0, 7) === m);
    const wkMonth = all.filter((r) => r.bulan === m);
    const noTgl = wkMonth.filter((r) => !r.tgl);
    $('kpKpi').innerHTML = kpis([
      { num: nf.format(inMonth.length), lbl: 'MO bertanggal di bulan ini' },
      { num: kpQtyTxt(inMonth) || '–', lbl: 'total produksi terjadwal' },
      { num: nf.format(new Set(inMonth.map((r) => r.tgl)).size), lbl: 'hari produksi' },
      { num: nf.format(noTgl.length), lbl: `MO week ${monShort(m)} belum bertanggal`, tone: noTgl.length ? 'warn' : '', title: 'MO yang Plotting Week-nya di bulan ini tapi belum diberi tanggal di Plotting Harian' },
    ]);
    const chip = (r) => `<button type="button" class="kp-mo${kfIsEk(r.code) ? ' is-ek' : ''}${q ? (hit(r) ? ' is-hit' : ' is-dim') : ''}" data-no="${esc(r.no)}" title="${esc(r.no + ' · ' + r.code + ' ' + r.name)}"><b>${esc(r.no)}</b>${isMan(r.no) ? '<i class="kf-mant">M</i>' : ''} <span>${esc(r.code)}</span> <small>${planUnit(r.code) === 'pcs' ? fmtQ(r.qty) + ' pcs' : (r.kg !== '' ? fmtKg(r.kg) : fmtQ(r.qty)) + ' kg'}</small></button>`;
    $('kpGrid').innerHTML = `<div class="kp-hd"></div>${HARI.map((h) => `<div class="kp-hd">${h}</div>`).join('')}`
      + rows.map((wd) => {
        const w = weekOfDate(wd.find((d) => d.slice(0, 7) === m) || wd[0]);
        const un = w ? all.filter((r) => r.bulan === w.bulan && r.week === w.week && !r.tgl) : [];
        const wkCell = `<div class="kp-wk">${w ? `<b>${esc(w.week)}</b><small>${monShort(w.bulan)}</small>${un.length ? `<a href="#/mrp/harian" class="kp-un" data-wk="${w.bulan}|${w.week}" title="${esc(un.map((r) => r.no).join(', '))}">${un.length} MO belum bertanggal</a>` : ''}` : ''}</div>`;
        return wkCell + wd.map((d) => {
          const L = (byDay.get(d) || []).sort((a, b) => a.no.localeCompare(b.no, 'id', { numeric: true }));
          const out = d.slice(0, 7) !== m;
          return `<div class="kp-day${out ? ' is-out' : ''}${d === today ? ' is-today' : ''}${L.length ? '' : ' is-empty'}"><div class="kp-dn"><b>${Number(d.slice(8))}</b>${L.length ? `<small>${L.length} MO · ${kpQtyTxt(L)}</small>` : ''}</div><div class="kp-list">${L.map(chip).join('')}</div></div>`;
        }).join('');
      }).join('');
    const nHit = q ? inMonth.filter(hit).length : 0;
    $('kpInfo').textContent = q ? `${nf.format(nHit)} MO cocok di ${monLabel(m)}` : 'Hanya untuk review. Ubah tanggal produksi di menu Plotting Harian.';
  }
  // Tampilan Week: 7 hari dengan kartu MO lengkap + MO week ini yang belum bertanggal
  function kpRenderWeek() {
    const wk = kpWeekSel(); if (!wk) return;
    const q = $('kpQ').value.trim().toLowerCase(), jenis = $('kpJenis').value, today = todayStr();
    const all = [...P.konf.values()].filter((r) => jenis === 'all' || (jenis === 'ek' ? kfIsEk(r.code) : !kfIsEk(r.code)));
    const hit = (r) => !q || (r.no + ' ' + r.code + ' ' + r.name).toLowerCase().includes(q);
    const days = dayList(wk), inWk = all.filter((r) => r.tgl && days.includes(r.tgl)), un = all.filter((r) => r.bulan === wk.bulan && r.week === wk.week && !r.tgl);
    $('kpKpi').innerHTML = kpis([
      { num: nf.format(inWk.length), lbl: `MO bertanggal di ${wLabel(wk)}` },
      { num: kpQtyTxt(inWk) || '–', lbl: 'total produksi terjadwal' },
      { num: nf.format(new Set(inWk.map((r) => r.tgl)).size), lbl: 'hari produksi' },
      { num: nf.format(un.length), lbl: 'MO week ini belum bertanggal', tone: un.length ? 'warn' : '' },
    ]);
    const card = (r) => `<button type="button" class="kp-mo kp-mo2${kfIsEk(r.code) ? ' is-ek' : ''}${q ? (hit(r) ? ' is-hit' : ' is-dim') : ''}" data-no="${esc(r.no)}" title="${esc(r.no + ' · ' + r.code + ' ' + r.name)}"><span class="kp-l1"><b>${esc(r.no)}${isMan(r.no) ? '<i class="kf-mant">M</i>' : ''}</b><small>${planUnit(r.code) === 'pcs' ? fmtQ(r.qty) + ' pcs' : (r.kg !== '' ? fmtKg(r.kg) : fmtQ(r.qty)) + ' kg'}</small></span><span class="kp-l2">${esc(r.code)} · ${esc(r.name)}</span></button>`;
    $('kpGrid').classList.add('is-week');
    $('kpGrid').innerHTML = days.map((d) => {
      const L = inWk.filter((r) => r.tgl === d).sort((a, b) => a.no.localeCompare(b.no, 'id', { numeric: true }));
      return `<div class="kp-day kp-wday${d === today ? ' is-today' : ''}${L.length ? '' : ' is-empty'}"><div class="kp-dn kp-wdn"><b>${esc(dayLbl(d))}</b><small>${L.length ? `${L.length} MO · ${kpQtyTxt(L)}` : 'Tidak ada MO'}</small></div><div class="kp-list">${L.map(card).join('')}</div></div>`;
    }).join('')
      + `<div class="kp-day kp-wday kp-wun"><div class="kp-dn kp-wdn"><b>Belum bertanggal</b><small>${un.length} MO · ${kpQtyTxt(un) || '–'}</small></div><div class="kp-list">${un.sort((a, b) => a.no.localeCompare(b.no, 'id', { numeric: true })).map(card).join('') || '<p class="ph-empty">Semua MO week ini sudah bertanggal.</p>'}</div></div>`;
    $('kpInfo').textContent = q ? `${nf.format(inWk.concat(un).filter(hit).length)} MO cocok di ${wLabel(wk)}` : 'Hanya untuk review. Ubah tanggal produksi di menu Plotting Harian.';
  }
  // Alokasi ekstrak: MO ekstrak → MO SKU mana saja yang memakai (MO Ekstrak dipakai), kg, tanggal; MO SKU → batch ekstrak yang dipakai
  const kpWhen = (x) => (x.tgl ? esc(dayLbl(x.tgl)) : x.week ? `${esc(x.week)} ${monShort(x.bulan)} <span class="muted">(belum bertanggal)</span>` : '<span class="muted">belum diplot</span>');
  function kpEkAlloc(r) {
    const all = [...P.konf.values()];
    if (kfIsEk(r.code)) {
      const users = all.filter((x) => x.moEk === r.no).sort((a, b) => String(a.tgl || a.bulan + a.week).localeCompare(String(b.tgl || b.bulan + b.week)) || a.no.localeCompare(b.no, 'id', { numeric: true }));
      const cap = Number(r.kg !== '' ? r.kg : r.qty) || 0, used = users.reduce((t, x) => t + (Number(x.ekKg) || 0), 0), sisa = cap - used;
      const late = (x) => r.tgl && x.tgl && x.tgl < r.tgl;
      const bar = cap ? Math.min(100, used / cap * 100) : 0;
      return `<h3 class="kp-h">Alokasi batch ekstrak ${esc(r.no)}</h3>
        <div class="kp-alloc"><div class="kp-bar"><i style="width:${bar.toFixed(1)}%"${sisa < -kfTol(cap) ? ' class="is-over"' : ''}></i></div>
          <div class="kp-nums"><span>Hasil <b>${fmtKg(cap)} kg</b></span><span>Terpakai <b>${fmtKg(used) || 0} kg</b> (${cap ? nf.format(Math.round(used / cap * 100)) : 0}%)</span><span class="${sisa < -kfTol(cap) ? 'pl-bad' : ''}">${sisa < -kfTol(cap) ? `Kurang <b>${fmtKg(-sisa)} kg</b>` : `Sisa <b>${fmtKg(sisa) || 0} kg</b>`}</span></div></div>
        ${users.length ? `<table class="po-table pl-mini kp-at"><thead><tr><th>MO SKU</th><th>Produk</th><th>Tanggal / week</th><th class="num">Ekstrak (kg)</th><th class="num">Porsi</th></tr></thead><tbody>
          ${users.map((x) => `<tr${late(x) ? ' class="kp-late"' : ''}><td><button type="button" class="btn-link" data-kpopen="${esc(x.no)}" title="Buka detail MO ini"><b>${esc(x.no)}</b></button>${isMan(x.no) ? '<i class="kf-mant">M</i>' : ''}</td><td><span class="pl-code">${esc(x.code)}</span><span class="pl-name">${esc(x.name)}</span></td><td>${kpWhen(x)}${late(x) ? '<div class="pl-bad kp-lt">⚠ sebelum ekstrak diproduksi</div>' : ''}</td><td class="num">${fmtKg(x.ekKg) || 0}</td><td class="num">${cap ? nf.format(Math.round((Number(x.ekKg) || 0) / cap * 100)) + '%' : '–'}</td></tr>`).join('')}
          <tr class="csl-tot"><th colspan="3">Total terpakai</th><th class="num">${fmtKg(used) || 0}</th><th class="num">${cap ? nf.format(Math.round(used / cap * 100)) + '%' : '–'}</th></tr></tbody></table>`
          : '<p class="check">Belum ada MO SKU yang memakai batch ekstrak ini. Pilih di Konfirmasi Produksi → kolom MO Ekstrak dipakai.</p>'}`;
    }
    if (!r.ek) return '';
    const e = r.moEk ? P.konf.get(r.moEk) : null;
    if (!e) return `<h3 class="kp-h">Batch ekstrak</h3><p class="check${r.moEk ? ' err' : ''}">${r.moEk ? `MO ekstrak ${esc(r.moEk)} tidak ditemukan.` : 'Belum dipilih MO ekstrak yang dipakai (Konfirmasi Produksi → kolom MO Ekstrak dipakai).'}</p>`;
    const cap = Number(e.kg !== '' ? e.kg : e.qty) || 0, others = all.filter((x) => x.moEk === e.no), used = others.reduce((t, x) => t + (Number(x.ekKg) || 0), 0);
    const late = e.tgl && r.tgl && r.tgl < e.tgl;
    return `<h3 class="kp-h">Batch ekstrak dipakai</h3>
      <dl class="kp-dl"><div><dt>MO ekstrak</dt><dd><b>${esc(e.no)}</b>${isMan(e.no) ? '<i class="kf-mant">M</i>' : ''} · ${esc(e.code)} ${esc(e.name)} · hasil ${fmtKg(cap)} kg</dd></div>
        <div><dt>Diproduksi</dt><dd>${kpWhen(e)}${late ? ' <span class="pl-bad">⚠ setelah MO ini</span>' : ''}</dd></div>
        <div><dt>Dipakai MO ini</dt><dd><b>${fmtKg(r.ekKg) || 0} kg</b> (${cap ? nf.format(Math.round((Number(r.ekKg) || 0) / cap * 100)) : 0}% batch)</dd></div>
        <div><dt>Batch dipakai juga oleh</dt><dd>${others.filter((x) => x.no !== r.no).map((x) => `${esc(x.no)} <span class="muted">${esc(x.code)} ${fmtKg(x.ekKg)} kg</span>`).join(', ') || '<span class="muted">–</span>'}</dd></div>
        <div><dt>Sisa batch</dt><dd class="${cap - used < -kfTol(cap) ? 'pl-bad' : ''}"><b>${fmtKg(cap - used) || 0} kg</b></dd></div></dl>
      <button type="button" class="btn-link" data-kpopen="${esc(e.no)}">Lihat alokasi lengkap batch ${esc(e.no)}</button>`;
  }
  function kpMoDialog(no) {
    const r = P.konf.get(no); if (!r) return;
    const b = r.bom ? bomById(r.code, r.bom) : null;
    openDialog({
      title: `MO ${no}`, ok: 'Buka di Plotting Harian', cancel: true,
      body: `<dl class="kp-dl">
        <div><dt>Produk</dt><dd><b>${esc(r.code)}</b> ${esc(r.name)}${kfIsEk(r.code) ? ' <span class="badge b-wait">Ekstrak</span>' : ''}</dd></div>
        <div><dt>Qty</dt><dd>${fmtQ(r.qty)} ${esc(r.uom)}${r.kg !== '' ? ` · ${fmtKg(r.kg)} kg` : ''}</dd></div>
        <div><dt>BoM</dt><dd>${b ? esc(refOf(b)) + ` <span class="muted">${esc(b.id)}</span>` : '–'}</dd></div>
        <div><dt>Tanggal produksi</dt><dd>${r.tgl ? esc(dayLbl(r.tgl)) + ' ' + r.tgl.slice(0, 4) : '<span class="muted">Belum diplot</span>'}</dd></div>
        <div><dt>Plotting Week</dt><dd>${r.week ? `${esc(r.week)} ${monShort(r.bulan)} ${r.bulan.slice(0, 4)}` : '–'}</dd></div>
        ${r.ek ? `<div><dt>Ekstrak dibutuhkan</dt><dd>${esc(r.ek)} ${esc(ekShortK(r.ek))}${r.ekKg !== '' && r.ekKg !== undefined ? ` · <b>${fmtKg(r.ekKg)} kg</b>` : ''}</dd></div>` : ''}
        ${r.note ? `<div><dt>Catatan</dt><dd>${esc(r.note)}</dd></div>` : ''}
      </dl>${kpEkAlloc(r)}`,
      wide: kfIsEk(r.code) || !!r.ek,
      onSubmit: async () => { if (r.week) { const sel = $('phWeek'); if (!sel.options.length) phWeek(); sel.value = r.bulan + '|' + r.week; } $('phQ').value = r.no; location.hash = '#/mrp/harian'; return ''; },
    });
  }
  $('dlgBody').addEventListener('click', (e) => { const b = e.target.closest('[data-kpopen]'); if (b) { e.preventDefault(); const no = b.dataset.kpopen; setTimeout(() => kpMoDialog(no), 0); $('dlgCancel').click(); } });
  $('kpMonth').addEventListener('change', renderKalender);
  $('kpWeek').addEventListener('change', renderKalender);
  $('kpView').addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    // jaga posisi: Month → Week ke week pertama bulan itu (atau week ini bila di bulan yang sama); Week → Month ke bulan week itu
    if (b.dataset.v === 'week' && P.kpView !== 'week') { kpWeekSel(); const m = $('kpMonth').value, cur = weekOfDate(todayStr()); const w = cur && cur.bulan === m ? cur : (P.monthWeeks.get(m) || [])[0]; if (w) $('kpWeek').value = w.bulan + '|' + w.week; }
    if (b.dataset.v === 'month' && P.kpView === 'week') { const w = P.weekBy.get($('kpWeek').value); if (w && [...$('kpMonth').options].some((o) => o.value === w.bulan)) $('kpMonth').value = w.bulan; }
    P.kpView = b.dataset.v; renderKalender();
  });
  ['kpPrev', 'kpNext'].forEach((id, k) => $(id).addEventListener('click', () => { const sel = $((P.kpView || 'month') === 'week' ? 'kpWeek' : 'kpMonth'), i = sel.selectedIndex + (k ? 1 : -1); if (i >= 0 && i < sel.options.length) { sel.selectedIndex = i; renderKalender(); } }));
  $('kpThis').addEventListener('click', () => {
    if ((P.kpView || 'month') === 'week') { const w = weekOfDate(todayStr()); if (w) { kpWeekSel(); $('kpWeek').value = w.bulan + '|' + w.week; renderKalender(); } return; }
    const sel = $('kpMonth'), cur = todayStr().slice(0, 7); if ([...sel.options].some((o) => o.value === cur)) { sel.value = cur; renderKalender(); }
  });
  $('kpQ').addEventListener('input', renderKalender);
  $('kpJenis').addEventListener('change', renderKalender);
  $('kpGrid').addEventListener('click', (e) => {
    const c = e.target.closest('.kp-mo'); if (c) { kpMoDialog(c.dataset.no); return; }
    const u = e.target.closest('.kp-un'); if (u) { const sel = $('phWeek'); if (!sel.options.length) phWeek(); sel.value = u.dataset.wk; }
  });

  $('pjExport').addEventListener('click', () => {
    if (P.pjCalc === 'now') {
      const N = P.pjNow; if (!N) return;
      const data = (P.pjRows || []).map((r) => {
        const d = r.d, o = { KODE: r.code, NAMA: r.name, UoM: r.uom, 'STOK UPLOAD': round4(d.awal), 'TGL STOK': d.stokDate, KOREKSI: round4(d.koreksi), GANTUNG: round4(d.gantung), INCOMING: round4(d.incPast), 'PEMAKAIAN MO': round4(d.pakaiPast), 'ADD/FOH/RS S/D HARI INI': round4(d.addPast), 'STOK TERKINI': round4(d.stok), 'PO TELAT/TANPA JADWAL': round4(d.poLate + d.poNone) };
        d.cols.forEach((c) => { const k = (c.lf || c.l).toUpperCase(); o[k + ' KEBUTUHAN'] = round4(c.need); o[k + ' ADD/FOH/RS'] = round4(c.add); o[k + ' PO'] = round4(c.po); o[k + ' SALDO'] = round4(c.sal); });
        o['PO SETELAH MPS'] = round4(d.poAfter); o['MULAI KURANG'] = r.firstShort >= 0 ? (d.cols[r.firstShort].lf || d.cols[r.firstShort].l) : ''; o.KURANG = round4(r.short);
        return o;
      });
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Proyeksi Stok');
      XLSX.writeFile(wb, `Proyeksi_Stok_Terkini_${todayStr()}.xlsx`); return;
    }
    const J = P.proj; if (!J) return;
    const data = (P.pjRows || []).map((r) => {
      const o = { KODE: r.code, NAMA: r.name, UoM: r.uom, 'DIPAKAI DI RENTANG': r.used ? 'YA' : 'TIDAK', 'STOK AWAL': round4(r.awal), 'STOK GANTUNG': round4(r.gant), 'STOK TERSEDIA': round4(r.start),
        'PO LEWAT TANGGAL': round4(r.po ? r.po.late : 0), 'PO BELUM DIJADWALKAN': round4(r.po ? r.po.unsched : 0) };
      J.weeks.forEach((w, i) => {
        if (i < J.s) return;
        const k = wLabel(w) + ' ' + w.bulan.slice(0, 4);
        o[k + ' IN'] = round4(r.inW[i]);
        if (J.moMode) { o[k + ' PLAN'] = round4(r.need[i]); o[k + ' PC'] = round4(r.pc[i]); o[k + ' CP'] = round4(r.cp[i]); } else o[k + ' KEBUTUHAN'] = round4(r.need[i]);
        o[k + ' ADD/FOH/RS'] = round4(r.outW[i] || 0);
        o[k + ' PO (INFO)'] = round4(r.po ? r.po.w[i] : 0);
        o[k + ' SALDO'] = round4(r.saldo[i]);
      });
      if (P.pjAfter) o[`PO ${P.pjAfter.label.toUpperCase()} DST (INFO)`] = round4(P.pjAfter.qty(r));
      o['MULAI KURANG'] = r.firstShort >= 0 ? wLabel(J.weeks[r.firstShort]) : ''; o.KURANG = round4(r.short);
      return o;
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Proyeksi Stok');
    XLSX.writeFile(wb, `Proyeksi_Stok_${J.moMode ? 'PC-CP_' : ''}${P.hz}_${todayStr()}.xlsx`);
  });

  /* ---------- Parameter SKU ---------- */
  const skuPayload = (k) => ({ kode: k.code, nama: k.name, jenis: k.jenis, bom: k.bom, batch: k.batchText, aktif: k.aktif ? 'Y' : 'N', catatan: k.note });
  async function saveSkuRow(p) {
    const res = await mrpApi('saveSku', { sku: p });
    P.skus.set(p.kode, { code: p.kode, name: p.nama, jenis: p.jenis || 'SKU', bom: p.bom, batchText: p.batch, batch: parseBatch(p.batch), aktif: p.aktif !== 'N', note: p.catatan, time: res.time });
    toast(`${p.kode} tersimpan.`);
    return res;
  }
  /* ---------- BoM Banded / 2in1 / KIT ---------- */
  function setRakitan(list) {
    P.rakitan = (list || []).map((r) => ({ code: r[0], bom: r[1], aktif: String(r[2] || 'Y').toUpperCase() !== 'N', note: r[3], time: r[4] }));
    syncRakitanSkus();
  }
  // Produk rakitan ikut daftar SKU (Rencana Produksi, Konfirmasi, perhitungan) dengan BoM dari menu BoM Banded/2in1/KIT.
  // Sumber tunggal: menu rakitan menimpa baris SKU_MRP dengan kode yang sama. Di Parameter SKU tampil terpisah (hanya baca).
  function syncRakitanSkus() {
    if (!P.skus) return;
    P.skus.forEach((v, c) => { if (v.rakitan) { P.skus.delete(c); if (v.orig) P.skus.set(c, v.orig); } });
    (P.rakitan || []).forEach((k) => {
      const orig = P.skus.get(k.code), b = (k.bom && bomById(k.code, k.bom)) || (MRP.byProduct.get(k.code) || [])[0];
      const name = ((MRP.master.get(k.code) || {}).name) || (b && b.name) || (orig && orig.name) || '';
      P.skus.set(k.code, { code: k.code, name, jenis: 'Rakitan', bom: b ? b.id : k.bom, batchText: '', batch: [], aktif: k.aktif, note: k.note, time: k.time, rakitan: true, orig: orig || null });
    });
    unitMemo.clear();
  }
  const rkJenis = (name) => (/\bkit\b/i.test(name) ? 'KIT' : /2\s*in\s*1/i.test(name) ? '2in1' : 'Banded');
  const rkBom = (k) => (k.bom && bomById(k.code, k.bom)) || (MRP.byProduct.get(k.code) || [])[0] || null;
  function renderRakitan() {
    if (!P.pakai) P.pakai = new Set();
    const q = $('rkQ').value.trim().toLowerCase(), j = $('rkJenis').value, ed = P.edit;
    const list = (P.rakitan || []).map((k) => {
      const b = rkBom(k), name = ((MRP.master.get(k.code) || {}).name) || (b && b.name) || '';
      return Object.assign({}, k, { b, name, jenis: rkJenis(name) });
    }).filter((k) => (!j || k.jenis === j) && (!q || (k.code + ' ' + k.name + ' ' + (k.b ? k.b.comps.map((c) => c.code + ' ' + c.name).join(' ') : '')).toLowerCase().includes(q)))
      .sort((a, b) => a.code.localeCompare(b.code, 'id', { numeric: true }));
    P.rkList = list;
    const fgSet = new Set(), pmSet = new Set();
    const rkHtml = list.map((k, i) => {
      const versions = MRP.byProduct.get(k.code) || [], b = k.b;
      const head = `<tr class="rk-head${k.aktif ? '' : ' is-off'}" data-i="${i}"><td class="mono"><b>${esc(k.code)}</b></td>
        <td colspan="2"><b>${esc(k.name)}</b><div class="rk-meta"><span class="badge rk-${k.jenis.toLowerCase()}">${k.jenis}</span>
          ${b ? `BoM <b>${esc(refOf(b))}</b> · batch ${fmtQ(b.batch)} ${esc(b.uom || '')}${versions.length > 1 ? ` · ${versions.length} versi` : ''}` : '<span class="pl-bad">BoM tidak ditemukan di DATABASE</span>'}
          · ${k.aktif ? '<span class="muted">ikut Rencana Produksi (pcs)</span>' : '<b>tidak aktif</b> (tidak ikut Rencana Produksi)'}
          · <b class="${b && rkLines(k.code, b).some((l) => P.pakai.has(k.code + '|' + l.src + '|' + l.code)) ? '' : 'pl-bad'}">${b ? rkLines(k.code, b).filter((l) => P.pakai.has(k.code + '|' + l.src + '|' + l.code)).length : 0}/${b ? rkLines(k.code, b).length : 0} material digunakan</b>${k.note ? ` · ${esc(k.note)}` : ''}</div></td>
        <td colspan="4" class="rk-act">${ed ? `${versions.length > 1 ? `<label class="rk-bomsel">BoM <select data-rkbom="${esc(k.code)}">${versions.map((v) => `<option value="${esc(v.id)}"${b && v.id === b.id ? ' selected' : ''}>${esc(refOf(v))}</option>`).join('')}</select></label>` : ''}
          <button type="button" class="btn-link" data-rkedit="${esc(k.code)}">Ubah</button> <button type="button" class="btn-link danger" data-rkdel="${esc(k.code)}">Hapus dari menu</button>` : ''}</td></tr>`;
      const lines = b ? rkLines(k.code, b) : [];
      const groups = new Map(); lines.forEach((l) => { if (!groups.has(l.src)) groups.set(l.src, []); groups.get(l.src).push(l); });
      const nYa = lines.filter((l) => P.pakai.has(k.code + '|' + l.src + '|' + l.code)).length;
      // Tampilan seperti BoM Odoo: bagian FG (tiap FG bisa dibuka untuk melihat pecahan RM/PM-nya) lalu PM tambahan
      if (!P.rkOpen) P.rkOpen = new Set();
      const srcs = [...groups.keys()].sort((x, y) => (x === 'RAKITAN') - (y === 'RAKITAN'));
      const ynBtn = (src) => (ed ? `<button type="button" class="btn-link" data-rkall="${esc(k.code)}|${esc(src)}|Y">Ya semua</button> · <button type="button" class="btn-link" data-rkall="${esc(k.code)}|${esc(src)}|N">Tidak semua</button>` : '');
      const compRow = (l, hide, fgKey) => {
        const m = MRP.master.get(l.code) || {}, on = P.pakai.has(k.code + '|' + l.src + '|' + l.code);
        if (l.dobLbl) return `<tr class="rk-comp rk-sub rk-dobl${on ? ' is-on' : ''}"><td></td><td>${esc(l.dobLbl)}</td><td></td>
            <td class="num">${fq(l.q * 1000)}</td><td class="num">${fq(l.q)}</td><td>${esc(l.uom || m.uom || '')}</td>
            <td>${ed ? `<span class="rk-yn" role="group"><button type="button" data-rkp="${esc(k.code)}|${esc(l.src)}|${esc(l.code)}|Y" aria-pressed="${on}">Ya</button><button type="button" data-rkp="${esc(k.code)}|${esc(l.src)}|${esc(l.code)}|N" aria-pressed="${!on}">Tidak</button></span>`
              : (on ? '<b class="rk-ya">Ya</b>' : '<span class="muted">Tidak</span>')}</td></tr>`;
        return `<tr class="rk-comp${on ? ' is-on' : ''}${fgKey ? ' rk-sub' : ''}"${fgKey ? ` data-fgrow="${esc(fgKey)}"` : ''}${hide ? ' hidden' : ''}><td class="mono">${esc(l.code)}</td><td>${esc(m.name || l.name || '')}${l.noBom ? ' <span class="pl-bad">(FG tanpa BoM)</span>' : ''}</td><td>${l.kind === 'ek' ? '<span class="badge b-wait">Ekstrak/bulk</span>' : esc(m.kat || '')}</td>
            <td class="num">${fq(l.q * 1000)}</td><td class="num">${fq(l.q)}</td><td>${esc(l.uom || m.uom || '')}</td>
            <td>${ed ? `<span class="rk-yn" role="group"><button type="button" data-rkp="${esc(k.code)}|${esc(l.src)}|${esc(l.code)}|Y" aria-pressed="${on}">Ya</button><button type="button" data-rkp="${esc(k.code)}|${esc(l.src)}|${esc(l.code)}|N" aria-pressed="${!on}">Tidak</button></span>`
              : (on ? '<b class="rk-ya">Ya</b>' : '<span class="muted">Tidak</span>')}</td></tr>`;
      };
      const dob = rkDobel(lines);
      const fgSrcs = srcs.filter((x) => x !== 'RAKITAN'), pmAll = groups.get('RAKITAN') || [], pmLs = pmAll.filter((l) => !dob.has(l.code));
      const isYa = (l) => P.pakai.has(k.code + '|' + l.src + '|' + l.code);
      let comps = '';
      if (fgSrcs.length) comps += `<tr class="rk-sec"><td colspan="7">FG <span class="muted">· dipecah ke bahan baku & kemasannya — klik FG untuk melihat dan memilih Ya/Tidak</span></td></tr>`;
      fgSrcs.forEach((src) => {
        const lsAll = groups.get(src), ls = lsAll.filter((l) => !dob.has(l.code)), nDob = lsAll.length - ls.length;
        const fgB = lsAll[0] && lsAll[0].fgBom, ya = ls.filter(isYa).length;
        fgSet.add(src);
        const key = k.code + '|' + src, open = P.rkOpen.has(key);
        const c = b.comps.find((x) => x.code === src), qFg = c && b.batch ? (Number(c.qty) || 0) / b.batch * 1000 : 0;
        comps += `<tr class="rk-src rk-fg${open ? ' is-open' : ''}" data-rkfg="${esc(key)}" tabindex="0" title="Klik untuk ${open ? 'menutup' : 'membuka'} pecahan FG"><td class="mono"><span class="rk-car" aria-hidden="true">${open ? '▾' : '▸'}</span> <b>${esc(src)}</b></td>
          <td>${esc(((MRP.master.get(src) || {}).name) || (c && c.name) || '')}<div class="rk-meta">${fgB ? `BoM Ref ${esc(refOf(fgB))} (${normU(fgB.uom) === 'kg' ? 'batch ' + fmtQ(fgB.batch) + ' kg' : fmtQ(fgB.batch) + ' pcs = 1.000 kg'})` : '<span class="pl-bad">FG tanpa BoM</span>'}</div></td>
          <td>FG</td><td class="num"><b>${fq(qFg)}</b></td><td class="num">${fq(qFg / 1000)}</td><td>${esc((c && c.uom) || 'Pcs')}</td>
          <td><b class="${ya ? '' : 'pl-bad'}">${ya}/${ls.length} Ya</b>${open && ed ? `<div class="rk-src-act">${ynBtn(src)}</div>` : ''}</td></tr>`;
        comps += ls.map((l) => compRow(l, !open, key)).join('')
          + (nDob ? `<tr class="rk-comp rk-sub rk-dobnote" data-fgrow="${esc(key)}"${open ? '' : ' hidden'}><td colspan="7" class="muted">+ ${nDob} PM yang juga ada di PM tambahan → lihat bagian <b>PM dobel</b> di bawah</td></tr>` : '');
      });
      if (pmAll.length) {
        pmSet.add(pmAll.map((l) => l.code).join());
        const ya = pmLs.filter((l) => P.pakai.has(k.code + '|' + l.src + '|' + l.code)).length;
        comps += `<tr class="rk-sec"><td colspan="6">PM tambahan <span class="muted">· hanya di BoM rakitan (di luar FG) · ${ya}/${pmLs.length} Ya</span></td><td class="rk-src-act">${pmLs.length ? ynBtn('RAKITAN') : ''}</td></tr>`
          + (pmLs.length ? pmLs.map((l) => compRow(l, false, '')).join('') : '<tr class="rk-comp"><td colspan="7" class="muted">Semua PM tambahan juga ada di FG — lihat PM dobel.</td></tr>');
      }
      if (dob.size) {
        const dl = lines.filter((l) => dob.has(l.code)), ya = dl.filter(isYa).length;
        comps += `<tr class="rk-sec rk-dob"><td colspan="6">PM dobel <span class="muted">· ada di pecahan FG dan juga di PM tambahan — pilih yang benar-benar dipakai supaya tidak terhitung dua kali · ${ya}/${dl.length} Ya</span></td><td class="rk-src-act">${ynBtn('DOBEL')}</td></tr>`;
        [...dob].forEach((code) => {
          const ls = dl.filter((l) => l.code === code).sort((x, y) => (x.src === 'RAKITAN') - (y.src === 'RAKITAN'));
          const m = MRP.master.get(code) || {}, nYa2 = ls.filter(isYa).length;
          comps += `<tr class="rk-dobh"><td class="mono"><b>${esc(code)}</b></td><td colspan="5"><b>${esc(m.name || ls[0].name || '')}</b> <span class="muted">· ${esc(m.kat || '')}</span></td><td>${nYa2 > 1 ? '<b class="pl-bad">dihitung ' + nYa2 + '×</b>' : nYa2 ? '<b class="rk-ya">1 Ya</b>' : '<span class="muted">Tidak dipakai</span>'}</td></tr>`
            + ls.map((l) => compRow(Object.assign({}, l, { dobLbl: l.src === 'RAKITAN' ? 'PM tambahan' : 'dari FG ' + l.src }), false, '')).join('');
        });
      }
      if (!pmAll.length && b) comps += `<tr class="rk-sec rk-none"><td colspan="7">PM tambahan <span class="muted">· tidak ada di BoM Odoo produk ini</span></td></tr>`;
      k.nYa = nYa; k.nLines = lines.length;
      return `<tbody class="rk-group">${head}${comps}</tbody>`;
    }).join('') || `<tbody><tr class="empty"><td colspan="7">${(P.rakitan || []).length ? 'Tidak ada yang cocok.' : (P.hasRakitan ? 'Belum ada kode. Klik "Tambah kode" (mode edit).' : 'Apps Script MRP perlu diperbarui (versi dengan BoM rakitan).')}</td></tr></tbody>`;
    // satu tbody per produk (kepala produk + komponennya)
    const tbl = $('rkTable'); tbl.querySelectorAll('tbody').forEach((t) => t.remove()); tbl.insertAdjacentHTML('beforeend', rkHtml);
    $('rkKpi').innerHTML = kpis([{ num: nf.format(list.length), lbl: 'produk rakitan' }, { num: nf.format(fgSet.size), lbl: 'komponen FG (unik)' },
      { num: nf.format(list.filter((k) => !k.nYa).length), lbl: 'belum ada material digunakan', tone: list.some((k) => !k.nYa) ? 'warn' : '' },
      { num: nf.format(list.filter((k) => k.aktif).length), lbl: 'aktif (ikut Rencana Produksi)' }]);
    $('rkInfo').textContent = `${nf.format(list.length)} produk ditampilkan${ed ? '' : ' · masuk Mode edit untuk menambah / mengubah'}`;
    $('rkAdd').disabled = !ed;
  }
  ['rkQ', 'rkJenis'].forEach((id) => $(id).addEventListener(id === 'rkQ' ? 'input' : 'change', renderRakitan));
  const rkToggle = (tr) => {
    if (!P.rkOpen) P.rkOpen = new Set();
    const key = tr.dataset.rkfg, open = !P.rkOpen.has(key);
    if (open) P.rkOpen.add(key); else P.rkOpen.delete(key);
    renderRakitan();
  };
  $('rkTable').addEventListener('click', (e) => { if (e.target.closest('button, select, a, input')) return; const tr = e.target.closest('tr[data-rkfg]'); if (tr) rkToggle(tr); });
  $('rkTable').addEventListener('keydown', (e) => { if (e.key !== 'Enter' && e.key !== ' ') return; const tr = e.target.closest('tr[data-rkfg]'); if (tr) { e.preventDefault(); rkToggle(tr); } });
  async function rkSave(rows, del, msg) {
    if (!P.hasRakitan) { toast('Apps Script MRP perlu diperbarui (versi dengan BoM rakitan).'); return; }
    const res = await mrpApi('saveRakitan', { rows, del });
    setRakitan(res.rakitan || []); renderRakitan(); if (msg) toast(msg);
  }
  function rkDialog(code) {
    const k = code ? (P.rakitan || []).find((x) => x.code === code) : null;
    // saran kode: produk di DATABASE yang BoM-nya berisi FG
    const sug = [...MRP.byProduct.entries()].filter(([c, l]) => !(P.rakitan || []).some((x) => x.code === c) && l.some((b) => b.comps.some((x) => isFg(x.code))))
      .map(([c, l]) => `<option value="${esc(c)}">${esc(((MRP.master.get(c) || {}).name) || l[0].name || '')}</option>`).join('');
    needEdit(() => openDialog({
      title: k ? `Ubah ${k.code}` : 'Tambah kode rakitan', ok: 'Simpan',
      body: `<div class="form-grid">
          <label class="field"><span>Kode produk *</span><input name="code" value="${esc(k ? k.code : '')}" ${k ? 'readonly' : 'list="rkSug" autocomplete="off"'} required placeholder="Bisa beberapa, pisah koma"></label>
          <label class="field"><span>Aktif</span><select name="aktif"><option value="Y"${!k || k.aktif ? ' selected' : ''}>Ya</option><option value="N"${k && !k.aktif ? ' selected' : ''}>Tidak</option></select></label>
          ${fld('note', 'Catatan', k ? k.note : '', { wide: true })}</div><datalist id="rkSug">${sug}</datalist>
        <p class="hint">${k ? 'BoM bisa dipilih langsung di tabel bila ada lebih dari satu versi.' : 'Daftar saran berisi produk yang BoM-nya mengandung FG. Bisa isi beberapa kode sekaligus, pisah koma.'}</p>`,
      onSubmit: async (fd) => {
        const codes = k ? [k.code] : String(fd.code || '').split(/[,;\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
        if (!codes.length) throw new Error('Isi kode produk.');
        const bad = codes.filter((c) => !MRP.byProduct.has(c));
        if (bad.length) throw new Error(`Tidak punya BoM di DATABASE: ${bad.join(', ')}`);
        await rkSave(codes.map((c) => { const o = (P.rakitan || []).find((x) => x.code === c); return [c, o ? o.bom : ((MRP.byProduct.get(c) || [])[0] || {}).id || '', fd.aktif, k ? fd.note : (o ? o.note : fd.note)]; }), []);
        return `${codes.length} kode tersimpan.`;
      },
    }));
  }
  $('rkAdd').addEventListener('click', () => rkDialog(''));
  $('view-mrp-rakitan').addEventListener('click', (e) => {
    const ed = e.target.closest('[data-rkedit]'); if (ed) { rkDialog(ed.dataset.rkedit); return; }
    const dl = e.target.closest('[data-rkdel]');
    if (dl) needEdit(() => openDialog({ title: `Hapus ${dl.dataset.rkdel} dari menu?`, ok: 'Hapus', danger: true,
      body: '<p>Kode ini hanya dihapus dari daftar menu BoM Banded/2in1/KIT. BoM di DATABASE PPIC tidak berubah.</p>',
      onSubmit: async () => { await rkSave([], [dl.dataset.rkdel]); return 'Dihapus dari menu.'; } }));
  });
  // Ya / Tidak digunakan (simpan langsung)
  async function rkPakaiSave(items) {
    if (!P.hasPakai) { toast('Apps Script MRP perlu diperbarui (versi dengan material rakitan).'); return; }
    items.forEach(([a, b, c, v]) => { const key = a + '|' + b + '|' + c; if (v === 'Y') P.pakai.add(key); else P.pakai.delete(key); });
    renderRakitan();
    try { const res = await mrpApi('setPakai', { items }); setPakai(res.rakitanPakai || []); renderRakitan(); }
    catch (err) { toast('Gagal menyimpan: ' + err.message + '. Muat ulang data.'); }
  }
  $('view-mrp-rakitan').addEventListener('click', (e) => {
    const t = e.target.closest('[data-rkp]');
    if (t) { const [a, b, c, v] = t.dataset.rkp.split('|'); if ((v === 'Y') === P.pakai.has(a + '|' + b + '|' + c)) return; needEdit(() => rkPakaiSave([[a, b, c, v]])); return; }
    const all = e.target.closest('[data-rkall]');
    if (all) {
      const [a, src, v] = all.dataset.rkall.split('|'), k = (P.rakitan || []).find((x) => x.code === a);
      const L = rkLines(a, k ? rkBom(k) : null), dob = rkDobel(L);
      const items = L.filter((l) => (src === 'DOBEL' ? dob.has(l.code) : l.src === src && !dob.has(l.code))).map((l) => [a, l.src, l.code, v]);
      needEdit(() => rkPakaiSave(items));
    }
  });
  $('view-mrp-rakitan').addEventListener('change', (e) => {
    const s = e.target.closest('[data-rkbom]'); if (!s) return;
    const k = (P.rakitan || []).find((x) => x.code === s.dataset.rkbom); if (!k) return;
    needEdit(() => rkSave([[k.code, s.value, k.aktif ? 'Y' : 'N', k.note]], [], `BoM ${k.code} diganti.`).catch((err) => toast('Gagal: ' + err.message)));
  });
  $('rkExport').addEventListener('click', () => {
    const rows = [];
    (P.rkList || []).forEach((k) => (k.b ? rkLines(k.code, k.b) : []).forEach((l) => {
      const m = MRP.master.get(l.code) || {};
      rows.push({ 'KODE RAKITAN': k.code, 'NAMA RAKITAN': k.name, JENIS: k.jenis, BOM: k.b ? refOf(k.b) : '', SUMBER: l.src === 'RAKITAN' ? 'PM tambahan' : 'FG ' + l.src,
        'KODE MATERIAL': l.code, 'NAMA MATERIAL': m.name || l.name || '', KATEGORI: l.kind === 'ek' ? 'Ekstrak/bulk' : m.kat || '', 'QTY PER 1.000 PCS': round4(l.q * 1000), 'QTY PER PCS': round4(l.q),
        UoM: l.uom || m.uom || '', DIGUNAKAN: P.pakai.has(k.code + '|' + l.src + '|' + l.code) ? 'Ya' : 'Tidak' });
    }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'BOM RAKITAN');
    XLSX.writeFile(wb, `BoM_Banded_2in1_KIT_${todayStr()}.xlsx`);
  });

  function renderSku() {
    const q = $('skQ').value.trim().toLowerCase(), j = $('skJenis').value;
    const rows = [...P.skus.values()].filter((k) => !k.rakitan && (!q || (k.code + ' ' + k.name).toLowerCase().includes(q)) && (!j || (j === 'off' ? !k.aktif : k.jenis === j)))
      .sort((a, b) => (a.jenis === b.jenis ? a.code.localeCompare(b.code, 'id', { numeric: true }) : a.jenis === 'SKU' ? -1 : 1));
    P.skRows = rows;
    $('skRows').innerHTML = rows.map((k, i) => {
      const list = MRP.byProduct.get(k.code) || [], b = bomById(k.code, k.bom);
      const subs = b ? [...new Set(b.comps.filter((c) => MRP.byProduct.has(c.code)).map((c) => c.code))] : [];
      return `<tr class="row${k.aktif ? '' : ' is-off'}" data-i="${i}" tabindex="0"><td class="mono">${esc(k.code)}</td><td>${esc(k.name)}</td><td>${esc(k.jenis)}</td>
        <td>${b ? `${esc(refOf(b))}` : `<span class="pl-bad">${k.bom ? esc(k.bom) + ' tidak ditemukan' : 'belum dipilih'}</span>`}${list.length > 1 ? ` <span class="muted">(${list.length} versi)</span>` : ''}</td>
        <td>${esc(k.batch.join(' · ')) || '<span class="muted">–</span>'}</td>
        <td>${subs.map((c) => `<span class="pl-chip" title="${esc((MRP.master.get(c) || {}).name || '')}">${esc(c)}</span>`).join(' ') || '<span class="muted">–</span>'}</td>
        <td>${k.aktif ? 'Ya' : '<span class="muted">Tidak</span>'}</td><td>${esc(k.note || '')}</td><td class="muted">${esc(k.time || '')}</td></tr>`;
    }).join('') || '<tr class="empty"><td colspan="9">Tidak ada SKU yang cocok.</td></tr>';
    const nS = [...P.skus.values()].filter((k) => !k.rakitan && k.jenis !== 'Ekstrak' && k.aktif).length;
    $('skInfo').textContent = `${nf.format(nS)} SKU aktif · ${nf.format([...P.skus.values()].filter((k) => k.jenis === 'Ekstrak').length)} ekstrak/bulk · klik baris untuk mengubah (mode edit)`;
    // Bagian terpisah: produk rakitan dari menu BoM Banded/2in1/KIT (hanya baca)
    const rk = [...P.skus.values()].filter((k) => k.rakitan && (!q || (k.code + ' ' + k.name).toLowerCase().includes(q)) && (!j || j === 'off' ? (j !== 'off' || !k.aktif) : false))
      .sort((a, b) => a.code.localeCompare(b.code, 'id', { numeric: true }));
    $('skRkRows').innerHTML = rk.map((k) => { const b = bomById(k.code, k.bom); return `<tr class="${k.aktif ? '' : 'is-off'}"><td class="mono"><a href="#/mrp/rakitan">${esc(k.code)}</a></td><td>${esc(k.name)}</td>
      <td><span class="badge rk-${rkJenis(k.name).toLowerCase()}">${rkJenis(k.name)}</span></td><td>${b ? esc(refOf(b)) + ` <span class="muted">${esc(b.id)}</span>` : '<span class="pl-bad">BoM tidak ditemukan</span>'}</td>
      <td>pcs</td><td>${skRkMat(k, b)}</td><td>${k.aktif ? 'Ya' : '<span class="muted">Tidak</span>'}</td><td>${esc(k.note || '')}</td><td class="muted">${esc(k.time || '')}</td></tr>`; }).join('')
      || `<tr class="empty"><td colspan="9">${(P.rakitan || []).length ? 'Tidak ada yang cocok dengan filter.' : 'Belum ada produk rakitan.'}</td></tr>`;
    $('skRkInfo').textContent = `${nf.format((P.rakitan || []).filter((k) => k.aktif).length)} produk rakitan aktif · diambil dari menu BoM Banded/2in1/KIT; ubah di sana`;
  }
  // Material yang dipotong stoknya untuk 1 produk rakitan = baris "Ya" di menu BoM Banded/2in1/KIT (pecahan FG + PM tambahan)
  function skRkMat(k, b) {
    if (!b) return '<span class="muted">–</span>';
    const all = rkLines(k.code, b), ya = all.filter((l) => P.pakai && P.pakai.has(k.code + '|' + l.src + '|' + l.code));
    if (!ya.length) return `<span class="pl-bad">Belum ada yang Ya</span> <span class="muted">(0/${all.length})</span> · <a href="#/mrp/rakitan">atur</a>`;
    const nFg = ya.filter((l) => l.src !== 'RAKITAN').length, nPm = ya.length - nFg;
    const grp = new Map(); ya.forEach((l) => { if (!grp.has(l.src)) grp.set(l.src, []); grp.get(l.src).push(l); });
    const order = [...grp.keys()].sort((a, c) => (a === 'RAKITAN') - (c === 'RAKITAN'));
    return `<details class="sk-rkmat"><summary><b>${ya.length}</b> material <span class="muted">(${nFg} pecahan FG · ${nPm} PM tambahan, dari ${all.length})</span></summary>
      <table class="po-table pl-mini"><thead><tr><th>Kode</th><th>Material</th><th>Kategori</th><th class="num">Qty / 1.000 pcs</th></tr></thead><tbody>
      ${order.map((src) => `<tr class="rk-src"><td colspan="4"><b>${src === 'RAKITAN' ? 'PM tambahan' : 'Dari FG ' + esc(src)}</b> <span class="muted">${src === 'RAKITAN' ? '' : esc(((MRP.master.get(src) || {}).name) || '')}</span></td></tr>`
        + grp.get(src).map((l) => { const m = MRP.master.get(l.code) || {}; return `<tr><td class="mono">${esc(l.code)}</td><td>${esc(m.name || l.name || '')}</td><td>${l.kind === 'ek' ? '<span class="badge b-wait">Ekstrak/bulk</span>' : esc(m.kat || '')}</td><td class="num">${fmtQ(l.q * 1000)} ${esc(normU(m.uom || l.uom || ''))}</td></tr>`; }).join('')).join('')}
      </tbody></table></details>`;
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
          if (cells.length) { await mrpApi('savePlan', { cells }); cells.forEach((c) => { P.plan.get(`${c.bulan}|${c.week}|${code}`).bom = fd.bom; }); toast(`${cells.length} week ikut dikunci ke ${refOf(bomById(code, fd.bom))}.`); }
        }
        renderSku();
      },
    });
    const fillBom = () => {
      const code = (isNew ? $('dlgBody').querySelector('[name=kode]').value : k.code).trim();
      const list = MRP.byProduct.get(code) || [];
      $('skBomSel').innerHTML = list.map((b) => `<option value="${esc(b.id)}"${k && b.id === k.bom ? ' selected' : ''}>${esc(refOf(b))} · ${b.comps.length} komponen</option>`).join('') || '<option value="">Kode belum punya BOM</option>';
    };
    fillBom();
    if (isNew) $('dlgBody').querySelector('[name=kode]').addEventListener('input', fillBom);
  }

  /* ---------- Update Data MRP: upload stok & rencana ---------- */
  function renderMrpUpdate() {
    const nG = P.gantung ? [...P.gantung.values()].filter((v) => v).length : 0;
    $('upGantNow').className = 'up-now' + (nG ? '' : ' is-empty');
    $('upGantNow').innerHTML = !P.hasGantung ? '<b>Apps Script MRP perlu diperbarui</b> supaya stok gantung bisa disimpan.'
      : nG ? `Tersimpan sekarang: ${nf.format(nG)} material stok gantung per <b>${fmtDate(P.gantungDate)}</b> · ${esc(P.gantungSrc)}` : 'Belum ada stok gantung (Stok Tersedia = Stok Awal).';
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
  // Format stok awal: semua material RM & PM di master, QTY kosong (diisi lalu di-upload di kartu ini)
  function stockTemplate(kind) {
    const gant = kind === 'gantung';
    if (!MRP.loaded) { toast('Data master material belum termuat. Tunggu sebentar lalu coba lagi.'); return; }
    const isRM = (k) => /raw|\brm\b/i.test(k || ''), isPM = (k) => /pack|\bpm\b/i.test(k || '');
    const list = [...MRP.master.values()].filter((m) => isRM(m.kat) || isPM(m.kat))
      .sort((a, b) => (isRM(b.kat) - isRM(a.kat)) || a.code.localeCompare(b.code, 'id', { numeric: true }));
    const aoa = [['KODE', 'NAMA MATERIAL', 'KATEGORI', 'UoM', 'QTY']].concat(list.map((m) => [m.code, m.name, m.kat, m.uom, '']));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 12 }, { wch: 60 }, { wch: 12 }, { wch: 8 }, { wch: 14 }];
    ws['!autofilter'] = { ref: `A1:E${aoa.length}` };
    // kolom KODE sebagai teks supaya kode berawalan 0 tidak berubah
    list.forEach((m, i) => { const c = ws['A' + (i + 2)]; if (c) { c.t = 's'; c.v = String(m.code); } });
    const nRM = list.filter((m) => isRM(m.kat)).length;
    const info = XLSX.utils.aoa_to_sheet([
      [gant ? 'Format stok gantung RM & PM (MRP PPIC GTK)' : 'Format stok awal RM & PM (MRP PPIC GTK)'], [''],
      [gant ? '1. Isi kolom QTY dengan stok yang tidak bisa dipakai (stok gantung) dalam satuan UoM di sebelahnya. Jangan ubah kolom KODE.' : '1. Isi kolom QTY dengan stok fisik / stok Odoo dalam satuan UoM di sebelahnya. Jangan ubah kolom KODE.'],
      ['2. QTY yang dibiarkan kosong dianggap 0.'],
      [gant ? '3. Upload di website: MRP → Update Data MRP → Upload stok gantung, lalu isi tanggalnya. Stok Tersedia = Stok Awal − Stok Gantung.' : '3. Upload di website: MRP → Update Data MRP → Upload stok RM/PM, lalu isi tanggal stok.'],
      [gant ? '4. Upload stok gantung mengganti seluruh stok gantung sebelumnya.' : '4. Upload stok mengganti seluruh stok yang tersimpan sebelumnya.'], [''],
      ['Jumlah material', `${list.length} (RM ${nRM}, PM ${list.length - nRM})`], ['Dibuat', todayStr()],
    ]);
    info['!cols'] = [{ wch: 100 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, gant ? 'STOK GANTUNG' : 'STOK AWAL');
    XLSX.utils.book_append_sheet(wb, info, 'PETUNJUK');
    XLSX.writeFile(wb, `Format_${gant ? 'Stok_Gantung' : 'Stok_Awal'}_RM_PM_${todayStr()}.xlsx`);
  }
  $('stockTpl').addEventListener('click', () => stockTemplate('awal'));
  $('gantTpl').addEventListener('click', () => stockTemplate('gantung'));
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

  // Upload Stok Gantung (format sama dengan stok)
  $('gantFile').addEventListener('change', async () => {
    const f = $('gantFile').files[0];
    $('gantName').textContent = f ? f.name : 'Belum ada file';
    $('gantCheck').className = 'check'; $('gantCheck').textContent = '';
    P.parsedGant = null; $('gantSend').disabled = true;
    if (!f) return;
    try {
      const p = parseStock(await readBook(f), f.name);
      p.file = f.name; p.rows = p.rows.filter((r) => r.qty); P.parsedGant = p;
      if (!$('gantDate').value) $('gantDate').value = p.date || P.stockDate || todayStr();
      const notM = p.rows.filter((r) => !MRP.master.has(r.code));
      const over = p.rows.filter((r) => r.qty > ((P.stock.get(r.code) || {}).qty || 0));
      $('gantCheck').className = 'check ok';
      $('gantCheck').innerHTML = `Terbaca dari sheet <b>${esc(p.sheet)}</b>: <b>${nf.format(p.rows.length)}</b> material dengan stok gantung (qty kosong/0 dilewati).`
        + (notM.length ? `<br><span class="pl-bad">${nf.format(notM.length)} kode tidak ada di master</span>: ${esc(notM.slice(0, 12).map((r) => r.code).join(', '))}` : '')
        + (over.length ? `<br><span class="pl-warn-t">${nf.format(over.length)} material: stok gantung lebih besar dari stok awal</span> (stok tersedia jadi minus): ${esc(over.slice(0, 8).map((r) => r.code).join(', '))}${over.length > 8 ? '…' : ''}` : '');
      $('gantSend').disabled = !P.hasGantung;
      if (!P.hasGantung) $('gantCheck').innerHTML += '<br><span class="pl-bad">Apps Script MRP perlu diperbarui dulu.</span>';
    } catch (err) { $('gantCheck').className = 'check err'; $('gantCheck').textContent = err.message; }
  });
  $('gantSend').addEventListener('click', () => needEdit(async () => {
    const p = P.parsedGant, date = $('gantDate').value;
    if (!p) return;
    if (!date) { $('gantCheck').className = 'check err'; $('gantCheck').textContent = 'Isi tanggal stok gantung dulu.'; return; }
    $('gantSend').disabled = true; $('gantResult').className = 'send-result'; $('gantResult').textContent = 'Mengirim ke Google Sheet…';
    try {
      const res = await mrpApi('uploadGantung', { date, file: p.file, rows: p.rows.map((r) => [r.code, r.name, round4(r.qty), r.uom]) });
      $('gantResult').className = 'send-result ok';
      $('gantResult').textContent = `Tersimpan ${savedAt(res)}: ${nf.format(res.saved)} material stok gantung per ${fmtDate(date)}.`;
      P.parsedGant = null; $('gantFile').value = ''; $('gantName').textContent = 'Belum ada file';
      loadMrp(true);
    } catch (err) { $('gantResult').className = 'send-result err'; $('gantResult').textContent = 'Gagal: ' + err.message; $('gantSend').disabled = false; }
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
  // Kolom plan satu bulan: "PLAN NOVEMBER 2026", "PLAN BULAN NOVEMBER", "TOTAL NOVEMBER", "2026-11 PLAN"
  function monthHeader(h) {
    const s = txt(h).toUpperCase().replace(/\s+/g, ' ');
    let m = s.match(/^(\d{4})-(\d{2}) (?:PLAN|TOTAL)$/);
    if (m) return `${m[1]}-${m[2]}`;
    m = s.match(/^(?:PLAN BULAN|PLAN|TOTAL PLAN|TOTAL) ([A-Z]+)(?: (\d{4}))?$/);
    if (!m || !MON_MAP[m[1]]) return null;
    const w = weekHeader(`W1 ${m[1]}${m[2] ? ' ' + m[2] : ''}`);
    return w ? w.bulan : null;
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
        const mcols = new Map();
        head.forEach((x, i) => { const b = monthHeader(x); if (b && !mcols.has(b)) mcols.set(b, i); });
        const monthCells = [];
        if (mcols.size) rows.slice(h + 1).forEach((r) => {
          const code = normCode(r[iK]); if (!code || /^total/i.test(code)) return;
          mcols.forEach((i, b) => { const q = Number(r[i]); if (q > 0) monthCells.push({ bulan: b, code, qty: q }); });
        });
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
        return { sheet: sn, months, cells, monthMonths: [...mcols.keys()].sort(), monthCells, unknown: [...unknown], notSku: [...notSku], warn, noWeek };
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
        + (p.monthMonths.length ? `<br>Kolom <b>Plan bulan</b> terbaca untuk ${p.monthMonths.map(monLabel).join(', ')}: ${nf.format(p.monthCells.length)} SKU. Plan bulan yang tersimpan untuk bulan itu ikut diganti.` : '<br><span class="muted">Tidak ada kolom Plan bulan (mis. "PLAN NOVEMBER 2026") di file; Plan bulan yang tersimpan tidak berubah.</span>')
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
      const body = { months: p.months, file: p.file, rows: p.cells.map((c) => [c.bulan, c.week, c.code, c.kg, ((P.plan.get(`${c.bulan}|${c.week}|${c.code}`) || {}).bom) || (activeBom(c.code) || {}).id || '']) };
      if (p.monthMonths.length) { body.monthMonths = p.monthMonths; body.monthRows = p.monthCells.map((c) => [c.bulan, c.code, c.qty]); }
      const res = await mrpApi('replacePlan', body);
      $('planResult').className = 'send-result ok';
      $('planResult').textContent = `Tersimpan ${savedAt(res)}: ${nf.format(res.saved)} sel untuk ${p.months.map(monLabel).join(', ')}.`
        + (p.monthMonths.length ? (res.monthSaved === undefined ? ' Plan bulan TIDAK tersimpan: Apps Script MRP perlu diperbarui.' : ` Plan bulan: ${nf.format(res.monthSaved)} SKU.`) : '');
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
    let noStock = [];
    if (MRP.loaded && P.weeks.length) {
      const J = computeProj();
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
        head: ['Bulan', 'Week', 'Kode', 'Qty kg', 'BOM terkunci'], row: (p) => [monLabel(p.bulan), p.week, p.code, fmtKg(p.kg), p.bom ? 'versi yang dikunci sudah dihapus' : '(kosong)'] },
      skuBad: { label: 'SKU: BOM default tidak valid', badge: true, rows: skuBad,
        desc: 'SKU di Parameter SKU yang BOM default-nya kosong atau sudah tidak ada. Hitungan memakai BOM pertama sampai diperbaiki.',
        head: ['Kode', 'Nama', 'Jenis', 'BOM tersimpan'], row: (k) => [k.code, k.name, k.jenis, k.bom ? 'versi tersimpan sudah dihapus' : '(kosong)'], bom: (k) => k.code },
      planBatch: { label: 'Rencana: bukan ukuran batch', badge: false, rows: planBatch,
        desc: 'Qty kg yang tidak bisa disusun dari ukuran batch SKU (Parameter SKU). Hanya peringatan; tetap dihitung.',
        head: ['Bulan', 'Week', 'Kode', 'Qty kg', 'Ukuran batch (kg)'], row: (x) => [monLabel(x.p.bulan), x.p.week, x.p.code, fmtKg(x.p.kg), x.sku.batch.join(', ')] },
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
      desc: 'Baris PO RM/PM yang belum dijadwalkan di Odoo, sehingga tidak masuk kalender.', link: '#/po/monitoring', linkLabel: 'Monitoring PO',
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
      const bad = ['planNoBom', 'lockGone', 'skuBad'].flatMap((k) => (ck[k] ? ck[k].rows.map((x, i) => k + i) : []));
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
  /* ---------- Menu MRP: klik judul kolom untuk mengurutkan (semua tabel; urutan tidak diingat) ----------
     Klik 1×: terbanyak di atas (kolom teks A→Z; Saldo & Mulai kurang: paling minus / paling awal di atas), 2×: kebalikannya, 3×: urutan awal.
     Bekerja di DOM: baris yang sudah digambar diurutkan ulang, jadi klik baris & rincian tetap jalan. Sel kosong selalu di bawah. */
  const MS = { state: new Map(), busy: false };
  function msGrid(thead) {
    const rows = [...thead.rows], occ = [], cells = [];
    rows.forEach((tr, ri) => {
      occ[ri] = occ[ri] || [];
      let c = 0;
      [...tr.cells].forEach((th) => {
        while (occ[ri][c]) c++;
        const cs = th.colSpan || 1, rs = th.rowSpan || 1;
        for (let r = 0; r < rs; r++) { occ[ri + r] = occ[ri + r] || []; for (let k = 0; k < cs; k++) occ[ri + r][c + k] = th; }
        cells.push({ th, col: c, span: cs, bottom: ri + rs === rows.length });
        c += cs;
      });
    });
    return { occ, cells };
  }
  const msSig = (occ, col) => [...new Set(occ.map((r) => r[col]).filter(Boolean))].map((th) => th.textContent.trim()).join('|');
  function msCell(tr, col) {
    let c = 0;
    for (const td of tr.cells) { if (col < c + (td.colSpan || 1)) return col === c ? td : null; c += td.colSpan || 1; }
    return null;
  }
  function msVal(td, num) {
    if (!td) return null;
    if (td.dataset.v !== undefined && td.dataset.v !== '') return Number(td.dataset.v);
    const el = td.querySelector('b') || td;
    const cut = el.matches('.num-cut') ? el : el.querySelector('.num-cut');
    const t = (cut && cut.title ? cut.title : el.textContent).replace(/−/g, '-').trim();
    if (!t || t === '–' || t === '-') return null;
    if (!num) return t.toLowerCase();
    const m = t.match(/-?\d[\d.]*(?:,\d+)?/);
    return m ? Number(m[0].replace(/\./g, '').replace(',', '.')) : null;
  }
  // kolom angka: judul ber-class num, sel ber-data-v, atau ≥ 80% sel berisi angka saja
  function msIsNum(table, th, col) {
    if (th.classList.contains('num')) return true;
    const rows = [...table.tBodies[0].rows].filter((tr) => !tr.classList.contains('empty'));
    let n = 0, ok = 0;
    rows.forEach((tr) => { const td = msCell(tr, col); if (!td) return; if (td.dataset.v !== undefined) { n++; ok++; return; } const t = td.textContent.replace(/\u2212/g, '-').trim(); if (!t || t === '–') return; n++; if (/^-?\d/.test(t)) ok++; });
    return n > 0 && ok / n >= 0.8;
  }
  const msAscFirst = (th) => /^(saldo|mulai kurang)/i.test(th.textContent.trim()) || th.classList.contains('pj-ssal');
  const msOk = (table) => table && table.tHead && table.tBodies[0] && !table.querySelector('th[data-sk]') && !table.classList.contains('mrp-tree');
  function msDecorate(table) {
    const { cells } = msGrid(table.tHead);
    cells.forEach(({ th, span, bottom }) => {
      if (th.dataset.msort || span !== 1 || !bottom || !th.textContent.trim()) return;
      th.dataset.msort = '1'; th.tabIndex = 0; th.classList.add('ms-th');
      th.title = (th.title ? th.title + ' · ' : '') + 'Klik untuk mengurutkan';
      th.insertAdjacentHTML('beforeend', '<span class="sort-ind" aria-hidden="true"></span>');
    });
  }
  function msApply(table) {
    const st = MS.state.get(table), tb = table.tBodies[0];
    const rows = [...tb.rows].filter((tr) => !tr.classList.contains('empty'));
    if (rows.some((tr) => tr.dataset.o0 === undefined)) rows.forEach((tr, i) => { tr.dataset.o0 = i; });
    const { occ, cells } = msGrid(table.tHead);
    let col = -1, th = null;
    if (st) { const hit = cells.find((c) => c.th.dataset.msort && msSig(occ, c.col) === st.sig); if (hit) { col = hit.col; th = hit.th; } }
    table.tHead.querySelectorAll('th[data-msort]').forEach((h) => {
      h.classList.toggle('is-sorted', h === th);
      if (h === th) h.setAttribute('aria-sort', st.dir === 'asc' ? 'ascending' : 'descending'); else h.removeAttribute('aria-sort');
    });
    let order;
    if (col < 0) order = rows.slice().sort((a, b) => a.dataset.o0 - b.dataset.o0);
    else {
      const num = msIsNum(table, th, col);
      const k = rows.map((tr) => ({ tr, v: msVal(msCell(tr, col), num), o: Number(tr.dataset.o0) }));
      const sg = st.dir === 'asc' ? 1 : -1;
      k.sort((a, b) => (a.v === null) - (b.v === null) || (a.v === null ? a.o - b.o : (a.v < b.v ? -sg : a.v > b.v ? sg : a.o - b.o)));
      order = k.map((x) => x.tr);
    }
    if (order.every((tr, i) => rows[i] === tr)) return;
    const frag = document.createDocumentFragment(); order.forEach((tr) => frag.appendChild(tr));
    tb.insertBefore(frag, tb.firstChild);
  }
  document.querySelectorAll('[id^="view-mrp-"]').forEach((sec) => {
    let q = false;
    const scan = () => { sec.querySelectorAll('table').forEach((t) => { if (!msOk(t)) return; msDecorate(t); msApply(t); }); };
    const mo = new MutationObserver(() => {
      if (MS.busy || q) return; q = true;
      Promise.resolve().then(() => { q = false; MS.busy = true; try { scan(); } finally { mo.takeRecords(); MS.busy = false; } });
    });
    mo.observe(sec, { childList: true, subtree: true });
    const click = (e) => {
      const th = e.target.closest('th[data-msort]'); if (!th || !sec.contains(th)) return;
      if (e.target.closest('button, a, input, select')) return;
      const table = th.closest('table'); if (!msOk(table)) return;
      const { occ, cells } = msGrid(table.tHead), c = cells.find((x) => x.th === th); if (!c) return;
      const isId = /^(kode|no\.?|sku|material)/i.test(th.textContent.trim());
      const sig = msSig(occ, c.col), cur = MS.state.get(table), first = msAscFirst(th) || isId ? 'asc' : (msIsNum(table, th, c.col) ? 'desc' : 'asc');
      if (!cur || cur.sig !== sig) MS.state.set(table, { sig, dir: first });
      else if (cur.dir === first) MS.state.set(table, { sig, dir: first === 'asc' ? 'desc' : 'asc' });
      else MS.state.delete(table);
      MS.busy = true; try { msApply(table); } finally { mo.takeRecords(); MS.busy = false; }
    };
    sec.addEventListener('click', click);
    sec.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('th[data-msort]')) { e.preventDefault(); click(e); } });
  });
  // urutan tidak diingat: pindah halaman → kembali ke urutan awal
  window.addEventListener('hashchange', () => { [...MS.state.keys()].forEach((t) => { MS.state.delete(t); if (t.isConnected) msApply(t); }); });

  /* ================= Purchase Request ================= */
  // Data di Google Sheet MONITORING PO (tab REKAP_PR, lewat Code.gs PO). Rekap PR = tempat input; Formulir PR menarik data dari Rekap per Kode PR.
  // Baris rekap: { kodePr, tanggal, no, kode, nama, jenis, note, stok, butuh, ospo, kurang, buka, pakai, kirim, pos[], status, time, by }
  const PR_NUM = ['stok', 'butuh', 'ospo', 'kurang', 'buka', 'pakai'];
  const PR_COLS = [
    { k: 'stok', h: 'Stok Terkini', u: '(Kg/Pcs)' }, { k: 'butuh', h: 'Kebutuhan', u: '(Kg/Pcs)' }, { k: 'ospo', h: 'OS PO', u: '(Kg/Pcs)' },
    { k: 'kurang', h: 'Kekurangan', u: '(Kg/Pcs)' }, { k: 'buka', h: 'Jumlah Buka PO', u: '(Kg/Pcs)' }, { k: 'pakai', h: 'Pemakaian', u: '(Bulan)' },
  ];
  const prColH = (c) => (PRM() === 'lt' && c.k === 'stok' ? 'Stok Awal' : c.h);
  const splitPo = (t) => String(t || '').split(/[,;\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
  // PR Reguler (PR/GTK/…) dan PR LT Panjang (PR-LT/GTK/…) disimpan di tab yang sama, tampil di menu terpisah
  const isLtPr = (k) => String(k || '').startsWith('PR-LT/');
  const PRM = () => (String(state.routeKey || '').startsWith('prlt/') ? 'lt' : 'reg');
  function prApplyMode() { state.pr = (state.prAll || []).filter((r) => isLtPr(r.kodePr) === (PRM() === 'lt')); }
  function setPrData(list) {
    state.prAll = (list || []).map((r) => ({ kodePr: r[0], tanggal: r[1], no: r[2], kode: r[3], nama: r[4], jenis: r[5], note: r[6],
      stok: r[7], butuh: r[8], ospo: r[9], kurang: r[10], buka: r[11], pakai: r[12], kirim: r[13], pos: splitPo(r[14]), status: r[15] || 'Aktif', time: r[16], by: r[17] }));
    prApplyMode();
    state.prByPo = new Map();
    state.prAll.forEach((r) => { if (r.status !== 'Batal') r.pos.forEach((po) => { const s = state.prByPo.get(po) || new Set(); s.add(r.kodePr); state.prByPo.set(po, s); }); });
  }
  // Kelompok per Kode PR
  function prGroups() {
    const m = new Map();
    (state.pr || []).forEach((r) => { const g = m.get(r.kodePr) || { kodePr: r.kodePr, tanggal: r.tanggal, rows: [] }; g.rows.push(r); m.set(r.kodePr, g); });
    m.forEach((g) => { g.rows.sort((a, b) => a.no - b.no); g.batal = g.rows.every((r) => r.status === 'Batal'); });
    return [...m.values()].sort((a, b) => (a.kodePr < b.kodePr ? 1 : -1));
  }
  const prDefKode = (date) => `${PRM() === 'lt' ? 'PR-LT' : 'PR'}/GTK/${(date || todayStr()).slice(2, 4)}${(date || todayStr()).slice(5, 7)}/…`;
  const prDateTxt = (d) => { if (!d) return ''; const [y, m, dd] = d.split('-'); return `${Number(dd)}-${BULAN_ID[Number(m) - 1]}-${y.slice(2)}`; };
  // Split jadwal kirim: kolom TANGGAL KIRIM berisi "2026-12-01=500; 2026-12-15=500" (satu baris material, beberapa jadwal)
  const prSched = (v) => { const t = String(v || '').trim(); if (!t.includes('=')) return null; const L = t.split(';').map((x) => x.trim()).filter(Boolean).map((x) => { const [d, q] = x.split('='); return { d: String(d || '').trim(), q: prNum(String(q || '').trim()) }; }); return L.length ? L : null; };
  const prSchedStr = (L) => L.map((x) => `${x.d}=${x.q === '' ? '' : x.q}`).join('; ');
  const prKirimLines = (v) => { const L = prSched(v); return L ? L.map((x) => `${prDateTxt(x.d)}: ${prNumTxt(x.q)}`) : (v ? [prDateTxt(v)] : []); };
  const prKirimFirst = (v) => { const L = prSched(v); return L ? L.map((x) => x.d).filter(Boolean).sort()[0] || '' : v || ''; };
  const prNum = (v) => (v === '' || v === null || v === undefined ? '' : Number(String(v).replace(',', '.')));
  // Pemakaian (Bulan): angka disimpan sebagai angka, selain itu (mis. "2-3", "3 bulan") disimpan apa adanya sebagai teks
  const prPakaiVal = (v) => { const t = String(v === undefined || v === null ? '' : v).trim(); if (!t) return ''; const n = Number(t.replace(',', '.')); return isNaN(n) ? t : n; };
  const prNumTxt = (v, dash = '-') => { if (v === '' || v === null || v === undefined) return dash; const n = Number(v); return isNaN(n) ? esc(v) : new Intl.NumberFormat('id-ID', { maximumFractionDigits: 4 }).format(n); };
  // qty PO (dari Monitoring PO) untuk No PO yang tercatat + kode material yang sama
  function prPoQty(r) {
    if (!r.pos.length) return null;
    const set = new Set(r.pos);
    const lines = (state.rows || []).filter((x) => set.has(x.po) && x.code === r.kode && !x.cancel);
    return { qty: lines.reduce((t, x) => t + (Number(x.qty) || 0), 0), found: new Set(lines.map((x) => x.po)), uom: (lines[0] || {}).uom || '' };
  }
  const prStatus = (r) => (r.status === 'Batal' ? { t: 'Batal', cls: 'b-cancel' } : r.pos.length ? { t: 'Sudah ada PO', cls: 'b-done' } : { t: 'Belum ada PO', cls: 'b-none' });
  const prPoLinks = (r) => r.pos.map((po) => `<button type="button" class="btn-link pr-po" data-gopo="${esc(po)}" data-gocode="${esc(r.kode)}" title="Buka ${esc(po)} di Monitoring PO">${esc(po)}</button>`).join(' ');

  /* ---------- Rekap PR ---------- */
  function renderPrRekap() {
    if (!$('prRows')) return;
    const groups = prGroups();
    const months = [...new Set(groups.map((g) => g.tanggal.slice(0, 7)).filter(Boolean))].sort().reverse();
    const curM = $('prMon').value;
    $('prMon').innerHTML = '<option value="">Semua bulan</option>' + months.map((m) => `<option value="${m}"${m === curM ? ' selected' : ''}>${esc(monLabel(m))}</option>`).join('');
    const q = $('prQ').value.trim().toLowerCase(), mon = $('prMon').value, st = $('prSt').value;
    let rows = (state.pr || []).filter((r) => (!mon || r.tanggal.slice(0, 7) === mon)
      && (!q || (r.kodePr + ' ' + r.kode + ' ' + r.nama + ' ' + r.note + ' ' + r.pos.join(' ')).toLowerCase().includes(q))
      && (!st || prStatus(r).t === st));
    rows = rows.slice().sort((a, b) => (a.kodePr < b.kodePr ? 1 : a.kodePr > b.kodePr ? -1 : a.no - b.no));
    const ed = state.edit.on;
    let prev = '';
    // Per Kode PR: satu baris ringkasan (klik untuk buka rinciannya). Pencarian membuka otomatis PR yang cocok.
    state.prOpen = state.prOpen || new Set();
    const byPr = new Map(); rows.forEach((r) => { if (!byPr.has(r.kodePr)) byPr.set(r.kodePr, []); byPr.get(r.kodePr).push(r); });
    const autoOpen = !!(q || st);
    $('prRows').innerHTML = [...byPr].map(([kodePr, L]) => {
      const open = autoOpen || state.prOpen.has(kodePr), all = (state.pr || []).filter((x) => x.kodePr === kodePr);
      const act = all.filter((x) => x.status !== 'Batal'), stc = new Map(); act.forEach((x) => { const t = prStatus(x); const o = stc.get(t.t) || { n: 0, cls: t.cls }; o.n++; stc.set(t.t, o); });
      const stx = prStatusOf(kodePr), ht = prHitungOf(kodePr), gm = new Set(stx.filter((x) => x.po).map((x) => x.kode)), nm = new Set(stx.map((x) => x.kode)), mn = ht.filter((x) => x.data && x.data.minus).length, nl = prLampOf(kodePr).length;
      const names = act.slice(0, 3).map((x) => x.nama || x.kode).join(', ') + (act.length > 3 ? ` +${act.length - 3}` : '');
      const head = `<tr class="pr-grp${open ? ' is-open' : ''}${act.length ? '' : ' is-takeout'}" data-prg="${esc(kodePr)}">
        <td class="pr-kc"><span class="pr-chev" aria-hidden="true">${open ? '▾' : '▸'}</span><button type="button" class="btn-link" data-openpr="${esc(kodePr)}" title="Buka formulir PR ini">${esc(kodePr)}</button>${ed ? ` <button type="button" class="btn-link" data-editpr="${esc(kodePr)}">Ubah</button> <button type="button" class="btn-link danger pr-del" data-prdelall="${esc(kodePr)}" title="Hapus seluruh PR ini secara permanen">Hapus PR</button>` : ''}
          ${nm.size || ht.length ? `<small class="pr-lamps">${ht.length ? `${mn ? `<span class="pl-bad">${mn} minus</span>` : 'tidak minus'} · ` : ''}${nm.size ? `${gm.size} PO gantung / ${nm.size}` : ''}</small>` : ''}<button type="button" class="pr-lampbtn${nl ? ' has' : ''}" data-lamppr="${esc(kodePr)}" title="Lampiran PR (perhitungan, status PO & gambar)">${nl ? `📎 ${nl} lampiran` : 'Sertakan lampiran'}</button></td>
        <td class="date">${esc(prDateTxt(all[0] ? all[0].tanggal : ''))}</td>
        <td colspan="13" class="pr-gsum"><b>${act.length}</b> material${all.length - act.length ? ` <span class="muted">(+${all.length - act.length} batal)</span>` : ''} · ${esc(names)}${open ? '' : ' <span class="muted">· klik untuk lihat rincian</span>'}</td>
        <td>${[...stc].map(([t, o]) => `<span class="badge ${o.cls}">${o.n > 1 ? o.n + ' ' : ''}${t}</span>`).join(' ') || '<span class="badge b-muted">Batal</span>'}</td></tr>`;
      if (!open) return head;
      return head + L.map((r) => {
        const s = prStatus(r), pq = prPoQty(r), unk = pq ? r.pos.filter((po) => !pq.found.has(po)) : [];
        return `<tr class="row pr-det${r.status === 'Batal' ? ' is-takeout' : ''}">
        <td class="pr-kc">${ed ? `<button type="button" class="btn-link danger pr-del" data-prdel="${esc(r.kodePr)}" data-prdel-no="${r.no}" data-prdel-kode="${esc(r.kode)}" title="Hapus baris ini secara permanen">Hapus</button>` : ''}</td>
        <td></td><td class="num">${r.no}</td>
        <td class="mono">${esc(r.kode)}</td><td>${esc(r.nama)}</td><td>${esc(r.jenis)}</td><td>${esc(r.note)}</td>
        ${PR_NUM.map((k) => `<td class="num">${prNumTxt(r[k], '')}</td>`).join('')}
        <td class="date">${prKirimLines(r.kirim).map(esc).join('<br>')}</td>
        <td>${prPoLinks(r) || '<span class="muted">–</span>'}${pq ? `<small class="pr-poq">qty PO ${prNumTxt(pq.qty, '0')} ${esc(pq.uom)}${r.buka !== '' ? ` / buka ${prNumTxt(r.buka)}` : ''}</small>` : ''}${unk.length ? `<small class="pl-bad">tidak ada di data PO untuk kode ini: ${esc(unk.join(', '))}</small>` : ''}</td>
        <td><span class="badge ${s.cls}">${s.t}</span></td></tr>`;
      }).join('');
    }).join('') || `<tr class="empty"><td colspan="16">${(state.pr || []).length ? 'Tidak ada PR yang cocok.' : (state.noPrScript ? 'Apps Script MONITORING PO perlu diperbarui (versi dengan Purchase Request).' : 'Belum ada PR. Klik "Tambah PR baru" (mode edit) atau upload Excel.')}</td></tr>`;
    if ($('prExpand')) $('prExpand').textContent = state.prOpen.size >= byPr.size && byPr.size ? 'Tutup semua' : 'Buka semua';
    const nG = groups.length, nAct = groups.filter((g) => !g.batal).length;
    const lines = (state.pr || []).filter((r) => r.status !== 'Batal');
    $('prKpi').innerHTML = kpis([{ num: nf.format(nAct), lbl: 'PR aktif' }, { num: nf.format(lines.length), lbl: 'baris material' },
      { num: nf.format(lines.filter((r) => !r.pos.length).length), lbl: 'belum ada PO', tone: lines.some((r) => !r.pos.length) ? 'warn' : '' },
      { num: nf.format(nG - nAct), lbl: 'PR batal' }]);
    $('prInfo').textContent = `${nf.format(rows.length)} baris ditampilkan · klik Kode PR untuk membuka formulir · klik No PO untuk membuka di Monitoring PO${ed ? '' : ' · masuk Mode edit untuk menambah / mengubah PR'}`;
    $('prNew').disabled = !ed; $('prUpBtn').classList.toggle('is-disabled', !ed);
  }
  ['prQ', 'prMon', 'prSt'].forEach((id) => $(id).addEventListener(id === 'prQ' ? 'input' : 'change', renderPrRekap));
  $('prRows').addEventListener('click', (e) => {
    if (e.target.closest('button, a, input, select')) {
      const d = e.target.closest('[data-prdel]'); if (d) prDelRow(d.dataset.prdel, Number(d.dataset.prdelNo), d.dataset.prdelKode);
      const da = e.target.closest('[data-prdelall]'); if (da) prDelAll(da.dataset.prdelall);
      return;
    }
    const g = e.target.closest('tr.pr-grp'); if (!g) return;
    const k = g.dataset.prg; if (state.prOpen.has(k)) state.prOpen.delete(k); else state.prOpen.add(k); renderPrRekap();
  });
  if ($('prExpand')) $('prExpand').addEventListener('click', () => { const ks = [...new Set((state.pr || []).map((r) => r.kodePr))]; if (state.prOpen.size >= ks.length) state.prOpen.clear(); else ks.forEach((k) => state.prOpen.add(k)); renderPrRekap(); });
  function prDelRow(kodePr, no, kode) {
    if (!state.edit.on) { toast('Masuk Mode edit dulu.'); return; }
    const r = (state.pr || []).find((x) => x.kodePr === kodePr && x.no === no && x.kode === kode); if (!r) return;
    const n = (state.pr || []).filter((x) => x.kodePr === kodePr).length;
    openDialog({ title: `Hapus baris ${kodePr} no ${no}`, ok: 'Hapus permanen', danger: true,
      body: `<p class="dlg-lead">Baris <b>${esc(kode)} ${esc(r.nama)}</b>${r.buka !== '' ? ` (buka PO ${prNumTxt(r.buka)})` : ''}${r.pos.length ? `, No PO ${esc(r.pos.join(', '))}` : ''} akan <b>dihapus permanen</b> dari REKAP_PR beserta Lampiran Perhitungan & Status PO material ini. Tidak bisa dibatalkan dari website.</p>
        ${n === 1 ? '<p class="warn">Ini baris terakhir: PR ini akan hilang dari Rekap (lampiran gambar tetap tersimpan di Drive).</p>' : `<p class="hint">No baris lain di PR ini diurutkan ulang. Kalau hanya ingin menandai tidak jadi, pakai status Batal (Ubah PR).</p>`}
        <label class="tb-check"><input type="checkbox" name="ack" id="prDelAck"> Ya, hapus permanen</label>`,
      onSubmit: async (fd) => {
        if (!fd.ack) throw new Error('Centang dulu "Ya, hapus permanen".');
        const res = await api('deletePrRow', { data: { kodePr, no, kode } });
        setPrData(res.pr); if (res.prStatus) setPrStatus(res.prStatus); if (res.prHitung) setPrHitung(res.prHitung); if (res.editLog) state.editLog = res.editLog;
        renderPrRekap(); renderLog();
        return `Baris ${kode} dihapus dari ${kodePr}.`;
      } });
    $('dlgOk').disabled = true; $('prDelAck').addEventListener('change', (e) => { $('dlgOk').disabled = !e.target.checked; });
  }
  function prDelAll(kodePr) {
    if (!state.edit.on) { toast('Masuk Mode edit dulu.'); return; }
    const rs = (state.pr || []).filter((x) => x.kodePr === kodePr); if (!rs.length) return;
    const withPo = rs.filter((x) => x.pos.length);
    openDialog({ title: `Hapus ${kodePr}`, ok: 'Hapus PR permanen', danger: true,
      body: `<p class="dlg-lead">Seluruh PR <b>${esc(kodePr)}</b> (${rs.length} baris material) akan <b>dihapus permanen</b> dari REKAP_PR beserta Lampiran Perhitungan & Status PO-nya. Tidak bisa dibatalkan dari website.</p>
        <ul class="pr-dellist">${rs.map((r) => `<li><span class="mono">${esc(r.kode)}</span> ${esc(r.nama)}${r.buka !== '' ? ` · buka ${prNumTxt(r.buka)}` : ''}${r.pos.length ? ` · PO ${esc(r.pos.join(', '))}` : ''}</li>`).join('')}</ul>
        ${withPo.length ? `<p class="warn">${withPo.length} baris sudah punya No PO. PO-nya di Monitoring PO tidak ikut terhapus, hanya catatan PR-nya.</p>` : ''}
        <p class="hint">Kalau hanya ingin menandai tidak jadi, pakai status Batal (Ubah PR). Lampiran gambar di Drive tetap tersimpan.</p>
        <label class="tb-check"><input type="checkbox" name="ack" id="prDelAck"> Ya, hapus seluruh PR ini</label>`,
      onSubmit: async (fd) => {
        if (!fd.ack) throw new Error('Centang dulu "Ya, hapus seluruh PR ini".');
        const res = await api('deletePr', { data: { kodePr, n: rs.length } });
        setPrData(res.pr); if (res.prStatus) setPrStatus(res.prStatus); if (res.prHitung) setPrHitung(res.prHitung); if (res.editLog) state.editLog = res.editLog;
        state.prOpen.delete(kodePr); renderPrRekap(); renderLog();
        return `${kodePr} dihapus.`;
      } });
    $('dlgOk').disabled = true; $('prDelAck').addEventListener('change', (e) => { $('dlgOk').disabled = !e.target.checked; });
  }
  function prGoPo(po, code) {
    const row = state.rows.find((x) => x.po === po && x.code === code && !x.cancel) || state.rows.find((x) => x.po === po && x.code === code) || state.rows.find((x) => x.po === po);
    if ($('dlg').open) $('dlg').close();
    goMonitor({ q: row && row.code === code ? po + ' ' + code : po, openKey: row ? row.key : null, jenis: '', supplier: '' });
    if (row) setTimeout(() => scrollRowTop(row.key), 300);
  }
  document.addEventListener('click', (e) => {
    const g = e.target.closest('.pr-po[data-gopo]'); if (g) { prGoPo(g.dataset.gopo, g.dataset.gocode); return; }
    const o = e.target.closest('[data-openpr]'); if (o) { PRF.kode = o.dataset.openpr; location.hash = isLtPr(o.dataset.openpr) ? '#/prlt/form' : '#/pr/form'; return; }
    const ed = e.target.closest('[data-editpr]'); if (ed) prEdit(ed.dataset.editpr);
  });

  // Dialog tambah / ubah PR (mode edit PO)
  const prBlank = () => ({ kode: '', nama: '', jenis: '', note: '', stok: '', butuh: '', ospo: '', kurang: '', buka: '', pakai: '', kirim: '', pos: [], status: 'Aktif' });
  // Kekurangan otomatis = Stok Awal − Kebutuhan − OS PO (kosong dianggap 0; hanya bila salah satu terisi)
  function prAutoKurang(r) {
    if (r.kurangManual || r._modeManual) return;
    const v = ['stok', 'butuh', 'ospo'].map((k) => prNum(r[k]));
    if (v.every((x) => x === '' || x === null || isNaN(x))) return;
    const n = (x) => (x === '' || x === null || x === undefined || isNaN(x) ? 0 : Number(x));
    r.kurang = String(Math.round((n(v[0]) + n(r._inc) + n(v[2]) - n(v[1]) - n(r._add)) * 10000) / 10000);
  }
  // Histori PO per kode untuk saran Jumlah Buka PO: dari baris PO di Monitoring PO (tanpa yang cancel) + ringkasan Supplier & MoQ
  function prHist(kode) {
    kode = String(kode || '').trim(); if (!kode) return null;
    const seen = new Set(), L = (state.rows || []).filter((x) => x.code === kode && !x.cancel && x.qty > 0 && !seen.has(x.po + '|' + x.lineKe) && seen.add(x.po + '|' + x.lineKe))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const sup = (SUP.rows || []).filter((x) => x.code === kode && x.supplier && x.count);
    if (!L.length && !sup.length) return { none: true };
    const q = L.map((x) => x.qty).sort((a, b) => a - b), med = q.length ? (q.length % 2 ? q[(q.length - 1) / 2] : (q[q.length / 2 - 1] + q[q.length / 2]) / 2) : null;
    const mins = sup.map((x) => x.moq).filter((x) => x !== null), maxs = sup.map((x) => x.max).filter((x) => x !== null);
    const lo = mins.length ? Math.min(...mins) : q.length ? q[0] : null, hi = maxs.length ? Math.max(...maxs) : q.length ? q[q.length - 1] : null;
    const dates = [...new Set(L.map((x) => x.date))].sort(), gaps = dates.slice(1).map((d, k) => (new Date(d) - new Date(dates[k])) / 86400000);
    const six = new Date(); six.setMonth(six.getMonth() - 6); const sixS = six.toISOString().slice(0, 10);
    return { kode, L, sup, lo, hi, med, avg: q.length ? q.reduce((t, x) => t + x, 0) / q.length : null, n: L.length || sup.reduce((t, x) => t + x.count, 0),
      uom: (L[0] || sup[0] || {}).uom || '', gap: gaps.length ? gaps.reduce((t, x) => t + x, 0) / gaps.length : null,
      q6: L.filter((x) => x.date >= sixS).reduce((t, x) => t + x.qty, 0), last: L[0] || null, main: sup.find((x) => x.main) || sup.slice().sort((a, b) => b.count - a.count)[0] || null };
  }
  function prMoqHtml(r, i) {
    const H = prHist(r.kode); if (!H) return '';
    if (H.none) return SUP.loaded || (state.rows || []).length ? '<span class="muted">Belum ada histori PO</span>' : '';
    const bk = prNum(r.buka), has = !(bk === '' || bk === null || isNaN(bk));
    const out = has && H.lo !== null && Number(bk) < H.lo - 1e-9 ? 'di bawah MoQ terkecil' : has && H.hi !== null && Number(bk) > H.hi + 1e-9 ? 'di atas bukaan terbesar' : '';
    return `<span>${nf.format(H.n)} PO · <b class="pr-moqr">${prNumTxt(H.lo)}–${prNumTxt(H.hi)}</b> ${esc(H.uom)}</span>${H.med !== null ? `<span>median ${prNumTxt(Math.round(H.med * 100) / 100)}${H.last ? ` · terakhir ${prNumTxt(H.last.qty)}` : ''}</span>` : ''}${out ? `<b class="pl-bad">⚠ ${out}</b>` : ''}<button type="button" class="btn-link pr-hisb" data-hist="${i}">${r.histOpen ? 'tutup histori' : 'lihat histori'}</button>`;
  }
  function prHistRow(r, i) {
    if (!r.histOpen) return '';
    const H = prHist(r.kode); if (!H || H.none) return '';
    const sup = H.sup.slice().sort((a, b) => b.count - a.count);
    return `<div class="pr-hisp"><button type="button" class="btn-link pr-hisx" data-hist="${i}">Tutup</button><div class="pr-his">
      <div class="pr-hisk"><b>Histori PO ${esc(H.kode)}</b>
        <span>Range qty PO <b>${prNumTxt(H.lo)} – ${prNumTxt(H.hi)} ${esc(H.uom)}</b></span>
        ${H.med !== null ? `<span>Median <b>${prNumTxt(Math.round(H.med * 100) / 100)}</b> · rata-rata ${prNumTxt(Math.round(H.avg * 100) / 100)}</span>` : ''}
        ${H.gap !== null ? `<span>PO rata-rata tiap <b>${nf.format(Math.round(H.gap))} hari</b></span>` : ''}
        <span>Total dibuka 6 bulan terakhir <b>${prNumTxt(H.q6)} ${esc(H.uom)}</b></span>
        ${H.last ? `<span>PO terakhir <b>${esc(H.last.po)}</b> ${esc(fmtDate(H.last.date))} · ${prNumTxt(H.last.qty)} ${esc(H.last.uom)}</span>` : ''}</div>
      ${sup.length ? `<table class="pr-hist"><thead><tr><th>Supplier</th><th class="num">Jml PO</th><th class="num">MoQ (terkecil)</th><th class="num">Terbesar</th><th class="num">Lead time</th><th class="num">Harga terakhir</th></tr></thead><tbody>
        ${sup.map((x) => `<tr><td>${esc(x.supplier)}${x.main ? ' <span class="pr-main">utama</span>' : ''}</td><td class="num">${nf.format(x.count)}</td><td class="num">${prNumTxt(x.moq)}</td><td class="num">${prNumTxt(x.max)}</td><td class="num">${x.lead !== null ? nf.format(Math.round(x.lead)) + ' hari' : '–'}</td><td class="num">${blank(x.price) ? '–' : prNumTxt(x.price) + ' ' + esc(x.kurs || '')}</td></tr>`).join('')}</tbody></table>` : ''}
      ${H.L.length ? `<table class="pr-hist"><thead><tr><th>Tgl order</th><th>No PO</th><th>Supplier</th><th class="num">Qty</th><th class="num">Harga</th></tr></thead><tbody>
        ${H.L.slice(0, 6).map((x) => `<tr><td>${esc(fmtDate(x.date))}</td><td>${esc(x.po)}</td><td>${esc(x.supplier)}</td><td class="num">${prNumTxt(x.qty)} ${esc(x.uom)}</td><td class="num">${x.price === '' ? '–' : prNumTxt(x.price) + ' ' + esc(x.kurs || '')}</td></tr>`).join('')}</tbody></table>${H.L.length > 6 ? `<p class="muted">6 PO terbaru dari ${nf.format(H.L.length)}.</p>` : ''}` : ''}
    </div></td></tr>`;
  }
  function prEdit(kodePr, pre) {
    if (!state.edit.on) { toast('Masuk Mode edit dulu.'); return; }
    if (state.noPrScript) { toast('Apps Script MONITORING PO perlu diperbarui (versi dengan Purchase Request).'); return; }
    const g = kodePr ? prGroups().find((x) => x.kodePr === kodePr) : null;
    const hz0 = kodePr ? ((prHitungOf(kodePr)[0] || {}).hz || '8') : '8';
    const D = { mode: kodePr ? 'manual' : 'auto', hz: hz0, kodePr: kodePr || '', tanggal: g ? g.tanggal : todayStr(), rows: g ? g.rows.map((r) => Object.assign({}, r, { pos: r.pos.slice() })) : pre && pre.length ? pre : [prBlank(), prBlank(), prBlank()] };
    const matOpts = [...(MRP.master || new Map()).values()].filter((m) => !/^fg$/i.test(String(m.kat || '').trim()) && (PRM() !== 'lt' || (P.lt || []).some((x) => x.aktif && x.kode === m.code))).map((m) => `<option value="${esc(m.code)}">${esc(m.name)}</option>`).join('');
    const rowHtml = (r, i) => `<tr data-i="${i}"><td class="num">${i + 1}</td>
      <td><input data-k="kode" value="${esc(r.kode)}" list="prEdMat" class="pr-in-kode" aria-label="Kode"><div class="pr-subw">${prSubWarn(r.kode, i)}</div></td>
      <td><input data-k="nama" value="${esc(r.nama)}" aria-label="Nama item"></td><td><input data-k="jenis" value="${esc(r.jenis)}" class="pr-in-s" aria-label="Jenis"></td>
      <td><input data-k="note" value="${esc(r.note)}" class="pr-in-s" aria-label="Note"></td>
      ${PR_NUM.map((k) => `<td><input${k === 'stok' ? ` title="Otomatis: stok upload pertama di bulan berjalan. Boleh diubah; kosongkan untuk kembali otomatis."` : k === 'butuh' ? ` title="Otomatis: Kebutuhan Material s/d MPS terakhir. Boleh diubah; kosongkan untuk kembali otomatis."` : ''} data-k="${k}" value="${esc(r[k] === '' || r[k] === undefined ? '' : String(r[k]))}" inputmode="decimal" class="pr-in-n${(k === 'kurang' && !r.kurangManual) || (k === 'ospo' && r.ospoAuto) || (k === 'butuh' && r.butuhAuto) ? ' is-auto' : ''}${k === 'stok' && r.stokAuto ? ' is-auto' : ''}" aria-label="${k}"${k === 'kurang' ? ' title="Otomatis: Stok Awal + Incoming + OS PO − Kebutuhan − ADD/FOH/RS. Boleh diubah; kosongkan untuk kembali otomatis."' : k === 'ospo' ? ' title="Otomatis: total sisa PO outstanding (Monitoring PO) saat kode diisi. Boleh diubah; kosongkan untuk kembali otomatis."' : ''}>${k === 'buka' ? `<div class="pr-moq" data-moq="${i}">${prMoqHtml(r, i)}</div>` : k === 'stok' ? '<div class="pr-calcn"></div>' : ''}</td>`).join('')}
      <td class="pr-kir">${r.sched ? `<span class="pr-schs">${r.sched.length} jadwal</span>` : `<input type="date" data-k="kirim" value="${esc(r.kirim || '')}" aria-label="Tanggal kirim">`}<button type="button" class="btn-link pr-splitb" data-split="${i}" title="${r.sched ? 'Tambah jadwal kirim' : 'Pecah jadwal kirim: beberapa tanggal dengan qty masing-masing'}">${r.sched ? '+ jadwal' : 'Split'}</button></td>
      <td><input data-k="pos" value="${esc(r.pos.join(', '))}" list="prEdPo${i}" class="pr-in-po" placeholder="PO… , PO…" aria-label="No PO"><datalist id="prEdPo${i}">${prPoSuggest(r.kode, D.tanggal)}</datalist></td>
      <td><select data-k="status" aria-label="Status"><option${r.status !== 'Batal' ? ' selected' : ''}>Aktif</option><option${r.status === 'Batal' ? ' selected' : ''}>Batal</option></select></td>
      <td><button type="button" class="btn-link danger" data-rm="${i}" title="Hapus baris (belum tersimpan)">×</button></td></tr>`;
    D.rows.forEach((r) => {
      r.sched = prSched(r.kirim);
      r.ospoManual = !(prNum(r.ospo) === '' || prNum(r.ospo) === null); r.ospoAuto = false;
      r.butuhManual = !(prNum(r.butuh) === '' || prNum(r.butuh) === null);
      r.stokManual = !(prNum(r.stok) === '' || prNum(r.stok) === null);
      const k0 = prNum(r.kurang);
      if (k0 !== '' && k0 !== null) { const t = Object.assign({}, r, { kurangManual: false }); prAutoKurang(t); r.kurangManual = Math.abs(Number(t.kurang) - Number(k0)) > 1e-6 || t.kurang === undefined; }
    });
    const schedSum = (r) => r.sched.reduce((t, x) => t + (Number(x.q) || 0), 0);
    const schedRow = (r, i) => {
      if (!r.sched) return '';
      const tot = schedSum(r), bk = Number(prNum(r.buka)) || 0, ok = Math.abs(tot - bk) < 1e-6;
      return `<tr class="pr-schr" data-si="${i}"><td></td><td colspan="${PR_NUM.length + 8}"><div class="pr-sch"><b>Jadwal kirim ${esc(r.kode || '')}</b>
        ${r.sched.map((x, j) => `<span class="pr-schi"><input type="date" data-sd="${j}" value="${esc(x.d)}" aria-label="Tanggal kirim ${j + 1}"><input data-sq="${j}" value="${esc(x.q === '' ? '' : String(x.q))}" inputmode="decimal" placeholder="Qty" aria-label="Qty kirim ${j + 1}"><button type="button" class="btn-link danger" data-sx="${j}" title="Hapus jadwal ini">×</button></span>`).join('')}
        <span class="pr-schsum ${ok ? 'is-ok' : 'is-bad'}">Total ${prNumTxt(tot) || 0}${bk ? ` / Jumlah Buka PO ${prNumTxt(bk)}` : ''}${ok ? ' ✓' : bk ? ` · selisih ${prNumTxt(tot - bk)}` : ' · Jumlah Buka PO kosong (diisi otomatis = total)'}</span></div></td></tr>`;
    };
    const paint = () => { $('dlgBody').querySelector('#prEdRows').innerHTML = D.rows.map((r, i) => rowHtml(r, i) + schedRow(r, i)).join(''); const hi = D.rows.findIndex((r) => r.histOpen); $('dlgBody').querySelector('#prHisPanel').innerHTML = hi >= 0 ? prHistRow(D.rows[hi], hi) : ''; };
    const paintSum = (i) => { const tr = $('dlgBody').querySelector(`.pr-schr[data-si="${i}"]`); if (!tr) return; const tmp = document.createElement('tbody'); tmp.innerHTML = schedRow(D.rows[i], i); tr.querySelector('.pr-schsum').replaceWith(tmp.querySelector('.pr-schsum')); };
    openDialog({
      title: kodePr ? `Ubah ${kodePr}` : 'Tambah PR baru', ok: 'Simpan PR', wide: true,
      body: `<div class="form-grid pr-ed-head"><label class="field"><span>Tanggal PR *</span><input type="date" name="tanggal" value="${esc(D.tanggal)}" required></label>
          <label class="field"><span>Kode PR</span><input value="${esc(kodePr || prDefKode(D.tanggal) + ' (otomatis)')}" readonly></label>
          <div class="field"><span>Cara hitung</span><div class="pj-seg" id="prMode" role="group" aria-label="Cara hitung"><button type="button" data-v="auto" title="Stok Awal, Kebutuhan, OS PO, dan Kekurangan terisi otomatis (tetap bisa diubah)">Otomatis</button><button type="button" data-v="manual" title="Semua angka diketik sendiri, tidak ada yang terisi otomatis">Manual</button></div></div>

          ${kodePr ? `<label class="field pr-ed-batal"><span>Status seluruh PR</span><select name="allst"><option value="">Ikuti per baris</option><option value="Aktif">Aktifkan semua</option><option value="Batal">Batalkan seluruh PR</option></select></label>` : ''}</div>
        <datalist id="prEdMat">${matOpts}</datalist>
        <div class="table-wrap pr-ed-wrap"><table class="po-table pr-ed"><thead><tr><th>No</th><th>Kode</th><th>Nama Item</th><th>Jenis</th><th>Note</th>${PR_COLS.map((c) => `<th class="num">${prColH(c)}</th>`).join('')}<th>Tgl Kirim</th><th>No PO <small>(pisah koma)</small></th><th>Status</th><th></th></tr></thead><tbody id="prEdRows"></tbody></table></div>
        <div id="prHisPanel"></div>
        <p><button type="button" class="btn btn-ghost btn-sm" id="prEdAdd">Tambah baris</button></p>
        <p class="hint" id="prMrpNote"></p><p class="hint">Pilih <b>Otomatis</b> atau <b>Manual</b> di Cara hitung. Otomatis: begitu kode diisi, Stok Terkini (stok upload terakhir + incoming − pemakaian MO Plotting Harian − ADD/FOH/RS s/d hari ini), Kebutuhan (MO Plotting Harian mulai besok s/d akhir bulan + Plan bulan bulan-bulan berikutnya), dan OS PO (sisa PO gantung) terisi otomatis. Kekurangan = Stok Terkini + OS PO − Kebutuhan − ADD/FOH/RS setelah hari ini (rinciannya di Lampiran Perhitungan); angka otomatis tetap bisa diubah. Manual: semua angka diketik sendiri. Lampiran Perhitungan tetap dihitung sistem. Kode PR dibuat otomatis mengikuti bulan Tanggal PR. Baris berstatus Batal tetap tercatat di Rekap tapi tidak dicetak. No PO bisa lebih dari satu; saran No PO diambil dari PO di Monitoring PO dengan kode material yang sama.</p>`,
      onSubmit: async (fd) => {
        const rows = D.rows.filter((r) => String(r.kode || '').trim());
        if (!rows.length) throw new Error('Isi minimal satu kode material.');
        const bad = rows.filter((r) => MRP.master && MRP.master.size && !MRP.master.get(String(r.kode).trim()));
        if (bad.length && !D.warned) { D.warned = true; throw new Error(`Kode tidak ada di Daftar Material: ${bad.map((r) => r.kode).join(', ')}. Klik Simpan PR sekali lagi bila memang benar.`); }
        for (const r of rows) {
          if (!r.sched) continue;
          if (r.sched.some((x) => !/^\d{4}-\d{2}-\d{2}$/.test(x.d) || !(Number(x.q) > 0))) throw new Error(`Jadwal kirim ${r.kode}: setiap jadwal wajib punya tanggal dan qty > 0.`);
          const tot = schedSum(r), bk = prNum(r.buka);
          if (bk === '' || bk === null) r.buka = String(tot);
          else if (Math.abs(tot - Number(bk)) > 1e-6) throw new Error(`Jadwal kirim ${r.kode}: total ${prNumTxt(tot)} belum sama dengan Jumlah Buka PO ${prNumTxt(bk)}. Sesuaikan qty jadwalnya.`);
          r.sched.sort((a, b) => a.d.localeCompare(b.d));
          r.kirim = r.sched.length > 1 ? prSchedStr(r.sched) : r.sched[0].d;
        }
        const all = fd.allst || '';
        const PR_LBL = { stok: 'Stok Terkini', butuh: 'Kebutuhan', ospo: 'OS PO', kurang: 'Kekurangan', buka: 'Jumlah Buka PO' };
        rows.forEach((r) => Object.keys(PR_LBL).forEach((k) => { const v = String(r[k] === undefined || r[k] === null ? '' : r[k]).trim(); if (v !== '' && isNaN(prNum(v))) throw new Error(`${PR_LBL[k]} untuk ${r.kode} harus angka (tertulis "${v}").`); }));
        if (PRM() === 'lt') { const nl = rows.filter((r) => !(P.lt || []).some((x) => x.aktif && x.kode === String(r.kode).trim())); if (nl.length && !D.warnedLt) { D.warnedLt = true; throw new Error(`Bukan material LT panjang (tidak ada di Material LT & Saran PO): ${nl.map((r) => r.kode).join(', ')}. Klik Simpan PR sekali lagi bila memang benar.`); } }
        const hitung = state.noPrHitungScript ? null : await prHitungPayload(rows);
        const res = await api('savePr', { data: { lt: PRM() === 'lt', kodePr: D.kodePr, tanggal: fd.tanggal, statusPo: prStatusPayload(rows.map((r) => r.kode)), hitung: hitung || undefined, rows: rows.map((r) => [String(r.kode).trim(), r.nama, r.jenis, r.note,
          ...PR_NUM.map((k) => (k === 'pakai' ? prPakaiVal(r.pakai) : prNum(r[k]))), r.kirim || '', r.pos.join(', '), all || r.status]) } });
        setPrData(res.pr); if (res.prStatus) setPrStatus(res.prStatus); if (res.prHitung) setPrHitung(res.prHitung); if (res.editLog) state.editLog = res.editLog;
        renderPrRekap(); renderLog();
        return `${res.codes[0]} tersimpan.`;
      },
    });
    paint();
    const body = $('dlgBody'), seq = dlgSeq;
    // Stok Awal otomatis dari Plotting Harian (untuk kode baru / kode yang diubah)
    const fillStok = (i) => {
      const r = D.rows[i], k = String(r.kode || '').trim(); if (!k || !MRP.loaded || D.mode === 'manual') return;
      const tr = body.querySelector(`#prEdRows tr[data-i="${i}"]`); if (!tr) return;
      const set = (key, v, auto) => { r[key] = v === '' ? '' : String(v); const x = tr.querySelector(`[data-k=${key}]`); if (x) { x.value = r[key]; if (auto !== undefined) x.classList.toggle('is-auto', auto); } };
      if (!MRP.master.has(k) && !(P.stock || new Map()).has(k)) { if (!r.stokManual) set('stok', ''); r._inc = 0; r._add = 0; return; }
      if (PRM() === 'lt') {
        if (!LTSO.m) { ltSoMap().then(() => { if (seq === dlgSeq) fillStok(i); }).catch(() => {}); return; }
        const L = ltCalc(k); if (!L) return;
        if (!r.stokManual) { set('stok', L.stok, true); r.stokAuto = true; } r._inc = 0; r._add = 0;
        if (!r.butuhManual) { set('butuh', L.total, true); r.butuhAuto = true; }
        if (!r.ospoManual) { set('ospo', L.ospo, true); r.ospoAuto = true; }
        if (!String(r.pakai || '').trim()) set('pakai', `${monShort(L.months[0])} - ${monShort(L.months[L.months.length - 1])}`);
        if (!String(r.buka || '').trim() && L.saran) set('buka', L.saran);
        prAutoKurang(r); const ki = tr.querySelector('[data-k=kurang]'); if (ki && !r.kurangManual) ki.value = r.kurang || '';
        const mq = tr.querySelector('.pr-calcn'); if (mq) mq.textContent = `LT ${L.lt} bln · stok awal ${fmtDate(L.stokDate)} · ${L.hz} bln dari avg SO ${monShort(L.avgMs[0])}–${monShort(L.avgMs[5])} · ${LT_ST[L.status][0]}${L.batas ? ' · batas buka PO ' + fmtDate(L.batas) : ''}${(P.lt || []).some((x) => x.aktif && x.kode === k) ? '' : ' · ⚠ bukan material LT'}`;
        return;
      }
      const c = prCalc(k, 'all', [], { pool: true }); if (!c) return;
      if (!r.stokManual) { set('stok', c.stok, true); r.stokAuto = true; } r._inc = c.inc; r._add = c.add;
      if (!r.butuhManual) { set('butuh', c.butuh, true); r.butuhAuto = true; }
      if (!r.ospoManual) { set('ospo', c.ospo, true); r.ospoAuto = true; }
      prAutoKurang(r); const ki = tr.querySelector('[data-k=kurang]'); if (ki && !r.kurangManual) ki.value = r.kurang || '';
      const mq = tr.querySelector('.pr-calcn'); if (mq) mq.textContent = `per ${fmtDate(c.at)} (stok ${fmtDate(c.stokDate)})${c.add ? ` · ADD/FOH/RS ${prNumTxt(c.add)}` : ''}`;
    };
    D.fillStok = fillStok;
    $('prMrpNote').textContent = MRP.loaded ? '' : 'Memuat data MRP (Plotting Harian & Proyeksi Stok) untuk Stok Awal dan Lampiran Perhitungan…';
    mrpReady().then((ok) => { if (seq !== dlgSeq) return; $('prMrpNote').textContent = ok ? '' : 'Data MRP tidak bisa dimuat: Stok Awal dan Lampiran Perhitungan tidak terisi otomatis.'; if (ok) D.rows.forEach((r, i) => { if (r.stokPending) { r.stokPending = false; fillStok(i); } }); });
    if (MRP.loaded) D.rows.forEach((r, i) => { if (r.stokPending) { r.stokPending = false; fillStok(i); } });
    const paintMode = () => {
      body.querySelectorAll('#prMode [data-v]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === D.mode)));
      D.rows.forEach((r) => { r._modeManual = D.mode === 'manual'; });
      const t = body.querySelector('table.pr-ed'); if (t) t.classList.toggle('is-manual', D.mode === 'manual');
      body.querySelectorAll('#prEdRows .pr-calcn').forEach((x) => { if (D.mode === 'manual') x.textContent = ''; });
    };
    body.querySelector('#prMode').addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]'); if (!b || b.dataset.v === D.mode) return;
      D.mode = b.dataset.v;
      if (D.mode === 'auto') D.rows.forEach((r, i) => { r.stokManual = r.butuhManual = r.ospoManual = r.kurangManual = false; r._modeManual = false; if (MRP.loaded) fillStok(i); else r.stokPending = true; });
      paintMode();
    });
    paintMode();
    body.querySelector('[name=tanggal]').addEventListener('change', (e) => { D.tanggal = e.target.value; if (!kodePr) body.querySelector('.pr-ed-head input[readonly]').value = prDefKode(D.tanggal) + ' (otomatis)'; });
    body.querySelector('#prEdAdd').addEventListener('click', () => { const nr = prBlank(); nr._modeManual = D.mode === 'manual'; D.rows.push(nr); paint(); });
    body.addEventListener('input', (e) => {
      if (seq !== dlgSeq) return;
      const si = e.target.closest('.pr-schr');
      if (si) { const i = Number(si.dataset.si), r = D.rows[i], d = e.target.dataset; if (d.sd !== undefined) r.sched[Number(d.sd)].d = e.target.value; if (d.sq !== undefined) { r.sched[Number(d.sq)].q = prNum(e.target.value); paintSum(i); } return; }
      const inp = e.target.closest('#prEdRows [data-k]'); if (!inp) return;
      const i = Number(inp.closest('tr').dataset.i), k = inp.dataset.k, r = D.rows[i];
      if (k === 'pos') r.pos = splitPo(inp.value); else r[k] = inp.value;
      if (k === 'buka' && r.sched) paintSum(i);
      const tr = inp.closest('tr');
      if (k === 'kurang') { r.kurangManual = inp.value.trim() !== ''; inp.classList.toggle('is-auto', !r.kurangManual); if (!r.kurangManual) { prAutoKurang(r); inp.value = r.kurang || ''; } }
      if (k === 'ospo') { r.ospoManual = inp.value.trim() !== ''; r.ospoAuto = !r.ospoManual; }
      if (k === 'kode') { const w = tr.querySelector('.pr-subw'); if (w) w.innerHTML = prSubWarn(r.kode, i); if (MRP.loaded) D.fillStok(i); else r.stokPending = true; }
      if (k === 'butuh') { r.butuhManual = inp.value.trim() !== ''; inp.classList.toggle('is-auto', !r.butuhManual); }
      if (k === 'stok') { r.stokManual = inp.value.trim() !== ''; inp.classList.toggle('is-auto', !r.stokManual); if (!r.stokManual && MRP.loaded) D.fillStok(i); }
      if (false && k === 'kode' && !r.ospoManual) { const os = prOsSum(r.kode); r.ospo = r.kode && String(r.kode).trim() ? String(Math.round(os * 10000) / 10000) : ''; r.ospoAuto = true; const oi = tr.querySelector('[data-k=ospo]'); if (oi) { oi.value = r.ospo; oi.classList.add('is-auto'); } prAutoKurang(r); const ki = tr.querySelector('[data-k=kurang]'); if (ki && !r.kurangManual) ki.value = r.kurang || ''; }
      if (k === 'ospo' || k === 'butuh') { inp.classList.toggle('is-auto', !(k === 'ospo' ? r.ospoManual : r.butuhManual)); if (!(k === 'ospo' ? r.ospoManual : r.butuhManual) && MRP.loaded) D.fillStok(i); }
      if (k === 'stok' || k === 'butuh' || k === 'ospo') { prAutoKurang(r); if (!r.kurangManual) tr.querySelector('[data-k=kurang]').value = r.kurang || ''; }
      if (k === 'buka' || k === 'kode') { const mq = tr.querySelector('.pr-moq'); if (mq) mq.innerHTML = prMoqHtml(r, i); if (k === 'kode' && r.histOpen) { r.histOpen = false; paint(); } }
      if (k === 'kode') {
        const m = MRP.master && MRP.master.get(inp.value.trim());
        if (m) { r.nama = m.name || ''; r.jenis = m.kat || ''; const tr = inp.closest('tr'); tr.querySelector('[data-k=nama]').value = r.nama; tr.querySelector('[data-k=jenis]').value = r.jenis; tr.querySelector('datalist').innerHTML = prPoSuggest(m.code, D.tanggal); }
      }
    });
    body.addEventListener('change', (e) => { if (seq !== dlgSeq) return; const sl = e.target.closest('#prEdRows select[data-k]'); if (sl) D.rows[Number(sl.closest('tr').dataset.i)].status = sl.value; });
    body.addEventListener('click', (e) => {
      if (seq !== dlgSeq) return;
      const hb = e.target.closest('[data-hist]'); if (hb) { const r = D.rows[Number(hb.dataset.hist)], on = !r.histOpen; D.rows.forEach((x) => { x.histOpen = false; }); r.histOpen = on; paint(); if (on) $('dlgBody').querySelector('#prHisPanel').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return; }
      const sp = e.target.closest('[data-split]');
      if (sp) { const r = D.rows[Number(sp.dataset.split)]; if (!r.sched) { const bk = prNum(r.buka); r.sched = [{ d: r.kirim || '', q: bk === '' ? '' : Number(bk) }, { d: '', q: '' }]; } else r.sched.push({ d: '', q: '' }); paint(); return; }
      const sx = e.target.closest('[data-sx]');
      if (sx) { const r = D.rows[Number(sx.closest('.pr-schr').dataset.si)]; r.sched.splice(Number(sx.dataset.sx), 1); if (r.sched.length <= 1) { r.kirim = r.sched.length ? r.sched[0].d : ''; r.sched = null; } paint(); return; }
    });
    body.addEventListener('click', (e) => {
      if (seq !== dlgSeq) return; const g = e.target.closest('[data-subgo]'); if (!g) return;
      const tr = g.closest('tr'), inp = tr && tr.querySelector('[data-k=kode]'); if (!inp) return;
      inp.value = g.dataset.subgo; inp.dispatchEvent(new Event('input', { bubbles: true }));
    });
    body.addEventListener('click', (e) => { if (seq !== dlgSeq) return; const b = e.target.closest('[data-rm]'); if (!b) return; D.rows.splice(Number(b.dataset.rm), 1); if (!D.rows.length) D.rows.push(prBlank()); paint(); });
  }
  // Saran No PO: PO di Monitoring PO dengan kode material sama, tgl order ≥ tgl PR (terbaru di atas)
  function prPoSuggest(kode, tanggal) {
    if (!kode) return '';
    const seen = new Set();
    return (state.rows || []).filter((x) => x.code === String(kode).trim() && !x.cancel && (!tanggal || x.date >= tanggal))
      .sort((a, b) => (a.date < b.date ? 1 : -1)).filter((x) => !seen.has(x.po) && seen.add(x.po)).slice(0, 15)
      .map((x) => `<option value="${esc(x.po)}">${esc(x.supplier)} · ${fmtDate(x.date)} · ${fmtNum(x.qty)} ${esc(x.uom)}</option>`).join('');
  }
  $('prNew').addEventListener('click', () => {
    if (!state.edit.on) { toast('Masuk Mode edit dulu.'); return; }
    if (PRM() === 'lt') {
      openDialog({ title: 'Tambah PR LT Panjang baru', ok: 'Lanjut', wide: false,
        body: `<p class="dlg-lead">Mulai dari mana?</p>
          <label class="pr-src"><input type="radio" name="src" value="saran" checked><span><b>Dari saran buka PO</b><small>Material LT berstatus Segera buka PO / Siapkan PO otomatis masuk ke formulir, lengkap dengan saran qty.</small></span></label>
          <label class="pr-src"><input type="radio" name="src" value="manual"><span><b>Manual</b><small>Formulir kosong, ketik kode material LT sendiri.</small></span></label>`,
        onSubmit: async (fd) => { setTimeout(() => (fd.src === 'manual' ? prEdit('') : ltPrFromSaran()), 0); return ''; } });
      return;
    }
    openDialog({ title: 'Tambah PR baru', ok: 'Lanjut', wide: false,
      body: `<p class="dlg-lead">Mulai dari mana?</p>
        <label class="pr-src"><input type="radio" name="src" value="short" checked><span><b>Dari stok yang kurang</b><small>Pilih material yang saldonya minus menurut Stok Terkini − Kebutuhan (dipisah RM dan PM), lalu daftar materialnya otomatis masuk ke formulir.</small></span></label>
        <label class="pr-src"><input type="radio" name="src" value="manual"><span><b>Manual</b><small>Formulir kosong, ketik kode material sendiri.</small></span></label>`,
      onSubmit: async (fd) => { setTimeout(() => (fd.src === 'manual' ? prEdit('') : prPickShort()), 0); return ''; } });
  });
  // Daftar material yang kurang (kolom "Kurang" Proyeksi Stok, rentang & cara hitung sesuai menu Proyeksi Stok) → isi formulir PR
  async function prPickShort() {
    openDialog({ title: 'Pilih material yang kurang', ok: 'Buat PR', wide: true, body: '<p class="dlg-lead" id="psLoad">Memuat Proyeksi Stok… (data MRP, biasanya 5–15 detik)</p><div id="psBox"></div>',
      onSubmit: async () => {
        const sel = [...(prPickShort.sel || [])]; if (!sel.length) throw new Error('Centang minimal satu material.');
        const rows = sel.map((k) => { const m = MRP.master.get(k) || {}, x = (prPickShort.rows || []).find((r) => r.code === k) || {}; return Object.assign(prBlank(), { kode: k, nama: m.name || x.name || '', jenis: m.kat || x.kat || '', stokPending: true }); });
        setTimeout(() => prEdit('', rows), 0); return '';
      } });
    const seq = dlgSeq;
    if (!(await mrpReady())) { if (seq === dlgSeq) $('psLoad').textContent = 'Data MRP tidak bisa dimuat.'; return; }
    if (seq !== dlgSeq) return;
    const B = stkBase(), act = new Map();
    (state.pr || []).filter((r) => r.status !== 'Batal' && !r.pos.length).forEach((r) => { if (!act.has(r.kode)) act.set(r.kode, r.kodePr); });
    const grp = (k) => { const t = String(k || '').toUpperCase(); return t.startsWith('RM') ? 'RM' : t.startsWith('PM') ? 'PM' : 'Lainnya'; };
    const L = [];
    const codesS = new Set([...B.M.keys(), ...(P.subs || []).filter((x) => x.aktif).map((x) => x.baru)]);
    codesS.forEach((code) => {
      if (isFg(code) || kfIsEk(code) || subNewOf(code)) return;   // material lama (sudah diganti) tidak diusulkan; kebutuhannya ikut material baru
      const c = prCalc(code, 'all', [], { pool: true }); if (!c) return;
      const i = c.cols.findIndex((x) => x.sal < -1e-9); if (i < 0) return;
      const m = MRP.master.get(code) || {};
      L.push({ code, name: c.nama || m.name || code, kat: m.kat || '', uom: c.uom, firstShort: i, firstLbl: c.cols[i].lf || c.cols[i].l, short: -c.deep, g: grp(m.kat) });
    });
    L.sort((a, b) => a.firstShort - b.firstShort || b.short - a.short);
    prPickShort.rows = L; prPickShort.sel = new Set(); prPickShort.tab = L.some((r) => r.g === 'RM') ? 'RM' : 'PM'; prPickShort.q = '';
    $('psLoad').innerHTML = `${L.length} material saldonya minus (Stok terkini per ${esc(fmtDate(B.today))} − kebutuhan ${esc(B.cols[0].l)} s/d ${esc(B.cols[B.n - 1].lf || B.cols[B.n - 1].l)}, sebelum PO telat / tanpa jadwal). Daftar ini hanya untuk mengisi kode material; angka di formulir dihitung seperti biasa.`;
    const paint = () => {
      const tabs = ['RM', 'PM', 'Lainnya'].filter((g) => L.some((r) => r.g === g) || g !== 'Lainnya');
      const q = prPickShort.q.toLowerCase(), list = L.filter((r) => r.g === prPickShort.tab && (!q || (r.code + ' ' + r.name).toLowerCase().includes(q)));
      $('psBox').innerHTML = `<div class="ps-bar"><div class="pj-seg" role="group">${tabs.map((g) => `<button type="button" data-pstab="${g}" aria-pressed="${g === prPickShort.tab}">${g} <b>${L.filter((r) => r.g === g).length}</b></button>`).join('')}</div>
        <input type="search" id="psQ" value="${esc(prPickShort.q)}" placeholder="Cari kode / nama"><label class="tb-check"><input type="checkbox" id="psAll"${list.length && list.every((r) => prPickShort.sel.has(r.code)) ? ' checked' : ''}> Pilih semua ${prPickShort.tab}</label><span class="muted" id="psN">${prPickShort.sel.size} dipilih</span></div>
        <div class="table-wrap ps-wrap"><table class="po-table pl-mini"><thead><tr><th></th><th>Kode</th><th>Nama</th><th>Mulai kurang</th><th class="num">Kurang</th><th>Catatan</th></tr></thead><tbody>
        ${list.map((r) => `<tr><td><input type="checkbox" data-psk="${esc(r.code)}"${prPickShort.sel.has(r.code) ? ' checked' : ''}></td><td class="mono">${esc(r.code)}</td><td>${esc(r.name)}</td><td>${esc(r.firstLbl || '')}</td><td class="num"><b class="pl-bad">${fmtQ(r.short)}</b> <small class="muted">${esc(r.uom || '')}</small></td><td>${act.has(r.code) ? `<span class="badge b-wait" title="Sudah ada di PR aktif yang belum jadi PO">di ${esc(act.get(r.code))}</span>` : ''}</td></tr>`).join('') || '<tr class="empty"><td colspan="6">Tidak ada material kurang di kelompok ini.</td></tr>'}</tbody></table></div>`;
      $('dlgOk').textContent = `Buat PR (${prPickShort.sel.size} material)`; $('dlgOk').disabled = !prPickShort.sel.size;
    };
    paint();
    const box = $('psBox');
    box.addEventListener('click', (e) => { const t = e.target.closest('[data-pstab]'); if (t) { prPickShort.tab = t.dataset.pstab; paint(); } });
    box.addEventListener('input', (e) => { if (e.target.id === 'psQ') { prPickShort.q = e.target.value; const pos = e.target.selectionStart; paint(); const qi = $('psQ'); qi.focus(); qi.setSelectionRange(pos, pos); } });
    box.addEventListener('change', (e) => {
      const c = e.target.closest('[data-psk]'); if (c) { if (c.checked) prPickShort.sel.add(c.dataset.psk); else prPickShort.sel.delete(c.dataset.psk); $('psN').textContent = `${prPickShort.sel.size} dipilih`; $('dlgOk').textContent = `Buat PR (${prPickShort.sel.size} material)`; $('dlgOk').disabled = !prPickShort.sel.size; return; }
      if (e.target.id === 'psAll') { const q = prPickShort.q.toLowerCase(); L.filter((r) => r.g === prPickShort.tab && (!q || (r.code + ' ' + r.name).toLowerCase().includes(q))).forEach((r) => { if (e.target.checked) prPickShort.sel.add(r.code); else prPickShort.sel.delete(r.code); }); paint(); }
    });
  }

  // Excel: format, upload, unduh rekap
  const PR_XL = ['KODE PR', 'TANGGAL PR', 'KODE', 'NAMA ITEM', 'JENIS', 'NOTE', 'STOK AWAL', 'KEBUTUHAN', 'OS PO', 'KEKURANGAN', 'JUMLAH BUKA PO', 'PEMAKAIAN (BULAN)', 'TANGGAL KIRIM', 'NO PO', 'STATUS'];
  $('prTpl').addEventListener('click', () => {
    const ws = XLSX.utils.aoa_to_sheet([PR_XL, ['', todayStr(), '', '', '', '', '', '', '', '', '', '', '', '', 'Aktif']]);
    ws['!cols'] = PR_XL.map((h) => ({ wch: Math.max(12, h.length + 2) })); ws['!cols'][3] = { wch: 36 };
    const info = XLSX.utils.aoa_to_sheet([['Petunjuk'], ['KODE PR kosong = PR baru. Baris dengan KODE PR kosong dan TANGGAL PR sama digabung menjadi satu PR; Kode PR dibuat otomatis (PR/GTK/YYMM/NNN).'],
      ['KODE PR diisi (yang sudah ada) = seluruh isi PR itu diganti dengan baris di file.'], ['TANGGAL PR & TANGGAL KIRIM format tanggal (yyyy-mm-dd). NAMA ITEM & JENIS boleh kosong (diisi dari Daftar Material).'],
      ['NO PO boleh lebih dari satu, pisah koma. STATUS: Aktif / Batal (kosong = Aktif).']]);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'REKAP PR'); XLSX.utils.book_append_sheet(wb, info, 'PETUNJUK');
    XLSX.writeFile(wb, `Format_Upload_PR_${todayStr()}.xlsx`);
  });
  const xlDate = (v) => {
    if (v === '' || v === null || v === undefined) return '';
    if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); return d ? `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}` : ''; }
    const t = String(v).trim(); let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
  };
  $('prFile').addEventListener('change', async () => {
    const f = $('prFile').files[0]; $('prFile').value = ''; if (!f) return;
    if (!state.edit.on) { toast('Masuk Mode edit dulu.'); return; }
    try {
      const wb = await readBook(f), sn = wb.SheetNames.find((n) => /rekap/i.test(n)) || wb.SheetNames[0], A = sheetRows(wb, sn);
      const h = A.findIndex((r) => r.some((x) => txt(x).toUpperCase() === 'KODE PR'));
      if (h < 0) throw new Error('Kolom KODE PR tidak ditemukan. Pakai "Unduh format Excel".');
      const H = A[h].map((x) => txt(x).toUpperCase()), ix = (n) => H.indexOf(n);
      if (ix('KODE') < 0 || ix('TANGGAL PR') < 0) throw new Error('Kolom KODE dan TANGGAL PR wajib ada.');
      const groups = new Map(), errs = [];
      A.slice(h + 1).forEach((r, i) => {
        const kode = txt(r[ix('KODE')]).replace(/\.0+$/, ''); if (!kode) return;
        const kp = txt(r[ix('KODE PR')]), tg = xlDate(r[ix('TANGGAL PR')]);
        if (!tg) { errs.push(`baris ${h + i + 2}: TANGGAL PR kosong/tidak dikenal`); return; }
        const key = kp || 'NEW|' + tg, g = groups.get(key) || { kodePr: kp, tanggal: tg, rows: [], lt: kp ? isLtPr(kp) : PRM() === 'lt' };
        const m = MRP.master && MRP.master.get(kode), g2 = (n) => (ix(n) >= 0 ? r[ix(n)] : '');
        g.rows.push([kode, txt(g2('NAMA ITEM')) || (m ? m.name : ''), txt(g2('JENIS')) || (m ? m.kat : ''), txt(g2('NOTE')),
          ...['STOK AWAL', 'KEBUTUHAN', 'OS PO', 'KEKURANGAN', 'JUMLAH BUKA PO'].map((n) => prNum(g2(n) === '' ? '' : g2(n))), prPakaiVal(g2('PEMAKAIAN (BULAN)')),
          (prSched(txt(g2('TANGGAL KIRIM'))) ? prSchedStr(prSched(txt(g2('TANGGAL KIRIM')))) : xlDate(g2('TANGGAL KIRIM'))), splitPo(g2('NO PO')).join(', '), /batal/i.test(txt(g2('STATUS'))) ? 'Batal' : 'Aktif']);
        groups.set(key, g);
      });
      if (errs.length) throw new Error(errs.slice(0, 5).join('; '));
      const G = [...groups.values()]; if (!G.length) throw new Error('Tidak ada baris dengan KODE material.');
      const exist = new Set((state.pr || []).map((r) => r.kodePr));
      const nNew = G.filter((g) => !g.kodePr).length, nRep = G.filter((g) => g.kodePr && exist.has(g.kodePr)).length;
      openDialog({
        title: `Upload PR · ${f.name}`, ok: 'Simpan ke Google Sheet',
        body: `<p class="dlg-lead">Terbaca <b>${nf.format(G.length)}</b> PR, <b>${nf.format(G.reduce((t, g) => t + g.rows.length, 0))}</b> baris material.</p>
          <ul class="pj-list"><li>${nf.format(nNew)} PR baru (Kode PR otomatis)</li><li>${nf.format(nRep)} PR yang sudah ada akan <b>diganti seluruh isinya</b>: ${esc(G.filter((g) => g.kodePr && exist.has(g.kodePr)).map((g) => g.kodePr).join(', ')) || '–'}</li>
          ${G.filter((g) => g.kodePr && !exist.has(g.kodePr)).length ? `<li>${nf.format(G.filter((g) => g.kodePr && !exist.has(g.kodePr)).length)} Kode PR di file belum ada di Rekap → dibuat dengan kode tersebut</li>` : ''}</ul>`,
        onSubmit: async () => {
          G.forEach((g) => { g.statusPo = prStatusPayload(g.rows.map((r) => r[0])); });
          if (!state.noPrHitungScript) for (const g of G) { const h = await prHitungPayload(g.rows.map((r) => ({ kode: r[0], buka: r[8], kirim: r[10] }))); if (h) g.hitung = h; }
          const res = await api('uploadPr', { data: { file: f.name, groups: G } });
          setPrData(res.pr); if (res.prStatus) setPrStatus(res.prStatus); if (res.editLog) state.editLog = res.editLog; renderPrRekap(); renderLog();
          return `${res.codes.length} PR tersimpan.`;
        },
      });
    } catch (err) { toast('Upload PR gagal: ' + err.message); }
  });
  $('prExport').addEventListener('click', () => {
    const data = (state.pr || []).map((r) => ({ 'KODE PR': r.kodePr, 'TANGGAL PR': r.tanggal, NO: r.no, KODE: r.kode, 'NAMA ITEM': r.nama, JENIS: r.jenis, NOTE: r.note,
      'STOK AWAL': r.stok, KEBUTUHAN: r.butuh, 'OS PO': r.ospo, KEKURANGAN: r.kurang, 'JUMLAH BUKA PO': r.buka, 'PEMAKAIAN (BULAN)': r.pakai, 'TANGGAL KIRIM': r.kirim,
      'NO PO': r.pos.join(', '), 'QTY PO (MONITORING PO)': (prPoQty(r) || {}).qty ?? '', STATUS: prStatus(r).t, DIUBAH: r.time, OLEH: r.by }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'REKAP PR');
    XLSX.writeFile(wb, `Rekap_PR_${todayStr()}.xlsx`);
  });

  /* ---------- Lampiran PR (per Kode PR): gambar ditempel (Ctrl+V), disimpan di Google Drive lewat Apps Script ---------- */
  /* ---------- Lampiran Perhitungan PR ----------
   * Kekurangan = Stok Awal + Incoming + OS PO − Kebutuhan − ADD/FOH/RS
   *   Stok Awal  = stok upload pertama di bulan berjalan (MRP)
   *   Incoming   = konfirmasi incoming yang SUDAH datang sejak tanggal stok itu s/d hari ini (yang belum datang ada di OS PO)
   *   OS PO      = sisa semua PO gantung (lewat jadwal maupun akan datang) = Lampiran Status PO
   *   Kebutuhan  = kebutuhan material (Mode Plan: MO menggantikan plan) dari week tanggal stok s/d week MPS terakhir
   *   ADD/FOH/RS = pengurangan manual pada periode yang sama */
  /* ---------- Material pengganti (RM / PM): hanya untuk perhitungan PR ----------
   * Pasangan LAMA → BARU. Di perhitungan PR material BARU, kebutuhan + stok + OS PO material LAMA digabung
   * (stok lama dipakai lebih dulu), kekurangannya dibeli sebagai BARU. Material LAMA tidak diusulkan PR.
   * Pemotongan stok MO, Proyeksi Stok, dan Plotting Harian tidak terpengaruh (tetap per material sesuai BoM Odoo). */
  function setSubs(list) {
    P.subs = (list || []).map((r) => ({ lama: String(r[0] || '').trim(), baru: String(r[1] || '').trim(), pakai: String(r[2] || 'Y').toUpperCase() !== 'N', aktif: String(r[3] || 'Y').toUpperCase() !== 'N', cat: r[4] || '', time: r[5] || '', skus: String(r[6] || '').split(/[;,\s]+/).map((x) => x.trim()).filter(Boolean) })).filter((x) => x.lama && x.baru);
  }
  // subNewOf: hanya bila SEMUA SKU berganti (material lama tidak lagi diusulkan PR); subPartOf: berganti untuk SKU tertentu saja
  function subNewOf(k) { const t = String(k || '').trim(), x = (P.subs || []).find((s) => s.aktif && s.lama === t && !s.skus.length); return x ? x.baru : ''; }
  // berganti untuk SKU tertentu — bisa beberapa pasangan (mis. 14241 → 14337 untuk SKU A, 14241 → 14344 untuk SKU B); digabung jadi satu
  function subPartOf(k) {
    const t = String(k || '').trim(), L = (P.subs || []).filter((s) => s.aktif && s.lama === t && s.skus.length);
    if (!L.length) return null;
    return { baru: [...new Set(L.map((x) => x.baru))].join(', '), skus: [...new Set(L.flatMap((x) => x.skus))], list: L };
  }
  function subOldsOf(k) { const t = String(k || '').trim(); return (P.subs || []).filter((s) => s.aktif && s.baru === t); }
  function prSubWarn(kode, i) {
    const k = String(kode || '').trim(); if (!k) return '';
    const n = subNewOf(k);
    if (n) { const nm = (MRP.master && MRP.master.get(n)) || {}; return `<span class="pr-subw-t">⚠ ${esc(k)} sudah diganti ${esc(n)}${nm.name ? ' ' + esc(nm.name) : ''}</span> <button type="button" class="btn-link" data-subgo="${esc(n)}">Ganti ke ${esc(n)}</button>`; }
    const pt = subPartOf(k);
    if (pt) return `<span class="pr-subw-t">⚠ ${pt.list.map((x) => `Untuk ${esc(x.skus.join(', '))} sudah diganti ${esc(x.baru)}`).join('; ')}; kebutuhan di sini hanya SKU lain</span> ${pt.list.map((x) => `<button type="button" class="btn-link" data-subgo="${esc(x.baru)}">Ganti ke ${esc(x.baru)}</button>`).join(' ')}`;
    const o = subOldsOf(k);
    return o.length ? `<span class="pr-subw-i">Termasuk stok &amp; kebutuhan ${esc(o.map((x) => x.lama + (x.skus.length ? ` (SKU ${x.skus.join(', ')})` : '')).join(', '))} (lama)</span>` : '';
  }
  const rmpmOf = (c) => { const t = String(((MRP.master && MRP.master.get(c)) || {}).kat || '').trim().toUpperCase(); return t.startsWith('RM') ? 'RM' : t.startsWith('PM') ? 'PM' : ''; };
  async function renderSubs() {
    const box = $('subRows'); if (!box) return;
    const ed = state.edit.on || P.edit;
    if (!MRP.loaded) { $('subInfo').textContent = 'Memuat data MRP…'; box.innerHTML = '<tr class="empty"><td colspan="10">Memuat…</td></tr>'; if (!(await mrpReady())) { $('subInfo').textContent = 'Data MRP tidak bisa dimuat.'; return; } }
    if (state.routeKey !== 'pr/pengganti') return;
    const L = P.subs || [];
    const nm = (c) => ((MRP.master.get(c) || {}).name || '');
    const stk = (c) => { const x = prCalc(c, 'all', []); return x ? `${prNumTxt(x.stok) || 0} <small class="muted">${esc(x.uom || '')}</small>` : '–'; };
    box.innerHTML = L.map((x, i) => {
      const users = [...new Set(matUsers(x.lama).filter((u) => !(P.skus.get(u.sku) || {}).rakitan).map((u) => u.sku).concat(ltKitUsers(x.lama).map((u) => `${u.sku} (rakitan)`)))], sw = x.skus.length ? x.skus : null;
      return `<tr class="${x.aktif ? '' : 'lp-dim'}" data-si="${i}"><td><b class="mono">${esc(x.lama)}</b><small class="sub-nm">${esc(nm(x.lama))}</small></td><td><b class="mono">${esc(x.baru)}</b><small class="sub-nm">${esc(nm(x.baru))}</small></td>
        <td>${x.pakai ? 'Habiskan dulu' : '<span class="pl-warn-t">Tidak dipakai</span>'}</td><td class="num">${stk(x.lama)}</td><td class="num">${stk(x.baru)}</td>
        <td>${sw ? `<small><b>${esc(sw.join(', '))}</b></small>` : '<span class="kf-w kf-ok">Semua SKU</span>'}</td><td>${users.length ? `<small>${esc(users.join(', '))}</small>` : '<span class="muted">tidak ada</span>'}</td><td><small>${esc(x.cat)}</small></td>
        <td>${x.aktif ? '<span class="kf-w kf-ok">Aktif</span>' : '<span class="kf-w kf-todo">Nonaktif</span>'}</td>
        <td class="kf-act">${ed ? `<button type="button" class="btn-link" data-subed="${i}">Ubah</button> <button type="button" class="btn-link" data-subon="${i}">${x.aktif ? 'Nonaktifkan' : 'Aktifkan'}</button> <button type="button" class="btn-link danger" data-subdel="${i}">Hapus</button>` : ''}</td></tr>`;
    }).join('') || '<tr class="empty"><td colspan="10">Belum ada pasangan material pengganti.</td></tr>';
    const nA = L.filter((x) => x.aktif).length;
    $('subInfo').innerHTML = `${nA} pasangan aktif dari ${L.length}. Stok = stok terkini per ${esc(fmtDate(todayStr()))}.` + (!P.hasSubs ? ' <span class="pl-bad">Apps Script MRP perlu diperbarui (versi dengan MATERIAL_PENGGANTI) supaya daftar bisa dibaca &amp; disimpan.</span>' : '') + (!ed ? ' Masuk Mode edit untuk menambah / mengubah.' : '');
    $('subAdd').hidden = !ed;
  }
  async function saveSubs(list, msg) {
    const res = await mrpApi('saveSubs', { rows: list.map((x) => [x.lama, x.baru, x.pakai ? 'Y' : 'N', x.aktif ? 'Y' : 'N', x.cat || '', (x.skus || []).join(';')]) });
    setSubs(res.subs || []); stkCache.clear(); renderSubs(); toast(msg || 'Material pengganti tersimpan.');
  }
  function subDialog(i) {
    const L = P.subs || [], x = i >= 0 ? L[i] : { lama: '', baru: '', pakai: true, aktif: true, cat: '', skus: [] };
    // SKU kandidat: SKU aktif yang salah satu BoM-nya memakai material lama + pemakai BoM aktif + SKU dengan kebutuhan MO/plan
    const skuCands = (lama) => {
      const set = new Set(x.lama === lama ? x.skus : []);
      if (lama) {
        P.skus.forEach((k) => { if (k.aktif && k.jenis !== 'Ekstrak' && (MRP.byProduct.get(k.code) || []).some((b) => b.comps.some((c) => c.code === lama))) set.add(k.code); });
        matUsers(lama).forEach((u) => set.add(u.sku));
        const o = stkBase().M.get(lama); if (o) o.sku.forEach((_, k) => set.add(k));
      }
      return [...set].sort();
    };
    const skuBox = (lama, sel) => { const C = skuCands(lama); const taken = (k) => L.find((y, j) => j !== i && y.lama === lama && y.skus.includes(k));
      return C.length ? C.map((k) => { const t = taken(k); return `<label class="tb-check sub-sku${t ? ' is-taken' : ''}"${t ? ` title="Sudah diganti ke ${esc(t.baru)} di pasangan lain"` : ''}><input type="checkbox" name="sku_${esc(k)}" data-subsku="${esc(k)}"${sel.includes(k) ? ' checked' : ''}${t ? ' disabled' : ''}> <b>${esc(k)}</b> <small>${t ? `→ ${esc(t.baru)}` : esc(((P.skus.get(k) || {}).name) || ((MRP.master.get(k) || {}).name) || '')}</small></label>`; }).join('') : '<span class="muted">Isi kode lama dulu / tidak ada SKU yang memakai material ini.</span>'; };
    const opts = [...MRP.master.values()].filter((m) => rmpmOf(m.code)).map((m) => `<option value="${esc(m.code)}">${esc(m.name)}</option>`).join('');
    openDialog({
      title: i >= 0 ? `Ubah pasangan ${x.lama} → ${x.baru}` : 'Tambah material pengganti', ok: 'Simpan',
      body: `<div class="form-grid"><label class="field"><span>Kode material lama *</span><input name="lama" value="${esc(x.lama)}" list="subMat" required autocomplete="off"><small class="muted" id="subNmL">${esc(((MRP.master.get(x.lama) || {}).name) || '')}</small></label>
        <label class="field"><span>Kode material baru *</span><input name="baru" value="${esc(x.baru)}" list="subMat" required autocomplete="off"><small class="muted" id="subNmB">${esc(((MRP.master.get(x.baru) || {}).name) || '')}</small></label>
        <label class="field"><span>Stok lama</span><select name="pakai"><option value="Y"${x.pakai ? ' selected' : ''}>Ya, habiskan dulu (ikut mengurangi kekurangan)</option><option value="N"${x.pakai ? '' : ' selected'}>Tidak dipakai (stok & PO lama diabaikan)</option></select></label>
        <label class="field full"><span>Catatan</span><input name="cat" value="${esc(x.cat)}"></label></div><datalist id="subMat">${opts}</datalist>
        <div class="sub-skuw"><b>SKU yang berganti</b>
          <label class="tb-check"><input type="radio" name="skumode" value="all"${x.skus.length ? '' : ' checked'}> Semua SKU</label>
          <label class="tb-check"><input type="radio" name="skumode" value="pick"${x.skus.length ? ' checked' : ''}> Hanya SKU yang dicentang</label>
          <div class="sub-skul" id="subSkuL"${x.skus.length ? '' : ' hidden'}>${skuBox(x.lama, x.skus)}</div>
          <p class="hint">SKU yang tidak dicentang tetap memakai material lama: kebutuhannya tetap di material lama (masih bisa di-PR-kan), dan stok lama dipakai untuk SKU itu lebih dulu; sisanya baru ikut mengurangi kekurangan material baru.</p></div>
        <p class="hint">Material RM atau PM (lama dan baru harus golongan sama). Berlaku untuk perhitungan PR saja: kebutuhan, stok, dan OS PO material lama digabung ke material baru; material lama tidak diusulkan PR. Proyeksi Stok dan pemotongan stok MO tidak berubah.</p>`,
      onSubmit: async (fd) => {
        const lama = String(fd.lama || '').trim(), baru = String(fd.baru || '').trim();
        if (!lama || !baru) throw new Error('Kode lama dan baru wajib diisi.');
        if (lama === baru) throw new Error('Kode lama dan baru tidak boleh sama.');
        [lama, baru].forEach((c) => { if (!MRP.master.has(c)) throw new Error(`Kode ${c} tidak ada di Daftar Material.`); if (!rmpmOf(c)) throw new Error(`${c} bukan material RM / PM (kategori ${(MRP.master.get(c) || {}).kat || '–'}).`); });
        if (rmpmOf(lama) !== rmpmOf(baru)) throw new Error(`${lama} (${rmpmOf(lama)}) dan ${baru} (${rmpmOf(baru)}) beda golongan. Pasangan harus RM → RM atau PM → PM.`);
        const others = L.filter((_, j) => j !== i);
        const skusSel = fd.skumode === 'pick' ? [...$('dlgBody').querySelectorAll('[data-subsku]:checked')].map((c) => c.dataset.subsku) : [];
        const same = others.filter((y) => y.lama === lama);
        if (same.some((y) => y.baru === baru)) throw new Error(`Pasangan ${lama} → ${baru} sudah ada. Ubah pasangan itu saja.`);
        if (same.length && (!skusSel.length || same.some((y) => !y.skus.length))) throw new Error(`${lama} sudah punya pengganti lain (${same.map((y) => y.baru).join(', ')}). Bila satu material lama punya beberapa pengganti, setiap pasangan harus memakai "Hanya SKU yang dicentang".`);
        const dup = skusSel.filter((k) => same.some((y) => y.skus.includes(k)));
        if (dup.length) throw new Error(`SKU ${dup.join(', ')} sudah diganti ke ${same.filter((y) => y.skus.some((k) => dup.includes(k))).map((y) => y.baru).join(', ')} di pasangan lain. Satu SKU hanya boleh punya satu pengganti untuk ${lama}.`);
        if (others.some((y) => y.aktif && y.lama === baru)) throw new Error(`${baru} sendiri sudah diganti material lain (rantai A → B → C belum didukung).`);
        if (others.some((y) => y.aktif && y.baru === lama)) throw new Error(`${lama} adalah pengganti material lain (rantai A → B → C belum didukung).`);
        const skus = fd.skumode === 'pick' ? [...$('dlgBody').querySelectorAll('[data-subsku]:checked')].map((c) => c.dataset.subsku) : [];
        if (fd.skumode === 'pick' && !skus.length) throw new Error('Centang minimal satu SKU yang berganti, atau pilih "Semua SKU".');
        const nx = { lama, baru, pakai: fd.pakai !== 'N', aktif: x.aktif, cat: String(fd.cat || '').trim(), skus };
        const list = L.slice(); if (i >= 0) list[i] = nx; else list.push(nx);
        await saveSubs(list, `${lama} → ${baru} tersimpan.`);
        return '';
      },
    });
    const body = $('dlgBody');
    ['lama', 'baru'].forEach((n) => body.querySelector(`[name=${n}]`).addEventListener('input', (e) => { $(n === 'lama' ? 'subNmL' : 'subNmB').textContent = ((MRP.master.get(e.target.value.trim()) || {}).name) || ''; if (n === 'lama') { const sel = [...body.querySelectorAll('[data-subsku]:checked')].map((c) => c.dataset.subsku); $('subSkuL').innerHTML = skuBox(e.target.value.trim(), sel); } }));
    body.querySelectorAll('[name=skumode]').forEach((r) => r.addEventListener('change', () => { $('subSkuL').hidden = body.querySelector('[name=skumode]:checked').value !== 'pick'; }));
  }
  if ($('subAdd')) {
    $('subAdd').addEventListener('click', () => needEdit(() => subDialog(-1)));
    $('subRows').addEventListener('click', (e) => {
      const b = e.target.closest('[data-subed],[data-subon],[data-subdel]'); if (!b) return;
      const L = P.subs || [];
      if (b.dataset.subed !== undefined) { needEdit(() => subDialog(Number(b.dataset.subed))); return; }
      if (b.dataset.subon !== undefined) { const i = Number(b.dataset.subon); needEdit(async () => { const list = L.map((x, j) => (j === i ? Object.assign({}, x, { aktif: !x.aktif }) : x)); try { await saveSubs(list, `${L[i].lama} → ${L[i].baru} ${L[i].aktif ? 'dinonaktifkan' : 'diaktifkan'}.`); } catch (err) { toast('Gagal: ' + err.message); } }); return; }
      const i = Number(b.dataset.subdel), x = L[i];
      needEdit(() => openDialog({ title: `Hapus pasangan ${x.lama} → ${x.baru}?`, ok: 'Hapus', body: '<p class="dlg-lead">Pasangan dihapus dari daftar. Perhitungan PR berikutnya tidak lagi menggabungkan kedua material ini. PR yang sudah dibuat tidak berubah.</p>',
        onSubmit: async () => { await saveSubs(L.filter((_, j) => j !== i), `${x.lama} → ${x.baru} dihapus.`); return ''; } }));
    });
  }
  /* ================= PR LEAD TIME PANJANG =================
   * Kebutuhan dari rata-rata SO CSL (PC + Beauty) 6 bulan penuh sebelum tanggal mulai × material per pcs (BoM aktif Parameter SKU).
   * Stok awal = upload stok terdekat dengan tanggal mulai; OS PO = sisa PO gantung menurut jadwalnya.
   * Stok pengaman = 1 bulan pemakaian. Batas buka PO = saat saldo < stok pengaman − lead time. */
  function setLt(list) {
    P.lt = (list || []).map((r) => ({ kode: String(r[0] || '').trim(), lt: Number(r[1]) || 0, cat: r[2] || '', aktif: String(r[3] || 'Y').toUpperCase() !== 'N', time: r[4] || '' })).filter((x) => x.kode && x.lt > 0);
  }
  const LTSO = { m: null, at: 0, errs: [], lastSo: '' };
  async function ltSoMap(fresh) {
    if (LTSO.m && !fresh && Date.now() - LTSO.at < 10 * 60e3) return LTSO;
    if (!window.CSL || !window.CSL.soOut) throw new Error('Data CSL tidak tersedia.');
    const m = new Map(), errs = []; let lastSo = '';
    for (const seg of ['pc', 'beauty']) {
      try { const r = await window.CSL.soOut(seg); (r.lines || []).forEach(([k, b, q]) => { const key = k + '|' + b; m.set(key, (m.get(key) || 0) + q); }); if (r.lastSo > lastSo) lastSo = r.lastSo; }
      catch (e) { errs.push(`${seg === 'pc' ? 'Personal Care' : 'Beauty'}: ${e.message}`); }
    }
    Object.assign(LTSO, { m, at: Date.now(), errs, lastSo });
    return LTSO;
  }
  const ltDays = (b) => new Date(+b.slice(0, 4), +b.slice(5, 7), 0).getDate();
  const ltAddDays = (d, n) => { const t = new Date(d + 'T00:00:00'); t.setDate(t.getDate() + Math.round(n)); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
  const ltDiff = (a, b) => Math.round((new Date(a + 'T00:00:00') - new Date(b + 'T00:00:00')) / 864e5);
  function ltMoq(code) { const S = state.sup; if (!S || !S.rows) return null; const L = S.rows.filter((x) => x.code === code && x.moq); const m = L.find((x) => x.main) || L[0]; return m ? m.moq : null; }
  function ltCalc(kode, o = {}) {
    kode = String(kode || '').trim(); if (!kode) return null;
    const B = stkBase(), today = B.today, R3 = (x) => Math.round((Number(x) || 0) * 1000) / 1000;
    const def = (P.lt || []).find((x) => x.kode === kode) || {};
    const lt = Number(o.lt) || def.lt || 3, start = o.start || today.slice(0, 7) + '-01', m0 = start.slice(0, 7);
    const hz = Number(o.hz) || Math.ceil(lt) + 2;
    const avgMs = [6, 5, 4, 3, 2, 1].map((k) => addMonth(m0, -k));
    const SO = o.SO || LTSO.m || new Map();
    const m = MRP.master.get(kode) || {};
    // Material pengganti (sama dengan PR Reguler): material lama yang diganti ke kode ini, dan SKU kode ini yang sudah dialihkan ke material lain
    const olds = subOldsOf(kode), full = olds.filter((x) => !x.skus.length), partO = olds.filter((x) => x.skus.length);
    const part = subPartOf(kode), replacedBy = subNewOf(kode);
    const skuOk = (c, sku) => { if (c === kode) return !(part && part.skus.includes(sku)); const x = olds.find((y) => y.lama === c); return !x || !x.skus.length || x.skus.includes(sku); };
    // SKU pemakai (BoM aktif) — SKU tanpa SO tetap ditampilkan
    const users = [kode, ...olds.map((x) => x.lama)].flatMap((c) => matUsers(c).filter((u) => !(P.skus.get(u.sku) || {}).rakitan).concat(ltKitUsers(c)).filter((u) => skuOk(c, u.sku)).map((u) => Object.assign({}, u, { mat: c })));
    const rows = users.map((u) => {
      const so = avgMs.map((b) => Math.round(SO.get(u.sku + '|' + b) || 0));
      const avgPcs = so.reduce((t, x) => t + x, 0) / 6;
      const kgPcs = u.perPcs && u.perTon ? u.perPcs / (u.perTon / 1000) : 0;   // kg produk per pcs
      const perKg = u.perTon / 1000, needM = avgPcs * u.perPcs;
      return { sku: u.sku, name: u.name, bom: u.bom, kit: !!u.kit, old: u.mat !== kode ? u.mat : undefined, perKg: Math.round(perKg * 1e6) / 1e6, perPcs: u.perPcs, so, avgPcs: Math.round(avgPcs), avgKg: kgPcs ? R3(avgPcs * kgPcs) : null, prodKg: kgPcs ? R3(avgPcs * kgPcs * hz) : null, prodPcs: Math.round(avgPcs * hz), needM: R3(needM), need: R3(needM * hz) };
    }).sort((a, b) => b.need - a.need || a.sku.localeCompare(b.sku));
    const use = R3(rows.reduce((t, x) => t + x.needM, 0)), total = R3(use * hz);
    // stok awal: upload stok terdekat dengan tanggal mulai (+ stok material lama yang diganti semua SKU-nya & stok lama dipakai)
    const dates = [...(P.stockHist || new Map()).keys()].sort();
    const sd = dates.reduce((best, d) => (!best || Math.abs(ltDiff(d, start)) < Math.abs(ltDiff(best, start)) ? d : best), '');
    const stQ = (c) => (sd ? ((P.stockHist.get(sd).get(c) || {}).qty || 0) : 0);
    const KS = [kode, ...full.filter((x) => x.pakai).map((x) => x.lama)];
    const stokOwn = R3(stQ(kode));
    // sisa stok + OS PO material lama setelah kebutuhan SKU yang tidak berganti (berganti untuk SKU tertentu), dibagi bila beberapa pengganti
    const swNeed = (x) => matUsers(x.lama).filter((u) => x.skus.includes(u.sku)).reduce((t, u) => t + (avgMs.reduce((a, b) => a + (SO.get(u.sku + '|' + b) || 0), 0) / 6) * u.perPcs, 0);
    const lumps = partO.filter((x) => x.pakai).map((x) => {
      const r = ltCalc(x.lama, Object.assign({}, o, { lt, start, hz, SO })), rem = r ? Math.max(0, r.kurang) : 0;
      const sib = (P.subs || []).filter((y) => y.aktif && y.pakai && y.lama === x.lama && y.skus.length);
      const tot = sib.reduce((t, y) => t + swNeed(y), 0), share = sib.length < 2 ? 1 : tot > 1e-9 ? swNeed(x) / tot : 1 / sib.length;
      return { kode: x.lama, q: R3(rem * share), share };
    });
    const lump = R3(lumps.reduce((t, x) => t + x.q, 0));
    const stokOld = KS.slice(1).map((c) => ({ kode: c, q: R3(stQ(c)) }));
    const stok = R3(stokOwn + stokOld.reduce((t, x) => t + x.q, 0) + lump);
    // OS PO per jadwal (termasuk PO material lama yang diganti semua SKU-nya)
    const po = [], seen = new Set();
    KS.forEach((c) => poRowsOf(c).forEach((x) => {
      const key = x.po + '|' + x.code; if (seen.has(key)) return; seen.add(key);
      const sc = (x.sched || []).filter((s) => s.status !== 'Done' && (Number(s.qty) || 0) - (Number(s.rec) || 0) > 1e-9);
      const info = { po: x.po, sup: x.supplier || '', tglPo: x.date || '', qtyPo: x.qty, uomPo: x.uom || '', mat: c !== kode ? c : undefined };
      if (sc.length) sc.forEach((s) => po.push(Object.assign({ d: s.date || '', q: R3((Number(s.qty) || 0) - (Number(s.rec) || 0)) }, info)));
      else po.push(Object.assign({ d: '', q: R3(x.sisa) }, info));
    }));
    const ospo = R3(po.reduce((t, x) => t + x.q, 0));
    // pemakaian bulan berjalan dari MO (Plotting Harian): sudah jalan + terjadwal bulan ini (gabungan material pengganti)
    const pc = prCalc(kode, 'all', [], { pool: true });
    const moNow = pc ? R3(pc.pakaiPast + pc.cols.filter((c) => c.kind === 'w').reduce((t, c) => t + c.need, 0)) : 0;
    const wIdx = new Set(B.cols.map((c, i) => (c.kind === 'w' ? i : -1)).filter((i) => i >= 0));
    const moList = [kode, ...olds.map((x) => x.lama)].flatMap((c) => { const mo0 = B.M.get(c); return mo0 ? mo0.mos.filter((x) => (x.past || wIdx.has(x.i)) && skuOk(c, x.sku)).map((x) => Object.assign({}, x, { mat: c })) : []; })
      .map((x) => { const r = kfGet(x.ref) || {}; return { no: x.ref, sku: x.sku, mat: x.mat !== kode ? x.mat : undefined, name: (P.skus.get(x.sku) || MRP.master.get(x.sku) || {}).name || '', tgl: r.tgl || '', wk: r.week ? `${r.week} ${monShort(r.bulan || today)}` : '', qtyMo: Number(r.qty) || 0, uomMo: r.uom || '', q: R3(x.q), past: !!x.past }; })
      .sort((a, b) => (a.tgl || '9').localeCompare(b.tgl || '9') || a.no.localeCompare(b.no));
    // proyeksi saldo per bulan (PO tanpa tanggal / telat dianggap datang di bulan pertama)
    const N = Math.max(hz, 36), proj = []; let s = stok;
    for (let i = 0; i < N; i++) {
      const b = addMonth(m0, i), inc = R3(po.filter((x) => (i === 0 ? !x.d || x.d.slice(0, 7) <= b : x.d.slice(0, 7) === b)).reduce((t, x) => t + x.q, 0));
      const open = s + inc; s = R3(open - use);
      proj.push({ b, open: R3(open), inc, use, sal: s });
    }
    const safety = use;
    let habis = '', status = 'green', batas = '', days = null, dip = null;
    if (use > 1e-9 && !replacedBy) {
      // batas buka PO: saat stok + SEMUA OS PO tidak lagi menutup stok pengaman (PO baru hanya bisa menolong setelah OS PO habis terpakai)
      const t = Math.max(0, (stok + ospo - safety) / use);          // bulan sejak tanggal mulai
      habis = ltAddDays(start, t * 30.44);
      batas = ltAddDays(habis, -lt * 30.44);
      days = ltDiff(batas, today);
      status = days <= 14 ? 'red' : days <= 30 ? 'yellow' : 'green';
      // penurunan sementara sebelum OS PO datang (bukan tugas PO baru → minta percepat OS PO)
      const i = proj.findIndex((x) => x.sal < safety - 1e-9);
      if (i >= 0) {
        const x = proj[i], f = x.open <= safety ? 0 : Math.min(1, (x.open - safety) / use), dd = ltAddDays(x.b + '-01', f * ltDays(x.b));
        const nx = po.filter((y) => y.d && y.d > dd).sort((a, b) => a.d.localeCompare(b.d))[0];
        if (nx && ltDiff(habis, dd) > 7) dip = { date: dd, po: nx.po, poDate: nx.d, poQ: nx.q };
      }
    }
    const kurang = R3(stok + ospo - total), doi = use > 1e-9 ? Math.round(((stok + ospo) / use) * 10) / 10 : null;
    const moq = ltMoq(kode), saranRaw = !replacedBy && kurang < 0 ? -kurang : 0;
    const saran = saranRaw > 0 ? Math.ceil(Math.max(saranRaw, moq || 0)) : 0;
    const sub = olds.length || part || replacedBy ? { olds: olds.map((x) => ({ kode: x.lama, skus: x.skus, pakai: x.pakai })), stokOld, lumps, part: part ? { baru: part.baru, skus: part.skus } : null, replacedBy } : null;
    return { sub, dip, now: pc ? { stok: pc.stok, awal: pc.awal, koreksi: pc.koreksi, gantung: pc.gantung, incPast: pc.incPast, pakaiPast: pc.pakaiPast, addPast: pc.addPast } : null, moList, stokFrom: B.d0, kode, nama: m.name || '', uom: m.uom || '', kat: m.kat || '', lt, start, hz, avgMs, months: proj.slice(0, hz).map((x) => x.b), rows, use, total, stokDate: sd, stokOwn, stok, po, ospo, moNow, moOver: use > 1e-9 ? Math.round(((moNow - use) / use) * 1000) / 10 : null, proj: proj.slice(0, Math.max(hz, 12)), safety, habis, batas, days, status: replacedBy ? 'subs' : status, kurang, doi, moq, saranRaw: R3(saranRaw), saran, cat: def.cat || '' };
  }
  // Pemakai produk rakitan (Banded / 2in1 / KIT) — mengikuti menu BoM Banded/2in1/KIT: hanya produk rakitan aktif,
  // BoM yang dipilih di menu itu, dan hanya baris "Ya digunakan" (ekstrak ditelusuri sampai bahan baku). Khusus PR LT Panjang.
  const ltKitMemo = { key: '', map: new Map() };
  function ltKitUsers(kode) {
    const key = (P.rakitan || []).map((k) => k.code + k.bom + k.aktif).join(',') + '|' + (P.pakai ? P.pakai.size : 0) + '|' + MRP.byProduct.size;
    if (ltKitMemo.key !== key) {
      const map = new Map();
      (P.rakitan || []).filter((k) => k.aktif).forEach((k) => {
        const sk = P.skus.get(k.code) || {}, bom = activeBom(k.code); if (!bom) return;
        const r = needRakitan(k.code, 1, bom);
        r.leaves.forEach((q, c) => { if (!(q > 0)) return; if (!map.has(c)) map.set(c, []); map.get(c).push({ sku: k.code, name: sk.name || (MRP.master.get(k.code) || {}).name || k.code, bom: refOf(bom), perTon: 0, perPcs: q, kit: true }); });
      });
      ltKitMemo.key = key; ltKitMemo.map = map;
    }
    return ltKitMemo.map.get(String(kode || '').trim()) || [];
  }
  const LT_ST = { red: ['Segera buka PO', 'lt-red'], yellow: ['Siapkan PO', 'lt-yel'], green: ['Aman', 'lt-grn'], subs: ['Diganti', 'lt-sub'] };
  const ltStatusHtml = (d) => `<span class="lt-st ${LT_ST[d.status][1]}">${LT_ST[d.status][0]}</span>`;
  async function renderLtMat() {
    const box = $('ltRows'); if (!box) return;
    const ed = state.edit.on || P.edit;
    if (!MRP.loaded) { $('ltInfo').textContent = 'Memuat data MRP…'; box.innerHTML = '<tr class="empty"><td colspan="14">Memuat…</td></tr>'; if (!(await mrpReady())) { $('ltInfo').textContent = 'Data MRP tidak bisa dimuat.'; return; } }
    if (state.routeKey !== 'prlt/material') return;
    $('ltAdd').hidden = !ed;
    const L = P.lt || [];
    if (!L.length) { box.innerHTML = `<tr class="empty"><td colspan="14">Belum ada material LT panjang.${ed ? ' Klik "Tambah material".' : ' Masuk Mode edit untuk menambah.'}</td></tr>`; $('ltInfo').innerHTML = !P.hasLt ? '<span class="pl-bad">Apps Script MRP perlu diperbarui (versi dengan MATERIAL_LT).</span>' : ''; return; }
    box.innerHTML = '<tr class="empty"><td colspan="14">Memuat SO CSL…</td></tr>';
    let SO; try { SO = await ltSoMap(); } catch (e) { SO = { m: new Map(), errs: [e.message] }; }
    if (state.routeKey !== 'prlt/material') return;
    const D = L.map((x, i) => ({ x, i, d: x.aktif ? ltCalc(x.kode, { SO: SO.m }) : null }));
    const ord = { red: 0, yellow: 1, green: 2, subs: 3 };
    D.sort((a, b) => (!a.d) - (!b.d) || (a.d && b.d ? ord[a.d.status] - ord[b.d.status] || (a.d.batas || '9').localeCompare(b.d.batas || '9') : 0));
    P.ltView = D; P.ltSO = SO;
    ltPaint();
  }
  function ltPaint() {
    const box = $('ltRows'), D = P.ltView || [], SO = P.ltSO || {}, ed = state.edit.on || P.edit;
    const ql = ($('ltQ').value || '').trim().toLowerCase();
    const gf = $('ltGrp').value;
    const V = D.filter(({ x }) => !gf || rmpmOf(x.kode) === gf).filter(({ x, d }) => !ql || (x.kode + ' ' + ((d && d.nama) || (MRP.master.get(x.kode) || {}).name || '') + ' ' + x.cat).toLowerCase().includes(ql));
    // sort per kolom (klik judul kolom); nonaktif selalu di bawah
    const S = P.ltSort || { k: 'status', dir: 1 }, ordS = { red: 0, yellow: 1, green: 2, subs: 3 };
    const key = { kode: (y) => y.x.kode, lt: (y) => y.x.lt, use: (y) => y.d.use, mo: (y) => y.d.moNow, stok: (y) => y.d.stok, now: (y) => (y.d.now ? y.d.now.stok : 0), ospo: (y) => y.d.ospo, doi: (y) => (y.d.doi === null ? 1e9 : y.d.doi), habis: (y) => y.d.habis || '9999', batas: (y) => y.d.batas || '9999', status: (y) => ordS[y.d.status] * 1e5 + (y.d.days === null ? 99999 : y.d.days), saran: (y) => y.d.saran }[S.k];
    V.sort((a, b) => { if (!a.d || !b.d) return (!a.d) - (!b.d); const va = key(a), vb = key(b); return (typeof va === 'string' ? va.localeCompare(vb, 'id', { numeric: true }) : va - vb) * S.dir; });
    document.querySelectorAll('#view-prlt-mat th[data-ltsort]').forEach((th) => { th.classList.toggle('is-sort', th.dataset.ltsort === S.k); th.dataset.dir = th.dataset.ltsort === S.k ? (S.dir > 0 ? 'asc' : 'desc') : ''; });
    const q = (v, u) => `${prNumTxt(v) || 0}${u ? ` <small class="muted">${esc(u)}</small>` : ''}`;
    box.innerHTML = V.map(({ x, i, d }) => {
      const act = ed ? `<button type="button" class="btn-link" data-lted="${i}">Ubah</button> <button type="button" class="btn-link" data-lton="${i}">${x.aktif ? 'Nonaktifkan' : 'Aktifkan'}</button> <button type="button" class="btn-link danger" data-ltdel="${i}">Hapus</button>` : '';
      if (!d) return `<tr class="lp-dim"><td><b class="mono">${esc(x.kode)}</b><small class="sub-nm">${esc((MRP.master.get(x.kode) || {}).name || '')}</small></td><td class="num">${x.lt} bln</td><td colspan="10" class="muted">Nonaktif</td><td></td><td class="kf-act">${act}</td></tr>`;
      const over = d.moOver === null ? '' : d.moOver > 0.5 ? `<small class="pl-bad">+${d.moOver}% dari rata-rata</small>` : d.moOver < -0.5 ? `<small class="muted">${d.moOver}% dari rata-rata</small>` : '<small class="muted">sesuai rata-rata</small>';
      return `<tr data-lti="${i}"><td><b class="mono">${esc(d.kode)}</b><small class="sub-nm">${esc(d.nama)}</small></td><td class="num">${d.lt} bln</td>
        <td class="num"><button type="button" class="lt-num" data-ltx="use" data-lti="${i}" title="Rincian per SKU">${q(d.use, d.uom)}</button></td><td class="num"><button type="button" class="lt-num" data-ltx="mo" data-lti="${i}" title="Rincian MO">${q(d.moNow)}</button>${over}</td><td class="num">${q(d.stok)}<small class="muted">${d.stokDate ? fmtDate(d.stokDate) : ''}</small></td><td class="num">${d.now ? `<button type="button" class="lt-num" data-ltx="now" data-lti="${i}" title="Rincian stok terkini">${q(d.now.stok)}</button><small class="muted">per ${fmtDate(todayStr())}</small>` : '–'}</td><td class="num"><button type="button" class="lt-num" data-ltx="po" data-lti="${i}" title="Rincian PO">${q(d.ospo)}</button></td>
        <td class="num">${d.doi === null ? '–' : d.doi + ' bln'}</td><td>${d.sub && d.sub.replacedBy ? `<span class="muted">diganti → ${esc(d.sub.replacedBy)}</span>` : d.habis ? fmtDate(d.habis) : '<span class="muted">–</span>'}${d.dip ? `<small class="pl-bad" title="Saldo sempat di bawah stok pengaman sebelum OS PO datang. PO baru tidak bisa menolong ini (lead time) — minta OS PO dipercepat.">⚠ ${fmtDate(d.dip.date)} sebelum ${esc(d.dip.po)} datang${d.dip.poDate ? ' ' + fmtDate(d.dip.poDate) : ''} → percepat</small>` : ''}${d.sub && (d.sub.olds.length || d.sub.part) ? `<small class="muted">${d.sub.olds.length ? `+ ${esc(d.sub.olds.map((x) => x.kode).join(', '))} (lama)` : `sebagian SKU → ${esc(d.sub.part.baru)}`}</small>` : ''}</td><td><b>${d.batas ? fmtDate(d.batas) : '–'}</b>${d.days !== null ? `<small class="muted">${d.days < 0 ? `lewat ${-d.days} hari` : `${d.days} hari lagi`}</small>` : ''}</td>
        <td>${ltStatusHtml(d)}</td><td class="num">${d.saran ? `<b>${prNumTxt(d.saran)}</b>${d.moq ? `<small class="muted">MoQ ${prNumTxt(d.moq)}</small>` : ''}` : '<span class="muted">–</span>'}</td>
        <td><button type="button" class="btn-link" data-ltdet="${i}">Rincian</button></td><td class="kf-act">${act}</td></tr>`;
    }).join('') || '<tr class="empty"><td colspan="14">Tidak ada material yang cocok dengan pencarian.</td></tr>';
    const nR = D.filter((y) => y.d && y.d.status === 'red').length, nY = D.filter((y) => y.d && y.d.status === 'yellow').length;
    $('ltInfo').innerHTML = `${D.filter((y) => y.d).length} material aktif · <span class="lt-st lt-red">${nR} segera buka PO</span> <span class="lt-st lt-yel">${nY} siapkan PO</span> · rata-rata SO ${monShort(D.find((y) => y.d) ? D.find((y) => y.d).d.avgMs[0] : todayStr())}–${monShort(D.find((y) => y.d) ? D.find((y) => y.d).d.avgMs[5] : todayStr())} (SO s/d ${SO.lastSo ? fmtDate(SO.lastSo) : '–'})${SO.errs && SO.errs.length ? ` · <span class="pl-bad">${esc(SO.errs.join('; '))}</span>` : ''}${!P.hasLt ? ' · <span class="pl-bad">Apps Script MRP perlu diperbarui.</span>' : ''}`;
  }
  function ltDetailHtml(d) {
    const n = (v) => prNumTxt(v) || 0, ms = d.months;
    return `<p class="dlg-lead"><b>${esc(d.kode)}</b> ${esc(d.nama)} · lead time ${d.lt} bln · mulai ${fmtDate(d.start)} · horizon ${d.hz} bln (${monShort(ms[0])} ${ms[0].slice(2, 4)} – ${monShort(ms[ms.length - 1])} ${ms[ms.length - 1].slice(2, 4)}) · rata-rata SO ${monShort(d.avgMs[0])}–${monShort(d.avgMs[5])}</p>
      <div class="table-wrap"><table class="po-table lt-t"><thead><tr><th>Kode FG</th><th>Nama FG</th><th class="num">Keb. / 1 kg produksi</th><th class="num">Avg L6M (pcs)</th><th class="num">Avg L6M (kg)</th><th class="num">Produksi ${d.hz} bln (kg)</th><th class="num">Kebutuhan ${d.hz} bln</th></tr></thead><tbody>
      ${d.rows.map((r) => `<tr><td class="mono">${esc(r.sku)}</td><td>${esc(r.name)}${r.kit ? '<small class="muted">KIT / Banded</small>' : ''}${r.old ? `<small class="lp-old">BoM lama (${esc(r.old)})</small>` : ''}</td><td class="num">${r.kit ? `<small class="muted">${String(Math.round(r.perPcs * 1e4) / 1e4).replace('.', ',')} / pcs</small>` : r.perKg.toFixed(4).replace('.', ',')}</td><td class="num">${r.avgPcs ? n(r.avgPcs) : '–'}</td><td class="num">${r.avgKg ? n(r.avgKg) : '–'}</td><td class="num">${r.prodKg ? n(r.prodKg) : '–'}</td><td class="num"><b>${r.need ? n(r.need) : '–'}</b></td></tr>`).join('') || '<tr class="empty"><td colspan="7">Tidak ada SKU aktif yang BoM-nya memakai material ini.</td></tr>'}
      <tr class="lt-tot"><td colspan="6">Total pemakaian ${d.hz} bulan</td><td class="num"><b>${n(d.total)} ${esc(d.uom)}</b></td></tr></tbody></table></div>
      <div class="lt-sum"><dl>
        <dt>Stok awal (${d.stokDate ? fmtDate(d.stokDate) : '–'})</dt><dd>${n(d.stok)}${d.sub && Math.abs(d.stok - d.stokOwn) > 1e-9 ? `<small class="muted">${esc(d.kode)} ${n(d.stokOwn)}${d.sub.stokOld.map((x) => ` + ${esc(x.kode)} ${n(x.q)}`).join('')}${d.sub.lumps.map((x) => ` + sisa ${esc(x.kode)} ${n(x.q)}${x.share < 1 ? ` (${Math.round(x.share * 1000) / 10}%)` : ''}`).join('')}</small>` : ''}</dd><dt>OS PO</dt><dd>${n(d.ospo)}</dd>
        <dt>Total pemakaian ${d.hz} bln</dt><dd>${n(d.total)}</dd><dt>Pemakaian per bulan (avg SO)</dt><dd>${n(d.use)}</dd>
        <dt>Pemakaian bulan berjalan (MO)</dt><dd>${n(d.moNow)}${d.moOver !== null ? ` <small class="${d.moOver > 0.5 ? 'pl-bad' : 'muted'}">${d.moOver > 0 ? '+' : ''}${d.moOver}%</small>` : ''}</dd>
        <dt>Kekurangan</dt><dd class="${d.kurang < 0 ? 'pl-bad' : ''}"><b>${n(d.kurang)}</b></dd>
        <dt>DOI</dt><dd>${d.doi === null ? '–' : d.doi + ' bulan'}</dd><dt>Stok pengaman (1 bln)</dt><dd>${n(d.safety)}</dd>
        <dt>Stok + OS PO di bawah stok pengaman</dt><dd>${d.habis ? fmtDate(d.habis) : '–'}</dd><dt>Batas buka PO (− ${d.lt} bln)</dt><dd><b>${d.batas ? fmtDate(d.batas) : '–'}</b> ${ltStatusHtml(d)}</dd>
        <dt>Saran qty PO</dt><dd><b>${d.saran ? n(d.saran) : '–'}</b>${d.moq ? ` <small class="muted">MoQ ${n(d.moq)}</small>` : ''}</dd></dl></div>
      ${d.sub ? `<p class="hint">${d.sub.replacedBy ? `Material ini sudah diganti <b>${esc(d.sub.replacedBy)}</b> untuk semua SKU — kebutuhannya dihitung di ${esc(d.sub.replacedBy)}, tidak ada saran buka PO.` : ''}${d.sub.olds.length ? `Material pengganti: termasuk kebutuhan ${d.sub.olds.map((x) => `${esc(x.kode)}${x.skus.length ? ` (SKU ${esc(x.skus.join(', '))})` : ''}`).join(', ')}; stok & OS PO material lama dipakai lebih dulu.` : ''}${d.sub.part ? ` SKU ${esc(d.sub.part.skus.join(', '))} sudah dialihkan ke ${esc(d.sub.part.baru)}; angka di sini hanya SKU yang tetap memakai ${esc(d.kode)}.` : ''}</p>` : ''}
      ${d.dip ? `<p class="hint pl-bad">⚠ Saldo sempat di bawah stok pengaman sekitar ${fmtDate(d.dip.date)} sebelum ${esc(d.dip.po)}${d.dip.poDate ? ` (${n(d.dip.poQ)}) datang ${fmtDate(d.dip.poDate)}` : ''}. PO baru tidak bisa menolong ini karena lead time — minta OS PO dipercepat. Batas buka PO dihitung dari saat stok + semua OS PO tidak cukup lagi.</p>` : ''}
      <p><b>Proyeksi saldo per bulan</b> <small class="muted">(PO dihitung datang di bulan jadwalnya; PO telat / tanpa jadwal di bulan pertama)</small></p>
      <div class="table-wrap"><table class="po-table lt-t"><thead><tr><th>Bulan</th><th class="num">Awal</th><th class="num">+ PO datang</th><th class="num">− Pemakaian</th><th class="num">Saldo akhir</th></tr></thead><tbody>
      ${d.proj.map((x) => `<tr class="${x.sal < d.safety ? 'lt-low' : ''}"><td>${monLabel(x.b)}</td><td class="num">${n(x.open - x.inc)}</td><td class="num">${x.inc ? n(x.inc) : '–'}</td><td class="num">${n(x.use)}</td><td class="num"><b>${n(x.sal)}</b></td></tr>`).join('')}
      </tbody></table></div>
      ${d.po.length ? `<p class="hint">OS PO: ${d.po.map((x) => `${esc(x.po)} ${n(x.q)}${x.d ? ' · ' + fmtDate(x.d) : ' · tanpa jadwal'}`).join('; ')}</p>` : ''}`;
  }
  function ltMiniHtml(kind, d) {
    const n = (v) => prNumTxt(v) || 0;
    if (kind === 'use') {
      const R = d.rows.filter((r) => r.avgPcs > 0);
      return `<p class="dlg-lead"><b>${esc(d.kode)}</b> ${esc(d.nama)}. Pemakaian per bulan = Σ (rata-rata SO ${monShort(d.avgMs[0])}–${monShort(d.avgMs[5])} per SKU × material per pcs). SO dari CSL Personal Care + Beauty, qty SO dikurangi batal, bulan menurut tanggal SO.</p>
        <div class="table-wrap"><table class="po-table lt-t"><thead><tr><th>SKU</th><th>Nama</th>${d.avgMs.map((b) => `<th class="num">SO ${monShort(b)}</th>`).join('')}<th class="num">Avg (pcs)</th><th class="num">Material / pcs</th><th class="num">Pemakaian / bln</th></tr></thead><tbody>
        ${R.map((r) => `<tr><td class="mono">${esc(r.sku)}</td><td>${esc(r.name)}${r.kit ? '<small class="muted">KIT / Banded</small>' : ''}${r.old ? `<small class="lp-old">BoM lama (${esc(r.old)})</small>` : ''}</td>${r.so.map((v) => `<td class="num">${v ? n(v) : '–'}</td>`).join('')}<td class="num">${n(r.avgPcs)}</td><td class="num">${String(Math.round(r.perPcs * 1e7) / 1e7).replace('.', ',')}</td><td class="num"><b>${n(r.needM)}</b></td></tr>`).join('') || `<tr class="empty"><td colspan="${d.avgMs.length + 5}">Tidak ada SO untuk SKU pemakai material ini.</td></tr>`}
        <tr class="lt-tot"><td colspan="${d.avgMs.length + 4}">Total pemakaian per bulan</td><td class="num"><b>${n(d.use)} ${esc(d.uom)}</b></td></tr></tbody></table></div>
        ${d.rows.length > R.length ? `<p class="hint">SKU pemakai tanpa SO di periode ini: ${esc(d.rows.filter((r) => !(r.avgPcs > 0)).map((r) => r.sku).join(', '))}.</p>` : ''}`;
    }
    if (kind === 'now') {
      const x = d.now, row = (l, v, sg) => `<tr><td>${sg || ''} ${l}</td><td class="num">${n(v)}</td></tr>`;
      return `<p class="dlg-lead"><b>${esc(d.kode)}</b> ${esc(d.nama)}. Stok terkini per ${fmtDate(todayStr())}, dihitung sama seperti di Formulir PR / Plotting Harian.</p>
        <div class="table-wrap"><table class="po-table lt-t"><tbody>
        ${row(`Stok upload ${fmtDate(d.stokFrom)}`, x.awal)}${x.koreksi ? row('Koreksi stok', x.koreksi, '+') : ''}${x.gantung ? row('Stok gantung', x.gantung, '−') : ''}
        ${row(`Incoming datang ${fmtDate(d.stokFrom)} s/d hari ini`, x.incPast, '+')}${row('Pemakaian MO yang sudah jalan', x.pakaiPast, '−')}${row('ADD / FOH / RS s/d hari ini', x.addPast, '−')}
        <tr class="lt-tot"><td>= Stok terkini</td><td class="num"><b>${n(x.stok)} ${esc(d.uom)}</b></td></tr></tbody></table></div>
        <p class="hint">Stok awal di tabel (${fmtDate(d.stokDate || d.stokFrom)}) dipakai sebagai titik awal proyeksi bulan ${monLabel(d.start.slice(0, 7))}; stok terkini menunjukkan posisi hari ini.</p>`;
    }
    if (kind === 'mo') {
      return `<p class="dlg-lead"><b>${esc(d.kode)}</b> ${esc(d.nama)}. MO bulan berjalan dari Konfirmasi Produksi / Plotting Harian: yang sudah jalan sejak upload stok ${fmtDate(d.stokFrom)} + yang terjadwal sampai akhir bulan, dikali BoM MO. Dibandingkan dengan pemakaian per bulan dari rata-rata SO (${n(d.use)}).</p>
        <div class="table-wrap"><table class="po-table lt-t"><thead><tr><th>No MO</th><th>SKU</th><th>Nama</th><th>Tanggal / week</th><th class="num">Qty MO</th><th class="num">Pemakaian ${esc(d.kode)}</th><th>Status</th></tr></thead><tbody>
        ${d.moList.map((x) => `<tr><td class="mono">${esc(x.no)}</td><td class="mono">${esc(x.sku)}${x.mat ? `<small class="lp-old">BoM ${esc(x.mat)}</small>` : ''}</td><td>${esc(x.name)}</td><td>${x.tgl ? fmtDate(x.tgl) : esc(x.wk || '–')}</td><td class="num">${n(x.qtyMo)} <small class="muted">${esc(x.uomMo)}</small></td><td class="num"><b>${n(x.q)}</b></td><td>${x.past ? 'Sudah jalan' : 'Terjadwal'}</td></tr>`).join('') || '<tr class="empty"><td colspan="7">Tidak ada MO bulan ini yang memakai material ini.</td></tr>'}
        <tr class="lt-tot"><td colspan="5">Total MO bulan berjalan</td><td class="num"><b>${n(d.moNow)} ${esc(d.uom)}</b></td><td>${d.moOver === null ? '' : `${d.moOver > 0 ? '+' : ''}${d.moOver}% dari rata-rata`}</td></tr></tbody></table></div>`;
    }
    return `<p class="dlg-lead"><b>${esc(d.kode)}</b> ${esc(d.nama)}. OS PO = sisa qty jadwal PO yang belum Done (Monitoring PO). PO tanpa jadwal atau yang jadwalnya sudah lewat dihitung datang di bulan pertama proyeksi.</p>
      <div class="table-wrap"><table class="po-table lt-t"><thead><tr><th>No PO</th><th>Supplier</th><th>Tgl PO</th><th class="num">Qty PO</th><th>Jadwal datang</th><th class="num">Sisa</th></tr></thead><tbody>
      ${d.po.map((x) => `<tr><td class="mono">${esc(x.po)}${x.mat ? `<small class="lp-old">${esc(x.mat)} (lama)</small>` : ''}</td><td>${esc(x.sup || '')}</td><td>${x.tglPo ? fmtDate(x.tglPo) : '–'}</td><td class="num">${x.qtyPo ? n(x.qtyPo) : '–'} <small class="muted">${esc(x.uomPo || '')}</small></td><td>${x.d ? fmtDate(x.d) + (x.d < todayStr() ? ' <small class="pl-bad">telat</small>' : '') : '<span class="muted">tanpa jadwal</span>'}</td><td class="num"><b>${n(x.q)}</b></td></tr>`).join('') || '<tr class="empty"><td colspan="6">Tidak ada PO gantung.</td></tr>'}
      <tr class="lt-tot"><td colspan="5">Total OS PO</td><td class="num"><b>${n(d.ospo)} ${esc(d.uom)}</b></td></tr></tbody></table></div>`;
  }
  // Lampiran Perhitungan PR LT Panjang (dibekukan saat PR disimpan)
  function ltLampHtml(g, print) {
    const H = prHitungOf(g.kodePr), rows = g.rows.filter((r) => r.status !== 'Batal'), n = (v) => prNumTxt(v) || 0;
    const at = H.map((x) => x.at).filter(Boolean).sort().pop() || '';
    const blk = rows.map((r) => {
      const h = H.find((x) => x.kode === String(r.kode).trim()), d = h && h.data;
      if (!d || d.v !== 'lt') return `<div class="lp-card"><div class="lp-head"><span class="lp-code">${esc(r.kode)}</span><span class="lp-name">${esc(r.nama)}</span><span class="lp-chip is-muted">Belum ada perhitungan</span></div></div>`;
      const q = Number(d.prQty) || 0, sisa = Math.round((d.kurang + q) * 1000) / 1000;
      const sch = (d.pr || []).filter((x) => x.q > 0).map((x) => `${x.d ? fmtDate(x.d) : 'tanpa tgl'} ${n(x.q)}`).join(' · ');
      return `<div class="lp-card lt-lamp"><div class="lp-head"><span class="lp-code">${esc(d.kode)}</span><span class="lp-name">${esc(d.nama)}</span>${ltStatusHtml(d)}</div>
        ${ltDetailHtml(d)}
        <p class="lp-eqt">PR ini: <b>${n(q)} ${esc(d.uom)}</b>${sch ? ` (${esc(sch)})` : ''} · Kekurangan ${n(d.kurang)} + PR ${n(q)} = <b class="${sisa < -1e-9 ? 'pl-bad' : ''}">Sisa ${n(sisa)}</b>${d.noSo && d.noSo.length ? ` · SKU pemakai tanpa SO: ${esc(d.noSo.join(', '))}` : ''}</p></div>`;
    }).join('');
    const title = `<div class="pr-lamp-h"><b>Lampiran Perhitungan PR Lead Time Panjang</b> · ${esc(g.kodePr)}${at ? ` · dihitung ${esc(at)}` : ''}</div><p class="lp-how">Kebutuhan = rata-rata SO CSL (Personal Care + Beauty) 6 bulan penuh sebelum tanggal mulai × material per pcs (BoM aktif). Horizon = lead time + 2 bulan. Kekurangan = Stok awal + OS PO − Total pemakaian horizon. Stok pengaman = 1 bulan pemakaian; batas buka PO = perkiraan saldo di bawah stok pengaman − lead time.</p>`;
    return print ? `<section class="pr-lamp-page pr-st-page pr-hit-page lp-print">${title}${blk}</section>` : `${title}${blk}`;
  }
  function ltPrFromSaran() {
    const go = async () => {
      if (!(await mrpReady())) { toast('Data MRP tidak bisa dimuat.'); return; }
      try { await ltSoMap(); } catch (e) { toast('SO CSL tidak bisa dimuat: ' + e.message); }
      const L = (P.lt || []).filter((x) => x.aktif).map((x) => ltCalc(x.kode)).filter((d) => d && d.status !== 'green' && d.saran > 0);
      if (!L.length) { toast('Tidak ada material LT berstatus Segera buka / Siapkan PO.'); prEdit(''); return; }
      const rows = L.map((d) => Object.assign(prBlank(), { kode: d.kode, nama: d.nama, jenis: d.kat, buka: String(d.saran), stokPending: true }));
      prEdit('', rows);
    };
    go();
  }
  async function saveLt(list, msg) {
    const res = await mrpApi('saveLt', { rows: list.map((x) => [x.kode, x.lt, x.cat || '', x.aktif ? 'Y' : 'N']) });
    setLt(res.lt || []); renderLtMat(); toast(msg || 'Daftar material LT tersimpan.');
  }
  function ltDialog(i) {
    const L = P.lt || [], x = i >= 0 ? L[i] : { kode: '', lt: 3, cat: '', aktif: true };
    const opts = [...MRP.master.values()].filter((m) => rmpmOf(m.code)).map((m) => `<option value="${esc(m.code)}">${esc(m.name)}</option>`).join('');
    openDialog({
      title: i >= 0 ? `Ubah material LT ${x.kode}` : 'Tambah material LT panjang', ok: 'Simpan',
      body: `<div class="form-grid"><label class="field"><span>Kode material *</span><input name="kode" value="${esc(x.kode)}" list="ltMat" required autocomplete="off"${i >= 0 ? ' readonly' : ''}><small class="muted" id="ltNm">${esc((MRP.master.get(x.kode) || {}).name || '')}</small></label>
        <label class="field"><span>Lead time (bulan) *</span><input name="lt" type="number" step="0.5" min="0.5" value="${x.lt}" required></label>
        <label class="field full"><span>Catatan</span><input name="cat" value="${esc(x.cat)}" placeholder="mis. supplier / negara asal"></label></div><datalist id="ltMat">${opts}</datalist>
        <p class="hint">Horizon kebutuhan = lead time + 2 bulan. Stok pengaman = 1 bulan pemakaian. Batas buka PO = perkiraan saldo di bawah stok pengaman − lead time.</p>`,
      onSubmit: async (fd) => {
        const kode = String(fd.kode || '').trim(), lt = Number(fd.lt);
        if (!MRP.master.has(kode)) throw new Error(`Kode ${kode || '–'} tidak ada di Daftar Material.`);
        if (!(lt > 0)) throw new Error('Isi lead time lebih dari 0 bulan.');
        if (i < 0 && L.some((y) => y.kode === kode)) throw new Error(`${kode} sudah ada di daftar.`);
        const nx = { kode, lt, cat: String(fd.cat || '').trim(), aktif: x.aktif };
        const list = L.slice(); if (i >= 0) list[i] = nx; else list.push(nx);
        await saveLt(list, `${kode} tersimpan (lead time ${lt} bln).`);
        return '';
      },
    });
    const inp = $('dlgBody').querySelector('[name=kode]');
    inp.addEventListener('input', () => { $('ltNm').textContent = (MRP.master.get(inp.value.trim()) || {}).name || ''; });
  }
  if ($('ltAdd')) {
    $('ltAdd').addEventListener('click', () => needEdit(() => ltDialog(-1)));
    $('ltReload').addEventListener('click', async () => { LTSO.m = null; renderLtMat(); });
    $('ltQ').addEventListener('input', () => { if (P.ltView) ltPaint(); });
    $('ltGrp').addEventListener('change', () => { if (P.ltView) ltPaint(); });
    $('ltMkPr').addEventListener('click', () => { if (!state.edit.on) { toast('Masuk Mode edit dulu (PIN Monitoring PO).'); return; } location.hash = '#/prlt/rekap'; setTimeout(ltPrFromSaran, 400); });
    document.querySelector('#view-prlt-mat thead').addEventListener('click', (e) => {
      const th = e.target.closest('th[data-ltsort]'); if (!th) return;
      const k = th.dataset.ltsort, S = P.ltSort || { k: 'status', dir: 1 };
      P.ltSort = { k, dir: S.k === k ? -S.dir : 1 }; if (P.ltView) ltPaint();
    });
    $('ltRows').addEventListener('click', (e) => {
      const xb = e.target.closest('[data-ltx]');
      if (xb) { const v = (P.ltView || []).find((y) => y.i === Number(xb.dataset.lti)); if (v && v.d) openDialog({ title: `${({ use: 'Pemakaian / bulan', mo: 'MO bulan berjalan', po: 'OS PO', now: 'Stok terkini' })[xb.dataset.ltx]} · ${v.d.kode} ${v.d.nama}`, ok: 'Tutup', cancel: false, wide: true, body: ltMiniHtml(xb.dataset.ltx, v.d), onSubmit: async () => '' }); return; }
      const b = e.target.closest('[data-lted],[data-lton],[data-ltdel],[data-ltdet]'); if (!b) return;
      const L = P.lt || [];
      if (b.dataset.ltdet !== undefined) { const v = (P.ltView || []).find((y) => y.i === Number(b.dataset.ltdet)); if (v && v.d) openDialog({ title: `Rincian ${v.d.kode} · ${v.d.nama}`, ok: 'Tutup', cancel: false, wide: true, body: ltDetailHtml(v.d), onSubmit: async () => '' }); return; }
      if (b.dataset.lted !== undefined) { needEdit(() => ltDialog(Number(b.dataset.lted))); return; }
      if (b.dataset.lton !== undefined) { const i = Number(b.dataset.lton); needEdit(async () => { try { await saveLt(L.map((x, j) => (j === i ? Object.assign({}, x, { aktif: !x.aktif }) : x)), `${L[i].kode} ${L[i].aktif ? 'dinonaktifkan' : 'diaktifkan'}.`); } catch (err) { toast('Gagal: ' + err.message); } }); return; }
      const i = Number(b.dataset.ltdel), x = L[i];
      needEdit(() => openDialog({ title: `Hapus ${x.kode} dari daftar material LT?`, ok: 'Hapus', body: '<p class="dlg-lead">Material ini tidak lagi dihitung di PR LT Panjang. PR yang sudah dibuat tidak berubah.</p>', onSubmit: async () => { await saveLt(L.filter((_, j) => j !== i), `${x.kode} dihapus dari daftar.`); return ''; } }));
    });
  }
  async function mrpReady() {
    if (!MRP.loaded) await loadMrp();
    for (let i = 0; i < 150 && MRP.loading; i++) await new Promise((r) => setTimeout(r, 200));
    return MRP.loaded && P.weeks && P.weeks.length;
  }
  /* ---------- Hitungan Stok Terkini (dipakai Formulir PR, Lampiran, daftar stok kurang, Proyeksi Stok mode "Stok terkini") ----------
   * STOK TERKINI (hari ini) = Stok awal (upload stok terakhir ≤ hari ini, + koreksi − stok gantung)
   *                          + Incoming dikonfirmasi datang (tgl stok … hari ini)
   *                          − Pemakaian MO Plotting Harian bertanggal (tgl stok … hari ini)
   *                          − ADD/FOH/RS (tgl stok … hari ini)
   * KEBUTUHAN = MO Plotting Harian bulan berjalan bertanggal setelah hari ini (MO tanpa tanggal ikut di week-nya)
   *           + Plan bulan penuh untuk bulan-bulan berikutnya (bila Plan bulan kosong: Σ plan week bulan itu)
   * Produk rakitan (Banded / 2in1 / KIT) tidak dihitung. MO ekstrak tidak dihitung terpisah (sudah lewat MO FG-nya). */
  const stkCache = new Map();
  const addDay = (d, n) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  /* ---------- Suggest Produksi ---------- */
  // Kebutuhan = sisa Plan bulan berjalan (Plan − MO) + Plan bulan depan (− MO bulan depan).
  // Ketersediaan material = stok terkini − pemakaian MO terjadwal − ADD/FOH/RS mendatang, + PO incoming per tanggal.
  // Prioritas: bulan berjalan dulu, lalu rata-rata SO 6 bulan penuh terakhir (PC + Beauty) terbesar. Material yang dipakai bersama
  // dialokasikan berurutan (SKU prioritas lebih tinggi "memakai" lebih dulu). Siap = RM dan PM lengkap.
  const SG = { loadingSo: false, soErr: '' };
  const sgR3 = (x) => Math.round((Number(x) || 0) * 1000) / 1000;
  function sgCalc() {
    const B = stkBase(), today = B.today, cur = B.cur, nxt = addMonth(cur, 1), KF = konfByCell();
    const SO = LTSO.m || new Map(), avgMs = [6, 5, 4, 3, 2, 1].map((k) => addMonth(cur, -k));
    const monQ = (b, c) => { const o = P.planMon.get(`${b}|${c}`); let q = o ? o.qty : 0; if (!(q > 0)) q = sumWeekOf(b, c); return q; };
    const skip = { pcs: [], noBom: [] }, dem = [];
    [cur, nxt].forEach((b) => {
      const codes = new Set(); P.planMon.forEach((o) => { if (o.bulan === b && o.qty > 0) codes.add(o.code); }); P.plan.forEach((x) => { if (x.bulan === b && x.kg > 0) codes.add(x.code); });
      codes.forEach((c) => {
        if (kfIsEk(c)) return;
        if (planUnit(c) === 'pcs') { skip.pcs.push(c); return; }
        const plan = monQ(b, c), mo = sumKonfOf(b, c, KF), q = sgR3(plan - mo); if (!(q > 1e-6)) return;
        const so = avgMs.reduce((t, m) => t + (SO.get(c + '|' + m) || 0), 0) / 6;
        dem.push({ b, code: c, name: (P.skus.get(c) || MRP.master.get(c) || {}).name || '', plan: sgR3(plan), mo: sgR3(mo), q, so: Math.round(so) });
      });
    });
    dem.sort((a, z) => (a.b < z.b ? -1 : a.b > z.b ? 1 : 0) || z.so - a.so || z.q - a.q || a.code.localeCompare(z.code));
    // stok & PO per material (lazy)
    const SUP = new Map();
    const sup1 = (X) => {
      const pc = prCalc(X, 'all', []), stok = pc ? pc.stok : 0;
      const mo = ((B.M.get(X) || {}).mos || []).filter((m) => !m.past).reduce((t, m) => t + m.q, 0);
      const add = (P.kurang || []).filter((x) => x.code === X && x.tgl && x.tgl > today).reduce((t, x) => t + x.qty, 0);
      const arr = []; let none = 0;
      poRowsOf(X).forEach((x) => {
        let left = x.sisa;
        (x.sched || []).filter((s) => s.status !== 'Done' && s.date).sort((a, z) => (a.date < z.date ? -1 : 1)).forEach((s) => {
          const q = Math.min(left, Math.max(0, (Number(s.qty) || 0) - (Number(s.rec) || 0))); if (!(q > 0)) return;
          left -= q; arr.push({ d: s.date, q, po: x.po, late: s.date < today });
        });
        if (left > 1e-9) none += left;
      });
      return { free: stok - mo - add, arr, none };
    };
    // satu saldo per kode material (tanpa kantong gabungan) supaya stok tidak terhitung dua kali
    const supOf = (c) => { let S = SUP.get(c); if (!S) { S = Object.assign(sup1(c), { usedNow: 0, usedFut: 0 }); S.arr.sort((a, z) => (a.late !== z.late ? (a.late ? -1 : 1) : a.d < z.d ? -1 : 1)); SUP.set(c, S); } return S; };
    const nowAv = (S) => Math.max(0, S.free - S.usedNow);
    const futAv = (S) => Math.max(0, S.free - S.usedNow - S.usedFut + S.arr.reduce((t, a) => t + a.q, 0));
    const resolve = (c, sku) => { const s = (P.subs || []).find((x) => x.aktif && x.lama === c && (!x.skus.length || x.skus.includes(sku))); return !s ? [c] : s.pakai ? [c, s.baru] : [s.baru]; };
    const kindOf = (c) => rmpmOf(c) || (normU((MRP.master.get(c) || {}).kat) === 'ekstrak' ? 'RM' : '');
    const later = (a, z) => (!a ? z : !z ? a : a.late ? z : z.late ? a : a.d > z.d ? a : z);   // tanggal siap paling akhir
    const rows = [];
    dem.forEach((x, idx) => {
      const n = needOf(x.code, 1000);
      if (!n) { skip.noBom.push(x.code); return; }
      const lines = [];
      n.leaves.forEach((q, c) => { const kind = kindOf(c); if (!kind || !(q > 0)) return; const codes = resolve(c, x.code); lines.push({ c: codes[codes.length - 1], codes, orig: c, kind, r: q / 1000 }); });
      const res = lines.map((L) => {
        // pengganti dengan "pakai stok lama": stok LAMA dulu, kekurangannya dari BARU (codes = [lama, baru])
        const SS = L.codes.map(supOf), need = L.r * x.q, av = SS.reduce((t, S) => t + nowAv(S), 0);
        const net = SS.map((S) => S.free - S.usedNow - S.usedFut), tot = () => net.reduce((t, v) => t + Math.max(0, v), 0);
        let ready = null;
        if (tot() >= need - 1e-9) ready = { now: true };
        else {
          const ev = SS.flatMap((S, k) => S.arr.map((a2) => Object.assign({ k }, a2))).sort((a2, z) => (a2.late !== z.late ? (a2.late ? -1 : 1) : a2.d < z.d ? -1 : a2.d > z.d ? 1 : 0));
          for (const e of ev) { net[e.k] += e.q; if (tot() >= need - 1e-9) { ready = e; break; } }
        }
        return Object.assign(L, { SS, need, av, cap: L.r > 0 ? av / L.r : Infinity, ready, kurang: Math.max(0, need - av) });
      });
      const capOf = (k) => Math.min(Infinity, ...res.filter((L) => L.kind === k).map((L) => L.cap));
      const capRM = capOf('RM'), capPM = capOf('PM'), now = sgR3(Math.min(x.q, capRM, capPM));
      const rmOk = capRM >= x.q - 1e-6, pmOk = capPM >= x.q - 1e-6;
      const shortL = (k) => res.filter((L) => L.kind === k && L.kurang > Math.max(1e-6, L.need * 1e-4)).sort((a, z) => z.kurang / (z.need || 1) - a.kurang / (a.need || 1));
      const readyAll = (k) => { const L = res.filter((y) => (!k || y.kind === k) && y.kurang > 1e-6); if (L.some((y) => !y.ready)) return null; return L.reduce((t, y) => later(t, y.ready), null); };
      const st = rmOk && pmOk ? 'siap' : now > 1e-6 ? 'sebagian' : !rmOk ? 'rm' : 'pm';
      const rAll = st === 'siap' ? null : readyAll('');
      // stok sekarang hanya terpakai sebesar yang bisa diproduksi sekarang; sisanya mengklaim PO yang akan datang
      res.forEach((L) => {
        let a = L.r * now, f = L.need - a;
        L.SS.forEach((S, k) => { const last = k === L.SS.length - 1;
          const tn = last ? a : Math.min(a, nowAv(S)); S.usedNow += tn; a -= tn;
          const tf = last ? f : Math.min(f, futAv(S)); S.usedFut += tf; f -= tf; });
      });
      rows.push(Object.assign({}, x, { prio: idx + 1, now, rmOk, pmOk, capRM: sgR3(Math.min(x.q, capRM)), st, rmShort: shortL('RM'), pmShort: shortL('PM'), rAll, nMat: res.length }));
    });
    rows.forEach((r, i) => { r.prio = i + 1; });
    return { rows, cur, nxt, skip, avgMs, B };
  }
  const sgWhen = (a) => (!a ? 'belum ada PO yang cukup' : a.now ? 'stok cukup' : a.late ? `cukup setelah ${a.po} datang (terlambat, jadwal ${fmtDate(a.d)})` : `cukup ${fmtDate(a.d)} (${a.po})`);
  const sgWhenAll = (a) => (!a ? 'sisanya menunggu PO material (belum ada PO yang cukup)' : a.late ? `lengkap setelah ${a.po} datang (terlambat, jadwal ${fmtDate(a.d)})` : `lengkap ${fmtDate(a.d)} setelah ${a.po} datang`);
  const SG_ST = { siap: ['Siap produksi', 'sg-ok'], sebagian: ['Bisa sebagian', 'sg-part'], pm: ['RM lengkap, PM kurang', 'sg-pm'], rm: ['RM kurang', 'sg-rm'] };
  function sgSaran(r) {
    const kg = (v) => `${fmtNum(sgR3(v))} kg`;
    if (r.st === 'siap') return `Siap produksi ${kg(r.q)}`;
    const rest = sgWhenAll(r.rAll);
    if (r.st === 'sebagian') return `Bisa ${kg(r.now)} dari ${kg(r.q)} sekarang; sisa ${kg(r.q - r.now)} ${rest}`;
    if (r.st === 'pm') return `Belum bisa: RM cukup untuk ${kg(r.q)}, PM kurang; ${rest}`;
    return `Belum bisa: RM ${r.capRM > 1e-6 ? `cukup untuk ${kg(r.capRM)} dari ${kg(r.q)}` : 'kurang'}; ${rest}`;
  }
  const sgMatTxt = (L) => { const m = MRP.master.get(L.c) || {}; return { code: L.c, name: m.name || '', uom: m.uom || '', kurang: sgR3(L.kurang), when: sgWhen(L.ready), sub: L.orig !== L.c ? L.orig : '' }; };
  function sgFiltered(R) {
    const mon = $('sgMon').value, st = $('sgSt').value, q = $('sgQ').value.trim().toLowerCase();
    return R.rows.filter((r) => (!mon || r.b === mon) && (!st || r.st === st)
      && (!q || `${r.code} ${r.name} ${[...r.rmShort, ...r.pmShort].map((L) => L.c).join(' ')}`.toLowerCase().includes(q)));
  }
  function renderSuggest() {
    if (!$('sgRows')) return;
    if (!LTSO.m && !SG.loadingSo) {
      SG.loadingSo = true; $('sgSum').innerHTML = '<span class="muted">Memuat SO dari CSL untuk urutan prioritas…</span>';
      ltSoMap().then(() => { SG.soErr = (LTSO.errs || []).join('; '); }).catch((e) => { SG.soErr = e.message; LTSO.m = new Map(); LTSO.at = Date.now(); })
        .finally(() => { SG.loadingSo = false; if (state.routeKey === 'mrp/suggest') renderSuggest(); });
      return;
    }
    if (SG.loadingSo) return;
    const R = sgCalc(); SG.R = R;
    const sel = $('sgMon'), keep = sel.value;
    sel.innerHTML = `<option value="">${esc(monLabel(R.cur))} + ${esc(monLabel(R.nxt))}</option><option value="${R.cur}">Sisa ${esc(monLabel(R.cur))}</option><option value="${R.nxt}">${esc(monLabel(R.nxt))}</option>`;
    sel.value = [R.cur, R.nxt].includes(keep) ? keep : '';
    const V = sgFiltered(R), cnt = (k) => V.filter((r) => r.st === k).length;
    $('sgSum').innerHTML = ['siap', 'sebagian', 'pm', 'rm'].map((k) => `<span class="sg-chip ${SG_ST[k][1]}"><b>${cnt(k)}</b> ${SG_ST[k][0]}</span>`).join('') + `<span class="muted">${V.length} SKU</span>`;
    const matCell = (ok, L, kind) => ok ? `<span class="sg-ok-t">✔ ${kind} lengkap</span>` : `<ul class="sg-ml">${L.map((x) => { const t = sgMatTxt(x); return `<li><b>${esc(t.code)}</b> ${esc(t.name)}${t.sub ? ` <small class="muted">(pengganti ${esc(t.sub)})</small>` : ''}<small>kurang ${fmtQ(t.kurang)} ${esc(t.uom)} · ${esc(t.when)}</small></li>`; }).join('')}</ul>`;
    $('sgRows').innerHTML = V.length ? V.map((r) => `<tr><td class="num">${r.prio}</td><td><b>${esc(r.code)}</b><small class="muted sg-nm">${esc(r.name)}</small></td>
      <td>${r.b === R.cur ? `Sisa ${esc(monShort(r.b))}` : esc(monShort(r.b))}<small class="muted">plan ${fmtQ(r.plan)} · MO ${fmtQ(r.mo)}</small></td>
      <td class="num">${r.so ? fmtNum(r.so) + ' pcs' : '<span class="muted">–</span>'}</td><td class="num"><b>${fmtQ(r.q)}</b> kg</td>
      <td class="num">${r.now > 1e-6 ? fmtQ(r.now) + ' kg' : '<span class="muted">0</span>'}</td>
      <td>${matCell(r.rmOk, r.rmShort, 'RM')}</td><td>${r.rmOk ? matCell(r.pmOk, r.pmShort, 'PM') : r.pmOk ? '<span class="sg-ok-t">✔ PM lengkap</span>' : matCell(false, r.pmShort, 'PM')}</td>
      <td><span class="sg-st ${SG_ST[r.st][1]}">${SG_ST[r.st][0]}</span><small>${esc(sgSaran(r))}</small></td></tr>`).join('')
      : `<tr class="empty"><td colspan="9">${R.rows.length ? 'Tidak ada SKU untuk filter ini.' : `Tidak ada sisa Plan bulan ${esc(monLabel(R.cur))} maupun Plan ${esc(monLabel(R.nxt))}.`}</td></tr>`;
    const notes = [`Rata SO = rata-rata SO ${monShort(R.avgMs[0])}–${monShort(R.avgMs[5])} ${R.avgMs[5].slice(0, 4)} (PC + Beauty, dikurangi batal).`, 'Kebutuhan tidak dibulatkan ke ukuran batch.', 'PO terlambat dihitung sebagai yang paling dulu datang; PO tanpa jadwal tidak dihitung.'];
    if (SG.soErr) notes.push(`SO belum lengkap (${SG.soErr}); urutan prioritas memakai kebutuhan kg.`);
    if (R.skip.pcs.length) notes.push(`${new Set(R.skip.pcs).size} produk Banded/2in1/KIT (rencana dalam pcs) tidak dihitung.`);
    if (R.skip.noBom.length) notes.push(`Tanpa BoM aktif: ${[...new Set(R.skip.noBom)].join(', ')}.`);
    $('sgNote').textContent = notes.join(' ');
    $('sgPdf').disabled = $('sgXls').disabled = !V.length;
  }
  ['sgQ', 'sgMon', 'sgSt'].forEach((id) => $(id).addEventListener(id === 'sgQ' ? 'input' : 'change', renderSuggest));
  const sgMatPlain = (ok, L, kind) => (ok ? `${kind} lengkap` : L.map((x) => { const t = sgMatTxt(x); return `${t.code} ${t.name}${t.sub ? ' (pengganti ' + t.sub + ')' : ''}: kurang ${fmtNum(t.kurang)} ${t.uom}, ${t.when}`; }).join('\n'));
  $('sgXls').addEventListener('click', () => {
    const R = SG.R; if (!R) return;
    const data = sgFiltered(R).map((r) => ({ Prio: r.prio, SKU: r.code, Nama: r.name, Bulan: r.b === R.cur ? 'Sisa ' + monLabel(r.b) : monLabel(r.b), 'Plan (kg)': r.plan, 'MO (kg)': r.mo, 'Kebutuhan (kg)': r.q,
      'Rata SO / bln (pcs)': r.so, 'Bisa sekarang (kg)': r.now, Status: SG_ST[r.st][0], RM: sgMatPlain(r.rmOk, r.rmShort, 'RM'), PM: sgMatPlain(r.pmOk, r.pmShort, 'PM'), Saran: sgSaran(r) }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Suggest Produksi');
    XLSX.writeFile(wb, `Suggest_Produksi_${todayStr()}.xlsx`);
  });
  $('sgPdf').addEventListener('click', async () => {
    const R = SG.R; if (!R) return; const V = sgFiltered(R); if (!V.length) return;
    const btn = $('sgPdf'), lbl = btn.textContent; btn.disabled = true; btn.textContent = 'Menyiapkan PDF…';
    try {
      const JsPDF = await loadPdfLib(), doc = new JsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' }), now = new Date(), W = doc.internal.pageSize.getWidth(), M = 10;
      const t = (v) => String(v == null ? '' : v).replace(/[–—]/g, '-').replace(/✔/g, '');
      const cnt = (k) => V.filter((r) => r.st === k).length;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.text('Suggest Produksi', M, 15);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
      doc.text(t(`${$('sgMon').selectedOptions[0].textContent} · ${['siap', 'sebagian', 'pm', 'rm'].map((k) => `${cnt(k)} ${SG_ST[k][0]}`).join(' · ')}`), M, 20.5);
      doc.text(t(`Dicetak ${fuStamp(now)} · stok per ${fmtDate(R.B.d0)}`), W - M, 15, { align: 'right' });
      doc.setLineWidth(0.5); doc.line(M, 23, W - M, 23);
      const col = { siap: [31, 107, 53], sebagian: [176, 120, 20], pm: [176, 90, 20], rm: [192, 57, 43] };
      doc.autoTable({
        startY: 27, margin: { left: M, right: M, bottom: 12 }, theme: 'plain',
        head: [['Prio', 'SKU', 'Bulan', 'Rata SO/bln', 'Kebutuhan', 'Bisa sekarang', 'RM', 'PM', 'Saran']],
        body: V.map((r) => [String(r.prio), `${r.code}\n${r.name}`, r.b === R.cur ? 'Sisa ' + monShort(r.b) : monShort(r.b), r.so ? fmtNum(r.so) + ' pcs' : '-', fmtNum(r.q) + ' kg', r.now > 1e-6 ? fmtNum(r.now) + ' kg' : '0',
          sgMatPlain(r.rmOk, r.rmShort, 'RM'), r.rmOk ? sgMatPlain(r.pmOk, r.pmShort, 'PM') : (r.pmOk ? 'PM lengkap' : sgMatPlain(false, r.pmShort, 'PM')), `${SG_ST[r.st][0]}\n${sgSaran(r)}`].map(t)),
        styles: { font: 'helvetica', fontSize: 7.5, cellPadding: { top: 1.5, bottom: 1.5, left: 1.4, right: 1.4 }, lineColor: [205, 205, 205], lineWidth: { bottom: 0.2 }, valign: 'top' },
        headStyles: { fontStyle: 'bold', textColor: [70, 70, 70], fillColor: [240, 242, 240], lineWidth: { bottom: 0.4 }, lineColor: [60, 60, 60] },
        columnStyles: { 0: { cellWidth: 10, halign: 'right' }, 1: { cellWidth: 40 }, 2: { cellWidth: 16 }, 3: { cellWidth: 19, halign: 'right' }, 4: { cellWidth: 19, halign: 'right' }, 5: { cellWidth: 19, halign: 'right' }, 6: { cellWidth: 'auto' }, 7: { cellWidth: 'auto' }, 8: { cellWidth: 52 } },
        didParseCell: (d) => { if (d.section === 'head' && [0, 3, 4, 5].includes(d.column.index)) d.cell.styles.halign = 'right'; if (d.section === 'body' && d.column.index === 8) { d.cell.styles.textColor = col[V[d.row.index].st]; } },
      });
      const n = doc.internal.getNumberOfPages();
      for (let i = 1; i <= n; i++) { doc.setPage(i); doc.setFontSize(8); doc.setTextColor(120); doc.text(`Halaman ${i} dari ${n}`, W - M, doc.internal.pageSize.getHeight() - 6, { align: 'right' }); }
      doc.save(`Suggest-Produksi-${ymd(now)}.pdf`);
    } catch (e) { toast(e.message || String(e)); } finally { btn.disabled = false; btn.textContent = lbl; }
  });
  function stkBase() {
    const today = todayStr();
    const key = today + '|' + Math.floor(Date.now() / 60000) + '|' + P.konf.size + '|' + P.plan.size + '|' + P.planMon.size + '|' + P.stockDate + '|' + (P.kurang || []).length + '|' + (P.incK || []).length + '|' + P.adj.length;
    if (stkCache.has(key)) return stkCache.get(key);
    const cur = today.slice(0, 7), tm = addDay(today, 1);
    const dates = [...(P.stockHist || new Map()).keys()].filter((d) => d <= today).sort();
    const d0 = dates.pop() || P.stockDate || today;
    // Kolom kebutuhan: week bulan berjalan yang belum selesai (mulai besok), lalu satu kolom per bulan berikutnya s/d MPS berakhir
    const W = P.weeks.slice().sort((a, b) => (a.start < b.start ? -1 : 1));
    const cols = [];
    W.filter((w) => w.bulan === cur && w.end >= tm).forEach((w) => cols.push({ kind: 'w', bulan: w.bulan, week: w.week, d: w.start < tm ? tm : w.start, de: w.end, l: `${w.week} ${monShort(w.bulan)}${w.start < tm ? ' (sisa)' : ''}`, part: w.start < tm }));
    const later = new Set(); P.planMon.forEach((o) => { if (o.bulan > cur && o.qty > 0) later.add(o.bulan); }); P.plan.forEach((x) => { if (x.bulan > cur && x.kg > 0) later.add(x.bulan); });
    [...later].sort().forEach((b) => { const L = (P.monthWeeks && P.monthWeeks.get(b)) || []; if (!L.length) return; cols.push({ kind: 'm', bulan: b, d: L[0].start, de: L[L.length - 1].end, l: `${monShort(b)} ${b.slice(2, 4)}`, lf: monLabel(b) }); });
    if (!cols.length) { const L = (P.monthWeeks && P.monthWeeks.get(cur)) || []; const de = L.length ? L[L.length - 1].end : today; cols.push({ kind: 'w', bulan: cur, week: '', d: tm, de: de < tm ? tm : de, l: 'Sisa bulan ini', part: true }); }
    const n = cols.length, end = cols[n - 1].de;
    const colOfDate = (d) => { if (!d) return -1; for (let i = 0; i < n; i++) if (d >= cols[i].d && d <= cols[i].de) return i; return d < cols[0].d ? -2 : -3; };
    // Pemakaian material per material: past (sebelum/sama dengan hari ini) + per kolom; sumber per SKU
    const M = new Map(), mk = (c) => { let o = M.get(c); if (!o) { o = { past: 0, w: new Array(n).fill(0), sku: new Map(), skuW: new Map(), mos: [] }; M.set(c, o); } return o; };
    const pushNeed = (code, qty, bomId, at, ref) => {
      const r = needOf(code, qty, bomId); if (!r) return false;
      r.leaves.forEach((q, c) => {
        const o = mk(c);
        if (at < 0) { o.past += q; o.mos.push({ ref, sku: code, q, past: true }); }
        else { o.w[at] += q; o.sku.set(code, (o.sku.get(code) || 0) + q); if (!o.skuW.has(code)) o.skuW.set(code, new Array(n).fill(0)); o.skuW.get(code)[at] += q; if (ref) o.mos.push({ ref, sku: code, q, i: at }); }
      });
      return true;
    };
    const info = { moPast: 0, moFut: 0, moNoDate: [], moSkip: 0, monFallback: [], monPlan: [], noBom: new Set() };
    (P.konf || new Map()).forEach((r) => {
      if (kfIsEk(r.code)) return;
      if (planUnit(r.code) === 'pcs') { info.moSkip++; return; }   // Banded / 2in1 / KIT: diabaikan
      const q = Number(r.kg) || 0; if (!(q > 0)) return;
      const t = r.tgl || '';
      if (t && t >= d0 && t <= today) { if (pushNeed(r.code, q, r.bom || undefined, -1, r.no)) info.moPast++; else info.noBom.add(r.code); return; }
      if (t && t < d0) return;
      // belum berjalan: hanya MO bulan berjalan (bulan berikutnya memakai Plan bulan)
      let i = -1;
      if (t) { if (t.slice(0, 7) > cur && r.bulan !== cur) return; i = colOfDate(t); if (i < 0 || cols[i].kind !== 'w') { const j = cols.findIndex((c) => c.kind === 'w' && c.week === r.week && c.bulan === r.bulan); i = j; } }
      else { if (r.bulan !== cur) return; i = cols.findIndex((c) => c.kind === 'w' && c.week === r.week && c.bulan === r.bulan); if (i < 0) i = 0; info.moNoDate.push(r.no); }
      if (i < 0) return;
      if (pushNeed(r.code, q, r.bom || undefined, i, r.no)) info.moFut++; else info.noBom.add(r.code);
    });
    cols.forEach((c, i) => {
      if (c.kind !== 'm') return;
      const codes = new Set(); P.planMon.forEach((o) => { if (o.bulan === c.bulan && o.qty > 0) codes.add(o.code); }); P.plan.forEach((x) => { if (x.bulan === c.bulan && x.kg > 0) codes.add(x.code); });
      codes.forEach((code) => {
        if (planUnit(code) === 'pcs') return;
        const pm = P.planMon.get(`${c.bulan}|${code}`); let q = pm ? pm.qty : 0;
        if (!(q > 0)) { q = 0; P.plan.forEach((x) => { if (x.bulan === c.bulan && x.code === code) q += x.kg; }); if (q > 0) info.monFallback.push(`${code} ${monShort(c.bulan)}`); }
        if (q > 0) { if (pushNeed(code, q, undefined, i, '')) info.monPlan.push(code); else info.noBom.add(code); }
      });
    });
    const o = { today, tm, d0, cur, cols, n, end, colOfDate, M, info };
    stkCache.clear(); stkCache.set(key, o);
    return o;
  }
  // PO outstanding per kode material (indeks dibangun ulang bila data PO berubah)
  let poIdx = { rows: null, map: null };
  function poRowsOf(kode) {
    if (poIdx.rows !== state.rows) {
      const map = new Map();
      (state.rows || []).forEach((x) => { if (x.cancel || x.takeout || !(x.sisa > 1e-9)) return; if (!map.has(x.code)) map.set(x.code, []); map.get(x.code).push(x); });
      poIdx = { rows: state.rows, map };
    }
    return poIdx.map.get(kode) || [];
  }
  // sched: [{d, q}] jadwal datang PR ini (Tgl Kirim / split)
  // opt.pool: material pengganti (hanya perhitungan PR) — kebutuhan, stok, dan OS PO material lama digabung ke material baru
  function prCalc(kode, hz, sched, opt) {
    kode = String(kode || '').trim(); if (!kode) return null;
    const B = stkBase(), { today, d0, cols: C0, n, end, colOfDate } = B;
    const m = MRP.master.get(kode) || {};
    const sh = (P.stockHist || new Map()).get(d0), st = sh ? sh.get(kode) : null;
    const R3 = (x) => Math.round((Number(x) || 0) * 1000) / 1000;
    const pool = opt && opt.pool ? subOldsOf(kode) : [];
    const full = pool.filter((x) => !x.skus.length), partO = pool.filter((x) => x.skus.length);
    const part = opt && opt.pool ? subPartOf(kode) : null;                        // kode = material lama yang berganti untuk SKU tertentu
    const KA = new Set([kode, ...full.map((x) => x.lama)]);                       // kebutuhan: semua SKU
    const KS = new Set([kode, ...full.filter((x) => x.pakai).map((x) => x.lama)]); // stok & PO: lama hanya bila stok lama dipakai
    const skuNeed = (c, skus, i) => { const o = B.M.get(c); return o ? skus.reduce((t, k) => t + ((o.skuW.get(k) || [])[i] || 0), 0) : 0; };
    const mms = [...KA].map((c) => B.M.get(c)).filter(Boolean), mmS = [...KS].map((c) => B.M.get(c)).filter(Boolean);
    const anyNeed = mms.length || partO.some((x) => B.M.get(x.lama));
    const mm = anyNeed ? { past: mmS.reduce((t, o) => t + o.past, 0), w: C0.map((_, i) => mms.reduce((t, o) => t + o.w[i], 0) - (part ? skuNeed(kode, part.skus, i) : 0) + partO.reduce((t, x) => t + skuNeed(x.lama, x.skus, i), 0)) } : null;
    // berganti untuk SKU tertentu: stok lama yang dipakai = sisa setelah kebutuhan SKU yang tidak berganti (stok + OS PO − kebutuhan itu)
    // bila material lama yang sama punya beberapa pengganti (SKU berbeda), sisa stok lama dibagi sebanding kebutuhan SKU yang berganti
    const swNeed = (x) => C0.reduce((t, _, i) => t + skuNeed(x.lama, x.skus, i), 0);
    const lumps = partO.filter((x) => x.pakai).map((x) => {
      const r = prCalc(x.lama, hz, [], { pool: true }), rem = r ? Math.max(0, r.kurang) : 0;
      const sib = (P.subs || []).filter((y) => y.aktif && y.pakai && y.lama === x.lama && y.skus.length);
      const tot = sib.reduce((t, y) => t + swNeed(y), 0), share = sib.length < 2 ? 1 : tot > 1e-9 ? swNeed(x) / tot : 1 / sib.length;
      return { kode: x.lama, q: rem * share, share };
    });
    const lump = lumps.reduce((t, x) => t + x.q, 0);
    const cols = C0.map((c, i) => ({ l: c.l, lf: c.lf || '', kind: c.kind, d: c.d, de: c.de, need: mm ? mm.w[i] : 0, inc: 0, po: 0, poS: 0, poL: 0, poN: 0, add: 0, sal: 0 }));
    // Stok terkini
    const awal = R3([...KS].reduce((t, c) => { const x = sh ? sh.get(c) : null; return t + (x ? x.qty : 0); }, 0));
    const koreksi = R3(P.adj.filter((a) => KS.has(a.code) && a.date >= d0).reduce((t, a) => t + a.qty, 0));
    const gantung = R3([...KS].reduce((t, c) => t + ((P.gantung && P.gantung.get(c)) || 0), 0));
    let incPast = 0, addPast = 0;
    (P.incK || []).forEach((x) => { const d = x.datang || x.tgl; if (KS.has(x.code) && d && d >= d0 && d <= today) incPast += x.qty; });
    (P.kurang || []).forEach((x) => {
      if (!KA.has(x.code) || !x.tgl) return;
      if (x.tgl >= d0 && x.tgl <= today) { if (KS.has(x.code)) addPast += x.qty; }
      else if (x.tgl > today) { const i = colOfDate(x.tgl); if (i >= 0) cols[i].add += x.qty; }
    });
    const pakaiPast = R3(mm ? mm.past : 0);
    const stok = R3(awal + koreksi - gantung + incPast - pakaiPast - addPast + lump);
    // OS PO
    let poLate = 0, poNone = 0, poAfter = 0; const after = [], lateL = [];
    [...KS].flatMap((c) => poRowsOf(c)).forEach((x) => {
      let left = x.sisa;
      (x.sched || []).filter((s) => s.status !== 'Done' && s.date).sort((a, b) => (a.date < b.date ? -1 : 1)).forEach((s) => {
        const q = Math.min(left, Math.max(0, (Number(s.qty) || 0) - (Number(s.rec) || 0))); if (!(q > 0)) return;
        left -= q;
        if (s.date < today) { poLate += q; lateL.push({ po: x.po, d: s.date, q: R3(q) }); }
        else if (s.date > end) { poAfter += q; after.push({ po: x.po, d: s.date, q: R3(q) }); }
        else { const i = colOfDate(s.date); cols[i >= 0 ? i : 0].poS += q; }
      });
      if (left > 1e-9) poNone += left;
    });
    let run = stok;
    cols.forEach((c) => { c.need = R3(c.need); c.poS = R3(c.poS); c.po = c.poS; c.add = R3(c.add); run += c.po - c.need - c.add; c.sal = R3(run); });
    const sum = (k) => R3(cols.reduce((t, c) => t + c[k], 0));
    const out = { v: 3, kode, nama: m.name || (st && st.name) || '', uom: m.uom || (st && st.uom) || '', at: today, stokDate: d0,
      awal, koreksi, gantung, incPast: R3(incPast), pakaiPast, addPast: R3(addPast), stok, inc: 0,
      ospo: R3(sum('po') + poLate + poNone + poAfter), poLate: R3(poLate), poNone: R3(poNone), poIn: sum('poS'), poAfter: R3(poAfter), after: after.sort((a, b) => (a.d < b.d ? -1 : 1)), late: lateL,
      salEnd: R3(run + poLate + poNone + poAfter), split: 2, butuh: sum('need'), add: sum('add'), cols, last: cols[n - 1].lf || cols[n - 1].l,
      note: mm && (mm.past || mm.w.some((x) => x)) ? '' : 'Tidak ada pemakaian di MO Plotting Harian maupun Plan bulan.' };
    out.kurang = R3(out.stok + out.ospo - out.butuh - out.add);
    if (pool.length) {
      // rincian per material untuk lampiran (dihitung sendiri-sendiri, tanpa penggabungan)
      const one = (c, pakai, skus) => { const x = prCalc(c, hz, []); const mx = MRP.master.get(c) || {}; const o = { kode: c, nama: (mx.name || (x && x.nama) || '').slice(0, 60), pakai, stok: x ? x.stok : 0, butuh: x ? R3(x.butuh + x.add) : 0, ospo: x ? x.ospo : 0 };
        if (skus && skus.length) { o.skus = skus; o.butuh = R3(C0.reduce((t, _, i) => t + skuNeed(c, skus, i), 0)); const l = lumps.find((y) => y.kode === c); o.sisa = l ? R3(l.q) : 0; if (l && l.share < 1) o.share = Math.round(l.share * 1000) / 10; }
        return o; };
      out.subs = pool.map((x) => one(x.lama, x.pakai, x.skus)); out.subSelf = one(kode, true); if (lump) out.subLump = R3(lump);
    }
    if (part) {
      out.subPart = { baru: part.baru, skus: part.skus, butuh: R3(C0.reduce((t, _, i) => t + skuNeed(kode, part.skus, i), 0)) };
    }
    const neg = cols.find((c) => c.sal < -1e-9); out.minus = neg ? (neg.lf || neg.l) : ''; out.deep = Math.min(0, ...cols.map((c) => c.sal));
    out.minusNoLN = !!(neg && (poLate + poNone) > 1e-9 && out.deep + poLate + poNone >= -1e-9);
    const S = (sched || []).filter((x) => x.q > 0);
    if (S.length) {
      const add = cols.map(() => 0); let beyond = 0;
      S.forEach((x) => { const d = x.d || today; if (d > end) { beyond += x.q; return; } const i = colOfDate(d); add[i >= 0 ? i : 0] += x.q; });
      let cum = 0; out.pr = add; out.prSal = cols.map((c, i) => { cum += add[i]; return R3(c.sal + cum); });
      out.prQty = R3(S.reduce((t, x) => t + x.q, 0)); out.prBeyond = R3(beyond);
      const fa = add.findIndex((x) => x > 0); out.prFirst = fa >= 0 ? cols[fa].l : '';
      out.prDeepAfter = fa >= 0 ? Math.min(0, ...out.prSal.slice(fa)) : Math.min(0, ...out.prSal); out.prDeepBefore = fa > 0 ? Math.min(0, ...out.prSal.slice(0, fa)) : 0;
    }
    return out;
  }
  // Produk yang memakai material (BoM aktif tiap SKU, lewat ekstrak/bulk) + kebutuhannya di rentang Stok Terkini
  const useMemo = { key: '', map: null };
  function matUsers(kode) {
    const key = P.skus.size + '|' + MRP.byProduct.size;
    if (useMemo.key !== key) {
      const map = new Map();
      P.skus.forEach((k) => {
        if (!k.aktif || k.jenis === 'Ekstrak' || planUnit(k.code) === 'pcs') return;
        const r = needOf(k.code, 1000); if (!r) return;
        const pcs = normU(r.bom.uom) === 'kg' ? 0 : r.bom.batch;   // pcs per 1.000 kg
        r.leaves.forEach((q, c) => { if (!map.has(c)) map.set(c, []); map.get(c).push({ sku: k.code, name: k.name, bom: refOf(r.bom), perTon: q, perPcs: pcs ? q / pcs : 0 }); });
      });
      useMemo.key = key; useMemo.map = map;
    }
    return useMemo.map.get(String(kode || '').trim()) || [];
  }
  // Sell In (DO Delivered CSL Personal Care + Beauty) per kode per bulan
  async function sellInMap() {
    if (!window.CSL || !window.CSL.doOut) throw new Error('Data CSL tidak tersedia.');
    const out = new Map(), errs = [];
    for (const seg of ['pc', 'beauty']) {
      try { const r = await window.CSL.doOut(seg); (r.lines || []).forEach(([k, d, q]) => { const key = k + '|' + d.slice(0, 7); out.set(key, (out.get(key) || 0) + q); }); }
      catch (e) { errs.push(`${seg === 'pc' ? 'Personal Care' : 'Beauty'}: ${e.message}`); }
    }
    return { m: out, errs };
  }
  function prUseData(kode, SI) {
    const B = stkBase();
    const cur = B.today.slice(0, 7), months = [3, 2, 1].map((k) => addMonth(cur, -k));
    // material pengganti: produk pemakai material lama ikut ditampilkan (ditandai BoM lama)
    const olds = subOldsOf(kode), part = subPartOf(kode), codes = [kode, ...olds.map((x) => x.lama)];
    const skuOk = (c, sku) => { if (c === kode) return !(part && part.skus.includes(sku)); const x = olds.find((y) => y.lama === c); return !x || !x.skus.length || x.skus.includes(sku); };
    const tot = codes.reduce((t, c) => { const o = B.M.get(c); if (!o) return t; let v = 0; o.sku.forEach((q, sku) => { if (skuOk(c, sku)) v += q; }); return t + v; }, 0);
    const L = codes.flatMap((c) => matUsers(c).filter((u) => skuOk(c, u.sku)).map((u) => Object.assign({}, u, { mat: c })));
    // SKU dengan kebutuhan dari MO / plan yang BoM-nya beda dengan BoM aktif tetap dihitung kebutuhannya
    if (codes.length > 1) codes.forEach((c) => { const o = B.M.get(c); if (o) o.sku.forEach((q, sku) => { if (skuOk(c, sku) && !L.some((u) => u.sku === sku)) { const k = P.skus.get(sku) || {}; L.push({ sku, name: k.name || (MRP.master.get(sku) || {}).name || sku, bom: 'BoM MO/plan', perTon: 0, perPcs: 0, mat: c }); } }); });
    const rows = L.map((u) => {
      const mo = B.M.get(u.mat), need = mo ? mo.sku.get(u.sku) || 0 : 0;
      const sell = months.map((b) => (SI ? Math.round(SI.m.get(u.sku + '|' + b) || 0) : null));
      const avg = SI ? sell.reduce((t, x) => t + x, 0) / 3 : null;
      return { sku: u.sku, name: u.name, bom: u.bom, old: u.mat !== kode ? u.mat : undefined, perTon: Math.round(u.perTon * 1e6) / 1e6, perPcs: u.perPcs, need: Math.round(need * 1000) / 1000, share: tot ? need / tot : 0, sell, avg: avg === null ? null : Math.round(avg), setara: avg && u.perPcs ? Math.round(avg * u.perPcs * 1000) / 1000 : null };
    }).filter((x) => x.need > 0 || (x.avg || 0) > 0).sort((a, b) => b.need - a.need || (b.avg || 0) - (a.avg || 0) || b.perTon - a.perTon || a.sku.localeCompare(b.sku));
    // dibekukan di satu sel Google Sheet (maks ±49.000 karakter): ringkas & batasi 30 produk teratas
    const top = rows.slice(0, 30).map((x) => Object.assign(x, { name: x.name.length > 48 ? x.name.slice(0, 47) + '…' : x.name, share: Math.round(x.share * 1000) / 1000, perPcs: undefined }));
    // produk tanpa kebutuhan & tanpa Sell In sudah dibuang di atas
    return { months, rows: top, more: Math.max(0, rows.length - top.length), tot: Math.round(tot * 1000) / 1000, err: SI ? (SI.errs || []).join('; ') : 'Sell In tidak bisa dimuat.' };
  }
  const prSchedOf = (r) => { const L = r.sched || prSched(r.kirim); const bk = Number(prNum(r.buka)) || 0; return L ? L.map((x) => ({ d: x.d, q: Number(x.q) || 0 })) : bk ? [{ d: r.kirim || '', q: bk }] : []; };
  function setPrHitung(list) {
    state.prHitung = (list || []).map((r) => { let d = {}; try { d = JSON.parse(r[3] || '{}'); } catch (e) { d = {}; } return { kodePr: r[0], kode: r[1], hz: r[2], data: d, at: r[4] }; });
  }
  const prHitungOf = (kodePr) => (state.prHitung || []).filter((x) => x.kodePr === kodePr);
  function prHitungHtml(g, print) {
    if (isLtPr(g.kodePr)) return ltLampHtml(g, print);
    const H = prHitungOf(g.kodePr), rows = g.rows.filter((r) => r.status !== 'Batal');
    const at = H.map((x) => x.at).filter(Boolean).sort().pop() || '';
    const f = (v) => (Math.abs(Number(v) || 0) < 0.0005 ? '–' : prNumTxt(v));
    const R3h = (x) => Math.round((Number(x) || 0) * 1000) / 1000;
    const nz = (v) => Math.abs(Number(v) || 0) > 1e-9;
    const blk = rows.map((r) => {
      const h = H.find((x) => x.kode === String(r.kode).trim()), d = h && h.data;
      if (!d || !d.cols || d.butuh === undefined) return `<div class="lp-card"><div class="lp-head"><span class="lp-code">${esc(r.kode)}</span><span class="lp-name">${esc(r.nama)}</span><span class="lp-chip is-muted">Belum dihitung</span></div><p class="lp-empty">Perhitungan belum dibekukan. Klik "Perbarui lampiran".</p></div>`;
      const u = esc(d.uom || ''), ok = !(d.kurang < -1e-9);
      // 1) Kepala: kode, nama, hasil
      const subTxt = (d.subs && d.subs.length ? `Material pengganti: angka di bawah sudah termasuk ${d.subs.map((x) => `<b>${esc(x.kode)}</b> ${esc(x.nama)} (lama${x.skus ? `, hanya SKU ${esc(x.skus.join(', '))}` : ''}${x.pakai ? '' : ', stok lama tidak dipakai'})`).join(', ')}. Rincian: ${[d.subSelf].concat(d.subs).map((x) => x.skus ? `${esc(x.kode)} kebutuhan SKU yang berganti ${prNumTxt(x.butuh) || 0}${x.pakai ? ` · sisa stok + OS PO lama setelah SKU lain ${prNumTxt(x.sisa) || 0}${x.share ? ` (bagian ${x.share}% — material lama ini juga punya pengganti lain)` : ''}` : ''}` : `${esc(x.kode)} stok ${prNumTxt(x.stok) || 0} · kebutuhan ${prNumTxt(x.butuh) || 0} · OS PO ${prNumTxt(x.ospo) || 0}`).join('; ')}. Stok lama dipakai lebih dulu; kekurangan dibeli sebagai ${esc(r.kode)}.` : '')
        + (d.subPart ? ` Kebutuhan SKU ${esc(d.subPart.skus.join(', '))} (${prNumTxt(d.subPart.butuh) || 0}) sudah dialihkan ke ${esc(d.subPart.baru)}; angka di sini hanya untuk SKU yang tetap memakai ${esc(r.kode)}.` : '');
      const head = `<div class="lp-head"><span class="lp-code">${esc(r.kode)}</span><span class="lp-name">${esc(d.nama || r.nama)}${d.subs && d.subs.length ? ` <small class="lp-subt">+ ${esc(d.subs.map((x) => x.kode).join(', '))} (lama)</small>` : ''}</span><span class="lp-chip ${ok ? 'is-ok' : 'is-bad'}">${ok ? 'Cukup' : 'Kurang'} ${prNumTxt(Math.abs(d.kurang))} ${u}</span></div>`;
      // 2) Rumus sebagai kotak berurutan
      const osParts = d.split ? [['telat', d.poLate], ['tanpa jadwal', d.poNone], ['terjadwal', d.poIn], ['setelah MPS', d.poAfter]].filter((x) => nz(x[1])).map((x) => `${x[0]} ${prNumTxt(x[1])}`).join(' · ') : (nz(d.poLate) ? `telat ${prNumTxt(d.poLate)}` : '');
      const box = (op, lbl, sub, v, cls) => `<div class="lp-box${cls ? ' ' + cls : ''}"><span class="lp-lbl">${op ? `<b class="lp-op">${op}</b> ` : ''}${lbl}</span><b class="lp-v">${prNumTxt(v)}</b><span class="lp-sub">${sub}</span></div>`;
      const v3 = d.v === 3;
      const eq3 = v3 ? `<div class="lp-eq lp-eq3"><span class="lp-eqh">Stok terkini per ${esc(fmtDate(d.at))}</span>${box('', 'Stok awal', esc(fmtDate(d.stokDate)) + (nz(d.koreksi) || nz(d.gantung) ? ` · koreksi ${prNumTxt(d.koreksi)} · gantung ${prNumTxt(d.gantung)}` : ''), R3h(d.awal + (d.koreksi || 0) - (d.gantung || 0)))}${box('+', 'Incoming', 'sudah datang', d.incPast)}${box('−', 'Pemakaian MO', `${esc(fmtDate(d.stokDate))} – ${esc(fmtDate(d.at))}`, d.pakaiPast)}${box('−', 'ADD/FOH/RS', `s/d ${esc(fmtDate(d.at))}`, d.addPast)}${nz(d.subLump) ? box('+', 'Sisa stok lama', esc(d.subs.filter((x) => x.skus).map((x) => x.kode).join(', ')), d.subLump) : ''}${box('=', 'Stok terkini', u, d.stok, 'is-mid')}</div>
        <div class="lp-eq">${box('', 'Stok terkini', esc(fmtDate(d.at)), d.stok)}${box('+', 'OS PO', esc(osParts) || 'tidak ada', d.ospo)}${box('−', 'Kebutuhan', 'besok s/d ' + esc(d.last), d.butuh)}${box('−', 'ADD/FOH/RS', 'setelah hari ini', d.add)}${box('=', ok ? 'Sisa' : 'Kekurangan', u, d.kurang, ok ? 'is-ok' : 'is-bad')}</div>` : '';
      const eq = v3 ? eq3 : `<div class="lp-eq">${box('', 'Stok awal', esc(fmtDate(d.stokDate)), d.stok)}${box('+', 'Incoming', 'sudah datang', d.inc)}${box('+', 'OS PO', esc(osParts) || 'tidak ada', d.ospo)}${box('−', 'Kebutuhan', 's/d ' + esc(d.last), d.butuh)}${box('−', 'ADD/FOH/RS', '', d.add)}${box('=', ok ? 'Sisa' : 'Kekurangan', u, d.kurang, ok ? 'is-ok' : 'is-bad')}</div>`;
      // 3) Catatan singkat
      const v2 = d.split === 2, hasLN = v2 && (nz(d.poLate) || nz(d.poNone)), aft = !!(d.split && (nz(d.poAfter) || nz(d.prBeyond)));
      const notes = [
        subTxt,
        d.minus ? `<b class="pr-st-late">Saldo mulai minus ${esc(d.minus)}</b> (terdalam ${prNumTxt(d.deep)} ${u})${hasLN ? (d.minusNoLN ? ', tertutup bila PO telat / tanpa jadwal datang' : ', belum memperhitungkan PO telat / tanpa jadwal') : ''}.` : 'Saldo tidak minus sampai MPS terakhir.',
        d.prSal ? `Bila PR ini (${prNumTxt(d.prQty)} ${u}) datang${d.prFirst ? ` mulai ${esc(d.prFirst)}` : ''}: ${d.prDeepAfter < -1e-9 ? `<b class="pr-st-late">masih minus ${prNumTxt(d.prDeepAfter)}</b>` : '<b class="pr-st-ok">kekurangan tertutup</b>'}${d.prDeepBefore < -1e-9 ? `; sebelum PR datang minus ${prNumTxt(d.prDeepBefore)}` : ''}${nz(d.prBeyond) ? `; ${prNumTxt(d.prBeyond)} datang setelah MPS terakhir` : ''}.` : '',
        hasLN ? `PO telat / tanpa jadwal (${prNumTxt((d.poLate || 0) + (d.poNone || 0))} ${u}) belum pasti kapan datang, jadi dipisah di kolom sendiri dan tidak dihitung di week mana pun.` : '',
        nz(d.poAfter) ? `PO setelah MPS terakhir: ${(d.after || []).map((x) => `${esc(x.po)} ${esc(fmtDate(x.d))} (${prNumTxt(x.q)})`).join(', ')}.` : '',
        d.note ? esc(d.note) : '',
      ].filter(Boolean);
      // 4) Tabel per week (baris yang semuanya kosong disembunyikan)
      const X = (v, extra) => `<td class="num lp-x"${extra || ''}>${v}</td>`;
      const salX = R3h(d.cols[d.cols.length - 1].sal + (d.poLate || 0) + (d.poNone || 0));
      const tr = (lbl, fn, cls, ex) => `<tr${cls ? ` class="${cls}"` : ''}><th>${lbl}</th>${d.cols.map((c, i) => fn(c, i)).join('')}${hasLN ? (ex && ex[0] !== undefined ? ex[0] : X('')) : ''}${aft ? (ex && ex[1] !== undefined ? ex[1] : X('')) : ''}</tr>`;
      const sc = (v) => `<td class="num${v < -1e-9 ? ' pr-neg' : ''}">${prNumTxt(v)}</td>`;
      const scX = (v) => sc(v).replace('class="num', 'class="num lp-x');
      const any = (k) => d.cols.some((c) => nz(c[k]));
      const rowsHtml = [
        tr('Kebutuhan', (c) => `<td class="num">${f(c.need)}</td>`),
        any('inc') ? tr('Incoming sudah datang', (c) => `<td class="num">${f(c.inc)}</td>`) : '',
        !d.split ? tr('OS PO', (c) => `<td class="num">${f(c.po)}</td>`)
          : (!v2 && any('poL') ? tr('PO telat', (c) => `<td class="num">${f(c.poL)}</td>`) : '') + (!v2 && any('poN') ? tr('PO tanpa jadwal', (c) => `<td class="num">${f(c.poN)}</td>`) : '')
            + (hasLN ? tr('PO telat / tanpa jadwal', () => '<td class="num">–</td>', '', [X(prNumTxt((d.poLate || 0) + (d.poNone || 0)))]) : '')
            + tr('PO terjadwal', (c) => `<td class="num">${f(c.poS)}</td>`, '', [undefined, aft ? X(f(d.poAfter)) : undefined]),
        nz(d.add) ? tr('ADD/FOH/RS', (c) => `<td class="num">${f(c.add)}</td>`) : '',
        tr('Saldo', (c) => sc(c.sal), 'is-sal', [hasLN ? scX(salX) : undefined, aft ? scX(d.salEnd) : undefined]),
        d.prSal ? tr('PR ini datang', (c, i) => `<td class="num">${f(d.pr[i])}</td>`, 'is-pr', [undefined, aft ? X(f(d.prBeyond)) : undefined]) + tr('Saldo bila PR datang', (c, i) => sc(d.prSal[i]), 'is-sal is-pr', [hasLN ? scX(R3h(salX + d.prSal[d.prSal.length - 1] - d.cols[d.cols.length - 1].sal)) : undefined, aft ? scX(R3h(d.salEnd + (d.prQty || 0))) : undefined]) : '',
      ].join('');
      const table = `<div class="pr-hit-w"><table class="pr-st-t pr-hit"><thead><tr><th>${u}</th>${d.cols.map((c) => `<th class="num">${esc(c.l)}</th>`).join('')}${hasLN ? '<th class="num lp-x">PO telat /<br>tanpa jadwal</th>' : ''}${aft ? '<th class="num lp-x">Setelah<br>MPS</th>' : ''}</tr></thead><tbody>${rowsHtml}</tbody></table></div>`;
      if (print) {
        // cetak: rumus satu baris + catatan + tabel (kartu ringkas)
        const eqT = v3 ? `Stok terkini <b>${prNumTxt(d.stok)}</b> = stok ${esc(fmtDate(d.stokDate))} ${prNumTxt(R3h(d.awal + (d.koreksi || 0) - (d.gantung || 0)))}${nz(d.incPast) ? ` + incoming ${prNumTxt(d.incPast)}` : ''} − pemakaian MO ${prNumTxt(d.pakaiPast)}${nz(d.addPast) ? ` − ADD ${prNumTxt(d.addPast)}` : ''}${nz(d.subLump) ? ` + sisa stok lama ${prNumTxt(d.subLump)}` : ''} · + OS PO ${prNumTxt(d.ospo)}${osParts ? ` (${osParts})` : ''} − Kebutuhan ${prNumTxt(d.butuh)}${nz(d.add) ? ` − ADD ${prNumTxt(d.add)}` : ''} = <b class="${ok ? 'pr-st-ok' : 'pr-st-late'}">${ok ? 'Sisa' : 'Kurang'} ${prNumTxt(Math.abs(d.kurang))} ${u}</b>`
          : `Stok awal ${prNumTxt(d.stok)} + Incoming ${prNumTxt(d.inc)} + OS PO ${prNumTxt(d.ospo)} − Kebutuhan ${prNumTxt(d.butuh)} − ADD ${prNumTxt(d.add)} = <b>${ok ? 'Sisa' : 'Kurang'} ${prNumTxt(Math.abs(d.kurang))} ${u}</b>`;
        return `<div class="lp-card lp-cmp">${head}<p class="lp-eqt">${eqT}</p>${notes.length ? `<p class="lp-nt">${notes.join(' ')}</p>` : ''}${table}</div>`;
      }
      return `<div class="lp-card">${head}${eq}${notes.length ? `<ul class="lp-notes">${notes.map((t) => `<li>${t}</li>`).join('')}</ul>` : ''}${table}</div>`;
    }).join('');
    // cetak: tabel ringkasan semua material di depan
    let sum = '';
    if (print) {
      const D = rows.map((r) => { const h = H.find((x) => x.kode === String(r.kode).trim()); return { r, d: h && h.data }; }).filter((x) => x.d && x.d.cols && x.d.butuh !== undefined);
      const C = (D.find((x) => x.d.v === 3) || D[0] || { d: { cols: [] } }).d.cols.map((c) => c.l);
      if (D.length) sum = `<table class="pr-st-t lp-sum"><thead><tr><th>Kode</th><th>Nama</th><th class="num">Stok terkini</th><th class="num">OS PO</th>${C.map((l) => `<th class="num">${esc(l)}<small>keb. / saldo</small></th>`).join('')}<th class="num">Kekurangan</th><th>Mulai minus</th><th class="num">PR ini</th><th class="num" title="Kekurangan + qty PR ini (dasar sama dengan kolom Kekurangan: termasuk PO telat / tanpa jadwal)">Sisa setelah PR</th><th title="Saldo sudah minus sebelum PR ini datang (tanggal kirim PR terlambat)">Minus sebelum PR datang</th></tr></thead><tbody>
        ${D.map(({ r, d }) => {
          const ok = !(d.kurang < -1e-9), q = Number(d.prQty) || 0, sisa = R3h(d.kurang + q), ln = R3h((d.poLate || 0) + (d.poNone || 0));
          // minus sebelum PR datang: kolom pertama yang minus sebelum kolom kedatangan PR pertama
          const fa = d.pr ? d.pr.findIndex((x) => x > 0) : -1, lim = fa >= 0 ? fa : (q ? d.cols.length : 0);
          const pre = d.cols.slice(0, lim), ni = pre.findIndex((c) => c.sal < -1e-9), deep = ni >= 0 ? Math.min(...pre.map((c) => c.sal)) : 0;
          const rely = sisa >= -1e-9 && ln > 1e-9 && sisa - ln < -1e-9;
          return `<tr><td><b>${esc(r.kode)}</b></td><td>${esc(d.nama || r.nama)} <small>${esc(d.uom || '')}</small>${d.subs && d.subs.length ? `<small>termasuk ${esc(d.subs.map((x) => x.kode).join(', '))} (lama)</small>` : ''}</td><td class="num">${prNumTxt(d.stok)}</td><td class="num">${f(d.ospo)}${ln > 1e-9 ? `<small>telat/tanpa jadwal ${prNumTxt(ln)}</small>` : ''}</td>${C.map((l, i) => { const c = d.cols[i] || {}; return `<td class="num${c.sal < -1e-9 ? ' pr-neg' : ''}"><small>${nz(c.need) ? '−' + prNumTxt(c.need) : '–'}</small><b>${c.sal !== undefined ? prNumTxt(c.sal) : ''}</b></td>`; }).join('')}<td class="num ${ok ? 'pr-st-ok' : 'pr-st-late'}"><b>${ok ? '' : '−'}${prNumTxt(Math.abs(d.kurang))}</b></td><td>${esc(d.minus || '–')}</td><td class="num">${q ? prNumTxt(q) + (d.prFirst ? `<small>datang ${esc(d.prFirst)}</small>` : d.prBeyond ? '<small>setelah MPS</small>' : '') : '–'}</td><td class="num${sisa < -1e-9 ? ' pr-neg' : ''}"><b>${sisa < -1e-9 ? '−' : '+'}${prNumTxt(Math.abs(sisa))}</b>${rely ? `<small>mengandalkan PO telat/tanpa jadwal ${prNumTxt(ln)}</small>` : ''}</td><td>${ni >= 0 ? `<span class="pr-st-late">${esc(d.cols[ni].l)}</span><small>terdalam ${prNumTxt(deep)}${q ? ', PR baru datang ' + esc(d.prFirst || 'setelah MPS') : ''}</small>` : '–'}</td></tr>`;
        }).join('')}</tbody></table>
        <p class="lp-nt">Angka kecil = kebutuhan di kolom itu, angka tebal = saldo akhir kolom (tanpa PO telat / tanpa jadwal karena belum pasti kapan datang). Kekurangan dan Sisa setelah PR = Stok terkini + seluruh OS PO (termasuk telat / tanpa jadwal) − Kebutuhan (+ PR ini). "Mengandalkan PO telat/tanpa jadwal" = cukup hanya bila PO itu benar datang. "Minus sebelum PR datang" = qty sudah cukup tapi tanggal kirim PR perlu dimajukan. Rincian per material di bawah.</p>${(() => { const L = D.filter(({ d }) => (d.late || []).length && d.kurang + (Number(d.prQty) || 0) - (d.poLate || 0) - (d.poNone || 0) < -1e-9); return L.length ? `<p class="lp-nt"><b>PO telat yang diandalkan:</b> ${L.map(({ r, d }) => `${esc(r.kode)}: ${(d.late || []).map((x) => `${esc(x.po)} ${prNumTxt(x.q)} (jadwal ${esc(fmtDate(x.d))})`).join(', ')}`).join(' · ')}.</p>` : ''; })()}`;
    }
    const anyV3 = H.some((x) => x.data && x.data.v === 3);
    const title = `<div class="pr-lamp-h"><b>Lampiran Perhitungan</b> · ${esc(g.kodePr)}${at ? ` · dihitung ${esc(at)}` : ''}</div><p class="lp-how">${anyV3 ? 'Stok terkini = Stok awal + Incoming − Pemakaian MO (Plotting Harian) − ADD/FOH/RS sampai hari hitung. Kekurangan = Stok terkini + OS PO − Kebutuhan − ADD/FOH/RS sesudahnya. Kebutuhan bulan berjalan dari MO Plotting Harian per week; bulan berikutnya dari Plan bulan penuh (Banded/2in1/KIT tidak dihitung).' : 'Kekurangan = Stok awal + Incoming + OS PO − Kebutuhan − ADD/FOH/RS. Kebutuhan dari Kebutuhan Material s/d MPS terakhir.'} Angka minus di tabel = saldo kurang pada kolom itu.</p>`;
    return print ? `<section class="pr-lamp-page pr-st-page pr-hit-page lp-print">${title}${sum}${blk}</section>` : `${title}${blk}`;
  }
  /* ---------- Lampiran Penggunaan Material: produk pemakai (BoM aktif) + Sell In L3M, dibekukan bersama Lampiran Perhitungan ---------- */
  function prUseHtml(g, print) {
    if (isLtPr(g.kodePr)) return '';
    const H = prHitungOf(g.kodePr), rows = g.rows.filter((r) => r.status !== 'Batal');
    const at = H.map((x) => x.at).filter(Boolean).sort().pop() || '';
    let months = null;
    const blk = rows.map((r) => {
      const h = H.find((x) => x.kode === String(r.kode).trim()), d = h && h.data; let U = d && d.use;
      const head = (chip) => `<div class="lp-head"><span class="lp-code">${esc(r.kode)}</span><span class="lp-name">${esc((d && d.nama) || r.nama)}</span>${chip}</div>`;
      if (!U) return `<div class="lp-card">${head('<span class="lp-chip is-muted">Belum dihitung</span>')}<p class="lp-empty">Klik "Perbarui lampiran" untuk menghitung penggunaan material.</p></div>`;
      months = months || U.months;
      const u = esc(d.uom || ''), act = U.rows.filter((x) => x.need > 0).length;
      U.rows = U.rows.filter((x) => x.need > 0 || (x.avg || 0) > 0);   // produk tanpa kebutuhan & tanpa Sell In tidak ditampilkan
      let hidN = 0; if (print && U.rows.length > 8) { hidN = U.rows.length - 8; U = Object.assign({}, U, { rows: U.rows.slice(0, 8), more: (U.more || 0) + hidN }); }
      if (!U.rows.length) return `<div class="lp-card">${head('<span class="lp-chip is-muted">Tidak dipakai di BoM aktif SKU mana pun</span>')}</div>`;
      const ml = U.months.map((b) => `<th class="num">${monShort(b)} ${b.slice(2, 4)}</th>`).join('');
      const tb = U.rows.map((x) => `<tr${x.need > 0 ? '' : ' class="lp-dim"'}><td><b>${esc(x.sku)}</b><small>${esc(x.name)}</small></td><td>${esc(x.bom)}${x.old ? `<small class="lp-old">BoM lama (${esc(x.old)})</small>` : ''}</td><td class="num">${prNumTxt(x.perTon)}</td><td class="num">${x.need > 0 ? `<b>${prNumTxt(x.need)}</b><small>${nf.format(Math.round(x.share * 100))}%</small>` : '–'}</td>${x.sell ? x.sell.map((v) => `<td class="num">${v ? nf.format(v) : '–'}</td>`).join('') + `<td class="num"><b>${x.avg ? nf.format(x.avg) : '–'}</b></td><td class="num">${x.setara ? `<b>${prNumTxt(x.setara)}</b>` : '–'}</td>` : `<td class="num" colspan="5">–</td>`}</tr>`).join('');
      const totSet = U.rows.reduce((t, x) => t + (x.setara || 0), 0), hasSet = U.rows.some((x) => x.setara !== undefined);
      return `<div class="lp-card">${head(`<span class="lp-chip is-neutral">${U.rows.length} produk · ${act} ada kebutuhan</span>`)}
        <div class="pr-hit-w"><table class="pr-st-t lp-use"><thead><tr><th>Produk</th><th>BoM aktif</th><th class="num">Pemakaian<br><small>${u} / 1.000 kg</small></th><th class="num">Kebutuhan<br><small>${u}, s/d ${esc(d.last || '')}</small></th>${ml}<th class="num">Rata-rata<br><small>pcs/bln</small></th><th class="num">Setara material<br><small>${u}/bln</small></th></tr></thead>
        <tbody>${tb}</tbody><tfoot><tr><th colspan="3">Total</th><th class="num"><b>${prNumTxt(U.tot)}</b></th><th colspan="${U.months.length + 1}"></th><th class="num"><b>${totSet ? prNumTxt(totSet) : '–'}</b></th></tr></tfoot></table></div>
        ${U.more ? `<p class="lp-empty">+${U.more} produk lain dengan Sell In lebih kecil tidak ditampilkan.</p>` : ''}${U.err ? `<p class="lp-empty">Sell In: ${esc(U.err)}</p>` : ''}</div>`;
    }).join('');
    const ms = months ? months.map(monLabel) : [];
    const title = `<div class="pr-lamp-h"><b>Lampiran Penggunaan Material</b> · ${esc(g.kodePr)}${at ? ` · dihitung ${esc(at)}` : ''}</div><p class="lp-how">Produk yang memakai material ini menurut BoM aktif tiap SKU (termasuk lewat ekstrak/bulk). Kebutuhan = bagian produk itu dalam kebutuhan Lampiran Perhitungan. Sell In = DO Delivered CSL Personal Care + Beauty${ms.length ? ` (${esc(ms[0])} – ${esc(ms[ms.length - 1])})` : ''}, dalam pcs, 3 bulan penuh terakhir. Setara material = rata-rata Sell In × pemakaian material per pcs (BoM aktif), yaitu perkiraan material yang terpakai per bulan mengikuti kecepatan jual. Produk tanpa kebutuhan dan tanpa Sell In tidak ditampilkan. Baris abu-abu = tidak ada kebutuhan di rentang ini.</p>`;
    return print ? `<section class="pr-lamp-page pr-st-page pr-hit-page lp-print lp-usep">${title}${blk}</section>` : `${title}${blk}`;
  }
  async function prHitungPayload(rows) {
    if (!(await mrpReady())) return null;
    if (PRM() === 'lt') {
      try { await ltSoMap(); } catch (e) { /* tanpa SO: kebutuhan 0 */ }
      const o = {};
      rows.forEach((r) => {
        const k = String(r.kode || '').trim(); if (!k || o[k]) return;
        const d = ltCalc(k); if (!d) return;
        const keep = d.rows.filter((x) => x.need > 0 || x.avgPcs > 0), noSo = d.rows.filter((x) => !(x.need > 0 || x.avgPcs > 0)).map((x) => x.sku);
        const L = Object.assign({ v: 'lt', at: todayStr(), noSo, pr: prSchedOf(r), prQty: Number(prNum(r.buka)) || 0 }, d, { rows: keep.slice(0, 60).map((x) => Object.assign({}, x, { name: x.name.length > 48 ? x.name.slice(0, 47) + '…' : x.name, perPcs: undefined })), moList: d.moList.slice(0, 40) });
        o[k] = { hz: 'lt', data: L };
      });
      return o;
    }
    let SI = null; try { SI = await sellInMap(); } catch (e) { SI = null; }
    const o = {};
    rows.forEach((r) => { const k = String(r.kode || '').trim(); if (k && !o[k]) { const d = prCalc(k, 'all', prSchedOf(r), { pool: true }); if (d) { d.use = prUseData(k, SI); while (JSON.stringify(d).length > 45000 && d.use.rows.length > 5) { d.use.more += Math.ceil(d.use.rows.length / 3); d.use.rows = d.use.rows.slice(0, Math.floor(d.use.rows.length * 2 / 3)); } o[k] = { hz: 'all', data: d }; } } });
    return o;
  }
  /* ---------- Lampiran Status PO: PO outstanding (gantung) per material, dibekukan saat PR disimpan ---------- */
  function setPrStatus(list) {
    state.prStatus = (list || []).map((r) => ({ kodePr: r[0], kode: r[1], po: r[2], supplier: r[3], tgl: r[4], qty: r[5], rec: r[6], sisa: r[7], uom: r[8], jadwal: r[9], status: r[10], at: r[11] }));
  }
  const PR_ST_TXT = { late: 'Telat', short: 'Kurang kirim', wait: 'Menunggu jadwal', none: 'Belum ada jadwal kirim' };
  // Baris PO outstanding untuk satu kode material (dari Monitoring PO, saat ini)
  function prOsList(kode) {
    kode = String(kode || '').trim(); if (!kode) return [];
    return (state.rows || []).filter((x) => x.code === kode && !x.cancel && !x.takeout && x.sisa > 1e-9)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .map((x) => {
        const pend = (x.sched || []).filter((sc) => sc.status !== 'Done' && sc.date).map((sc) => `${fmtDate(sc.date)}: ${prNumTxt(Math.max(0, (Number(sc.qty) || 0) - (Number(sc.rec) || 0)))}`);
        const st = x.status === 'late' ? `Telat ${nf.format(x.lateDays || 0)} hari` : PR_ST_TXT[x.status] || x.status;
        return [x.po, x.supplier, x.date, x.qty, x.rec, x.sisa, x.uom, pend.join('; '), st];
      });
  }
  const prOsSum = (kode) => prOsList(kode).reduce((t, x) => t + (Number(x[5]) || 0), 0);
  const prStatusPayload = (kodes) => { const o = {}; [...new Set(kodes.map((k) => String(k || '').trim()).filter(Boolean))].forEach((k) => { o[k] = prOsList(k); }); return o; };
  const prStatusOf = (kodePr) => (state.prStatus || []).filter((x) => x.kodePr === kodePr);
  // Halaman / pratinjau Lampiran Status PO
  function prStatusHtml(g, print) {
    const st = prStatusOf(g.kodePr), rows = g.rows.filter((r) => r.status !== 'Batal');
    const at = st.map((x) => x.at).filter(Boolean).sort().pop() || '';
    const stCls = (s) => (/^Telat/.test(s) ? 'is-bad' : /Kurang/.test(s) ? 'is-warn' : /Belum ada jadwal/.test(s) ? 'is-muted' : 'is-ok');
    const blk = rows.map((r) => {
      const L = st.filter((x) => x.kode === String(r.kode).trim());
      const os = L.filter((x) => x.po), tot = os.reduce((t, x) => t + (Number(x.sisa) || 0), 0), u = esc((os[0] || {}).uom || '');
      const late = os.filter((x) => /^Telat/.test(x.status));
      const chip = !L.length ? '<span class="lp-chip is-muted">Belum dibekukan</span>' : os.length ? `<span class="lp-chip is-neutral">OS PO ${prNumTxt(tot)} ${u}</span>${late.length ? `<span class="lp-chip is-bad">${late.length} PO telat</span>` : ''}` : '<span class="lp-chip is-ok">Tidak ada PO gantung</span>';
      const head = `<div class="lp-head"><span class="lp-code">${esc(r.kode)}</span><span class="lp-name">${esc(r.nama)}</span>${chip}</div>`;
      if (!os.length) return `<div class="lp-card">${head}</div>`;
      const lateD = (x) => (/^Telat/.test(x.status) ? Number((String(x.status).match(/\d+/) || [0])[0]) || 0.5 : 0);
      const sorted = os.slice().sort((a, b) => (lateD(b) - lateD(a)) || String(a.jadwal).localeCompare(String(b.jadwal)));
      return `<div class="lp-card">${head}<table class="pr-st-t lp-po"><thead><tr><th>No PO</th><th>Supplier</th><th class="num">Sisa belum datang</th><th>Jadwal kirim</th><th>Status</th></tr></thead><tbody>
        ${sorted.map((x) => `<tr><td class="lp-nopo"><b>${esc(x.po)}</b><small>order ${esc(x.tgl ? fmtDate(x.tgl) : '–')}</small></td><td>${esc(x.supplier)}</td><td class="num"><b>${prNumTxt(x.sisa)}</b> ${esc(x.uom)}<small>diterima ${prNumTxt(x.rec)} dari ${prNumTxt(x.qty)}</small></td><td>${esc(x.jadwal).replace(/; /g, '<br>') || '–'}</td><td><span class="lp-chip ${stCls(x.status)}">${esc(x.status)}</span></td></tr>`).join('')}</tbody></table></div>`;
    }).join('');
    const title = `<div class="pr-lamp-h"><b>Lampiran Status PO</b> · ${esc(g.kodePr)}${at ? ` · status per ${esc(at)}` : ''}</div><p class="lp-how">PO yang masih gantung (belum datang semua) per material. PO telat ditaruh paling atas.</p>`;
    return print ? `<section class="pr-lamp-page pr-st-page">${title}${blk}</section>` : `${title}${blk}`;
  }
  // Panel Lampiran Perhitungan + Status PO (Formulir PR & Rekap PR)
  function prLampPanel(g, withInc) {
    return `<div class="pr-st-tools">${withInc ? `<label class="tb-check"><input type="checkbox" id="prHtInc"${PRF.noHt ? '' : ' checked'}> Cetak Lampiran Perhitungan</label><label class="tb-check"><input type="checkbox" id="prStInc"${PRF.noSt ? '' : ' checked'}> Cetak Lampiran Status PO</label><label class="tb-check"><input type="checkbox" id="prUseInc"${PRF.noUse ? '' : ' checked'}> Cetak Lampiran Penggunaan Material</label>` : ''}<button type="button" class="btn-link" data-prst-refresh="${esc(g.kodePr)}" title="Hitung & bekukan ulang Lampiran Perhitungan dan Status PO dengan data saat ini (Mode edit)">Perbarui lampiran</button></div>
      ${state.noPrHitungScript ? '' : `<div class="pr-hit-sec">${prHitungHtml(g, false)}</div>`}<div class="pr-st-sec">${prStatusHtml(g, false)}</div>${state.noPrHitungScript ? '' : `<div class="pr-st-sec">${prUseHtml(g, false)}</div>`}`;
  }
  async function prRefreshLamp(kodePr, after) {
    const g = prGroups().find((x) => x.kodePr === kodePr); if (!g) return;
    if (!state.edit.on) { toast('Masuk Mode edit dulu untuk memperbarui lampiran.'); return; }
    const rows = g.rows.filter((r) => r.status !== 'Batal'), hz0 = (prHitungOf(kodePr)[0] || {}).hz || '8';
    openDialog({ title: `Perbarui lampiran · ${kodePr}`, ok: 'Perbarui',
      body: `<p class="dlg-lead">Lampiran Perhitungan dan Status PO untuk ${rows.length} material di PR ini dihitung ulang dengan data saat ini, lalu dibekukan lagi.</p>
`,
      onSubmit: async (fd) => {
        const hitung = state.noPrHitungScript ? null : await prHitungPayload(rows);
        const res = await api('refreshPrStatus', { data: { kodePr, statusPo: prStatusPayload(rows.map((r) => r.kode)), hitung: hitung || undefined } });
        setPrStatus(res.prStatus); if (res.prHitung) setPrHitung(res.prHitung); if (res.editLog) state.editLog = res.editLog;
        if (after) setTimeout(after, 0);
        return 'Lampiran diperbarui.';
      } });
  }
  function setPrLamp(list) {
    state.prLamp = (list || []).map((r) => ({ kodePr: r[0], id: r[1], jenis: r[2], fileId: r[3], name: r[4], caption: r[5], time: r[6], by: r[7] }));
  }
  const prLampOf = (kodePr) => (state.prLamp || []).filter((x) => x.kodePr === kodePr);
  const LAMP_IMG = new Map();   // id → data URL (sekali ambil per sesi)
  async function prLampImg(id) {
    if (LAMP_IMG.has(id)) return LAMP_IMG.get(id);
    const res = await fetch(CFG.APPS_SCRIPT_URL + '?view=prlamp&id=' + encodeURIComponent(id));
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || 'Gambar tidak bisa dimuat.');
    const url = `data:${d.mime};base64,${d.data}`;
    LAMP_IMG.set(id, url); return url;
  }
  function prLampFill(root) {
    root.querySelectorAll('img[data-lampid]').forEach((img) => {
      if (img.src) return;
      prLampImg(img.dataset.lampid).then((u) => { img.src = u; }).catch((err) => { img.alt = 'Gagal memuat: ' + err.message; img.classList.add('is-err'); });
    });
  }
  // Gambar tempelan → base64; diperkecil bila lebar > 2000 px, JPEG bila file besar
  function prLampEncode(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('Gambar tidak bisa dibaca.'));
      fr.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Gambar tidak bisa dibaca.'));
        img.onload = () => {
          const big = file.size > 1200000, scale = Math.min(1, 2000 / img.width);
          if (!big && scale === 1) { resolve({ mime: file.type || 'image/png', url: fr.result }); return; }
          const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
          const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
          const mime = big ? 'image/jpeg' : 'image/png';
          resolve({ mime, url: c.toDataURL(mime, 0.85) });
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }
  function prLampDialog(kodePr) {
    const ed = state.edit.on, pend = [];
    const list = () => prLampOf(kodePr);
    const paint = () => {
      const L = list(), b = $('dlgBody');
      b.querySelector('#plSaved').innerHTML = L.length ? L.map((x, i) => `<figure class="pl-fig"><img data-lampid="${esc(x.id)}" alt="Lampiran ${i + 1}">
          <figcaption><b>Lampiran ${i + 1}</b>${x.caption ? ' · ' + esc(x.caption) : ''}<small class="muted">${esc(x.time)} · ${esc(x.by)}</small>${ed ? ` <button type="button" class="btn-link danger" data-lampdel="${esc(x.id)}">Hapus</button>` : ''}</figcaption></figure>`).join('')
        : '<p class="muted">Belum ada gambar lampiran.</p>';
      b.querySelector('#plPend').innerHTML = pend.map((x, i) => `<figure class="pl-fig is-new"><img src="${x.url}" alt="Gambar baru ${i + 1}">
          <figcaption><input data-cap="${i}" value="${esc(x.caption)}" placeholder="Keterangan (opsional)"> <button type="button" class="btn-link danger" data-pendrm="${i}">Buang</button></figcaption></figure>`).join('');
      $('dlgOk').textContent = pend.length ? `Simpan ${pend.length} gambar` : 'Tutup';
      prLampFill(b);
    };
    openDialog({
      title: `Lampiran ${kodePr}`, ok: 'Tutup', wide: true, cancel: false,
      body: `${(() => { const g = prGroups().find((x) => x.kodePr === kodePr); return g && !state.noPrStatusScript ? `<div class="pr-lampdlg">${prLampPanel(g, false)}</div>` : '<h3 class="pj-h">Perhitungan & Status PO</h3><p class="muted">Perlu Apps Script MONITORING PO versi terbaru.</p>'; })()}
        <h3 class="pj-h">Gambar</h3>
        ${ed ? '<div class="pl-paste" id="plPaste" tabindex="0" role="button" aria-label="Tempel gambar">Klik kotak ini lalu tekan <b>Ctrl+V</b> untuk menempel screenshot. Bisa berkali-kali.</div>' : (state.noLampScript ? '<p class="pl-bad">Apps Script MONITORING PO perlu diperbarui (versi dengan lampiran PR).</p>' : '<p class="muted">Masuk Mode edit untuk menambah atau menghapus gambar.</p>')}
        <div class="pl-grid" id="plPend"></div><div class="pl-grid" id="plSaved"></div>
        <p class="hint">Gambar disimpan di Google Drive (folder "Lampiran PR - PPIC GTK", tidak dibagikan publik) dan ikut tercetak di halaman setelah formulir PR.</p>`,
      onSubmit: async () => {
        if (!pend.length) return '';
        for (const x of pend.splice(0)) {
          const res = await api('addPrLamp', { data: { kodePr, mime: x.mime, data: x.url.split(',')[1], caption: x.caption } });
          setPrLamp(res.prLamp);
        }
        renderPrViews();
        return 'Lampiran tersimpan.';
      },
    });
    const seq = dlgSeq, b = $('dlgBody');
    paint();
    const zone = b.querySelector('#plPaste'); if (zone) zone.focus();
    const onPaste = async (e) => {
      if (seq !== dlgSeq || !$('dlg').open) return;
      const files = [...(e.clipboardData ? e.clipboardData.items : [])].filter((it) => it.kind === 'file' && /^image\//.test(it.type)).map((it) => it.getAsFile());
      if (!files.length) { if (zone) { toast('Clipboard tidak berisi gambar. Salin screenshot dulu.'); } return; }
      e.preventDefault();
      if (state.noLampScript) { toast('Apps Script MONITORING PO perlu diperbarui dulu.'); return; }
      for (const f of files) { try { const x = await prLampEncode(f); pend.push(Object.assign(x, { caption: '' })); } catch (err) { toast(err.message); } }
      paint();
    };
    if (ed) b.addEventListener('paste', onPaste);
    b.addEventListener('input', (e) => { if (seq !== dlgSeq) return; const c = e.target.closest('[data-cap]'); if (c) pend[Number(c.dataset.cap)].caption = c.value; });
    b.addEventListener('click', async (e) => {
      if (seq !== dlgSeq) return;
      const rm = e.target.closest('[data-pendrm]'); if (rm) { pend.splice(Number(rm.dataset.pendrm), 1); paint(); return; }
      const del = e.target.closest('[data-lampdel]'); if (!del) return;
      del.disabled = true; del.textContent = 'Menghapus…';
      try { const res = await api('delPrLamp', { data: { id: del.dataset.lampdel } }); setPrLamp(res.prLamp); paint(); renderPrViews(); toast('Lampiran dihapus.'); }
      catch (err) { del.disabled = false; del.textContent = 'Hapus'; toast('Gagal: ' + err.message); }
    });
  }
  document.addEventListener('click', (e) => { const l = e.target.closest('[data-lamppr]'); if (l) prLampDialog(l.dataset.lamppr); });
  // Halaman lampiran untuk cetak (setelah formulir)
  async function prLampPrintHtml(kodePr) {
    const L = prLampOf(kodePr);
    const urls = await Promise.all(L.map((x) => prLampImg(x.id).catch(() => '')));
    return L.map((x, i) => `<section class="pr-lamp-page"><div class="pr-lamp-h"><b>Lampiran ${i + 1}</b> · ${esc(kodePr)}${x.caption ? ' · ' + esc(x.caption) : ''}</div>
      ${urls[i] ? `<img src="${urls[i]}" alt="Lampiran ${i + 1}">` : '<p>Gambar tidak bisa dimuat.</p>'}</section>`).join('');
  }

  /* ---------- Formulir PR (tarik data dari Rekap per Kode PR, cetak PDF) ---------- */
  const PRF = { kode: '' };
  // Catatan di formulir PR: diketik langsung di formulir, ikut tercetak; disimpan di browser ini per Kode PR (tidak ke Google Sheet)
  const prNoteGet = (k) => { try { return (JSON.parse(localStorage.getItem('ppic.prnote') || '{}'))[k] || ''; } catch (e) { return ''; } };
  const prNoteSet = (k, v) => { try { const o = JSON.parse(localStorage.getItem('ppic.prnote') || '{}'); if (v) o[k] = v; else delete o[k]; localStorage.setItem('ppic.prnote', JSON.stringify(o)); } catch (e) { /* abaikan */ } };
  function prSheet(g, print) {
    const rows = g ? g.rows.filter((r) => r.status !== 'Batal') : [];
    while (rows.length < 5) rows.push(null);
    const head = `<div class="pr-top"><img src="assets/logo-gondowangi.png" alt="Gondowangi" class="pr-logo"><span class="pr-lamp">Lampiran 8.1</span></div>
      <h2 class="pr-title">FORMULIR PURCHASE REQUEST (PR)</h2>
      <div class="pr-meta"><div class="pr-berlaku">Tanggal Berlaku : 02 Okt 2025<br>Tanggal Kaji Ulang : 02 Okt 2028</div>
        <div class="pr-ids"><span>Tanggal PR :</span><b class="pr-box">${g ? esc(prDateTxt(g.tanggal)) : ''}</b><span>Kode PR :</span><b class="pr-box pr-box2">${g ? esc(g.kodePr) : ''}</b></div></div>`;
    const th = `<tr><th class="pr-no">No.</th><th class="pr-kode">Kode</th><th class="pr-nama">Nama Item</th><th class="pr-jenis">Jenis</th><th class="pr-note">Note</th>
      ${PR_COLS.map((c) => `<th class="pr-n">${prColH(c)}<small>${c.u}</small></th>`).join('')}<th class="pr-kirim">Tanggal Kirim</th></tr>`;
    const body = rows.map((r, i) => (r
      ? `<tr><td class="pr-no">${i + 1}</td><td class="pr-kode">${esc(r.kode)}</td><td class="pr-nama">${esc(r.nama)}</td><td class="pr-jenis">${esc(r.jenis)}</td><td class="pr-note">${esc(r.note)}</td>
        ${PR_NUM.map((k) => `<td class="pr-n">${prNumTxt(r[k])}</td>`).join('')}<td class="pr-kirim">${prKirimLines(r.kirim).map(esc).join('<br>')}</td></tr>`
      : `<tr><td class="pr-no">${i + 1}</td><td></td><td></td><td></td><td></td>${PR_NUM.map(() => '<td class="pr-n">-</td>').join('')}<td></td></tr>`)).join('');
    const note = g ? prNoteGet(g.kodePr) : '';
    const cat = print ? `<div class="pr-cat"><span>Catatan :</span><div class="pr-catx">${esc(note).replace(/\n/g, '<br>')}</div></div>`
      : `<div class="pr-cat"><span>Catatan :</span><div class="pr-catx" ${g ? 'contenteditable="plaintext-only" data-prnote="1" title="Ketik catatan; ikut tercetak"' : ''} data-ph="Ketik catatan di sini (opsional)">${esc(note)}</div></div>`;
    const foot = `<div class="pr-bottom"><div class="pr-left">${cat}<div class="pr-dok">No. Dok : LF1004-01<br>No. Rev : 04</div></div>
      <table class="pr-sign"><tr><th>Dibuat Oleh :</th><th>Diperiksa Oleh :</th><th colspan="2">Disetujui Oleh :</th></tr>
        <tr><td>(.........................)</td><td>(.........................)</td><td>(.........................)</td><td>(.........................)</td></tr></table></div>`;
    return head + `<table class="pr-table"><thead>${th}</thead><tbody>${body}</tbody></table>` + foot;
  }
  function prEnter() {
    const groups = prGroups();
    $('prKodeList').innerHTML = groups.filter((g) => !g.batal).map((g) => `<option value="${esc(g.kodePr)}">${esc(prDateTxt(g.tanggal))} · ${g.rows.filter((r) => r.status !== 'Batal').length} item</option>`).join('');
    if (!PRF.kode) { const g0 = groups.find((g) => !g.batal); if (g0) PRF.kode = g0.kodePr; }
    $('prKode').value = PRF.kode;
    prRenderForm();
  }
  function prRenderForm() {
    const g = prGroups().find((x) => x.kodePr === PRF.kode);
    const msg = !PRF.kode ? (state.noPrScript ? 'Apps Script MONITORING PO perlu diperbarui (versi dengan Purchase Request).' : 'Pilih atau ketik Kode PR. Data diambil dari Rekap PR.')
      : !g ? `Kode PR ${PRF.kode} tidak ada di Rekap PR.` : g.batal ? `${PRF.kode} berstatus Batal.` : '';
    $('prFormMsg').textContent = msg; $('prFormMsg').className = 'check' + (msg && PRF.kode ? ' err' : '');
    $('prPaper').innerHTML = prSheet(g && !g.batal ? g : null);
    $('prPrint').disabled = !(g && !g.batal);
    const pos = g ? [...new Set(g.rows.filter((r) => r.status !== 'Batal').flatMap((r) => r.pos))] : [];
    const L = g && !g.batal ? prLampOf(g.kodePr) : [];
    $('prFormLamp').innerHTML = g && !g.batal ? `<div class="pr-flamp-h"><b>Lampiran (${L.length})</b> <span class="muted">ikut tercetak di halaman setelah formulir</span> <button type="button" class="btn-link" data-lamppr="${esc(g.kodePr)}">${L.length ? 'Lihat / ubah lampiran' : 'Sertakan lampiran'}</button></div>`
      + (L.length ? `<div class="pl-grid">${L.map((x, i) => `<figure class="pl-fig"><img data-lampid="${esc(x.id)}" alt="Lampiran ${i + 1}"><figcaption><b>Lampiran ${i + 1}</b>${x.caption ? ' · ' + esc(x.caption) : ''}</figcaption></figure>`).join('')}</div>` : '') : '';
    prLampFill($('prFormLamp'));
    $('prFormStatus').innerHTML = g && !g.batal ? (state.noPrStatusScript ? '<p class="check err">Lampiran Status PO & Perhitungan perlu Apps Script MONITORING PO versi terbaru.</p>' : prLampPanel(g, true)) : '';
    $('prFormPo').innerHTML = g && !g.batal ? `No PO terbit dari PR ini: ${pos.length ? g.rows.filter((r) => r.status !== 'Batal' && r.pos.length).map((r) => `<span class="pr-pochip"><span class="mono">${esc(r.kode)}</span> ${prPoLinks(r)}</span>`).join(' ') : '<span class="muted">belum ada</span>'}` : '';
  }
  $('prKode').addEventListener('input', () => { PRF.kode = $('prKode').value.trim(); prRenderForm(); });
  $('prFormStatus').addEventListener('change', (e) => { if (e.target.id === 'prStInc') PRF.noSt = !e.target.checked; if (e.target.id === 'prHtInc') PRF.noHt = !e.target.checked; if (e.target.id === 'prUseInc') PRF.noUse = !e.target.checked; });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-prst-refresh]'); if (b) { const inDlg = !!b.closest('#dlg'); prRefreshLamp(b.dataset.prstRefresh, () => { prRenderForm(); if (inDlg) prLampDialog(b.dataset.prstRefresh); }); return; }
  });
  $('prPaper').addEventListener('input', (e) => { const n = e.target.closest('[data-prnote]'); if (n && PRF.kode) prNoteSet(PRF.kode, n.innerText.replace(/\n+$/, '')); });
  $('prPrint').addEventListener('click', async () => {
    const g = prGroups().find((x) => x.kodePr === PRF.kode); if (!g || g.batal) return;
    let root = document.getElementById('prPrintRoot');
    if (!root) { root = document.createElement('div'); root.id = 'prPrintRoot'; document.body.appendChild(root); }
    $('prPrint').disabled = true; const lbl = $('prPrint').textContent; $('prPrint').textContent = 'Menyiapkan lampiran…';
    let lampHtml = '';
    try { lampHtml = await prLampPrintHtml(g.kodePr); } finally { $('prPrint').disabled = false; $('prPrint').textContent = lbl; }
    root.innerHTML = `<div class="pr-paper is-print">${prSheet(g, true)}</div>${!PRF.noHt && !state.noPrHitungScript ? prHitungHtml(g, true) : ''}${!PRF.noSt && !state.noPrStatusScript ? prStatusHtml(g, true) : ''}${!PRF.noUse && !state.noPrHitungScript ? prUseHtml(g, true) : ''}${lampHtml}`;
    document.body.classList.add('printing-pr');
    const t0 = document.title; document.title = g.kodePr.replace(/\//g, '-');   // nama file PDF bawaan
    const done = () => { document.body.classList.remove('printing-pr'); document.title = t0; window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    const imgs = [...root.querySelectorAll('img')].filter((im) => !im.complete);
    Promise.all(imgs.map((im) => new Promise((ok) => { im.addEventListener('load', ok, { once: true }); im.addEventListener('error', ok, { once: true }); })))
      .then(() => { window.print(); setTimeout(done, 1000); });
  });
  function renderPrViews() { if (state.routeKey === 'pr/rekap' || state.routeKey === 'prlt/rekap') renderPrRekap(); if (state.routeKey === 'pr/form' || state.routeKey === 'prlt/form') prEnter(); if (state.routeKey === 'pr/pengganti') renderSubs(); if (state.routeKey === 'prlt/material') renderLtMat(); }

  // Salin gambar (canvas) ke clipboard sebagai PNG. cvP: Promise<canvas>. Dipanggil langsung dari klik (izin clipboard).
  window.copyCanvasImage = (cvP) => {
    const blobP = Promise.resolve(cvP).then((cv) => new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('Gagal membuat gambar.'))), 'image/png')));
    if (!navigator.clipboard || !window.ClipboardItem) { toast('Browser ini belum bisa menyalin gambar. Pakai Unduh JPG.'); return; }
    navigator.clipboard.write([new ClipboardItem({ 'image/png': blobP })])
      .then(() => toast('Gambar tersalin. Tempel (Ctrl+V) di PowerPoint, email, atau WhatsApp.'))
      .catch((e) => toast('Gagal menyalin gambar: ' + (e && e.message ? e.message : e) + '. Pakai Unduh JPG.'));
  };
  // Potret elemen halaman → canvas (html2canvas dimuat saat pertama dipakai). nodes: elemen yang disalin berurutan; title: judul di atas.
  let h2cP = null;
  const loadH2c = () => h2cP || (h2cP = new Promise((res, rej) => { if (window.html2canvas) return res(window.html2canvas); const sc = document.createElement('script'); sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'; sc.onload = () => res(window.html2canvas); sc.onerror = () => { h2cP = null; rej(new Error('Pustaka gambar tidak bisa dimuat.')); }; document.head.appendChild(sc); }));
  window.domToCanvas = async (nodes, { title = '', sub = '', width = 1400 } = {}) => {
    const h2c = await loadH2c();
    const box = document.createElement('div');
    box.className = 'snap-box'; box.style.width = width + 'px';
    box.innerHTML = `${title ? `<div class="snap-t">${esc(title)}</div>` : ''}${sub ? `<div class="snap-s">${esc(sub)}</div>` : ''}`;
    nodes.filter(Boolean).forEach((n) => { const c = n.cloneNode(true); c.removeAttribute('id'); c.querySelectorAll('[id]').forEach((x) => x.removeAttribute('id')); c.querySelectorAll('details:not([open])').forEach((dt) => [...dt.children].forEach((x) => { if (x.tagName !== 'SUMMARY') x.remove(); })); c.querySelectorAll('button, input, select').forEach((x) => { if (x.matches('input, select')) x.replaceWith(Object.assign(document.createElement('span'), { textContent: x.value || '' })); }); box.appendChild(c); });
    box.insertAdjacentHTML('beforeend', `<div class="snap-f">Sumber: PPIC Gondowangi · dibuat ${esc(fmtDate(todayStr()))}</div>`);
    document.body.appendChild(box);
    try { return await h2c(box, { scale: 2, backgroundColor: '#ffffff', logging: false, useCORS: true }); }
    finally { box.remove(); }
  };
  window.PPIC_UI = { openDialog, toast, esc, fmtDate, todayStr, ymd, fld, workdaysSince };
  route();
  loadData();
  loadSupplier(false);
  setTimeout(() => loadMrp(false), 300);   // angka MRP di Beranda; halaman MRP langsung siap saat dibuka
})();
