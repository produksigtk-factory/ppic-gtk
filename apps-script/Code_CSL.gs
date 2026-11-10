/**
 * Apps Script CSL PPIC GTK — dipasang di Google Sheet "CSL PPIC GTK"
 * (Extensions → Apps Script → tempel file ini → Deploy → New deployment → Web app,
 *  Execute as: Me, Who has access: Anyone).
 *
 * - doGet  ?action=meta   : parameter, master (DATABASE PPIC GTK), daftar bulan + versi, forecast, log
 * - doGet  ?action=months&m=2026-09,2026-10 : baris SO & DO milik bulan SO tersebut (ringkas)
 * - doPost {action:...}   : replaceMonths, finishExcel (upload Excel CSL: INPUT SODO, (GTK), (BIMS)), saveNilai, saveParam
 *
 * SO_LINES dan DO_LINES selalu tersimpan urut per BULAN (bulan SO) supaya satu bulan
 * bisa dibaca sebagai satu blok baris. Setiap bulan punya VERSI di tab MONTHS; website
 * menyimpan salinan per bulan di browser dan hanya mengambil ulang bulan yang versinya berubah.
 * Belum memakai PIN (sesuai permintaan) — semua yang punya alamat website bisa upload.
 */
const CSL_CONFIG = {
  DATABASE_ID: '1Qp8FkQXPLtV89e9NBoIMY5oLY6_DXLzQEr3HemkHI6g',
  MASTER_SHEET: 'MASTER_MATERIAL',
  WEEK_SHEET: 'PEMBAGIAN_WEEK',
  DIST_SHEET: 'DISTRIBUTOR',
  KOTA_SHEET: 'KOTA_REF',
  TZ: 'Asia/Jakarta',
  // Untuk halaman Kapasitas Google Sheet (hanya membaca ukuran tab, tidak membaca isi)
  OTHER: [
    ['MONITORING PO', '1Dw7HmExGNYYDkbNgYTPA7zwEr6ueUMhdtjdlR7tCBdU'],
    ['MRP PPIC GTK', '1nx0gqSM8UzVKYMvqyzHmCvafZIcEKZLCswGJ7o3rQ9c'],
  ],
};
const CSL_HEAD = {
  SO_LINES: { head: ['BULAN', 'NO SO', 'TANGGAL SO', 'DISTRIBUTOR', 'ORDER REF', 'KODE', 'NAMA PRODUK', 'QTY SO', 'HARGA/PCS', 'DIUPLOAD', 'KODE DIST', 'KOTA', 'REGION', 'STATUS', 'WEEK'], text: [1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15] },
  DO_LINES: { head: ['BULAN SO', 'NO DO', 'TANGGAL DO', 'NO SO', 'KODE', 'BATCH', 'QTY DO', 'STATUS', 'DIUPLOAD'], text: [1, 2, 3, 4, 5, 6, 8, 9] },
  FORECAST: { head: ['BULAN', 'KODE', 'REGION', 'QTY FCT (PCS)', 'SUMBER', 'DIUBAH'], text: [1, 2, 3, 5, 6] },
  FCT_NILAI: { head: ['BULAN', 'REGION', 'NILAI FCT (RP)', 'SUMBER', 'DIUBAH'], text: [1, 2, 4, 5] },
  MONTHS: { head: ['BULAN', 'VERSI', 'BARIS SO', 'BARIS DO', 'DIUBAH', 'HASH'], text: [1, 2, 5, 6] },
  PARAMETER: { head: ['PARAMETER', 'NILAI', 'KETERANGAN'], text: [1] },
  PRODUK_SO: { head: ['KODE', 'NAMA DI SO'], text: [1, 2] },
  TUGAS: { head: ['ID', 'SIGNATURE', 'CATATAN', 'DITANDAI', 'JUDUL'], text: [1, 2, 3, 4, 5] },
  LOG_CSL: { head: ['WAKTU', 'AKSI', 'REF', 'JUMLAH BARIS', 'KETERANGAN'], text: [1, 2, 3, 5] },
};

