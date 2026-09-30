# Put TaskFlow online

Your phone needs to reach TaskFlow at a public `https://` address, and something has to be awake to send reminders even when nobody has the app open.

## Free: Cloudflare (recommended)

TaskFlow runs on Cloudflare's **free Workers plan**, with no credit card. The app's files are served by Cloudflare, and a single Durable Object holds the database and **wakes itself up every minute** with an alarm to send whatever is due, then goes back to sleep. The free limits (100,000 requests a day) are far more than a few people use.

**First time**

1. Create a free account at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up).
2. In this folder, install everything and connect your account (a browser page opens; click **Allow**):

   ```bash
   npm install
   ```

   ```bash
   npx wrangler login
   ```

3. Publish:

   ```bash
   npm run deploy
   ```

   It prints your address, like `https://taskflow.<your-subdomain>.workers.dev`.
   On a brand-new account, Cloudflare first needs a `workers.dev` subdomain. If the deploy stops and says the name is taken, open the link it prints, choose any free name, and run `npm run deploy` again.

4. Open the address on your phone and follow **“Put it on your phone”** in the [README](README.md).

**Updating:** run `npm run deploy` again. Your data stays.

**Optional:** give push services a contact address (otherwise the app's own address is used):

```bash
npx wrangler secret put VAPID_SUBJECT
```

(enter something like `mailto:you@gmail.com`).

Emailing invites and reminders only works on the Node version below. On Cloudflare, sharing still works; the other person just signs up with the email you shared with.

**Watch it work:** `npx wrangler tail` shows live logs, including the once-a-minute `Alarm … Ok`.

## Other hosts (Node)

The same app also runs as a normal Node server (`npm start`), which includes optional email. Anything that runs a Docker container with a persistent disk works, like Railway, Fly.io or your own server. Mount the disk at `/data` and expose port `3000`. Free plans that sleep or wipe the disk don't work for this version, because it checks for due reminders from inside the running server.

## Try it on your phone from your Mac

While your Mac is on, you can get a temporary https address:

```bash
npm start
```

```bash
brew install cloudflared
```

```bash
cloudflared tunnel --url http://localhost:3000
```

Cloudflare prints an address like `https://something-random.trycloudflare.com`. It stops when you close the terminal or your Mac sleeps, and it changes every time.
