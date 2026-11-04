/**
 * PPIC Gondowangi — penghubung website <-> Google Sheet "MONITORING PO"
 *
 * Dipasang di: MONITORING PO → Extensions → Apps Script.
 * - doGet  : website membaca PO_LINE, PO_SCHEDULE, tanda edit manual, dan riwayat edit.
 * - doPost : upload export Odoo dan edit manual dari website (dilindungi PIN).
 *
 * PIN diatur di: Project Settings → Script Properties → UPLOAD_PIN.
 * Setelah kode diganti: Deploy → Manage deployments → Edit (ikon pensil) → Version: New version → Deploy.
 */

const CONFIG = {
  DATABASE_ID: '1Qp8FkQXPLtV89e9NBoIMY5oLY6_DXLzQEr3HemkHI6g', // DATABASE PPIC GTK
  MASTER_SHEET: 'MASTER_MATERIAL',
  LINE_SHEET: 'PO_LINE',
  SCHED_SHEET: 'PO_SCHEDULE',
  LOG_SHEET: 'LOG_UPLOAD',
  MANUAL_SHEET: 'PO_MANUAL',   // PO yang pernah diedit manual (dipakai untuk konfirmasi saat upload)
  EDIT_LOG_SHEET: 'LOG_EDIT',  // riwayat edit manual
};
const LINE_COLS = 13;   // A–M PO_LINE
const SCHED_COLS = 10;  // A–J PO_SCHEDULE (K dan L berisi rumus kunci di baris judul)
const LINE_FMT = [['D', '@'], ['B', 'yyyy-mm-dd']];
const SCHED_FMT = [['B', '@'], ['G', 'yyyy-mm-dd']];

/* ================= Baca data ================= */

function doGet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = ss.getSpreadsheetTimeZone();
  return json_({
    ok: true,
    lines: readRows_(ss.getSheetByName(CONFIG.LINE_SHEET), 11).map(r => lineOut_(r, tz)),
    schedules: readRows_(ss.getSheetByName(CONFIG.SCHED_SHEET), 8).map(r => schedOut_(r, tz)),
    manual: readManual_(ss, tz),
    editLog: readEditLog_(ss, tz, 300),
    lastUpload: lastUpload_(ss, tz),
    readAt: Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm'),
  });
}

// [po, tanggal, supplier, kode, nama, jenis, qty, uom, harga, kurs, lineKe]
function lineOut_(r, tz) {
  return [str_(r[0]), fmtDate_(r[1], tz), r[2], str_(r[3]), r[4], r[5], num_(r[6]), r[7], num_(r[8]), r[9], num_(r[10]) || 1];
}
// [po, kode, nama, jadwalKe, qtyJadwal, qtyDiterima, tanggal, status]
function schedOut_(r, tz) {
  return [str_(r[0]), str_(r[1]), r[2], num_(r[3]) || 1, num_(r[4]) || 0, num_(r[5]) || 0, fmtDate_(r[6], tz), r[7]];
}

/* ================= Tulis data ================= */

