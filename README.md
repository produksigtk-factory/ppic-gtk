# PPIC GTK

Website Monitoring Pekerjaan PPIC Gondowangi. Menu samping berisi Beranda dan grup pekerjaan; tiap grup punya sub menu (saat ini: Purchase Order → Monitoring PO, Update Data PO).

Menambah menu baru: tambahkan link di `.menu` (index.html), `<section id="view-...">` untuk isinya, dan satu baris di `ROUTES` (app.js).

## Struktur

- Hosting: Cloudflare Pages (auto-deploy dari branch `main`) → https://ppic-gtk.pages.dev
- Database master: Google Sheet "DATABASE PPIC GTK" (MASTER_MATERIAL, BOM_LIST, BOM_DETAIL)
- Monitoring PO: Google Sheet "MONITORING PO" (PO_LINE, PO_SCHEDULE, MONITORING_PO)

## File

| File | Isi |
|---|---|
| `index.html` | Kerangka website: menu samping, Beranda, halaman Purchase Order |
| `assets/` | Logo Gondowangi dan ikon tab |
| `style.css` | Tampilan |
| `app.js` | Hitung status PO, saringan, unduh Excel, baca file export Odoo dan kirim ke Google Sheet |
| `config.js` | Alamat Web App Apps Script |
| `apps-script/Code.gs` | Kode penghubung yang dipasang di Google Sheet MONITORING PO (Extensions → Apps Script) |

## Aturan data PO

- PO-DET: satu baris per baris PO. PO yang ada di file menggantikan data lama PO tersebut; PO lain tetap disimpan.
- PO-DEL: No PO, tanggal, dan status diisi ke bawah untuk baris lanjutan. Jadwal Cancelled tidak dimasukkan. Qty diterima kosong dihitung 0.
- Kode material dicocokkan persis (MMBU001 ≠ MMBU002). Jumlah jadwal tidak dibatasi.
- Kode yang muncul lebih dari sekali dalam satu PO: qty diterima dibagi berurutan ke tiap baris.
- Urutan tampilan: Order Date terlama di atas.
- Status: Lengkap (sisa 0), Terlambat (ada jadwal belum Done yang tanggalnya sudah lewat), Dijadwalkan (ada jadwal belum Done), Belum dijadwalkan.