/* ======================= BACA ======================= */
function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (p.action === 'months') return json_(readMonths_(ss, s_(p.m).split(',').map(s_).filter(Boolean)));
    if (p.action === 'usage') return json_(usage_(ss));
    if (p.action === 'tasks') return json_({ ok: true, tasks: readTasks_(ss) });
    return json_(readMeta_(ss, p.fresh === '1'));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function readMeta_(ss, fresh) {
  const t0 = Date.now(), ms = {};
  // Master dari DATABASE PPIC GTK jarang berubah: disimpan di cache Apps Script 10 menit.
  // "Muat ulang data" di website mengirim fresh=1 sehingga selalu dibaca langsung.
  const D = dbMaster_(fresh);
  ms.database = Date.now() - t0;
  const params = rows_(sheet_(ss, 'PARAMETER'), 3).map(r => [s_(r[0]), r[1], s_(r[2])]);
  const months = rows_(sheet_(ss, 'MONTHS'), 6).map(r => [s_(r[0]), s_(r[1]), n_(r[2]), n_(r[3]), s_(r[4]), s_(r[5])]);
  const fct = rows_(sheet_(ss, 'FORECAST'), 4).map(r => [s_(r[0]), s_(r[1]), s_(r[2]), n_(r[3])]);
  const nilai = rows_(sheet_(ss, 'FCT_NILAI'), 5).map(r => [s_(r[0]), s_(r[1]), n_(r[2]), s_(r[3]), s_(r[4])]);
  ms.csl = Date.now() - t0 - ms.database;
  // Nama produk seperti di SO (untuk kode yang belum ada di MASTER_MATERIAL) — dari tab PRODUK_SO yang kecil
  const names = {};
  produk_(ss).forEach(r => { names[r[0]] = r[1]; });
  const logSh = sheet_(ss, 'LOG_CSL'), nLog = logSh.getLastRow() - 1;
  const log = nLog > 0 ? logSh.getRange(Math.max(2, nLog - 78), 1, Math.min(nLog, 80), 5).getValues().reverse()
    .map(r => [s_(r[0]), s_(r[1]), s_(r[2]), n_(r[3]), s_(r[4])]) : [];
  ms.total = Date.now() - t0;
  return {
    ok: true, version: 2, params, master: D.master, dist: D.dist, kota: D.kota, weeks: D.weeks, months, fct, nilai, names, log,
    sheetUrl: ss.getUrl(), dbUrl: D.dbUrl, readAt: now_(), ms, cached: D.cached,
  };
}
function dbMaster_(fresh) {
  const cache = CacheService.getScriptCache();
  if (!fresh) {
    const hit = getBig_(cache, 'dbmaster');
    if (hit) { hit.cached = true; return hit; }
  }
  const tz = CSL_CONFIG.TZ;
  const db = SpreadsheetApp.openById(CSL_CONFIG.DATABASE_ID);
  const master = rows_(db.getSheetByName(CSL_CONFIG.MASTER_SHEET), 4).map(r => [s_(r[0]), s_(r[1]), s_(r[3])]);
  const dist = rows_(db.getSheetByName(CSL_CONFIG.DIST_SHEET), 3).map(r => [s_(r[0]), s_(r[1]), s_(r[2])]);
  const kota = rows_(db.getSheetByName(CSL_CONFIG.KOTA_SHEET), 2).map(r => [s_(r[0]), s_(r[1])]);
  const weeks = [];
  rows_(db.getSheetByName(CSL_CONFIG.WEEK_SHEET), 4).forEach(r => {
    const d = d_(r[0], tz, 'yyyy-MM-dd'), w = s_(r[2]), b = d_(r[3], tz, 'yyyy-MM') || d.slice(0, 7);
    if (!d || !w) return;
    const last = weeks[weeks.length - 1];
    if (last && last[0] === b && last[1] === w) last[3] = d; else weeks.push([b, w, d, d]);
  });
  const out = { master, dist, kota, weeks, dbUrl: db.getUrl() };
  putBig_(cache, 'dbmaster', out, 600);
  out.cached = false;
  return out;
}
// CacheService maksimal 100 KB per kunci: data dipecah beberapa kunci
function putBig_(cache, key, obj, ttl) {
  try {
    const s = JSON.stringify(obj), size = 90000, parts = {};
    const n = Math.ceil(s.length / size);
    for (let i = 0; i < n; i++) parts[key + '_' + i] = s.slice(i * size, (i + 1) * size);
    parts[key + '_n'] = String(n);
    cache.putAll(parts, ttl);
  } catch (e) { /* cache gagal: abaikan, data tetap dibaca langsung */ }
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
// Daftar kode → nama produk dari SO (tab PRODUK_SO). Dibuat sekali dari SO_LINES bila masih kosong.
function produk_(ss) {
  const sh = sheet_(ss, 'PRODUK_SO');
  let rows = rows_(sh, 2).map(r => [s_(r[0]), s_(r[1])]);
  if (!rows.length) {
    const so = sheet_(ss, 'SO_LINES'), n = so.getLastRow() - 1;
    if (n > 0) {
      const m = new Map();
      so.getRange(2, 6, n, 2).getValues().forEach(r => { const k = s_(r[0]); if (k && !m.has(k)) m.set(k, s_(r[1])); });
      rows = [...m.entries()].sort((a, c) => cmp_(a[0], c[0]));
      if (rows.length) sh.getRange(2, 1, rows.length, 2).setValues(rows);
    }
  }
  return rows;
}
function addProduk_(ss, pairs) {
  const sh = sheet_(ss, 'PRODUK_SO');
  const old = readAll_(sh, 2);
  const have = new Set(old.map(r => s_(r[0])));
  const add = [];
  pairs.forEach(([k, n]) => { if (k && !have.has(k)) { have.add(k); add.push([k, n]); } });
  if (add.length) sh.getRange(old.length + 2, 1, add.length, 2).setValues(add);
}

// Satu atau beberapa bulan SO: {so:{h:{noSO:[tgl,distributor,ref]}, l:[[noSO,kode,qty,harga]]}, do:{h:{noDO:[tgl,status]}, l:[[noDO,noSO,kode,batch,qty]]}}
function readMonths_(ss, list) {
  const want = new Set(list);
  const out = {};
  list.forEach(m => { out[m] = { so: { h: {}, l: [] }, do: { h: {}, l: [] } }; });
  const ver = {};
  rows_(sheet_(ss, 'MONTHS'), 2).forEach(r => { ver[s_(r[0])] = s_(r[1]); });
  blocks_(sheet_(ss, 'SO_LINES'), 15, want).forEach(r => {
    const m = out[s_(r[0])]; if (!m) return;
    const no = s_(r[1]);
    // [tanggal, distributor, order ref, kode dist, kota, region, status, week] — 5 terakhir dari Excel CSL
    if (!m.so.h[no]) m.so.h[no] = [s_(r[2]), s_(r[3]), s_(r[4]), s_(r[10]), s_(r[11]), s_(r[12]), s_(r[13]), s_(r[14])];
    m.so.l.push([no, s_(r[5]), n_(r[7]), n_(r[8])]);
  });
  blocks_(sheet_(ss, 'DO_LINES'), 8, want).forEach(r => {
    const m = out[s_(r[0])]; if (!m) return;
    const no = s_(r[1]);
    if (!m.do.h[no]) m.do.h[no] = [s_(r[2]), s_(r[7])];
    m.do.l.push([no, s_(r[3]), s_(r[4]), s_(r[5]), n_(r[6])]);
  });
  list.forEach(m => { out[m].ver = ver[m] || ''; });
  return { ok: true, months: out };
}

// Baca hanya blok baris bulan yang diminta (kolom A sudah urut)
function blocks_(sh, ncol, want) {
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const col = sh.getRange(2, 1, n, 1).getValues();
  const ranges = [];
  let start = -1, cur = '';
  for (let i = 0; i <= n; i++) {
    const b = i < n ? s_(col[i][0]) : '\u0000';
    if (b !== cur) {
      if (start >= 0 && want.has(cur)) ranges.push([start, i - start]);
      start = i; cur = b;
    }
  }
  let out = [];
  ranges.forEach(([s, len]) => { out = out.concat(sh.getRange(2 + s, 1, len, ncol).getValues()); });
  return out;
}

// Ukuran tiap Google Sheet: batas Google = 10.000.000 sel per file (dihitung dari baris × kolom yang tersedia, termasuk yang kosong)
function usage_(ss) {
  const list = [['CSL PPIC GTK', ss], ['DATABASE PPIC GTK', CSL_CONFIG.DATABASE_ID]].concat(CSL_CONFIG.OTHER);
  const files = list.map(([name, x]) => {
    try {
      const f = typeof x === 'string' ? SpreadsheetApp.openById(x) : x;
      return {
        name, url: f.getUrl(), ok: true,
        tabs: f.getSheets().map(sh => [sh.getName(), sh.getMaxRows(), sh.getMaxColumns(), sh.getLastRow(), sh.getLastColumn()]),
      };
    } catch (err) {
      return { name, ok: false, error: String(err && err.message || err), tabs: [] };
    }
  });
  const months = rows_(sheet_(ss, 'MONTHS'), 4).map(r => [s_(r[0]), n_(r[2]), n_(r[3])]);
  return { ok: true, files, months, limit: 10000000, readAt: now_() };
}

/* ======================= TULIS ======================= */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const b = JSON.parse(e.postData.contents || '{}');
    lock.waitLock(60000);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const now = now_();
    let res;
    switch (b.action) {
      case 'verify': res = { ok: true }; break;
      case 'replaceMonths': res = replaceMonths_(ss, b, now); break;
      case 'finishExcel': res = finishExcel_(ss, b, now); break;
      case 'saveNilai': res = saveNilai_(ss, b, now); break;
      case 'saveParam': res = saveParam_(ss, b, now); break;
      case 'saveTask': res = saveTask_(ss, b, now); break;
      default: throw new Error('Aksi tidak dikenal: ' + b.action);
    }
    res.time = now;
    return json_(res);
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}

