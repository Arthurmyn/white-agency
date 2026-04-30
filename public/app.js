// ── STATE ──
let myVotedFor = null;          // participant id I voted for
let hasVoted = false;
const LS_KEY = 'voted_participant_id';

// ── INIT ──
(async () => {
  await loadParticipants();
  subscribeToLiveUpdates();
})();

// ── INITIAL LOAD ──
async function loadParticipants() {
  try {
    const res = await fetch('/api/participants');
    const data = await res.json();

    myVotedFor = data.votedFor;

    // Also check localStorage as fallback (for incognito reloads etc.)
    const lsVote = localStorage.getItem(LS_KEY);
    if (lsVote && !myVotedFor) myVotedFor = parseInt(lsVote, 10);

    hasVoted = !!myVotedFor;

    renderParticipants(data.participants, data.totalVotes);
    updateStatus();
  } catch (e) {
    document.getElementById('participantsContainer').innerHTML =
      '<div class="loading">Ошибка загрузки. Обновите страницу.</div>';
  }
}

// ── RENDER CARDS ──
function renderParticipants(participants, totalVotes) {
  document.getElementById('totalVotes').textContent = totalVotes;

  const container = document.getElementById('participantsContainer');
  container.innerHTML = '';

  participants.forEach(p => {
    const isMyVote = myVotedFor === p.id;
    const card = document.createElement('div');
    card.className = 'participant-card' + (isMyVote ? ' voted-card' : '');
    card.id = `card-${p.id}`;

    const avatarInner = p.photo
      ? `<img class="avatar-img" src="${escHtml(p.photo)}" alt="${escHtml(p.name)}" loading="lazy" />`
      : `<div class="avatar-placeholder">🎵</div>`;

    const checkmark = isMyVote ? `<div class="avatar-check">✓</div>` : '';

    const btnLabel = isMyVote ? '✓ Проголосовал' : 'Проголосовать';
    const btnClass = 'btn-vote' + (isMyVote ? ' voted' : '');
    const btnDisabled = hasVoted ? 'disabled' : '';

    const numLabel = p.number < 10 ? `0${p.number}` : `${p.number}`;

    card.innerHTML = `
      <div class="card-photo">
        ${p.photo
          ? `<img src="${escHtml(p.photo)}" alt="${escHtml(p.name)}" loading="lazy">`
          : `<div class="card-photo-placeholder">🎵</div>`}
        ${isMyVote ? '<div class="card-voted-overlay">✓</div>' : ''}
      </div>

      <div class="card-right">
        <div class="card-num-badge">${numLabel}</div>

        <div class="card-name-block">${escHtml(p.name)}</div>

        <button class="${btnClass}" ${btnDisabled} onclick="castVote(${p.id}, this)">
          ${btnLabel}
        </button>

        <div class="card-divider"></div>

        <div class="card-progress">
          <div class="bar-track">
            <div class="bar-fill" id="bar-${p.id}" style="width:${p.percentage}%"></div>
          </div>
          <span class="bar-pct" id="pct-${p.id}">${p.percentage}%</span>
          <span class="bar-cnt" id="cnt-${p.id}">${p.votes} г.</span>
        </div>
      </div>
    `;

    container.appendChild(card);
  });
}

// ── LIVE UPDATE (polling every 3s) ──
function subscribeToLiveUpdates() {
  setInterval(async () => {
    try {
      const res  = await fetch('/api/participants');
      if (!res.ok) return;
      const data = await res.json();

      document.getElementById('totalVotes').textContent = data.totalVotes;
      data.participants.forEach(p => {
        const bar = document.getElementById(`bar-${p.id}`);
        const pct = document.getElementById(`pct-${p.id}`);
        const cnt = document.getElementById(`cnt-${p.id}`);
        if (bar) bar.style.width = p.percentage + '%';
        if (pct) pct.textContent = p.percentage + '%';
        if (cnt) cnt.textContent = p.votes + ' голос' + voteSuffix(p.votes);
      });
    } catch (_) {}
  }, 3000);
}

// ── CAST VOTE ──
async function castVote(participantId, btn) {
  if (hasVoted) return;

  btn.disabled = true;
  btn.textContent = 'Отправляем…';

  try {
    const res = await fetch('/api/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participantId }),
    });
    const data = await res.json();

    if (res.ok && data.success) {
      myVotedFor = participantId;
      hasVoted = true;
      localStorage.setItem(LS_KEY, String(participantId));

      // Update all buttons
      document.querySelectorAll('.btn-vote').forEach(b => {
        b.disabled = true;
        if (b === btn) {
          b.textContent = '✓ Вы проголосовали';
          b.classList.add('voted');
        }
      });

      // Highlight winning card
      const card = document.getElementById(`card-${participantId}`);
      if (card) card.classList.add('voted-card');

      updateStatus();
      showToast('Ваш голос принят! Спасибо!', 'success');
    } else if (data.error === 'already_voted') {
      myVotedFor = data.votedFor;
      hasVoted = true;
      localStorage.setItem(LS_KEY, String(data.votedFor));
      updateStatus();
      showToast('Вы уже проголосовали ранее', 'error');
      btn.textContent = 'Проголосовать';
    } else {
      btn.disabled = false;
      btn.textContent = 'Проголосовать';
      showToast('Ошибка. Попробуйте ещё раз.', 'error');
    }
  } catch (_) {
    btn.disabled = false;
    btn.textContent = 'Проголосовать';
    showToast('Нет связи с сервером.', 'error');
  }
}

// ── STATUS BANNER ──
function updateStatus() {
  const banner = document.getElementById('statusBanner');
  const text   = document.getElementById('statusText');
  if (hasVoted && myVotedFor) {
    banner.style.display = '';
    banner.classList.remove('error-banner');
    const card = document.getElementById(`card-${myVotedFor}`);
    const name = card ? card.querySelector('.card-name')?.textContent : 'участника';
    text.textContent = `✓ Вы проголосовали за: ${name}`;
  } else {
    banner.style.display = 'none';
  }
}

// ── CANCEL VOTE ──
async function cancelVote() {
  const btn = document.getElementById('btnCancelVote');
  btn.textContent = '...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/vote', { method: 'DELETE' });
    if (res.ok) {
      myVotedFor = null;
      hasVoted   = false;
      localStorage.removeItem(LS_KEY);

      // Restore all vote buttons
      document.querySelectorAll('.btn-vote').forEach(b => {
        b.disabled = false;
        b.textContent = 'Проголосовать';
        b.classList.remove('voted');
      });

      // Remove gold border from cards
      document.querySelectorAll('.participant-card').forEach(c => c.classList.remove('voted-card'));

      // Remove checkmark avatars
      document.querySelectorAll('.avatar-check').forEach(el => el.remove());

      updateStatus();
      showToast('Выбор отменён', '');
    } else {
      showToast('Не удалось отменить', 'error');
    }
  } catch {
    showToast('Ошибка соединения', 'error');
  }

  btn.textContent = 'Отменить выбор';
  btn.disabled = false;
}

// ── TOAST ──
let toastTimer = null;
function showToast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (type ? ' ' + type : '');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
}

// ── HELPERS ──
function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function voteSuffix(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return '';
  if ([2,3,4].includes(mod10) && ![12,13,14].includes(mod100)) return 'а';
  return 'ов';
}
