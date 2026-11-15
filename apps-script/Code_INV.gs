/**
 * Value and Qty Inventory (RM, PM, dan FG) — PPIC GTK
 * Apps Script yang terpasang di Google Sheet "Value and Qty Inventory (RM, PM, dan FG)".
 * Berdiri sendiri: tidak membaca / menulis DATABASE PPIC GTK, MRP, PO, maupun CSL.
 *
 * Tab (dibuat otomatis bila belum ada):
 *   DB_GOLONGAN : KODE, NAMA, GOLONGAN (RM/PM/FG), KATEGORI, UOM, DIPERBARUI   — upload mengganti seluruh isi
 *   DB_HARGA    : KODE, HARGA, BERLAKU (yyyy-mm-dd), DIUPLOAD, FILE           — upload menambah baris (riwayat harga)
 *   STOK        : SNAPSHOT (yyyy-mm-dd HH:mm), KODE, LOKASI, QTY, SUMBER, CATATAN, KELOMPOK (MAT = RM+PM+WIP, FG)
 *   SNAPSHOT    : SNAPSHOT, FILE, BARIS, DIUPLOAD, CATATAN, KELOMPOK
 *   Stok Material dan FG diupload & disimpan terpisah: snapshot = kelompok + tanggal & jam.
 *   LOG         : WAKTU, AKSI, DETAIL
 *
 * Deploy: Extensions → Apps Script → tempel file ini → Deploy → New deployment → Web app
 *         (Execute as: Me, Who has access: Anyone) → salin URL /exec ke website.
 */
const INV_TABS = {
  DB_GOLONGAN: ['KODE', 'NAMA', 'GOLONGAN', 'KATEGORI', 'UOM', 'DIPERBARUI'],
  DB_HARGA: ['KODE', 'HARGA', 'BERLAKU', 'DIUPLOAD', 'FILE'],
  STOK: ['SNAPSHOT', 'KODE', 'LOKASI', 'QTY', 'SUMBER', 'CATATAN', 'KELOMPOK'],
  SNAPSHOT: ['SNAPSHOT', 'FILE', 'BARIS', 'DIUPLOAD', 'CATATAN', 'KELOMPOK'],
  LOG: ['WAKTU', 'AKSI', 'DETAIL'],
};
const INV_TEXT_COLS = { DB_GOLONGAN: [1, 2, 3, 4, 5, 6], DB_HARGA: [1, 3, 4, 5], STOK: [1, 2, 3, 5, 6, 7], SNAPSHOT: [1, 2, 4, 5, 6], LOG: [1, 2, 3] };

function doGet(e) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    invSetup_(ss);
    return invJson_(invRead_(ss));
  } catch (err) {
    return invJson_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    const body = JSON.parse(e.postData.contents || '{}');
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    invSetup_(ss);
    const now = invNow_();
    let msg;
    if (body.action === 'saveGolongan') msg = invSaveGolongan_(ss, body, now);
    else if (body.action === 'addHarga') msg = invAddHarga_(ss, body, now);
    else if (body.action === 'saveStok') msg = invSaveStok_(ss, body, now);
    else if (body.action === 'editStok') msg = invEditStok_(ss, body, now);
    else throw new Error('Aksi tidak dikenal: ' + body.action);
    SpreadsheetApp.flush();
    const out = invRead_(ss);
    out.message = msg;
    return invJson_(out);
  } catch (err) {
    return invJson_({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (x) { /* abaikan */ }
  }
}

/* ---------- Setup tab ---------- */
function invSetup_(ss) {
  Object.keys(INV_TABS).forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) {
      const first = ss.getSheets()[0];
      // Spreadsheet baru: pakai Sheet1 kosong untuk tab pertama
      if (name === 'DB_GOLONGAN' && first && first.getLastRow() === 0 && !INV_TABS[first.getName()]) { sh = first; sh.setName(name); }
      else sh = ss.insertSheet(name);
    }
    const h = INV_TABS[name];
    if (sh.getLastRow() === 0) {
      INV_TEXT_COLS[name].forEach(function (c) { sh.getRange(1, c, sh.getMaxRows(), 1).setNumberFormat('@'); });
      sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold').setBackground('#e8f0e9');
      sh.setFrozenRows(1);
    } else {
      // Kolom baru (mis. KELOMPOK) ditambahkan ke header lama
      const cur = sh.getRange(1, 1, 1, h.length).getValues()[0];
      h.forEach(function (x, i) {
        if (String(cur[i]).trim() === '') {
          if (INV_TEXT_COLS[name].indexOf(i + 1) >= 0) sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat('@');
          sh.getRange(1, i + 1).setValue(x).setFontWeight('bold').setBackground('#e8f0e9');
        }
      });
    }
  });
}