/* ---------- Upload Excel CSL ----------
 * Website membaca sheet INPUT SODO, (GTK), (BIMS) dari file Excel CSL, lalu:
 * 1) replaceMonths: bulan SO yang isinya berubah dikirim utuh; semua baris SO & DO bulan itu diganti.
 *    so: [[noSO, tanggal, distributor, orderRef, kode, nama, qty, harga, kodeDist, kota, region, status, week]]
 *    do: [[bulanSO, noDO, tanggal, noSO, kode, batch, qty, status]]
 *    hash: {bulan: sidik isi} — dipakai website untuk melewati bulan yang tidak berubah.
 * 2) finishExcel: bulan yang tidak ada lagi di file dihapus, FORECAST diganti seluruhnya dari (GTK)/(BIMS).
 */
function replaceMonths_(ss, b, now) {
  const months = new Set((b.months || []).map(s_));
  if (!months.size) throw new Error('Tidak ada bulan yang dikirim.');
  const so = (b.so || []).map(r => {
    const t = s_(r[1]).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new Error('Tanggal SO tidak valid: ' + s_(r[0]) + ' ' + s_(r[1]));
    return [t.slice(0, 7), s_(r[0]), t, s_(r[2]), s_(r[3]), s_(r[4]), s_(r[5]), num_(r[6]), num_(r[7]), now, s_(r[8]), s_(r[9]), s_(r[10]), s_(r[11]), s_(r[12])];
  }).filter(r => r[1] && r[5]);
  so.forEach(r => { if (!months.has(r[0])) throw new Error('SO ' + r[1] + ' bulan ' + r[0] + ' tidak termasuk bulan kiriman.'); });
  const dos = (b.do || []).map(r => [s_(r[0]), s_(r[1]), s_(r[2]), s_(r[3]), s_(r[4]), s_(r[5]), num_(r[6]), s_(r[7]), now])
    .filter(r => months.has(r[0]) && r[1] && r[4]);
  const sh = sheet_(ss, 'SO_LINES'), old = readAll_(sh, 15);
  const all = old.filter(r => !months.has(s_(r[0]))).concat(so);
  all.sort((a, c) => cmp_(a[0], c[0]) || cmp_(a[1], c[1]) || cmp_(a[5], c[5]));
  writeFrom_(sh, old, all, 15);
  const dsh = sheet_(ss, 'DO_LINES'), dOld = readAll_(dsh, 9);
  const dAll = dOld.filter(r => !months.has(s_(r[0]))).concat(dos);
  dAll.sort(doCmp_);
  writeFrom_(dsh, dOld, dAll, 9);
  const res = bumpMonths_(ss, months, now, b.hash || {});
  produk_(ss);
  addProduk_(ss, so.map(r => [r[5], r[6]]));
  return { ok: true, saved: so.length, savedDo: dos.length, months: res };
}

