// Admin panel logic (vanilla JS). Talks to /admin/api/*.
const $ = (sel) => document.querySelector(sel);
let STATE = { users: [], plans: [], settings: {}, publicBaseUrl: '' };

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = '/admin/login'; return; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2200);
}

function copy(text) {
  navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard'));
}

async function load() {
  STATE = await api('GET', '/admin/api/state');
  $('#base-url').textContent = `Public URL: ${STATE.publicBaseUrl}`;
  $('#brand_name').value = STATE.settings.brand_name || '';
  $('#tagline').value = STATE.settings.tagline || '';
  renderPlans();
  renderUsers();
}

function renderPlans() {
  const wrap = $('#plans');
  wrap.innerHTML = '';
  if (!STATE.plans.length) {
    wrap.innerHTML = '<div class="empty-state muted">No plans yet. Add one to make it available to users.</div>';
    return;
  }
  for (const p of STATE.plans) {
    const div = document.createElement('div');
    div.className = 'plan';
    const features = p.features?.length
      ? `<ul class="plan-features">${p.features.map((feature) => `<li>${escapeHtml(feature)}</li>`).join('')}</ul>`
      : '<div class="muted plan-no-features">No features added</div>';
    div.innerHTML = `
      <div class="plan-heading">
        <div>
          <div class="plan-name">${escapeHtml(p.name)}</div>
          <div class="plan-price">${escapeHtml(p.price)}</div>
        </div>
        <div class="actions">
          <button class="btn tiny ghost" data-act="edit-plan">Edit</button>
          <button class="btn tiny danger" data-act="delete-plan">Delete</button>
        </div>
      </div>
      ${features}`;
    div.querySelector('[data-act="edit-plan"]').onclick = () => openPlanDialog(p);
    div.querySelector('[data-act="delete-plan"]').onclick = async () => {
      if (!confirm(`Delete plan "${p.name}"?`)) return;
      try {
        await api('DELETE', `/admin/api/plans/${p.id}`);
        toast('Plan deleted');
        await load();
      } catch (e) { toast(e.message); }
    };
    wrap.appendChild(div);
  }
}

function renderUsers() {
  const tbody = $('#users tbody');
  tbody.innerHTML = '';
  if (!STATE.users.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="muted">No users yet — click “Add user”.</td></tr>`;
    return;
  }
  for (const u of STATE.users) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${escapeHtml(u.username)}</strong></td>
      <td>${escapeHtml(u.plan_name)}</td>
      <td>${escapeHtml(u.price)}</td>
      <td>${escapeHtml(u.expires_pretty)}</td>
      <td>${u.days_left === null ? '—' : u.days_left}</td>
      <td><span class="pill" style="background:${u.status_color}">${u.status_label}</span></td>
      <td></td>
      <td><div class="link-btns">
        <button class="btn tiny ghost" data-act="copy-m3u">Copy m3u</button>
        <button class="btn tiny ghost" data-act="open-hls">HLS</button>
      </div></td>
      <td><div class="actions">
        <button class="btn tiny ghost" data-act="edit">Edit</button>
        <button class="btn tiny ghost" data-act="token">New link</button>
        <button class="btn tiny ghost" data-act="del">Delete</button>
      </div></td>`;

    // active switch
    const sw = document.createElement('label');
    sw.className = 'switch';
    sw.innerHTML = `<input type="checkbox" ${u.active ? 'checked' : ''}><span class="slider"></span>`;
    sw.querySelector('input').onchange = async (e) => {
      try { await api('PATCH', `/admin/api/users/${u.id}`, { active: e.target.checked }); await load(); }
      catch (err) { toast(err.message); }
    };
    tr.children[6].appendChild(sw);

    tr.querySelector('[data-act="copy-m3u"]').onclick = () => copy(u.m3u_url);
    tr.querySelector('[data-act="open-hls"]').onclick = () => window.open(u.hls_url, '_blank');
    tr.querySelector('[data-act="edit"]').onclick = () => openDialog(u);
    tr.querySelector('[data-act="token"]').onclick = async () => {
      if (!confirm('Generate a new link? The old m3u URL will stop working.')) return;
      try { await api('POST', `/admin/api/users/${u.id}/token`); toast('New link generated'); await load(); }
      catch (e) { toast(e.message); }
    };
    tr.querySelector('[data-act="del"]').onclick = async () => {
      if (!confirm(`Delete ${u.username}?`)) return;
      try { await api('DELETE', `/admin/api/users/${u.id}`); toast('User deleted'); await load(); }
      catch (e) { toast(e.message); }
    };
    tbody.appendChild(tr);
  }
}

