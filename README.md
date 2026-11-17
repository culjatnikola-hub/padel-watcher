# padel-watcher

A Cloudflare Worker that watches Playtomic for free padel slots at **Padel Embassy** and **Padel.hr** (Zagreb) and sends a Telegram alert when one fits your days and times. Booking stays a manual tap in the Playtomic app; the alert has a button that opens the club there.

## What it does

- **Checks every minute** from 07:00 to 22:59 Zagreb winter time (Cron Trigger) for slots in each person's days, start-time window and length.
- **Alerts on cancellations**, with a hint of how fast that kind of slot usually goes (🔥 / ⏳ / 🧊, learned from history).
- **New releases** (when the booking window reaches a slot): alerts Mon–Thu; on Fridays only the 18:00 start.
- **Skips** slots for today, and won't repeat an alert for the same slot within 3 hours (checkout flicker).
- **Several people** can use one bot: anyone sends `/start`, the owner approves them, and each gets their own settings and alerts.
- **History and stats** in D1: `/report` (charts), `/stats`, `/metrics`, plus a weekly report on Monday 08:00.
- **Optional:** reads the owner's Playtomic bookings (`/bookings`), skips days already booked, reminds the day before.

## Deploying

The Worker is connected to this repo with Cloudflare Workers Builds: every push to `main` deploys automatically, using `wrangler.toml` (bindings and the every-minute cron). Secrets stay in the Cloudflare dashboard.

## Setup from scratch (Cloudflare dashboard)

1. Create a Worker and paste `src/worker.js` into it.
2. **Bindings**
   - KV namespace → variable name `SEEN`
   - D1 database → variable name `DB` (tables are created automatically)
3. **Variables and secrets**
   - `TELEGRAM_TOKEN` (secret): from @BotFather
   - `TELEGRAM_CHAT_ID` (variable): the owner's Telegram chat ID
   - `PLAYTOMIC_TOKEN` (secret, optional): enables `/bookings`
4. **Trigger**: Cron `* 6-21 * * *` (every minute, 06:00–21:59 UTC)
5. Open `https://<your-worker>.workers.dev/?setup=1` once to connect the Telegram webhook and command menus.

Never commit tokens: they live only in Cloudflare secrets.

## Commands

Owner: `/slots` `/bookings` `/report` `/stats` `/metrics` `/status` `/window` `/days` `/length` `/remind` `/pause` `/resume` `/users` `/approve ID` `/deny ID` `/remove ID`

Approved users: `/slots` `/status` `/window` `/days` `/length` `/report` `/pause` `/resume`

Examples: `/window 17:30 19:00` (every day) · `/window tue,thu 17:00 20:30` (some days) · `/days mon-fri` · `/length 90`

Debug links: `?setup=1` · `?webhook=1` · `?stats=1&days=7` · `?test=1` · `?day=2026-11-03&club=hr` · no parameter runs one check.

## Tests

`npm test` runs scenario scripts (Node 22.5+, no dependencies). They mock Playtomic, Telegram, KV and D1 (SQLite in memory) and print the messages the bot would send: multi-user access, per-day windows, checkout flicker, and release rules.

## Limits to keep in mind (free plan)

10 ms CPU per run, about 1,000 KV writes a day (state is written only when it changes), cron at most once a minute.
