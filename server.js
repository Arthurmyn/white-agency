const express      = require('express');
const cookieParser = require('cookie-parser');
const multer       = require('multer');
const crypto       = require('crypto');
const { v4: uuidv4 } = require('uuid');
const path         = require('path');
const fs           = require('fs');

const IS_NETLIFY = !!(process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME);
const DATA_DIR   = './data';
const DB_FILE    = path.join(DATA_DIR, 'votes.json');
const PHOTOS_DIR = path.join(__dirname, 'public', 'assets', 'photos');
const DEFAULT_DB = { participants: [], voters: {} };

// ── Wrap async Express handlers so errors propagate to the error middleware ──
const a = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── Storage ──
// Netlify: Netlify Blobs
// Local:   data/votes.json

async function loadDB() {
  if (IS_NETLIFY) {
    const fallback = loadSeedDB();

    try {
      const { getStore } = require('@netlify/blobs');
      const data = await getStore('votes').get('db', { type: 'json' });
      return data || fallback;
    } catch (err) {
      console.error('[loadDB] falling back to seed data:', err.message);
      return fallback;
    }
  }
  if (!fs.existsSync(DB_FILE)) {
    const init = { participants: [], voters: {} };
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2));
    return init;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

async function saveDB(data) {
  if (IS_NETLIFY) {
    const { getStore } = require('@netlify/blobs');
    await getStore('votes').set('db', JSON.stringify(data));
  } else {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  }
}

function loadSeedDB() {
  try {
    const seedFile = path.join(__dirname, 'data', 'votes.json');
    return JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  } catch (_) {
    return { ...DEFAULT_DB };
  }
}

function nextId(list) { return list.length ? Math.max(...list.map(p => p.id)) + 1 : 1; }
function reNumber(list) { list.forEach((p, i) => { p.number = i + 1; }); }

