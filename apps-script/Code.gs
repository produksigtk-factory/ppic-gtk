/**
 * PPIC Gondowangi — penghubung website <-> Google Sheet "MONITORING PO"
 *
 * Dipasang di: MONITORING PO → Extensions → Apps Script.
 * - doGet  : website membaca PO_LINE, PO_SCHEDULE, tanda edit manual, dan riwayat edit.
 *            ?view=supplier → daftar supplier & MoQ (histori) per material RM/PM (tab SUPPLIER_MATERIAL di DATABASE PPIC).
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
  FOLLOWUP_SHEET: 'PO_FOLLOWUP',   // tindak lanjut per PO + kode (tidak tersentuh upload)
  CHANGE_SHEET: 'LOG_PERUBAHAN',   // perubahan yang terdeteksi di setiap upload export Odoo
  SUPPLIER_SHEET: 'SUPPLIER_MATERIAL',  // di DATABASE PPIC: hasil hitung otomatis (jangan diketik)
  SUPPLIER_CATS: ['RM (Raw)', 'PM (Pack)'],
};
const LINE_COLS = 13;   // A–M PO_LINE
const SCHED_COLS = 10;  // A–J PO_SCHEDULE (K dan L berisi rumus kunci di baris judul)
const LINE_FMT = [['D', '@'], ['B', 'yyyy-mm-dd']];
const SCHED_FMT = [['B', '@'], ['G', 'yyyy-mm-dd']];

/* ================= Baca data ================= */

