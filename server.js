const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Auth Routes ─────────────────────────────────────────────────────────────

// POST Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password required' });
    }

    const existing = db.getUserByUsername(username);
    if (existing) {
      return res.status(409).json({ success: false, error: 'Username already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const uniqueCode = uuidv4().split('-')[0].toUpperCase(); // Short unique code e.g. "A1B2C3D4"

    db.createUser({
      id: uuidv4(),
      username,
      password: hashedPassword,
      unique_code: uniqueCode,
      created_at: new Date().toISOString()
    });

    res.status(201).json({ success: true, message: 'User registered successfully', uniqueCode });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password required' });
    }

    const user = db.getUserByUsername(username);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    res.json({ success: true, message: 'Login successful', uniqueCode: user.unique_code });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Helper: Build Poll Result Object ─────────────────────────────────────────
function buildPollResult(pollId) {
  const poll = db.getPollById(pollId);
  if (!poll) return null;
  const options = db.getOptionsByPoll(pollId);
  return { ...poll, options };
}

// ─── REST API ──────────────────────────────────────────────────────────────────

// GET all polls
app.get('/api/polls', (req, res) => {
  try {
    const polls = db.getAllPolls();
    const withOptions = polls.map(p => ({
      ...p,
      options: db.getOptionsByPoll(p.id)
    }));
    res.json({ success: true, polls: withOptions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET single poll
app.get('/api/polls/:id', (req, res) => {
  try {
    const result = buildPollResult(req.params.id);
    if (!result) return res.status(404).json({ success: false, error: 'Poll not found' });
    res.json({ success: true, poll: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST create poll
app.post('/api/polls', (req, res) => {
  try {
    const { title, description = '', options = [] } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, error: 'Title is required' });
    }
    if (options.length < 2) {
      return res.status(400).json({ success: false, error: 'At least 2 options required' });
    }

    const pollId = uuidv4();
    db.createPoll({ id: pollId, title: title.trim(), description: description.trim(), created_at: new Date().toISOString() });

    options.forEach((label, i) => {
      if (label && label.trim()) {
        db.createOption({ id: uuidv4(), poll_id: pollId, label: label.trim(), position: i });
      }
    });

    const poll = buildPollResult(pollId);
    io.emit('poll-created', poll);
    res.status(201).json({ success: true, poll });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST vote on a poll
app.post('/api/polls/:id/vote', (req, res) => {
  try {
    const { optionId, sessionId } = req.body;
    const pollId = req.params.id;

    const poll = db.getPollById(pollId);
    if (!poll) return res.status(404).json({ success: false, error: 'Poll not found' });
    if (!poll.is_active) return res.status(403).json({ success: false, error: 'This poll is closed' });

    const existing = db.hasVoted(pollId, sessionId);
    if (existing) return res.status(409).json({ success: false, error: 'Already voted', votedOptionId: existing.option_id });

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    db.createVote({
      id: uuidv4(),
      poll_id: pollId,
      option_id: optionId,
      session_id: sessionId,
      ip_address: ip,
      created_at: new Date().toISOString()
    });

    const updatedPoll = buildPollResult(pollId);
    io.to(`poll:${pollId}`).emit('vote-update', updatedPoll);
    io.to('admin-room').emit('admin-vote-update', updatedPoll);
    io.to('admin-room').emit('admin-stats', db.getStatsOverview());

    res.json({ success: true, poll: updatedPoll });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ success: false, error: 'Already voted' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE poll
app.delete('/api/polls/:id', (req, res) => {
  try {
    const poll = db.getPollById(req.params.id);
    if (!poll) return res.status(404).json({ success: false, error: 'Poll not found' });
    db.deletePoll(req.params.id);
    io.emit('poll-deleted', { id: req.params.id });
    io.to('admin-room').emit('admin-stats', db.getStatsOverview());
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH toggle poll active/closed
app.patch('/api/polls/:id/toggle', (req, res) => {
  try {
    db.togglePoll(req.params.id);
    const updatedPoll = buildPollResult(req.params.id);
    if (!updatedPoll) return res.status(404).json({ success: false, error: 'Poll not found' });
    io.to(`poll:${req.params.id}`).emit('poll-status-changed', updatedPoll);
    io.to('admin-room').emit('admin-poll-toggled', updatedPoll);
    res.json({ success: true, poll: updatedPoll });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET vote history for a poll
app.get('/api/polls/:id/votes', (req, res) => {
  try {
    const votes = db.getVoteHistory(req.params.id);
    res.json({ success: true, votes });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET admin stats overview
app.get('/api/admin/stats', (req, res) => {
  try {
    const stats = db.getStatsOverview();
    const allVotes = db.getAllVotes();
    res.json({ success: true, stats, recentVotes: allVotes });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);

  socket.on('join-poll', (pollId) => {
    socket.join(`poll:${pollId}`);
    console.log(`[Socket] ${socket.id} joined poll:${pollId}`);
  });

  socket.on('join-admin', () => {
    socket.join('admin-room');
    console.log(`[Socket] ${socket.id} joined admin-room`);
    // Send initial stats on join
    socket.emit('admin-stats', db.getStatsOverview());
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] Client disconnected: ${socket.id}`);
  });
});

// ─── Start Server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🗳️  Voting Server running at http://localhost:${PORT}`);
  console.log(`📊  Admin Dashboard:  http://localhost:${PORT}/admin.html`);
  console.log(`➕  Create Poll:     http://localhost:${PORT}/create.html\n`);
});
