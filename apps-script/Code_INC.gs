/**
 * Apps Script Incoming RMPM — dipasang di Google Sheet "Incoming RMPM"
 * (Extensions → Apps Script → tempel file ini → Deploy → New deployment → Web app,
 *  Execute as: Me, Who has access: Anyone).
 *
 * Tab:
 *  INCOMING : 1 baris = 1 penerimaan. SUMBER = Report (Jan–Jun 2026 dari file report), Odoo (export Receipt), Manual (WIP maklon, dll.)
 *  REASON   : alasan Largest Incoming per bulan + kelompok + kode (diketik di website)
 *  LOG      : riwayat perubahan
 *
 * Tidak terhubung ke Monitoring PO: No PO hanya teks.
 * - doGet               : semua baris INCOMING, REASON, LOG (80 terakhir)
 * - doPost replaceOdoo  : ganti baris Odoo Received untuk bulan yang dikirim + seluruh baris Ready to Receive
 * - doPost saveManual   : tambah / ubah baris Manual   · deleteManual : hapus baris Manual
 * - doPost saveReason   : simpan alasan Largest Incoming
 */
const INC = {
  TZ: 'Asia/Jakarta',
  CUTOFF: '2026-07',   // bulan pertama yang memakai data Odoo; sebelumnya dari Report
  HEAD: {
    INCOMING: ['ID', 'SUMBER', 'KELOMPOK', 'TANGGAL', 'BULAN', 'NO IN', 'NO PO', 'SUPPLIER', 'KODE', 'NAMA', 'QTY', 'UOM', 'SERIAL NUMBER', 'HARGA', 'STATUS', 'CATATAN', 'DIUBAH'],
    REASON: ['BULAN', 'KELOMPOK', 'KODE', 'ALASAN', 'DIUBAH'],
    LOG: ['WAKTU', 'AKSI', 'REF', 'JUMLAH', 'KETERANGAN'],
  },
  NUM: { INCOMING: [10, 13] },   // kolom angka (0-based): QTY, HARGA
};

function doGet() {
  try { return json_(readAll_(SpreadsheetApp.getActiveSpreadsheet())); }
  catch (e) { return json_({ ok: false, error: String(e && e.message || e) }); }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    const b = JSON.parse(e.postData.contents || '{}');
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const now = now_();
    if (b.action === 'replaceOdoo') replaceOdoo_(ss, b, now);
    else if (b.action === 'saveManual') saveManual_(ss, b, now);
    else if (b.action === 'deleteManual') deleteManual_(ss, b, now);
    else if (b.action === 'saveReason') saveReason_(ss, b, now);
    else throw new Error('Aksi tidak dikenal: ' + b.action);
    return json_(readAll_(ss));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (x) { /* abaikan */ }
  }
}

/* ======================= BACA ======================= */
function readAll_(ss) {
  const rows = rows_(sheet_(ss, 'INCOMING'), INC.HEAD.INCOMING.length).map(r => r.map((v, i) => (INC.NUM.INCOMING.indexOf(i) >= 0 ? n_(v) : s_(v))));
  const reason = rows_(sheet_(ss, 'REASON'), 5).map(r => r.map(s_));
  const lg = sheet_(ss, 'LOG'), n = lg.getLastRow() - 1;
  const log = n > 0 ? lg.getRange(Math.max(2, n - 78), 1, Math.min(n, 80), 5).getValues().reverse().map(r => r.map(s_)) : [];
  return { ok: true, rows, reason, log, cutoff: INC.CUTOFF, sheetUrl: ss.getUrl(), readAt: now_() };
}

/* ======================= TULIS ======================= */
// Upload export Odoo: baris Received bulan >= CUTOFF yang dikirim menggantikan baris Odoo bulan itu; Ready to Receive diganti semuanya.
function replaceOdoo_(ss, b, now) {
  const months = (b.months || []).map(String).filter(m => m >= INC.CUTOFF);
  const set = {}; months.forEach(m => { set[m] = 1; });
  const sh = sheet_(ss, 'INCOMING'), W = INC.HEAD.INCOMING.length;
  const all = rows_(sh, W);
  const keep = all.filter(r => {
    if (s_(r[1]) !== 'Odoo') return true;
    if (s_(r[14]) === 'Ready to Receive') return !b.replaceRtr;
    return !set[s_(r[4])];
  });
  const stamp = Utilities.formatDate(new Date(), INC.TZ, 'yyMMddHHmmss');
  let k = 0;
  const add = [];
  (b.rows || []).forEach(x => {
    const m = s_(x.bulan);
    const rtr = s_(x.status) === 'Ready to Receive';
    if (!rtr && !set[m]) return;
    if (rtr && !b.replaceRtr) return;
    add.push(['O-' + stamp + '-' + (++k), 'Odoo', '', s_(x.tanggal), rtr ? '' : m, s_(x.noIn), s_(x.po), s_(x.supplier), s_(x.kode), s_(x.nama),
      n_(x.qty), s_(x.uom), s_(x.sn), n_(x.harga), rtr ? 'Ready to Receive' : 'Received', s_(b.file), now]);
  });
  writeAll_(sh, keep.concat(add));
  log_(ss, now, 'Upload export Odoo', s_(b.file), add.length,
    `bulan diganti: ${months.join(', ') || '-'}${b.replaceRtr ? ' · Ready to Receive diganti' : ''} · baris lama dihapus ${all.length - keep.length}`);
}