function doGet(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = ss.getSpreadsheetTimeZone();
  const p = (e && e.parameter) || {};
  if (p.view === 'supplier') {
    try { return json_(supplierView_(ss, tz, p.rebuild === '1')); }
    catch (err) { return json_({ ok: false, error: String(err.message || err) }); }
  }
  return json_({
    ok: true,
    lines: readRows_(ss.getSheetByName(CONFIG.LINE_SHEET), 11).map(r => lineOut_(r, tz)),
    schedules: readRows_(ss.getSheetByName(CONFIG.SCHED_SHEET), 8).map(r => schedOut_(r, tz)),
    manual: readManual_(ss, tz),
    editLog: readEditLog_(ss, tz, 300),
    followups: readFollowups_(ss, tz),
    changes: readChanges_(ss, 4000),
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

    if (action === 'upload') {
      const res = upload_(ss, body, stamp);
      if (res.ok) markSupplierStale_();
      return json_(res);
    }

    const user = String(body.user || '').trim() || 'Website';

    if (action === 'saveFollowup') {
      saveFollowup_(ss, body, user, stamp, tz);
      return json_({ ok: true, time: stamp, followups: readFollowups_(ss, tz), editLog: readEditLog_(ss, tz, 300) });
    }

    const handlers = { saveLine: saveLine_, deleteLine: deleteLine_, saveSched: saveSched_, deleteSched: deleteSched_ };
    if (!handlers[action]) return json_({ ok: false, error: 'Aksi tidak dikenal: ' + action });

    const pos = handlers[action](ss, body, user, stamp, tz);
    markSupplierStale_();
    return json_(Object.assign({ ok: true, time: stamp, manual: readManual_(ss, tz), editLog: readEditLog_(ss, tz, 300) }, poData_(ss, pos, tz)));
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Upload export Odoo ---------- */

function upload_(ss, body, stamp) {
  const tz = ss.getSpreadsheetTimeZone();
  const prev = lastUpload_(ss, tz);
  const changes = computeChanges_(ss, body, stamp, prev ? prev.time : '', tz);   // dibandingkan sebelum data ditimpa
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
  writeChanges_(ss, changes);
  result.changes = {};
  changes.forEach(c => { result.changes[c[2]] = (result.changes[c[2]] || 0) + 1; });
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

/* ================= Perubahan per upload (LOG_PERUBAHAN) ================= */
// Kolom: WAKTU UPLOAD | UPLOAD SEBELUMNYA | JENIS | NO PO | KODE | NAMA MATERIAL | SUPPLIER | NILAI LAMA | NILAI BARU | TGL JADWAL | QTY
// Jenis: PO baru, Baris baru, Baris dihapus, Qty order berubah, Jadwal baru, Jadwal berubah, Jadwal dihapus, Diterima
const CHANGE_HEAD = ['WAKTU UPLOAD', 'UPLOAD SEBELUMNYA', 'JENIS', 'NO PO', 'KODE', 'NAMA MATERIAL', 'SUPPLIER',
  'NILAI LAMA', 'NILAI BARU', 'TGL JADWAL', 'QTY'];

function computeChanges_(ss, body, stamp, prevTime, tz) {
  const out = [];
  const oldLines = readRows_(ss.getSheetByName(CONFIG.LINE_SHEET), 11);
  if (!oldLines.length) return out;   // sheet masih kosong: upload ini menjadi data awal, belum ada pembanding
  const info = {};   // PO|kode → {name, sup}
  const add = (jenis, po, kode, lama, baru, tgl, qty) => {
    const i = info[po + '|' + kode] || {};
    out.push([stamp, prevTime, jenis, po, kode, i.name || '', i.sup || '', fmtVal_(lama), fmtVal_(baru), tgl || '', qty === undefined ? '' : qty]);
  };
  oldLines.forEach(r => { info[str_(r[0]) + '|' + str_(r[3])] = { name: r[4], sup: r[2] }; });
  (body.lines || []).forEach(r => { info[str_(r[0]) + '|' + str_(r[3])] = { name: r[4], sup: r[2] }; });

  // Baris PO (PO-DET)
  if (Array.isArray(body.lines) && body.lines.length) {
    const oldByPo = {};
    oldLines.forEach(r => { (oldByPo[str_(r[0])] = oldByPo[str_(r[0])] || {})[str_(r[3]) + '|' + Number(r[10] || 1)] = r; });
    const newByPo = {};
    body.lines.forEach(r => { (newByPo[str_(r[0])] = newByPo[str_(r[0])] || {})[str_(r[3]) + '|' + Number(r[9] || 1)] = r; });
    Object.keys(newByPo).forEach(po => {
      const o = oldByPo[po], n = newByPo[po];
      if (!o) { Object.keys(n).forEach(k => add('PO baru', po, k.split('|')[0], '', n[k][5] + ' ' + n[k][6], n[k][1], n[k][5])); return; }
      Object.keys(n).forEach(k => {
        const kode = k.split('|')[0];
        if (!o[k]) add('Baris baru', po, kode, '', n[k][5] + ' ' + n[k][6], '', n[k][5]);
        else if (Number(o[k][6]) !== Number(n[k][5])) add('Qty order berubah', po, kode, o[k][6], n[k][5], '', Number(n[k][5]) - Number(o[k][6]));
      });
      Object.keys(o).forEach(k => { if (!n[k]) add('Baris dihapus', po, k.split('|')[0], o[k][6] + ' ' + o[k][7], '', '', ''); });
    });
  }

  // Jadwal (PO-DEL), dicocokkan per PO + kode + jadwal ke
  if (Array.isArray(body.delPOs) && body.delPOs.length) {
    const pos = new Set(body.delPOs.map(str_));
    const oldS = {}, newS = {};
    readRows_(ss.getSheetByName(CONFIG.SCHED_SHEET), 8).forEach(r => {
      if (pos.has(str_(r[0]))) oldS[str_(r[0]) + '|' + str_(r[1]) + '|' + Number(r[3])] = r;
    });
    (body.schedules || []).forEach(r => { newS[str_(r[0]) + '|' + str_(r[1]) + '|' + Number(r[3])] = r; });
    const isNewPo = {};
    out.forEach(c => { if (c[2] === 'PO baru') isNewPo[c[3]] = true; });
    Object.keys(newS).forEach(k => {
      const n = newS[k], [po, kode] = k.split('|');
      const nDate = String(n[6] || ''), nRec = Number(n[5]) || 0;
      const o = oldS[k];
      if (!o) {
        if (!isNewPo[po]) add('Jadwal baru', po, kode, '', nDate + ' · ' + n[4], nDate, Number(n[4]) || 0);
        if (nRec > 0) add('Diterima', po, kode, 0, nRec, nDate, nRec);
        return;
      }
      const oDate = fmtDate_(o[6], tz), oRec = Number(o[5]) || 0;
      if (oDate !== nDate) add('Jadwal berubah', po, kode, oDate, nDate, nDate, Number(n[4]) || 0);
      if (nRec > oRec) add('Diterima', po, kode, oRec, nRec, nDate, nRec - oRec);
    });
    Object.keys(oldS).forEach(k => {
      if (newS[k]) return;
      const o = oldS[k], [po, kode] = k.split('|');
      add('Jadwal dihapus', po, kode, fmtDate_(o[6], tz) + ' · ' + o[4], '', fmtDate_(o[6], tz), Number(o[4]) || 0);
    });
  }
  return out;
}

function fmtVal_(v) { return v === undefined || v === null ? '' : String(v); }

function writeChanges_(ss, rows) {
  if (!rows.length) return;
  let sh = ss.getSheetByName(CONFIG.CHANGE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.CHANGE_SHEET);
    sh.getRange(1, 1, 1, CHANGE_HEAD.length).setValues([CHANGE_HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  const start = sh.getLastRow() + 1;
  if (sh.getMaxRows() < start + rows.length) sh.insertRowsAfter(sh.getMaxRows(), start + rows.length - sh.getMaxRows() + 200);
  sh.getRange(start, 1, rows.length, CHANGE_HEAD.length).setNumberFormat('@').setValues(rows.map(r => r.map(v => String(v ?? ''))));
}

function readChanges_(ss, limit) {
  const sh = ss.getSheetByName(CONFIG.CHANGE_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  const n = Math.min(limit, sh.getLastRow() - 1);
  return sh.getRange(sh.getLastRow() - n + 1, 1, n, CHANGE_HEAD.length).getDisplayValues();
}

/* ================= Tindak lanjut (PO_FOLLOWUP) ================= */
// Kolom: NO PO | KODE | STATUS | JANJI KIRIM | CATATAN | UPDATE TERAKHIR
const FOLLOW_STATUS = ['Belum dihubungi', 'Sudah dihubungi', 'Eskalasi', 'Selesai'];

function followSheet_(ss) {
  let sh = ss.getSheetByName(CONFIG.FOLLOWUP_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.FOLLOWUP_SHEET);
    sh.getRange(1, 1, 1, 6).setValues([['NO PO', 'KODE', 'STATUS', 'JANJI KIRIM', 'CATATAN', 'UPDATE TERAKHIR']]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function readFollowups_(ss, tz) {
  const sh = ss.getSheetByName(CONFIG.FOLLOWUP_SHEET);
  if (!sh) return [];
  return readRows_(sh, 6).map(r => [str_(r[0]), str_(r[1]), str_(r[2]), fmtDate_(r[3], tz), String(r[4] || ''), show_(r[5], tz)]);
}

function saveFollowup_(ss, body, user, stamp, tz) {
  const d = body.data || {};
  const po = str_(d.po), kode = str_(d.code);
  if (!po || !kode) throw new Error('No PO dan kode wajib ada.');
  const status = FOLLOW_STATUS.indexOf(d.status) >= 0 ? d.status : 'Belum dihubungi';
  const promise = /^\d{4}-\d{2}-\d{2}$/.test(String(d.promise || '')) ? d.promise : '';
  const note = String(d.note || '').trim();
  const sh = followSheet_(ss);
  const rows = readRows_(sh, 6).map(r => [str_(r[0]), str_(r[1]), str_(r[2]), fmtDate_(r[3], tz), String(r[4] || ''), show_(r[5], tz)]);
  let r = rows.find(x => x[0] === po && x[1] === kode);
  const old = r ? r.slice() : [po, kode, '', '', '', ''];
  if (!r) { r = [po, kode, '', '', '', '']; rows.push(r); }
  r[2] = status; r[3] = promise; r[4] = note; r[5] = stamp;
  const keep = rows.filter(x => x[2] !== 'Belum dihubungi' || x[3] || x[4]);   // baris kosong tidak disimpan
  writeTable_(sh, keep, 6, [['A', '@'], ['B', '@'], ['D', '@'], ['F', '@']]);
  const log = [];
  if (old[2] !== r[2]) log.push([stamp, user, 'Ubah follow-up', po, kode, 'Status', old[2], r[2]]);
  if (old[3] !== r[3]) log.push([stamp, user, 'Ubah follow-up', po, kode, 'Janji kirim', old[3], r[3]]);
  if (old[4] !== r[4]) log.push([stamp, user, 'Ubah follow-up', po, kode, 'Catatan', old[4], r[4]]);
  logEdit_(ss, log);
}

/* ================= Supplier & MoQ per material ================= */
// SUPPLIER_MATERIAL (di DATABASE PPIC, hasil hitung — jangan diketik): satu baris per material RM/PM + supplier.
// MoQ = histori, yaitu qty terkecil dalam satu PO untuk material + supplier tersebut.
const SUP_HEAD = ['KODE', 'NAMA MATERIAL', 'KATEGORI', 'UoM', 'SUPPLIER', 'SUPPLIER UTAMA', 'SUMBER',
  'JUMLAH PO', 'TOTAL QTY PO', 'MOQ (QTY PO TERKECIL)', 'QTY PO TERBESAR', 'NO PO TERAKHIR', 'TGL PO TERAKHIR',
  'HARGA TERAKHIR', 'KURS', 'LEAD TIME RATA-RATA (HARI)', 'DIHITUNG'];
const SUP_COLS = SUP_HEAD.length;

function supplierView_(ss, tz, forceRebuild) {
  const db = SpreadsheetApp.openById(CONFIG.DATABASE_ID);
  let sh = db.getSheetByName(CONFIG.SUPPLIER_SHEET);
  const stale = PropertiesService.getScriptProperties().getProperty('SUPPLIER_STALE') === '1';
  if (!sh || forceRebuild || stale || sh.getLastRow() < 2) sh = rebuildSupplier_(ss, db, tz);
  const rows = readRows_(sh, SUP_COLS).map(r => r.map((v, i) => (i === 12 ? fmtDate_(v, tz) : (i === 16 ? show_(v, tz) : v))));
  return { ok: true, rows: rows, builtAt: rows.length ? String(rows[0][16]) : '', databaseUrl: db.getUrl() };
}

function markSupplierStale_() {
  PropertiesService.getScriptProperties().setProperty('SUPPLIER_STALE', '1');
}

// Bisa juga dijalankan manual dari editor Apps Script (pilih fungsi ini → Run).
function rebuildSupplierNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  rebuildSupplier_(ss, SpreadsheetApp.openById(CONFIG.DATABASE_ID), ss.getSpreadsheetTimeZone());
}

function rebuildSupplier_(ss, db, tz) {
  const stamp = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm');
  const master = readRows_(db.getSheetByName(CONFIG.MASTER_SHEET), 4)
    .filter(r => CONFIG.SUPPLIER_CATS.indexOf(str_(r[3])) >= 0);
  const inMaster = {};
  master.forEach(r => { inMaster[str_(r[0])] = true; });

  // Kedatangan pertama yang sudah Done per PO + kode
  const firstDone = {};
  readRows_(ss.getSheetByName(CONFIG.SCHED_SHEET), 8).forEach(r => {
    if (str_(r[7]) !== 'Done' || !isDate_(r[6])) return;
    const k = str_(r[0]) + '|' + str_(r[1]);
    if (!firstDone[k] || r[6] < firstDone[k]) firstDone[k] = r[6];
  });

  // Ringkas riwayat PO per material + supplier
  const pairs = {}, byCode = {};
  readRows_(ss.getSheetByName(CONFIG.LINE_SHEET), 10).forEach(r => {
    const kode = str_(r[3]), sup = str_(r[2]);
    if (!inMaster[kode] || !sup) return;
    const k = kode + '|' + sup;
    let p = pairs[k];
    if (!p) { p = pairs[k] = { sup: sup, poQty: {}, total: 0, last: null, leads: {} }; (byCode[kode] = byCode[kode] || []).push(p); }
    const po = str_(r[0]), qty = Number(r[6]) || 0, date = isDate_(r[1]) ? r[1] : toDate_(r[1]);
    p.poQty[po] = (p.poQty[po] || 0) + qty;   // satu PO bisa punya beberapa baris kode yang sama
    p.total += qty;
    if (!p.last || (date && (date > p.last.date || (+date === +p.last.date && po > p.last.po)))) {
      p.last = { po: po, date: date, price: r[8], kurs: r[9] };
    }
    const fd = firstDone[po + '|' + kode];
    if (fd && date) p.leads[po] = Math.max(0, Math.round((fd - date) / 86400000));
  });

  const out = [];
  master.forEach(m => {
    const kode = str_(m[0]);
    const list = (byCode[kode] || []).slice();
    if (!list.length) {
      out.push([kode, m[1], m[3], m[2], '', '', 'Belum ada riwayat PO', 0, 0, '', '', '', '', '', '', '', stamp]);
      return;
    }
    // Supplier utama: PO terbanyak, lalu PO paling baru
    const nPo = p => Object.keys(p.poQty).length;
    const lastT = p => (p.last && p.last.date ? +p.last.date : 0);
    list.sort((a, b) => nPo(b) - nPo(a) || lastT(b) - lastT(a) || a.sup.localeCompare(b.sup));
    list.forEach((p, i) => {
      const qtys = Object.keys(p.poQty).map(k => p.poQty[k]).filter(q => q > 0);
      const leads = Object.keys(p.leads).map(k => p.leads[k]);
      const lead = leads.length ? Math.round(leads.reduce((a, b) => a + b, 0) / leads.length) : '';
      out.push([kode, m[1], m[3], m[2], p.sup, i === 0 ? 'Ya' : '', 'Riwayat PO',
        nPo(p), p.total, qtys.length ? Math.min.apply(null, qtys) : '', qtys.length ? Math.max.apply(null, qtys) : '',
        p.last.po, p.last.date || '', p.last.price, p.last.kurs, lead, stamp]);
    });
  });

  let sh = db.getSheetByName(CONFIG.SUPPLIER_SHEET);
  if (!sh) {
    sh = db.insertSheet(CONFIG.SUPPLIER_SHEET);
    sh.setFrozenRows(1);
  }
  sh.getRange(1, 1, 1, SUP_COLS).setValues([SUP_HEAD]).setFontWeight('bold');
  writeTable_(sh, out, SUP_COLS, [['A', '@'], ['M', 'yyyy-mm-dd'], ['Q', '@']]);
  PropertiesService.getScriptProperties().deleteProperty('SUPPLIER_STALE');
  return sh;
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
