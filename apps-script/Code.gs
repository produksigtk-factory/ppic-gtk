/**
 * PPIC Gondowangi — penghubung website <-> Google Sheet "MONITORING PO" (PROJECT 1: Purchase Order)
 * Menu MRP memakai Apps Script tersendiri di Google Sheet "MRP PPIC GTK" (apps-script/Code_MRP.gs).
 *
 * Dipasang di: MONITORING PO → Extensions → Apps Script.
 * - doGet  : website membaca PO_LINE, PO_SCHEDULE, tanda edit manual, dan riwayat edit.
 *            Disimpan di cache 5 menit (dihapus setiap upload/edit); ?fresh=1 selalu membaca langsung.
 *            ?view=supplier → daftar supplier & MoQ (histori) per material RM/PM (tab SUPPLIER_MATERIAL di DATABASE PPIC).
 * - doPost : upload export Odoo, edit manual, dan Purchase Request (REKAP_PR) dari website (dilindungi PIN).
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
  CANCEL_SHEET: 'PO_CANCEL',       // PO / baris yang di-cancel lewat website (tidak tersentuh upload)
  CHANGE_SHEET: 'LOG_PERUBAHAN',   // perubahan yang terdeteksi di setiap upload export Odoo
  SUPPLIER_SHEET: 'SUPPLIER_MATERIAL',  // di DATABASE PPIC: hasil hitung otomatis (jangan diketik)
  SUPPLIER_CATS: ['RM (Raw)', 'PM (Pack)'],
  MONITOR_SHEET: 'MONITORING_PO',  // tampilan di Google Sheet: diisi Apps Script sebagai tabel biasa (tanpa rumus berat)
  PR_SHEET: 'REKAP_PR',            // Purchase Request: satu baris = satu material di satu PR (tidak tersentuh upload Odoo)
  PR_LAMP_SHEET: 'LAMPIRAN_PR',    // daftar lampiran per Kode PR; file gambar disimpan di Google Drive (folder PR_LAMP_FOLDER)
  PR_LAMP_FOLDER: 'Lampiran PR - PPIC GTK',   // dibuat otomatis di folder yang sama dengan Sheet MONITORING PO (tidak dibagikan publik)
};
const MONITOR_VERSION = '2';      // naikkan bila susunan tab MONITORING_PO berubah
const LINE_COLS = 13;   // A–M PO_LINE
const SCHED_COLS = 10;  // A–J PO_SCHEDULE (K dan L berisi rumus kunci di baris judul)
const LINE_FMT = [['D', '@'], ['B', 'yyyy-mm-dd']];
const SCHED_FMT = [['B', '@'], ['G', 'yyyy-mm-dd']];

/* ================= Baca data ================= */

function doGet(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = ss.getSpreadsheetTimeZone();
  const p = (e && e.parameter) || {};
  if (p.view === 'prlamp') {   // isi satu gambar lampiran PR (base64) supaya website bisa menampilkan tanpa membagikan file
    try { return json_(prLampFile_(ss, String(p.id || ''))); }
    catch (err) { return json_({ ok: false, error: String(err.message || err) }); }
  }
  if (p.view === 'supplier') {
    try { return json_(supplierView_(ss, tz, p.rebuild === '1')); }
    catch (err) { return json_({ ok: false, error: String(err.message || err) }); }
  }
  // Sekali setelah versi ini dipasang: ganti rumus di tab MONITORING_PO dengan tabel biasa
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('MONITOR_VERSION') !== MONITOR_VERSION) {
    try { refreshMonitorSheet(); props.setProperty('MONITOR_VERSION', MONITOR_VERSION); } catch (err) { /* tetap kirim data ke website */ }
  }
  // Isi lengkap disimpan di cache Apps Script (maks. 5 menit) supaya website terbuka cepat.
  // Cache dihapus setiap ada upload/edit dari website; tombol "Muat ulang data" mengirim fresh=1 (selalu baca langsung).
  const cache = CacheService.getScriptCache();
  if (p.fresh !== '1') {
    const hit = getBig_(cache, 'po_main');
    if (hit) { hit.cached = true; return json_(hit); }
  }
  const out = {
    ok: true,
    lines: readRows_(ss.getSheetByName(CONFIG.LINE_SHEET), 11).map(r => lineOut_(r, tz)),
    schedules: readRows_(ss.getSheetByName(CONFIG.SCHED_SHEET), 8).map(r => schedOut_(r, tz)),
    manual: readManual_(ss, tz),
    editLog: readEditLog_(ss, tz, 300),
    followups: readFollowups_(ss, tz),
    cancels: readCancels_(ss, tz),
    changes: readChanges_(ss, 4000),
    lastUpload: lastUpload_(ss, tz),
    pr: readPr_(ss, tz),
    prLamp: readPrLamp_(ss, tz),
    readAt: Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm'),
  };
  putBig_(cache, 'po_main', out, 300);
  return json_(out);
}

