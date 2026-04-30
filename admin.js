// ── STATE ──
let participants = [];
let pendingDeleteId = null;

// ── INIT ──
(async () => {
  // Check if already logged in
  const check = await fetch('/api/admin/check');
  if (check.ok) {
    showPanel();
    await loadParticipants();
  } else {
    showLogin();
  }
})();

// ── AUTH ──
function showLogin() {
  document.getElementById('loginScreen').style.display = '';
  document.getElementById('adminPanel').style.display  = 'none';
}

function showPanel() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('adminPanel').style.display  = '';
}

document.getElementById('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const password = document.getElementById('passwordInput').value;
  const errEl    = document.getElementById('loginError');
  const btn      = document.getElementById('loginBtn');

  btn.textContent = '...';
  btn.disabled = true;

  const res  = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const data = await res.json();

  btn.textContent = 'Войти';
  btn.disabled = false;

  if (res.ok) {
    errEl.textContent = '';
    showPanel();
    await loadParticipants();
  } else {
    errEl.textContent = data.error || 'Ошибка входа';
    document.getElementById('passwordInput').focus();
  }
});

document.getElementById('btnLogout').addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' });
  showLogin();
  document.getElementById('passwordInput').value = '';
});

// ── LOAD PARTICIPANTS ──
async function loadParticipants() {
  const res  = await fetch('/api/admin/participants');
  if (!res.ok) return;
  const data = await res.json();
  participants = data.participants;
  renderList();
  updateStats();
}

// ── STATS ──
function updateStats() {
  const total   = participants.reduce((s, p) => s + p.votes, 0);
  const leader  = participants.reduce((a, b) => b.votes > a.votes ? b : a, participants[0]);
  document.getElementById('statParticipants').textContent = participants.length;
  document.getElementById('statVotes').textContent        = total;
  document.getElementById('statLeader').textContent       = leader ? leader.name.split(' ')[0] : '—';
}

// ── RENDER LIST ──
function renderList() {
  const list = document.getElementById('participantsList');
  list.innerHTML = '';

  participants.forEach((p, idx) => {
    const row = document.createElement('div');
    row.className = 'p-row';
    row.dataset.id = p.id;

    const photoHTML = p.photo
      ? `<img class="p-photo" src="${escHtml(p.photo)}?t=${Date.now()}" alt="" />`
      : `<div class="p-photo-placeholder">🎵</div>`;

    const votesClass = p.votes > 0 ? 'p-votes has-votes' : 'p-votes';
    const numLabel   = p.number < 10 ? `0${p.number}` : `${p.number}`;

    row.innerHTML = `
      <div class="p-num">${numLabel}</div>

      <div class="p-photo-wrap" title="Нажмите чтобы загрузить фото">
        ${photoHTML}
        <div class="p-photo-overlay">📷</div>
        <input type="file" class="photo-file-input" accept="image/*" style="display:none" />
      </div>

      <input
        class="p-name-input"
        type="text"
        value="${escHtml(p.name)}"
        placeholder="Имя участника"
        maxlength="60"
      />

      <span class="${votesClass}">${p.votes} г.</span>
      <span class="p-saved" id="saved-${p.id}">✓</span>

      <div class="p-actions">
        <button class="btn-move btn-up"   title="Вверх"   ${idx === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn-move btn-down" title="Вниз"    ${idx === participants.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn-del"           title="Удалить">✕</button>
      </div>
    `;

    // Photo upload
    const photoWrap  = row.querySelector('.p-photo-wrap');
    const fileInput  = row.querySelector('.photo-file-input');
    photoWrap.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => uploadPhoto(p.id, fileInput, row));

    // Name auto-save on blur / Enter
    const nameInput = row.querySelector('.p-name-input');
    let saveTimer;
    nameInput.addEventListener('input', () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveName(p.id, nameInput.value, row), 800);
    });
    nameInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); }
    });

    // Move
    row.querySelector('.btn-up').addEventListener('click',   () => moveParticipant(p.id, 'up'));
    row.querySelector('.btn-down').addEventListener('click', () => moveParticipant(p.id, 'down'));

    // Delete
    row.querySelector('.btn-del').addEventListener('click', () => confirmDelete(p.id, p.name));

    list.appendChild(row);
  });
}