/* ---------- Baca semua ---------- */
function invRead_(ss) {
  const rows = function (name, n) {
    const sh = ss.getSheetByName(name), last = sh.getLastRow();
    if (last < 2) return [];
    return sh.getRange(2, 1, last - 1, n).getValues().filter(function (r) { return String(r[0]).trim() !== '' || String(r[1]).trim() !== ''; })
      .map(function (r) { return r.map(invCell_); });
  };
  return {
    ok: true,
    sheetUrl: ss.getUrl(),
    readAt: invNow_(),
    golongan: rows('DB_GOLONGAN', 6),
    harga: rows('DB_HARGA', 5),
    stok: rows('STOK', 7),
    snapshot: rows('SNAPSHOT', 6),
    log: rows('LOG', 3).slice(-200),
  };
}

/* ---------- Aksi ---------- */
// body: { rows: [[kode, nama, golongan, kategori, uom]], file }
function invSaveGolongan_(ss, body, now) {
  const rows = (body.rows || []).map(function (r) { return [invS_(r[0]), invS_(r[1]), invS_(r[2]).toUpperCase(), invS_(r[3]), invS_(r[4]), now]; })
    .filter(function (r) { return r[0]; });
  if (!rows.length) throw new Error('Tidak ada baris golongan.');
  invReplace_(ss.getSheetByName('DB_GOLONGAN'), rows, 6);
  invLog_(ss, now, 'Upload golongan', (body.file || '') + ' · ' + rows.length + ' kode');
  return rows.length + ' kode golongan disimpan.';
}

// body: { rows: [[kode, harga]], berlaku: 'yyyy-mm-dd', file }
function invAddHarga_(ss, body, now) {
  const berlaku = invS_(body.berlaku);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(berlaku)) throw new Error('Tanggal berlaku harga tidak valid.');
  const rows = (body.rows || []).map(function (r) { return [invS_(r[0]), Number(r[1]), berlaku, now, invS_(body.file)]; })
    .filter(function (r) { return r[0] && isFinite(r[1]); });
  if (!rows.length) throw new Error('Tidak ada baris harga.');
  const sh = ss.getSheetByName('DB_HARGA');
  // Harga dengan kode + tanggal berlaku yang sama diganti (bukan dobel)
  const keep = invAll_(sh, 5).filter(function (r) {
    if (invCell_(r[2]) !== berlaku) return true;
    return !rows.some(function (x) { return x[0] === invS_(r[0]); });
  });
  invReplace_(sh, keep.map(function (r) { return [invS_(r[0]), Number(r[1]), invCell_(r[2]), invCell_(r[3]), invS_(r[4])]; }).concat(rows), 5);
  invLog_(ss, now, 'Upload harga', (body.file || '') + ' · berlaku ' + berlaku + ' · ' + rows.length + ' kode');
  return rows.length + ' harga disimpan (berlaku ' + berlaku + ').';
}

