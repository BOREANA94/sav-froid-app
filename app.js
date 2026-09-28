// SAV Froid – suivi des bouteilles de gaz frigorigène
(function () {
  'use strict';

  const cfg = window.SAV_CONFIG || {};
  const $ = (id) => document.getElementById(id);

  if (!cfg.SUPABASE_KEY || cfg.SUPABASE_KEY.startsWith('COLLER_ICI')) {
    $('config-error').classList.remove('hidden');
    return;
  }

  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY);

  const STATUS = {
    en_stock: 'Au stock',
    chez_technicien: 'Dans un camion',
    vide: 'Vide',
    maintenance: 'Maintenance',
  };
  const ACTION = { checkout: 'Prise', checkin: 'Retour au stock' };
  const BOTTLE_SELECT = '*, holder:profiles!bottles_current_technician_id_fkey(id, full_name)';

  let me = null;          // { id, full_name, role }
  let scanner = null;     // instance Html5Qrcode
  let busy = false;
  let pendingBottle = new URLSearchParams(location.search).get('b');

  // ---------- utilitaires ----------
  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function badge(status) {
    return `<span class="badge ${esc(status)}">${esc(STATUS[status] || status)}</span>`;
  }
  function kg(v) {
    return v == null ? '–' : `${String(v).replace('.', ',')} kg`;
  }
  function fmtDate(v) {
    return v ? new Date(v).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '';
  }
  function showMsg(el, text) {
    el.textContent = text || '';
    el.classList.toggle('hidden', !text);
  }
  let toastTimer;
  function toast(text, isError) {
    const t = $('toast');
    t.textContent = text;
    t.className = isError ? 'error' : '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
  }
  function errText(error) {
    return (error && (error.message || error.error_description)) || 'Erreur inattendue.';
  }
  // Accepte un n° brut (BTL-0001) ou l'URL encodée dans le QR (…?b=BTL-0001)
  function parseBottleId(text) {
    let raw = String(text || '').trim();
    try {
      const u = new URL(raw);
      raw = u.searchParams.get('b') || raw;
    } catch (_) { /* pas une URL */ }
    raw = raw.toUpperCase();
    return /^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(raw) ? raw : null;
  }

  // ---------- connexion ----------
  async function loadMe(user) {
    const { data, error } = await sb.from('profiles').select('id, full_name, role').eq('id', user.id).maybeSingle();
    if (error) throw error;
    return data || { id: user.id, full_name: user.email, role: 'technicien' };
  }

  async function onSession(session) {
    if (!session) {
      me = null;
      $('view-app').classList.add('hidden');
      $('view-login').classList.remove('hidden');
      $('logout').classList.add('hidden');
      $('who').textContent = '';
      return;
    }
    try {
      me = await loadMe(session.user);
    } catch (e) {
      showMsg($('login-error'), errText(e));
      return;
    }
    $('who').textContent = me.full_name || session.user.email;
    $('logout').classList.remove('hidden');
    $('view-login').classList.add('hidden');
    $('view-app').classList.remove('hidden');
    document.querySelectorAll('.admin-only').forEach((el) => el.classList.toggle('hidden', me.role !== 'admin'));

    if (pendingBottle) {
      const id = parseBottleId(pendingBottle);
      pendingBottle = null;
      history.replaceState(null, '', location.pathname);
      switchTab('scan');
      if (id) showBottle(id);
    }
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showMsg($('login-error'), '');
    const { error } = await sb.auth.signInWithPassword({
      email: $('email').value.trim(),
      password: $('password').value,
    });
    if (error) {
      showMsg($('login-error'), error.message === 'Invalid login credentials'
        ? 'Email ou mot de passe incorrect.' : errText(error));
    }
  });

  $('logout').addEventListener('click', async () => {
    await stopScanner();
    await sb.auth.signOut();
  });

  // ---------- onglets ----------
  const loaders = {
    camion: loadCamion,
    stock: loadStock,
    bouteilles: loadLabelsTable,
    historique: loadHistory,
    equipe: loadTeam,
  };
  function switchTab(name) {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== `tab-${name}`));
    if (name !== 'scan') stopScanner();
    if (loaders[name]) loaders[name]();
  }
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) switchTab(b.dataset.tab);
  });

  // ---------- scanner ----------
  async function startScanner() {
    showMsg($('scan-error'), '');
    $('scan-result').innerHTML = '';
    if (!scanner) scanner = new Html5Qrcode('reader');
    try {
      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: (w, h) => { const s = Math.floor(Math.min(w, h) * 0.7); return { width: s, height: s }; } },
        onScan,
        () => {}
      );
      $('scan-start').classList.add('hidden');
      $('scan-stop').classList.remove('hidden');
    } catch (e) {
      showMsg($('scan-error'), "Impossible d'ouvrir la caméra. Autorise l'accès à la caméra pour ce site, ou saisis le numéro à la main.");
    }
  }
  async function stopScanner() {
    if (scanner && scanner.isScanning) {
      try { await scanner.stop(); } catch (_) { /* déjà arrêté */ }
    }
    $('scan-start').classList.remove('hidden');
    $('scan-stop').classList.add('hidden');
  }
  async function onScan(text) {
    const id = parseBottleId(text);
    await stopScanner();
    if (navigator.vibrate) navigator.vibrate(80);
    if (!id) {
      showMsg($('scan-error'), `QR code non reconnu : ${text}`);
      return;
    }
    showBottle(id);
  }
  $('scan-start').addEventListener('click', startScanner);
  $('scan-stop').addEventListener('click', stopScanner);
  $('manual-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = parseBottleId($('manual-id').value);
    if (!id) { showMsg($('scan-error'), 'Numéro de bouteille invalide.'); return; }
    showMsg($('scan-error'), '');
    $('manual-id').value = '';
    stopScanner();
    showBottle(id);
  });

  async function showBottle(id) {
    const box = $('scan-result');
    box.innerHTML = '<div class="card muted">Recherche…</div>';
    const { data: b, error } = await sb.from('bottles').select(BOTTLE_SELECT).eq('id', id).maybeSingle();
    if (error) { box.innerHTML = `<div class="card msg error">${esc(errText(error))}</div>`; return; }
    if (!b) { box.innerHTML = `<div class="card msg error">La bouteille <b>${esc(id)}</b> n'existe pas.</div>`; return; }

    const mine = b.current_technician_id === me.id;
    const holder = b.holder ? b.holder.full_name : null;
    let actions = '';
    if (mine) {
      actions = `<button class="btn block secondary" data-act="checkin">↩︎ Je la rends au stock</button>`;
    } else {
      const label = holder ? `Je la prends (actuellement chez ${esc(holder)})` : 'Je la prends dans mon camion';
      actions = `<button class="btn block ok" data-act="checkout">✔︎ ${label}</button>`;
      if (holder && me.role === 'admin') {
        actions += `<button class="btn block secondary" data-act="checkin">↩︎ Remettre au stock</button>`;
      }
    }

    box.innerHTML = `
      <div class="bottle-card">
        <div class="bid">${esc(b.id)}</div>
        <dl>
          <dt>Gaz</dt><dd>${esc(b.gas_type || '–')}</dd>
          <dt>Capacité</dt><dd>${esc(kg(b.capacity_kg))}</dd>
          <dt>Statut</dt><dd>${badge(b.status)}</dd>
          <dt>Chez</dt><dd>${mine ? 'Moi' : esc(holder || '–')}</dd>
        </dl>
        <label for="scan-note">Note (facultatif)</label>
        <input id="scan-note" placeholder="ex : chantier Dupont">
        <div class="stack" style="margin-top:12px">${actions}</div>
      </div>`;
    box.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => doScan(b.id, btn.dataset.act, $('scan-note').value));
    });
  }

  async function doScan(id, action, note) {
    if (busy) return;
    busy = true;
    try {
      const { error } = await sb.rpc('scan_bottle', { p_bottle_id: id, p_action: action, p_note: note || null });
      if (error) { toast(errText(error), true); return; }
      toast(action === 'checkout' ? `${id} ajoutée à ton camion` : `${id} remise au stock`);
      $('scan-result').innerHTML = '';
      if (!$('tab-camion').classList.contains('hidden')) loadCamion();
    } finally {
      busy = false;
    }
  }

  // ---------- mon camion ----------
  async function loadCamion() {
    const ul = $('camion-list');
    ul.innerHTML = '<li class="muted">Chargement…</li>';
    const { data, error } = await sb.from('bottles').select('*').eq('current_technician_id', me.id).order('id');
    if (error) { ul.innerHTML = `<li class="msg error">${esc(errText(error))}</li>`; return; }
    if (!data.length) { ul.innerHTML = '<li class="empty">Aucune bouteille dans ton camion.</li>'; return; }
    ul.innerHTML = data.map((b) => `
      <li>
        <div class="grow">
          <div class="title">${esc(b.id)}</div>
          <div class="sub">${esc(b.gas_type || '–')} · ${esc(kg(b.capacity_kg))}</div>
        </div>
        <button class="btn small secondary" data-id="${esc(b.id)}">Rendre</button>
      </li>`).join('');
    ul.querySelectorAll('button[data-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Rendre ${btn.dataset.id} au stock ?`)) return;
        await doScan(btn.dataset.id, 'checkin', null); // recharge la liste
      });
    });
  }

  // ---------- stock (admin) ----------
  let stockRows = [];
  async function loadStock() {
    $('stock-table').innerHTML = '<tr><td colspan="5" class="muted">Chargement…</td></tr>';
    const { data, error } = await sb.from('bottles').select(BOTTLE_SELECT).order('id');
    if (error) { $('stock-table').innerHTML = `<tr><td colspan="5" class="msg error">${esc(errText(error))}</td></tr>`; return; }
    stockRows = data;

    const count = (s) => data.filter((b) => b.status === s).length;
    $('stock-stats').innerHTML = [
      ['Total', data.length],
      ['Au stock', count('en_stock')],
      ['Dans les camions', count('chez_technicien')],
      ['Vides', count('vide')],
      ['Maintenance', count('maintenance')],
    ].map(([l, n]) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');

    const byTech = {};
    data.filter((b) => b.holder).forEach((b) => {
      (byTech[b.holder.full_name] = byTech[b.holder.full_name] || []).push(b);
    });
    const names = Object.keys(byTech).sort((a, b) => a.localeCompare(b, 'fr'));
    $('stock-by-tech').innerHTML = names.length
      ? `<ul class="list">${names.map((n) => `
          <li><div class="grow">
            <div class="title">${esc(n)} — ${byTech[n].length} bouteille${byTech[n].length > 1 ? 's' : ''}</div>
            <div class="sub">${byTech[n].map((b) => `${esc(b.id)} (${esc(b.gas_type || '?')}, ${esc(kg(b.capacity_kg))})`).join(' · ')}</div>
          </div></li>`).join('')}</ul>`
      : '<p class="empty">Aucune bouteille sortie.</p>';
    renderStockTable();
  }
  function renderStockTable() {
    const q = $('stock-search').value.trim().toLowerCase();
    const f = $('stock-filter').value;
    const rows = stockRows.filter((b) => (!f || b.status === f) && (!q || [
      b.id, b.gas_type, b.holder && b.holder.full_name,
    ].some((v) => String(v || '').toLowerCase().includes(q))));
    $('stock-table').innerHTML = rows.length
      ? rows.map((b) => `<tr>
          <td><b>${esc(b.id)}</b></td><td>${esc(b.gas_type || '–')}</td><td>${esc(kg(b.capacity_kg))}</td>
          <td>${badge(b.status)}</td><td>${esc(b.holder ? b.holder.full_name : '–')}</td></tr>`).join('')
      : '<tr><td colspan="5" class="empty">Aucune bouteille.</td></tr>';
  }
  $('stock-search').addEventListener('input', renderStockTable);
  $('stock-filter').addEventListener('change', renderStockTable);

  // ---------- création + étiquettes (admin) ----------
  function openLabels(ids) {
    if (!ids.length) { toast('Aucune bouteille sélectionnée.', true); return; }
    window.open(`etiquettes.html?ids=${encodeURIComponent(ids.join(','))}`, '_blank');
  }

  $('create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showMsg($('create-error'), '');
    const { data, error } = await sb.rpc('create_bottles', {
      p_count: parseInt($('c-count').value, 10),
      p_gas_type: $('c-gas').value,
      p_capacity_kg: parseFloat(String($('c-cap').value).replace(',', '.')),
    });
    if (error) { showMsg($('create-error'), errText(error)); return; }
    const ids = data.map((b) => b.id);
    $('create-result').innerHTML = `
      <div class="msg info">${ids.length} bouteille${ids.length > 1 ? 's créées' : ' créée'} : ${esc(ids.join(', '))}</div>
      <button class="btn" type="button" id="print-new">🖨️ Imprimer ces étiquettes</button>`;
    $('print-new').addEventListener('click', () => openLabels(ids));
    loadLabelsTable();
  });

  async function loadLabelsTable() {
    const tb = $('labels-table');
    tb.innerHTML = '<tr><td colspan="5" class="muted">Chargement…</td></tr>';
    const { data, error } = await sb.from('bottles').select('id, gas_type, capacity_kg, created_at').order('id');
    if (error) { tb.innerHTML = `<tr><td colspan="5" class="msg error">${esc(errText(error))}</td></tr>`; return; }
    tb.innerHTML = data.length
      ? data.map((b) => `<tr>
          <td><input type="checkbox" value="${esc(b.id)}" style="width:auto"></td>
          <td><b>${esc(b.id)}</b></td><td>${esc(b.gas_type || '–')}</td><td>${esc(kg(b.capacity_kg))}</td>
          <td>${esc(fmtDate(b.created_at))}</td></tr>`).join('')
      : '<tr><td colspan="5" class="empty">Aucune bouteille pour l\'instant.</td></tr>';
  }
  const labelChecks = () => [...document.querySelectorAll('#labels-table input[type=checkbox]')];
  $('labels-all').addEventListener('click', () => labelChecks().forEach((c) => { c.checked = true; }));
  $('labels-none').addEventListener('click', () => labelChecks().forEach((c) => { c.checked = false; }));
  $('labels-print').addEventListener('click', () => openLabels(labelChecks().filter((c) => c.checked).map((c) => c.value)));

  // ---------- historique (admin) ----------
  async function loadHistory() {
    const tb = $('history-table');
    tb.innerHTML = '<tr><td colspan="5" class="muted">Chargement…</td></tr>';
    const { data, error } = await sb.from('movements')
      .select('created_at, bottle_id, action, note, technician:profiles!movements_technician_profile_fkey(full_name)')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) { tb.innerHTML = `<tr><td colspan="5" class="msg error">${esc(errText(error))}</td></tr>`; return; }
    tb.innerHTML = data.length
      ? data.map((m) => `<tr>
          <td>${esc(fmtDate(m.created_at))}</td><td><b>${esc(m.bottle_id)}</b></td>
          <td>${esc(ACTION[m.action] || m.action)}</td><td>${esc(m.technician ? m.technician.full_name : '–')}</td>
          <td>${esc(m.note || '')}</td></tr>`).join('')
      : '<tr><td colspan="5" class="empty">Aucun mouvement.</td></tr>';
  }

  // ---------- équipe (admin) ----------
  async function loadTeam() {
    const tb = $('team-table');
    tb.innerHTML = '<tr><td colspan="3" class="muted">Chargement…</td></tr>';
    const { data, error } = await sb.from('profiles').select('id, full_name, role').order('full_name');
    if (error) { tb.innerHTML = `<tr><td colspan="3" class="msg error">${esc(errText(error))}</td></tr>`; return; }
    tb.innerHTML = data.map((p) => `<tr data-id="${esc(p.id)}">
        <td><input value="${esc(p.full_name || '')}" data-f="full_name"></td>
        <td><select data-f="role" ${p.id === me.id ? 'disabled' : ''}>
          <option value="technicien" ${p.role === 'technicien' ? 'selected' : ''}>Technicien</option>
          <option value="admin" ${p.role === 'admin' ? 'selected' : ''}>Admin</option>
        </select></td>
        <td><button class="btn small secondary" type="button">Enregistrer</button></td></tr>`).join('');
    tb.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const tr = btn.closest('tr');
        const patch = { full_name: tr.querySelector('[data-f=full_name]').value.trim() };
        const sel = tr.querySelector('[data-f=role]');
        if (!sel.disabled) patch.role = sel.value;
        const { error: err } = await sb.from('profiles').update(patch).eq('id', tr.dataset.id);
        toast(err ? errText(err) : 'Enregistré', !!err);
      });
    });
  }

  // ---------- démarrage ----------
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'SIGNED_OUT') {
      // setTimeout : éviter d'appeler Supabase à l'intérieur du callback d'auth
      setTimeout(() => onSession(session), 0);
    }
  });
})();
