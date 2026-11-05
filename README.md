# PPIC GTK

Website Monitoring Pekerjaan PPIC Gondowangi. Menu samping berisi Beranda dan grup pekerjaan; tiap grup punya sub menu (Purchase Order → Dashboard PO, Monitoring PO, Kalender Kedatangan, Perubahan Data, Update Data PO, Supplier & MoQ, Riwayat Edit PO).

Menambah menu baru: tambahkan link di `.menu` (index.html), `<section id="view-...">` untuk isinya, dan satu baris di `ROUTES` (app.js).

## Struktur

- Hosting: Cloudflare Pages (auto-deploy dari branch `main`) → https://ppic-gtk.pages.dev
- Database master: Google Sheet "DATABASE PPIC GTK" (MASTER_MATERIAL, BOM_LIST, BOM_DETAIL)
- Monitoring PO: Google Sheet "MONITORING PO" (PO_LINE, PO_SCHEDULE, MONITORING_PO)
- Tab MONITORING_PO berisi tabel biasa (bukan rumus) yang diisi Apps Script ±1 menit setelah upload/edit, atau lewat menu PPIC → Perbarui tab MONITORING_PO. Rumus berat di tab ini dulu membuat setiap simpan dari website menunggu Google Sheet menghitung ulang.
- Edit manual menulis hanya baris yang berubah.

## File

| File | Isi |
|---|---|
| `index.html` | Kerangka website: menu samping, Beranda, halaman Purchase Order |
| `assets/` | Logo Gondowangi dan ikon tab |
| `style.css` | Tampilan |
| `app.js` | Hitung status PO, saringan, unduh Excel, baca file export Odoo dan kirim ke Google Sheet |
| `config.js` | Alamat Web App Apps Script |
| `apps-script/Code.gs` | Apps Script Purchase Order, dipasang di Google Sheet MONITORING PO (Extensions → Apps Script) |
| `apps-script/Code_MRP.gs` | Apps Script MRP, dipasang di Google Sheet MRP PPIC GTK; alamat Web app-nya diisi di `config.js` → `MRP_SCRIPT_URL` |

## Aturan data PO

- PO-DET: satu baris per baris PO. PO yang ada di file menggantikan data lama PO tersebut; PO lain tetap disimpan.
- PO-DEL: No PO, tanggal, dan status diisi ke bawah untuk baris lanjutan. Jadwal Cancelled tidak dimasukkan. Qty diterima kosong dihitung 0.
- Kode material dicocokkan persis (MMBU001 ≠ MMBU002). Jumlah jadwal tidak dibatasi.
- Kode yang muncul lebih dari sekali dalam satu PO: qty diterima dibagi berurutan ke tiap baris.
- Urutan tampilan: Order Date terlama di atas.
- Edit manual (Mode edit, cukup PIN): tambah/ubah/hapus baris PO dan jadwal, tambah PO manual. Setiap edit tercatat (waktu, aksi, nilai lama → baru) di tab LOG_EDIT dan halaman Riwayat Edit PO; PO yang diedit ditandai di tab PO_MANUAL.
- Upload setelah edit manual: website menampilkan PO yang bentrok dan meminta pilihan per PO (pakai data Odoo / pertahankan edit). "Pertahankan" berarti bagian yang diedit tidak dikirim dari file.
- Shortage: qty dari jadwal yang belum Done dan tanggalnya sudah lewat tetapi belum diterima, ditambah kurang kirim pada jadwal yang sudah Done. Dihitung per PO + kode, dibagi berurutan ke baris kode yang sama. Hari terlambat dihitung dari jadwal tertua yang tertunggak.
- Dashboard PO: KPI (PO aktif, nilai belum diterima, shortage, datang 7 hari ke depan), jadwal kedatangan per minggu, umur shortage, supplier dengan shortage terbesar, belum lengkap per jenis, nilai PO per bulan, tabel perlu ditindaklanjuti. Semua angka dan batang bisa diklik untuk membuka Monitoring PO dengan saringan terkait.
- Status: Lengkap (sisa 0), Terlambat (ada jadwal belum Done yang tanggalnya sudah lewat), Dijadwalkan (ada jadwal belum Done), Belum dijadwalkan.

## Supplier & MoQ

- Menu Purchase Order → Supplier & MoQ. Semua dari histori PO, tidak ada isian manual.
- Tab `SUPPLIER_MATERIAL` di DATABASE PPIC dihitung otomatis oleh Apps Script: satu baris per material RM/PM + supplier. MoQ = qty terkecil dalam satu PO untuk material + supplier itu; juga qty PO terbesar, jumlah PO, total qty, PO terakhir, harga terakhir, lead time rata-rata (Order Date → kedatangan pertama yang Done), supplier utama (PO terbanyak). Material tanpa PO tetap tampil sebagai "Belum ada riwayat PO". Jangan diketik.
- Dihitung ulang otomatis setelah upload atau edit PO (saat halaman dibuka), lewat tombol "Muat ulang data", atau fungsi `rebuildSupplierNow` di editor Apps Script.

## Follow-up, perubahan data, kalender

- Saringan jenis bawaan = RM dan PM (Monitoring PO, Dashboard, Kalender, Beranda). Reset kembali ke RM dan PM; pilih "Semua jenis" untuk melihat FG/Service/Ekstrak.
- Follow-up per PO + kode (tab `PO_FOLLOWUP` di MONITORING PO): status (Belum dihubungi / Sudah dihubungi / Eskalasi / Selesai), janji kirim baru, catatan. Diisi lewat Mode edit di detail baris; tidak tersentuh upload. Saringan "Follow-up" dan kolom di tabel Perlu ditindaklanjuti.
- Perubahan per upload (tab `LOG_PERUBAHAN`): PO baru, baris baru/dihapus, qty order berubah, jadwal baru/berubah/dihapus, diterima. Dibandingkan dengan isi sheet sebelum ditimpa. Upload ke sheet kosong tidak dicatat (data awal).
- Ketepatan kirim supplier (estimasi): penerimaan yang terdeteksi antar-upload; terlambat bila upload sebelumnya sudah melewati tanggal jadwal tetapi barang belum diterima.
- Kalender Kedatangan: jadwal belum Done per tanggal (hijau = dijadwalkan, merah = lewat jadwal) dan janji kirim dari follow-up (emas).

## MRP tahap 1 (menu MRP)

- **Rencana Produksi**: kg per SKU per week (W1–W5, 3 bulan), edit per sel atau upload sheet PLAN WEEKLY.
- **Kebutuhan Material**: rencana dipecah lewat BOM aktif (ekstrak/bulk dipecah sampai bahan baku) per material per week.
- **Proyeksi Stok**: stok awal (upload stok + koreksi) + incoming (jadwal PO terbuka dari Monitoring PO + incoming manual) − kebutuhan, saldo berjalan per week.
- **Parameter SKU**: BOM aktif, ukuran batch, aktif/tidak (tab SKU_MRP).
- **Update Data MRP**: upload stok Odoo dan rencana produksi, riwayat LOG_MRP.

Data disimpan di Google Sheet MRP PPIC GTK: SKU_MRP, RENCANA_PRODUKSI, STOK, STOK_KOREKSI, INCOMING_MANUAL, LOG_MRP. Week diambil dari tab PEMBAGIAN_WEEK di DATABASE PPIC GTK.
