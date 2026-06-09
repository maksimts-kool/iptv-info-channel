// Admin panel logic (vanilla JS). Talks to /admin/api/*.
const $ = (sel) => document.querySelector(sel);
let STATE = { users: [], plans: [], settings: {}, publicBaseUrl: '' };
let generationStatusLoading = false;
let generationInProgress = false;
let generationCompleteTimer;

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

async function copy(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const input = document.createElement('textarea');
      input.value = text;
      input.setAttribute('readonly', '');
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      input.setSelectionRange(0, input.value.length);
      const copied = document.execCommand('copy');
      input.remove();
      if (!copied) throw new Error('copy command was rejected');
    }
    toast('Copied to clipboard');
  } catch {
    window.prompt('Copy this URL:', text);
  }
}

function showGenerationPending(title = 'Updating channel streams') {
  const banner = $('#generation-status');
  clearTimeout(generationCompleteTimer);
  generationInProgress = true;
  banner.hidden = false;
  banner.classList.remove('is-complete');
  $('#generation-title').textContent = title;
  $('#generation-detail').textContent = 'Your changes are saved. FFmpeg is rendering new video segments in the background, so IPTV playback updates only after encoding finishes.';
  $('#generation-progress').hidden = true;
  $('#generation-count').textContent = 'Waiting for the encoder…';
  $('#regen-all').disabled = true;
}

function clearGenerationPending() {
  clearTimeout(generationCompleteTimer);
  generationInProgress = false;
  $('#generation-status').hidden = true;
  $('#generation-status').classList.remove('is-complete');
  $('#regen-all').disabled = false;
}

function showGenerationComplete() {
  const banner = $('#generation-status');
  generationInProgress = false;
  banner.hidden = false;
  banner.classList.add('is-complete');
  $('#generation-title').textContent = 'Stream update complete';
  $('#generation-detail').textContent = 'Encoding finished. The updated channel stream is ready for IPTV playback.';
  $('#generation-progress').hidden = false;
  $('#generation-progress-bar').style.width = '100%';
  $('#generation-count').textContent = 'Completed';
  $('#regen-all').disabled = false;
  clearTimeout(generationCompleteTimer);
  generationCompleteTimer = setTimeout(() => {
    banner.hidden = true;
    banner.classList.remove('is-complete');
  }, 5000);
}

function renderGenerationStatus(status) {
  const banner = $('#generation-status');
  if (!status.active) {
    if (generationInProgress) showGenerationComplete();
    else if (!banner.classList.contains('is-complete')) clearGenerationPending();
    return;
  }

  clearTimeout(generationCompleteTimer);
  generationInProgress = true;
  const names = status.active_users.map((user) => user.username).filter(Boolean);
  banner.hidden = false;
  banner.classList.remove('is-complete');
  $('#regen-all').disabled = true;
  $('#generation-title').textContent = status.bulk
    ? 'Rebuilding all channel streams'
    : `Updating ${names[0] || 'channel'} stream`;
  $('#generation-detail').textContent = 'FFmpeg is encoding video in the background. Existing streams stay online, but saved changes will appear in IPTV playback only when the new stream is ready.';

  if (status.bulk?.total) {
    const completed = Math.min(status.bulk.completed, status.bulk.total);
    const percent = Math.round((completed / status.bulk.total) * 100);
    $('#generation-progress').hidden = false;
    $('#generation-progress-bar').style.width = `${percent}%`;
    $('#generation-count').textContent = `${completed} of ${status.bulk.total} streams encoded${names.length ? ` · Now: ${names.join(', ')}` : ''}`;
  } else {
    $('#generation-progress').hidden = true;
    $('#generation-count').textContent = names.length
      ? `Encoding: ${names.join(', ')}`
      : 'Preparing stream encoding…';
  }
}