function finishExcel_(ss, b, now) {
  const keep = new Set((b.keep || []).map(s_));
  if (!keep.size) throw new Error('File tidak berisi bulan SO.');
  const gone = new Set();
  [['SO_LINES', 15, (a, c) => cmp_(a[0], c[0]) || cmp_(a[1], c[1]) || cmp_(a[5], c[5])], ['DO_LINES', 9, doCmp_]].forEach(([name, ncol]) => {
    const sh = sheet_(ss, name), old = readAll_(sh, ncol);
    const all = old.filter(r => { const m = s_(r[0]); if (keep.has(m)) return true; gone.add(m); return false; });
    if (all.length !== old.length) writeFrom_(sh, old, all, ncol);
  });
  const months = bumpMonths_(ss, gone, now, {});
  // Forecast: diganti seluruhnya dari (GTK) dan (BIMS). rows: [[bulan, kode, region, qty]]
  const fsh = sheet_(ss, 'FORECAST'), fOld = readAll_(fsh, 6);
  const fNew = (b.fct || []).map(r => [s_(r[0]), s_(r[1]), s_(r[2]).toUpperCase(), num_(r[3]), s_(b.file) || 'Excel CSL', now])
    .filter(r => r[0] && r[1] && r[2] && r[3] !== '' && r[3] !== 0);
  fNew.sort((a, c) => cmp_(a[0], c[0]) || cmp_(a[1], c[1]) || cmp_(a[2], c[2]));
  writeFrom_(fsh, fOld, fNew, 6);
  log_(ss, now, 'Upload Excel CSL', b.file || '', n_(b.nSo) || 0,
    `${b.changed || 0} bulan berubah dari ${keep.size} bulan${gone.size ? ' · dihapus ' + [...gone].sort().join(', ') : ''} · forecast ${fNew.length} baris${b.note ? ' · ' + b.note : ''}`);
  return { ok: true, months, removed: [...gone], fct: fNew.map(r => [r[0], r[1], r[2], n_(r[3])]) };
}

