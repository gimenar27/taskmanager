// Run TaskFlow on your own computer or any Node host (`npm start`).
// For free hosting on Cloudflare, see worker.js and DEPLOY.md.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { serve } = require('@hono/node-server');
const { serveStatic } = require('@hono/node-server/serve-static');
const { openNodeDatabase } = require('./lib/db-node');
const { createApp } = require('./lib/app');

function createMailer(env) {
  if (!env.SMTP_USER || !env.SMTP_PASS) return null;
  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport(env.SMTP_HOST
    ? { host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 587), secure: env.SMTP_PORT === '465', auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } }
    : { service: env.SMTP_SERVICE || 'gmail', auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } });
  const from = env.MAIL_FROM || `TaskFlow <${env.SMTP_USER}>`;
  return { send: (to, subject, text) => transport.sendMail({ from, to, subject, text }) };
}

// Accounts made by an earlier build of this version used scrypt hashes; still accept them
// (they're upgraded to the current format on login).
function verifyScrypt(password, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) return false;
  const [, salt, hash] = stored.split('$');
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

async function main() {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const dbFile = process.env.DB_PATH || path.join(dataDir, 'taskflow.db');
  // Bring along the database from the first version of the app if it is still next to this file.
  const legacy = path.join(__dirname, 'database.db');
  if (!fs.existsSync(dbFile) && fs.existsSync(legacy)) {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    fs.copyFileSync(legacy, dbFile);
  }

  const { app, scheduler } = await createApp({
    db: openNodeDatabase(dbFile),
    env: process.env,
    mailer: createMailer(process.env),
    verifyLegacyHash: verifyScrypt,
  });
  app.use('*', serveStatic({
    root: path.relative(process.cwd(), path.join(__dirname, 'public')) || '.',
    onFound(file, c) {
      if (/\.(html|webmanifest)$/.test(file) || file.endsWith('sw.js')) c.header('Cache-Control', 'no-cache');
    },
  }));

  const port = Number(process.env.PORT || 3000);
  serve({ fetch: app.fetch, port }, () => {
    console.log(`TaskFlow running on http://localhost:${port}`);
    scheduler.start();
  });
}

if (require.main === module) main();

module.exports = { verifyScrypt };
