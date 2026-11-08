/**
 * PPIC Gondowangi — penghubung website <-> Google Sheet "MRP PPIC GTK" (PROJECT 2: MRP)
 *
 * Dipasang di: MRP PPIC GTK → Extensions → Apps Script (terpisah dari Apps Script MONITORING PO).
 * - doGet  : website membaca BOM, master material, dan PEMBAGIAN_WEEK dari DATABASE PPIC GTK,
 *            serta isi tab perencanaan di file ini (SKU_MRP, RENCANA_PRODUKSI, REALISASI_PRODUKSI, STOK,
 *            STOK_KOREKSI, INCOMING_MANUAL, LOG_MRP).
 * - doPost : simpan rencana produksi (plan & rincian per tanggal), realisasi produksi, default BOM bulanan, parameter SKU, upload stok, koreksi stok, dan incoming manual
 *            dari website. Semua dilindungi PIN.
 *
 * PIN diatur di: Project Settings → Script Properties → UPLOAD_PIN (boleh sama dengan PIN MONITORING PO).
 * Pemasangan pertama: Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone → Deploy,
 *                     lalu kirim alamat Web app (…/exec) untuk dipasang di website.
 * Setelah kode diganti: Deploy → Manage deployments → Edit (ikon pensil) → Version: New version → Deploy.
 */

const MRP_CONFIG = {
  DATABASE_ID: '1Qp8FkQXPLtV89e9NBoIMY5oLY6_DXLzQEr3HemkHI6g', // DATABASE PPIC GTK
  MASTER_SHEET: 'MASTER_MATERIAL',
  BOM_SHEET: 'BOM_LIST',
  BOM_DETAIL_SHEET: 'BOM_DETAIL',
  WEEK_SHEET: 'PEMBAGIAN_WEEK',
  // Tab di file MRP ini
  SKU_SHEET: 'SKU_MRP',
  PLAN_SHEET: 'RENCANA_PRODUKSI',
  REAL_SHEET: 'REALISASI_PRODUKSI',
  BOMMON_SHEET: 'BOM_DEFAULT_BULANAN',
  STOCK_SHEET: 'STOK',
  ADJ_SHEET: 'STOK_KOREKSI',
  INC_SHEET: 'INCOMING_MANUAL',
  LOG_SHEET: 'LOG_MRP',
};

// Judul kolom tiap tab + kolom yang harus berformat teks (supaya "01" / "2026-11" tidak diubah Google Sheet)
const MRP_HEAD = {
  SKU_MRP: { head: ['KODE', 'NAMA', 'JENIS', 'BOM ID AKTIF', 'UKURAN BATCH (KG)', 'AKTIF', 'CATATAN', 'DIUBAH'], text: [1, 2, 3, 4, 5, 6, 7, 8] },
  // BOM ID       : BOM SKU yang dikunci untuk week ini
  // RINCIAN PLAN : qty per tanggal + BOM-nya, mis. "2026-11-03=300|BOM-0161|14291:BOM-0015;2026-11-05=200|BOM-0161|14291:BOM-0013"
  //                (kosong = hanya total per week; BOM kosong di rincian = ikut BOM week)
  // BOM EKSTRAK  : BOM ekstrak/bulk yang dikunci untuk week ini, mis. "14291:BOM-0015,14265:BOM-0005"
  RENCANA_PRODUKSI: { head: ['BULAN', 'WEEK', 'KODE', 'QTY KG', 'BOM ID', 'SUMBER', 'DIUBAH', 'RINCIAN PLAN (TGL=QTY|BOM|EKSTRAK)', 'BOM EKSTRAK'], text: [1, 2, 3, 5, 6, 7, 8, 9] },
  // Default BOM per bulan (SKU & ekstrak). Bulan tanpa baris = ikut bulan sebelumnya, lalu Parameter SKU.
  BOM_DEFAULT_BULANAN: { head: ['BULAN', 'KODE', 'BOM ID', 'REFERENCE', 'DIUBAH'], text: [1, 2, 3, 4, 5] },
  // Satu baris = realisasi satu SKU pada satu tanggal (week = week rencana yang dibandingkan)
  REALISASI_PRODUKSI: { head: ['BULAN', 'WEEK', 'KODE', 'TANGGAL', 'QTY REALISASI', 'SUMBER', 'DIUBAH'], text: [1, 2, 3, 4, 6, 7] },
  STOK: { head: ['TANGGAL STOK', 'KODE', 'NAMA', 'QTY', 'UoM', 'SUMBER', 'CATATAN'], text: [1, 2, 3, 5, 6, 7] },
  STOK_KOREKSI: { head: ['ID', 'TANGGAL', 'KODE', 'QTY (+/-)', 'ALASAN', 'DIBUAT'], text: [1, 2, 3, 5, 6] },
  INCOMING_MANUAL: { head: ['ID', 'BULAN', 'WEEK', 'KODE', 'QTY (+/-)', 'KETERANGAN', 'DIBUAT'], text: [1, 2, 3, 4, 6, 7] },
  LOG_MRP: { head: ['WAKTU', 'AKSI', 'RINGKASAN'], text: [1, 2, 3] },
};

