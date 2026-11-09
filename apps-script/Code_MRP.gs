/**
 * PPIC Gondowangi — penghubung website <-> Google Sheet "MRP PPIC GTK" (PROJECT 2: MRP)
 *
 * Dipasang di: MRP PPIC GTK → Extensions → Apps Script (terpisah dari Apps Script MONITORING PO).
 * - doGet  : website membaca BOM, master material, dan PEMBAGIAN_WEEK dari DATABASE PPIC GTK,
 *            serta isi tab perencanaan di file ini (SKU_MRP, RENCANA_PRODUKSI, STOK, STOK_GANTUNG, STOK_KOREKSI,
 *            INCOMING_MANUAL, KONFIRMASI_PRODUKSI, PC_CP_MO, LOG_MRP).
 * - doPost : simpan rencana produksi, parameter SKU, upload stok, koreksi stok, dan incoming manual
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
  STOCK_SHEET: 'STOK',
  GANTUNG_SHEET: 'STOK_GANTUNG',
  ADJ_SHEET: 'STOK_KOREKSI',
  INC_SHEET: 'INCOMING_MANUAL',
  LOG_SHEET: 'LOG_MRP',
  KONF_SHEET: 'KONFIRMASI_PRODUKSI',
  CONS_SHEET: 'PC_CP_MO',
  INCK_SHEET: 'KONFIRMASI_INCOMING',
};

// Judul kolom tiap tab + kolom yang harus berformat teks (supaya "01" / "2026-11" tidak diubah Google Sheet)
const MRP_HEAD = {
  SKU_MRP: { head: ['KODE', 'NAMA', 'JENIS', 'BOM ID AKTIF', 'UKURAN BATCH (KG)', 'AKTIF', 'CATATAN', 'DIUBAH'], text: [1, 2, 3, 4, 5, 6, 7, 8] },
  RENCANA_PRODUKSI: { head: ['BULAN', 'WEEK', 'KODE', 'QTY KG', 'BOM ID', 'SUMBER', 'DIUBAH'], text: [1, 2, 3, 5, 6, 7] },
  STOK: { head: ['TANGGAL STOK', 'KODE', 'NAMA', 'QTY', 'UoM', 'SUMBER', 'CATATAN'], text: [1, 2, 3, 5, 6, 7] },
  // Stok Gantung: stok yang ada tetapi tidak bisa dipakai (diupload sendiri). Stok Tersedia = Stok Awal − Stok Gantung.
  STOK_GANTUNG: { head: ['TANGGAL', 'KODE', 'NAMA', 'QTY', 'UoM', 'SUMBER', 'CATATAN'], text: [1, 2, 3, 5, 6, 7] },
  STOK_KOREKSI: { head: ['ID', 'TANGGAL', 'KODE', 'QTY (+/-)', 'ALASAN', 'DIBUAT'], text: [1, 2, 3, 5, 6] },
  INCOMING_MANUAL: { head: ['ID', 'BULAN', 'WEEK', 'KODE', 'QTY (+/-)', 'KETERANGAN', 'DIBUAT'], text: [1, 2, 3, 4, 6, 7] },
  LOG_MRP: { head: ['WAKTU', 'AKSI', 'RINGKASAN'], text: [1, 2, 3] },
  // Konfirmasi Produksi: satu baris = satu MO Odoo (dari LIST_MO). BOM ID & konversi kg dikunci saat disimpan.
  KONFIRMASI_PRODUKSI: { head: ['NO MO', 'KODE', 'NAMA PRODUK', 'QTY', 'UoM', 'BOM ID', 'KONVERSI KG', 'BULAN', 'WEEK', 'KODE EKSTRAK', 'KEBUTUHAN EKSTRAK KG', 'MO EKSTRAK', 'CATATAN', 'DIUBAH'], text: [1, 2, 3, 5, 6, 8, 9, 10, 12, 13, 14] },
  // PC (Products to Consume) & CP (Consumed Products) per MO dari Odoo. Baris tanpa KODE MATERIAL = penanda MO ada di file tapi kosong.
  // Konfirmasi incoming: jadwal kirim PO (Monitoring PO) yang dikonfirmasi datang → Incoming di Proyeksi Stok. Kunci = NO PO + KODE + JADWAL KE.
  KONFIRMASI_INCOMING: { head: ['NO PO', 'KODE', 'JADWAL KE', 'QTY', 'TGL JADWAL SAAT KONFIRMASI', 'CATATAN', 'DIUBAH'], text: [1, 2, 3, 5, 6, 7] },
  PC_CP_MO: { head: ['JENIS', 'NO MO', 'KODE SKU', 'KODE MATERIAL', 'NAMA MATERIAL', 'QTY', 'UoM', 'FILE', 'DIUBAH'], text: [1, 2, 3, 4, 5, 7, 8, 9] },
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
    const plan = rows_(ss.getSheetByName(MRP_CONFIG.PLAN_SHEET), 7)
      .map(r => [d_(r[0], tz, 'yyyy-MM'), s_(r[1]), s_(r[2]), n_(r[3]), s_(r[4]), s_(r[5]), d_(r[6], tz, 'yyyy-MM-dd HH:mm')]);
    // gantung: [tanggal, kode, nama, qty, uom, sumber, catatan]
    const gantung = rows_(ss.getSheetByName(MRP_CONFIG.GANTUNG_SHEET), 7)
      .map(r => [d_(r[0], tz, 'yyyy-MM-dd'), s_(r[1]), s_(r[2]), n_(r[3]), s_(r[4]), s_(r[5]), s_(r[6])]);
    const stock = rows_(ss.getSheetByName(MRP_CONFIG.STOCK_SHEET), 7)
      .map(r => [d_(r[0], tz, 'yyyy-MM-dd'), s_(r[1]), s_(r[2]), n_(r[3]), s_(r[4]), s_(r[5]), s_(r[6])]);
    const adj = rows_(ss.getSheetByName(MRP_CONFIG.ADJ_SHEET), 6)
      .map(r => [s_(r[0]), d_(r[1], tz, 'yyyy-MM-dd'), s_(r[2]), n_(r[3]), s_(r[4]), d_(r[5], tz, 'yyyy-MM-dd HH:mm')]);
    const inc = rows_(ss.getSheetByName(MRP_CONFIG.INC_SHEET), 7)
      .map(r => [s_(r[0]), d_(r[1], tz, 'yyyy-MM'), s_(r[2]), s_(r[3]), n_(r[4]), s_(r[5]), d_(r[6], tz, 'yyyy-MM-dd HH:mm')]);
    const log = rows_(ss.getSheetByName(MRP_CONFIG.LOG_SHEET), 3)
      .map(r => [d_(r[0], tz, 'yyyy-MM-dd HH:mm'), s_(r[1]), s_(r[2])]).slice(-60).reverse();

    return json_({
      ok: true, master, boms, details, weeks, skus, plan, stock, gantung, adj, inc, log, konf: readKonf_(ss, tz), cons: readCons_(ss, tz), incK: readIncK_(ss, tz),
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
    else if (action === 'saveKonf') res = saveKonf_(ss, body.rows || [], body.del || [], body.file || '', now);
    else if (action === 'savePlan') res = savePlan_(ss, body.cells || [], now);
    else if (action === 'replacePlan') res = replacePlan_(ss, body.months || [], body.rows || [], body.file || '', now);
    else if (action === 'saveSku') res = saveSku_(ss, body.sku || {}, now);
    else if (action === 'uploadStock') res = uploadStock_(ss, body.date, body.rows || [], body.file || '', now);
    else if (action === 'setIncK') res = setIncK_(ss, body, now);
    else if (action === 'uploadCons') res = uploadCons_(ss, body.jenis, body.mos || [], body.rows || [], body.file || '', now);
    else if (action === 'uploadGantung') res = uploadGantung_(ss, body.date, body.rows || [], body.file || '', now);
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
  const keys = last > 1 ? sh.getRange(2, 1, last - 1, 3).getDisplayValues().map(r => r[0] + '|' + r[1] + '|' + r[2]) : [];
  const idx = new Map(keys.map((k, i) => [k, i + 2]));
  const del = [], add = [];
  let n = 0;
  cells.forEach(c => {
    const bulan = s_(c.bulan), week = s_(c.week), kode = s_(c.kode);
    if (!/^\d{4}-\d{2}$/.test(bulan) || !/^W[1-5]$/.test(week) || !kode) return;
    const kg = c.kg === '' || c.kg === null || c.kg === undefined ? '' : Number(c.kg);
    const bom = s_(c.bom);
    const row = [bulan, week, kode, kg === '' || isNaN(kg) ? '' : kg, bom, 'Website', now];
    const at = idx.get(bulan + '|' + week + '|' + kode);
    const empty = !(Number(kg) > 0) && !bom;
    if (at) { if (empty) del.push(at); else sh.getRange(at, 1, 1, 7).setValues([row]); }
    else if (!empty) add.push(row);
    n++;
  });
  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, 7).setValues(add);
  del.sort((a, b) => b - a).forEach(r => sh.deleteRow(r));
  if (n === 1) {
    const c = cells[0];
    log_(ss, now, 'Edit rencana', `${c.kode} ${c.bulan} ${c.week}: ${c.kg === '' ? 'dikosongkan' : c.kg + ' kg'}`);
  } else if (n) log_(ss, now, 'Edit rencana', `${n} sel diubah`);
  return { saved: n };
}

// Upload rencana: semua baris di bulan yang ada di file diganti dengan isi file
function replacePlan_(ss, months, rows, file, now) {
  const sh = sheet_(ss, MRP_CONFIG.PLAN_SHEET);
  const mset = new Set(months.map(s_));
  const last = sh.getLastRow();
  const tz = ss.getSpreadsheetTimeZone();
  const keep = last > 1 ? sh.getRange(2, 1, last - 1, 7).getValues()
    .map(r => [d_(r[0], tz, 'yyyy-MM'), s_(r[1]), s_(r[2]), n_(r[3]), s_(r[4]), s_(r[5]), d_(r[6], tz, 'yyyy-MM-dd HH:mm')])
    .filter(r => r[0] && !mset.has(r[0])) : [];
  const fresh = rows.map(r => [s_(r[0]), s_(r[1]), s_(r[2]), Number(r[3]) || 0, s_(r[4]), 'Upload' + (file ? ': ' + file : ''), now])
    .filter(r => mset.has(r[0]) && /^W[1-5]$/.test(r[1]) && r[2] && r[3] > 0);
  const all = keep.concat(fresh);
  if (last > 1) sh.getRange(2, 1, last - 1, 7).clearContent();
  if (all.length) sh.getRange(2, 1, all.length, 7).setValues(all);
  log_(ss, now, 'Upload rencana', `${file || 'file'} · bulan ${[...mset].join(', ')} · ${fresh.length} sel`);
  return { saved: fresh.length };
}

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

// Upload stok gantung: isi lama diganti seluruhnya (qty 0 tidak disimpan)
function uploadGantung_(ss, date, rows, file, now) {
  const tgl = s_(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tgl)) throw new Error('Tanggal stok gantung wajib diisi.');
  const sh = sheet_(ss, MRP_CONFIG.GANTUNG_SHEET);
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, 7).clearContent();
  const out = rows.map(r => [tgl, s_(r[0]), s_(r[1]), Number(r[2]) || 0, s_(r[3]), 'Upload' + (file ? ': ' + file : ''), ''])
    .filter(r => r[1] && r[3]);
  if (out.length) sh.getRange(2, 1, out.length, 7).setValues(out);
  log_(ss, now, 'Upload stok gantung', `${file || 'file'} · per ${tgl} · ${out.length} material`);
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

/* ================= Konfirmasi incoming (jadwal PO) ================= */
// incK: [noPo, kode, jadwalKe, qty, tglJadwal, catatan, diubah]
function readIncK_(ss, tz) {
  return rows_(ss.getSheetByName(MRP_CONFIG.INCK_SHEET), 7).map(r => [s_(r[0]), s_(r[1]), s_(r[2]), n_(r[3]), d_(r[4], tz, 'yyyy-MM-dd'), s_(r[5]), d_(r[6], tz, 'yyyy-MM-dd HH:mm')]);
}
// Upsert satu jadwal; qty 0 / kosong = batalkan konfirmasi
function setIncK_(ss, b, now) {
  const po = s_(b.po), kode = s_(b.kode), ke = s_(b.ke), qty = Number(b.qty) || 0;
  if (!po || !kode || !ke) throw new Error('No PO, kode, dan jadwal ke wajib ada.');
  if (qty < 0) throw new Error('Qty konfirmasi tidak boleh minus.');
  const tz = ss.getSpreadsheetTimeZone();
  const all = readIncK_(ss, tz).filter(r => !(r[0] === po && r[1] === kode && r[2] === ke));
  if (qty > 0) all.push([po, kode, ke, qty, s_(b.tgl), s_(b.note), now]);
  const sh = sheet_(ss, MRP_CONFIG.INCK_SHEET);
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, 7).clearContent();
  if (all.length) sh.getRange(2, 1, all.length, 7).setValues(all);
  log_(ss, now, qty > 0 ? 'Konfirmasi incoming' : 'Batal konfirmasi incoming', `${po} · ${kode} · jadwal ${ke}${qty > 0 ? ' · ' + qty + (b.tgl ? ' · ' + s_(b.tgl) : '') : ''}`);
  return { incK: readIncK_(ss, tz) };
}

