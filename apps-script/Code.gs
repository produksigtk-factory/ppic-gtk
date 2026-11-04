/**
 * PPIC GTK — penghubung website <-> Google Sheet "MONITORING PO"
 *
 * Dipasang di: MONITORING PO → Extensions → Apps Script.
 * - doGet  : website membaca isi PO_LINE dan PO_SCHEDULE.
 * - doPost : website mengirim hasil upload PO-DET / PO-DEL (dilindungi PIN).
 *
 * PIN upload diatur di: Project Settings → Script Properties → UPLOAD_PIN.
 */

const CONFIG = {
  DATABASE_ID: '1Qp8FkQXPLtV89e9NBoIMY5oLY6_DXLzQEr3HemkHI6g', // DATABASE PPIC GTK
  MASTER_SHEET: 'MASTER_MATERIAL',
  LINE_SHEET: 'PO_LINE',
  SCHED_SHEET: 'PO_SCHEDULE',
  LOG_SHEET: 'LOG_UPLOAD',
};

/* ---------- Baca data (dipakai halaman Monitoring PO) ---------- */

function doGet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = ss.getSpreadsheetTimeZone();

  const lines = readRows_(ss.getSheetByName(CONFIG.LINE_SHEET), 11).map(r => [
    String(r[0]).trim(),     // 0 No PO
    fmtDate_(r[1], tz),      // 1 Order date (yyyy-MM-dd)
    r[2],                    // 2 Supplier
    String(r[3]).trim(),     // 3 Kode
    r[4],                    // 4 Nama material
    r[5],                    // 5 Jenis
    num_(r[6]),              // 6 Qty order
    r[7],                    // 7 UoM
    num_(r[8]),              // 8 Unit price
    r[9],                    // 9 Kurs
    num_(r[10]) || 1,        // 10 Line ke
  ]);

  const schedules = readRows_(ss.getSheetByName(CONFIG.SCHED_SHEET), 8).map(r => [
    String(r[0]).trim(),     // 0 No PO
    String(r[1]).trim(),     // 1 Kode
    r[2],                    // 2 Nama material
    num_(r[3]),              // 3 Jadwal ke
    num_(r[4]) || 0,         // 4 Schedule qty
    num_(r[5]) || 0,         // 5 Receive qty
    fmtDate_(r[6], tz),      // 6 Tanggal
    r[7],                    // 7 Status
  ]);

  return json_({
    ok: true,
    lines: lines,
    schedules: schedules,
    lastUpload: lastUpload_(ss, tz),
    readAt: Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm'),
  });
}

/* ---------- Terima upload (dipakai halaman Update Data) ---------- */