/* ================= Baca data ================= */

function doGet(e) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tz = ss.getSpreadsheetTimeZone();
    // BOM, master, dan week dari DATABASE PPIC GTK jarang berubah: disimpan di cache Apps Script 10 menit.
    // Tombol "Muat ulang data" di website mengirim fresh=1 sehingga selalu dibaca langsung.
    const D = dbData_(tz, e && e.parameter && e.parameter.fresh === '1');
    const master = D.master, boms = D.boms, details = D.details, weeks = D.weeks;

    const skus = rows_(ss.getSheetByName(MRP_CONFIG.SKU_SHEET), 8)
      .map(r => [s_(r[0]), s_(r[1]), s_(r[2]), s_(r[3]), s_(r[4]), s_(r[5]), s_(r[6]), d_(r[7], tz, 'yyyy-MM-dd HH:mm')]);
    // plan: [bulan, week, kode, qty, bomId, sumber, diubah, rincianPlan, bomEkstrak]
    const plan = rows_(ss.getSheetByName(MRP_CONFIG.PLAN_SHEET), 9)
      .map(r => [d_(r[0], tz, 'yyyy-MM'), s_(r[1]), s_(r[2]), n_(r[3]), s_(r[4]), s_(r[5]), d_(r[6], tz, 'yyyy-MM-dd HH:mm'), s_(r[7]), s_(r[8])]);
    // real: [bulan, week, kode, tanggal, qty, sumber, diubah]
    const real = rows_(ss.getSheetByName(MRP_CONFIG.REAL_SHEET), 7)
      .map(r => [d_(r[0], tz, 'yyyy-MM'), s_(r[1]), s_(r[2]), d_(r[3], tz, 'yyyy-MM-dd'), n_(r[4]), s_(r[5]), d_(r[6], tz, 'yyyy-MM-dd HH:mm')]);
    const stock = rows_(ss.getSheetByName(MRP_CONFIG.STOCK_SHEET), 7)
      .map(r => [d_(r[0], tz, 'yyyy-MM-dd'), s_(r[1]), s_(r[2]), n_(r[3]), s_(r[4]), s_(r[5]), s_(r[6])]);
    const adj = rows_(ss.getSheetByName(MRP_CONFIG.ADJ_SHEET), 6)
      .map(r => [s_(r[0]), d_(r[1], tz, 'yyyy-MM-dd'), s_(r[2]), n_(r[3]), s_(r[4]), d_(r[5], tz, 'yyyy-MM-dd HH:mm')]);
    const inc = rows_(ss.getSheetByName(MRP_CONFIG.INC_SHEET), 7)
      .map(r => [s_(r[0]), d_(r[1], tz, 'yyyy-MM'), s_(r[2]), s_(r[3]), n_(r[4]), s_(r[5]), d_(r[6], tz, 'yyyy-MM-dd HH:mm')]);
    // bomMon: [bulan, kode, bomId, reference, diubah]
    const bomMon = rows_(ss.getSheetByName(MRP_CONFIG.BOMMON_SHEET), 5)
      .map(r => [d_(r[0], tz, 'yyyy-MM'), s_(r[1]), s_(r[2]), s_(r[3]), d_(r[4], tz, 'yyyy-MM-dd HH:mm')]);
    const log = rows_(ss.getSheetByName(MRP_CONFIG.LOG_SHEET), 3)
      .map(r => [d_(r[0], tz, 'yyyy-MM-dd HH:mm'), s_(r[1]), s_(r[2])]).slice(-60).reverse();

    return json_({
      ok: true, version: 5, master, boms, details, weeks, skus, plan, real, bomMon, stock, adj, inc, log,
      databaseUrl: D.dbUrl, mrpUrl: ss.getUrl(), cached: !!D.cached,
      readAt: Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm'),
    });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