async function refreshGenerationStatus() {
  if (generationStatusLoading) return;
  generationStatusLoading = true;
  try {
    renderGenerationStatus(await api('GET', '/admin/api/generation-status'));
  } catch {
    // Keep the current indicator during brief network failures.
  } finally {
    generationStatusLoading = false;
  }
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
          <div class="plan-price">${escapeHtml(p.price)}${p.billing_period === 'month' ? '/мес.' : p.billing_period === 'year' ? '/год' : ''}</div>
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
      showGenerationPending('Deleting plan and rebuilding streams');
      try {
        await api('DELETE', `/admin/api/plans/${p.id}`);
        toast('Plan deleted — streams rebuilding');
        await load();
        await refreshGenerationStatus();
      } catch (e) { toast(e.message); clearGenerationPending(); }
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
      showGenerationPending(`Updating ${u.username}'s stream`);
      try {
        await api('PATCH', `/admin/api/users/${u.id}`, { active: e.target.checked });
        await load();
        await refreshGenerationStatus();
      } catch (err) { toast(err.message); clearGenerationPending(); }
    };
    tr.children[6].appendChild(sw);

    tr.querySelector('[data-act="copy-m3u"]').onclick = () => copy(u.m3u_url);
    tr.querySelector('[data-act="open-hls"]').onclick = () => window.open(u.hls_url, '_blank');
    tr.querySelector('[data-act="edit"]').onclick = () => openDialog(u);
    tr.querySelector('[data-act="token"]').onclick = async () => {
      if (!confirm('Generate a new link? The old m3u URL will stop working.')) return;
      showGenerationPending(`Generating ${u.username}'s new stream`);
      try {
        await api('POST', `/admin/api/users/${u.id}/token`);
        toast('New link generated — stream rebuilding');
        await load();
        await refreshGenerationStatus();
      } catch (e) { toast(e.message); clearGenerationPending(); }
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
  sel.innerHTML = STATE.plans.map((p) => {
    const period = p.billing_period === 'month' ? '/мес.' : p.billing_period === 'year' ? '/год' : '';
    return `<option value="${p.id}">${escapeHtml(p.name)} (${p.price}${period})</option>`;
  }).join('');
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
  showGenerationPending(id ? `Updating ${payload.username}'s stream` : `Creating ${payload.username}'s stream`);
  try {
    if (id) await api('PATCH', `/admin/api/users/${id}`, payload);
    else await api('POST', '/admin/api/users', payload);
    $('#user-dialog').close();
    toast('Saved — stream rebuilding');
    await load();
    await refreshGenerationStatus();
  } catch (err) { toast(err.message); clearGenerationPending(); }
};
$('#dialog-cancel').onclick = () => $('#user-dialog').close();

// ---- plan dialog ----
function openPlanDialog(plan) {
  $('#plan-dialog-title').textContent = plan ? 'Edit plan' : 'Add plan';
  $('#plan-id').value = plan?.id || '';
  $('#plan-name').value = plan?.name || '';
  $('#plan-price').value = plan ? (plan.price_cents / 100).toFixed(2) : '';
  $('#plan-period').value = plan?.billing_period || '';
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
    billing_period: $('#plan-period').value,
    features: $('#plan-features').value
      .split('\n')
      .map((feature) => feature.trim())
      .filter(Boolean),
  };
  if (!payload.name) return toast('Plan name required');
  if (!priceText || !Number.isFinite(payload.price_eur) || payload.price_eur < 0) return toast('Valid price required');
  showGenerationPending('Saving plan and rebuilding streams');
  try {
    if (id) await api('PATCH', `/admin/api/plans/${id}`, payload);
    else await api('POST', '/admin/api/plans', payload);
    $('#plan-dialog').close();
    toast('Plan saved — streams rebuilding');
    await load();
    await refreshGenerationStatus();
  } catch (err) { toast(err.message); clearGenerationPending(); }
};
$('#plan-dialog-cancel').onclick = () => $('#plan-dialog').close();

// ---- top-level actions ----
$('#add-user').onclick = () => openDialog(null);
$('#add-plan').onclick = () => openPlanDialog(null);
$('#save-settings').onclick = async () => {
  showGenerationPending('Saving branding and rebuilding streams');
  try {
    await api('PATCH', '/admin/api/settings', {
      brand_name: $('#brand_name').value, tagline: $('#tagline').value,
    });
    toast('Branding saved — streams rebuilding');
    await refreshGenerationStatus();
  } catch (e) { toast(e.message); clearGenerationPending(); }
};
$('#regen-all').onclick = async () => {
  showGenerationPending('Rebuilding all channel streams');
  toast('Rebuilding all streams…');
  try {
    await api('POST', '/admin/api/regenerate-all');
    toast('All streams rebuilt');
    await refreshGenerationStatus();
  } catch (e) { toast(e.message); clearGenerationPending(); }
};
$('#logout').onclick = async () => { await api('POST', '/admin/logout'); location.href = '/admin/login'; };

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

load()
  .then(refreshGenerationStatus)
  .catch((e) => toast('Load failed: ' + e.message));
setInterval(refreshGenerationStatus, 1500);