function saveManual_(ss, b, now) {
  const x = b.row || {};
  if (!s_(x.kode)) throw new Error('Kode wajib diisi.');
  if (!/^\d{4}-\d{2}-\d{2}/.test(s_(x.tanggal))) throw new Error('Tanggal wajib diisi (yyyy-mm-dd).');
  if (!(n_(x.qty) > 0)) throw new Error('Qty harus lebih dari 0.');
  const sh = sheet_(ss, 'INCOMING'), W = INC.HEAD.INCOMING.length;
  const all = rows_(sh, W);
  const id = s_(b.id);
  const row = [id || 'M-' + Utilities.formatDate(new Date(), INC.TZ, 'yyMMddHHmmss') + '-' + Math.floor(Math.random() * 900 + 100), 'Manual',
    s_(x.kelompok), s_(x.tanggal).slice(0, 10), s_(x.tanggal).slice(0, 7), s_(x.noIn), s_(x.po), s_(x.supplier), s_(x.kode), s_(x.nama),
    n_(x.qty), s_(x.uom), s_(x.sn), n_(x.harga), 'Received', s_(x.catatan), now];
  if (id) {
    const i = all.findIndex(r => s_(r[0]) === id);
    if (i < 0) throw new Error('Baris ' + id + ' tidak ditemukan. Muat ulang data.');
    if (s_(all[i][1]) !== 'Manual') throw new Error('Hanya baris Manual yang bisa diubah.');
    all[i] = row;
    writeAll_(sh, all);
  } else {
    writeAll_(sh, all.concat([row]));
  }
  log_(ss, now, id ? 'Ubah incoming manual' : 'Tambah incoming manual', row[0], 1, `${row[8]} ${row[9]} · ${row[10]} · ${row[3]}`);
}

function deleteManual_(ss, b, now) {
  const id = s_(b.id);
  const sh = sheet_(ss, 'INCOMING'), W = INC.HEAD.INCOMING.length;
  const all = rows_(sh, W);
  const i = all.findIndex(r => s_(r[0]) === id);
  if (i < 0) throw new Error('Baris ' + id + ' tidak ditemukan. Muat ulang data.');
  if (s_(all[i][1]) !== 'Manual') throw new Error('Hanya baris Manual yang bisa dihapus.');
  const del = all.splice(i, 1)[0];
  writeAll_(sh, all);
  log_(ss, now, 'Hapus incoming manual', id, 1, `${s_(del[8])} ${s_(del[9])} · ${n_(del[10])} · ${s_(del[3])}`);
}

function saveReason_(ss, b, now) {
  const m = s_(b.bulan), kel = s_(b.kelompok), kode = s_(b.kode), txt = s_(b.alasan);
  if (!m || !kode) throw new Error('Bulan dan kode wajib.');
  const sh = sheet_(ss, 'REASON');
  const all = rows_(sh, 5).map(r => r.map(s_));
  const i = all.findIndex(r => r[0] === m && r[1] === kel && r[2] === kode);
  if (i >= 0) { if (txt) all[i] = [m, kel, kode, txt, now]; else all.splice(i, 1); }
  else if (txt) all.push([m, kel, kode, txt, now]);
  const n = sh.getLastRow() - 1;
  if (n > 0) sh.getRange(2, 1, n, 5).clearContent();
  if (all.length) sh.getRange(2, 1, all.length, 5).setNumberFormat('@').setValues(all);
}

/* ======================= Utilitas ======================= */
function writeAll_(sh, rows) {
  const W = INC.HEAD.INCOMING.length, n = sh.getLastRow() - 1;
  if (n > 0) sh.getRange(2, 1, n, W).clearContent();
  if (!rows.length) return;
  const out = rows.map(r => { const x = r.slice(0, W); while (x.length < W) x.push(''); return x.map((v, i) => (INC.NUM.INCOMING.indexOf(i) >= 0 ? n_(v) : s_(v))); });
  if (sh.getMaxRows() < out.length + 1) sh.insertRowsAfter(sh.getMaxRows(), out.length + 1 - sh.getMaxRows());
  const rg = sh.getRange(2, 1, out.length, W);
  rg.setNumberFormat('@');
  sh.getRange(2, 11, out.length, 1).setNumberFormat('0.###');
  sh.getRange(2, 14, out.length, 1).setNumberFormat('0.####');
  rg.setValues(out);
}
function log_(ss, now, aksi, ref, n, ket) {
  const sh = sheet_(ss, 'LOG');
  sh.appendRow([now, aksi, ref, n, ket]);
}
function sheet_(ss, name) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    const h = INC.HEAD[name];
    if (h) { sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold'); sh.setFrozenRows(1); }
  }
  return sh;
}
function rows_(sh, w) {
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, w).getValues().filter(r => r.some(v => v !== '' && v !== null));
}
function s_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    const t = Utilities.formatDate(v, INC.TZ, 'yyyy-MM-dd HH:mm');
    return t.slice(11) === '00:00' ? t.slice(0, 10) : t;
  }
  return String(v).trim();
}
function n_(v) { const x = Number(String(v === null || v === undefined ? '' : v).replace(/,/g, '')); return isFinite(x) ? x : 0; }
function now_() { return Utilities.formatDate(new Date(), INC.TZ, 'yyyy-MM-dd HH:mm'); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