// master  : [kode, nama, uom, kategori]
// boms    : [bomId, kodeProduk, namaProduk, qtyBatch, uom, reference, jumlahKomponen, catatan]
// details : [bomId, kodeMaterial, namaMaterial, qtyMaterial, uom, kategori]
// weeks   : [bulan yyyy-MM, week, tanggal awal, tanggal akhir] — diringkas dari PEMBAGIAN_WEEK
function dbData_(tz, fresh) {
  const cache = CacheService.getScriptCache();
  if (!fresh) {
    const hit = getBig_(cache, 'mrp_db');
    if (hit) { hit.cached = true; return hit; }
  }
  const db = SpreadsheetApp.openById(MRP_CONFIG.DATABASE_ID);
  const master = rows_(db.getSheetByName(MRP_CONFIG.MASTER_SHEET), 4)
    .map(r => [s_(r[0]), s_(r[1]), s_(r[2]), s_(r[3])]);
  const boms = rows_(db.getSheetByName(MRP_CONFIG.BOM_SHEET), 8)
    .map(r => [s_(r[0]), s_(r[1]), s_(r[2]), n_(r[3]), s_(r[4]), s_(r[5]), n_(r[6]), s_(r[7])]);
  const details = rows_(db.getSheetByName(MRP_CONFIG.BOM_DETAIL_SHEET), 10)
    .map(r => [s_(r[0]), s_(r[5]), s_(r[6]), n_(r[7]), s_(r[8]), s_(r[9])]);
  const weeks = [];
  rows_(db.getSheetByName(MRP_CONFIG.WEEK_SHEET), 4).forEach(r => {
    const d = d_(r[0], tz, 'yyyy-MM-dd'), w = s_(r[2]), b = d_(r[3], tz, 'yyyy-MM') || d.slice(0, 7);
    if (!d || !w) return;
    const last = weeks[weeks.length - 1];
    if (last && last[0] === b && last[1] === w) last[3] = d; else weeks.push([b, w, d, d]);
  });
  const out = { master, boms, details, weeks, dbUrl: db.getUrl() };
  putBig_(cache, 'mrp_db', out, 600);
  out.cached = false;
  return out;
}
// Cache Apps Script maksimal 100 KB per kunci: data dipecah beberapa kunci
function putBig_(cache, key, obj, ttl) {
  try {
    const s = JSON.stringify(obj), size = 90000, parts = {};
    const n = Math.ceil(s.length / size);
    if (n > 60) return;                                   // terlalu besar: tidak di-cache
    for (let i = 0; i < n; i++) parts[key + '_' + i] = s.slice(i * size, (i + 1) * size);
    parts[key + '_n'] = String(n);
    cache.putAll(parts, ttl);
  } catch (e) { /* cache gagal: data tetap dibaca langsung */ }
}
function getBig_(cache, key) {
  try {
    const n = Number(cache.get(key + '_n'));
    if (!n) return null;
    const keys = []; for (let i = 0; i < n; i++) keys.push(key + '_' + i);
    const got = cache.getAll(keys);
    let s = '';
    for (let i = 0; i < n; i++) { if (got[keys[i]] == null) return null; s += got[keys[i]]; }
    return JSON.parse(s);
  } catch (e) { return null; }
}

/* ================= Tulis data ================= */