function doPost(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return json_({ ok: false, error: 'Sedang ada upload lain yang berjalan. Coba lagi dalam satu menit.' });
  }
  try {
    const body = JSON.parse(e.postData.contents);
    const pin = PropertiesService.getScriptProperties().getProperty('UPLOAD_PIN');
    if (!pin) {
      return json_({ ok: false, error: 'PIN upload belum diatur. Isi UPLOAD_PIN di Apps Script → Project Settings → Script Properties.' });
    }
    if (String(body.pin || '') !== String(pin)) {
      return json_({ ok: false, error: 'PIN salah. Periksa lagi PIN upload Anda.' });
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tz = ss.getSpreadsheetTimeZone();
    const stamp = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm');
    const result = {};

    if (Array.isArray(body.lines) && body.lines.length) {
      result.lines = upsertLines_(ss, body.lines, body.detName || 'PO-DET', stamp);
    }
    if (Array.isArray(body.delPOs) && body.delPOs.length) {
      result.schedules = upsertSchedules_(ss, body.schedules || [], body.delPOs, body.delName || 'PO-DEL', stamp);
    }
    if (!result.lines && !result.schedules) {
      return json_({ ok: false, error: 'Tidak ada data yang dikirim.' });
    }

    writeLog_(ss, stamp, body, result);
    return json_({ ok: true, result: result, time: stamp });
  } catch (err) {
    return json_({ ok: false, error: 'Gagal memproses upload: ' + err });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Upsert baris PO (PO-DET) ---------- */
// row masuk: [po, 'yyyy-MM-dd', supplier, kode, nama, qty, uom, price, kurs, lineKe]
function upsertLines_(ss, rows, fileName, stamp) {
  const sh = ss.getSheetByName(CONFIG.LINE_SHEET);
  const jenis = masterKategori_();
  const incomingPOs = new Set(rows.map(r => String(r[0]).trim()));

  const existing = readRows_(sh, 13);
  const existingPOs = new Set(existing.map(r => String(r[0]).trim()));
  const kept = existing.filter(r => !incomingPOs.has(String(r[0]).trim()));

  const fresh = rows.map(r => {
    const kode = String(r[3]).trim();
    return [
      String(r[0]).trim(), toDate_(r[1]), r[2], kode, r[4], jenis[kode] || '',
      r[5] === '' ? '' : Number(r[5]), r[6], r[7] === '' ? '' : Number(r[7]), r[8],
      Number(r[9]) || 1, fileName, stamp,
    ];
  });

  writeTable_(sh, kept.concat(fresh), 13, [['D', '@'], ['B', 'yyyy-mm-dd']]);

  let added = 0, updated = 0;
  incomingPOs.forEach(po => (existingPOs.has(po) ? updated++ : added++));
  return { rows: fresh.length, poBaru: added, poDiperbarui: updated, totalBaris: kept.length + fresh.length };
}

/* ---------- Upsert jadwal (PO-DEL) ---------- */
// row masuk: [po, kode, nama, jadwalKe, schedQty, recvQty, 'yyyy-MM-dd', status]
function upsertSchedules_(ss, rows, delPOs, fileName, stamp) {
  const sh = ss.getSheetByName(CONFIG.SCHED_SHEET);
  const replacePOs = new Set(delPOs.map(p => String(p).trim()));

  const existing = readRows_(sh, 10);
  const kept = existing.filter(r => !replacePOs.has(String(r[0]).trim()));

  const fresh = rows.map(r => [
    String(r[0]).trim(), String(r[1]).trim(), r[2], Number(r[3]) || 1,
    Number(r[4]) || 0, Number(r[5]) || 0, toDate_(r[6]), r[7], fileName, stamp,
  ]);

  // Kolom K dan L berisi rumus kunci di baris judul, jadi hanya A–J yang ditulis.
  writeTable_(sh, kept.concat(fresh), 10, [['B', '@'], ['G', 'yyyy-mm-dd']]);
  return { rows: fresh.length, poDiganti: replacePOs.size, totalJadwal: kept.length + fresh.length };
}

/* ---------- Helper ---------- */

function writeTable_(sh, data, cols, formats) {
  const needed = data.length + 1;
  if (sh.getMaxRows() < needed + 50) sh.insertRowsAfter(sh.getMaxRows(), needed + 200 - sh.getMaxRows());
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, cols).clearContent();
  formats.forEach(([col, fmt]) => sh.getRange(col + '2:' + col).setNumberFormat(fmt));
  if (data.length) sh.getRange(2, 1, data.length, cols).setValues(data);
  SpreadsheetApp.flush();
}

function readRows_(sh, cols) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, cols).getValues().filter(r => String(r[0]).trim() !== '');
}

function masterKategori_() {
  const sh = SpreadsheetApp.openById(CONFIG.DATABASE_ID).getSheetByName(CONFIG.MASTER_SHEET);
  const map = {};
  readRows_(sh, 4).forEach(r => { map[String(r[0]).trim()] = r[3]; });
  return map;
}

function writeLog_(ss, stamp, body, result) {
  let sh = ss.getSheetByName(CONFIG.LOG_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.LOG_SHEET);
    sh.appendRow(['WAKTU', 'FILE PO-DET', 'FILE PO-DEL', 'BARIS PO', 'PO BARU', 'PO DIPERBARUI', 'JADWAL', 'PO JADWAL DIGANTI']);
    sh.setFrozenRows(1);
  }
  const l = result.lines || {}, s = result.schedules || {};
  sh.appendRow([stamp, result.lines ? body.detName : '', result.schedules ? body.delName : '',
    l.rows || '', l.poBaru || '', l.poDiperbarui || '', s.rows || '', s.poDiganti || '']);
}

function lastUpload_(ss, tz) {
  const sh = ss.getSheetByName(CONFIG.LOG_SHEET);
  if (!sh || sh.getLastRow() < 2) return null;
  const v = sh.getRange(sh.getLastRow(), 1, 1, 3).getValues()[0];
  return { time: v[0] instanceof Date ? Utilities.formatDate(v[0], tz, 'yyyy-MM-dd HH:mm') : String(v[0]), det: v[1], del: v[2] };
}

function toDate_(s) {
  if (s instanceof Date) return s;
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : '';
}

function fmtDate_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  return v ? String(v) : '';
}

function num_(v) {
  if (v === '' || v === null) return '';
  const n = Number(v);
  return isNaN(n) ? '' : n;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
