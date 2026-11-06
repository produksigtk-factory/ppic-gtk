// Beri nomor versi (hash isi file) pada CSS/JS di index.html, supaya browser boleh menyimpan file
// lama-lama (lihat _headers) tetapi langsung mengambil versi baru setiap kali isinya berubah.
// Jalankan sebelum commit: node tools/stamp.js
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.join(__dirname, '..');
const file = path.join(root, 'index.html');
let html = fs.readFileSync(file, 'utf8');
html = html.replace(/(src|href)="((?:[\w-]+\/)*[\w-]+\.(?:js|css))(?:\?v=[\w]+)?"/g, (m, attr, f) => {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) return m;
  const v = crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex').slice(0, 8);
  return `${attr}="${f}?v=${v}"`;
});
fs.writeFileSync(file, html);
console.log(html.match(/(?:src|href)="[\w/-]+\.(?:js|css)\?v=\w+"/g).join('\n'));