/* ================= Konfirmasi Produksi ================= */
const KONF_COLS = 14;
// konf: [noMo, kode, nama, qty, uom, bomId, konversiKg, bulan, week, kodeEkstrak, kebutuhanEkstrakKg, moEkstrak, catatan, diubah]
function readKonf_(ss, tz) {
  return rows_(ss.getSheetByName(MRP_CONFIG.KONF_SHEET), KONF_COLS).map(r => [s_(r[0]), s_(r[1]), s_(r[2]), n_(r[3]), s_(r[4]), s_(r[5]), n_(r[6]),
    d_(r[7], tz, 'yyyy-MM'), s_(r[8]), s_(r[9]), n_(r[10]), s_(r[11]), s_(r[12]), d_(r[13], tz, 'yyyy-MM-dd HH:mm')]);
}
// rows: baris lengkap (tanpa DIUBAH) — ditambah / diganti per NO MO; del: daftar NO MO yang dihapus
function saveKonf_(ss, rows, del, file, now) {
  const sh = sheet_(ss, MRP_CONFIG.KONF_SHEET);
  const tz = ss.getSpreadsheetTimeZone();
  const map = new Map(readKonf_(ss, tz).map(r => [r[0], r]));
  let nAdd = 0, nUpd = 0, nDel = 0;
  (del || []).forEach(no => { if (map.delete(s_(no))) nDel++; });
  rows.forEach(r => {
    const no = s_(r[0]); if (!no || !s_(r[1])) return;
    const bulan = s_(r[7]), week = s_(r[8]);
    if (bulan && !/^\d{4}-\d{2}$/.test(bulan)) throw new Error('Bulan tidak dikenal untuk MO ' + no + ': ' + bulan);
    if (week && !/^W[1-5]$/.test(week)) throw new Error('Week tidak dikenal untuk MO ' + no + ': ' + week);
    if (map.has(no)) nUpd++; else nAdd++;
    map.set(no, [no, s_(r[1]), s_(r[2]), Number(r[3]) || 0, s_(r[4]), s_(r[5]), r[6] === '' || r[6] === null ? '' : Number(r[6]) || 0,
      bulan, week, s_(r[9]), r[10] === '' || r[10] === null ? '' : Number(r[10]) || 0, s_(r[11]), s_(r[12]), now]);
  });
  const all = [...map.values()];
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, KONF_COLS).clearContent();
  if (all.length) sh.getRange(2, 1, all.length, KONF_COLS).setValues(all);
  log_(ss, now, 'Konfirmasi produksi', `${file ? file + ' · ' : ''}${nAdd} MO baru, ${nUpd} diubah${nDel ? ', ' + nDel + ' dihapus' : ''}`);
  return { added: nAdd, updated: nUpd, deleted: nDel, konf: readKonf_(ss, tz) };
}