function doPost(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return json_({ ok: false, error: 'Sedang ada proses lain yang berjalan. Coba lagi dalam satu menit.' });
  try {
    const body = JSON.parse(e.postData.contents);
    const pin = PropertiesService.getScriptProperties().getProperty('UPLOAD_PIN');
    if (!pin) return json_({ ok: false, error: 'PIN belum diatur. Isi UPLOAD_PIN di Apps Script MRP → Project Settings → Script Properties.' });
    if (String(body.pin || '') !== String(pin)) return json_({ ok: false, error: 'PIN salah. Periksa lagi PIN Anda.' });
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tz = ss.getSpreadsheetTimeZone();
    const now = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm');
    const action = body.action || '';
    let res;
    if (action === 'verify') return json_({ ok: true });
    else if (action === 'savePlan') res = savePlan_(ss, body.cells || [], now);
    else if (action === 'saveBomMon') res = saveBomMon_(ss, body.cells || [], now);
    else if (action === 'saveReal') res = saveReal_(ss, body.cells || [], now);
    else if (action === 'replacePlan') res = replacePlan_(ss, body.months || [], body.rows || [], body.file || '', now);
    else if (action === 'saveSku') res = saveSku_(ss, body.sku || {}, now);
    else if (action === 'uploadStock') res = uploadStock_(ss, body.date, body.rows || [], body.file || '', now);
    else if (action === 'addAdj') res = addAdj_(ss, body, now);
    else if (action === 'addInc') res = addInc_(ss, body, now);
    else if (action === 'delRow') res = delRow_(ss, body.kind, body.id, now);
    else return json_({ ok: false, error: 'Aksi tidak dikenal: ' + action });
    return json_(Object.assign({ ok: true, time: now }, res || {}));
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

// Simpan beberapa sel rencana sekaligus (dari edit per sel di website). kg kosong/0 tanpa BOM = baris dihapus.
function savePlan_(ss, cells, now) {
  const sh = sheet_(ss, MRP_CONFIG.PLAN_SHEET);
  const last = sh.getLastRow();
  const cur = last > 1 ? sh.getRange(2, 1, last - 1, 9).getDisplayValues() : [];
  const idx = new Map(cur.map((r, i) => [r[0] + '|' + r[1] + '|' + r[2], i + 2]));
  const oldRinci = new Map(cur.map(r => [r[0] + '|' + r[1] + '|' + r[2], r[7]]));
  const oldEk = new Map(cur.map(r => [r[0] + '|' + r[1] + '|' + r[2], r[8]]));
  const del = [], add = [];
  let n = 0;
  cells.forEach(c => {
    const bulan = s_(c.bulan), week = s_(c.week), kode = s_(c.kode);
    if (!/^\d{4}-\d{2}$/.test(bulan) || !/^W[1-5]$/.test(week) || !kode) return;
    let kg = c.kg === '' || c.kg === null || c.kg === undefined ? '' : Number(c.kg);
    const bom = s_(c.bom);
    const key = bulan + '|' + week + '|' + kode;
    // rinci tidak dikirim = rincian lama dipertahankan selama totalnya masih sama; array = diganti
    let rinci;
    if (Array.isArray(c.rinci)) {
      const items = planRinciParse_(c.rinci);
      rinci = planRinciText_(items);
      if (items.length) kg = items.reduce((t, x) => t + x[1], 0);
    } else {
      const old = planRinciParse_(s_(oldRinci.get(key)));
      const sum = old.reduce((t, x) => t + x[1], 0);
      rinci = old.length && Math.abs(sum - (Number(kg) || 0)) < 1e-9 ? planRinciText_(old) : '';
    }
    // ek tidak dikirim = kunci BOM ekstrak lama dipertahankan
    const ek = c.ek === undefined ? s_(oldEk.get(key)) : ekText_(c.ek);
    const row = [bulan, week, kode, kg === '' || isNaN(kg) ? '' : kg, bom, 'Website', now, rinci, ek];
    const at = idx.get(key);
    const empty = !(Number(kg) > 0) && !bom;
    if (at) { if (empty) del.push(at); else sh.getRange(at, 1, 1, 9).setValues([row]); }
    else if (!empty) add.push(row);
    n++;
  });
  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, 9).setValues(add);
  del.sort((a, b) => b - a).forEach(r => sh.deleteRow(r));
  if (n === 1) {
    const c = cells[0];
    log_(ss, now, 'Edit rencana', `${c.kode} ${c.bulan} ${c.week}: ${c.kg === '' ? 'dikosongkan' : c.kg + ' kg'}${Array.isArray(c.rinci) ? ' · rincian ' + (planRinciText_(planRinciParse_(c.rinci)) || 'dikosongkan') : ''}${c.ek !== undefined ? ' · ekstrak ' + (ekText_(c.ek) || '-') : ''}`);
  } else if (n) log_(ss, now, 'Edit rencana', `${n} sel diubah`);
  return { saved: n };
}

// Upload rencana: semua baris di bulan yang ada di file diganti dengan isi file
function replacePlan_(ss, months, rows, file, now) {
  const sh = sheet_(ss, MRP_CONFIG.PLAN_SHEET);
  const mset = new Set(months.map(s_));
  const last = sh.getLastRow();
  const tz = ss.getSpreadsheetTimeZone();
  const old = last > 1 ? sh.getRange(2, 1, last - 1, 9).getValues()
    .map(r => [d_(r[0], tz, 'yyyy-MM'), s_(r[1]), s_(r[2]), n_(r[3]), s_(r[4]), s_(r[5]), d_(r[6], tz, 'yyyy-MM-dd HH:mm'), s_(r[7]), s_(r[8])])
    .filter(r => r[0]) : [];
  const keep = old.filter(r => !mset.has(r[0]));
  // Rincian per tanggal dipertahankan bila total di file sama dengan jumlah rinciannya; selain itu dikosongkan
  const rOld = new Map(old.map(r => [r[0] + '|' + r[1] + '|' + r[2], planRinciParse_(r[7])]));
  const keepRinci = (k, kg) => { const it = rOld.get(k) || []; const sum = it.reduce((t, x) => t + x[1], 0); return it.length && Math.abs(sum - kg) < 1e-9 ? planRinciText_(it) : ''; };
  // rows: [bulan, week, kode, qty, bomSku, bomEkstrak] — kunci BOM dikirim website (kunci lama / default Parameter SKU)
  const fresh = rows.map(r => [s_(r[0]), s_(r[1]), s_(r[2]), Number(r[3]) || 0, s_(r[4]), 'Upload' + (file ? ': ' + file : ''), now,
    keepRinci(s_(r[0]) + '|' + s_(r[1]) + '|' + s_(r[2]), Number(r[3]) || 0), ekText_(r[5] || '')])
    .filter(r => mset.has(r[0]) && /^W[1-5]$/.test(r[1]) && r[2] && r[3] > 0);
  const all = keep.concat(fresh);
  if (last > 1) sh.getRange(2, 1, last - 1, 9).clearContent();
  if (all.length) sh.getRange(2, 1, all.length, 9).setValues(all);
  log_(ss, now, 'Upload rencana', `${file || 'file'} · bulan ${[...mset].join(', ')} · ${fresh.length} sel`);
  return { saved: fresh.length };
}

// Realisasi produksi: tiap sel (SKU + week) dikirim lengkap sebagai daftar [tanggal, qty]; baris lama sel itu diganti.
// Daftar kosong = realisasi sel itu dihapus. Catatan: realisasi belum dipakai di hitungan kebutuhan/proyeksi.
function saveReal_(ss, cells, now) {
  const sh = sheet_(ss, MRP_CONFIG.REAL_SHEET);
  const tz = ss.getSpreadsheetTimeZone();
  const last = sh.getLastRow();
  const cur = last > 1 ? sh.getRange(2, 1, last - 1, 7).getValues()
    .map(r => [d_(r[0], tz, 'yyyy-MM'), s_(r[1]), s_(r[2]), d_(r[3], tz, 'yyyy-MM-dd'), r[4], s_(r[5]), d_(r[6], tz, 'yyyy-MM-dd HH:mm')])
    .filter(r => r[0]) : [];
  const touched = new Set(), add = [];
  const notes = [];
  cells.forEach(c => {
    const bulan = s_(c.bulan), week = s_(c.week), kode = s_(c.kode);
    if (!/^\d{4}-\d{2}$/.test(bulan) || !/^W[1-5]$/.test(week) || !kode) return;
    const items = rinciParse_(c.items || []);
    touched.add(bulan + '|' + week + '|' + kode);
    items.forEach(x => add.push([bulan, week, kode, x[0], x[1], 'Website', now]));
    notes.push(`${kode} ${bulan} ${week}: ${rinciText_(items) || 'dikosongkan'}`);
  });
  if (!touched.size) return { saved: 0 };
  const all = cur.filter(r => !touched.has(r[0] + '|' + r[1] + '|' + r[2])).concat(add);
  all.sort((a, b) => (a[0] + a[1] + a[2] + a[3]).localeCompare(b[0] + b[1] + b[2] + b[3]));
  if (last > 1) sh.getRange(2, 1, last - 1, 7).clearContent();
  if (all.length) sh.getRange(2, 1, all.length, 7).setValues(all);
  log_(ss, now, 'Edit realisasi', notes.length === 1 ? notes[0] : `${notes.length} sel diubah`);
  return { saved: touched.size };
}
// Default BOM per bulan: cells [{bulan, kode, bom, ref}] — bom kosong = baris dihapus (ikut bulan sebelumnya)
function saveBomMon_(ss, cells, now) {
  const sh = sheet_(ss, MRP_CONFIG.BOMMON_SHEET);
  const tz = ss.getSpreadsheetTimeZone();
  const last = sh.getLastRow();
  const cur = last > 1 ? sh.getRange(2, 1, last - 1, 5).getValues()
    .map(r => [d_(r[0], tz, 'yyyy-MM'), s_(r[1]), s_(r[2]), s_(r[3]), d_(r[4], tz, 'yyyy-MM-dd HH:mm')]).filter(r => r[0]) : [];
  const map = new Map(cur.map(r => [r[0] + '|' + r[1], r]));
  const notes = [];
  cells.forEach(c => {
    const bulan = s_(c.bulan), kode = s_(c.kode), bom = s_(c.bom);
    if (!/^\d{4}-\d{2}$/.test(bulan) || !kode) return;
    if (bom) map.set(bulan + '|' + kode, [bulan, kode, bom, s_(c.ref), now]); else map.delete(bulan + '|' + kode);
    notes.push(`${kode} ${bulan}: ${bom ? (s_(c.ref) || bom) : 'ikut bulan sebelumnya'}`);
  });
  const all = [...map.values()].sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
  if (last > 1) sh.getRange(2, 1, last - 1, 5).clearContent();
  if (all.length) sh.getRange(2, 1, all.length, 5).setValues(all);
  if (notes.length) log_(ss, now, 'Default BOM bulanan', notes.length === 1 ? notes[0] : `${notes.length} perubahan`);
  return { saved: notes.length };
}
// Rincian per tanggal: [[tgl, qty], ...] atau teks "tgl=qty;tgl=qty" → [[tgl, qty]] terurut, qty > 0
function rinciParse_(v) {
  const list = Array.isArray(v) ? v : s_(v).split(';').filter(Boolean).map(x => x.split('='));
  const m = new Map();
  list.forEach(x => {
    const tgl = s_(x[0]), qty = Number(String(x[1] === undefined ? '' : x[1]).replace(',', '.'));
    if (!tgl && !qty) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tgl)) throw new Error('Format tanggal tidak dikenal: ' + tgl);
    if (isNaN(qty) || qty < 0) throw new Error('Qty harus angka: ' + x[1]);
    if (qty > 0) m.set(tgl, (m.get(tgl) || 0) + qty);
  });
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}
function rinciText_(items) { return items.map(x => x[0] + '=' + x[1]).join(';'); }
// Kunci BOM ekstrak: {kode: bomId} / [[kode, bomId]] / teks "kode:BOM,kode:BOM" → teks terurut
function ekText_(v) {
  let list;
  if (Array.isArray(v)) list = v;
  else if (v && typeof v === 'object') list = Object.keys(v).map(k => [k, v[k]]);
  else list = s_(v).split(',').filter(Boolean).map(x => x.split(':'));
  return list.map(x => [s_(x[0]), s_(x[1])]).filter(x => x[0] && x[1]).sort((a, b) => a[0].localeCompare(b[0]))
    .map(x => x[0] + ':' + x[1]).join(',');
}
// Rincian plan: [[tgl, qty, bomSku, ek], ...] atau teks "tgl=qty|BOM|ek;..." → [[tgl, qty, bom, ekText]] terurut, qty > 0
function planRinciParse_(v) {
  const list = Array.isArray(v) ? v : s_(v).split(';').filter(Boolean).map(x => {
    const [a, bom, ek] = x.split('|'); const [t, q] = a.split('='); return [t, q, bom, ek];
  });
  const m = new Map();
  list.forEach(x => {
    const tgl = s_(x[0]), qty = Number(String(x[1] === undefined ? '' : x[1]).replace(',', '.'));
    if (!tgl && !qty) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tgl)) throw new Error('Format tanggal tidak dikenal: ' + tgl);
    if (isNaN(qty) || qty < 0) throw new Error('Qty harus angka: ' + x[1]);
    if (qty > 0) m.set(tgl, [tgl, qty, s_(x[2]), ekText_(x[3] || '')]);
  });
  return [...m.values()].sort((a, b) => a[0].localeCompare(b[0]));
}
function planRinciText_(items) { return items.map(x => x[0] + '=' + x[1] + (x[2] || x[3] ? '|' + (x[2] || '') + '|' + (x[3] || '') : '')).join(';'); }

