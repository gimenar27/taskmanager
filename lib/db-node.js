// SQLite on your own computer or a Node host, using the database built into Node 22+.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { setupSchema } = require('./schema');

function openNodeDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const db = {
    exec: sql => raw.exec(sql),
    prepare: sql => raw.prepare(sql),
    transaction(fn) {
      raw.exec('BEGIN');
      try {
        const result = fn();
        raw.exec('COMMIT');
        return result;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
    close: () => raw.close(),
  };
  setupSchema(db, { legacy: true });
  return db;
}

module.exports = { openNodeDatabase };
