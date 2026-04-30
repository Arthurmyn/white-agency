const express     = require('express');
const cookieParser = require('cookie-parser');
const multer      = require('multer');
const crypto      = require('crypto');
const { v4: uuidv4 } = require('uuid');
const path        = require('path');
const fs          = require('fs');

const IS_NETLIFY  = !!process.env.NETLIFY;
const DATA_DIR    = './data';
const DB_FILE     = path.join(DATA_DIR, 'votes.json');
const PHOTOS_DIR  = path.join(__dirname, 'public', 'assets', 'photos');

// ── Storage: file locally, Netlify Blobs in production ──

async function loadDB() {
  if (IS_NETLIFY) {
    const { getStore } = require('@netlify/blobs');
    const data = await getStore('votes').get('db', { type: 'json' });
    return data || { participants: [], voters: {} };
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

function nextId(list) {
  return list.length ? Math.max(...list.map(p => p.id)) + 1 : 1;
}
function reNumber(list) {
  list.forEach((p, i) => { p.number = i + 1; });
}

// ── createApp — used both locally and by the Netlify Function ──

function createApp() {
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'white_story_agency';

  // Deterministic token — stable across serverless cold starts
  const ADMIN_SESSION_TOKEN = crypto
    .createHmac('sha256', ADMIN_PASSWORD)
    .update('admin-session-v1')
    .digest('hex');

  // ── Multer: disk locally, memory on Netlify ──
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

  // Static files only in local mode (Netlify CDN handles them in production)
  if (!IS_NETLIFY) {
    app.use(express.static(path.join(__dirname, 'public')));
    app.get('/admin', (_req, res) =>
      res.sendFile(path.join(__dirname, 'public', 'admin.html')));
  }

  // Assign voter ID cookie
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

  // ── PUBLIC API ──

  app.get('/api/participants', async (req, res) => {
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
  });

  app.post('/api/vote', async (req, res) => {
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
  });

  app.delete('/api/vote', async (req, res) => {
    const voterId = req.cookies.voter_id;
    const db = await loadDB();
    if (db.voters[voterId] === undefined)
      return res.status(404).json({ error: 'no_vote' });

    const p = db.participants.find(p => p.id === db.voters[voterId]);
    if (p && p.votes > 0) p.votes -= 1;
    delete db.voters[voterId];
    await saveDB(db);
    res.json({ success: true });
  });

  // Serve photos stored in Netlify Blobs
  app.get('/api/photos/:key', async (req, res) => {
    if (!IS_NETLIFY) return res.status(404).send('Use /assets/photos/ locally');
    try {
      const { getStore } = require('@netlify/blobs');
      const result = await getStore('photos')
        .getWithMetadata(req.params.key, { type: 'arrayBuffer' });
      if (!result?.data) return res.status(404).send('Not found');
      res.setHeader('Content-Type', result.metadata?.contentType || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(Buffer.from(result.data));
    } catch {
      res.status(500).send('Error');
    }
  });

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

  app.get('/api/admin/participants', requireAdmin, async (_req, res) => {
    const db = await loadDB();
    res.json({ participants: db.participants });
  });

  app.post('/api/admin/participants', requireAdmin, async (req, res) => {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
    const db  = await loadDB();
    const newP = { id: nextId(db.participants), name: name.trim(),
                   number: db.participants.length + 1, photo: null, votes: 0 };
    db.participants.push(newP);
    await saveDB(db);
    res.json({ success: true, participant: newP });
  });

  app.patch('/api/admin/participants/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id);
    if (!req.body.name?.trim()) return res.status(400).json({ error: 'Name required' });
    const db = await loadDB();
    const p  = db.participants.find(p => p.id === id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    p.name = req.body.name.trim();
    await saveDB(db);
    res.json({ success: true });
  });

  app.delete('/api/admin/participants/:id', requireAdmin, async (req, res) => {
    const id  = parseInt(req.params.id);
    const db  = await loadDB();
    const idx = db.participants.findIndex(p => p.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });

    const p = db.participants[idx];
    if (!IS_NETLIFY && p.photo) {
      const f = path.join(__dirname, 'public', p.photo);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    if (IS_NETLIFY) {
      try {
        const { getStore } = require('@netlify/blobs');
        await getStore('photos').delete(`participant-${id}`);
      } catch (_) {}
    }

    db.participants.splice(idx, 1);
    reNumber(db.participants);
    Object.keys(db.voters).forEach(v => { if (db.voters[v] === id) delete db.voters[v]; });
    await saveDB(db);
    res.json({ success: true });
  });

  app.post('/api/admin/participants/:id/move', requireAdmin, async (req, res) => {
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
  });

  app.post('/api/admin/participants/:id/photo', requireAdmin,
    upload.single('photo'), async (req, res) => {
      const id = parseInt(req.params.id);
      const db = await loadDB();
      const p  = db.participants.find(p => p.id === id);
      if (!p)        return res.status(404).json({ error: 'Not found' });
      if (!req.file) return res.status(400).json({ error: 'No file' });

      if (IS_NETLIFY) {
        const { getStore } = require('@netlify/blobs');
        const key = `participant-${id}`;
        await getStore('photos').set(key, req.file.buffer,
          { contentType: req.file.mimetype });
        p.photo = `/api/photos/${key}`;
      } else {
        if (p.photo?.includes('/photos/')) {
          const old = path.join(__dirname, 'public', p.photo);
          if (fs.existsSync(old)) fs.unlinkSync(old);
        }
        p.photo = `/assets/photos/${req.file.filename}`;
      }

      await saveDB(db);
      res.json({ success: true, photo: p.photo });
    });

  app.post('/api/admin/reset', requireAdmin, async (_req, res) => {
    const db = await loadDB();
    db.voters = {};
    db.participants.forEach(p => { p.votes = 0; });
    await saveDB(db);
    res.json({ success: true });
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