// Forecast Rupiah per region (manual). rows: [[bulan, region, nilai]] — nilai kosong = hapus
function saveNilai_(ss, b, now) {
  const sh = sheet_(ss, 'FCT_NILAI');
  const old = readAll_(sh, 5);
  const map = new Map(old.map(r => [s_(r[0]) + '|' + s_(r[1]), r]));
  let n = 0;
  (b.rows || []).forEach(r => {
    const k = s_(r[0]) + '|' + s_(r[1]).toUpperCase();
    const v = num_(r[2]);
    if (v === '') map.delete(k);
    else map.set(k, [s_(r[0]), s_(r[1]).toUpperCase(), v, s_(b.source) || 'Manual', now]);
    n++;
  });
  const all = [...map.values()].sort((a, c) => cmp_(a[0], c[0]) || cmp_(a[1], c[1]));
  writeFrom_(sh, old, all, 5);
  log_(ss, now, 'Forecast Rupiah', s_(b.source) || 'Manual', n, [...new Set((b.rows || []).map(r => s_(r[0])))].sort().join(', '));
  return { ok: true, nilai: all.map(r => [s_(r[0]), s_(r[1]), n_(r[2]), s_(r[3]), s_(r[4])]) };
}

function saveParam_(ss, b, now) {
  const sh = sheet_(ss, 'PARAMETER');
  const key = s_(b.key);
  if (!key) throw new Error('Parameter kosong.');
  const old = readAll_(sh, 3);
  const i = old.findIndex(r => s_(r[0]) === key);
  if (i >= 0) sh.getRange(i + 2, 2).setValue(b.value);
  else sh.getRange(old.length + 2, 1, 1, 3).setValues([[key, b.value, s_(b.note)]]);
  log_(ss, now, 'Parameter', key, 1, String(b.value));
  return { ok: true, params: readAll_(sh, 3).map(r => [s_(r[0]), r[1], s_(r[2])]) };
}

// Tugas Beranda yang ditandai "sudah ditangani". Muncul lagi bila SIGNATURE (isi anomali) berubah.
function readTasks_(ss) {
  return rows_(sheet_(ss, 'TUGAS'), 5).map(r => [s_(r[0]), s_(r[1]), s_(r[2]), s_(r[3]), s_(r[4])]);
}
function saveTask_(ss, b, now) {
  const id = s_(b.id);
  if (!id) throw new Error('ID tugas kosong.');
  const sh = sheet_(ss, 'TUGAS');
  const old = readAll_(sh, 5);
  let all = old.filter(r => s_(r[0]) !== id);
  if (!b.clear) all.push([id, s_(b.sig), s_(b.note), now, s_(b.title)]);
  all.sort((a, c) => cmp_(a[0], c[0]));
  writeFrom_(sh, old, all, 5);
  log_(ss, now, b.clear ? 'Tugas dibuka lagi' : 'Tugas ditangani', id, 1, s_(b.note));
  return { ok: true, tasks: readTasks_(ss) };
}