// ── createApp ──
function createApp() {
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'white_story_agency';
  const ADMIN_SESSION_TOKEN = crypto
    .createHmac('sha256', ADMIN_PASSWORD).update('admin-session-v1').digest('hex');

  const upload = multer({
    storage: IS_NETLIFY
      ? multer.memoryStorage()
      : multer.diskStorage({
          destination: (_req, _file, cb) => {
            if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });
            cb(null, PHOTOS_DIR);
          },
          filename: (req, _file, cb) =>
            cb(null, `participant-${req.params.id}-${Date.now()}.jpg`),
        }),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
  });

  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  if (!IS_NETLIFY) {
    app.use(express.static(path.join(__dirname, 'public')));
    app.get('/admin', (_req, res) =>
      res.sendFile(path.join(__dirname, 'public', 'admin.html')));
  }

  // Voter ID cookie
  app.use((req, res, next) => {
    if (!req.cookies.voter_id) {
      const id = uuidv4();
      res.cookie('voter_id', id, {
        maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax',
      });
      req.cookies.voter_id = id;
    }
    next();
  });

  function requireAdmin(req, res, next) {
    if (req.cookies.admin_session !== ADMIN_SESSION_TOKEN)
      return res.status(403).json({ error: 'Unauthorized' });
    next();
  }

  // ── Health check (debug) ──
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      netlify: IS_NETLIFY,
      storage: IS_NETLIFY ? 'netlify-blobs' : 'local-json',
    });
  });

  // ── PUBLIC API ──

  app.get('/api/participants', a(async (req, res) => {
    const db    = await loadDB();
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
  }));

  app.post('/api/vote', a(async (req, res) => {
    const voterId = req.cookies.voter_id;
    const { participantId } = req.body;
    if (!participantId || typeof participantId !== 'number')
      return res.status(400).json({ error: 'Invalid participant ID' });
    const db = await loadDB();
    const p  = db.participants.find(p => p.id === participantId);
    if (!p) return res.status(404).json({ error: 'Participant not found' });
    if (db.voters[voterId] !== undefined)
      return res.status(409).json({ error: 'already_voted', votedFor: db.voters[voterId] });
    db.voters[voterId] = participantId;
    p.votes += 1;
    await saveDB(db);
    res.json({ success: true, votedFor: participantId });
  }));

  app.delete('/api/vote', a(async (req, res) => {
    const voterId = req.cookies.voter_id;
    const db = await loadDB();
    if (db.voters[voterId] === undefined)
      return res.status(404).json({ error: 'no_vote' });
    const p = db.participants.find(p => p.id === db.voters[voterId]);
    if (p && p.votes > 0) p.votes -= 1;
    delete db.voters[voterId];
    await saveDB(db);
    res.json({ success: true });
  }));

  // ── ADMIN AUTH ──

  app.post('/api/admin/login', (req, res) => {
    if (req.body.password !== ADMIN_PASSWORD)
      return res.status(401).json({ error: 'Неверный пароль' });
    res.cookie('admin_session', ADMIN_SESSION_TOKEN, {
      httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000,
    });
    res.json({ success: true });
  });

  app.post('/api/admin/logout', (_req, res) => {
    res.clearCookie('admin_session');
    res.json({ success: true });
  });

  app.get('/api/admin/check', requireAdmin, (_req, res) => res.json({ ok: true }));

  // ── ADMIN PARTICIPANTS ──

  app.get('/api/admin/participants', requireAdmin, a(async (_req, res) => {
    const db = await loadDB();
    res.json({ participants: db.participants });
  }));

  app.post('/api/admin/participants', requireAdmin, a(async (req, res) => {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
    const db   = await loadDB();
    const newP = { id: nextId(db.participants), name: name.trim(),
                   number: db.participants.length + 1, photo: null, votes: 0 };
    db.participants.push(newP);
    await saveDB(db);
    res.json({ success: true, participant: newP });
  }));

  app.patch('/api/admin/participants/:id', requireAdmin, a(async (req, res) => {
    const id = parseInt(req.params.id);
    if (!req.body.name?.trim()) return res.status(400).json({ error: 'Name required' });
    const db = await loadDB();
    const p  = db.participants.find(p => p.id === id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    p.name = req.body.name.trim();
    await saveDB(db);
    res.json({ success: true });
  }));

  app.delete('/api/admin/participants/:id', requireAdmin, a(async (req, res) => {
    const id  = parseInt(req.params.id);
    const db  = await loadDB();
    const idx = db.participants.findIndex(p => p.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const p = db.participants[idx];
    if (!IS_NETLIFY && p.photo) {
      const f = path.join(__dirname, 'public', p.photo);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    db.participants.splice(idx, 1);
    reNumber(db.participants);
    Object.keys(db.voters).forEach(v => { if (db.voters[v] === id) delete db.voters[v]; });
    await saveDB(db);
    res.json({ success: true });
  }));

  app.post('/api/admin/participants/:id/move', requireAdmin, a(async (req, res) => {
    const id  = parseInt(req.params.id);
    const db  = await loadDB();
    const idx = db.participants.findIndex(p => p.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const swap = req.body.direction === 'up' ? idx - 1 : idx + 1;
    if (swap >= 0 && swap < db.participants.length) {
      [db.participants[idx], db.participants[swap]] =
        [db.participants[swap], db.participants[idx]];
      reNumber(db.participants);
    }
    await saveDB(db);
    res.json({ success: true, participants: db.participants });
  }));

  app.post('/api/admin/participants/:id/photo', requireAdmin,
    upload.single('photo'), a(async (req, res) => {
      const id = parseInt(req.params.id);
      const db = await loadDB();
      const p  = db.participants.find(p => p.id === id);
      if (!p)        return res.status(404).json({ error: 'Not found' });
      if (!req.file) return res.status(400).json({ error: 'No file' });
      if (!IS_NETLIFY) {
        if (p.photo?.includes('/photos/')) {
          const old = path.join(__dirname, 'public', p.photo);
          if (fs.existsSync(old)) fs.unlinkSync(old);
        }
        p.photo = `/assets/photos/${req.file.filename}`;
        await saveDB(db);
        res.json({ success: true, photo: p.photo });
      } else {
        // On Netlify: photo upload not available — use GitHub to add photos
        res.status(501).json({
          error: 'Загрузка фото через интерфейс недоступна на Netlify. Добавьте фото через GitHub репозиторий в папку public/assets/photos/ и укажите путь /assets/photos/имя_файла.jpg',
        });
      }
    }));

  app.post('/api/admin/reset', requireAdmin, a(async (_req, res) => {
    const db = await loadDB();
    db.voters = {};
    db.participants.forEach(p => { p.votes = 0; });
    await saveDB(db);
    res.json({ success: true });
  }));

  // ── Global error handler ──
  app.use((err, req, res, _next) => {
    console.error('[Express error]', err.message, err.stack);
    if (!res.headersSent)
      res.status(500).json({ error: err.message || 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };

// ── Local dev only ──
if (!IS_NETLIFY) {
  const PORT = process.env.PORT || 3000;
  const app  = createApp();
  app.listen(PORT, () => {
    console.log(`\n✅  Сайт:    http://localhost:${PORT}`);
    console.log(`🔧  Админка: http://localhost:${PORT}/admin`);
    console.log(`🔑  Пароль:  ${process.env.ADMIN_PASSWORD || 'white_story_agency'}\n`);
  });
}