// body: { kel: 'MAT'|'FG', snapshot: 'yyyy-mm-dd HH:mm', rows: [[kode, lokasi, qty]], file, note }
// Menimpa hanya snapshot kelompok yang sama (stok Material dan FG terpisah).
function invSaveStok_(ss, body, now) {
  const snap = invS_(body.snapshot), kel = invKel_(body.kel);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(snap)) throw new Error('Tanggal & jam snapshot tidak valid.');
  const rows = (body.rows || []).map(function (r) { return [snap, invS_(r[0]), invS_(r[1]), Number(r[2]) || 0, 'upload', '', kel]; })
    .filter(function (r) { return r[1]; });
  if (!rows.length) throw new Error('Tidak ada baris stok.');
  const sh = ss.getSheetByName('STOK');
  const keep = invAll_(sh, 7).map(invStokRow_).filter(function (r) { return !(r[0] === snap && r[6] === kel); });
  invReplace_(sh, keep.concat(rows), 7);
  const sn = ss.getSheetByName('SNAPSHOT');
  const sk = invAll_(sn, 6).map(function (r) { return r.map(invCell_).map(invS_); }).filter(function (r) { return !(r[0] === snap && r[5] === kel); });
  sk.push([snap, invS_(body.file), String(rows.length), now, invS_(body.note), kel]);
  sk.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[5] < b[5] ? -1 : 1; });
  invReplace_(sn, sk, 6);
  invLog_(ss, now, 'Upload stok ' + (kel === 'FG' ? 'FG' : 'Material'), snap + ' · ' + (body.file || '') + ' · ' + rows.length + ' baris');
  return 'Snapshot ' + (kel === 'FG' ? 'FG' : 'Material') + ' ' + snap + ' disimpan (' + rows.length + ' baris).';
}

// body: { kel, snapshot, changes: [{ kode, lokasi, qty }], reason }
function invEditStok_(ss, body, now) {
  const snap = invS_(body.snapshot), kel = invKel_(body.kel), reason = invS_(body.reason);
  if (!reason) throw new Error('Alasan koreksi wajib diisi.');
  const sh = ss.getSheetByName('STOK');
  const all = invAll_(sh, 7).map(invStokRow_);
  const det = [];
  (body.changes || []).forEach(function (c) {
    const kode = invS_(c.kode), lok = invS_(c.lokasi), qty = Number(c.qty);
    if (!kode || !isFinite(qty)) return;
    const r = all.find(function (x) { return x[0] === snap && x[6] === kel && x[1] === kode && x[2] === lok; });
    if (r) { det.push(kode + ' @' + (lok || '-') + ': ' + r[3] + ' → ' + qty); r[3] = qty; r[4] = 'manual'; r[5] = reason; }
    else { det.push(kode + ' @' + (lok || '-') + ': baru ' + qty); all.push([snap, kode, lok, qty, 'manual', reason, kel]); }
  });
  if (!det.length) throw new Error('Tidak ada perubahan.');
  invReplace_(sh, all, 7);
  invLog_(ss, now, 'Koreksi stok ' + (kel === 'FG' ? 'FG' : 'Material'), snap + ' · ' + reason + ' · ' + det.join('; '));
  return det.length + ' baris stok dikoreksi.';
}

/* ---------- Util ---------- */
function invAll_(sh, n) { const last = sh.getLastRow(); return last < 2 ? [] : sh.getRange(2, 1, last - 1, n).getValues().filter(function (r) { return String(r[0]).trim() !== ''; }); }
function invStokRow_(r) { return [invS_(invCell_(r[0])), invS_(r[1]), invS_(r[2]), Number(r[3]) || 0, invS_(r[4]), invS_(r[5]), invS_(r[6])]; }
function invKel_(v) { return String(v || '').toUpperCase() === 'FG' ? 'FG' : 'MAT'; }
function invReplace_(sh, rows, n) {
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, n).clearContent();
  if (rows.length) {
    if (sh.getMaxRows() < rows.length + 1) sh.insertRowsAfter(sh.getMaxRows(), rows.length + 1 - sh.getMaxRows());
    sh.getRange(2, 1, rows.length, n).setValues(rows);
  }
}
function invLog_(ss, now, aksi, detail) { ss.getSheetByName('LOG').appendRow([now, aksi, String(detail).slice(0, 45000)]); }
function invS_(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function invCell_(v) {
  if (v instanceof Date) {
    const tz = Session.getScriptTimeZone() || 'Asia/Jakarta';
    const hm = Utilities.formatDate(v, tz, 'HH:mm');
    return Utilities.formatDate(v, tz, 'yyyy-MM-dd') + (hm === '00:00' ? '' : ' ' + hm);
  }
  return v;
}
function invNow_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Jakarta', 'yyyy-MM-dd HH:mm:ss'); }
function invJson_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
