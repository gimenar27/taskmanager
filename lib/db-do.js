// SQLite inside a Cloudflare Durable Object (ctx.storage.sql), wrapped to look like Node's
// node:sqlite so the rest of the app doesn't care where it runs.
const { setupSchema } = require('./schema');

function openDurableObjectDatabase(storage) {
  const sql = storage.sql;
  const exec = (query, params) => sql.exec(query, ...params.map(v => (v === undefined ? null : v)));
  const db = {
    exec(script) {
      // Run one statement at a time; skip chunks that are only comments.
      for (const stmt of script.split(/;[ \t]*(?:\r?\n|$)/)) {
        if (stmt.replace(/--[^\n]*/g, '').trim()) sql.exec(stmt);
      }
    },
    prepare(query) {
      return {
        get: (...params) => exec(query, params).toArray()[0],
        all: (...params) => exec(query, params).toArray(),
        run: (...params) => {
          const cursor = exec(query, params);
          cursor.toArray();
          return { changes: cursor.rowsWritten };
        },
      };
    },
    transaction: fn => storage.transactionSync(fn),
  };
  setupSchema(db);
  return db;
}

module.exports = { openDurableObjectDatabase };