// ── SAVE NAME ──
async function saveName(id, name, row) {
  if (!name.trim()) return;
  const res = await fetch(`/api/admin/participants/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (res.ok) {
    const p = participants.find(p => p.id === id);
    if (p) p.name = name.trim();
    updateStats();
    flashSaved(id);
  }
}

function flashSaved(id) {
  const el = document.getElementById(`saved-${id}`);
  if (!el) return;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1500);
}

// ── UPLOAD PHOTO ──
async function uploadPhoto(id, input, row) {
  const file = input.files[0];
  if (!file) return;

  const photoWrap = row.querySelector('.p-photo-wrap');
  photoWrap.querySelector('.p-photo-overlay').textContent = '⏳';

  const form = new FormData();
  form.append('photo', file);

  const res  = await fetch(`/api/admin/participants/${id}/photo`, { method: 'POST', body: form });
  const data = await res.json();

  photoWrap.querySelector('.p-photo-overlay').textContent = '📷';

  if (res.ok) {
    const p = participants.find(p => p.id === id);
    if (p) p.photo = data.photo;
    // Replace photo element
    const inner = photoWrap.querySelector('.p-photo, .p-photo-placeholder');
    if (inner) inner.outerHTML = `<img class="p-photo" src="${data.photo}?t=${Date.now()}" alt="" />`;
    flashSaved(id);
    showToast('Фото загружено', 'ok');
  } else {
    showToast('Ошибка загрузки фото', 'err');
  }
  input.value = '';
}

// ── MOVE ──
async function moveParticipant(id, direction) {
  const res  = await fetch(`/api/admin/participants/${id}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ direction }),
  });
  const data = await res.json();
  if (res.ok) {
    participants = data.participants;
    renderList();
    updateStats();
  }
}

// ── ADD PARTICIPANT ──
document.getElementById('btnAdd').addEventListener('click', async () => {
  const name = prompt('Имя нового участника:');
  if (!name || !name.trim()) return;

  const res  = await fetch('/api/admin/participants', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();

  if (res.ok) {
    participants.push(data.participant);
    renderList();
    updateStats();
    showToast('Участник добавлен', 'ok');
    // Scroll to new row
    setTimeout(() => {
      document.getElementById('participantsList').lastElementChild?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  } else {
    showToast('Ошибка добавления', 'err');
  }
});

// ── DELETE ──
function confirmDelete(id, name) {
  pendingDeleteId = id;
  document.getElementById('deleteName').textContent = name;
  document.getElementById('deleteModal').style.display = '';
}

document.getElementById('deleteCancel').addEventListener('click', () => {
  document.getElementById('deleteModal').style.display = 'none';
  pendingDeleteId = null;
});

document.getElementById('deleteConfirm').addEventListener('click', async () => {
  if (!pendingDeleteId) return;
  document.getElementById('deleteModal').style.display = 'none';

  const res = await fetch(`/api/admin/participants/${pendingDeleteId}`, { method: 'DELETE' });
  if (res.ok) {
    participants = participants.filter(p => p.id !== pendingDeleteId);
    renderList();
    updateStats();
    showToast('Участник удалён', 'ok');
  } else {
    showToast('Ошибка удаления', 'err');
  }
  pendingDeleteId = null;
});

// ── RESET VOTES ──
document.getElementById('btnReset').addEventListener('click', () => {
  document.getElementById('resetModal').style.display = '';
});

document.getElementById('resetCancel').addEventListener('click', () => {
  document.getElementById('resetModal').style.display = 'none';
});

document.getElementById('resetConfirm').addEventListener('click', async () => {
  document.getElementById('resetModal').style.display = 'none';
  const res = await fetch('/api/admin/reset', { method: 'POST' });
  if (res.ok) {
    participants.forEach(p => { p.votes = 0; });
    renderList();
    updateStats();
    showToast('Голоса сброшены', 'ok');
  } else {
    showToast('Ошибка сброса', 'err');
  }
});

// Close modals on overlay click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.style.display = 'none';
  });
});

// ── TOAST ──
let toastTimer;
function showToast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2800);
}

// ── HELPERS ──
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
