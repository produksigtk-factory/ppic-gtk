/* Bantuan & Sistem — Glosarium istilah dan Kapasitas Google Sheet */
(function () {
  'use strict';
  const CFG = window.PPIC_CONFIG || {};
  const UI = window.PPIC_UI || {};
  const $ = (id) => document.getElementById(id);
  const esc = UI.esc || ((s) => String(s ?? ''));
  const nf0 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  /* =====================================================================
     GLOSARIUM
     [kelompok, istilah, nama lain, definisi, dipakai di (route|label)]
     ===================================================================== */
  const G = [
    // ---------- Umum ----------
    ['Umum', 'Export Odoo', '', 'File Excel yang diunduh dari Odoo (menu Export) lalu di-upload apa adanya ke website. Website mengenali kolomnya dari judul kolom Odoo, jadi file tidak perlu dirapikan.', ''],
    ['Umum', 'Upload', '', 'Mengirim isi file export Odoo ke Google Sheet lewat website. Data dengan nomor yang sama (PO, SO, DO) diganti, bukan ditambah, sehingga upload ulang file yang sama aman dan tidak membuat data dobel.', ''],
    ['Umum', 'Apps Script', 'Web app', 'Program kecil di dalam Google Sheet yang menjadi penghubung website ↔ Google Sheet. Tiap Google Sheet (MONITORING PO, MRP, CSL) punya Apps Script sendiri. Setelah kode Apps Script diganti, perlu Deploy → Manage deployments → Edit → New version.', ''],
    ['Umum', 'PIN', 'UPLOAD_PIN', 'Kode rahasia di Script Properties Apps Script untuk mengizinkan perubahan data dari website (mode edit PO dan MRP). CSL untuk sementara belum memakai PIN.', ''],
    ['Umum', 'Mode edit', '', 'Keadaan website yang mengizinkan tambah/ubah/hapus data secara manual. Diaktifkan dengan tombol "Mode edit" + PIN, dan dimatikan lagi setelah selesai.', 'po/monitoring|Monitoring PO'],
    ['Umum', 'Muat ulang data', 'Reload', 'Mengambil data terbaru dari Google Sheet tanpa memuat ulang seluruh halaman.', ''],
    ['Umum', 'DATABASE PPIC GTK', '', 'Google Sheet induk berisi master yang dipakai semua project: MASTER_MATERIAL, BOM_LIST, BOM_DETAIL, PEMBAGIAN_WEEK, DISTRIBUTOR, KOTA_REF, SUPPLIER_MATERIAL.', 'info/kapasitas|Kapasitas Google Sheet'],
    ['Umum', 'MASTER_MATERIAL', 'Master', 'Daftar semua kode barang (RM, PM, ekstrak/bulk, FG) beserta nama, satuan (UoM), dan kategori. Kode yang tidak ada di sini muncul di Pemeriksaan Data.', ''],
    ['Umum', 'Kategori RM / PM / FG', '', 'RM = Raw Material (bahan baku), PM = Packaging Material (bahan kemas), FG = Finished Goods (barang jadi). Ekstrak/bulk = setengah jadi yang dibuat sendiri dari RM.', ''],
    ['Umum', 'UoM', 'Satuan', 'Unit of Measure: Kg, Pcs, Lt, Set, dll. Hitungan hanya digabung bila satuannya sama dengan master.', ''],
    ['Umum', 'PEMBAGIAN_WEEK', 'Week, W1–W5', 'Tabel tanggal → minggu ke-berapa dalam bulan (W1–W5). Sejak 2025 minggu dimulai hari Minggu; awal bulan yang jatuh Kamis–Sabtu digabung ke W1; sisa 1 hari di akhir bulan digabung ke week sebelumnya.', ''],
    ['Umum', 'Data basi', 'Peringatan data', 'Tanda bahwa export Odoo belum di-upload ulang selama beberapa hari kerja (kuning 2 hari kerja, merah ≥ 3). Angka di website bisa tidak sesuai Odoo.', 'po/dashboard|Dashboard PO'],
    ['Umum', 'Pemeriksaan Data', '', 'Halaman daftar data yang perlu dirapikan (kode tidak ada di master, distributor belum terdaftar, dsb.) supaya hitungan benar. Angka kecil di menu = jumlah temuan.', 'csl/cek|Pemeriksaan Data CSL'],
    // ---------- Purchase Order ----------
    ['Purchase Order', 'PO-DET', '', 'Export Odoo detail baris PO: nomor PO, tanggal, supplier, kode, qty order, harga. Dasar daftar PO.', 'po/update|Update Data PO'],
    ['Purchase Order', 'PO-DEL', 'Jadwal kirim', 'Export Odoo jadwal kedatangan per baris PO: tanggal rencana, qty, qty diterima, status. Dasar kalender dan shortage.', 'po/update|Update Data PO'],
    ['Purchase Order', 'Jadwal', 'Schedule', 'Rencana tanggal dan qty kedatangan untuk satu baris PO. Satu baris PO bisa punya beberapa jadwal.', 'po/kalender|Kalender Kedatangan'],
    ['Purchase Order', 'Sisa', '', 'Qty order − qty yang sudah diterima.', 'po/monitoring|Monitoring PO'],
    ['Purchase Order', 'Lengkap', 'Done', 'Seluruh qty order sudah diterima.', ''],
    ['Purchase Order', 'Terlambat', '', 'Ada jadwal yang tanggalnya sudah lewat tetapi barang belum diterima penuh.', 'po/perhatian|Perhatian Khusus'],
    ['Purchase Order', 'Kurang kirim', 'Shortage', 'Qty diterima pada jadwal yang sudah selesai lebih kecil dari yang dijadwalkan; selisihnya disebut shortage.', 'po/perhatian|Perhatian Khusus'],
    ['Purchase Order', 'Dijadwalkan / Belum dijadwalkan', '', 'Dijadwalkan = punya jadwal yang belum jatuh tempo. Belum dijadwalkan = baris PO tanpa jadwal kedatangan sama sekali.', ''],
    ['Purchase Order', 'Take out', '', 'Baris PO dengan qty order 0 (dikeluarkan dari PO di Odoo). Tidak dihitung menunggu.', ''],
    ['Purchase Order', 'Cancel PO', '', 'PO atau baris PO yang dibatalkan lewat website (tab PO_CANCEL). Tidak tersentuh upload berikutnya.', ''],
    ['Purchase Order', 'Tindak lanjut', 'Follow-up', 'Catatan penanganan PO bermasalah: Belum dihubungi, Sudah dihubungi, Eskalasi, Selesai, beserta janji kirim supplier.', 'po/perhatian|Perhatian Khusus'],
    ['Purchase Order', 'Perubahan Data', '', 'Perbedaan yang ditemukan setiap kali export Odoo di-upload (qty, tanggal, harga berubah; baris baru/hilang).', 'po/perubahan|Perubahan Data'],
    ['Purchase Order', 'MoQ', 'Minimum Order Quantity', 'Jumlah pesan terkecil ke supplier. Dihitung otomatis dari histori PO: qty terkecil dalam satu PO untuk material + supplier tersebut, bukan diketik.', 'po/supplier|Supplier & MoQ'],
    ['Purchase Order', 'Lead time', '', 'Rata-rata hari dari tanggal PO sampai barang datang, dihitung dari histori PO per material + supplier.', 'po/supplier|Supplier & MoQ'],
    // ---------- MRP ----------
    ['MRP', 'MRP', 'Material Requirements Planning', 'Perhitungan kebutuhan material: rencana produksi → dipecah lewat BOM → dibandingkan dengan stok dan kedatangan PO per week → terlihat kapan material kurang.', 'mrp/proyeksi|Proyeksi Stok'],
    ['MRP', 'BOM', 'Bill of Material', 'Resep produk: daftar material beserta qty untuk sejumlah batch tertentu (qty batch BOM).', 'mrp/bom|Bill of Material'],
    ['MRP', 'BOM ID / Reference', 'Versi BOM', 'Satu produk bisa punya beberapa versi BOM (Reference 00, 01, …). Versi aktif diatur per SKU dan bisa dikunci per week.', 'mrp/sku|Parameter SKU'],
    ['MRP', 'Qty batch BOM', '', 'Jumlah hasil yang menjadi dasar BOM. Untuk SKU = pcs per 1.000 kg; kebutuhan material = qty material ÷ qty batch BOM × pcs rencana.', ''],
    ['MRP', 'Ukuran batch', 'MoQ produksi', 'Kg per batch yang boleh diproduksi. Rencana yang tidak bisa disusun dari ukuran batch diberi warna kuning (peringatan saja).', 'mrp/rencana|Rencana Produksi'],
    ['MRP', 'Rencana produksi', 'MPS, plan', 'Kg (atau pcs untuk rakitan) per SKU per week. Diisi lewat upload Excel atau diketik di sel.', 'mrp/rencana|Rencana Produksi'],
    ['MRP', 'Horizon', '', 'Rentang yang dihitung: bulan berjalan + 2 bulan berikutnya (otomatis).', ''],
    ['MRP', 'Rakitan', 'Banded, 2in1, KIT', 'Produk yang BOM-nya hanya berisi FG + bahan kemas (tanpa RM/ekstrak). Direncanakan dalam pcs; komponen FG-nya tidak dipecah lagi, tampil sebagai "FG untuk rakitan/bonus". Perlakuan per jenis masih menunggu keputusan.', 'mrp/kebutuhan|Kebutuhan Material'],
    ['MRP', 'Ekstrak / bulk dipecah', '', 'Ekstrak dan bulk yang punya BOM sendiri dipecah terus sampai bahan baku, dengan kebutuhan pas (tanpa pembulatan batch).', ''],
    ['MRP', 'Kebutuhan', '', 'Qty material yang dibutuhkan untuk rencana produksi pada week tersebut.', 'mrp/kebutuhan|Kebutuhan Material'],
    ['MRP', 'Incoming', '', 'Barang yang akan datang dan ditambahkan ke saldo stok per week. Untuk sementara hanya dari incoming manual; jadwal PO belum dihubungkan ke MRP.', 'mrp/proyeksi|Proyeksi Stok'],
    ['MRP', 'Saldo / Proyeksi stok', '', 'Stok awal + incoming − kebutuhan, dibawa dari week ke week. Saldo minus (merah) = material akan kurang.', 'mrp/proyeksi|Proyeksi Stok'],
    ['MRP', 'Stok koreksi', '', 'Penyesuaian manual (+/−) atas stok hasil export Odoo, berlaku sejak tanggalnya.', ''],
    // ---------- CSL ----------
    ['CSL', 'SO', 'Sales Order', 'Pesanan distributor di Odoo (sale.order). 1 baris = 1 SO × produk. Amount SO = qty × harga per pcs.', 'csl/update|Update Data CSL'],
    ['CSL', 'DO', 'Delivery Order, stock.picking.out', 'Pengiriman barang untuk SO. Satu SO bisa dikirim lewat beberapa DO. Status: Delivered (terkirim), Ready to Deliver, Waiting Availability, Cancelled.', 'csl/update|Update Data CSL'],
    ['CSL', 'CSL', 'Customer Service Level', 'Persentase pesanan yang terkirim tepat di bulannya: Amount DO yang terkirim di bulan yang sama dengan SO ÷ Amount SO bulan itu. Target 100%.', 'csl/dashboard|Dashboard CSL'],
    ['CSL', 'CSL + OS', '', 'Semua DO yang terkirim di bulan itu — termasuk sisa SO bulan sebelumnya — ÷ SO bulan itu. Sama seperti Excel, bisa lebih dari 100% karena pembilang dan penyebut berbeda bulan.', 'csl/dashboard|Dashboard CSL'],
    ['CSL', 'DO (bulan sama)', '', 'Bagian SO yang terkirim (Delivered) di bulan yang sama dengan bulan SO.', ''],
    ['CSL', 'DO-OS', 'Outstanding terkirim', 'Bagian SO yang baru terkirim di bulan berikutnya. Di Suggest: SO bulan lalu yang terkirim bulan ini.', 'csl/sku|Rekap per SKU'],
    ['CSL', 'OS-DO', '', 'Di Suggest: SO bulan ini yang terkirim bulan depan.', 'csl/suggest|Suggest Forecast'],
    ['CSL', 'Sisa SO', 'OS-SO', 'Qty di DO yang belum Delivered (Ready to Deliver, Waiting Availability, …). DO Cancelled dipisah, kecuali dipilih "dihitung sisa" seperti Excel lama.', 'csl/os|Sisa SO'],
    ['CSL', 'Bulan SO / bulan kirim', '', 'Bulan SO = bulan tanggal SO dibuat; bulan kirim = bulan tanggal DO selesai (date_done). CSL membandingkan keduanya.', ''],
    ['CSL', 'Region R1–R4', '', 'Pembagian wilayah distributor offline (dari tab DISTRIBUTOR). Distributor yang belum terdaftar diberi region "?".', 'csl/region|Review Region'],
    ['CSL', 'Offline (GTK) / Online (BIMS)', '', 'Offline = distributor region R1–R4 (Gondowangi). Online = region ONLINE, yaitu Buana Indah Marketama Sejahtera (BIMS).', ''],
    ['CSL', 'Order ref → Kota', 'KODE REF', 'Nomor PO distributor di SO (client_order_ref). Kota diambil dari kode di dalamnya (mis. JBI1 → Jambi) lewat tab KOTA_REF.', ''],
    ['CSL', 'FCT', 'Forecast', 'Perkiraan penjualan per SKU per region per bulan dalam pcs (upload), dan per region dalam Rupiah (diisi manual).', 'csl/update|Update Data CSL'],
    ['CSL', 'GAP', '', 'Di Review Region: FCT − SO (Rupiah). Di Suggest: lihat Gap aktual / GAP SUG.', 'csl/region|Review Region'],
    ['CSL', 'FC vs SO', '', '(SO − FCT) ÷ FCT. Negatif = SO di bawah forecast.', 'csl/suggest|Suggest Forecast'],
    ['CSL', 'Amount Check', '', 'Pivot per SO: Amount SO, DO, DO-OS, sisa, dan selisihnya. Selisih ≠ 0 = SO tanpa DO atau DO Cancelled.', 'csl/amount|Amount Check'],
    ['CSL', 'Jam date_done', 'UTC / WIB', 'Odoo bisa mengekspor jam kirim dalam UTC (7 jam di belakang WIB). Pengaturan ini menentukan apakah jam digeser ke WIB agar DO di akhir bulan masuk bulan yang benar.', 'csl/update|Update Data CSL'],
    // ---------- Analisa forecast ----------
    ['Analisa Forecast', 'Jendela analisa', 'Bulan dipakai', '12 bulan sebelum bulan target. Bulan yang tidak wajar bisa dilepas centangnya (seperti tanda "-" di Excel).', 'csl/analisa|Analisa Forecast'],
    ['Analisa Forecast', 'Error', '', 'SO − FCT per bulan. Positif = penjualan di atas forecast.', ''],
    ['Analisa Forecast', 'Bias', '', 'Rata-rata error. Negatif = forecast cenderung terlalu tinggi (arah DOWN); positif = terlalu rendah (UP). Di Suggest memakai rata-rata error yang ≠ 0.', 'csl/analisa|Analisa Forecast'],
    ['Analisa Forecast', 'MAD', 'Mean Absolute Deviation', 'Rata-rata |SO − FCT| — besar meleset rata-rata dalam pcs, tanpa melihat arah.', ''],
    ['Analisa Forecast', 'MAPE', 'Mean Absolute Percentage Error', 'Rata-rata |SO − FCT| ÷ SO dalam persen. 10% = forecast rata-rata meleset 10% dari penjualan.', ''],
    ['Analisa Forecast', 'Zero Demand', '', 'Bulan yang FCT-nya 0 atau SO-nya 0 (salah satu saja) — persentase error tidak bisa dihitung, jadi tidak ikut MAPE.', ''],
    ['Analisa Forecast', 'σ (sigma)', 'STDEV, simpangan baku', 'Ukuran naik-turunnya SO dari bulan ke bulan. ±1σ / ±2σ = batas wajar di sekitar rata-rata.', ''],
    ['Analisa Forecast', 'Tanpa nol', 'AVG > 0', 'Statistik yang hanya memakai bulan dengan SO > 0 (bulan tanpa penjualan diabaikan).', ''],
    ['Analisa Forecast', 'ADI', 'Average Demand Interval', 'Jumlah bulan ÷ jumlah bulan yang ada SO. 1 = laku tiap bulan; makin besar = makin jarang laku.', ''],
    ['Analisa Forecast', 'CV / CV²', 'Coefficient of Variation', 'σ ÷ rata-rata (tanpa nol); CV² = kuadratnya. Makin besar = jumlah SO per bulan makin tidak stabil.', ''],
    ['Analisa Forecast', 'Tipe demand', 'Smooth, Intermittent, Erratic, Lumpy', 'Smooth = rutin & stabil; Intermittent = jarang laku tapi stabil; Erratic = rutin tapi naik-turun tajam; Lumpy = jarang dan tidak stabil; Undefined = data kurang. Batas: ADI 1,32 dan CV² 0,49.', 'csl/analisa|Analisa Forecast'],
    ['Analisa Forecast', 'Safety stock', 'Buffer', 'Stok cadangan: 2,33 × σ × √(10/30) + 2,33 × rata-rata × 0,027 (2,33 ≈ tingkat layanan 99%, 10 hari lead time). Konstanta diatur di PARAMETER.', 'csl/suggest|Suggest Forecast'],
    ['Analisa Forecast', 'Range', '', 'Posisi forecast bulan ini terhadap rata-rata ± σ (mis. "-1σ <> AVG" = sedikit di bawah rata-rata).', ''],
    ['Analisa Forecast', '5 aturan penyesuaian', 'Tipe, Range, Bias, Max gap, MAPE', 'Lima cara menyesuaikan forecast — menurut tipe demand, posisi σ, besar bias, selisih ke penjualan tertinggi, dan MAPE. Rumus sama dengan sheet SUG-GTK/SUG-BIMS.', 'csl/suggest|Suggest Forecast'],
    ['Analisa Forecast', 'Final suggest', 'Rata + buffer', 'Rata-rata 5 aturan + safety stock — usulan forecast/stok untuk bulan itu.', 'csl/suggest|Suggest Forecast'],
    ['Analisa Forecast', 'Gap aktual', '', 'Final suggest − SO bulan itu. Positif = usulan cukup menutup penjualan.', ''],
    ['Analisa Forecast', 'GAP SUG', '', 'Final suggest − FCT bulan ini − FCT bulan depan (sama seperti kolom AY di Excel).', ''],
    ['Analisa Forecast', 'Seasonal index', 'Musim', 'TOP 10 SKU menurut qty SO pada bulan-bulan musim tertentu (Kemarau, Ramadhan, Natal, …). Bulan musim diatur di PARAMETER.', 'csl/musim|Seasonal'],
    // ---------- Sistem ----------
    ['Sistem', 'Batas 10 juta sel', '', 'Satu file Google Sheet maksimal 10.000.000 sel. Yang dihitung adalah baris × kolom yang tersedia di setiap tab — termasuk baris/kolom kosong — bukan hanya yang berisi.', 'info/kapasitas|Kapasitas Google Sheet'],
    ['Sistem', 'Sel terisi / tersedia', '', 'Terisi = sampai baris & kolom terakhir yang berisi data. Tersedia = ukuran grid tab (yang dihitung untuk batas 10 juta).', 'info/kapasitas|Kapasitas Google Sheet'],
    ['Sistem', 'Versi bulan', 'MONTHS', 'Penanda perubahan data CSL per bulan. Website hanya mengunduh ulang bulan yang versinya berubah.', ''],
    ['Sistem', 'Cache browser', 'IndexedDB', 'Salinan data CSL di browser masing-masing pemakai supaya halaman cepat. Bisa dihapus dengan "Unduh ulang semua data".', 'csl/update|Update Data CSL'],
    ['Sistem', 'Upload bertahap', 'Bagian 1/11', 'File besar dikirim beberapa bagian (±4.000 baris) agar tidak melewati batas waktu Apps Script (6 menit). Bagian yang sudah tersimpan tetap aman bila terputus.', ''],
  ];
  const GROUPS = ['Semua', 'Umum', 'Purchase Order', 'MRP', 'CSL', 'Analisa Forecast', 'Sistem'];
  const S = { grp: 'Semua' };
  function renderGlos() {
    const q = $('glQ').value.trim().toLowerCase();
    const list = G.filter((t) => (S.grp === 'Semua' || t[0] === S.grp) && (!q || t.slice(1, 4).join(' ').toLowerCase().includes(q)));
    $('glTabs').innerHTML = GROUPS.map((g) => `<button class="chg-type${S.grp === g ? ' is-on' : ''}" data-g="${g}">${g} <b>${g === 'Semua' ? G.length : G.filter((t) => t[0] === g).length}</b></button>`).join('');
    const byGrp = new Map();
    list.forEach((t) => { if (!byGrp.has(t[0])) byGrp.set(t[0], []); byGrp.get(t[0]).push(t); });
    $('glList').innerHTML = [...byGrp.entries()].map(([g, ts]) => `<section class="gl-sec"><h2 class="gl-h">${esc(g)}</h2><dl class="gl-dl">${ts.map((t) => {
      const [route, label] = (t[4] || '').split('|');
      return `<div class="gl-item"><dt>${esc(t[1])}${t[2] ? `<span class="gl-alias">${esc(t[2])}</span>` : ''}</dt><dd>${esc(t[3])}${route ? ` <a class="gl-link" href="#/${route}">${esc(label)}</a>` : ''}</dd></div>`;
    }).join('')}</dl></section>`).join('') || '<p class="csl-empty">Istilah tidak ditemukan.</p>';
    $('glInfo').textContent = `${list.length} istilah`;
  }

  /* =====================================================================
     KAPASITAS GOOGLE SHEET
     ===================================================================== */
  const K = { data: null, loading: false, err: '' };
  async function loadUsage() {
    if (K.loading) return;
    K.loading = true; K.err = ''; paintUsage();
    try {
      if (!CFG.CSL_SCRIPT_URL) throw new Error('Apps Script CSL belum terpasang.');
      const res = await fetch(CFG.CSL_SCRIPT_URL + '?action=usage');
      const d = await res.json();
      if (!d.ok) throw new Error(d.error || 'Gagal membaca.');
      if (!d.files) throw new Error('Apps Script CSL belum versi terbaru. Tempel Code_CSL.gs terbaru lalu Deploy → Manage deployments → Edit → New version.');
      K.data = d;
    } catch (err) { K.err = err.message; }
    K.loading = false; paintUsage();
  }
  const pct = (a, b) => (b ? a / b : 0);
  const fPct = (v) => nf1.format(v * 100) + '%';
  const tone = (v) => (v >= 0.8 ? 'bad' : v >= 0.5 ? 'warn' : 'ok');
  function paintUsage() {
    const box = $('kpBody'); if (!box) return;
    $('kpLoading').hidden = !K.loading && !K.err;
    $('kpLoading').textContent = K.err ? 'Kapasitas belum bisa dibaca: ' + K.err : 'Membaca ukuran 4 Google Sheet… biasanya 10–30 detik';
    $('kpLoading').classList.toggle('is-err', !!K.err);
    const d = K.data;
    if (!d) { box.innerHTML = ''; return; }
    const LIM = d.limit || 10000000;
    // Laju pertumbuhan CSL: rata-rata baris SO + DO per bulan (6 bulan terakhir yang lengkap)
    const ms = (d.months || []).slice(-7, -1);
    const perMonth = ms.length ? ms.reduce((a, r) => a + (Number(r[1]) || 0) * 10 + (Number(r[2]) || 0) * 9, 0) / ms.length : 0;
    box.innerHTML = d.files.map((f) => {
      if (!f.ok) return `<article class="csl-card kp-card"><h2>${esc(f.name)}</h2><p class="check err">Tidak bisa dibuka: ${esc(f.error)}</p></article>`;
      const tabs = f.tabs.map(([n, mr, mc, lr, lc]) => ({ n, mr, mc, lr, lc, alloc: mr * mc, used: lr * lc }));
      const alloc = tabs.reduce((a, t) => a + t.alloc, 0), used = tabs.reduce((a, t) => a + t.used, 0);
      const p = pct(alloc, LIM);
      const isCsl = /CSL/.test(f.name);
      const left = isCsl && perMonth ? Math.floor((LIM - alloc) / perMonth) : null;
      const top = tabs.slice().sort((a, b) => b.alloc - a.alloc);
      return `<article class="csl-card kp-card">
        <header class="kp-head"><h2><a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name)}</a></h2><span class="kp-pct is-${tone(p)}">${fPct(p)}</span></header>
        <div class="kp-bar" role="img" aria-label="${fPct(p)} dari batas 10 juta sel"><span class="kp-fill is-${tone(p)}" style="width:${Math.max(0.4, Math.min(100, p * 100))}%"></span><span class="kp-used" style="width:${Math.max(0.2, Math.min(100, pct(used, LIM) * 100))}%"></span></div>
        <dl class="csl-dl"><div><dt>Sel tersedia (dihitung batas)</dt><dd>${nf0.format(alloc)}</dd></div><div><dt>Sel terisi</dt><dd>${nf0.format(used)}</dd></div><div><dt>Sisa sampai batas</dt><dd>${nf0.format(LIM - alloc)}</dd></div>
        ${isCsl ? `<div><dt>Tambah per bulan (SO + DO)</dt><dd>± ${nf0.format(perMonth)} sel</dd></div><div><dt>Perkiraan cukup untuk</dt><dd>${left === null ? '–' : left > 1200 ? '> 100 tahun' : `± ${nf0.format(left)} bulan (${nf1.format(left / 12)} tahun)`}</dd></div>` : ''}</dl>
        <details class="kp-tabs"><summary>Rincian ${tabs.length} tab</summary>
        <div class="table-wrap"><table class="po-table csl-table csl-small"><thead><tr><th>Tab</th><th class="num">Baris terisi</th><th class="num">Baris tersedia</th><th class="num">Kolom (terisi / tersedia)</th><th class="num">Sel tersedia</th><th class="num">Bagian dari file</th></tr></thead>
        <tbody>${top.map((t) => `<tr><td>${esc(t.n)}</td><td class="num">${nf0.format(Math.max(0, t.lr - 1))}</td><td class="num">${nf0.format(t.mr)}</td><td class="num">${t.lc} / ${t.mc}</td><td class="num">${nf0.format(t.alloc)}</td><td class="num">${fPct(pct(t.alloc, alloc))}</td></tr>`).join('')}</tbody></table></div></details>
      </article>`;
    }).join('');
    $('kpInfo').textContent = `Dibaca ${String(d.readAt || '').slice(0, 16)} · batas Google: ${nf0.format(LIM)} sel per file`;
  }

  /* ---------- Routing ---------- */
  function enter(key) {
    if (key === 'info/glosarium') renderGlos();
    if (key === 'info/kapasitas') { if (!K.data) loadUsage(); else paintUsage(); }
    const di = $('dataInfo');
    if (di) di.textContent = key === 'info/glosarium' ? 'Istilah yang dipakai di website, dikelompokkan per project' : 'Ukuran setiap Google Sheet dibandingkan batas 10 juta sel';
  }
  const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
  on('glQ', 'input', renderGlos);
  // Tombol Glosarium di judul halaman: buka kelompok sesuai project yang sedang dibuka
  on('lnkGlos', 'click', () => {
    const c = ($('crumb') && $('crumb').textContent) || '';
    const t = ($('pageTitle') && $('pageTitle').textContent) || '';
    S.grp = /Analisa|Suggest|Seasonal/.test(t) ? 'Analisa Forecast' : /Purchase/.test(c) ? 'Purchase Order' : /MRP/.test(c) ? 'MRP' : /CSL/.test(c) ? 'CSL' : 'Semua';
    if ($('glQ')) $('glQ').value = '';
  });
  on('glTabs', 'click', (e) => { const b = e.target.closest('[data-g]'); if (!b) return; S.grp = b.dataset.g; renderGlos(); });
  on('kpReload', 'click', () => { K.data = null; loadUsage(); });
  window.HELP = { enter };
  const k0 = location.hash.replace(/^#\/?/, '');
  if (k0.startsWith('info/')) enter(k0);
})();