function saveSku_(ss, k, now) {
  const kode = s_(k.kode);
  if (!kode) throw new Error('Kode SKU wajib diisi.');
  const sh = sheet_(ss, MRP_CONFIG.SKU_SHEET);
  const last = sh.getLastRow();
  const codes = last > 1 ? sh.getRange(2, 1, last - 1, 1).getDisplayValues().map(r => r[0]) : [];
  const at = codes.indexOf(kode);
  const row = [kode, s_(k.nama), s_(k.jenis) || 'SKU', s_(k.bom), s_(k.batch), (s_(k.aktif) || 'Y').toUpperCase() === 'N' ? 'N' : 'Y', s_(k.catatan), now];
  if (at >= 0) sh.getRange(at + 2, 1, 1, 8).setValues([row]);
  else sh.getRange(last + 1, 1, 1, 8).setValues([row]);
  log_(ss, now, at >= 0 ? 'Ubah SKU' : 'Tambah SKU', `${kode} · BOM ${row[3] || '-'} · batch ${row[4] || '-'} · aktif ${row[5]}`);
  return {};
}

// Upload stok: snapshot lama diganti seluruhnya
function uploadStock_(ss, date, rows, file, now) {
  const tgl = s_(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tgl)) throw new Error('Tanggal stok wajib diisi.');
  const sh = sheet_(ss, MRP_CONFIG.STOCK_SHEET);
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, 7).clearContent();
  const out = rows.map(r => [tgl, s_(r[0]), s_(r[1]), Number(r[2]) || 0, s_(r[3]), 'Upload' + (file ? ': ' + file : ''), ''])
    .filter(r => r[1]);
  if (out.length) sh.getRange(2, 1, out.length, 7).setValues(out);
  log_(ss, now, 'Upload stok', `${file || 'file'} · per ${tgl} · ${out.length} material`);
  return { saved: out.length };
}