/* ---------- Cache Apps Script (maks. 100 KB per kunci → dipecah) ---------- */
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
function clearMainCache_() {
  try { CacheService.getScriptCache().remove('po_main_n'); } catch (e) { /* abaikan */ }
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
    clearMainCache_();   // data akan berubah: website berikutnya membaca langsung dari Sheet

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tz = ss.getSpreadsheetTimeZone();
    const stamp = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm');

    if (action === 'upload') {
      const res = upload_(ss, body, stamp);
      if (res.ok) { markSupplierStale_(); scheduleMonitorRefresh_(); }
      return json_(res);
    }

    const user = String(body.user || '').trim() || 'Website';

    if (action === 'setCancel') {
      setCancel_(ss, body, user, stamp, tz);
      markSupplierStale_();
      scheduleMonitorRefresh_();
      return json_({ ok: true, time: stamp, cancels: readCancels_(ss, tz), editLog: readEditLog_(ss, tz, 300) });
    }

    if (action === 'saveFollowup') {
      saveFollowup_(ss, body, user, stamp, tz);
      return json_({ ok: true, time: stamp, followups: readFollowups_(ss, tz), editLog: readEditLog_(ss, tz, 300) });
    }

    if (action === 'addPrLamp' || action === 'delPrLamp') {
      if (action === 'addPrLamp') addPrLamp_(ss, body.data || {}, user, stamp); else delPrLamp_(ss, body.data || {}, user, stamp);
      return json_({ ok: true, time: stamp, prLamp: readPrLamp_(ss, tz), editLog: readEditLog_(ss, tz, 300) });
    }
    if (action === 'savePr' || action === 'uploadPr') {
      const codes = action === 'savePr' ? [savePr_(ss, body.data || {}, user, stamp, tz)] : uploadPr_(ss, body.data || {}, user, stamp, tz);
      return json_({ ok: true, time: stamp, codes, pr: readPr_(ss, tz), editLog: readEditLog_(ss, tz, 300) });
    }

    const handlers = { saveLine: saveLine_, deleteLine: deleteLine_, saveSched: saveSched_, deleteSched: deleteSched_ };
    if (!handlers[action]) return json_({ ok: false, error: 'Aksi tidak dikenal: ' + action });

    const pos = handlers[action](ss, body, user, stamp, tz);
    markSupplierStale_();
    scheduleMonitorRefresh_();
    return json_(Object.assign({ ok: true, time: stamp, manual: readManual_(ss, tz), editLog: readEditLog_(ss, tz, 300) }, poData_(ss, pos, tz)));
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  } finally {
    clearMainCache_();   // sekali lagi setelah selesai menulis
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

// Edit manual menulis hanya baris yang berubah (bukan seluruh tab) supaya simpan cepat.
// rowNo = nomor baris di Sheet untuk setiap baris data (tahan terhadap baris kosong di tengah).
function readRowsIdx_(sh, cols) {
  const last = sh.getLastRow();
  if (last < 2) return { rows: [], rowNo: [] };
  const vals = sh.getRange(2, 1, last - 1, cols).getValues();
  const rows = [], rowNo = [];
  vals.forEach((r, i) => { if (str_(r[0]) !== '') { rows.push(r); rowNo.push(i + 2); } });
  return { rows, rowNo };
}
// Nomori ulang LINE KE / JADWAL KE untuk satu PO + kode saja, tulis hanya sel yang berubah.
function renumberKey_(sh, t, poIdx, codeIdx, nIdx, po, kode) {
  let n = 0;
  t.rows.forEach((r, i) => {
    if (str_(r[poIdx]) !== po || str_(r[codeIdx]) !== kode) return;
    n++;
    if (Number(r[nIdx]) !== n) { r[nIdx] = n; sh.getRange(t.rowNo[i], nIdx + 1).setValue(n); }
  });
}
// Hapus beberapa baris Sheet, dari bawah ke atas supaya nomor baris tidak bergeser.
function deleteSheetRows_(sh, nums) {
  nums.slice().sort((x, y) => y - x).forEach(n => sh.deleteRow(n));
}

function saveLine_(ss, body, user, stamp, tz) {
  const d = body.data || {};
  const po = str_(d.po), kode = str_(d.code);
  if (!po || !kode) throw new Error('No PO dan Kode wajib diisi.');
  if (d.qty === '' || isNaN(Number(d.qty))) throw new Error('Qty Order harus berupa angka.');
  if (Number(d.qty) < 0) throw new Error('Qty Order tidak boleh minus. Isi 0 untuk take out.');

  const sh = ss.getSheetByName(CONFIG.LINE_SHEET);
  const t = readRowsIdx_(sh, LINE_COLS);
  let idx = -1, old = null;
  if (body.key) {
    idx = findLine_(t.rows, body.key);
    if (idx < 0) throw new Error('Baris PO tidak ditemukan (mungkin sudah berubah). Muat ulang data lalu coba lagi.');
    old = t.rows[idx].slice();
  }
  const sameKey = old && str_(old[0]) === po && str_(old[3]) === kode;
  const kategori = old && str_(old[3]) === kode ? old[5] : kategoriOf_(kode);
  const row = [po, toDate_(d.date), String(d.supplier || '').trim(), kode, String(d.name || '').trim(), kategori,
    Number(d.qty), String(d.uom || '').trim(), numOrBlank_(d.price), String(d.kurs || '').trim(),
    old ? old[10] : 1, old ? old[11] : 'Manual', stamp];

  if (sameKey) {
    sh.getRange(t.rowNo[idx], 1, 1, LINE_COLS).setValues([row]);          // ubah di tempat
  } else {
    if (!old) {
      row[10] = t.rows.filter(r => str_(r[0]) === po && str_(r[3]) === kode).length + 1;
      sh.getRange(Math.max(sh.getLastRow(), 1) + 1, 1, 1, LINE_COLS).setValues([row]);   // tambah di bawah
    } else {
      row[10] = t.rows.filter(r => str_(r[0]) === po && str_(r[3]) === kode).length + 1;
      sh.getRange(t.rowNo[idx], 1, 1, LINE_COLS).setValues([row]);
      t.rows[idx] = row;
      renumberKey_(sh, t, 0, 3, 10, str_(old[0]), str_(old[3]));       // rapikan urutan kode lama
    }
  }

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
  const t = readRowsIdx_(sh, LINE_COLS);
  const idx = findLine_(t.rows, body.key || {});
  if (idx < 0) throw new Error('Baris PO tidak ditemukan (mungkin sudah berubah). Muat ulang data lalu coba lagi.');
  const old = t.rows[idx];
  const po = str_(old[0]), kode = str_(old[3]);
  sh.deleteRow(t.rowNo[idx]);
  const after = readRowsIdx_(sh, LINE_COLS);
  renumberKey_(sh, after, 0, 3, 10, po, kode);
  const log = [[stamp, user, 'Hapus baris PO', po, kode, '', old[4] + ' · ' + old[6] + ' ' + old[7], '']];

  const groupLeft = after.rows.some(r => str_(r[0]) === po && str_(r[3]) === kode);
  if (body.withSchedules && !groupLeft) {
    const ssh = ss.getSheetByName(CONFIG.SCHED_SHEET);
    const st = readRowsIdx_(ssh, SCHED_COLS);
    const del = st.rowNo.filter((n, i) => str_(st.rows[i][0]) === po && str_(st.rows[i][1]) === kode);
    if (del.length) {
      deleteSheetRows_(ssh, del);
      log.push([stamp, user, 'Hapus jadwal', po, kode, '', del.length + ' jadwal ikut dihapus', '']);
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
  if (Number(d.qty) < 0 || Number(d.rec) < 0) throw new Error('Qty tidak boleh minus.');

  const sh = ss.getSheetByName(CONFIG.SCHED_SHEET);
  const t = readRowsIdx_(sh, SCHED_COLS);
  let idx = -1, old = null;
  if (body.key) {
    idx = findSched_(t.rows, body.key);
    if (idx < 0) throw new Error('Jadwal tidak ditemukan (mungkin sudah berubah). Muat ulang data lalu coba lagi.');
    old = t.rows[idx].slice();
  }
  const n = old ? old[3] : t.rows.filter(r => str_(r[0]) === po && str_(r[1]) === kode).length + 1;
  const row = [po, kode, String(d.name || (old ? old[2] : '')).trim(), n, Number(d.qty) || 0, Number(d.rec) || 0,
    toDate_(d.date), String(d.status || 'Confirmed').trim(), old ? old[8] : 'Manual', stamp];
  const at = old ? t.rowNo[idx] : Math.max(sh.getLastRow(), 1) + 1;     // ubah di tempat, atau tambah di bawah
  sh.getRange(at, 1, 1, SCHED_COLS).setValues([row]);

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
  if (log.length) markManual_(ss, [po], 'sched', user, stamp);
  return [po];
}

function deleteSched_(ss, body, user, stamp, tz) {
  const sh = ss.getSheetByName(CONFIG.SCHED_SHEET);
  const t = readRowsIdx_(sh, SCHED_COLS);
  const idx = findSched_(t.rows, body.key || {});
  if (idx < 0) throw new Error('Jadwal tidak ditemukan (mungkin sudah berubah). Muat ulang data lalu coba lagi.');
  const old = t.rows[idx];
  const po = str_(old[0]), kode = str_(old[1]);
  sh.deleteRow(t.rowNo[idx]);
  renumberKey_(sh, readRowsIdx_(sh, SCHED_COLS), 0, 1, 3, po, kode);
  logEdit_(ss, [[stamp, user, 'Hapus jadwal', po, kode, '', show_(old[6], tz) + ' · ' + old[4] + ' · ' + old[7], '']]);
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
  const t = readRowsIdx_(sh, 5);
  pos.forEach(po => {
    const i = t.rows.findIndex(x => str_(x[0]) === po);
    const r = i >= 0 ? t.rows[i].slice() : [po, '', '', '', ''];
    if (part === 'lines') r[1] = 'Ya'; else r[2] = 'Ya';
    r[3] = stamp; r[4] = user;
    const at = i >= 0 ? t.rowNo[i] : Math.max(sh.getLastRow(), 1) + 1;
    sh.getRange(at, 4).setNumberFormat('@');
    sh.getRange(at, 1, 1, 5).setValues([r]);
    if (i < 0) { t.rows.push(r); t.rowNo.push(at); }
  });
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

/* ================= Cancel PO (PO_CANCEL) ================= */
// Kolom: NO PO | KODE (kosong = seluruh PO) | ALASAN | DIBATALKAN | OLEH. Tidak tersentuh upload.

function cancelSheet_(ss) {
  let sh = ss.getSheetByName(CONFIG.CANCEL_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.CANCEL_SHEET);
    sh.getRange(1, 1, 1, 5).setValues([['NO PO', 'KODE (KOSONG = SELURUH PO)', 'ALASAN', 'DIBATALKAN', 'OLEH']]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('A:B').setNumberFormat('@');
    sh.getRange('D:D').setNumberFormat('@');
  }
  return sh;
}

function readCancels_(ss, tz) {
  const sh = ss.getSheetByName(CONFIG.CANCEL_SHEET);
  if (!sh) return [];
  return readRows_(sh, 5).map(r => [str_(r[0]), str_(r[1]), String(r[2] || ''), show_(r[3], tz), String(r[4] || '')]);
}

function cancelSet_(ss) {
  const set = {};
  const sh = ss.getSheetByName(CONFIG.CANCEL_SHEET);
  if (sh) readRows_(sh, 2).forEach(r => { set[str_(r[0]) + '|' + str_(r[1])] = true; });
  return set;
}

function setCancel_(ss, body, user, stamp, tz) {
  const d = body.data || {};
  const po = str_(d.po), kode = str_(d.code);          // kode kosong = seluruh PO
  if (!po) throw new Error('No PO wajib ada.');
  const sh = cancelSheet_(ss);
  const t = readRowsIdx_(sh, 5);
  const i = t.rows.findIndex(r => str_(r[0]) === po && str_(r[1]) === kode);
  const what = kode ? 'baris' : 'PO';
  if (d.cancel) {
    const reason = String(d.reason || '').trim();
    if (!reason) throw new Error('Alasan cancel wajib diisi.');
    const row = [po, kode, reason, stamp, user];
    const at = i >= 0 ? t.rowNo[i] : Math.max(sh.getLastRow(), 1) + 1;
    sh.getRange(at, 1, 1, 5).setValues([row]);
    logEdit_(ss, [[stamp, user, kode ? 'Cancel baris' : 'Cancel PO', po, kode, 'Alasan', i >= 0 ? String(t.rows[i][2]) : '', reason]]);
  } else {
    if (i < 0) throw new Error('Tanda cancel untuk ' + what + ' ini tidak ditemukan. Muat ulang data lalu coba lagi.');
    const old = String(t.rows[i][2]);
    sh.deleteRow(t.rowNo[i]);
    logEdit_(ss, [[stamp, user, kode ? 'Aktifkan lagi baris' : 'Aktifkan lagi PO', po, kode, 'Alasan cancel', old, '']]);
  }
}

/* ================= Purchase Request (REKAP_PR) ================= */
// Satu baris = satu material di satu PR. Kode PR otomatis PR/GTK/YYMM/NNN mengikuti bulan TANGGAL PR (nomor urut per bulan).
// NO PO boleh lebih dari satu (dipisah koma). STATUS: Aktif / Batal. Tidak tersentuh upload export Odoo.
const PR_HEAD = ['KODE PR', 'TANGGAL PR', 'NO', 'KODE', 'NAMA ITEM', 'JENIS', 'NOTE', 'STOK AWAL', 'KEBUTUHAN', 'OS PO', 'KEKURANGAN',
  'JUMLAH BUKA PO', 'PEMAKAIAN (BULAN)', 'TANGGAL KIRIM', 'NO PO', 'STATUS', 'DIUBAH', 'OLEH'];
const PR_COLS = PR_HEAD.length;
const PR_FMT = [['A', '@'], ['B', '@'], ['D', '@'], ['N', '@'], ['O', '@'], ['Q', '@']];

function prSheet_(ss) {
  let sh = ss.getSheetByName(CONFIG.PR_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.PR_SHEET);
    sh.getRange(1, 1, 1, PR_COLS).setValues([PR_HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
    PR_FMT.forEach(([c, f]) => sh.getRange(c + ':' + c).setNumberFormat(f));
  }
  return sh;
}
// [kodePr, tanggal, no, kode, nama, jenis, note, stok, kebutuhan, osPo, kekurangan, buka, pemakaian, tglKirim, noPo, status, diubah, oleh]
function readPr_(ss, tz) {
  const sh = ss.getSheetByName(CONFIG.PR_SHEET);
  if (!sh) return [];
  return readRows_(sh, PR_COLS).map(r => [str_(r[0]), fmtDate_(r[1], tz), Number(r[2]) || 0, str_(r[3]), String(r[4] || ''), String(r[5] || ''), String(r[6] || ''),
    numOrBlank_(r[7]), numOrBlank_(r[8]), numOrBlank_(r[9]), numOrBlank_(r[10]), numOrBlank_(r[11]), numOrBlank_(r[12]),
    fmtDate_(r[13], tz), str_(r[14]), str_(r[15]) || 'Aktif', show_(r[16], tz), String(r[17] || '')]);
}
function nextPrCode_(all, tanggal) {
  const pre = 'PR/GTK/' + tanggal.slice(2, 4) + tanggal.slice(5, 7) + '/';
  let max = 0;
  all.forEach(r => { if (r[0].indexOf(pre) === 0) { const n = Number(r[0].slice(pre.length)); if (n > max) max = n; } });
  return pre + String(max + 1).padStart(3, '0');
}
// Ganti seluruh baris satu Kode PR (kodePr kosong = PR baru). rows: [kode, nama, jenis, note, stok, kebutuhan, osPo, kekurangan, buka, pemakaian, tglKirim, noPo, status]
function applyPr_(all, d, stamp, user, log) {
  const tanggal = str_(d.tanggal);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) throw new Error('Tanggal PR wajib diisi (format tanggal).');
  const rows = (d.rows || []).filter(r => str_(r[0]));
  if (!rows.length) throw new Error('PR harus berisi minimal satu kode material.');
  let kode = str_(d.kodePr);
  const isNew = !kode;
  if (isNew) kode = nextPrCode_(all, tanggal);
  else if (!/^PR\/GTK\/\d{4}\/\d+$/.test(kode)) throw new Error('Format Kode PR tidak dikenal: ' + kode + ' (contoh PR/GTK/2611/001).');
  const old = all.filter(r => r[0] === kode);
  const oldPo = {}; old.forEach(r => { oldPo[r[3]] = r[14]; });
  const keep = all.filter(r => r[0] !== kode);
  const nb = (v) => (v === '' || v === null || v === undefined || isNaN(Number(v)) ? '' : Number(v));
  const dt = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(str_(v)) ? str_(v) : '');
  const add = rows.map((r, i) => [kode, tanggal, i + 1, str_(r[0]), String(r[1] || ''), String(r[2] || ''), String(r[3] || ''),
    nb(r[4]), nb(r[5]), nb(r[6]), nb(r[7]), nb(r[8]), nb(r[9]), dt(r[10]),
    String(r[11] || '').split(/[,;\s]+/).map(str_).filter(Boolean).join(', '), str_(r[12]) === 'Batal' ? 'Batal' : 'Aktif', stamp, user]);
  log.push([stamp, user, isNew ? 'Buat PR' : (old.length ? 'Ubah PR' : 'Buat PR'), kode, '', 'Jumlah baris', old.length ? String(old.length) : '', String(add.length)]);
  add.forEach(r => { if ((oldPo[r[3]] || '') !== r[14] && (old.length || r[14])) log.push([stamp, user, 'No PO di PR', kode, r[3], 'No PO', oldPo[r[3]] || '', r[14]]); });
  const nBatal = add.filter(r => r[15] === 'Batal').length;
  if (nBatal) log.push([stamp, user, 'Status PR', kode, '', 'Baris batal', '', String(nBatal)]);
  keep.push(...add);
  all.length = 0; all.push(...keep);
  return kode;
}
function writePr_(ss, all) {
  all.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[2] - b[2]));
  writeTable_(prSheet_(ss), all, PR_COLS, PR_FMT);
}
function savePr_(ss, d, user, stamp, tz) {
  const all = readPr_(ss, tz).map(r => { r[16] = r[16] || ''; return r; });
  const log = [];
  const kode = applyPr_(all, d, stamp, user, log);
  writePr_(ss, all);
  logEdit_(ss, log);
  return kode;
}
// Upload Excel: groups [{ kodePr, tanggal, rows }] — Kode PR kosong = PR baru, Kode PR ada = isinya diganti dengan isi file
function uploadPr_(ss, d, user, stamp, tz) {
  const groups = d.groups || [];
  if (!groups.length) throw new Error('Tidak ada baris PR di file.');
  const all = readPr_(ss, tz);
  const log = [], codes = [];
  groups.forEach(g => codes.push(applyPr_(all, g, stamp, user, log)));
  writePr_(ss, all);
  log.push([stamp, user, 'Upload PR', '', '', 'File', '', String(d.file || '') + ' · ' + codes.length + ' PR']);
  logEdit_(ss, log);
  return codes;
}

/* ---------- Lampiran PR (gambar di Google Drive, daftar di tab LAMPIRAN_PR) ---------- */
const LAMP_HEAD = ['KODE PR', 'ID', 'JENIS', 'FILE ID', 'NAMA FILE', 'KETERANGAN', 'DIBUAT', 'OLEH'];
function prLampSheet_(ss) {
  let sh = ss.getSheetByName(CONFIG.PR_LAMP_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.PR_LAMP_SHEET);
    sh.getRange(1, 1, 1, LAMP_HEAD.length).setValues([LAMP_HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('A:H').setNumberFormat('@');
  }
  return sh;
}
// [kodePr, id, jenis, fileId, nama, keterangan, dibuat, oleh]
function readPrLamp_(ss, tz) {
  const sh = ss.getSheetByName(CONFIG.PR_LAMP_SHEET);
  if (!sh) return [];
  return readRows_(sh, LAMP_HEAD.length).map(r => [str_(r[0]), str_(r[1]), str_(r[2]), str_(r[3]), String(r[4] || ''), String(r[5] || ''), show_(r[6], tz), String(r[7] || '')]);
}
function prLampFolder_(ss) {
  const parents = DriveApp.getFileById(ss.getId()).getParents();
  const base = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const it = base.getFoldersByName(CONFIG.PR_LAMP_FOLDER);
  return it.hasNext() ? it.next() : base.createFolder(CONFIG.PR_LAMP_FOLDER);
}
function addPrLamp_(ss, d, user, stamp) {
  const kode = str_(d.kodePr);
  if (!kode) throw new Error('Kode PR wajib ada.');
  if (!readPr_(ss, ss.getSpreadsheetTimeZone()).some(r => r[0] === kode)) throw new Error('Kode PR ' + kode + ' tidak ada di Rekap PR.');
  const mime = /^image\/(png|jpeg|webp|gif)$/.test(String(d.mime || '')) ? d.mime : '';
  if (!mime || !d.data) throw new Error('Lampiran harus berupa gambar.');
  const ext = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];
  const sh = prLampSheet_(ss);
  const n = readRows_(sh, 2).filter(r => str_(r[0]) === kode).length + 1;
  const name = kode.replace(/\//g, '-') + ' - lampiran ' + n + '.' + ext;
  const file = prLampFolder_(ss).createFile(Utilities.newBlob(Utilities.base64Decode(d.data), mime, name));
  file.setDescription(kode + (d.caption ? ' · ' + d.caption : ''));
  const id = 'L' + Date.now() + Math.floor(Math.random() * 1000);
  sh.getRange(sh.getLastRow() + 1, 1, 1, LAMP_HEAD.length).setNumberFormat('@').setValues([[kode, id, 'Gambar', file.getId(), name, String(d.caption || ''), stamp, user]]);
  logEdit_(ss, [[stamp, user, 'Lampiran PR', kode, '', 'Tambah gambar', '', name]]);
}
function delPrLamp_(ss, d, user, stamp) {
  const sh = prLampSheet_(ss);
  const t = readRowsIdx_(sh, LAMP_HEAD.length);
  const i = t.rows.findIndex(r => str_(r[1]) === str_(d.id));
  if (i < 0) throw new Error('Lampiran tidak ditemukan. Muat ulang data lalu coba lagi.');
  const r = t.rows[i];
  try { DriveApp.getFileById(str_(r[3])).setTrashed(true); } catch (err) { /* file sudah tidak ada */ }   // masuk Sampah Drive, masih bisa dipulihkan
  sh.deleteRow(t.rowNo[i]);
  logEdit_(ss, [[stamp, user, 'Lampiran PR', str_(r[0]), '', 'Hapus gambar', String(r[4] || ''), '']]);
}
function prLampFile_(ss, id) {
  const r = readPrLamp_(ss, ss.getSpreadsheetTimeZone()).find(x => x[1] === id);
  if (!r) throw new Error('Lampiran tidak ditemukan.');
  const blob = DriveApp.getFileById(r[3]).getBlob();
  return { ok: true, mime: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
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
  const cancelled = cancelSet_(ss);
  readRows_(ss.getSheetByName(CONFIG.LINE_SHEET), 10).forEach(r => {
    const kode = str_(r[3]), sup = str_(r[2]);
    if (!inMaster[kode] || !sup) return;
    if ((Number(r[6]) || 0) <= 0) return;                                        // take out (qty 0) tidak dihitung
    if (cancelled[str_(r[0]) + '|'] || cancelled[str_(r[0]) + '|' + kode]) return;   // PO / baris yang di-cancel tidak dihitung
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
// Jenis material untuk satu kode. Daftar master disimpan sementara (6 jam) supaya tidak membuka DATABASE setiap simpan.
function kategoriOf_(kode) {
  const cache = CacheService.getScriptCache();
  let map = null;
  try { const c = cache.get('MASTER_KAT'); if (c) map = JSON.parse(c); } catch (e) { map = null; }
  if (!map || !(kode in map)) {
    map = masterKategori_();
    try { cache.put('MASTER_KAT', JSON.stringify(map), 21600); } catch (e) { /* terlalu besar untuk cache: abaikan */ }
  }
  return map[kode] || '';
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
  const n = Math.min(500, sh.getLastRow() - 1);
  const rows = sh.getRange(sh.getLastRow() - n + 1, 1, n, 3).getValues();
  const t = (v) => (isDate_(v) ? Utilities.formatDate(v, tz, 'yyyy-MM-dd HH:mm') : String(v));
  const v = rows[rows.length - 1];
  const out = { time: t(v[0]), det: v[1], del: v[2], detTime: '', detFile: '', delTime: '', delFile: '' };
  // Waktu upload terakhir masing-masing file (PO-DET dan PO-DEL bisa di-upload terpisah)
  for (let i = rows.length - 1; i >= 0 && (!out.detTime || !out.delTime); i--) {
    if (!out.detTime && str_(rows[i][1])) { out.detTime = t(rows[i][0]); out.detFile = str_(rows[i][1]); }
    if (!out.delTime && str_(rows[i][2])) { out.delTime = t(rows[i][0]); out.delFile = str_(rows[i][2]); }
  }
  return out;
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

/* ================= Tab MONITORING_PO (tampilan di Google Sheet) ================= */
// Dulu tab ini memakai rumus ARRAYFORMULA/MAP yang dihitung ulang setiap PO_LINE/PO_SCHEDULE berubah,
// sehingga setiap simpan dari website menunggu Google Sheet selesai menghitung (bisa sampai 1 menit).
// Sekarang Apps Script mengisinya sebagai tabel biasa: ±1 menit setelah upload/edit (di latar belakang),
// atau langsung lewat menu PPIC → Perbarui tab MONITORING_PO.

function onOpen() {
  SpreadsheetApp.getUi().createMenu('PPIC').addItem('Perbarui tab MONITORING_PO', 'refreshMonitorSheet').addToUi();
}

// Jadwalkan pembaruan tab ±1 menit lagi (sekali saja walau ada beberapa edit berturut-turut).
function scheduleMonitorRefresh_() {
  try {
    const pending = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'refreshMonitorSheet');
    if (!pending) ScriptApp.newTrigger('refreshMonitorSheet').timeBased().after(60 * 1000).create();
  } catch (err) { /* izin pemicu belum diberikan: tab diperbarui saat upload berikutnya atau lewat menu */ }
}

function refreshMonitorSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  buildMonitorSheet_(ss, ss.getSpreadsheetTimeZone());
  try {
    ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'refreshMonitorSheet') ScriptApp.deleteTrigger(t); });
  } catch (err) { /* abaikan */ }
}

function buildMonitorSheet_(ss, tz) {
  const sh = ss.getSheetByName(CONFIG.MONITOR_SHEET);
  if (!sh) return;
  const lines = readRows_(ss.getSheetByName(CONFIG.LINE_SHEET), 11).map((r, i) => ({ r, i }));
  const sched = readRows_(ss.getSheetByName(CONFIG.SCHED_SHEET), 8);
  const sb = {};
  sched.forEach(x => { const k = str_(x[0]) + '|' + str_(x[1]); (sb[k] = sb[k] || []).push(x); });
  Object.keys(sb).forEach(k => sb[k].sort((a, b) => num_(a[3]) - num_(b[3])));

  const dkey = v => (isDate_(v) ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : String(v || '').slice(0, 10));
  lines.sort((a, b) => {
    const x = dkey(a.r[1]), y = dkey(b.r[1]);
    if (x !== y) return x < y ? -1 : 1;                          // Order Date terlama di atas
    const p = str_(a.r[0]), q = str_(b.r[0]);
    if (p !== q) return p < q ? -1 : 1;
    return a.i - b.i;
  });

  // Qty diterima dibagi berurutan (LINE KE) ke baris kode yang sama; baris qty 0 (take out) tidak ikut dibagi
  const groups = {};
  lines.forEach(x => { const k = str_(x.r[0]) + '|' + str_(x.r[3]); (groups[k] = groups[k] || []).push(x); });
  const os = new Map();
  Object.keys(groups).forEach(k => {
    const ord = groups[k].slice().sort((a, b) => num_(a.r[10]) - num_(b.r[10]));
    let rem = (sb[k] || []).reduce((t, x) => t + (Number(x[5]) || 0), 0);
    const active = ord.filter(x => (Number(x.r[6]) || 0) > 0);
    const last = active.length ? active[active.length - 1] : ord[ord.length - 1];
    ord.forEach(x => {
      const q = Number(x.r[6]) || 0;
      const rec = x === last ? rem : (q > 0 ? Math.min(q, rem) : 0);
      rem -= rec;
      os.set(x, q - rec);
    });
  });

  const cancels = {};
  readCancels_(ss, tz).forEach(c => { cancels[c[0] + '|' + c[1]] = c[2]; });
  const out = lines.map(x => {
    const r = x.r, k = str_(r[0]) + '|' + str_(r[3]);
    const cancelWhy = cancels[str_(r[0]) + '|'] || cancels[k];
    const qty = Number(r[6]) || 0, price = r[8] === '' ? '' : Number(r[8]);
    const lineKe = num_(r[10]) || 1, n = groups[k].length;
    const first = lineKe === Math.min.apply(null, groups[k].map(y => num_(y.r[10]) || 1));
    const list = first ? (sb[k] || []) : [];
    const cells = [];
    for (let j = 0; j < 5; j++) {
      const s = list[j];
      cells.push(s ? Number(s[4]) || 0 : '', s ? Number(s[5]) || 0 : '', s ? toDate_(s[6]) || '' : '', s ? s[7] : '');
    }
    const o = os.get(x);
    const notes = [];
    if (cancelWhy) notes.push('CANCEL (website): ' + cancelWhy + '.');
    if (qty <= 0) notes.push('Take out (qty order 0).');
    if (n > 1) notes.push('Kode ganda di PO ini: jadwal tercatat di baris pertama, qty diterima dibagi berurutan ke tiap baris.');
    if (list.length > 5) notes.push('Jadwal lebih dari 5, selengkapnya di PO_SCHEDULE.');
    return [str_(r[0]), toDate_(r[1]) || r[1], r[2], str_(r[3]), r[4], r[5], qty, r[7], price, r[9],
      price === '' ? '' : qty * price, o, qty ? (qty - o) / qty : '']
      .concat(cells, [first ? list.length : '', notes.join(' '), lineKe]);
  });

  const COLS = 36, START = 6;
  const need = START - 1 + out.length;
  if (sh.getMaxRows() < need + 10) sh.insertRowsAfter(sh.getMaxRows(), need + 200 - sh.getMaxRows());
  sh.getRange(START, 1, sh.getMaxRows() - START + 1, COLS).clearContent();   // hapus rumus lama dan isi lama
  sh.getRange(START, 4, Math.max(out.length, 1), 1).setNumberFormat('@');     // kode material sebagai teks
  if (out.length) sh.getRange(START, 1, out.length, COLS).setValues(out);
  sh.getRange('A2').setValue('Diisi otomatis oleh Apps Script dari PO_LINE dan PO_SCHEDULE: ±1 menit setelah upload atau edit manual, atau lewat menu PPIC → Perbarui tab MONITORING_PO. Terakhir diperbarui '
    + Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm') + '. Jangan mengetik langsung di tab ini.');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