// ---- dialog ----
function openDialog(user) {
  const dlg = $('#user-dialog');
  $('#dialog-title').textContent = user ? 'Edit user' : 'Add user';
  $('#f-id').value = user?.id || '';
  $('#f-username').value = user?.username || '';
  $('#f-expires').value = user?.expires_at || '';
  $('#f-active').checked = user ? user.active : true;
  const sel = $('#f-plan');
  sel.innerHTML = STATE.plans.map((p) => `<option value="${p.id}">${escapeHtml(p.name)} (${p.price})</option>`).join('');
  sel.value = user?.plan_id || STATE.plans[0]?.id;
  dlg.showModal();
}

$('#dialog-save').onclick = async (e) => {
  e.preventDefault();
  const id = $('#f-id').value;
  const payload = {
    username: $('#f-username').value.trim(),
    plan_id: $('#f-plan').value,
    expires_at: $('#f-expires').value || null,
    active: $('#f-active').checked,
  };
  if (!payload.username) return toast('Username required');
  try {
    if (id) await api('PATCH', `/admin/api/users/${id}`, payload);
    else await api('POST', '/admin/api/users', payload);
    $('#user-dialog').close();
    toast('Saved');
    await load();
  } catch (err) { toast(err.message); }
};
$('#dialog-cancel').onclick = () => $('#user-dialog').close();

// ---- plan dialog ----
function openPlanDialog(plan) {
  $('#plan-dialog-title').textContent = plan ? 'Edit plan' : 'Add plan';
  $('#plan-id').value = plan?.id || '';
  $('#plan-name').value = plan?.name || '';
  $('#plan-price').value = plan ? (plan.price_cents / 100).toFixed(2) : '';
  $('#plan-features').value = (plan?.features || []).join('\n');
  $('#plan-dialog').showModal();
}

$('#plan-dialog-save').onclick = async (e) => {
  e.preventDefault();
  const id = $('#plan-id').value;
  const priceText = $('#plan-price').value.trim();
  const payload = {
    name: $('#plan-name').value.trim(),
    price_eur: Number(priceText),
    features: $('#plan-features').value
      .split('\n')
      .map((feature) => feature.trim())
      .filter(Boolean),
  };
  if (!payload.name) return toast('Plan name required');
  if (!priceText || !Number.isFinite(payload.price_eur) || payload.price_eur < 0) return toast('Valid price required');
  try {
    if (id) await api('PATCH', `/admin/api/plans/${id}`, payload);
    else await api('POST', '/admin/api/plans', payload);
    $('#plan-dialog').close();
    toast('Plan saved — streams rebuilding');
    await load();
  } catch (err) { toast(err.message); }
};
$('#plan-dialog-cancel').onclick = () => $('#plan-dialog').close();

// ---- top-level actions ----
$('#add-user').onclick = () => openDialog(null);
$('#add-plan').onclick = () => openPlanDialog(null);
$('#save-settings').onclick = async () => {
  try {
    await api('PATCH', '/admin/api/settings', {
      brand_name: $('#brand_name').value, tagline: $('#tagline').value,
    });
    toast('Branding saved — streams rebuilding');
  } catch (e) { toast(e.message); }
};
$('#regen-all').onclick = async () => {
  toast('Rebuilding all streams…');
  try { await api('POST', '/admin/api/regenerate-all'); toast('All streams rebuilt'); }
  catch (e) { toast(e.message); }
};
$('#logout').onclick = async () => { await api('POST', '/admin/logout'); location.href = '/admin/login'; };

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

load().catch((e) => toast('Load failed: ' + e.message));
