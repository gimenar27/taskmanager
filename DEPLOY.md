# Put TaskFlow online

Your phone needs to reach TaskFlow at a public `https://` address, and the server has to run around the clock so reminders go out even when your computer is off.

## Recommended: Railway (about 10 minutes)

**Cost:** free for the first 30 days (a $5 trial credit, no card needed), then the Hobby plan at $5/month. TaskFlow uses much less than the $5 of usage that plan includes.

1. Go to [railway.com](https://railway.com) and **sign in with GitHub**.
2. Click **New Project → Deploy from GitHub repo** and choose **gimenar27/taskmanager**.
   If the new version isn't merged into `main` yet, open the service → **Settings → Source** and set the branch to **`mobile-app`**.
3. Railway finds the `Dockerfile` and builds the app. Wait for it to say **Active**.
4. **Add a disk** so your data survives restarts: right-click the service (or press ⌘K) → **Attach Volume**, and set the mount path to **`/data`**.
5. **Settings → Networking → Generate Domain.** You'll get an address like `https://taskmanager-production.up.railway.app`.
6. Optional, under **Variables**: `VAPID_SUBJECT` = `mailto:your-email@gmail.com` and `APP_URL` = the address from step 5.
7. Open that address on your phone and follow **“Put it on your phone”** in the [README](README.md).

After that, every push to that branch on GitHub redeploys automatically.

## Other hosts

Anything that runs a Docker container with a persistent disk works (Fly.io, Render with a disk, your own server): mount the disk at `/data` and expose port `3000`.

Free plans that go to sleep or wipe the disk (like Render's free tier) don't work well here: reminders need the server awake, and the database needs a disk that sticks around.

## Try it on your phone before hosting

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

Cloudflare prints an address like `https://something-random.trycloudflare.com` that works on your phone. It stops when you close the terminal or your Mac sleeps, and it changes every time. Once you move to a permanent host, remove the old icon and add TaskFlow to your Home Screen again from the new address.

## Bringing your data along

The database is a single file, `data/taskflow.db`. The simplest path is to sign up again on the hosted version. To keep what you have, copy that file onto the host's `/data` disk before the first start.