/* ======================= BANTU ======================= */
function bumpMonths_(ss, touched, now, hash) {
  hash = hash || {};
  const sh = sheet_(ss, 'MONTHS');
  const count = (name) => {
    const s = sheet_(ss, name), n = s.getLastRow() - 1, c = {};
    if (n > 0) s.getRange(2, 1, n, 1).getValues().forEach(r => { const m = s_(r[0]); c[m] = (c[m] || 0) + 1; });
    return c;
  };
  const cSo = count('SO_LINES'), cDo = count('DO_LINES');
  const old = readAll_(sh, 6);
  const map = new Map(old.map(r => [s_(r[0]), r]));
  const ver = String(Date.now());
  touched.forEach(m => { if (m) map.set(m, [m, ver, cSo[m] || 0, cDo[m] || 0, now, s_(hash[m])]); });
  [...map.keys()].forEach(m => { if (!cSo[m] && !cDo[m]) map.delete(m); });
  const all = [...map.values()].sort((a, c) => cmp_(a[0], c[0]));
  writeFrom_(sh, old, all, 6);
  return all.map(r => [s_(r[0]), s_(r[1]), n_(r[2]), n_(r[3]), s_(r[4]), s_(r[5])]);
}
function doCmp_(a, c) { return cmp_(a[0], c[0]) || cmp_(a[3], c[3]) || cmp_(a[1], c[1]) || cmp_(a[4], c[4]); }
function cmp_(a, c) { a = s_(a); c = s_(c); return a < c ? -1 : a > c ? 1 : 0; }

// Tulis hanya mulai baris pertama yang berbeda (biasanya upload hanya mengubah bulan terakhir)
function writeFrom_(sh, oldRows, newRows, ncol) {
  const key = (r) => r.slice(0, ncol).map(s_).join('\u0001');
  let i = 0;
  const lim = Math.min(oldRows.length, newRows.length);
  while (i < lim && key(oldRows[i]) === key(newRows[i])) i++;
  const need = newRows.length + 1;
  if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows() + 1000);
  if (newRows.length > i) {
    const CH = 20000;
    for (let s = i; s < newRows.length; s += CH) {
      const part = newRows.slice(s, s + CH).map(r => r.slice(0, ncol).map(v => (v === null || v === undefined ? '' : v)));
      sh.getRange(2 + s, 1, part.length, ncol).setValues(part);
    }
  }
  if (oldRows.length > newRows.length) sh.getRange(2 + newRows.length, 1, oldRows.length - newRows.length, ncol).clearContent();
}
function readAll_(sh, ncol) {
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, ncol).getValues().filter(r => s_(r[0]) !== '');
}
function sheet_(ss, name) {
  let sh = ss.getSheetByName(name);
  const def = CSL_HEAD[name];
  if (!sh) {
    sh = ss.insertSheet(name);
    if (def) {
      sh.getRange(1, 1, 1, def.head.length).setValues([def.head]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  }
  if (def && sh.getMaxRows() > 1 && !String(sh.getRange(2, def.text[def.text.length - 1]).getNumberFormat()).startsWith('@')) {
    def.text.forEach(c => sh.getRange(2, c, sh.getMaxRows() - 1, 1).setNumberFormat('@'));
  }
  return sh;
}
function log_(ss, now, aksi, ref, n, ket) {
  const sh = sheet_(ss, 'LOG_CSL');
  sh.getRange(sh.getLastRow() + 1, 1, 1, 5).setValues([[now, aksi, ref, n, ket]]);
}
function rows_(sh, cols) {
  if (!sh) return [];
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, cols).getValues().filter(r => s_(r[0]) !== '');
}
function now_() { return Utilities.formatDate(new Date(), CSL_CONFIG.TZ, 'yyyy-MM-dd HH:mm:ss'); }
function s_(v) { return String(v === null || v === undefined ? '' : v).trim(); }
function n_(v) { if (v === '' || v === null || v === undefined) return ''; const x = Number(v); return isNaN(x) ? '' : x; }
function num_(v) { if (v === '' || v === null || v === undefined) return ''; const x = Number(String(v).replace(/,/g, '')); return isNaN(x) ? '' : x; }
function d_(v, tz, f) {
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, tz, f);
  return s_(v);
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
