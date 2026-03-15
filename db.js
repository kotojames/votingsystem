const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Use environment variable for DB path, default to local directory
const dbDir = process.env.DB_DIR || __dirname;
const dbName = process.env.DB_NAME || 'voting.db';
const dbPath = path.join(dbDir, dbName);

// Ensure directory exists if it's not the current one
if (dbDir !== __dirname && !fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS polls (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    is_active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS options (
    id TEXT PRIMARY KEY,
    poll_id TEXT NOT NULL,
    label TEXT NOT NULL,
    position INTEGER DEFAULT 0,
    FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS votes (
    id TEXT PRIMARY KEY,
    poll_id TEXT NOT NULL,
    option_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    ip_address TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
    FOREIGN KEY (option_id) REFERENCES options(id) ON DELETE CASCADE,
    UNIQUE (poll_id, session_id)
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    unique_code TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// ─── Poll Queries ────────────────────────────────────────────────────────────

const getAllPolls = db.prepare(`
  SELECT p.*, 
    (SELECT COUNT(*) FROM votes WHERE poll_id = p.id) AS total_votes
  FROM polls p
  ORDER BY p.created_at DESC
`);

const getPollById = db.prepare(`
  SELECT p.*,
    (SELECT COUNT(*) FROM votes WHERE poll_id = p.id) AS total_votes
  FROM polls p
  WHERE p.id = ?
`);

const createPoll = db.prepare(`
  INSERT INTO polls (id, title, description, created_at, is_active)
  VALUES (@id, @title, @description, @created_at, 1)
`);

const deletePoll = db.prepare(`DELETE FROM polls WHERE id = ?`);

const togglePoll = db.prepare(`
  UPDATE polls SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END
  WHERE id = ?
`);

// ─── Options Queries ─────────────────────────────────────────────────────────

const getOptionsByPoll = db.prepare(`
  SELECT o.*,
    (SELECT COUNT(*) FROM votes WHERE option_id = o.id) AS vote_count
  FROM options o
  WHERE o.poll_id = ?
  ORDER BY o.position ASC
`);

const createOption = db.prepare(`
  INSERT INTO options (id, poll_id, label, position)
  VALUES (@id, @poll_id, @label, @position)
`);

// ─── Vote Queries ─────────────────────────────────────────────────────────────

const createVote = db.prepare(`
  INSERT INTO votes (id, poll_id, option_id, session_id, ip_address, created_at)
  VALUES (@id, @poll_id, @option_id, @session_id, @ip_address, @created_at)
`);

const hasVoted = db.prepare(`
  SELECT id, option_id FROM votes WHERE poll_id = ? AND session_id = ?
`);

const getVoteHistory = db.prepare(`
  SELECT v.id, v.session_id, v.ip_address, v.created_at,
    o.label AS option_label, p.title AS poll_title
  FROM votes v
  JOIN options o ON v.option_id = o.id
  JOIN polls p ON v.poll_id = p.id
  WHERE v.poll_id = ?
  ORDER BY v.created_at DESC
`);

const getAllVotes = db.prepare(`
  SELECT v.id, v.session_id, v.ip_address, v.created_at,
    o.label AS option_label, p.title AS poll_title, p.id AS poll_id
  FROM votes v
  JOIN options o ON v.option_id = o.id
  JOIN polls p ON v.poll_id = p.id
  ORDER BY v.created_at DESC
  LIMIT 200
`);

const getStatsOverview = db.prepare(`
  SELECT 
    (SELECT COUNT(*) FROM polls) AS total_polls,
    (SELECT COUNT(*) FROM polls WHERE is_active = 1) AS active_polls,
    (SELECT COUNT(*) FROM votes) AS total_votes,
    (SELECT COUNT(DISTINCT session_id) FROM votes) AS unique_voters
`);

// ─── User Queries ─────────────────────────────────────────────────────────────

const createUser = db.prepare(`
  INSERT INTO users (id, username, password, unique_code, created_at)
  VALUES (@id, @username, @password, @unique_code, @created_at)
`);

const getUserByUsername = db.prepare(`
  SELECT * FROM users WHERE username = ?
`);

const getUserById = db.prepare(`
  SELECT * FROM users WHERE id = ?
`);

// ─── Exported API ─────────────────────────────────────────────────────────────

module.exports = {
  getAllPolls: () => getAllPolls.all(),
  getPollById: (id) => getPollById.get(id),
  createPoll: (data) => createPoll.run(data),
  deletePoll: (id) => deletePoll.run(id),
  togglePoll: (id) => togglePoll.run(id),

  getOptionsByPoll: (pollId) => getOptionsByPoll.all(pollId),
  createOption: (data) => createOption.run(data),

  createVote: (data) => createVote.run(data),
  hasVoted: (pollId, sessionId) => hasVoted.get(pollId, sessionId),
  getVoteHistory: (pollId) => getVoteHistory.all(pollId),
  getAllVotes: () => getAllVotes.all(),
  getStatsOverview: () => getStatsOverview.get(),

  createUser: (data) => createUser.run(data),
  getUserByUsername: (username) => getUserByUsername.get(username),
  getUserById: (id) => getUserById.get(id),
};
