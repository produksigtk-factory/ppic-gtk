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
    wait: { label: 'Dijadwalkan', cls: 'b-wait' },
    none: { label: 'Belum dijadwalkan', cls: 'b-none' },
  };

  /* ---------- Menu & halaman ---------- */
  // Menu baru cukup ditambah di sini + <section id="view-..."> di index.html + link di menu samping.
  const ROUTES = {
    'beranda':       { view: 'view-beranda',       crumb: 'Monitoring Pekerjaan PPIC', title: 'Beranda',        po: false },
    'po/monitoring': { view: 'view-po-monitoring', crumb: 'Purchase Order',            title: 'Monitoring PO',  po: true },
    'po/update':     { view: 'view-po-update',     crumb: 'Purchase Order',            title: 'Update Data PO', po: true },
  };
  function route() {
    const key = location.hash.replace(/^#\/?/, '') || 'beranda';
    const r = ROUTES[key] || ROUTES.beranda;
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== r.view; });
    document.querySelectorAll('.menu-item').forEach((a) => {
      const on = a.dataset.route === (ROUTES[key] ? key : 'beranda');
      a.classList.toggle('is-active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    $('crumb').textContent = r.crumb;
    $('pageTitle').textContent = r.title;
    $('poActions').hidden = !r.po;
    document.title = `${r.title} · PPIC Gondowangi`;
    closeMenu();
    window.scrollTo(0, 0);
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
    const rows = state.rows;
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
    $('hLate').textContent = nf.format(rows.filter((r) => r.status === 'late').length);
    $('hWeek').textContent = nf.format(week);
  }

  if (CFG.SHEET_URL) $('lnkSheet').href = CFG.SHEET_URL; else $('lnkSheet').hidden = true;

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
      buildRows(data.lines, data.schedules);
      const up = data.lastUpload ? `Upload terakhir ${data.lastUpload.time}` : 'Belum ada upload lewat website';
      $('dataInfo').textContent = `${up} · Data dibaca ${data.readAt}`;
      fillFilterOptions();
      render();
      renderHome();
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

      items.forEach(({ idx, l }, i) => {
        const qty = Number(l[6]) || 0;
        const isLast = i === items.length - 1;
        const rec = isLast ? remain : Math.min(qty, remain);   // penerimaan dibagi berurutan ke baris kode yang sama
        remain -= rec;
        const sisa = qty - rec;
        let status;
        if (qty > 0 && sisa <= 0) status = 'done';
        else if (hasLate) status = 'late';
        else if (pending.length) status = 'wait';
        else status = 'none';

        const date = normDate(l[1]);
        rows.push({
          key: k + '|' + l[10], idx,
          po: l[0], date, month: date.slice(0, 7), supplier: l[2], code: l[3], name: l[4], jenis: l[5],
          qty, uom: l[7], price: l[8], kurs: l[9], lineKe: l[10], dupCount: items.length,
          amount: l[8] === '' ? 0 : qty * Number(l[8]),
          pendingDates: pending.map((s) => s.date).filter(Boolean),
          rec, sisa, status, sched, next, today,
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
    fill($('fJenis'), uniq((r) => r.jenis), 'Semua jenis');
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

  // Semua saringan kecuali bulan (dipakai juga untuk angka di tab bulan)
  function filteredNoMonth() {
    const q = $('q').value.trim().toLowerCase();
    const jenis = $('fJenis').value, sup = $('fSupplier').value, kurs = $('fKurs').value, arr = $('fArrive').value;
    return state.rows.filter((r) =>
      (!q || q.split(/\s+/).every((w) => r.search.includes(w))) &&
      (!jenis || r.jenis === jenis) &&
      (!sup || r.supplier === sup) &&
      (!kurs || r.kurs === kurs) &&
      matchArrive(r, arr));
  }
  const byMonth = (rows) => { const m = activeMonth(); return m === 'all' ? rows : rows.filter((r) => r.month === m); };

  const byStatus = (rows, st) => st === 'all' ? rows
    : st === 'open' ? rows.filter((r) => r.status !== 'done')
    : rows.filter((r) => r.status === st);

  const SORTS = {
    'date-asc': (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.po < b.po ? -1 : a.po > b.po ? 1 : a.idx - b.idx),
    'date-desc': (a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : a.po > b.po ? -1 : a.po < b.po ? 1 : a.idx - b.idx),
    'next-asc': (a, b) => { const x = a.next ? a.next.date : '9999', y = b.next ? b.next.date : '9999'; return x < y ? -1 : x > y ? 1 : SORTS['date-asc'](a, b); },
    'sisa-desc': (a, b) => (b.sisa - a.sisa) || SORTS['date-asc'](a, b),
    'amount-desc': (a, b) => (b.amount - a.amount) || SORTS['date-asc'](a, b),
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
    if (state.status !== 'all') chips.push(['status', 'Status: ' + { open: 'Belum lengkap diterima', late: 'Jadwal lewat, belum datang', done: 'Sudah lengkap' }[state.status]]);
    if ($('q').value.trim()) chips.push(['q', `Cari: "${$('q').value.trim()}"`]);
    if ($('fSupplier').value) chips.push(['fSupplier', 'Supplier: ' + $('fSupplier').value]);
    if ($('fJenis').value) chips.push(['fJenis', 'Jenis: ' + $('fJenis').value]);
    if ($('fArrive').value) chips.push(['fArrive', 'Jadwal: ' + ARRIVE[$('fArrive').value]]);
    if ($('fKurs').value) chips.push(['fKurs', 'Kurs: ' + $('fKurs').value]);
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

    const rows = byStatus(base, state.status).slice().sort(SORTS[$('fSort').value] || SORTS['date-asc']);
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
    let html = `<tr class="row${open ? ' is-open' : ''}" data-key="${esc(r.key)}" tabindex="0" aria-expanded="${open}">
      <td class="po">${esc(r.po)}</td>
      <td class="date">${fmtDate(r.date)}</td>
      <td class="supplier">${esc(r.supplier)}</td>
      <td><div class="mat-name">${esc(r.name)}</div><div class="mat-code">${esc(r.code)}${r.jenis ? ' · ' + esc(r.jenis) : ''}</div>${note}</td>
      <td class="num">${fmtNum(r.qty)} ${esc(r.uom)}</td>
      <td class="num">${fmtNum(r.rec)}</td>
      <td class="num">${r.sisa > 0 ? fmtNum(r.sisa) : '0'}</td>
      <td>${stripHtml(r)}</td>
      <td class="date">${next}</td>
      <td><span class="badge ${st.cls}">${st.label}</span></td>
    </tr>`;
    if (open) html += detailHtml(r);
    return html;
  }

  function detailHtml(r) {
    const amount = r.price === '' ? '–' : fmtNum(r.qty * r.price);
    const rows = r.sched.length ? r.sched.map((s) => {
      const late = s.status !== 'Done' && s.date && s.date < r.today;
      return `<tr class="${late ? 'is-late' : ''}"><td>${s.n}</td><td>${fmtDate(s.date)}</td>
        <td class="num">${fmtNum(s.qty)}</td><td class="num">${fmtNum(s.rec)}</td><td>${esc(s.status)}${late ? ' (lewat jadwal)' : ''}</td></tr>`;
    }).join('') : '<tr><td colspan="5">Belum ada jadwal pengiriman di Odoo.</td></tr>';
    const dup = r.dupCount > 1
      ? `<p class="hint">Kode ${esc(r.code)} muncul ${r.dupCount}× di ${esc(r.po)}. Odoo tidak membedakan jadwalnya, jadwal di bawah adalah gabungan; qty diterima dibagi berurutan ke tiap baris.</p>` : '';
    return `<tr class="detail"><td colspan="10"><div class="detail-box">
      <div class="detail-meta">
        <span>Harga satuan <b>${r.price === '' ? '–' : fmtNum(r.price)} ${esc(r.kurs)}</b></span>
        <span>Nilai PO baris ini <b>${amount} ${esc(r.kurs)}</b></span>
        <span>Progres <b>${r.qty ? Math.round(Math.min(r.rec, r.qty) / r.qty * 100) : 0}%</b></span>
      </div>
      <table class="sched"><thead><tr><th>Jadwal ke</th><th>Tanggal</th><th class="num">Qty jadwal</th><th class="num">Qty diterima</th><th>Status Odoo</th></tr></thead>
      <tbody>${rows}</tbody></table>${dup}
    </div></td></tr>`;
  }

  /* ---------- Interaksi monitoring ---------- */
  $('statusRow').addEventListener('click', (e) => {
    const b = e.target.closest('.stat'); if (!b) return;
    state.status = b.dataset.status; state.shown = PAGE; render();
  });
  let t;
  $('q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { state.shown = PAGE; render(); }, 200); });
  ['fJenis', 'fSupplier', 'fKurs', 'fArrive', 'fSort'].forEach((id) =>
    $(id).addEventListener('change', () => { state.shown = PAGE; render(); }));

  $('monthBar').addEventListener('click', (e) => {
    const b = e.target.closest('.month'); if (!b) return;
    state.month = b.dataset.month; state.shown = PAGE; state.openKey = null; render();
  });

  $('activeFilters').addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    const k = c.dataset.clear;
    if (k === 'month') state.month = 'all';
    else if (k === 'status') state.status = 'all';
    else $(k).value = '';
    state.shown = PAGE; render();
  });

  $('btnReset').addEventListener('click', () => {
    ['q', 'fJenis', 'fSupplier', 'fKurs', 'fArrive'].forEach((id) => { $(id).value = ''; });
    $('fSort').value = 'date-asc';
    state.status = 'all'; state.month = null; state.shown = PAGE; state.openKey = null; state.monthScrolled = false; render();
  });
  $('btnMore').addEventListener('click', () => { state.shown += PAGE; render(); });
  $('btnReload').addEventListener('click', loadData);

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
      'Diterima': r.rec, 'Sisa': Math.max(0, r.sisa), 'Jumlah Jadwal': r.sched.length,
      'Jadwal Berikutnya': r.next ? r.next.date : '', 'Qty Jadwal Berikutnya': r.next ? r.next.qty : '',
      'Status': STATUS[r.status].label,
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Monitoring PO');
    XLSX.writeFile(wb, `Monitoring_PO_${todayStr()}.xlsx`);
  });

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
      $('btnSend').disabled = !(state.parsedDet || state.parsedDel);
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
    const body = { pin };
    if (state.parsedDet) { body.lines = state.parsedDet.rows; body.detName = state.parsedDet.fileName; }
    if (state.parsedDel) { body.schedules = state.parsedDel.rows; body.delPOs = [...state.parsedDel.pos]; body.delName = state.parsedDel.fileName; }

    $('btnSend').disabled = true;
    out.className = 'send-result'; out.textContent = 'Mengirim ke Google Sheet… jangan tutup halaman ini.';
    try {
      const res = await fetch(CFG.APPS_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      const r = data.result, li = [];
      if (r.lines) li.push(`PO-DET: ${nf.format(r.lines.rows)} baris masuk (${nf.format(r.lines.poBaru)} PO baru, ${nf.format(r.lines.poDiperbarui)} PO diperbarui).`);
      if (r.schedules) li.push(`PO-DEL: ${nf.format(r.schedules.rows)} jadwal masuk untuk ${nf.format(r.schedules.poDiganti)} PO.`);
      out.className = 'send-result ok';
      out.innerHTML = `Terkirim ke Google Sheet pada ${esc(data.time)}.<ul>${li.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
      ['fileDet', 'fileDel'].forEach((id) => { $(id).value = ''; });
      ['nameDet', 'nameDel'].forEach((id) => { $(id).textContent = 'Belum ada file'; });
      ['checkDet', 'checkDel'].forEach((id) => { $(id).textContent = ''; });
      state.parsedDet = state.parsedDel = null;
      loadData();
    } catch (err) {
      out.className = 'send-result err';
      out.textContent = 'Gagal mengirim: ' + err.message;
      $('btnSend').disabled = false;
    }
  });

  route();
  loadData();
})();