function doPost(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return json_({ ok: false, error: 'Sedang ada proses lain yang berjalan. Coba lagi dalam satu menit.' });
  try {
    const body = JSON.parse(e.postData.contents);
    const pin = PropertiesService.getScriptProperties().getProperty('UPLOAD_PIN');
    if (!pin) return json_({ ok: false, error: 'PIN belum diatur. Isi UPLOAD_PIN di Apps Script → Project Settings → Script Properties.' });
    if (String(body.pin || '') !== String(pin)) return json_({ ok: false, error: 'PIN salah. Periksa lagi PIN Anda.' });

    const action = body.action || 'upload';
    if (action === 'verify') return json_({ ok: true });

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tz = ss.getSpreadsheetTimeZone();
    const stamp = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm');

    if (action === 'upload') return json_(upload_(ss, body, stamp));

    const user = String(body.user || '').trim();
    if (!user) return json_({ ok: false, error: 'Isi nama pengedit terlebih dahulu.' });

    const handlers = { saveLine: saveLine_, deleteLine: deleteLine_, saveSched: saveSched_, deleteSched: deleteSched_ };
    if (!handlers[action]) return json_({ ok: false, error: 'Aksi tidak dikenal: ' + action });

    const pos = handlers[action](ss, body, user, stamp, tz);
    return json_(Object.assign({ ok: true, time: stamp, manual: readManual_(ss, tz), editLog: readEditLog_(ss, tz, 300) }, poData_(ss, pos, tz)));
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Upload export Odoo ---------- */

function upload_(ss, body, stamp) {
  const result = {};
  if (Array.isArray(body.lines) && body.lines.length) {
    result.lines = upsertLines_(ss, body.lines, body.detName || 'PO-DET', stamp);
    clearManual_(ss, uniq_(body.lines.map(r => str_(r[0]))), 'lines');
  }
  if (Array.isArray(body.delPOs) && body.delPOs.length) {
    result.schedules = upsertSchedules_(ss, body.schedules || [], body.delPOs, body.delName || 'PO-DEL', stamp);
    clearManual_(ss, body.delPOs.map(str_), 'sched');
  }
  if (!result.lines && !result.schedules) return { ok: false, error: 'Tidak ada data yang dikirim.' };
  writeLog_(ss, stamp, body, result);
  return { ok: true, result: result, time: stamp };
}

// row masuk: [po, 'yyyy-MM-dd', supplier, kode, nama, qty, uom, price, kurs, lineKe]
function upsertLines_(ss, rows, fileName, stamp) {
  const sh = ss.getSheetByName(CONFIG.LINE_SHEET);
  const jenis = masterKategori_();
  const incoming = new Set(rows.map(r => str_(r[0])));
  const existing = readRows_(sh, LINE_COLS);
  const existingPOs = new Set(existing.map(r => str_(r[0])));
  const kept = existing.filter(r => !incoming.has(str_(r[0])));
  const fresh = rows.map(r => {
    const kode = str_(r[3]);
    return [str_(r[0]), toDate_(r[1]), r[2], kode, r[4], jenis[kode] || '', numOrBlank_(r[5]), r[6], numOrBlank_(r[7]), r[8],
      Number(r[9]) || 1, fileName, stamp];
  });
  writeTable_(sh, kept.concat(fresh), LINE_COLS, LINE_FMT);
  let added = 0, updated = 0;
  incoming.forEach(po => (existingPOs.has(po) ? updated++ : added++));
  return { rows: fresh.length, poBaru: added, poDiperbarui: updated, totalBaris: kept.length + fresh.length };
}

// row masuk: [po, kode, nama, jadwalKe, schedQty, recvQty, 'yyyy-MM-dd', status]
function upsertSchedules_(ss, rows, delPOs, fileName, stamp) {
  const sh = ss.getSheetByName(CONFIG.SCHED_SHEET);
  const replace = new Set(delPOs.map(str_));
  const kept = readRows_(sh, SCHED_COLS).filter(r => !replace.has(str_(r[0])));
  const fresh = rows.map(r => [str_(r[0]), str_(r[1]), r[2], Number(r[3]) || 1, Number(r[4]) || 0, Number(r[5]) || 0,
    toDate_(r[6]), r[7], fileName, stamp]);
  writeTable_(sh, kept.concat(fresh), SCHED_COLS, SCHED_FMT);
  return { rows: fresh.length, poDiganti: replace.size, totalJadwal: kept.length + fresh.length };
}

/* ---------- Edit manual: baris PO ---------- */

const LINE_FIELDS = [['No PO', 0], ['Order Date', 1], ['Supplier', 2], ['Kode', 3], ['Nama Material', 4],
  ['Qty Order', 6], ['UoM', 7], ['Unit Price', 8], ['Kurs', 9]];

function saveLine_(ss, body, user, stamp, tz) {
  const d = body.data || {};
  const po = str_(d.po), kode = str_(d.code);
  if (!po || !kode) throw new Error('No PO dan Kode wajib diisi.');
  if (d.qty === '' || isNaN(Number(d.qty))) throw new Error('Qty Order harus berupa angka.');

  const sh = ss.getSheetByName(CONFIG.LINE_SHEET);
  const rows = readRows_(sh, LINE_COLS);
  let idx = -1, old = null;
  if (body.key) {
    idx = findLine_(rows, body.key);
    if (idx < 0) throw new Error('Baris PO tidak ditemukan (mungkin sudah berubah). Muat ulang data lalu coba lagi.');
    old = rows[idx].slice();
  }
  const row = [po, toDate_(d.date), String(d.supplier || '').trim(), kode, String(d.name || '').trim(), masterKategori_()[kode] || '',
    Number(d.qty), String(d.uom || '').trim(), numOrBlank_(d.price), String(d.kurs || '').trim(),
    old ? old[10] : 9999, old ? old[11] : 'Manual', stamp];
  if (idx >= 0) rows[idx] = row; else rows.push(row);
  renumber_(rows, 0, 3, 10);
  writeTable_(sh, rows, LINE_COLS, LINE_FMT);

  const log = [];
  if (old) {
    LINE_FIELDS.forEach(([name, i]) => {
      const a = show_(old[i], tz), b = show_(row[i], tz);
      if (a !== b) log.push([stamp, user, 'Ubah baris PO', po, kode, name, a, b]);
    });
  } else {
    log.push([stamp, user, 'Tambah baris PO', po, kode, '', '', row[4] + ' · ' + row[6] + ' ' + row[7]]);
  }
  logEdit_(ss, log);
  const pos = uniq_([po, old ? str_(old[0]) : po]);
  if (log.length) markManual_(ss, pos, 'lines', user, stamp);
  return pos;
}

function deleteLine_(ss, body, user, stamp, tz) {
  const sh = ss.getSheetByName(CONFIG.LINE_SHEET);
  const rows = readRows_(sh, LINE_COLS);
  const idx = findLine_(rows, body.key || {});
  if (idx < 0) throw new Error('Baris PO tidak ditemukan (mungkin sudah berubah). Muat ulang data lalu coba lagi.');
  const old = rows.splice(idx, 1)[0];
  const po = str_(old[0]), kode = str_(old[3]);
  renumber_(rows, 0, 3, 10);
  writeTable_(sh, rows, LINE_COLS, LINE_FMT);
  const log = [[stamp, user, 'Hapus baris PO', po, kode, '', old[4] + ' · ' + old[6] + ' ' + old[7], '']];

  const groupLeft = rows.some(r => str_(r[0]) === po && str_(r[3]) === kode);
  if (body.withSchedules && !groupLeft) {
    const ssh = ss.getSheetByName(CONFIG.SCHED_SHEET);
    const srows = readRows_(ssh, SCHED_COLS);
    const left = srows.filter(r => !(str_(r[0]) === po && str_(r[1]) === kode));
    if (left.length !== srows.length) {
      writeTable_(ssh, left, SCHED_COLS, SCHED_FMT);
      log.push([stamp, user, 'Hapus jadwal', po, kode, '', (srows.length - left.length) + ' jadwal ikut dihapus', '']);
      markManual_(ss, [po], 'sched', user, stamp);
    }
  }
  logEdit_(ss, log);
  markManual_(ss, [po], 'lines', user, stamp);
  return [po];
}

/* ---------- Edit manual: jadwal ---------- */

const SCHED_FIELDS = [['No PO', 0], ['Kode', 1], ['Qty Jadwal', 4], ['Qty Diterima', 5], ['Tanggal', 6], ['Status', 7]];

function saveSched_(ss, body, user, stamp, tz) {
  const d = body.data || {};
  const po = str_(d.po), kode = str_(d.code);
  if (!po || !kode) throw new Error('No PO dan Kode wajib diisi.');
  if (!toDate_(d.date)) throw new Error('Tanggal jadwal wajib diisi.');
  ['qty', 'rec'].forEach(k => { if (d[k] !== '' && isNaN(Number(d[k]))) throw new Error('Qty harus berupa angka.'); });

  const sh = ss.getSheetByName(CONFIG.SCHED_SHEET);
  const rows = readRows_(sh, SCHED_COLS);
  let idx = -1, old = null;
  if (body.key) {
    idx = findSched_(rows, body.key);
    if (idx < 0) throw new Error('Jadwal tidak ditemukan (mungkin sudah berubah). Muat ulang data lalu coba lagi.');
    old = rows[idx].slice();
  }
  const row = [po, kode, String(d.name || (old ? old[2] : '')).trim(), old ? old[3] : 9999, Number(d.qty) || 0, Number(d.rec) || 0,
    toDate_(d.date), String(d.status || 'Confirmed').trim(), old ? old[8] : 'Manual', stamp];
  if (idx >= 0) rows[idx] = row; else rows.push(row);
  renumber_(rows, 0, 1, 3);
  writeTable_(sh, rows, SCHED_COLS, SCHED_FMT);

  const log = [];
  if (old) {
    SCHED_FIELDS.forEach(([name, i]) => {
      const a = show_(old[i], tz), b = show_(row[i], tz);
      if (a !== b) log.push([stamp, user, 'Ubah jadwal', po, kode, name, a, b]);
    });
  } else {
    log.push([stamp, user, 'Tambah jadwal', po, kode, '', '', show_(row[6], tz) + ' · ' + row[4] + ' · ' + row[7]]);
  }
  logEdit_(ss, log);
  const pos = uniq_([po, old ? str_(old[0]) : po]);
  if (log.length) markManual_(ss, pos, 'sched', user, stamp);
  return pos;
}

function deleteSched_(ss, body, user, stamp, tz) {
  const sh = ss.getSheetByName(CONFIG.SCHED_SHEET);
  const rows = readRows_(sh, SCHED_COLS);
  const idx = findSched_(rows, body.key || {});
  if (idx < 0) throw new Error('Jadwal tidak ditemukan (mungkin sudah berubah). Muat ulang data lalu coba lagi.');
  const old = rows.splice(idx, 1)[0];
  renumber_(rows, 0, 1, 3);
  writeTable_(sh, rows, SCHED_COLS, SCHED_FMT);
  const po = str_(old[0]);
  logEdit_(ss, [[stamp, user, 'Hapus jadwal', po, str_(old[1]), '', show_(old[6], tz) + ' · ' + old[4] + ' · ' + old[7], '']]);
  markManual_(ss, [po], 'sched', user, stamp);
  return [po];
}

/* ---------- Tanda edit manual (PO_MANUAL) ---------- */
// Kolom: NO PO | BARIS PO DIEDIT | JADWAL DIEDIT | TERAKHIR DIEDIT | OLEH

function manualSheet_(ss) {
  let sh = ss.getSheetByName(CONFIG.MANUAL_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.MANUAL_SHEET);
    sh.getRange(1, 1, 1, 5).setValues([['NO PO', 'BARIS PO DIEDIT', 'JADWAL DIEDIT', 'TERAKHIR DIEDIT', 'OLEH']]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function markManual_(ss, pos, part, user, stamp) {
  const sh = manualSheet_(ss);
  const rows = readRows_(sh, 5);
  pos.forEach(po => {
    let r = rows.find(x => str_(x[0]) === po);
    if (!r) { r = [po, '', '', '', '']; rows.push(r); }
    if (part === 'lines') r[1] = 'Ya'; else r[2] = 'Ya';
    r[3] = stamp; r[4] = user;
  });
  writeTable_(sh, rows, 5, [['D', '@']]);
}

function clearManual_(ss, pos, part) {
  const sh = ss.getSheetByName(CONFIG.MANUAL_SHEET);
  if (!sh) return;
  const set = new Set(pos);
  const rows = readRows_(sh, 5);
  let changed = false;
  rows.forEach(r => {
    if (set.has(str_(r[0]))) { if (part === 'lines') r[1] = ''; else r[2] = ''; changed = true; }
  });
  if (changed) writeTable_(sh, rows.filter(r => r[1] || r[2]), 5, [['D', '@']]);
}

function readManual_(ss, tz) {
  const sh = ss.getSheetByName(CONFIG.MANUAL_SHEET);
  if (!sh) return [];
  return readRows_(sh, 5).map(r => [str_(r[0]), !!r[1], !!r[2], isDate_(r[3]) ? Utilities.formatDate(r[3], tz, 'yyyy-MM-dd HH:mm') : String(r[3]), String(r[4])]);
}

/* ---------- Riwayat edit (LOG_EDIT) ---------- */
// Kolom: WAKTU | PENGEDIT | AKSI | NO PO | KODE | KOLOM | NILAI LAMA | NILAI BARU

function logEdit_(ss, entries) {
  if (!entries.length) return;
  let sh = ss.getSheetByName(CONFIG.EDIT_LOG_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.EDIT_LOG_SHEET);
    sh.getRange(1, 1, 1, 8).setValues([['WAKTU', 'PENGEDIT', 'AKSI', 'NO PO', 'KODE', 'KOLOM', 'NILAI LAMA', 'NILAI BARU']]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  const start = sh.getLastRow() + 1;
  sh.getRange(start, 1, entries.length, 8).setNumberFormat('@').setValues(entries.map(e => e.map(v => String(v ?? ''))));
}

function readEditLog_(ss, tz, limit) {
  const sh = ss.getSheetByName(CONFIG.EDIT_LOG_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  const n = Math.min(limit, sh.getLastRow() - 1);
  return sh.getRange(sh.getLastRow() - n + 1, 1, n, 8).getValues().reverse()
    .map(r => r.map(v => (isDate_(v) ? Utilities.formatDate(v, tz, 'yyyy-MM-dd HH:mm') : String(v))));
}

/* ================= Helper ================= */

function poData_(ss, pos, tz) {
  const set = new Set(pos);
  return {
    pos: pos,
    lines: readRows_(ss.getSheetByName(CONFIG.LINE_SHEET), 11).filter(r => set.has(str_(r[0]))).map(r => lineOut_(r, tz)),
    schedules: readRows_(ss.getSheetByName(CONFIG.SCHED_SHEET), 8).filter(r => set.has(str_(r[0]))).map(r => schedOut_(r, tz)),
  };
}

function findLine_(rows, k) {
  return rows.findIndex(r => str_(r[0]) === str_(k.po) && str_(r[3]) === str_(k.code) && Number(r[10]) === Number(k.lineKe));
}
function findSched_(rows, k) {
  return rows.findIndex(r => str_(r[0]) === str_(k.po) && str_(r[1]) === str_(k.code) && Number(r[3]) === Number(k.n));
}

// Nomori ulang urutan (LINE KE / JADWAL KE) per kombinasi PO + kode, mengikuti urutan baris.
function renumber_(rows, poIdx, codeIdx, nIdx) {
  const count = {};
  rows.forEach(r => { const k = str_(r[poIdx]) + '|' + str_(r[codeIdx]); count[k] = (count[k] || 0) + 1; r[nIdx] = count[k]; });
}

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
  if (!sh) return [];
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, cols).getValues().filter(r => str_(r[0]) !== '');
}

function masterKategori_() {
  const sh = SpreadsheetApp.openById(CONFIG.DATABASE_ID).getSheetByName(CONFIG.MASTER_SHEET);
  const map = {};
  readRows_(sh, 4).forEach(r => { map[str_(r[0])] = r[3]; });
  return map;
}

function writeLog_(ss, stamp, body, result) {
  let sh = ss.getSheetByName(CONFIG.LOG_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.LOG_SHEET);
    sh.appendRow(['WAKTU', 'FILE PO-DET', 'FILE PO-DEL', 'BARIS PO', 'PO BARU', 'PO DIPERBARUI', 'JADWAL', 'PO JADWAL DIGANTI', 'PO DIPERTAHANKAN']);
    sh.setFrozenRows(1);
  }
  const l = result.lines || {}, s = result.schedules || {};
  sh.appendRow([stamp, result.lines ? body.detName : '', result.schedules ? body.delName : '',
    l.rows ?? '', l.poBaru ?? '', l.poDiperbarui ?? '', s.rows ?? '', s.poDiganti ?? '', (body.keptPOs || []).join(', ')]);
}

function lastUpload_(ss, tz) {
  const sh = ss.getSheetByName(CONFIG.LOG_SHEET);
  if (!sh || sh.getLastRow() < 2) return null;
  const v = sh.getRange(sh.getLastRow(), 1, 1, 3).getValues()[0];
  return { time: isDate_(v[0]) ? Utilities.formatDate(v[0], tz, 'yyyy-MM-dd HH:mm') : String(v[0]), det: v[1], del: v[2] };
}

function isDate_(v) { return Object.prototype.toString.call(v) === '[object Date]'; }
function str_(v) { return String(v ?? '').trim(); }
function uniq_(a) { return [...new Set(a.filter(Boolean))]; }

function toDate_(s) {
  if (isDate_(s)) return s;
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : '';
}
function fmtDate_(v, tz) {
  if (isDate_(v)) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  return v ? String(v) : '';
}
function show_(v, tz) { return isDate_(v) ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : String(v ?? ''); }
function num_(v) {
  if (v === '' || v === null) return '';
  const n = Number(v);
  return isNaN(n) ? '' : n;
}
function numOrBlank_(v) { return v === '' || v === null || v === undefined || isNaN(Number(v)) ? '' : Number(v); }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
