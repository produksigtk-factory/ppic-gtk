/**
 * PPIC Gondowangi — penghubung website <-> Google Sheet "MRP PPIC GTK" (PROJECT 2: MRP)
 *
 * Dipasang di: MRP PPIC GTK → Extensions → Apps Script (terpisah dari Apps Script MONITORING PO).
 * - doGet  : website membaca BOM dan daftar material dari DATABASE PPIC GTK,
 *            serta isi tab RENCANA_PRODUKSI, STOK, dan PARAMETER_MATERIAL di file ini.
 * - doPost : disiapkan untuk upload/edit data MRP dari website (dilindungi PIN). Saat ini baru "verify".
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
  PLAN_SHEET: 'RENCANA_PRODUKSI',     // di file MRP ini
  STOCK_SHEET: 'STOK',
  PARAM_SHEET: 'PARAMETER_MATERIAL',
};

/* ================= Baca data ================= */

function doGet(e) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tz = ss.getSpreadsheetTimeZone();
    const db = SpreadsheetApp.openById(MRP_CONFIG.DATABASE_ID);
    // master  : [kode, nama, uom, kategori]
    // boms    : [bomId, kodeProduk, namaProduk, qtyBatch, uom, reference, jumlahKomponen, catatan]
    // details : [bomId, kodeMaterial, namaMaterial, qtyMaterial, uom, kategori]
    const master = rows_(db.getSheetByName(MRP_CONFIG.MASTER_SHEET), 4)
      .map(r => [s_(r[0]), String(r[1] || ''), String(r[2] || ''), String(r[3] || '')]);
    const boms = rows_(db.getSheetByName(MRP_CONFIG.BOM_SHEET), 8)
      .map(r => [s_(r[0]), s_(r[1]), String(r[2] || ''), n_(r[3]), String(r[4] || ''), String(r[5] || ''), n_(r[6]), String(r[7] || '')]);
    const details = rows_(db.getSheetByName(MRP_CONFIG.BOM_DETAIL_SHEET), 10)
      .map(r => [s_(r[0]), s_(r[5]), String(r[6] || ''), n_(r[7]), String(r[8] || ''), String(r[9] || '')]);
    // Data MRP di file ini (masih kosong sampai diisi)
    const plan = rows_(ss.getSheetByName(MRP_CONFIG.PLAN_SHEET), 9)
      .map(r => [d_(r[0], tz, 'yyyy-MM'), s_(r[1]), String(r[2] || ''), n_(r[3]), String(r[4] || ''), s_(r[5]), String(r[6] || ''), String(r[7] || ''), d_(r[8], tz, 'yyyy-MM-dd HH:mm')]);
    const stock = rows_(ss.getSheetByName(MRP_CONFIG.STOCK_SHEET), 7)
      .map(r => [s_(r[0]), String(r[1] || ''), n_(r[2]), String(r[3] || ''), String(r[4] || ''), d_(r[5], tz, 'yyyy-MM-dd'), String(r[6] || '')]);
    const params = rows_(ss.getSheetByName(MRP_CONFIG.PARAM_SHEET), 4)
      .map(r => [s_(r[0]), String(r[1] || ''), n_(r[2]), String(r[3] || '')]);
    return json_({
      ok: true, master, boms, details, plan, stock, params,
      databaseUrl: db.getUrl(), mrpUrl: ss.getUrl(),
      readAt: Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm'),
    });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

/* ================= Tulis data (disiapkan) ================= */

function doPost(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return json_({ ok: false, error: 'Sedang ada proses lain yang berjalan. Coba lagi dalam satu menit.' });
  try {
    const body = JSON.parse(e.postData.contents);
    const pin = PropertiesService.getScriptProperties().getProperty('UPLOAD_PIN');
    if (!pin) return json_({ ok: false, error: 'PIN belum diatur. Isi UPLOAD_PIN di Apps Script MRP → Project Settings → Script Properties.' });
    if (String(body.pin || '') !== String(pin)) return json_({ ok: false, error: 'PIN salah. Periksa lagi PIN Anda.' });
    const action = body.action || '';
    if (action === 'verify') return json_({ ok: true });
    return json_({ ok: false, error: 'Aksi belum tersedia: ' + action });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/* ================= Bantuan ================= */

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
