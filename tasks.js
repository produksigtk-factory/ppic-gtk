/* Beranda — daftar tugas dari anomali semua project.
 * Tiap modul mendaftarkan fungsi di window.PPIC_TASKS (po, mrp, csl) yang mengembalikan daftar tugas
 * (null = datanya belum termuat). Tugas bisa ditandai "sudah ditangani" (tersimpan di tab TUGAS,
 * Google Sheet CSL PPIC GTK, terlihat semua pemakai); muncul lagi bila isi anomalinya berubah.
 */
(function () {
  'use strict';
  const CFG = window.PPIC_CONFIG || {};
  const UI = window.PPIC_UI || {};
  const $ = (id) => document.getElementById(id);
  const esc = UI.esc || ((s) => String(s ?? ''));
  const nf0 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
  const LEVELS = [['urgent', 'Mendesak', 'Kerjakan hari ini'], ['check', 'Perlu dicek', 'Rapikan data / pastikan'], ['info', 'Info', 'Untuk diketahui']];
  const PROJ = ['PO', 'CSL', 'MRP', 'Database'];
  const SOURCES = [['po', 'Purchase Order'], ['csl', 'CSL'], ['mrp', 'MRP']];
  const S = { proj: '', handled: new Map(), handledLoaded: false, handledErr: '', open: new Set(), last: [], t0: Date.now(), readyAt: 0, timer: null };
  const READY_SRC = [['po', 'Purchase Order'], ['csl', 'CSL'], ['mrp', 'MRP'], ['tugas', 'Status tugas']];

  // Tanda isi anomali: berubah bila daftar item berubah → tugas yang sudah ditangani muncul lagi
  function sig(keys) {
    let h = 5381;
    const s = (keys || []).slice().sort().join('|');
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + '.' + (keys || []).length;
  }
  async function loadHandled() {
    if (!CFG.CSL_SCRIPT_URL) { S.handledErr = 'Apps Script CSL belum dipasang'; S.handledLoaded = true; refresh(); return; }
    // Permintaan kecil ini kadang menggantung di Google: batasi 20 detik lalu coba lagi (maks. 3 kali)
    for (let attempt = 1; attempt <= 3; attempt++) {
      const ctl = window.AbortController ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), 20000) : 0;
      try {
        const d = await (await fetch(CFG.CSL_SCRIPT_URL + '?action=tasks&try=' + attempt, ctl ? { signal: ctl.signal } : {})).json();
        clearTimeout(timer);
        if (d.ok && d.tasks) { S.handled = new Map(d.tasks.map((r) => [r[0], { sig: r[1], note: r[2], time: r[3], title: r[4] }])); S.handledErr = ''; }
        else S.handledErr = 'Apps Script CSL belum versi terbaru';
        break;
      } catch (e) {
        clearTimeout(timer);
        S.handledErr = 'tidak terbaca';
        if (attempt < 3) await new Promise((r) => setTimeout(r, 1500));
      }
    }
    S.handledLoaded = true;
    refresh();
  }
  async function save(payload) {
    const res = await fetch(CFG.CSL_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(Object.assign({ action: 'saveTask' }, payload)) });
    const d = await res.json();
    if (!d.ok) throw new Error(/Aksi tidak dikenal/.test(d.error || '') ? 'Apps Script CSL belum versi terbaru (perlu Code_CSL.gs terbaru).' : d.error || 'Gagal menyimpan.');
    S.handled = new Map(d.tasks.map((r) => [r[0], { sig: r[1], note: r[2], time: r[3], title: r[4] }]));
  }

  function collect() {
    const P = window.PPIC_TASKS || {};
    const all = [], pending = [];
    SOURCES.forEach(([k, label]) => {
      const f = P[k];
      let r = null;
      try { r = f ? f() : null; } catch (e) { console.error(e); r = []; }
      if (r === null) pending.push(label); else r.forEach((t) => { t.sig = sig(t.keys); all.push(t); });
    });
    return { all, pending };
  }
  // Penanda kesiapan: tiap sumber data memuat → siap / gagal; semua selesai = website siap dipakai
  function paintReady() {
    const el = $('readyBar'); if (!el) return;
    const ST = window.PPIC_STATUS || {};
    const list = READY_SRC.map(([k, label]) => {
      let st = k === 'tugas' ? (S.handledLoaded ? (S.handledErr ? S.handledErr : 'ready') : 'loading') : (ST[k] ? ST[k]() : 'loading');
      if (k !== 'tugas' && !CFG[{ po: 'APPS_SCRIPT_URL', csl: 'CSL_SCRIPT_URL', mrp: 'MRP_SCRIPT_URL' }[k]]) st = 'belum dipasang';
      return { k, label, st };
    });
    const loading = list.filter((x) => x.st === 'loading').length;
    const errs = list.filter((x) => x.st !== 'loading' && x.st !== 'ready');
    if (!loading && !S.readyAt) S.readyAt = Date.now();
    const secs = Math.round(((S.readyAt || Date.now()) - S.t0) / 1000);
    const state = loading ? 'loading' : errs.length ? 'warn' : 'ready';
    const title = loading ? `Menyiapkan data… ${list.length - loading} dari ${list.length} selesai (${secs} detik)`
      : errs.length ? `Website bisa dipakai, tetapi ${errs.map((x) => x.label).join(', ')} belum termuat`
      : `Website siap dipakai — semua data termuat dalam ${secs} detik`;
    const sub = loading ? 'Tunggu sampai semua tanda menjadi centang hijau; daftar tugas di bawah masih bisa bertambah.'
      : errs.length ? errs.map((x) => `${x.label}: ${x.st}`).join(' · ') + '. Tekan Muat ulang data di halaman terkait atau muat ulang browser.'
      : 'Daftar tugas di bawah sudah lengkap.';
    el.className = `ready-bar is-${state}`;
    el.innerHTML = `<span class="ready-ic" aria-hidden="true"></span><div class="ready-txt"><b>${esc(title)}</b><span>${esc(sub)}</span></div>
      <div class="ready-src">${list.map((x) => `<span class="ready-chip is-${x.st === 'ready' ? 'ok' : x.st === 'loading' ? 'load' : 'err'}" title="${esc(x.st === 'ready' ? 'Siap' : x.st === 'loading' ? 'Memuat…' : x.st)}">${esc(x.label)}</span>`).join('')}</div>`;
    if (loading && !S.timer) S.timer = setInterval(paintReady, 1000);
    if (!loading && S.timer) { clearInterval(S.timer); S.timer = null; }
    const badge = $('readyDot');
    if (badge) { badge.hidden = !loading; }
  }
  function refresh() {
    paintReady();
    const box = $('taskBody'); if (!box) return;
    const { all, pending } = collect();
    S.last = all;
    const isHandled = (t) => { const h = S.handled.get(t.id); return h && h.sig === t.sig; };
    const reopened = (t) => { const h = S.handled.get(t.id); return h && h.sig !== t.sig; };
    const active = all.filter((t) => !isHandled(t)), done = all.filter(isHandled);
    const byProj = (t) => !S.proj || t.proj === S.proj;
    // Ringkasan
    const cnt = (lv) => active.filter((t) => t.level === lv && byProj(t)).length;
    $('taskSum').innerHTML = LEVELS.map(([lv, lbl]) => `<div class="tk-sum is-${lv}"><b>${cnt(lv)}</b><span>${lbl}</span></div>`).join('')
      + `<div class="tk-sum is-done"><b>${done.filter(byProj).length}</b><span>Sudah ditangani</span></div>`;
    $('taskProj').innerHTML = ['', ...PROJ].map((p) => {
      const n = active.filter((t) => !p || t.proj === p).length;
      if (p && !n && !all.some((t) => t.proj === p)) return '';
      return `<button class="chg-type${S.proj === p ? ' is-on' : ''}" data-p="${p}">${p || 'Semua project'} <b>${n}</b></button>`;
    }).join('');
    $('taskSum').classList.toggle('is-wait', !!pending.length);
    $('taskPending').hidden = !pending.length;
    $('taskPending').textContent = pending.length ? `Masih memuat data ${pending.join(', ')}… daftar tugas akan bertambah.` : '';
    const card = (t, handled) => {
      const n = t.items ? t.items.length : 0, open = S.open.has(t.id);
      const items = n ? `<ul class="tk-items">${t.items.slice(0, open ? 60 : 4).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>${n > 4 ? `<button class="btn-link tk-more" data-more="${esc(t.id)}">${open ? 'Ringkas' : `Lihat semua ${nf0.format(n)}${n > 60 ? ' (60 pertama)' : ''}`}</button>` : ''}` : '';
      const h = S.handled.get(t.id);
      const re = !handled && reopened(t) ? `<p class="tk-re">Pernah ditandai ditangani ${esc(String(h.time).slice(0, 16))}${h.note ? ` — "${esc(h.note)}"` : ''}, muncul lagi karena datanya berubah.</p>` : '';
      return `<article class="tk-card is-${t.level}${handled ? ' is-done' : ''}">
        <div class="tk-main">
          <div class="tk-top"><span class="tk-proj p-${t.proj.toLowerCase()}">${esc(t.proj)}</span>${t.count ? `<span class="tk-count">${nf0.format(t.count)} ${esc(t.unit || '')}</span>` : ''}</div>
          <h3 class="tk-title">${esc(t.title)}</h3>
          <p class="tk-desc">${esc(t.desc || '')}</p>${re}
          ${handled ? `<p class="tk-note">Ditandai ${esc(String(h.time).slice(0, 16))}${h.note ? ` — "${esc(h.note)}"` : ''}</p>` : items}
        </div>
        <div class="tk-act">
          ${t.link ? `<a class="btn btn-sm" href="${t.link}">${esc(t.linkLabel || 'Buka')}</a>` : ''}
          ${t.noHandle || !CFG.CSL_SCRIPT_URL ? '' : handled ? `<button class="btn btn-ghost btn-sm" data-reopen="${esc(t.id)}">Buka lagi</button>` : `<button class="btn btn-ghost btn-sm" data-handle="${esc(t.id)}">Tandai ditangani</button>`}
        </div></article>`;
    };
    const order = (a, b) => PROJ.indexOf(a.proj) - PROJ.indexOf(b.proj);
    let html = LEVELS.map(([lv, lbl, sub]) => {
      const ts = active.filter((t) => t.level === lv && byProj(t)).sort(order);
      if (!ts.length) return '';
      return `<section class="tk-sec"><h2 class="tk-h is-${lv}">${lbl} <span>${sub}</span></h2>${ts.map((t) => card(t, false)).join('')}</section>`;
    }).join('');
    if (!html) html = pending.length ? '' : '<div class="tk-empty"><b>Tidak ada tugas.</b> Semua data terkini dan tidak ada anomali.</div>';
    const d = done.filter(byProj);
    if (d.length) html += `<details class="tk-donebox"><summary>Sudah ditangani (${d.length})</summary>${d.map((t) => card(t, true)).join('')}</details>`;
    box.innerHTML = html;
    const badge = $('homeBadge');
    if (badge) { const u = active.filter((t) => t.level === 'urgent').length; badge.hidden = !u; badge.textContent = u; }
  }
  function handle(id) {
    const t = S.last.find((x) => x.id === id); if (!t) return;
    UI.openDialog({
      title: 'Tandai sudah ditangani', ok: 'Simpan',
      body: `<p class="dlg-lead"><b>${esc(t.title)}</b><br>Tugas disembunyikan untuk semua pemakai sampai isi anomalinya berubah (mis. ada SO/PO baru yang masuk daftar).</p>
        <div class="form-grid"><label class="field span-2"><span>Catatan (opsional)</span><textarea name="note" rows="3" placeholder="mis. sudah konfirmasi ke supplier, kirim tgl 10"></textarea></label></div>`,
      onSubmit: async (fd) => { await save({ id, sig: t.sig, note: String(fd.note || '').trim(), title: t.title }); refresh(); return 'Tugas ditandai sudah ditangani.'; },
    });
  }
  document.addEventListener('click', async (e) => {
    const p = e.target.closest('#taskProj [data-p]');
    if (p) { S.proj = p.dataset.p; refresh(); return; }
    const m = e.target.closest('[data-more]');
    if (m) { const id = m.dataset.more; if (S.open.has(id)) S.open.delete(id); else S.open.add(id); refresh(); return; }
    const h = e.target.closest('[data-handle]');
    if (h) { handle(h.dataset.handle); return; }
    const r = e.target.closest('[data-reopen]');
    if (r) {
      r.disabled = true;
      try { await save({ id: r.dataset.reopen, clear: true }); refresh(); if (UI.toast) UI.toast('Tugas dibuka lagi.'); } catch (err) { if (UI.toast) UI.toast(err.message); r.disabled = false; }
    }
  });
  window.TASKS = { refresh };
  refresh();
  loadHandled();
})();