/* ================= PC / CP per MO ================= */
const CONS_COLS = 9;
// cons: [jenis, noMo, kodeSku, kodeMaterial, namaMaterial, qty, uom, file, diubah]
function readCons_(ss, tz) {
  return rows_(ss.getSheetByName(MRP_CONFIG.CONS_SHEET), CONS_COLS).map(r => [s_(r[0]), s_(r[1]), s_(r[2]), s_(r[3]), s_(r[4]), n_(r[5]), s_(r[6]), s_(r[7]),
    d_(r[8], tz, 'yyyy-MM-dd HH:mm')]);
}
// Ganti per MO: baris lama dengan JENIS sama dan NO MO yang ada di file dihapus, lalu diisi isi file.
// mos: [[noMo, kodeSku]] semua MO di file (termasuk yang barisnya kosong); rows: [[noMo, kodeSku, kodeMaterial, nama, qty, uom]]
function uploadCons_(ss, jenis, mos, rows, file, now) {
  const j = s_(jenis).toUpperCase();
  if (j !== 'PC' && j !== 'CP') throw new Error('Jenis file harus PC atau CP.');
  if (!mos.length) throw new Error('Tidak ada No MO di file.');
  const tz = ss.getSpreadsheetTimeZone();
  const set = new Set(mos.map(m => s_(m[0])));
  const keep = readCons_(ss, tz).filter(r => !(r[0] === j && set.has(r[1])));
  const has = new Set();
  const add = rows.map(r => { has.add(s_(r[0])); return [j, s_(r[0]), s_(r[1]), s_(r[2]), s_(r[3]), Number(r[4]) || 0, s_(r[5]), file, now]; })
    .filter(r => r[1] && r[3]);
  mos.forEach(m => { if (!has.has(s_(m[0]))) add.push([j, s_(m[0]), s_(m[1]), '', '', 0, '', file, now]); });
  const all = keep.concat(add);
  const sh = sheet_(ss, MRP_CONFIG.CONS_SHEET);
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, CONS_COLS).clearContent();
  if (all.length) sh.getRange(2, 1, all.length, CONS_COLS).setValues(all);
  log_(ss, now, 'Upload ' + j, `${file || 'file'} · ${set.size} MO · ${add.filter(r => r[3]).length} baris material`);
  return { saved: add.length, mos: set.size, cons: readCons_(ss, tz) };
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
