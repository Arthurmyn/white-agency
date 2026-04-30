const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = './data';
const DB_FILE = path.join(DATA_DIR, 'votes.json');
const PHOTOS_DIR = path.join(__dirname, 'public', 'assets', 'photos');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'white_story_agency';
// Session token generated fresh each server start
const ADMIN_SESSION_TOKEN = uuidv4();

// ── Default participants ──
const DEFAULT_PARTICIPANTS = [
  'Александр Петров',   'Мария Иванова',    'Дмитрий Сидоров',
  'Анна Козлова',       'Сергей Новиков',   'Елена Морозова',
  'Михаил Волков',      'Ольга Лебедева',   'Артём Зайцев',
  'Наталья Соколова',   'Павел Орлов',      'Юлия Попова',
  'Иван Кузнецов',      'Виктория Смирнова','Никита Фёдоров',
];

// ── Ensure directories ──
if (!fs.existsSync(DATA_DIR))   fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });

// ── File storage helpers ──
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = {
      participants: DEFAULT_PARTICIPANTS.map((name, i) => ({
        id: i + 1, name, number: i + 1, photo: null, votes: 0,
      })),
      voters: {},
    };
    saveDB(initial);
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function nextId(participants) {
  return participants.length ? Math.max(...participants.map(p => p.id)) + 1 : 1;
}

function reNumber(participants) {
  participants.forEach((p, i) => { p.number = i + 1; });
}

// ── Photo upload (multer) ──
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, PHOTOS_DIR),
  filename: (req, _file, cb) => cb(null, `participant-${req.params.id}-${Date.now()}.jpg`),
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, file.mimetype.startsWith('image/'));
  },
});

// ── Middleware ──
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Assign voter ID cookie
app.use((req, res, next) => {
  if (!req.cookies.voter_id) {
    const id = uuidv4();
    res.cookie('voter_id', id, { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' });
    req.cookies.voter_id = id;
  }
  next();
});

// Admin auth middleware
function requireAdmin(req, res, next) {
  if (req.cookies.admin_session !== ADMIN_SESSION_TOKEN) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Serve admin page ──
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── PUBLIC API ──

app.get('/api/participants', (req, res) => {
  const db = loadDB();
  const total = db.participants.reduce((s, p) => s + p.votes, 0);
  const votedFor = db.voters[req.cookies.voter_id] ?? null;
  res.json({
    participants: db.participants.map(p => ({
      id: p.id, name: p.name, number: p.number, photo: p.photo,
      votes: p.votes,
      percentage: total > 0 ? Math.round((p.votes / total) * 100) : 0,
    })),
    totalVotes: total,
    votedFor,
  });
});

app.post('/api/vote', (req, res) => {
  const voterId = req.cookies.voter_id;
  const { participantId } = req.body;
  if (!participantId || typeof participantId !== 'number')
    return res.status(400).json({ error: 'Invalid participant ID' });

  const db = loadDB();
  const participant = db.participants.find(p => p.id === participantId);
  if (!participant) return res.status(404).json({ error: 'Participant not found' });
  if (db.voters[voterId] !== undefined)
    return res.status(409).json({ error: 'already_voted', votedFor: db.voters[voterId] });

  db.voters[voterId] = participantId;
  participant.votes += 1;
  saveDB(db);
  res.json({ success: true, votedFor: participantId });
});

app.delete('/api/vote', (req, res) => {
  const voterId = req.cookies.voter_id;
  const db = loadDB();

  if (db.voters[voterId] === undefined)
    return res.status(404).json({ error: 'no_vote' });

  const participantId = db.voters[voterId];
  const participant = db.participants.find(p => p.id === participantId);
  if (participant && participant.votes > 0) participant.votes -= 1;
  delete db.voters[voterId];
  saveDB(db);
  res.json({ success: true });
});

app.get('/api/results/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = () => {
    const db = loadDB();
    const total = db.participants.reduce((s, p) => s + p.votes, 0);
    res.write(`data: ${JSON.stringify({
      participants: db.participants.map(p => ({
        id: p.id,
        votes: p.votes,
        percentage: total > 0 ? Math.round((p.votes / total) * 100) : 0,
      })),
      totalVotes: total,
    })}\n\n`);
  };

  send();
  const interval = setInterval(send, 3000);
  req.on('close', () => clearInterval(interval));
});

// ── ADMIN AUTH ──

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Неверный пароль' });
  res.cookie('admin_session', ADMIN_SESSION_TOKEN, {
    httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000,
  });
  res.json({ success: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('admin_session');
  res.json({ success: true });
});

app.get('/api/admin/check', requireAdmin, (_req, res) => {
  res.json({ ok: true });
});

// ── ADMIN PARTICIPANTS ──

// List all with full vote data
app.get('/api/admin/participants', requireAdmin, (_req, res) => {
  const db = loadDB();
  res.json({ participants: db.participants });
});

// Add participant
app.post('/api/admin/participants', requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const db = loadDB();
  const newP = { id: nextId(db.participants), name: name.trim(), number: db.participants.length + 1, photo: null, votes: 0 };
  db.participants.push(newP);
  saveDB(db);
  res.json({ success: true, participant: newP });
});

// Update name
app.patch('/api/admin/participants/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const db = loadDB();
  const p = db.participants.find(p => p.id === id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  p.name = name.trim();
  saveDB(db);
  res.json({ success: true });
});

// Delete participant
app.delete('/api/admin/participants/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const db = loadDB();
  const idx = db.participants.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  // Remove old photo file if exists
  const p = db.participants[idx];
  if (p.photo) {
    const filePath = path.join(__dirname, 'public', p.photo);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  db.participants.splice(idx, 1);
  reNumber(db.participants);

  // Remove votes cast for this participant
  Object.keys(db.voters).forEach(v => {
    if (db.voters[v] === id) delete db.voters[v];
  });

  saveDB(db);
  res.json({ success: true });
});

// Reorder: move participant up or down
app.post('/api/admin/participants/:id/move', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { direction } = req.body; // 'up' | 'down'
  const db = loadDB();
  const idx = db.participants.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= db.participants.length)
    return res.json({ success: true }); // already at edge

  [db.participants[idx], db.participants[swapIdx]] = [db.participants[swapIdx], db.participants[idx]];
  reNumber(db.participants);
  saveDB(db);
  res.json({ success: true, participants: db.participants });
});

// Upload photo
app.post('/api/admin/participants/:id/photo', requireAdmin, upload.single('photo'), (req, res) => {
  const id = parseInt(req.params.id);
  const db = loadDB();
  const p = db.participants.find(p => p.id === id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (!req.file)  return res.status(400).json({ error: 'No file' });

  // Remove old photo if exists and it's in our photos dir
  if (p.photo && p.photo.includes('/photos/')) {
    const old = path.join(__dirname, 'public', p.photo);
    if (fs.existsSync(old)) fs.unlinkSync(old);
  }

  p.photo = `/assets/photos/${req.file.filename}`;
  saveDB(db);
  res.json({ success: true, photo: p.photo });
});

// Reset all votes
app.post('/api/admin/reset', requireAdmin, (_req, res) => {
  const db = loadDB();
  db.voters = {};
  db.participants.forEach(p => { p.votes = 0; });
  saveDB(db);
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`\n✅  Сайт:   http://localhost:${PORT}`);
  console.log(`🔧  Админка: http://localhost:${PORT}/admin`);
  console.log(`🔑  Пароль:  ${ADMIN_PASSWORD}\n`);
});
