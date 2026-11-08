// Alamat Web App Apps Script yang terpasang di Google Sheet "MONITORING PO".
// Diisi setelah Apps Script di-deploy (Deploy → New deployment → Web app).
window.PPIC_CONFIG = {
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbzrxLOCvP9kghdrJJ4bUNMdkP0o0Gn8MadSW6LVxnfrVU6muveObOS_rw1Ds_9JTNy9/exec',
  // Apps Script di Google Sheet "MRP PPIC GTK" (menu MRP). Kosong = belum dipasang.
  MRP_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbydTHdU7vXyPunmJJm59XqiLROv26Bbp_YEtteMd9GGvENveNWvrC9QFPrdL8NSPeOdoA/exec',
  // MRP belum dihubungkan ke data Monitoring PO (incoming hanya dari incoming manual). Ubah ke true bila sudah siap.
  MRP_LINK_PO: false,
  MRP_SHEET_URL: 'https://docs.google.com/spreadsheets/d/1nx0gqSM8UzVKYMvqyzHmCvafZIcEKZLCswGJ7o3rQ9c/edit',
  // Apps Script di Google Sheet "CSL PPIC GTK" (menu CSL Personal Care). Kosong = belum dipasang.
  CSL_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbzI05llwLoC5huYAdfO1v93K2YlieVLcH7q9eJQZWhWbHJefb9B-QXiZ1-f5LEdiUsu/exec',
  CSL_SHEET_URL: 'https://docs.google.com/spreadsheets/d/1fhu2KSCqjzaNzyrYkLS2oAXeBYxku75zKwLqZo3ITY4/edit',
  SHEET_URL: 'https://docs.google.com/spreadsheets/d/1Dw7HmExGNYYDkbNgYTPA7zwEr6ueUMhdtjdlR7tCBdU/edit',
};
