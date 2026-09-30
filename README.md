# TaskFlow

A calm, phone-friendly place for tasks, bills and reminders, with notifications right on your phone.

TaskFlow installs on iPhone and Android as an app on your Home Screen (a Progressive Web App), so there's no App Store needed.

## What it does

- **💳 Bills that repeat.** Add your credit card once (“due the 15th, every month”) and get reminded **1 day before** and **on the day**, every month. You can also add 2 days, 3 days or 1 week before. Tap **Mark paid** and the rest of that month's reminders stop; next month's still come.
- **🔔 Nudges until it's done.** For things you need to finish, choose **how many reminders a day** (1–12) and the hours (e.g. 3× a day between 9 AM and 9 PM). TaskFlow keeps nudging every day until you check it off.
- **🤝 Share with people.** Share any reminder by email. Everyone on it gets the same notifications and anyone can check it off. If they don't have an account yet, they get it as soon as they sign up with that email.
- **🌎 English or Spanish.** Switch on the sign-in screen or in Me › Language; notifications arrive in each person's language.
- **🍵 Matcha or 🍑 Peach.** Light matcha green by default, with a soft wavy header; dark mode works with both.
- **Also:** daily/weekly/monthly/yearly repeats, a calendar view, snooze (1 hour, 3 hours, tomorrow), “Done” and “In 1 hour” buttons right on the notification (Android/desktop), add-to-Calendar (.ics) links, dark mode, and the assistant that breaks a goal into to-dos.

## Run it on your computer

Needs [Node.js](https://nodejs.org) 22.13 or newer.

```bash
npm install
npm start
```

Then open http://localhost:3000.

Run the tests:

```bash
npm test
```

## Put it on your phone

Your phone needs to reach TaskFlow at an `https://` address, so it has to be online. It runs **free on Cloudflare** (`npm run deploy`, see **[DEPLOY.md](DEPLOY.md)**). Once it is:

**iPhone** (iOS 16.4 or newer)
1. Open the TaskFlow address in **Safari**.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Open **TaskFlow** from your Home Screen, log in, and tap **Turn on notifications**.

**Android**
1. Open the address in **Chrome**.
2. Tap **Install app** (or **⋮ → Add to Home screen**).
3. Open TaskFlow and tap **Turn on notifications**.

On a computer you can go to **Me → Add TaskFlow to your phone** to get a QR code to scan.

## How it works

| Piece | What it does |
| --- | --- |
| `lib/app.js`, `lib/routes/` | The API (built with [Hono](https://hono.dev)): accounts, reminders, sharing, push subscriptions, calendar links. The same code runs on Cloudflare and on Node. |
| `worker.js` | Cloudflare entry point. One Durable Object holds the database and uses an alarm to wake up every minute and send due reminders. |
| `server.js` | Node entry point (`npm start`) for running on your computer or a normal server. |
| `lib/scheduler.js` | Works out which reminders are due for each person (in their own time zone) and sends them. Each notification is sent once. |
| `public/js/schedule.js` | The reminder rules: repeats, “day before” alerts, “N times a day” nudges. Shared by the server and the app, so what the app previews is exactly what gets sent. |
| `lib/webpush.js` | Encrypts and signs push notifications (Web Push) using the Web Crypto API. |
| `public/js/app/` | The phone app in four plain-JavaScript files (no build step): core, screens, sheets, startup. |
| `public/js/i18n.js`, `lib/messages.js` | All text in English and Spanish (app screens and server messages). |
| `public/sw.js` | Service worker: receives push notifications, handles the notification buttons, and lets the app open offline. |
| `lib/schema.js` | The SQLite tables: Cloudflare's built-in SQLite, or Node's in `data/taskflow.db`. Tasks from the first version of TaskFlow are copied over automatically on Node. |

Notifications use the standard [Web Push](https://developer.mozilla.org/docs/Web/API/Push_API) protocol, which Apple and Google both support for Home Screen apps. The signing keys are created on first start and stored in the database.

## Settings

All optional. Copy `.env.example` to `.env` for local use, or add them in your host's dashboard.

| Name | What it's for |
| --- | --- |
| `DATA_DIR` | Folder for the database. Point it at a persistent disk when hosting (the Dockerfile uses `/data`). |
| `PORT` | Port to listen on (default 3000). |
| `APP_URL` | The public `https://` address, used in invite emails. |
| `VAPID_SUBJECT` | Contact for push services, e.g. `mailto:you@gmail.com`. If unset, the app's own https address is used. |
| `SMTP_USER`, `SMTP_PASS` | Node version only: Gmail address + [app password](https://myaccount.google.com/apppasswords) to send share invites (and email reminders for people who turn them on). |

## Security notes

- Passwords are hashed (PBKDF2). Accounts from the first version are upgraded the next time they log in.
- Every request checks that you own the reminder or it's shared with you.
- Secrets live in environment variables, never in the code.

---

Created by Gimena Rios Moreno.