function addAdj_(ss, b, now) {
  const kode = s_(b.kode), qty = Number(b.qty);
  if (!kode || !qty) throw new Error('Kode dan qty koreksi wajib diisi.');
  if (!s_(b.alasan)) throw new Error('Alasan koreksi wajib diisi.');
  const sh = sheet_(ss, MRP_CONFIG.ADJ_SHEET);
  const id = 'K' + Date.now();
  sh.getRange(sh.getLastRow() + 1, 1, 1, 6).setValues([[id, s_(b.tanggal) || now.slice(0, 10), kode, qty, s_(b.alasan), now]]);
  log_(ss, now, 'Koreksi stok', `${kode} ${qty > 0 ? '+' : ''}${qty} · ${s_(b.alasan)}`);
  return { id };
}

function addInc_(ss, b, now) {
  const kode = s_(b.kode), qty = Number(b.qty);
  if (!kode || !qty) throw new Error('Kode dan qty incoming wajib diisi.');
  if (!/^\d{4}-\d{2}$/.test(s_(b.bulan)) || !/^W[1-5]$/.test(s_(b.week))) throw new Error('Pilih bulan dan week.');
  if (!s_(b.ket)) throw new Error('Keterangan wajib diisi.');
  const sh = sheet_(ss, MRP_CONFIG.INC_SHEET);
  const id = 'I' + Date.now();
  sh.getRange(sh.getLastRow() + 1, 1, 1, 7).setValues([[id, s_(b.bulan), s_(b.week), kode, qty, s_(b.ket), now]]);
  log_(ss, now, 'Incoming manual', `${kode} ${qty > 0 ? '+' : ''}${qty} · ${s_(b.bulan)} ${s_(b.week)} · ${s_(b.ket)}`);
  return { id };
}

