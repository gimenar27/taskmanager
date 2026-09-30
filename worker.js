// Cloudflare entry point (free Workers plan).
// Cloudflare serves the app's files from public/ directly; /api/* goes to one Durable Object
// that holds the database and uses an alarm to wake itself every minute to send due reminders.
import { DurableObject } from 'cloudflare:workers';
import { createApp } from './lib/app.js';
import { openDurableObjectDatabase } from './lib/db-do.js';

export class TaskFlowStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.core = await createApp({ db: openDurableObjectDatabase(ctx.storage), env });
      await this.ensureAlarm();
    });
  }

  async fetch(request) {
    await this.ensureAlarm();
    return this.core.app.fetch(request);
  }

  // Runs once a minute: send whatever is due, then set the next wake-up.
  async alarm() {
    await this.core.tick();
    await this.scheduleNextCheck();
  }

  async ensureAlarm() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.scheduleNextCheck();
  }

  async scheduleNextCheck() {
    // One second after the next minute starts, so "9:00" reminders go out at 9:00.
    await this.ctx.storage.setAlarm(Math.floor(Date.now() / 60000) * 60000 + 61000);
  }
}

const store = env => env.STORE.get(env.STORE.idFromName('taskflow'));

export default {
  async fetch(request, env) {
    // Read the (small) body up front so it isn't still streaming after the reply is sent.
    const body = ['GET', 'HEAD'].includes(request.method) ? null : await request.arrayBuffer();
    return store(env).fetch(new Request(request.url, { method: request.method, headers: request.headers, body }));
  },
  // Safety net: a periodic poke that restarts the alarm if it was ever lost.
  scheduled: (event, env, ctx) => ctx.waitUntil(store(env).fetch('https://taskflow.internal/api/health')),
};
