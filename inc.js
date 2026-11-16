/* Kebutuhan Report → Incoming RMPM — PPIC GTK
 * Data penerimaan RM/PM disimpan di Google Sheet "Incoming RMPM" (Apps Script Code_INC.gs).
 * Sumber: Report (Jan–Jun 2026, dari file 10. Incoming), Odoo (export Receipt, Juli 2026 dst.), Manual (WIP maklon, dll.).
 * Tidak terhubung ke Monitoring PO — No PO hanya teks.
 * Kelompok: Beauty = material yang HANYA dipakai FG Mizzu menurut BOM (+ WIP Mizzu), selain itu Personal Care.
 * Kategori material dari KATEGORI di DB_GOLONGAN (Value and Qty Inventory). SO / DO / FCT dari CSL Personal Care & CSL Beauty.
 */
(function () {
  'use strict';
  const CFG = window.PPIC_CONFIG || {};
  const UI = window.PPIC_UI || {};
  const $ = (id) => document.getElementById(id);
  const esc = UI.esc || ((s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const toast = UI.toast || ((t) => console.log(t));
  const openDialog = UI.openDialog;
  const todayStr = UI.todayStr || (() => new Date().toISOString().slice(0, 10));

  const MON = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const nf0 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf3 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 3 });
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const fQ = (v) => (!isNum(v) ? '–' : nf3.format(v));
  const fRp = (v) => (!isNum(v) ? '–' : 'Rp ' + nf0.format(Math.round(v)));
  const fBig = (v) => { if (!isNum(v)) return '–'; const a = Math.abs(v); return a >= 1e9 ? 'Rp ' + nf1.format(v / 1e9) + ' M' : a >= 1e6 ? 'Rp ' + nf1.format(v / 1e6) + ' jt' : 'Rp ' + nf0.format(v); };
  const fPct = (v) => (!isNum(v) ? '–' : nf1.format(v * 100) + '%');
  const monLabel = (m) => (m ? `${MON[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}` : '');
  const monShort = (m) => (m ? `${MON3[+m.slice(5, 7) - 1]} ${m.slice(2, 4)}` : '');
  const fDate = (d) => (d ? `${d.slice(8, 10)} ${MON3[+d.slice(5, 7) - 1]} ${d.slice(2, 4)}` : '–');
  const S = (v) => String(v === null || v === undefined ? '' : v).trim();
  const N = (v) => { if (typeof v === 'number') return v; const x = Number(S(v).replace(/,/g, '')); return isFinite(x) ? x : 0; };
  const ratio = (a, b) => (b ? a / b : NaN);
  const KEL = { PC: 'Personal Care', BEAUTY: 'Beauty' };
  const GOL = { RM: 'RM (Raw Material)', PM: 'PM (Packaging Material)', WIP: 'WIP / maklon', FG: 'FG', '?': 'Golongan belum diketahui' };
  const GOL_ORDER = ['RM', 'PM', 'WIP', 'FG', '?'];

  /* ---------- State ---------- */
  const I = {
    loaded: false, loading: false, err: '', raw: [], rows: [], rtr: [], reason: new Map(), log: [], cutoff: '2026-07', sheetUrl: '', readAt: '',
    mat: new Map(), mizzu: new Set(), metaNote: '', csl: { pc: null, beauty: null, err: '' },
    m: '', kel: '', src: '', q: '', tab: 'bulan', year: '',
  };
  try { const v = JSON.parse(localStorage.getItem('ppic.inc') || '{}'); if (v.tab) I.tab = v.tab; if (v.kel !== undefined) I.kel = v.kel; } catch (e) { /* abaikan */ }
  const savePref = () => { try { localStorage.setItem('ppic.inc', JSON.stringify({ tab: I.tab, kel: I.kel })); } catch (e) { /* abaikan */ } };

  /* ---------- Apps Script ---------- */
  async function getJSON(url) { const r = await fetch(url); const d = await r.json(); if (!d.ok) throw new Error(d.error || 'Gagal membaca data.'); return d; }
  async function api(action, payload) {
    if (!CFG.INC_SCRIPT_URL) throw new Error('Apps Script Incoming RMPM belum terpasang.');
    let res;
    try { res = await fetch(CFG.INC_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(Object.assign({ action }, payload)) }); }
    catch (e) { throw new Error('koneksi internet terputus atau Google tidak merespons'); }
    const d = await res.json();
    if (!d.ok) throw new Error(/Aksi tidak dikenal/.test(d.error || '') ? 'Apps Script Incoming RMPM belum versi terbaru.' : d.error || 'Gagal menyimpan.');
    return d;
  }

  async function load(force) {
    if (I.loading) return;
    I.loading = true; I.err = ''; paint();
    try {
      if (!CFG.INC_SCRIPT_URL) throw new Error('noUrl');
      const [d] = await Promise.all([getJSON(CFG.INC_SCRIPT_URL), (force || !I.mat.size) ? loadMeta() : null]);
      applyData(d);
      I.loaded = true;
      loadCsl();
    } catch (e) { I.err = e.message; }
    I.loading = false; paint(); render();
  }
  function applyData(d) {
    I.raw = d.rows || []; I.log = d.log || []; I.cutoff = d.cutoff || I.cutoff; I.sheetUrl = d.sheetUrl || ''; I.readAt = d.readAt || '';
    I.reason = new Map((d.reason || []).map((r) => [`${r[0]}|${r[1]}|${r[2]}`, r[3]]));
    normalize();
  }
  // Master material (nama, UoM, jenis) + BOM dari MRP; golongan & kategori dari Value and Qty Inventory
  async function loadMeta() {
    const notes = [];
    const [mrp, inv] = await Promise.all([
      CFG.MRP_SCRIPT_URL ? getJSON(CFG.MRP_SCRIPT_URL).catch((e) => { notes.push('MRP: ' + e.message); return null; }) : null,
      CFG.INV_SCRIPT_URL ? getJSON(CFG.INV_SCRIPT_URL).catch((e) => { notes.push('Inventory: ' + e.message); return null; }) : null,
    ]);
    const mat = new Map();
    ((mrp && mrp.master) || []).forEach((r) => { const k = S(r[0]); if (k) mat.set(k, { nama: S(r[1]), uom: S(r[2]), jenis: /^RM/i.test(S(r[3])) ? 'RM' : /^PM/i.test(S(r[3])) ? 'PM' : /^FG/i.test(S(r[3])) ? 'FG' : /WIP|BULK|EKSTRAK/i.test(S(r[3])) ? 'WIP' : '', kat: '' }); });
    const G = new Map();
    ((inv && inv.golongan) || []).forEach((g) => { const k = S(g[0]); if (!k) return; G.set(k, g); const o = mat.get(k) || { nama: S(g[1]), uom: S(g[4]), jenis: '', kat: '' }; if (['RM', 'PM', 'WIP', 'FG'].includes(S(g[2]))) o.jenis = S(g[2]); o.kat = S(g[3]); if (!o.nama) o.nama = S(g[1]); if (!o.uom) o.uom = S(g[4]); mat.set(k, o); });
    // Material yang HANYA dipakai FG Mizzu (BOM, termasuk lewat ekstrak/WIP)
    const mizzu = new Set();
    if (mrp && mrp.boms && mrp.details && G.size) {
      const brandOf = (c) => { const g = G.get(c); if (!g || S(g[2]) !== 'FG') return null; return (S(g[3]).split(' - ')[0] || '').trim().toUpperCase() || '?'; };
      const fgOf = {}; mrp.boms.forEach((b) => { fgOf[b[0]] = S(b[1]); });
      const users = new Map(); mrp.details.forEach((x) => { const p = fgOf[x[0]]; if (!p) return; const k = S(x[1]); if (!users.has(k)) users.set(k, new Set()); users.get(k).add(p); });
      const memo = new Map();
      const brands = (c, seen) => {
        if (memo.has(c)) return memo.get(c);
        const out = new Set(); seen = seen || new Set([c]);
        (users.get(c) || new Set()).forEach((p) => { if (seen.has(p)) return; const b = brandOf(p); if (b) out.add(b); else if (users.has(p)) brands(p, new Set([...seen, p])).forEach((z) => out.add(z)); else out.add('NON-FG'); });
        memo.set(c, out); return out;
      };
      users.forEach((_, c) => { const b = brands(c); if (b.size === 1 && b.has('MIZZU')) mizzu.add(c); });
    } else notes.push('BOM / golongan FG belum terbaca: kelompok Beauty hanya dari nama "Mizzu"');
    I.mat = mat; I.mizzu = mizzu; I.metaNote = notes.join(' · ');
  }
  async function loadCsl() {
    if (!window.CSL || !window.CSL.monthly) return;
    try {
      const [pc, b] = await Promise.all([window.CSL.monthly('pc'), window.CSL.monthly('beauty').catch(() => ({ months: [] }))]);
      I.csl.pc = new Map(pc.months.map((x) => [x.m, x])); I.csl.beauty = new Map((b.months || []).map((x) => [x.m, x])); I.csl.err = '';
    } catch (e) { I.csl.err = e.message; }
    if (isHere()) render();
  }

  function normalize() {
    const out = [], rtr = [];
    I.raw.forEach((r) => {
      const kode = S(r[8]), m = I.mat.get(kode) || {};
      const nama = S(r[9]) || m.nama || '';
      const kelStored = S(r[2]).toUpperCase();
      const kel = kelStored === 'BEAUTY' || kelStored === 'PC' ? kelStored : (I.mizzu.has(kode) || /mizzu/i.test(nama) || /mizzu/i.test(m.nama || '') ? 'BEAUTY' : 'PC');
      const x = { id: S(r[0]), src: S(r[1]), kel, tgl: S(r[3]), m: S(r[4]) || S(r[3]).slice(0, 7), noIn: S(r[5]), po: S(r[6]), sup: S(r[7]), kode, nama,
        qty: N(r[10]), uom: S(r[11]) || m.uom || '', sn: S(r[12]), harga: N(r[13]), st: S(r[14]), cat: S(r[15]), upd: S(r[16]),
        gol: (/WIP/i.test(m.kat || '') || /^WIP\b/i.test(nama)) ? 'WIP' : m.jenis || (/^30\d{3}$/.test(kode) ? 'WIP' : '?'), kat: m.kat || '' };
      x.val = x.qty * x.harga;
      (x.st === 'Ready to Receive' ? rtr : out).push(x);
    });
    out.sort((a, b) => (a.tgl < b.tgl ? 1 : a.tgl > b.tgl ? -1 : 0));
    I.rows = out; I.rtr = rtr;
    const ms = [...new Set(out.map((x) => x.m).filter(Boolean))].sort();
    if (!ms.includes(I.m)) I.m = ms[ms.length - 1] || '';
    if (!I.year || !ms.some((m) => m.startsWith(I.year))) I.year = (I.m || todayStr()).slice(0, 4);
  }

  /* ---------- Saringan ---------- */
  const qOk = (x) => { const q = I.q.toLowerCase(); return !q || `${x.kode} ${x.nama} ${x.po} ${x.sup} ${x.noIn} ${x.sn}`.toLowerCase().includes(q); };
  const pick = (L, m) => L.filter((x) => (!m || x.m === m) && (!I.kel || x.kel === I.kel) && (I.tab !== 'daftar' || ((!I.src || x.src === I.src) && qOk(x))));
  const sumBy = (L, key) => { const mp = new Map(); L.forEach((x) => { const k = key(x); const o = mp.get(k) || { val: 0, qty: 0, n: 0, kode: new Set(), rows: [] }; o.val += x.val; o.qty += x.qty; o.n++; o.kode.add(x.kode); o.rows.push(x); mp.set(k, o); }); return mp; };
  const tot = (L) => L.reduce((t, x) => t + x.val, 0);
  function cslOf(m) {
    const P = I.csl.pc && I.csl.pc.get(m), B = I.csl.beauty && I.csl.beauty.get(m);
    const z = { so: 0, do: 0, dos: 0, fct: 0 };
    const f = (x) => (x ? { so: x.so, do: x.do, dos: x.dos, fct: x.fctNilai || x.fctRp || 0 } : z);
    if (I.kel === 'PC') return f(P);
    if (I.kel === 'BEAUTY') return Object.assign(f(B), { fct: 0 });
    const a = f(P), b = f(B);
    return { so: a.so + b.so, do: a.do + b.do, dos: a.dos + b.dos, fct: a.fct };
  }

  /* ---------- Render ---------- */
  const isHere = () => location.hash.replace(/^#\/?/, '') === 'rep/incoming';
  function paint() { const el = $('incLoading'); if (el) el.hidden = !I.loading; }
  function render() {
    if (!$('incBody')) return;
    $('dataInfo').textContent = I.loaded ? `Incoming RMPM dibaca ${I.readAt} · ${nf0.format(I.rows.length)} penerimaan · ${nf0.format(I.rtr.length)} masih karantina` : I.err === 'noUrl' ? 'Apps Script Incoming RMPM belum dipasang' : I.err ? 'Data Incoming belum termuat' : 'Memuat…';
    if (I.err === 'noUrl') {
      $('incTop').hidden = true;
      $('incBody').innerHTML = `<div class="warn-box"><h4>Apps Script belum dipasang</h4><p>Buka Google Sheet <b>Incoming RMPM</b> → Extensions → Apps Script → tempel <code>Code_INC.gs</code> → Deploy sebagai Web app (Execute as: Me, Who has access: Anyone), lalu kirim Web App URL-nya untuk dipasang di website.</p></div>`;
      return;
    }
    if (I.err && !I.loaded) { $('incTop').hidden = true; $('incBody').innerHTML = `<p class="check err">${esc(I.err)}</p>`; return; }
    if (!I.loaded) return;
    $('incTop').hidden = false;
    const ms = monthsAll();
    const per = I.tab === 'grafik' || I.tab === 'rtr';
    $('incMonth').innerHTML = ms.slice().reverse().map((m) => `<option value="${m}"${m === I.m ? ' selected' : ''}>${monLabel(m)}</option>`).join('');
    $('incMonthBox').hidden = per;
    const i = ms.indexOf(I.m);
    $('incPrev').disabled = i <= 0; $('incNext').disabled = i < 0 || i >= ms.length - 1;
    document.querySelectorAll('#incKel [data-v]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === I.kel)));
    document.querySelectorAll('#incTab [data-v]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === I.tab)));
    const rt = pick(I.rtr, '');
    $('incTab').querySelector('[data-v="rtr"]').innerHTML = `Masih karantina${rt.length ? ` <span class="inc-badge">${rt.length}</span>` : ''}`;
    const L = pick(I.rows, I.tab === 'grafik' ? '' : I.m);
    $('incHero').innerHTML = per ? '' : hero(L, rt);
    $('incBody').innerHTML = (I.metaNote ? `<p class="check warn">${esc(I.metaNote)}</p>` : '') + (I.tab === 'grafik' ? viewGrafik() : I.tab === 'daftar' ? viewDaftar(L) : I.tab === 'rtr' ? viewRtr() : viewBulan(L));
  }
  const monthsAll = () => [...new Set(I.rows.map((x) => x.m).filter(Boolean))].sort();
  // Ringkasan atas: nilai incoming bulan ini vs bulan lalu, komposisi RM/PM/WIP, rasio ke SO/DO, karantina
  function hero(L, rt) {
    if (!L.length) return '<div class="inc-hero"><p class="muted">Tidak ada incoming pada bulan dan saringan ini.</p></div>';
    const t = tot(L), ms = monthsAll(), pm = ms[ms.indexOf(I.m) - 1], pt = pm ? tot(pick(I.rows, pm)) : NaN;
    const d = isNum(pt) && pt ? (t - pt) / pt : NaN;
    const g = sumBy(L, (x) => x.gol), c = cslOf(I.m);
    const parts = GOL_ORDER.filter((k) => g.has(k)).map((k) => ({ k, v: g.get(k).val, n: g.get(k).kode.size }));
    const CL = { RM: '#1e7a46', PM: '#c0392b', WIP: '#c9962b', FG: '#5b6f86', '?': '#aab4bd' };
    const lbl = (k) => (k === '?' ? 'Tanpa golongan' : k);
    const ratioBox = (name, v, base, note) => `<div class="inc-ratio"><span class="inc-rl">% terhadap ${name}</span><b>${fPct(ratio(t, base))}</b><small>${base ? `${name} ${fBig(base)}` : note}</small></div>`;
    const src = [...new Set(L.map((x) => x.src))];
    return `<div class="inc-hero">
      <div class="inc-hmain">
        <span class="inc-hl">Incoming ${monLabel(I.m)}${I.kel ? ` · ${KEL[I.kel]}` : ''}</span>
        <div class="inc-hv">${fRp(t)}</div>
        <div class="inc-hd">${isNum(d) ? `<span class="${d >= 0 ? 'inc-up' : 'inc-dn'}">${d >= 0 ? '▲' : '▼'} ${fPct(Math.abs(d))}</span> dibanding ${monLabel(pm)} (${fBig(pt)})` : 'Bulan pertama data'}${I.m === todayStr().slice(0, 7) ? ` <span class="inc-run">bulan berjalan · data s/d ${esc(fDate(L.map((x) => x.tgl.slice(0, 10)).sort().pop()))}</span>` : ''}</div>
        <div class="inc-hs">${nf0.format(L.length)} penerimaan · ${new Set(L.map((x) => x.po)).size} PO · ${new Set(L.map((x) => x.sup)).size} supplier · sumber ${src.map((s) => `<span class="inc-src inc-src-${esc(s)}">${esc(s)}</span>`).join(' ')}</div>
      </div>
      <div class="inc-hmix">
        <span class="inc-hl">Komposisi</span>
        <div class="inc-stack">${parts.map((p) => `<i style="width:${Math.max(0.5, p.v / t * 100)}%;background:${CL[p.k]}" title="${lbl(p.k)} ${fRp(p.v)}"></i>`).join('')}</div>
        <ul class="inc-mixl">${parts.map((p) => `<li><i style="background:${CL[p.k]}"></i>${lbl(p.k)} <b>${fPct(p.v / t)}</b> <span class="muted">${fBig(p.v)} · ${p.n} material</span></li>`).join('')}</ul>
      </div>
      <div class="inc-hr">${ratioBox('SO', c.so, c.so, I.csl.pc ? 'SO belum ada' : 'memuat CSL…')}${ratioBox('DO', c.dos, c.dos, '')}</div>
    </div>
    ${rt.length ? `<button type="button" class="inc-quar" data-inc-tab="rtr"><b>${fBig(tot(rt))}</b> masih karantina (${rt.length} baris Ready to Receive) — belum dihitung sebagai incoming. <u>Lihat</u></button>` : ''}`;
  }
  const head = (cols) => `<thead><tr>${cols.map((c) => `<th${c[1] ? ` class="${c[1]}"` : ''}>${c[0]}</th>`).join('')}</tr></thead>`;
  const barCell = (p, color) => `<span class="inc-bar"><i style="width:${Math.max(0, Math.min(100, p * 100))}%${color ? `;background:${color}` : ''}"></i></span>`;
  function viewBulan(L) {
    if (!L.length) return '';
    const t = tot(L);
    const CL = { RM: '#1e7a46', PM: '#c0392b', WIP: '#c9962b', FG: '#5b6f86', '?': '#aab4bd' };
    // Kategori: per golongan → kategori, dengan bar porsi
    const byG = sumBy(L, (x) => x.gol);
    let kat = '';
    GOL_ORDER.filter((g) => byG.has(g)).forEach((g) => {
      const o = byG.get(g);
      kat += `<div class="inc-kg"><span class="inc-dot" style="background:${CL[g]}"></span><b>${esc(GOL[g])}</b><span class="inc-kv">${fRp(o.val)} <small>${fPct(o.val / t)}</small></span></div>`;
      [...sumBy(o.rows, (x) => x.kat || 'Tanpa kategori')].sort((a, b) => b[1].val - a[1].val).forEach(([k, v]) => {
        kat += `<div class="inc-kr"><span class="inc-kn${k === 'Tanpa kategori' ? ' muted' : ''}">${esc(k)} <small class="muted">${v.kode.size} material</small></span>${barCell(v.val / t, CL[g])}<span class="inc-kv">${fBig(v.val)} <small>${fPct(v.val / t)}</small></span></div>`;
      });
    });
    const noKat = new Set(L.filter((x) => !x.kat).map((x) => x.kode)).size;
    // Top 10
    const byM = [...sumBy(L, (x) => x.kode)].sort((a, b) => b[1].val - a[1].val);
    const top = byM.slice(0, 10), mx = top.length ? top[0][1].val : 1;
    const rk = (kode) => I.reason.get(`${I.m}|${I.kel || 'ALL'}|${kode}`) || '';
    const topHtml = top.map(([kode, o], i) => {
      const x = o.rows[0], r = rk(kode);
      return `<li class="inc-ti">
        <span class="inc-tn">${i + 1}</span>
        <div class="inc-tb">
          <div class="inc-tt"><span><b>${esc(x.nama || kode)}</b> <small class="muted">${esc(kode)} · ${esc(x.gol === '?' ? '–' : x.gol)}${!I.kel ? ` · ${KEL[x.kel]}` : ''} · ${fQ(o.qty)} ${esc(x.uom)}</small></span><span class="inc-kv"><b>${fBig(o.val)}</b> <small>${fPct(o.val / t)}</small></span></div>
          ${barCell(o.val / mx, CL[x.gol])}
          <div class="inc-tr" data-inc-rbox="${esc(kode)}">${r ? `<span class="inc-rt">${esc(r)}</span> <button type="button" class="btn-link" data-inc-redit="${esc(kode)}">ubah</button>` : `<button type="button" class="btn-link inc-radd" data-inc-redit="${esc(kode)}">+ alasan</button>`}</div>
        </div></li>`;
    }).join('');
    const mrow = ([kode, o], i) => {
      const x = o.rows[0];
      return `<tr><td class="num">${i + 1}</td><td><span class="pl-code">${esc(kode)}</span> ${esc(x.nama)}${!I.kel ? ` <small class="muted">${KEL[x.kel] || ''}</small>` : ''}</td><td>${esc(x.gol === '?' ? '–' : x.gol)}${x.kat ? ` <small class="muted">${esc(x.kat)}</small>` : ''}</td>
        <td class="num">${fQ(o.qty)} <small class="muted">${esc(x.uom)}</small></td><td class="num"><b>${fRp(o.val)}</b></td><td class="num">${fPct(o.val / t)}</td><td class="num">${o.n}</td><td>${esc([...new Set(o.rows.map((r) => r.sup))].join(', '))}</td></tr>`;
    };
    return `<div class="inc-two">
      <section class="inv-card"><div class="inc-ch"><h3>Top 10 incoming</h3><small class="muted">menurut value</small></div><ol class="inc-top">${topHtml}</ol></section>
      <section class="inv-card"><div class="inc-ch"><h3>Per golongan &amp; kategori</h3></div><div class="inc-kat">${kat}</div>
        ${noKat ? `<p class="hint">${noKat} material belum punya kategori. Kategori diambil dari kolom KATEGORI di DB_GOLONGAN (Value and Qty Inventory).</p>` : ''}</section>
    </div>
    <details class="inv-card inc-all"${I.openAll ? ' open' : ''}><summary><b>Semua material</b> <span class="muted">${byM.length} material · klik untuk ${I.openAll ? 'menutup' : 'membuka'}</span></summary>
      <div class="table-wrap inv-tw"><table class="po-table inv-t">${head([['No', 'num'], ['Material'], ['Golongan'], ['Qty', 'num'], ['Value', 'num'], ['Porsi', 'num'], ['Penerimaan', 'num'], ['Supplier']])}<tbody>${byM.map(mrow).join('')}</tbody></table></div></details>`;
  }
  function yearMonths() {
    const ms = [...new Set(I.rows.map((x) => x.m).filter((m) => m && m.startsWith(I.year)))].sort();
    return ms;
  }
  function grafikData() {
    const ms = yearMonths();
    return ms.map((m) => {
      const L = pick(I.rows, m), c = cslOf(m), g = sumBy(L, (x) => (x.gol === 'RM' ? 'RM' : x.gol === 'PM' ? 'PM' : 'LAIN'));
      return { m, inc: tot(L), rm: (g.get('RM') || {}).val || 0, pm: (g.get('PM') || {}).val || 0, lain: (g.get('LAIN') || {}).val || 0, fct: c.fct, so: c.so, do: c.dos };
    });
  }
  function viewGrafik() {
    const years = [...new Set(I.rows.map((x) => x.m.slice(0, 4)).filter(Boolean))].sort().reverse();
    const D = grafikData();
    const showF = I.kel !== 'BEAUTY';
    const T = D.reduce((a, x) => { ['inc', 'rm', 'pm', 'lain', 'fct', 'so', 'do'].forEach((k) => { a[k] = (a[k] || 0) + x[k]; }); return a; }, {});
    const rowH = (x, lbl) => `<tr${lbl ? ' class="inc-gr"' : ''}><td>${lbl || monLabel(x.m)}${!lbl && x.m < I.cutoff ? ' <small class="muted">report</small>' : ''}</td><td class="num"><b>${fRp(x.inc)}</b></td><td class="num">${fRp(x.rm)}</td><td class="num">${fRp(x.pm)}</td>
      ${showF ? `<td class="num">${x.fct ? fRp(x.fct) : '–'}</td>` : ''}<td class="num">${x.so ? fRp(x.so) : '–'}</td><td class="num">${x.do ? fRp(x.do) : '–'}</td>
      ${showF ? `<td class="num">${fPct(ratio(x.inc, x.fct))}</td>` : ''}<td class="num">${fPct(ratio(x.inc, x.so))}</td><td class="num">${fPct(ratio(x.inc, x.do))}</td></tr>`;
    const wait = !I.csl.pc && !I.csl.err ? '<p class="check">Memuat SO / DO dari CSL…</p>' : I.csl.err ? `<p class="check err">SO / DO belum terbaca: ${esc(I.csl.err)}</p>` : '';
    return `<div class="toolbar"><label class="tb-field tb-narrow"><span class="sr">Tahun</span><select id="incYear">${years.map((y) => `<option${y === I.year ? ' selected' : ''}>${y}</option>`).join('')}</select></label></div>${wait}
      <section class="inv-card" id="incChart1"><div class="inv-ch"><h3>Materials incoming ${I.kel ? KEL[I.kel] : 'Personal Care + Beauty'} ${I.year}</h3><button type="button" class="btn btn-sm" data-inc-jpg="incChart1">Unduh JPG</button></div>${barChart(D, showF)}</section>
      <section class="inv-card" id="incChart2"><div class="inv-ch"><h3>Value incoming RM vs PM ${I.year}</h3><button type="button" class="btn btn-sm" data-inc-jpg="incChart2">Unduh JPG</button></div>${lineChart(D)}</section>
      <section class="inv-card"><h3>Rekap per bulan</h3><div class="table-wrap"><table class="po-table inv-t">${head([['Bulan'], ['Incoming', 'num'], ['RM', 'num'], ['PM', 'num']].concat(showF ? [['Forecast', 'num']] : [], [['SO', 'num'], ['DO', 'num']], showF ? [['% thd FCT', 'num']] : [], [['% thd SO', 'num'], ['% thd DO', 'num']]))}
        <tbody>${D.map((x) => rowH(x)).join('')}${D.length ? rowH(T, 'Total') : ''}</tbody></table></div>
        <p class="hint">Incoming = value penerimaan Received (Jan–Jun 2026 dari file report, Juli dst. dari Odoo + manual). SO dan DO dari ${I.kel === 'PC' ? 'CSL Personal Care' : I.kel === 'BEAUTY' ? 'CSL Beauty' : 'CSL Personal Care + CSL Beauty'}; DO = semua DO terkirim di bulan itu (DO + OS). Forecast dari CSL Personal Care.</p></section>`;
  }
  const C_INC = '#0f4d2c', C_SO = '#7fa88e', C_DO = '#c9962b', C_FCT = '#9aa5b1', C_RM = '#1e7a46', C_PM = '#c0392b';
  const axisMax = (v) => { if (!(v > 0)) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p; return ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((x) => f <= x + 1e-9) || 10) * p; };
  const shortRp = (v) => (v >= 1e9 ? nf1.format(v / 1e9) + ' M' : v >= 1e6 ? nf0.format(v / 1e6) + ' jt' : nf0.format(v));
  function legend(items) { return `<div class="inc-leg">${items.map(([c, t]) => `<span><i style="background:${c}"></i>${esc(t)}</span>`).join('')}</div>`; }
  function barChart(D, showF) {
    if (!D.length) return '<p class="muted">Belum ada data.</p>';
    const ser = [['inc', C_INC, 'Incoming']].concat(showF ? [['fct', C_FCT, 'Forecast']] : [], [['so', C_SO, 'SO'], ['do', C_DO, 'DO']]);
    const W = 960, H = 300, L = 60, R = 12, T = 12, B = 30;
    const max = axisMax(Math.max(...D.flatMap((x) => ser.map((s) => x[s[0]] || 0))));
    const gw = (W - L - R) / D.length, bw = Math.min(26, (gw - 10) / ser.length);
    const y = (v) => T + (H - T - B) * (1 - v / max);
    let g = '';
    for (let i = 0; i <= 4; i++) { const v = max * i / 4; g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="inc-grid-l"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="inc-ax">${shortRp(v)}</text>`; }
    D.forEach((x, i) => {
      const x0 = L + gw * i + (gw - bw * ser.length) / 2;
      ser.forEach((s, j) => { const v = x[s[0]] || 0; if (!v) return; g += `<rect x="${x0 + j * bw}" y="${y(v)}" width="${bw - 2}" height="${Math.max(0, y(0) - y(v))}" rx="2" fill="${s[1]}"><title>${monLabel(x.m)} · ${s[2]}: ${fRp(v)}</title></rect>`; });
      g += `<text x="${L + gw * i + gw / 2}" y="${H - 10}" text-anchor="middle" class="inc-ax">${monShort(x.m)}</text>`;
      if (x.inc && (x.so || x.do)) g += `<text x="${L + gw * i + gw / 2}" y="${y(Math.max(...ser.map((s) => x[s[0]] || 0))) - 4}" text-anchor="middle" class="inc-lbl">${fPct(ratio(x.inc, x.do || x.so))}</text>`;
    });
    return legend(ser.map((s) => [s[1], s[2]])) + `<svg viewBox="0 0 ${W} ${H}" class="inc-svg" role="img" aria-label="Grafik incoming vs SO vs DO">${g}</svg><p class="hint">Angka di atas batang = incoming ÷ DO bulan itu.</p>`;
  }
  function lineChart(D) {
    if (!D.length) return '<p class="muted">Belum ada data.</p>';
    const W = 960, H = 260, L = 60, R = 20, T = 14, B = 30;
    const max = axisMax(Math.max(...D.flatMap((x) => [x.rm, x.pm])));
    const xx = (i) => L + (D.length === 1 ? (W - L - R) / 2 : i * (W - L - R) / (D.length - 1)), y = (v) => T + (H - T - B) * (1 - v / max);
    let g = '';
    for (let i = 0; i <= 4; i++) { const v = max * i / 4; g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="inc-grid-l"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="inc-ax">${shortRp(v)}</text>`; }
    [['rm', C_RM], ['pm', C_PM]].forEach(([k, c]) => {
      g += `<polyline fill="none" stroke="${c}" stroke-width="2.5" points="${D.map((x, i) => `${xx(i)},${y(x[k])}`).join(' ')}"/>`;
      D.forEach((x, i) => { g += `<circle cx="${xx(i)}" cy="${y(x[k])}" r="4" fill="${c}"><title>${monLabel(x.m)} · ${k.toUpperCase()}: ${fRp(x[k])}</title></circle><text x="${xx(i)}" y="${y(x[k]) + ((k === 'rm') === (x.rm >= x.pm) ? -9 : 17)}" text-anchor="middle" class="inc-lbl" fill="${c}">${shortRp(x[k])}</text>`; });
    });
    D.forEach((x, i) => { g += `<text x="${xx(i)}" y="${H - 10}" text-anchor="middle" class="inc-ax">${monShort(x.m)}</text>`; });
    return legend([[C_RM, 'RM'], [C_PM, 'PM']]) + `<svg viewBox="0 0 ${W} ${H}" class="inc-svg" role="img" aria-label="Grafik RM vs PM">${g}</svg>`;
  }
  function viewDaftar(L) {
    const shown = L.slice(0, 2000);
    return `<div class="toolbar inc-dbar"><label class="tb-field tb-narrow"><span class="sr">Sumber</span><select id="incSrc"><option value="">Semua sumber</option>${['Report', 'Odoo', 'Manual'].map((v) => `<option${v === I.src ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="tb-search"><span class="sr">Cari</span><input type="search" id="incQ" placeholder="Cari kode, nama, PO, supplier, No IN" value="${esc(I.q)}"></label><span class="muted">${nf0.format(L.length)} baris · ${fRp(tot(L))}</span></div>
      <div class="table-wrap inv-tw"><table class="po-table inv-t inc-list">${head([['Tanggal'], ['No IN'], ['No PO'], ['Supplier'], ['Material'], ['Qty', 'num'], ['Harga', 'num'], ['Value', 'num'], ['Golongan'], ['Kelompok'], ['Sumber'], ['']])}<tbody>
      ${shown.map((x) => `<tr><td>${esc(fDate(x.tgl.slice(0, 10)))}</td><td>${esc(x.noIn || '–')}</td><td>${esc(x.po)}</td><td>${esc(x.sup)}</td><td><span class="pl-code">${esc(x.kode)}</span> ${esc(x.nama)}${x.sn ? `<div class="muted inv-sm">${esc(x.sn)}</div>` : ''}</td>
        <td class="num">${fQ(x.qty)} <small class="muted">${esc(x.uom)}</small></td><td class="num">${fRp(x.harga)}</td><td class="num"><b>${fRp(x.val)}</b></td><td>${esc(x.gol === '?' ? '–' : x.gol)}${x.kat ? `<div class="muted inv-sm">${esc(x.kat)}</div>` : ''}</td><td>${KEL[x.kel] || ''}</td>
        <td><span class="inc-src inc-src-${esc(x.src)}">${esc(x.src)}</span></td><td>${x.src === 'Manual' ? `<button type="button" class="btn-link" data-inc-edit="${esc(x.id)}">Ubah</button> <button type="button" class="btn-link danger" data-inc-del="${esc(x.id)}">Hapus</button>` : ''}</td></tr>`).join('') || '<tr class="empty"><td colspan="12">Tidak ada data.</td></tr>'}
      </tbody><tfoot><tr><th colspan="7">Total ${nf0.format(L.length)} baris</th><th class="num">${fRp(tot(L))}</th><th colspan="4"></th></tr></tfoot></table></div>
      ${L.length > shown.length ? `<p class="hint">Menampilkan 2.000 dari ${nf0.format(L.length)} baris.</p>` : ''}`;
  }
  function viewRtr() {
    const L = pick(I.rtr, '').sort((a, b) => (a.noIn < b.noIn ? 1 : -1));
    return `<p class="check">Penerimaan berstatus <b>Ready to Receive</b> (masih di karantina / belum divalidasi di Odoo). <b>Tidak dihitung</b> sebagai incoming; diganti setiap upload export Odoo. Setelah divalidasi (Received), otomatis masuk incoming di bulan tanggal validasinya.</p>
      <div class="table-wrap inv-tw"><table class="po-table inv-t">${head([['No IN'], ['No PO'], ['Supplier'], ['Material'], ['Qty', 'num'], ['Harga', 'num'], ['Value', 'num'], ['Kelompok']])}<tbody>
      ${L.map((x) => `<tr><td>${esc(x.noIn)}</td><td>${esc(x.po)}</td><td>${esc(x.sup)}</td><td><span class="pl-code">${esc(x.kode)}</span> ${esc(x.nama)}</td><td class="num">${fQ(x.qty)} <small class="muted">${esc(x.uom)}</small></td><td class="num">${fRp(x.harga)}</td><td class="num">${fRp(x.val)}</td><td>${KEL[x.kel] || ''}</td></tr>`).join('') || '<tr class="empty"><td colspan="8">Tidak ada.</td></tr>'}
      </tbody><tfoot><tr><th colspan="6">Total ${L.length} baris</th><th class="num">${fRp(tot(L))}</th><th></th></tr></tfoot></table></div>`;
  }

  /* ---------- Upload export Odoo ---------- */
  function parseOdoo(wb) {
    const sn = wb.SheetNames[0];
    const r = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '', raw: true, blankrows: false });
    const h = (r[0] || []).map((v) => S(v).toLowerCase());
    const at = (re) => h.findIndex((v) => re.test(v));
    const c = { id: at(/^external id$/), date: at(/date of transfer|date done|tanggal/), ref: at(/^reference$|^referensi$/), prod: at(/serial number\/product$|\/product$|^product$/), qty: at(/\/quantity$|^quantity$/),
      sn: at(/serial number\/serial number$|lot/), po: at(/purchase order$/), price: at(/unit price/), sup: at(/partner/), st: at(/^status$/) };
    const miss = Object.entries(c).filter(([k, v]) => v < 0 && k !== 'id' && k !== 'sn').map(([k]) => k);
    if (miss.length) throw new Error(`Kolom export Odoo tidak ditemukan: ${miss.join(', ')}. Gunakan export Receipt yang sama dengan INCOMING RMPM.`);
    const toDT = (v) => {
      if (typeof v === 'number') { const d = new Date(Math.round((v - 25569) * 864e5)); return d.toISOString().slice(0, 16).replace('T', ' '); }
      return S(v).slice(0, 16);
    };
    const out = []; let hdr = null;
    for (let i = 1; i < r.length; i++) {
      const x = r[i]; if (!x) continue;
      if (c.id >= 0 ? S(x[c.id]) : S(x[c.ref])) hdr = x;
      const g = (k) => (S(x[c[k]]) !== '' ? x[c[k]] : hdr ? hdr[c[k]] : '');
      const st = S(g('st')), prod = S(x[c.prod]);
      if (!prod) continue;
      let kode = '', nama = '';
      const mk = prod.match(/^\[\s*([^\]]+?)\s*\]\s*(.*)$/);
      if (mk) { kode = mk[1]; nama = mk[2]; } else { const m2 = prod.match(/\/\s*(\w+):/); kode = m2 ? m2[1] : ''; }
      if (!kode) continue;
      const tgl = toDT(g('date'));
      out.push({ tanggal: st === 'Ready to Receive' ? '' : tgl, bulan: st === 'Ready to Receive' ? '' : tgl.slice(0, 7), noIn: S(g('ref')), po: S(g('po')), supplier: S(g('sup')), kode, nama,
        qty: N(x[c.qty]), sn: c.sn >= 0 ? S(x[c.sn]) : '', harga: N(x[c.price]), status: st });
    }
    return out;
  }
  async function upOdoo(file) {
    const msg = $('incMsg'); msg.className = 'check'; msg.textContent = 'Membaca file…';
    let rows;
    try { const buf = await file.arrayBuffer(); rows = parseOdoo(XLSX.read(buf, { type: 'array', cellDates: false })); }
    catch (e) { msg.className = 'check err'; msg.textContent = e.message; return; }
    msg.textContent = '';
    const rec = rows.filter((x) => x.status === 'Received'), rtr = rows.filter((x) => x.status === 'Ready to Receive');
    const by = new Map(); rec.forEach((x) => { const o = by.get(x.bulan) || { n: 0, v: 0 }; o.n++; o.v += x.qty * x.harga; by.set(x.bulan, o); });
    const ms = [...by.keys()].filter(Boolean).sort().reverse();
    const ok = ms.filter((m) => m >= I.cutoff), old = ms.filter((m) => m < I.cutoff);
    const have = new Map(); I.rows.filter((x) => x.src === 'Odoo').forEach((x) => { const o = have.get(x.m) || { n: 0, v: 0 }; o.n++; o.v += x.val; have.set(x.m, o); });
    openDialog({
      title: 'Upload export Odoo · Incoming', ok: 'Simpan ke Google Sheet', wide: true,
      body: `<p class="dlg-lead">File <b>${esc(file.name)}</b>: ${nf0.format(rec.length)} baris Received, ${nf0.format(rtr.length)} baris Ready to Receive${rows.length - rec.length - rtr.length ? `, ${rows.length - rec.length - rtr.length} baris status lain (dilewati)` : ''}.</p>
        <p class="hint">Bulan yang dipilih: semua baris Odoo bulan itu di Google Sheet diganti isi file ini. Baris Report dan Manual tidak disentuh.${old.length ? ` Bulan sebelum ${monLabel(I.cutoff)} (${old.map(monShort).join(', ')}) diabaikan — Jan–Jun 2026 memakai data report.` : ''}</p>
        <div class="table-wrap"><table class="po-table inv-t">${head([[''], ['Bulan'], ['Baris di file', 'num'], ['Value di file', 'num'], ['Odoo tersimpan sekarang', 'num']])}<tbody>
        ${ok.map((m) => { const a = by.get(m), b = have.get(m); return `<tr><td><input type="checkbox" name="m_${m}" checked></td><td>${monLabel(m)}</td><td class="num">${nf0.format(a.n)}</td><td class="num">${fRp(a.v)}</td><td class="num">${b ? `${nf0.format(b.n)} baris · ${fRp(b.v)}` : '–'}</td></tr>`; }).join('') || '<tr class="empty"><td colspan="5">Tidak ada bulan ≥ cutoff di file.</td></tr>'}
        </tbody></table></div>
        <label class="tb-check"><input type="checkbox" name="rtr" checked> Ganti daftar Ready to Receive (karantina) dengan isi file ini (${rtr.length} baris)</label>`,
      onSubmit: async (fd) => {
        const months = ok.filter((m) => fd['m_' + m]);
        if (!months.length && !fd.rtr) throw new Error('Pilih minimal satu bulan atau daftar karantina.');
        const send = rows.filter((x) => (x.status === 'Received' && months.includes(x.bulan)) || (x.status === 'Ready to Receive' && fd.rtr));
        const d = await api('replaceOdoo', { months, rows: send, replaceRtr: !!fd.rtr, file: file.name });
        applyData(d); render();
        return `Tersimpan: ${months.length} bulan diperbarui${fd.rtr ? ', daftar karantina diganti' : ''}.`;
      },
    });
  }

  /* ---------- Manual ---------- */
  function manualDialog(id) {
    const x = id ? I.rows.find((r) => r.id === id) : null;
    const opt = (v, t, cur) => `<option value="${v}"${v === cur ? ' selected' : ''}>${t}</option>`;
    openDialog({
      title: x ? `Ubah incoming manual ${x.id}` : 'Tambah incoming manual', ok: 'Simpan', wide: true,
      body: `<p class="dlg-lead">Untuk penerimaan yang tidak ada di export Odoo, mis. WIP Mizzu dari maklon.</p>
        <div class="inc-form">
          <label class="field"><span>Tanggal</span><input type="date" name="tanggal" value="${esc(x ? x.tgl.slice(0, 10) : todayStr())}" required></label>
          <label class="field"><span>Kelompok</span><select name="kelompok">${opt('BEAUTY', 'Beauty', x ? x.kel : 'BEAUTY')}${opt('PC', 'Personal Care', x ? x.kel : '')}</select></label>
          <label class="field"><span>Kode</span><input type="text" name="kode" id="incMKode" value="${esc(x ? x.kode : '')}" required></label>
          <label class="field inc-wide"><span>Nama</span><input type="text" name="nama" id="incMNama" value="${esc(x ? x.nama : '')}"></label>
          <label class="field"><span>Qty</span><input type="number" step="any" name="qty" value="${x ? x.qty : ''}" required></label>
          <label class="field"><span>UoM</span><input type="text" name="uom" id="incMUom" value="${esc(x ? x.uom : '')}"></label>
          <label class="field"><span>Harga satuan (Rp)</span><input type="number" step="any" name="harga" value="${x ? x.harga : ''}"></label>
          <label class="field"><span>No PO</span><input type="text" name="po" value="${esc(x ? x.po : '')}"></label>
          <label class="field inc-wide"><span>Supplier</span><input type="text" name="supplier" value="${esc(x ? x.sup : '')}"></label>
          <label class="field"><span>Serial number</span><input type="text" name="sn" value="${esc(x ? x.sn : '')}"></label>
          <label class="field inc-wide"><span>Catatan</span><input type="text" name="catatan" value="${esc(x ? x.cat : '')}"></label>
        </div>`,
      onSubmit: async (fd) => {
        const d = await api('saveManual', { id: x ? x.id : '', row: { tanggal: fd.tanggal, kelompok: fd.kelompok, kode: S(fd.kode), nama: S(fd.nama), qty: N(fd.qty), uom: S(fd.uom), harga: N(fd.harga), po: S(fd.po), supplier: S(fd.supplier), sn: S(fd.sn), catatan: S(fd.catatan) } });
        applyData(d); render();
        return 'Tersimpan.';
      },
    });
    const k = $('incMKode');
    if (k) k.addEventListener('change', () => { const m = I.mat.get(S(k.value)); if (m) { if (!S($('incMNama').value)) $('incMNama').value = m.nama; if (!S($('incMUom').value)) $('incMUom').value = m.uom; } });
  }
  function deleteManual(id) {
    const x = I.rows.find((r) => r.id === id); if (!x) return;
    openDialog({
      title: 'Hapus incoming manual', ok: 'Hapus', danger: true,
      body: `<p class="dlg-lead">Hapus <b>${esc(x.kode)} ${esc(x.nama)}</b> · ${fQ(x.qty)} ${esc(x.uom)} · ${esc(fDate(x.tgl.slice(0, 10)))} (${fRp(x.val)}) dari Google Sheet? Tidak bisa dibatalkan dari website.</p>`,
      onSubmit: async () => { const d = await api('deleteManual', { id }); applyData(d); render(); return 'Dihapus.'; },
    });
  }

  /* ---------- Unduh ---------- */
  function exportXls() {
    const L = pick(I.rows, I.tab === 'grafik' ? '' : I.m);
    const wb = XLSX.utils.book_new();
    const add = (name, aoa) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
    add('INCOMING', [['TANGGAL', 'NO IN', 'NO PO', 'SUPPLIER', 'KODE', 'NAMA', 'QTY', 'UOM', 'SERIAL NUMBER', 'HARGA', 'VALUE', 'GOLONGAN', 'KATEGORI', 'KELOMPOK', 'SUMBER']]
      .concat(L.map((x) => [x.tgl, x.noIn, x.po, x.sup, x.kode, x.nama, x.qty, x.uom, x.sn, x.harga, x.val, x.gol, x.kat, KEL[x.kel] || '', x.src])));
    const t = tot(L);
    add('PER MATERIAL', [['KODE', 'NAMA', 'GOLONGAN', 'KATEGORI', 'QTY', 'UOM', 'VALUE', 'RASIO', 'ALASAN']].concat([...sumBy(L, (x) => x.kode)].sort((a, b) => b[1].val - a[1].val)
      .map(([k, o]) => [k, o.rows[0].nama, o.rows[0].gol, o.rows[0].kat, o.qty, o.rows[0].uom, o.val, t ? o.val / t : '', I.reason.get(`${I.m}|${I.kel || 'ALL'}|${k}`) || ''])));
    const D = grafikData();
    add('PER BULAN', [['BULAN', 'INCOMING', 'RM', 'PM', 'FORECAST', 'SO', 'DO', '% THD FCT', '% THD SO', '% THD DO']].concat(D.map((x) => [x.m, x.inc, x.rm, x.pm, x.fct, x.so, x.do, ratio(x.inc, x.fct) || '', ratio(x.inc, x.so) || '', ratio(x.inc, x.do) || ''])));
    XLSX.writeFile(wb, `Incoming_RMPM_${I.kel || 'Semua'}_${I.tab === 'grafik' ? I.year : I.m}.xlsx`);
  }
  async function toJpg(id) {
    const card = $(id); if (!card) return;
    const svg = card.querySelector('svg'); if (!svg) return;
    const title = card.querySelector('h3').textContent, leg = [...card.querySelectorAll('.inc-leg span')].map((s) => [s.querySelector('i').style.background, s.textContent]);
    const vb = svg.viewBox.baseVal, sc = 2, W = vb.width, H = vb.height + 70;
    const clone = svg.cloneNode(true);
    clone.querySelectorAll('.inc-grid-l').forEach((l) => l.setAttribute('stroke', '#e3e8e5'));
    clone.querySelectorAll('.inc-ax').forEach((t) => { t.setAttribute('fill', '#55605b'); t.setAttribute('font-size', '12'); t.setAttribute('font-family', 'Arial'); });
    clone.querySelectorAll('.inc-lbl').forEach((t) => { if (!t.getAttribute('fill')) t.setAttribute('fill', '#1d2724'); t.setAttribute('font-size', '11'); t.setAttribute('font-family', 'Arial'); t.setAttribute('font-weight', '600'); });
    clone.setAttribute('width', vb.width); clone.setAttribute('height', vb.height);
    const src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone));
    const img = new Image(); img.src = src; await new Promise((r, j) => { img.onload = r; img.onerror = j; });
    const cv = document.createElement('canvas'); cv.width = W * sc; cv.height = H * sc;
    const g = cv.getContext('2d'); g.scale(sc, sc); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#0f4d2c'; g.font = 'bold 18px Arial'; g.fillText(title, 14, 28);
    let lx = 14; g.font = '13px Arial'; leg.forEach(([c, t]) => { g.fillStyle = c; g.fillRect(lx, 42, 12, 12); g.fillStyle = '#333'; g.fillText(t, lx + 17, 53); lx += g.measureText(t).width + 40; });
    g.drawImage(img, 0, 66, vb.width, vb.height);
    const a = document.createElement('a'); a.href = cv.toDataURL('image/jpeg', 0.95); a.download = `${title.replace(/[^\w ]+/g, '').replace(/\s+/g, '_')}.jpg`; a.click();
  }

  /* ---------- Event ---------- */
  function bind() {
    if (bind.done || !$('view-rep-inc')) return; bind.done = true;
    $('incMonth').addEventListener('change', () => { I.m = $('incMonth').value; render(); });
    $('incKel').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b) return; I.kel = b.dataset.v; savePref(); render(); });
    $('incTab').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b) return; I.tab = b.dataset.v; savePref(); render(); });
    const step = (k) => { const ms = monthsAll(), i = ms.indexOf(I.m) + k; if (ms[i]) { I.m = ms[i]; render(); } };
    $('incPrev').addEventListener('click', () => step(-1)); $('incNext').addEventListener('click', () => step(1));
    let qt;
    $('view-rep-inc').addEventListener('input', (e) => { if (e.target.id !== 'incQ') return; clearTimeout(qt); qt = setTimeout(() => { I.q = S(e.target.value); const pos = e.target.selectionStart; render(); const q = $('incQ'); if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch (er) { /* abaikan */ } } }, 250); });
    $('view-rep-inc').addEventListener('toggle', (e) => { if (e.target.classList && e.target.classList.contains('inc-all')) I.openAll = e.target.open; }, true);
    $('incUp').addEventListener('change', async () => { const f = $('incUp').files[0]; $('incUp').value = ''; if (f) upOdoo(f); });
    $('incAdd').addEventListener('click', () => manualDialog(''));
    $('incXls').addEventListener('click', exportXls);
    $('view-rep-inc').addEventListener('click', (e) => {
      const t = e.target.closest('[data-inc-tab]'); if (t) { I.tab = t.dataset.incTab; savePref(); render(); return; }
      const ed = e.target.closest('[data-inc-edit]'); if (ed) { manualDialog(ed.dataset.incEdit); return; }
      const dl = e.target.closest('[data-inc-del]'); if (dl) { deleteManual(dl.dataset.incDel); return; }
      const re = e.target.closest('[data-inc-redit]'); if (re) { const k = re.dataset.incRedit, box = document.querySelector(`[data-inc-rbox="${CSS.escape(k)}"]`); box.innerHTML = `<input type="text" class="inc-reason" data-inc-reason="${esc(k)}" value="${esc(I.reason.get(`${I.m}|${I.kel || 'ALL'}|${k}`) || '')}" placeholder="Alasan incoming besar… (Enter untuk simpan)">`; box.querySelector('input').focus(); return; }
      const j = e.target.closest('[data-inc-jpg]'); if (j) { toJpg(j.dataset.incJpg).catch((er) => toast('Gagal membuat JPG: ' + er.message)); }
    });
    $('view-rep-inc').addEventListener('change', async (e) => {
      if (e.target.id === 'incYear') { I.year = e.target.value; render(); return; }
      if (e.target.id === 'incSrc') { I.src = e.target.value; render(); return; }
      const r = e.target.closest('[data-inc-reason]'); if (!r) return;
      const kode = r.dataset.incReason, val = S(r.value);
      r.disabled = true;
      try { const d = await api('saveReason', { bulan: I.m, kelompok: I.kel || 'ALL', kode, alasan: val }); I.reason = new Map((d.reason || []).map((x) => [`${x[0]}|${x[1]}|${x[2]}`, x[3]])); toast('Alasan tersimpan.'); render(); return; }
      catch (er) { toast(er.message); }
      r.disabled = false;
    });
    $('view-rep-inc').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.closest('[data-inc-reason]')) e.target.blur(); });
  }

  window.INC = {
    enter() { bind(); render(); if (!I.loaded && !I.loading) load(); else if (I.loaded && !I.csl.pc && !I.csl.err) loadCsl(); },
    reload() { I.csl = { pc: null, beauty: null, err: '' }; return load(true); },
    sheetUrl() { return I.sheetUrl || CFG.INC_SHEET_URL || ''; },
  };
  if (/^#\/rep\/incoming/.test(location.hash)) window.INC.enter();
})();