function delRow_(ss, kind, id, now) {
  const name = kind === 'adj' ? MRP_CONFIG.ADJ_SHEET : kind === 'inc' ? MRP_CONFIG.INC_SHEET : '';
  if (!name || !id) throw new Error('Baris yang dihapus tidak jelas.');
  const sh = sheet_(ss, name);
  const last = sh.getLastRow();
  const ids = last > 1 ? sh.getRange(2, 1, last - 1, 1).getDisplayValues().map(r => r[0]) : [];
  const at = ids.indexOf(String(id));
  if (at < 0) throw new Error('Baris sudah tidak ada. Muat ulang data.');
  const info = sh.getRange(at + 2, 1, 1, sh.getLastColumn()).getDisplayValues()[0].join(' · ');
  sh.deleteRow(at + 2);
  log_(ss, now, kind === 'adj' ? 'Hapus koreksi stok' : 'Hapus incoming manual', info);
  return {};
}

/* ================= Bantuan ================= */

// Ambil tab; kalau belum ada, dibuat lengkap dengan judul kolom dan format teks
function sheet_(ss, name) {
  let sh = ss.getSheetByName(name);
  const def = MRP_HEAD[name];
  if (!sh) {
    sh = ss.insertSheet(name);
    if (def) {
      sh.getRange(1, 1, 1, def.head.length).setValues([def.head]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  }
  // Kolom baru di versi terbaru (mis. TGL PLAN): tambahkan judulnya bila belum ada
  if (def && sh.getRange(1, def.head.length).getDisplayValue() === '') {
    if (sh.getMaxColumns() < def.head.length) sh.insertColumnsAfter(sh.getMaxColumns(), def.head.length - sh.getMaxColumns());
    sh.getRange(1, 1, 1, def.head.length).setValues([def.head]).setFontWeight('bold');
    def.text.forEach(c => sh.getRange(2, c, sh.getMaxRows() - 1, 1).setNumberFormat('@'));
  }
  if (def && !sh.getRange(2, def.text[0]).getNumberFormat().startsWith('@')) {
    def.text.forEach(c => sh.getRange(2, c, sh.getMaxRows() - 1, 1).setNumberFormat('@'));
  }
  return sh;
}
function log_(ss, now, aksi, ringkasan) {
  const sh = sheet_(ss, MRP_CONFIG.LOG_SHEET);
  sh.getRange(sh.getLastRow() + 1, 1, 1, 3).setValues([[now, aksi, ringkasan]]);
}
function rows_(sh, cols) {
  if (!sh) return [];
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, cols).getValues().filter(r => s_(r[0]) !== '');
}
function s_(v) { return String(v === null || v === undefined ? '' : v).trim(); }
function n_(v) { if (v === '' || v === null || v === undefined) return ''; const x = Number(v); return isNaN(x) ? '' : x; }
function d_(v, tz, f) {
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, tz, f);
  return s_(v);
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
