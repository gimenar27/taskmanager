// Database tables, plus upgrades from the original TaskFlow tables.
// `db` is a small adapter (see db-node.js and db-do.js) with exec / prepare(get, all, run) / transaction.

const TABLES = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT UNIQUE,
    password TEXT,
    password_hash TEXT,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    email_reminders INTEGER NOT NULL DEFAULT 0,
    language TEXT NOT NULL DEFAULT 'en',
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'task',
    priority TEXT NOT NULL DEFAULT 'Medium',
    amount TEXT NOT NULL DEFAULT '',
    start_date TEXT,
    time TEXT NOT NULL DEFAULT '09:00',
    repeat TEXT NOT NULL DEFAULT 'none',
    alerts TEXT NOT NULL DEFAULT '[]',
    nag_per_day INTEGER NOT NULL DEFAULT 0,
    nag_start TEXT NOT NULL DEFAULT '09:00',
    nag_end TEXT NOT NULL DEFAULT '21:00',
    nag_from TEXT,
    completed_through TEXT,
    done INTEGER NOT NULL DEFAULT 0,
    done_at TEXT,
    done_by INTEGER,
    starred INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS shares (
    reminder_id INTEGER NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shared_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (reminder_id, user_id)
  );

  -- Shares with people who don't have an account yet, turned into real shares when they sign up.
  CREATE TABLE IF NOT EXISTS invites (
    reminder_id INTEGER NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    invited_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (reminder_id, email)
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One row per notification already delivered, so a reminder never fires twice.
  CREATE TABLE IF NOT EXISTS sent_log (
    reminder_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    fire_key TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    PRIMARY KEY (reminder_id, user_id, fire_key)
  );

  CREATE TABLE IF NOT EXISTS snoozes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reminder_id INTEGER NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fire_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_reminders_owner ON reminders(owner_id);
  CREATE INDEX IF NOT EXISTS idx_shares_user ON shares(user_id);
  CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
`;

// Columns added on top of the users table from the first version of TaskFlow.
// (and columns added in later versions of this one).
const USER_COLUMNS = [
  'password_hash TEXT',
  "timezone TEXT NOT NULL DEFAULT 'UTC'",
  'email_reminders INTEGER NOT NULL DEFAULT 0',
  'created_at TEXT',
  "language TEXT NOT NULL DEFAULT 'en'",
];

function setupSchema(db, { legacy = false } = {}) {
  db.exec(TABLES);
  let existing = null;
  try {
    existing = db.prepare('SELECT name FROM pragma_table_info(?)').all('users').map(c => c.name);
  } catch {
    // Some hosts don't allow reading table info; just try each column and skip ones that exist.
  }
  for (const def of USER_COLUMNS) {
    if (existing && existing.includes(def.split(' ')[0])) continue;
    try {
      db.exec(`ALTER TABLE users ADD COLUMN ${def}`);
    } catch (err) {
      if (!/duplicate column/i.test(String(err && err.message))) throw err;
    }
  }
  if (legacy) migrateLegacyTasks(db);
}

// The first version of TaskFlow stored to-dos in a `tasks` table. Copy them over once.
function migrateLegacyTasks(db) {
  const hasTasks = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get();
  if (!hasTasks || getMeta(db, 'legacy_tasks_migrated')) return;

  const insert = db.prepare(`
    INSERT INTO reminders (owner_id, title, notes, kind, priority, start_date, alerts, done)
    VALUES (?, ?, ?, 'task', ?, ?, ?, ?)`);
  const userExists = db.prepare('SELECT 1 AS ok FROM users WHERE id = ?');
  db.transaction(() => {
    for (const t of db.prepare('SELECT * FROM tasks').all()) {
      if (!userExists.get(t.user_id)) continue;
      const priority = ['Low', 'Medium', 'High'].includes(t.priority) ? t.priority : 'Medium';
      const date = t.due_date && /^\d{4}-\d{2}-\d{2}$/.test(t.due_date) ? t.due_date : null;
      insert.run(t.user_id, (t.title || 'Untitled').trim() || 'Untitled', t.desc || '', priority,
        date, date ? '[1,0]' : '[]', t.completed ? 1 : 0);
    }
    setMeta(db, 'legacy_tasks_migrated', new Date().toISOString());
  });
}

function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

module.exports = { setupSchema, getMeta, setMeta };
