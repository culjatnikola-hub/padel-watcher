// Test edit by Claude via the Cloudflare dashboard (4 Nov 2026), safe to remove.
// Padel slot watcher + cancellation monitor (Padel Embassy + Padel.hr)
// Cloudflare Worker.
//
// Needs:  KV namespace bound as SEEN, D1 database bound as DB (for the
//         cancellation monitor), secret TELEGRAM_TOKEN, variable
//         TELEGRAM_CHAT_ID, and a Cron Trigger.
// Optional: secret PLAYTOMIC_TOKEN (from your logged-in browser), so the bot
//         can read your bookings (skip booked days, remind you the day before).
//         Read-only: it never books or cancels anything.
//
// Telegram commands (after opening ?setup=1 once):
//   /slots /bookings /stats /status /window 17:30 19:00 /days mon-fri /length 90
//   /remind on|off /pause /resume /help
//   /bookings raw  (how bookings are read)   /paytest [hr|embassy]  (which payment options Playtomic offers)
//
// Debug links:
//   ?setup=1                 connect the Telegram commands to this Worker
//   ?webhook=1               check whether Telegram commands are connected
//   ?stats=1&days=7          cancellation statistics
//   ?test=1                  send a test notification
//   ?day=2026-11-03&club=hr  list every free slot that day (club=embassy|hr)
//   (no parameters)          run one check now

const TZ = "Europe/Zagreb";
const ERROR_ALERT_EVERY_MIN = 60;          // at most one error alert per hour
const ALERT_AFTER_MIN = 10;                // warn only after this many minutes of failed checks
const REMIND_MIN_BEFORE = 10;              // release heads-up this many minutes early
const QUIET_FROM = "23:00", QUIET_TO = "07:00";  // messages arrive silently (no sound) in these hours

// Your own bookings, read from your Playtomic account (needs the secret
// PLAYTOMIC_TOKEN; without it this part is off).
const PLAYTOMIC_API = "https://api.app.playtomic.io";
const BOOKINGS_EVERY_MIN = 5;              // how often to re-read your bookings
const BOOKING_REMINDER_AT = "10:00";       // reminder the day before, from this time

// Defaults; change them from Telegram, no code edits needed.
const DEFAULT_SETTINGS = {
  earliest: "17:30",                        // used for days without their own window
  latest: "19:00",
  dayWindows: {                             // start-time window per weekday (0 = Sun ... 6 = Sat)
    1: ["17:00", "19:00"], 2: ["17:00", "20:30"], 3: ["17:00", "19:00"],
    4: ["17:00", "20:30"], 5: ["17:00", "19:00"],
  },
  weekdays: [1, 2, 3, 4, 5],                // 0 = Sun ... 6 = Sat
  durations: [90],
  paused: false,
  remind: true,                             // heads-up before evening slots are released
};

// Cancellation monitor: logs when evening slots open up and how fast they get
// booked again. Wider than your notification window, to collect more data.
const MONITOR = { days: [1, 2, 3, 4, 5], from: "16:00", to: "21:00", durations: [90] };
const KEEP_HISTORY_DAYS = 120;

// window = how many days ahead the club takes bookings. It's rolling to the
// minute: a slot becomes bookable exactly `window` days before it starts
// (checked 3 Nov 2026: Embassy 7 days, Padel.hr 21 days).
// remind = send the release heads-up for this club. Off for Embassy: it also
// takes phone bookings ~2 weeks ahead, so its evenings are gone before release.
// rank = preference (higher is nicer). If you're already booked on a day, you
// only hear about slots at clubs ranked higher than the one you're booked at.
// Only the courts listed here are watched (singles courts are left out).
const CLUBS = {
  embassy: {
    name: "Padel Embassy",
    tenant: "2ea46d91-f7ed-4e4a-aa5c-392ee5995ad9",
    url: "https://playtomic.com/clubs/padel-embassy",
    window: 7,
    remind: false,
    rank: 2,
    courts: {
      "ad3c913a-1aa5-4238-a959-e7bce2e5bfe7": "Court 1",
      "1d83c405-4c10-41c1-8dbd-937b2a7a975b": "Court 2",
      "c4243806-ff18-4739-88c8-4abd11366e38": "Court 3",
      "7fee4036-04e5-49aa-adb1-bcc0e727916a": "Court 4",
      "ae12d459-a0f6-4fc7-a9e3-cd16c1eab308": "Court 5",
      "0568296b-dc80-4aff-bf5d-bf5e63f44914": "Court 6",
      "4a41c59c-0fb8-44bb-bb0f-d4c75dd1fd5d": "Court 7",
      "ac28729f-8ed9-4750-94f4-dd7662651589": "Court 8",
      // excluded: 4873ec1f... Single 1, ca765871... Single 2
    },
  },
  hr: {
    name: "Padel.hr",
    tenant: "57b9c4ce-c8e4-4a4c-a043-a9c1683be829",
    url: "https://playtomic.com/clubs/padel-hr",
    window: 21,
    remind: true,
    rank: 1,
    courts: {                              // all 8 courts are doubles
      "9dc48a2b-1fc8-4894-a00f-663d460ab208": "Padel 1",
      "104f2608-e8e5-4dcd-b994-4ddf82996ef0": "Padel 2",
      "6d795f9a-5811-4a24-965f-e9c6e84dde39": "Padel 3",
      "79231a1e-bff7-4555-a64c-7439c04d22dc": "Padel 4",
      "d4d4f0af-6464-4b71-a9b5-1dbf64c0be8a": "Padel 5",
      "15bff5cd-9af4-47a2-8bc4-9670a1ba4d7b": "Padel 6",
      "16fa7d22-9cc5-466c-bb27-3275113032b3": "Padel 7",
      "885654fc-31d7-4a4d-b046-d23275402d98": "Padel 8",
    },
  },
};

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// Start-time window for a weekday: its own window if set, else earliest-latest.
const windowFor = (s, wd) => (s.dayWindows && s.dayWindows[wd]) || [s.earliest, s.latest];
// "Mon/Wed/Fri 17:00-19:00 · Tue/Thu 17:00-20:30"
function windowSummary(s) {
  const groups = new Map();
  for (const wd of s.weekdays.slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))) {
    const w = windowFor(s, wd).join("-");
    if (!groups.has(w)) groups.set(w, []);
    groups.get(w).push(DAY_NAMES[wd][0].toUpperCase() + DAY_NAMES[wd].slice(1));
  }
  return [...groups].map(([w, d]) => `${d.join("/")} ${w}`).join(" · ");
}

// ---------- time helpers ----------
// The free Cloudflare plan allows ~10 ms of computing per run, so date
// formatting (slow) is done once per day, never once per slot.
const fmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ, weekday: "short", year: "numeric", month: "2-digit",
  day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function local(d) {
  const p = Object.fromEntries(fmt.formatToParts(d).map(x => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    label: `${p.weekday} ${p.day}.${p.month}`,
  };
}

const toMin = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// Today and the next `ahead` days that fall on the given weekdays, with their
// label ("Tue 03.11") and Zagreb's UTC offset in minutes that day.
function upcomingDays(weekdays, ahead) {
  const today = local(new Date()).date;
  const days = [];
  for (let i = 0; i <= ahead; i++) {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    const wd = d.getUTCDay();
    if (!weekdays.includes(wd)) continue;
    const l = local(d);
    days.push({ date: d.toISOString().slice(0, 10), wd, label: l.label, offset: toMin(l.time) - 720 });
  }
  return days;
}

function isQuietHours() {
  const t = local(new Date()).time;
  return QUIET_FROM > QUIET_TO ? (t >= QUIET_FROM || t < QUIET_TO) : (t >= QUIET_FROM && t < QUIET_TO);
}

function fmtDuration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} h ${min % 60} min`;
  return `${Math.round(min / 1440)} days`;
}

// ---------- storage (KV) ----------
async function getJSON(env, key, fallback) {
  const v = await env.SEEN.get(key);
  return v ? JSON.parse(v) : fallback;
}
async function putJSON(env, key, value) {
  await env.SEEN.put(key, JSON.stringify(value));
}
async function getSettings(env) {
  return { ...DEFAULT_SETTINGS, ...(await getJSON(env, "settings", {})) };
}

// ---------- other people using the bot ----------
// You (TELEGRAM_CHAT_ID) are the owner. Anyone else sends /start, you approve
// them with /approve, and they get their own settings, pause and alerts in
// their own chat. They only ever see bot messages, never the code. Owner-only:
// bookings, release heads-up, health alerts, the weekly report, managing users.
const MAX_PENDING = 10;
const isOwner = (env, chatId) => String(chatId) === String(env.TELEGRAM_CHAT_ID);
const GUEST_DEFAULTS = { remind: false };
async function getUsers(env) { return getJSON(env, "users", {}); }
async function userSettings(env, chatId) {
  if (isOwner(env, chatId)) return getSettings(env);
  return { ...DEFAULT_SETTINGS, ...GUEST_DEFAULTS, ...(await getJSON(env, `settings:${chatId}`, {})) };
}
async function saveUserSettings(env, chatId, next) {
  await putJSON(env, isOwner(env, chatId) ? "settings" : `settings:${chatId}`, next);
}
const seenKey = (env, chatId) => (isOwner(env, chatId) ? "seen" : `seen:${chatId}`);
const alertedKey = (env, chatId) => (isOwner(env, chatId) ? "alerted" : `alerted:${chatId}`);
// A slot can flicker free/taken while someone is in Playtomic's checkout and
// gives up. Don't alert the same slot again within this time.
const REPEAT_QUIET_MS = 3 * 3600000;
const userLabel = u => `${u.name || "?"}${u.username ? ` (@${u.username})` : ""}`;

// Does a scanned slot fit these settings (day, start-time window, length)?
const fits = (s, x) => {
  if (!s.weekdays.includes(x.wd) || !s.durations.includes(x.duration)) return false;
  const [from, to] = windowFor(s, x.wd);
  return x.time >= from && x.time <= to;
};
// One scan covers everybody: every day, window and length anyone watches.
function combinedSettings(list) {
  const weekdays = [...new Set(list.flatMap(s => s.weekdays))];
  const durations = [...new Set(list.flatMap(s => s.durations))];
  const dayWindows = {};
  for (const wd of weekdays) {
    const ws = list.filter(s => s.weekdays.includes(wd)).map(s => windowFor(s, wd));
    dayWindows[wd] = [ws.map(w => w[0]).sort()[0], ws.map(w => w[1]).sort().slice(-1)[0]];
  }
  return { ...DEFAULT_SETTINGS, weekdays, durations, dayWindows };
}

// ---------- Telegram ----------
async function telegram(env, method, payload) {
  if (!env.TELEGRAM_TOKEN) throw new Error("TELEGRAM_TOKEN secret is not set on this Worker");
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const data = await r.json();
  if (!data.ok) throw new Error(`Telegram said: ${data.description || r.status}`);
  return data.result;
}

// buttons: [{ text, url }, ...]  (one button per row)
async function send(env, text, buttons, { silent = false, chatId = null } = {}) {
  if (!env.TELEGRAM_CHAT_ID) throw new Error("TELEGRAM_CHAT_ID variable is not set on this Worker");
  const payload = { chat_id: chatId || env.TELEGRAM_CHAT_ID, text: text.slice(0, 4000) };
  if (silent || isQuietHours()) payload.disable_notification = true;   // delivered, but no sound
  if (buttons && buttons.length) {
    payload.reply_markup = { inline_keyboard: buttons.slice(0, 20).map(b => [b]) };
  }
  await telegram(env, "sendMessage", payload);
}

// Opens the club straight in the Playtomic app: app.playtomic.io links are
// registered as app links for Android (assetlinks.json, package com.playtomic)
// and iOS (apple-app-site-association, path /tenant/*), so no browser step.
// In the app you can pay at the club; on the website you can't.
const appLink = club => `https://app.playtomic.io/tenant/${club.tenant}`;

// First button: open the club in the app. Then one website button per date
// as a fallback (the website opens on that exact day, but only takes cards).
function dateButtons(club, slots) {
  const byDate = new Map();
  for (const x of slots) if (!byDate.has(x.date)) byDate.set(x.date, x.line.split(" ").slice(0, 2).join(" "));
  return [
    { text: `📱 Open ${club.name} in the app`, url: appLink(club) },
    ...[...byDate].map(([date, label]) => ({ text: `🌐 ${label} on the website`, url: `${club.url}?date=${date}` })),
  ];
}

// Secret shared with Telegram so only Telegram can call our command endpoint.
async function webhookSecret(env) {
  const hash = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode("padel-watcher:" + env.TELEGRAM_TOKEN));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

async function setup(env, origin) {
  await telegram(env, "setWebhook", {
    url: `${origin}/telegram`,
    secret_token: await webhookSecret(env),
    allowed_updates: ["message"],
  });
  await telegram(env, "setMyCommands", {
    commands: [
      { command: "slots", description: "Show free slots matching my settings" },
      { command: "status", description: "My settings" },
      { command: "window", description: "Set start-time window, e.g. /window 17:30 19:00" },
      { command: "days", description: "Set days, e.g. /days mon-fri" },
      { command: "length", description: "Set slot length(s), e.g. /length 90" },
      { command: "report", description: "Charts: when cancellations happen and how fast they go" },
      { command: "pause", description: "Stop notifications" },
      { command: "resume", description: "Start notifications again" },
      { command: "help", description: "List commands" },
    ],
  });
  await telegram(env, "setMyCommands", {
    scope: { type: "chat", chat_id: Number(env.TELEGRAM_CHAT_ID) },
    commands: [
      { command: "slots", description: "Show free slots matching my settings" },
      { command: "bookings", description: "My upcoming bookings" },
      { command: "report", description: "Charts: when cancellations happen and how fast they go" },
      { command: "metrics", description: "Is the watcher running? Checks in the last hour / 24 h" },
      { command: "stats", description: "How fast released and cancelled slots get taken" },
      { command: "status", description: "Show settings and watcher health" },
      { command: "window", description: "Set start-time window, e.g. /window 17:30 19:00" },
      { command: "days", description: "Set days, e.g. /days mon-fri" },
      { command: "length", description: "Set slot length(s), e.g. /length 90" },
      { command: "remind", description: "Heads-up before new evening slots are released (on/off)" },
      { command: "pause", description: "Stop notifications" },
      { command: "resume", description: "Start notifications again" },
      { command: "users", description: "Who else uses the bot (approve / remove)" },
      { command: "help", description: "List commands" },
    ],
  });
  return "Done. Telegram commands are connected. Send /help to your bot.";
}

async function webhookStatus(env, origin) {
  const info = await telegram(env, "getWebhookInfo", {});
  const expected = `${origin}/telegram`;
  const lines = [
    `Connected URL: ${info.url || "(none - open ?setup=1)"}`,
    `Expected URL:  ${expected}`,
    `Pending messages: ${info.pending_update_count}`,
    info.last_error_message
      ? `Last error: ${info.last_error_message} (${new Date(info.last_error_date * 1000).toISOString()})`
      : "Last error: none",
  ];
  if (info.url !== expected) lines.push("\n→ Not connected to this Worker. Open ?setup=1 once.");
  return lines.join("\n");
}

// ---------- Playtomic ----------
// Server errors (5xx) are retried once after 1.5 s. Refusals (403/429) are not:
// retrying them only doubles the traffic while Playtomic is saying no. The
// source state below backs off instead.
const RETRY_STATUSES = [500, 502, 503, 504];
const REFUSED_STATUSES = [403, 429];

async function availability(club, day) {
  const url = `https://playtomic.com/api/clubs/availability?tenant_id=${club.tenant}` +
              `&date=${day}&sport_id=PADEL`;
  let r;
  for (let attempt = 1; attempt <= 2; attempt++) {
    r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } });
    if (r.ok || !RETRY_STATUSES.includes(r.status) || attempt === 2) break;
    await new Promise(res => setTimeout(res, 1500));
  }
  if (!r.ok) {
    const err = new Error(`Playtomic returned ${r.status}`);
    err.status = r.status;
    err.refused = REFUSED_STATUSES.includes(r.status);
    const ra = Number(r.headers.get("Retry-After"));
    if (ra > 0) err.retryAfterMs = ra * 1000;
    throw err;
  }
  const data = await r.json();
  if (!Array.isArray(data)) throw new Error("Playtomic sent data in an unexpected format");
  return data;
}

// All free slots at one club, over its whole booking window, that either the
// watcher (your settings) or the monitor needs.
// Returns { slots: [{ key, date, time, court, startMs, line, inWatch, inMon }], monDates }.
async function scanClub(club, s, nowMs) {
  const days = upcomingDays([...new Set([...s.weekdays, ...MONITOR.days])], club.window);
  const mFrom = toMin(MONITOR.from), mTo = toMin(MONITOR.to);
  const responses = await Promise.all(days.map(d => availability(club, d.date)));
  const out = [];

  responses.forEach((courts, i) => {
    const d = days[i];
    const watchDay = s.weekdays.includes(d.wd);
    const [wFrom, wTo] = windowFor(s, d.wd).map(toMin);
    const monDay = MONITOR.days.includes(d.wd);
    for (const court of courts) {
      const name = club.courts[court.resource_id];
      if (!name || court.start_date !== d.date) continue;
      for (const slot of court.slots) {
        const t = slot.start_time;                          // UTC "HH:MM:SS"
        const m = toMin(t) + d.offset;                      // local minutes
        if (m >= 1440) continue;
        const inWatch = watchDay && m >= wFrom && m <= wTo && s.durations.includes(slot.duration);
        const inMon = monDay && m >= mFrom && m <= mTo && MONITOR.durations.includes(slot.duration);
        if (!inWatch && !inMon) continue;
        const startMs = Date.parse(`${d.date}T${t}Z`);
        if (startMs <= nowMs) continue;
        const time = hhmm(m);
        out.push({
          key: `${d.date}|${time}|${slot.duration}|${court.resource_id}`,
          date: d.date, time, wd: d.wd, duration: slot.duration, court: name, startMs, inWatch, inMon,
          line: `${d.label} ${time}-${hhmm((m + slot.duration) % 1440)} · ${name} · ${slot.price}`,
        });
      }
    }
  });
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { slots: out, monDates: days.filter(d => MONITOR.days.includes(d.wd)).map(d => d.date) };
}

async function wholeDay(club, day) {
  const offset = toMin(local(new Date(`${day}T12:00:00Z`)).time) - 720;
  const rows = [];
  for (const court of await availability(club, day)) {
    const name = club.courts[court.resource_id] || `${court.resource_id.slice(0, 8)} (not watched)`;
    if (court.start_date !== day) continue;
    for (const s of court.slots) {
      const m = toMin(s.start_time) + offset;
      if (m >= 1440) continue;
      rows.push(`${hhmm(m)}  ${String(s.duration).padStart(3)} min  ${name.padEnd(8)}  ${s.price}`);
    }
  }
  rows.sort();
  return `${club.name}: all free slots on ${day} (club time), ${rows.length} total:\n\n` +
         (rows.join("\n") || "none");
}

// ---------- your Playtomic account (read-only: it never books or cancels) ----------
// Playtomic sends match times without a timezone; they are UTC like the
// availability times. (Verify with ?bookings=1: "raw" vs the local time shown.)
const parseApiTime = s => (s ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z") : NaN);

// The token comes from the website, so the bot identifies as the website too.
function ptHeaders(token, web = true) {
  const h = { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" };
  if (web) h["X-Requested-With"] = "com.playtomic.web";
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

// Ways to ask for a renewed session. Website tokens may want a slightly
// different request than app tokens, so try these in order and remember
// which one worked.
const REFRESH_VARIANTS = [
  { web: true,  body: rt => ({ refresh_token: rt, requested_user_roles: ["ROLE_CUSTOMER"] }) },
  { web: true,  body: rt => ({ refresh_token: rt }) },
  { web: false, body: rt => ({ refresh_token: rt, requested_user_roles: ["ROLE_CUSTOMER"] }) },
  { web: true,  body: rt => ({ grant_type: "refresh_token", refresh_token: rt }) },
];

// Authenticated call to Playtomic's app interface; renews the token once on
// 401 (expired). A 403 means "not allowed", which renewing doesn't fix.
async function ptFetch(env, path, init = {}) {
  let token = await ptToken(env);
  if (!token) return null;
  let r = await fetch(PLAYTOMIC_API + path, { ...init, headers: ptHeaders(token) });
  if (r.status === 401) {
    token = await ptToken(env, { stale: true });
    r = await fetch(PLAYTOMIC_API + path, { ...init, headers: ptHeaders(token) });
  }
  if (r.status === 401 || r.status === 403) {
    const body = (await r.text()).replace(/\s+/g, " ").slice(0, 200);
    const e = new Error(`Playtomic refused ${path.split("?")[0]} (${r.status}): ${body || "no reason given"}`);
    e.status = r.status;
    throw e;
  }
  return r;
}

// Playtomic only lets its own app/website log in (device check / reCAPTCHA),
// so the bot never logs in itself. You log in once in your browser and put
// that session's token in the secret PLAYTOMIC_TOKEN; the bot then renews it
// on its own. Renewed tokens are kept in KV.
const hasAccount = env => !!(env.PLAYTOMIC_TOKEN && env.PLAYTOMIC_TOKEN.trim());

async function ptAuth(path, body, web = true) {
  const r = await fetch(PLAYTOMIC_API + path, { method: "POST", headers: ptHeaders(null, web), body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) {
    const msg = (() => { try { const j = JSON.parse(text); return j.localized_message || j.message || text; } catch { return text; } })();
    const e = new Error(`Playtomic said ${r.status}: ${String(msg).slice(0, 150)}`);
    e.status = r.status;
    throw e;
  }
  return JSON.parse(text);
}

async function shortHash(s) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].slice(0, 8).map(b => b.toString(16).padStart(2, "0")).join("");
}

// The readable part of a JWT (user id, expiry...), or null if it isn't one.
function jwtClaims(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")
      .padEnd(Math.ceil(parts[1].length / 4) * 4, "=")));
  } catch { return null; }
}

// Expiry (ms) of a JWT, or null if it isn't one.
function jwtExpiry(token) {
  const c = jwtClaims(token);
  return c && typeof c.exp === "number" ? c.exp * 1000 : null;
}

const SESSION_HELP = "Log in on playtomic.com in a private/incognito window, copy the pt_auth_refresh_token " +
  "cookie (F12 → Application → Cookies) into the PLAYTOMIC_TOKEN secret, then close that window without logging out.";

// Returns a valid access token, renewing it when needed.
async function ptToken(env, { stale = false } = {}) {
  if (!hasAccount(env)) return null;
  const seed = env.PLAYTOMIC_TOKEN.trim().replace(/^["']|["']$/g, "");   // tolerate copied quotes
  const sid = await shortHash(seed);
  let tok = await getJSON(env, "pt_token", null);
  if (tok && tok.seed !== sid) tok = null;                 // a new token was pasted: start from it
  const exp = tok && parseApiTime(tok.access_token_expiration);
  if (!stale && tok && tok.access_token && (isNaN(exp) || exp - 60000 > Date.now())) return tok.access_token;

  const rt = (tok && tok.refresh_token) || seed;
  let fresh = null, err = null, variant = 0;
  const attempts = [];
  const order = tok && Number.isInteger(tok.variant)
    ? [tok.variant, ...REFRESH_VARIANTS.keys()].filter((v, i, a) => a.indexOf(v) === i)
    : [...REFRESH_VARIANTS.keys()];
  for (const v of order) {
    try {
      fresh = await ptAuth("/v3/auth/token", REFRESH_VARIANTS[v].body(rt), REFRESH_VARIANTS[v].web);
      variant = v;
      break;
    } catch (e) {
      err = e;
      attempts.push(`#${v + 1}: ${e.message}`);
      if (e.status && e.status >= 500) break;              // Playtomic is having trouble; don't hammer it
    }
  }
  if (!fresh && attempts.length) console.log("Session renewal failed:", attempts.join(" | "));
  if (!fresh) {
    // The pasted value may be an access token rather than a refresh token:
    // use it as-is until it expires.
    if (!tok) {
      const jexp = jwtExpiry(seed);
      if (jexp === null || jexp - 60000 > Date.now()) {
        await putJSON(env, "pt_token", {
          seed: sid, access_token: seed, refresh_token: null, kind: "access",
          access_token_expiration: jexp ? new Date(jexp).toISOString().slice(0, 19) : null,
        });
        return seed;
      }
    }
    const expired = !isNaN(exp) && exp - 60000 <= Date.now();
    const why = tok && tok.kind === "access"
      ? (expired ? "The token you pasted was a short-lived one and has expired"
                 : "Playtomic didn't accept the token you pasted")
      : "Your Playtomic session was rejected";
    const detail = attempts.length ? `\nRenewal attempts: ${attempts.join(" | ")}` : "";
    const deviceBlocked = attempts.length && attempts.every(a => /verify your device/i.test(a));
    const e = new Error(deviceBlocked
      ? "Playtomic's device check also blocks renewing the session from the bot, so a pasted website " +
        `token can't be kept alive. The app route (iPhone capture) is needed for this.${detail}`
      : `${why}. ${SESSION_HELP}${detail}`);
    e.renewal = attempts;
    throw e;
  }
  await putJSON(env, "pt_token", {
    seed: sid, kind: "refresh", variant,
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token || rt,
    access_token_expiration: fresh.access_token_expiration,
  });
  return fresh.access_token;
}

// Ways to ask for your matches. Website sessions may only be allowed some of
// them (padel-cli, which also uses a website identity, filters by owner_id),
// so try in order and remember the one that works.
const MATCH_QUERIES = [
  (uid, from) => `/v1/matches?owner_id=${uid}&sort=start_date,DESC&size=50`,
  (uid, from) => `/v1/matches?user_id=me&sport_id=PADEL&from_start_date=${from}&size=50&page=0`,
  (uid, from) => `/v1/matches?player_user_id=${uid}&sort=start_date,DESC&size=50`,
];

// Your recent and upcoming padel matches, straight from Playtomic.
async function fetchMyMatches(env) {
  const token = await ptToken(env);
  if (!token) return null;
  const uid = (jwtClaims(token) || {}).sub || "me";
  const from = new Date(Date.now() - 12 * 3600000).toISOString().slice(0, 19);
  const saved = Number(await env.SEEN.get("pt_match_query"));
  const order = [saved, ...MATCH_QUERIES.keys()].filter((v, i, a) => Number.isInteger(v) && v < MATCH_QUERIES.length && a.indexOf(v) === i);
  const failures = [];
  for (const q of order) {
    try {
      const r = await ptFetch(env, MATCH_QUERIES[q](uid, from));
      if (!r.ok) { failures.push(`#${q + 1}: ${r.status} ${(await r.text()).slice(0, 120)}`); continue; }
      const data = await r.json();
      if (!Array.isArray(data)) { failures.push(`#${q + 1}: unexpected format`); continue; }
      if (q !== saved) await env.SEEN.put("pt_match_query", String(q));
      return data.filter(m => !m.sport_id || m.sport_id === "PADEL");
    } catch (e) {
      failures.push(`#${q + 1}: ${e.message}`);
      if (e.status !== 401 && e.status !== 403) break;    // not a permissions thing: don't keep trying
    }
  }
  throw new Error(`Playtomic account: couldn't read your bookings. Tries: ${failures.join(" | ")}`);
}

function toBooking(m) {
  const clubId = Object.keys(CLUBS).find(k => CLUBS[k].tenant === (m.tenant && m.tenant.tenant_id)) || null;
  const teams = Array.isArray(m.teams) ? m.teams : [];
  return {
    id: m.match_id,
    startMs: parseApiTime(m.start_date),
    endMs: parseApiTime(m.end_date),
    clubId,
    club: clubId ? CLUBS[clubId].name : (m.tenant && m.tenant.tenant_name) || "another club",
    court: m.resource_name || (m.resource && m.resource.name) || null,
    players: teams.reduce((n, t) => n + (Array.isArray(t.players) ? t.players.length : 0), 0),
    maxPlayers: teams.reduce((n, t) => n + (t.max_players || 0), 0) || 4,
    createdMs: parseApiTime(m.created_at),
    raw: m.start_date,
  };
}

const isCancelled = m => /CANCEL/i.test(`${m.status || ""} ${m.game_status || ""}`);

// Re-reads your bookings every few minutes and keeps the list in KV
// (written only when it changes). Returns { list, error }; list is null if
// the account isn't set up. An error sticks until a later read succeeds.
async function getBookings(env, nowMs, { force = false } = {}) {
  if (!hasAccount(env)) return { list: null, error: null };
  const cached = await getJSON(env, "bookings", null);
  const upcoming = l => (l || []).filter(b => b.startMs > nowMs);
  const due = force || !cached || new Date(nowMs).getUTCMinutes() % BOOKINGS_EVERY_MIN === 0;
  if (!due) return { list: upcoming(cached.list), error: cached.error || null };

  try {
    const matches = await fetchMyMatches(env);
    const list = matches.filter(m => !isCancelled(m)).map(toBooking)
      .filter(b => !isNaN(b.startMs) && b.startMs > nowMs).sort((a, b) => a.startMs - b.startMs);
    const sig = JSON.stringify(list.map(b => [b.id, b.startMs, b.clubId, b.players]));
    if (!cached || cached.sig !== sig || cached.error) await putJSON(env, "bookings", { sig, list });
    return { list, error: null };
  } catch (e) {
    if (!cached || cached.error !== e.message) {
      await putJSON(env, "bookings", { sig: cached ? cached.sig : "", list: cached ? cached.list : [], error: e.message });
    }
    return { list: cached ? upcoming(cached.list) : null, error: e.message };
  }
}

function bookingLine(b) {
  const s = local(new Date(b.startMs));
  const end = isNaN(b.endMs) ? "" : `-${local(new Date(b.endMs)).time}`;
  return `${s.label} ${s.time}${end} · ${b.club}${b.court ? ` · ${b.court}` : ""} · players ${b.players}/${b.maxPlayers}`;
}

// Per local date: the highest-ranked club you're booked at, as { rank, club }.
function bookedDays(bookings) {
  const m = new Map();
  for (const b of bookings || []) {
    const d = local(new Date(b.startMs)).date;
    const rank = b.clubId ? CLUBS[b.clubId].rank : 0;
    if (!m.has(d) || rank > m.get(d).rank) m.set(d, { rank, club: b.club });
  }
  return m;
}

// Already covered: you're booked that day at this club or a nicer one.
const coveredBy = (booked, club, date) => booked.has(date) && club.rank <= booked.get(date).rank;

// The day before each booking: a reminder, so you can find players or cancel in time.
async function bookingReminders(env, bookings, nowMs) {
  if (!bookings || !bookings.length) return;
  const now = local(new Date(nowMs));
  if (now.time < BOOKING_REMINDER_AT) return;
  const t = new Date(`${now.date}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  const tomorrow = t.toISOString().slice(0, 10);
  const due = bookings.filter(b => local(new Date(b.startMs)).date === tomorrow &&
    !(b.createdMs && nowMs - b.createdMs < 6 * 3600000));          // skip ones you only just booked
  if (!due.length) return;

  const done = new Set(await getJSON(env, "reminded_bookings", []));
  const todo = due.filter(b => !done.has(b.id));
  if (!todo.length) return;
  for (const b of todo) {
    const need = b.maxPlayers - b.players;
    await send(env,
      `📅 Tomorrow: ${bookingLine(b)}\n\n` +
      (need > 0 ? `Still ${need} spot${need === 1 ? "" : "s"} open in the app. ` : "") +
      "If you can't fill it, cancel today, before the club's free-cancellation deadline.",
      b.clubId ? [{ text: `📱 Open ${b.club} in the app`, url: appLink(CLUBS[b.clubId]) }] : []);
    done.add(b.id);
  }
  const upcoming = new Set(bookings.map(b => b.id));
  await putJSON(env, "reminded_bookings", [...done].filter(id => upcoming.has(id)));
}

// /paytest: opens a checkout (a "payment intent") for a quiet morning slot to
// see which payment options Playtomic offers this account, e.g. CASH = pay at
// the club. It never selects a method and never confirms, so nothing is
// booked; the unused checkout simply lapses.
const PT_PAYMENT_TYPES = ["OFFER", "CASH", "MERCHANT_WALLET", "DIRECT", "SWISH", "IDEAL",
  "BANCONTACT", "PAYTRAIL", "CREDIT_CARD", "QUICK_PAY"];

async function payTest(env, clubId = "hr") {
  if (!hasAccount(env)) return "Your Playtomic account isn't connected yet: add the secret PLAYTOMIC_TOKEN to the Worker.";
  const club = CLUBS[clubId];
  if (!club) return "Use /paytest hr or /paytest embassy";
  const token = await ptToken(env);
  const userId = (jwtClaims(token) || {}).sub;
  if (!userId) return "Couldn't read your user id from the session token.";

  // A free 90-min slot on a watched court, 09:00-12:00, in the next days (quiet times).
  let pick = null;
  for (const d of upcomingDays([0, 1, 2, 3, 4, 5, 6], Math.min(club.window, 6)).slice(1)) {
    for (const court of await availability(club, d.date)) {
      const name = club.courts[court.resource_id];
      if (!name || court.start_date !== d.date) continue;
      const slot = court.slots.find(s => s.duration === 90 && toMin(s.start_time) + d.offset >= 540 &&
                                         toMin(s.start_time) + d.offset <= 720);
      if (slot) { pick = { d, court, name, slot }; break; }
    }
    if (pick) break;
  }
  if (!pick) return `No quiet morning slot free at ${club.name} in the next days to test with.`;

  const startUtc = `${pick.d.date}T${pick.slot.start_time}`;
  const r = await ptFetch(env, "/v1/payment_intents", {
    method: "POST",
    body: JSON.stringify({
      allowed_payment_method_types: PT_PAYMENT_TYPES,
      user_id: String(userId),
      cart: { requested_item: {
        cart_item_type: "CUSTOMER_MATCH",
        cart_item_voucher_id: null,
        cart_item_data: {
          supports_split_payment: true,
          number_of_players: 4,
          tenant_id: club.tenant,
          resource_id: pick.court.resource_id,
          start: startUtc,
          duration: 90,
          match_registrations: [{ user_id: String(userId), pay_now: true }],
        },
      } },
    }),
  });
  const text = await r.text();
  const when = `${pick.d.label} ${hhmm(toMin(pick.slot.start_time) + pick.d.offset)} · ${pick.name} · ${club.name}`;
  if (!r.ok) return `Checkout test for ${when}: Playtomic said ${r.status}:\n${text.slice(0, 400)}`;

  let j = {};
  try { j = JSON.parse(text); } catch { /* shown raw below */ }
  const methods = Array.isArray(j.available_payment_methods) ? j.available_payment_methods : [];
  const lines = methods.map(m => `• ${m.method_type || "?"}${m.name ? ` – ${m.name}` : ""}`);
  const atClub = methods.some(m => /CASH|CLUB|ON_?SITE|VENUE/i.test(`${m.method_type} ${m.name || ""}`));
  return `🧪 Checkout test for ${when} (nothing booked, it just lapses):\n\n` +
    `Payment options Playtomic offers:\n${lines.join("\n") || "(none listed)"}\n\n` +
    (atClub ? "✅ Pay at the club is offered, so the bot can book without a card."
            : "❌ No pay-at-club option for this account/club via the website identity.") +
    (methods.length ? "" : `\n\nRaw answer (start): ${text.slice(0, 300)}`);
}

// /bookings raw: show how the bot reads your bookings (times as Playtomic
// sends them, to double-check the timezone). No tokens, no other players' details.
async function debugBookings(env) {
  if (!hasAccount(env)) {
    return "Not set up: add the secret PLAYTOMIC_TOKEN to the Worker.";
  }
  const seed = env.PLAYTOMIC_TOKEN.trim().replace(/^["']|["']$/g, "");
  const c = jwtClaims(seed);
  const about = c
    ? `Token in PLAYTOMIC_TOKEN: ${(c.scopes || []).join(",") || "?"} for ${c.username || c.sub || "?"}, ` +
      `issued for ${c.aud || "?"}, valid until ${c.exp ? new Date(c.exp * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "?"}` +
      (Array.isArray(c.scopes) && c.scopes.includes("ROLE_REFRESH_TOKEN") ? " ✓ (that's the right one)" : " ⚠️ (this isn't the refresh token)")
    : `Token in PLAYTOMIC_TOKEN doesn't look like a Playtomic token (${seed.length} characters, starts with "${seed.slice(0, 3)}…")`;
  let matches;
  try {
    matches = await fetchMyMatches(env);
  } catch (e) {
    return `${about}\n\n❌ ${e.message}`;
  }
  const q = Number(await env.SEEN.get("pt_match_query"));
  const lines = [about, "", `✅ Logged in. Playtomic returned ${matches.length} match(es)` +
    ` (request #${Number.isInteger(q) ? q + 1 : "?"} worked):`, ""];
  for (const m of matches) {
    const b = toBooking(m);
    lines.push(`${bookingLine(b)}${isCancelled(m) ? "  [CANCELLED, ignored]" : ""}`);
    lines.push(`   raw start_date: ${m.start_date}   status: ${m.status || "-"} / ${m.game_status || "-"}`);
  }
  if (matches[0]) lines.push("", "Fields Playtomic sends: " + Object.keys(matches[0]).sort().join(", "));
  await getBookings(env, Date.now(), { force: true });   // refresh the stored list too
  return lines.join("\n");
}

// ---------- the regular check ----------
// ---------- data source health: back off when Playtomic refuses us ----------
// ok:       normal checks every minute.
// blocked:  Playtomic answered 403/429. No full checks; after each pause one
//           single test request decides whether to resume. Pauses grow
//           1 -> 5 -> 15 min (+-20% random), then every 15 min; reset on the first
//           success. Capped at 15 min so a lifted block costs at most ~15 min of alerts.
// You get one message once a block has lasted BLOCK_NOTIFY_MIN, and one when
// it ends (only if you were told it started).
const BACKOFF_MIN = [1, 5, 15];
const BLOCK_NOTIFY_MIN = 10;
const SOURCE_DEFAULT = { state: "ok", level: 0, since: null, nextTry: 0, lastError: null, notified: false };
async function getSource(env) { return { ...SOURCE_DEFAULT, ...(await getJSON(env, "source", {})) }; }
const jitter = ms => Math.round(ms * (0.8 + Math.random() * 0.4));

function sourceBlocked(src, err, nowMs) {
  const level = src.state === "blocked" ? Math.min(src.level + 1, BACKOFF_MIN.length - 1) : 0;
  const wait = Math.max(jitter(BACKOFF_MIN[level] * 60000), err.retryAfterMs || 0);
  return { ...src, state: "blocked", level, since: src.state === "blocked" ? src.since : nowMs,
           nextTry: nowMs + wait, lastError: err.message };
}

function describeSource(src) {
  if (src.state !== "blocked") return "✅ answering";
  const next = local(new Date(src.nextTry)).time;
  return `⛔ refusing the bot since ${local(new Date(src.since)).label} ${local(new Date(src.since)).time} ` +
         `(${src.lastError}); paused, next test at ${next}`;
}

// A slot that became bookable in the last 30 min (the club's booking window
// just reached it) is a new release, not a cancellation. Releases on workdays
// are rare (people book those by phone weeks ahead), so they alert right away,
// marked 🆕. On the weekdays listed here, only releases at these start times
// alert (Fridays are easy to get; 18:00 is the one worth grabbing).
const RELEASE_MUTE_MS = 30 * 60000;
const RELEASE_TIMES_BY_WEEKDAY = { 5: ["18:00"] };      // 0 = Sun ... 5 = Fri
const justReleased = (club, x, nowMs) => {
  const age = nowMs - (x.startMs - club.window * 86400000);
  return age >= 0 && age <= RELEASE_MUTE_MS;
};
const ignoredRelease = (club, x, nowMs) => {
  if (!justReleased(club, x, nowMs)) return false;
  const times = RELEASE_TIMES_BY_WEEKDAY[new Date(`${x.date}T12:00:00Z`).getUTCDay()];
  return !!times && !times.includes(x.time);
};

async function check(env, { force = false } = {}) {
  const s = await getSettings(env);
  const nowMs = Date.now();
  const today = local(new Date(nowMs)).date;
  const result = {};
  const errors = [];
  const scans = {};
  let alertsSent = 0;
  let urgency = null;          // learned "how fast do slots like this go", loaded only when needed

  // Your own bookings (if the account is connected): days you're already
  // covered are skipped, except for nicer clubs. Only for you, the owner.
  const { list: bookings, error: bookingsError } = await getBookings(env, nowMs, { force });
  if (bookingsError) errors.push(bookingsError);
  const booked = bookedDays(bookings);
  if (bookings) result["Your bookings"] = bookings.map(bookingLine);

  // Everyone who gets alerts: you, plus approved people.
  const users = await getUsers(env);
  const people = [{ chatId: String(env.TELEGRAM_CHAT_ID), owner: true, name: "you", s }];
  for (const [chatId, u] of Object.entries(users)) {
    if (u.status === "approved" && !isOwner(env, chatId)) {
      people.push({ chatId, owner: false, name: userLabel(u), s: await userSettings(env, chatId) });
    }
  }
  const scanWith = combinedSettings(people.map(p => p.s));

  // Is Playtomic answering? While it refuses us, skip the checks until the
  // pause is over, then send one single test request before a full check.
  let src = await getSource(env);
  const wasBlocked = src.state === "blocked";
  let skip = false;
  if (wasBlocked && nowMs < src.nextTry) {
    skip = true;
  } else if (wasBlocked) {
    try {
      const testClub = Object.values(CLUBS)[0];
      await availability(testClub, upcomingDays(scanWith.weekdays, testClub.window)[0]?.date || local(new Date(nowMs)).date);
    } catch (e) {
      if (e.refused) { src = sourceBlocked(src, e, nowMs); skip = true; }
    }
  }
  if (skip) errors.push(`Paused: Playtomic is refusing requests (${src.lastError}); next test at ${local(new Date(src.nextTry)).time}`);

  // One scan per club, shared by everybody.
  for (const [id, club] of Object.entries(CLUBS)) {
    if (skip) break;
    try {
      scans[id] = await scanClub(club, scanWith, nowMs);
    } catch (e) {
      errors.push(`${club.name}: ${e.message}`);
      result[club.name] = { error: e.message };
      if (e.refused) {
        src = sourceBlocked(src, e, nowMs);
        skip = true;
        break;                                     // don't ask for the next club either
      }
    }
  }
  if (!skip && Object.keys(scans).length) {
    if (wasBlocked && src.notified) {
      await send(env, `✅ Playtomic is answering the bot again (it refused requests for ${fmtDuration(nowMs - src.since)}). ` +
        "Back to checks every minute.");
    }
    src = { ...SOURCE_DEFAULT };
  }
  // Tell the owner once, when a block has lasted long enough to matter.
  if (src.state === "blocked" && !src.notified && nowMs - src.since >= BLOCK_NOTIFY_MIN * 60000) {
    await send(env, `⛔ Playtomic has been refusing the bot for ${fmtDuration(nowMs - src.since)} (${src.lastError}).\n\n` +
      `I've stopped sending requests and will test again with a single request after growing pauses ` +
      `(${BACKOFF_MIN.join(" → ")} min). Next test at ${local(new Date(src.nextTry)).time}. ` +
      "I'll tell you as soon as it answers again. /report, /stats and your settings keep working.");
    src = { ...src, notified: true };
  }
  // Only write when something changed (KV writes are limited on the free plan).
  const before = await getJSON(env, "source", null);
  if (JSON.stringify(before || SOURCE_DEFAULT) !== JSON.stringify(src)) {
    if (src.state === "ok") await env.SEEN.delete("source");
    else await putJSON(env, "source", src);
  }

  for (const person of people) {
    const ps = person.s;
    const notifying = !ps.paused || (force && person.owner);
    const seen = new Set(await getJSON(env, seenKey(env, person.chatId), []));
    const alerted = await getJSON(env, alertedKey(env, person.chatId), {});
    let alertedChanged = false;
    for (const k of Object.keys(alerted)) {
      if (nowMs - alerted[k] > REPEAT_QUIET_MS) { delete alerted[k]; alertedChanged = true; }
    }
    const keep = [];
    const mine = person.owner ? booked : new Map();
    const out = {};
    for (const [id, club] of Object.entries(CLUBS)) {
      if (!scans[id]) {
        // Keep what we already knew for this club, so nothing is re-sent after recovery.
        const ids = Object.keys(club.courts);
        keep.push(...[...seen].filter(k => ids.some(cid => k.endsWith(cid))));
        continue;
      }
      try {
        const all = scans[id].slots.filter(x => fits(ps, x));
        const watch = all.filter(x => !coveredBy(mine, club, x.date));
        // Nothing for today: a slot that frees up on the day itself is too late to plan around.
        const fresh = watch.filter(x => !seen.has(x.key) && x.date !== today && !alerted[x.key] &&
          !ignoredRelease(club, x, nowMs));
        if (fresh.length && notifying) {
          for (const x of fresh) alerted[x.key] = nowMs;
          alertedChanged = true;
          const atClub = x => (mine.has(x.date) ? ` (you're at ${mine.get(x.date).club} that day)` : "");
          const released = fresh.filter(x => justReleased(club, x, nowMs));
          const cancelled = fresh.filter(x => !justReleased(club, x, nowMs));
          if (cancelled.length) {
            urgency = urgency || await urgencyTable(env, nowMs);
            const lines = cancelled.map(x => x.line + atClub(x) + urgencyNote(urgency, id, x.startMs - nowMs));
            await send(env, `🎾 Free padel slot at ${club.name}!\n\n` + lines.join("\n"), dateButtons(club, cancelled),
              { chatId: person.chatId });
          }
          if (released.length) {
            const lines = released.map(x => x.line + atClub(x));
            await send(env, `🆕 Just opened for booking at ${club.name} (${club.window} days ahead):\n\n` + lines.join("\n"),
              dateButtons(club, released), { chatId: person.chatId });
          }
          alertsSent += fresh.length;
        }
        // Skipped slots are not marked as notified: if that booking gets
        // cancelled, you'll hear about them after all.
        keep.push(...watch.map(x => x.key));
        out[club.name] = {
          matching: watch.map(x => x.line),
          new: notifying ? fresh.map(x => x.line) : [],
          ignoredReleases: watch.filter(x => !seen.has(x.key) && ignoredRelease(club, x, nowMs)).map(x => x.line),
          skippedBecauseBooked: all.filter(x => coveredBy(mine, club, x.date)).map(x => x.line),
        };
      } catch (e) {
        // A failed message (e.g. someone blocked the bot) must not stop the others.
        console.log(`Alert for ${person.name} failed:`, e.message);
        const ids = Object.keys(club.courts);
        keep.push(...[...seen].filter(k => ids.some(cid => k.endsWith(cid))));
      }
    }
    // While paused, leave "already notified" alone so you hear about
    // everything that's free once you /resume.
    if (notifying) {
      keep.sort();
      const changed = keep.length !== seen.size || keep.some(k => !seen.has(k));
      if (changed) await putJSON(env, seenKey(env, person.chatId), keep);
      if (alertedChanged) await putJSON(env, alertedKey(env, person.chatId), alerted);
    }
    if (person.owner) Object.assign(result, ps.paused && !force ? { paused: true } : out);
    else (result.others = result.others || {})[person.name] = ps.paused ? { paused: true } : out;
  }

  if (src.state === "blocked") {
    // The block has its own messages; reset the generic error alert silently.
    const health = await getJSON(env, "health", null);
    if (health && health.failing) await putJSON(env, "health", { failing: false, alerted: false, lastAlert: 0, since: null });
  } else {
    await handleHealth(env, errors);
  }

  if (!force) {
    try { await weeklyReport(env, s); } catch (e) { console.log("Weekly report failed:", e.message); }
  }
  if (!force && !s.paused && s.remind) {
    try { await releaseReminder(env, s, booked); } catch (e) { console.log("Reminder failed:", e.message); }
  }
  if (!force) {
    try { await bookingReminders(env, bookings, nowMs); } catch (e) { console.log("Booking reminder failed:", e.message); }
  }

  try {
    await recordMonitor(env, scans, nowMs);
  } catch (e) {
    console.log("Cancellation monitor failed:", e.message);
  }
  // Log scheduled runs (not manual ones) for /metrics.
  if (!force) {
    try { await recordRun(env, nowMs, errors.length === 0, Date.now() - nowMs, alertsSent); }
    catch (e) { console.log("Run log failed:", e.message); }
  }
  return result;
}

// Heads-up shortly before the evening slots you care about become bookable.
// A slot opens exactly `window` days before it starts, at the same clock time,
// so today at 17:30 Padel.hr opens the 17:30 slot three weeks from today.
function releasePlan(s, nowDate = new Date()) {
  const today = local(nowDate).date;
  const plan = [];
  for (const club of Object.values(CLUBS)) {
    if (!club.remind) continue;
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + club.window);
    if (!s.weekdays.includes(d.getUTCDay())) continue;
    plan.push({ club, date: d.toISOString().slice(0, 10), label: local(d).label });
  }
  return plan;
}

async function releaseReminder(env, s, booked = new Map()) {
  const now = local(new Date());
  const plan = releasePlan(s).filter(p => !coveredBy(booked, p.club, p.date));
  if (!plan.length) return;
  const wins = plan.map(p => windowFor(s, new Date(`${p.date}T12:00:00Z`).getUTCDay()).map(toMin));
  const from = Math.min(...wins.map(w => w[0])), to = Math.max(...wins.map(w => w[1]));
  const at = hhmm(Math.max(0, from - REMIND_MIN_BEFORE));
  if (now.time < at || now.time >= hhmm(from)) return;
  if ((await env.SEEN.get("reminded")) === now.date) return;
  await env.SEEN.put("reminded", now.date);           // once a day, even if a run repeats

  const starts = [];
  for (let m = from; m <= to; m += 30) starts.push(hhmm(m));
  await send(env,
    `⏰ Release in ${REMIND_MIN_BEFORE} min\n\n` +
    plan.map(p => `${p.club.name}: ${p.label} (${p.club.window} days ahead)`).join("\n") +
    `\n\nEach start time unlocks at that exact time today: ${starts.join(", ")}. ` +
    "Have the app open on that day and book the moment it appears.",
    plan.map(p => ({ text: `📱 Open ${p.club.name} in the app (${p.label})`, url: appLink(p.club) })));
}

// Error alerts: only when checks keep failing for ALERT_AFTER_MIN minutes in a
// row (short blips at Playtomic stay silent), then at most once an hour.
// "Working again" is only sent if you were actually warned.
async function handleHealth(env, errors) {
  const health = await getJSON(env, "health", { failing: false, alerted: false, lastAlert: 0, since: null });
  const now = Date.now();

  if (errors.length) {
    const since = health.failing && health.since ? health.since : now;
    const longEnough = now - since >= ALERT_AFTER_MIN * 60000;
    const due = !health.alerted || now - health.lastAlert > ERROR_ALERT_EVERY_MIN * 60000;
    const last = errors.join("; ");
    if (longEnough && due) {
      await send(env, `⚠️ Padel watcher has had a problem for ${fmtDuration(now - since)}:\n\n` + errors.join("\n") +
        "\n\nI'll keep trying and tell you when it's fixed. If it lasts, Playtomic may have changed something.");
      await putJSON(env, "health", { failing: true, alerted: true, lastAlert: now, since, last });
    } else if (!health.failing) {
      await putJSON(env, "health", { failing: true, alerted: false, lastAlert: 0, since: now, last });
    }
  } else if (health.failing) {
    if (health.alerted) {
      await send(env, `✅ Padel watcher is working again (problem lasted ${fmtDuration(now - health.since)}).`);
    }
    await putJSON(env, "health", { failing: false, alerted: false, lastAlert: 0, since: null });
  }
}

// ---------- cancellation monitor (D1) ----------
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      club TEXT NOT NULL, slot TEXT NOT NULL, day TEXT NOT NULL, time TEXT NOT NULL,
      court TEXT NOT NULL, start_ms INTEGER NOT NULL, opened_ms INTEGER NOT NULL,
      closed_ms INTEGER, kind TEXT NOT NULL, outcome TEXT)`),
    db.prepare("CREATE INDEX IF NOT EXISTS episodes_open ON episodes (club, closed_ms)"),
    db.prepare("CREATE INDEX IF NOT EXISTS episodes_opened ON episodes (opened_ms)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS runs (
      minute INTEGER PRIMARY KEY, at_ms INTEGER NOT NULL, ok INTEGER NOT NULL,
      took_ms INTEGER, alerts INTEGER)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS scanned_days (
      club TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY (club, day))`),
  ]);
  schemaReady = true;
}

// Each time a slot in the monitor window becomes free we open an "episode";
// when it disappears again (someone booked it) we close it. Writes happen
// only when something changes.
//   kind:    initial  = already free when we first looked at that day (ignored in stats)
//            release  = appeared right when the club's booking window reached it
//            reopened = became free any other time -> a cancellation
//   outcome: taken | unbooked (start time passed while still free) | unwatched
const RELEASE_TOLERANCE_MS = 10 * 60000;

// After a gap in good data (e.g. a block), slots that disappeared were taken at
// an unknown time: logged as "unwatched" so they don't distort the speed stats.
const MONITOR_GAP_MS = 5 * 60000;
async function recordMonitor(env, scans, nowMs) {
  const db = env.DB;
  if (!db) return;
  await ensureSchema(db);
  const writes = [];
  let lastGood;

  for (const [clubId, { slots, monDates }] of Object.entries(scans)) {
    const windowMs = CLUBS[clubId].window * 86400000;
    const current = new Map(slots.filter(x => x.inMon).map(x => [x.key, x]));
    const [openRes, scannedRes] = await db.batch([
      db.prepare("SELECT id, slot, start_ms FROM episodes WHERE club = ? AND closed_ms IS NULL").bind(clubId),
      db.prepare("SELECT day FROM scanned_days WHERE club = ? AND day >= ?").bind(clubId, monDates[0] || "9999"),
    ]);
    const open = new Map(openRes.results.map(r => [r.slot, r]));
    const scanned = new Set(scannedRes.results.map(r => r.day));
    if (lastGood === undefined) {
      const row = await db.prepare("SELECT MAX(at_ms) AS t FROM runs WHERE ok = 1").first();
      lastGood = (row && row.t) || nowMs;
    }
    const afterGap = nowMs - lastGood > MONITOR_GAP_MS;

    for (const [slot, r] of open) {
      if (current.has(slot)) continue;
      let outcome = "taken", closed = nowMs;
      if (r.start_ms <= nowMs) { outcome = "unbooked"; closed = r.start_ms; }
      else if (!monDates.includes(slot.slice(0, 10))) outcome = "unwatched";
      else if (afterGap) { outcome = "unwatched"; closed = lastGood; }   // taken some time during the gap
      writes.push(db.prepare("UPDATE episodes SET closed_ms = ?, outcome = ? WHERE id = ?")
        .bind(closed, outcome, r.id));
    }

    const newByDay = new Map();
    for (const [slot, x] of current) {
      if (open.has(slot)) continue;
      if (!newByDay.has(x.date)) newByDay.set(x.date, []);
      newByDay.get(x.date).push(x);
    }
    for (const [day, list] of newByDay) {
      for (const x of list) {
        const sinceRelease = nowMs - (x.startMs - windowMs);
        const kind = !scanned.has(day) ? "initial"
                   : sinceRelease >= 0 && sinceRelease <= RELEASE_TOLERANCE_MS ? "release" : "reopened";
        writes.push(db.prepare(`INSERT INTO episodes
          (club, slot, day, time, court, start_ms, opened_ms, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(clubId, x.key, x.date, x.time, x.court, x.startMs, nowMs, kind));
      }
    }
    for (const day of monDates) {
      if (!scanned.has(day)) {
        writes.push(db.prepare("INSERT OR IGNORE INTO scanned_days (club, day) VALUES (?, ?)").bind(clubId, day));
      }
    }
  }

  // Tidy up old history about once a day.
  if (Math.random() < 1 / 900) {
    const cutoff = nowMs - KEEP_HISTORY_DAYS * 86400000;
    writes.push(db.prepare("DELETE FROM episodes WHERE closed_ms IS NOT NULL AND closed_ms < ?").bind(cutoff));
    writes.push(db.prepare("DELETE FROM runs WHERE at_ms < ?").bind(nowMs - 14 * 86400000));
  }
  if (writes.length) await db.batch(writes);
}

// ---------- run log for /metrics (D1) ----------
// The schedule is the Cron Trigger "* 6-21 * * *": every minute, 06:00-21:59 UTC.
const CRON_HOURS_UTC = [6, 21];
const inSchedule = ms => { const h = new Date(ms).getUTCHours(); return h >= CRON_HOURS_UTC[0] && h <= CRON_HOURS_UTC[1]; };

async function recordRun(env, nowMs, ok, tookMs, alerts) {
  if (!env.DB) return;
  await ensureSchema(env.DB);
  await env.DB.prepare("INSERT OR REPLACE INTO runs (minute, at_ms, ok, took_ms, alerts) VALUES (?, ?, ?, ?, ?)")
    .bind(Math.floor(nowMs / 60000), nowMs, ok ? 1 : 0, tookMs, alerts).run();
}

async function metrics(env) {
  if (!env.DB) {
    return "/metrics needs the padel-history database: Cloudflare → Storage & databases → D1 → create " +
      "'padel-history', then padel-watcher → Settings → Bindings → add D1 database with variable name DB.";
  }
  await ensureSchema(env.DB);
  const now = Date.now();
  const { results } = await env.DB.prepare("SELECT at_ms, ok, took_ms, alerts FROM runs WHERE at_ms > ? ORDER BY at_ms")
    .bind(now - 86400000).all();
  if (!results.length) {
    return "📈 No scheduled checks logged in the last 24 hours.\n\nIf you just connected the database, wait a few " +
      "minutes. Otherwise check that padel-watcher → Settings → Trigger Events has the Cron Trigger * 6-21 * * *";
  }

  let expected24 = 0, expected1 = 0;
  for (let m = Math.floor(now / 60000) - 1439; m <= Math.floor(now / 60000); m++) {
    if (inSchedule(m * 60000)) { expected24++; if (m > Math.floor(now / 60000) - 60) expected1++; }
  }
  const last = results[results.length - 1];
  const lastHour = results.filter(r => r.at_ms > now - 3600000);
  const failed = results.filter(r => !r.ok).length;
  const alerts = results.reduce((n, r) => n + (r.alerts || 0), 0);

  // Longest gap between checks during scheduled hours (overnight pause doesn't count).
  let gap = 0, gapAt = null;
  for (let i = 1; i < results.length; i++) {
    const a = results[i - 1].at_ms, b = results[i].at_ms;
    if (local(new Date(a)).date === local(new Date(b)).date && inSchedule(a) && inSchedule(b) && b - a > gap) {
      gap = b - a; gapAt = a;
    }
  }
  const sinceLast = now - last.at_ms;
  const stale = inSchedule(now) && sinceLast > 3 * 60000;
  const pct = n => (expected24 ? Math.min(100, Math.round(100 * n / expected24)) : 0);
  const avgMs = Math.round(results.reduce((n, r) => n + (r.took_ms || 0), 0) / results.length);

  return [
    `📈 Watcher metrics`,
    `Last check: ${local(new Date(last.at_ms)).label} ${local(new Date(last.at_ms)).time} ` +
      `(${fmtDuration(sinceLast)} ago) ${last.ok ? "✅" : "⚠️"}` + (stale ? "  ← overdue!" : ""),
    `Last hour: ${lastHour.length}/${expected1} checks`,
    `Last 24 h: ${results.length}/${expected24} checks (${pct(results.length)}%)` + (failed ? `, ${failed} with errors` : ", no errors"),
    gap > 3 * 60000
      ? `Longest gap: ${fmtDuration(gap)} after ${local(new Date(gapAt)).time}`
      : "No gaps longer than 3 min",
    `Alerts sent in 24 h: ${alerts}`,
    `Average check time: ${(avgMs / 1000).toFixed(1)} s`,
    "",
    `Schedule: every minute, ${local(new Date(new Date(now).setUTCHours(CRON_HOURS_UTC[0], 0, 0, 0))).time}–` +
      `${local(new Date(new Date(now).setUTCHours(CRON_HOURS_UTC[1], 59, 0, 0))).time} your time.`,
  ].join("\n");
}

// ---------- urgency: how fast do slots like this usually go? ----------
// Learned from the cancellation log: per club and "how far ahead" bucket, the
// median time a reopened slot stayed free before someone booked it.
const LEAD_BUCKETS = [
  { max: 6 * 3600000, label: "less than 6 h before start" },
  { max: 24 * 3600000, label: "6–24 h before start" },
  { max: 3 * 86400000, label: "1–3 days before start" },
  { max: Infinity, label: "more than 3 days before start" },
];
const URGENCY_MIN_SAMPLES = 5;
const leadBucket = ms => LEAD_BUCKETS.findIndex(b => ms < b.max);

async function urgencyTable(env, nowMs) {
  const table = new Map();
  if (!env.DB) return table;
  await ensureSchema(env.DB);
  const { results } = await env.DB.prepare(`SELECT club, start_ms, opened_ms, closed_ms, outcome FROM episodes
    WHERE kind = 'reopened' AND opened_ms > ?`).bind(nowMs - 30 * 86400000).all();
  for (const r of results) {
    // How long it stayed free: until booked, until it started (nobody booked it),
    // or until now if it's still free (a lower bound, good enough here).
    const freeMs = r.outcome === "taken" ? r.closed_ms - r.opened_ms
                 : r.outcome === "unbooked" ? r.start_ms - r.opened_ms
                 : r.closed_ms ? r.closed_ms - r.opened_ms : nowMs - r.opened_ms;
    const key = `${r.club}|${leadBucket(r.start_ms - r.opened_ms)}`;
    if (!table.has(key)) table.set(key, []);
    table.get(key).push(freeMs);
  }
  return table;
}

function urgencyNote(table, clubId, leadMs) {
  const samples = table && table.get(`${clubId}|${leadBucket(leadMs)}`);
  if (!samples || samples.length < URGENCY_MIN_SAMPLES) return "";
  const med = median(samples);
  const n = samples.length;
  if (med <= 5 * 60000) return `\n   🔥 usually rebooked within ~${Math.max(1, Math.round(med / 60000))} min (${n} similar)`;
  if (med <= 60 * 60000) return `\n   ⏳ usually lasts ~${Math.round(med / 60000)} min (${n} similar)`;
  return `\n   🧊 usually stays free for hours (${n} similar)`;
}

// ---------- report with charts (/report, and every Monday 08:00) ----------
// Charts are drawn by QuickChart (quickchart.io) from the numbers in the URL;
// Telegram fetches the images itself. Only counts are sent, nothing personal.
const REPORT_WEEKDAY = 1, REPORT_AT = "08:00";       // Monday 08:00 local
const CLUB_COLORS = { embassy: "#e4572e", hr: "#2e86ab" };

const chartUrl = cfg => "https://quickchart.io/chart?w=720&h=420&bkg=white&c=" + encodeURIComponent(JSON.stringify(cfg));

// Speed classes shared by the alert labels and the label check:
// 0 = fast (gone within 5 min), 1 = minutes (within 1 h), 2 = hours.
const speedClass = ms => (ms <= 5 * 60000 ? 0 : ms <= 60 * 60000 ? 1 : 2);

// How long a slot stayed free: until booked, or until it started (nobody booked it).
const freeTime = r => r.outcome === "taken" ? r.closed_ms - r.opened_ms
                    : r.outcome === "unbooked" ? r.start_ms - r.opened_ms : null;

// Label check: replay history and, for every cancellation, work out which label
// the alert would have shown using only what was known at that moment, then
// compare it with what really happened.
function replayLabels(reopened, fromMs) {
  const ends = [];
  for (const r of reopened) {
    const f = freeTime(r);
    if (f !== null) ends.push({ at: r.opened_ms + f, key: `${r.club}|${leadBucket(r.start_ms - r.opened_ms)}`, f });
  }
  ends.sort((a, b) => a.at - b.at);
  const known = new Map();
  const out = [];
  let j = 0;
  for (const e of reopened) {                                   // sorted by opened_ms
    while (j < ends.length && ends[j].at <= e.opened_ms) {
      const x = ends[j++];
      if (!known.has(x.key)) known.set(x.key, []);
      const arr = known.get(x.key);
      let i = arr.length;
      while (i > 0 && arr[i - 1] > x.f) i--;                    // keep sorted
      arr.splice(i, 0, x.f);
    }
    if (e.opened_ms <= fromMs) continue;
    const actual = freeTime(e);
    const s = known.get(`${e.club}|${leadBucket(e.start_ms - e.opened_ms)}`);
    if (actual === null || !s || s.length < URGENCY_MIN_SAMPLES) continue;
    const mid = Math.floor(s.length / 2);
    const med = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    out.push({ club: e.club, said: speedClass(med), was: speedClass(actual) });
  }
  return out;
}

async function buildReport(env, s, days = 7) {
  if (!env.DB) return null;
  await ensureSchema(env.DB);
  const DAY = 86400000;
  const now = Date.now(), since = now - days * DAY, prevSince = since - days * DAY;
  // Cancellations from the previous period (trend) and up to 30 days before (label check).
  const { results: hist } = await env.DB.prepare(`SELECT club, time, start_ms, opened_ms, closed_ms, kind, outcome
    FROM episodes WHERE kind IN ('reopened', 'release') AND opened_ms > ? ORDER BY opened_ms`)
    .bind(Math.min(prevSince, since - 30 * DAY)).all();
  const runRow = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(ok = 0) AS failed, SUM(alerts) AS alerts FROM runs WHERE at_ms > ?")
    .bind(since).first();
  const firstRun = await env.DB.prepare("SELECT MIN(t) AS t FROM (SELECT MIN(at_ms) AS t FROM runs UNION ALL SELECT MIN(opened_ms) FROM episodes)").first();
  const dataFrom = (firstRun && firstRun.t) || now;

  const reopened = hist.filter(e => e.kind === "reopened");
  const eps = reopened.filter(e => e.opened_ms > since);
  const prev = reopened.filter(e => e.opened_ms > prevSince && e.opened_ms <= since);
  const released = hist.filter(e => e.kind === "release" && e.opened_ms > since);

  const clubIds = Object.keys(CLUBS);
  const hours = [...Array(16)].map((_, i) => 7 + i);                  // 07..22
  const wdNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const byHour = Object.fromEntries(clubIds.map(c => [c, hours.map(() => 0)]));
  const byWd = Object.fromEntries(clubIds.map(c => [c, wdNames.map(() => 0)]));
  const speedLabels = ["≤1 min", "≤5 min", "≤15 min", "≤1 h", "≤6 h", "longer", "never rebooked"];
  const speed = Object.fromEntries(clubIds.map(c => [c, speedLabels.map(() => 0)]));
  const freeMin = Object.fromEntries(clubIds.map(c => [c, []]));
  let inWindow = 0;

  for (const e of eps) {
    const o = local(new Date(e.opened_ms));
    const h = Number(o.time.slice(0, 2));
    if (h >= 7 && h <= 22) byHour[e.club][h - 7]++;
    const wd = (new Date(`${o.date}T12:00:00Z`).getUTCDay() + 6) % 7;   // Mon = 0
    byWd[e.club][wd]++;
    if (e.outcome === "taken") {
      const m = (e.closed_ms - e.opened_ms) / 60000;
      freeMin[e.club].push(m);
      speed[e.club][m <= 1.5 ? 0 : m <= 5 ? 1 : m <= 15 ? 2 : m <= 60 ? 3 : m <= 360 ? 4 : 5]++;
    } else if (e.outcome === "unbooked") {
      speed[e.club][6]++;
    }
    const st = local(new Date(e.start_ms));
    const stWd = new Date(`${st.date}T12:00:00Z`).getUTCDay();
    const [wf, wt] = windowFor(s, stWd);
    if (s.weekdays.includes(stWd) && st.time >= wf && st.time <= wt) inWindow++;
  }

  const ds = series => clubIds.map(c => ({ label: CLUBS[c].name, data: series[c], backgroundColor: CLUB_COLORS[c] || "#888" }));
  const stacked = { xAxes: [{ stacked: true }], yAxes: [{ stacked: true, ticks: { beginAtZero: true, precision: 0 } }] };
  const intY = { yAxes: [{ ticks: { beginAtZero: true, precision: 0 } }] };
  const charts = [];
  if (eps.length) charts.push(
    chartUrl({ type: "bar", data: { labels: hours.map(h => `${String(h).padStart(2, "0")}h`), datasets: ds(byHour) },
      options: { title: { display: true, text: `When do cancellations happen? (time of day, last ${days} days)` }, scales: stacked } }),
    chartUrl({ type: "bar", data: { labels: wdNames, datasets: ds(byWd) },
      options: { title: { display: true, text: `Cancellations by weekday (last ${days} days)` }, scales: stacked } }),
    chartUrl({ type: "bar", data: { labels: speedLabels, datasets: ds(speed) },
      options: { title: { display: true, text: "How fast cancelled evening slots get rebooked" }, scales: intY } }),
  );

  // Text summary
  const sum = arr => arr.reduce((a, b) => a + b, 0);
  const peakIdx = arr => arr.indexOf(Math.max(...arr));
  const pct = (a, b) => (b ? Math.round(100 * a / b) : 0);
  const allHour = hours.map((_, i) => sum(clubIds.map(c => byHour[c][i])));
  const allWd = wdNames.map((_, i) => sum(clubIds.map(c => byWd[c][i])));
  const lines = [`📊 Padel report, last ${days} days`];
  const from = Math.max(since, dataFrom);
  if (now - from < days * DAY - 3600000) lines.push(`(data since ${local(new Date(from)).label} ${local(new Date(from)).time})`);
  lines.push("", "🔁 Cancelled evening slots (16:00–21:00 starts, 90 min, doubles):");
  for (const c of clubIds) {
    const n = eps.filter(e => e.club === c).length;
    const f = freeMin[c];
    const fast = f.filter(m => m <= 5).length;
    lines.push(`• ${CLUBS[c].name}: ${n}` + (f.length
      ? ` · typically rebooked in ${fmtDuration(median(f) * 60000)} · ${pct(fast, f.length)}% within 5 min`
      : ""));
  }
  if (eps.length) {
    const wdLong = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];
    lines.push(`• Most cancellations: ${wdLong[peakIdx(allWd)]}, around ${String(hours[peakIdx(allHour)]).padStart(2, "0")}:00`);
  }

  // 📈 Trend: this period vs the one before.
  lines.push("");
  if (dataFrom > prevSince + 3600000) {
    const ready = local(new Date(dataFrom + 2 * days * DAY));
    lines.push(`📈 Trend: not enough history yet to compare with the ${days} days before (from ${ready.label}).`);
  } else {
    const arrow = (a, b) => (a > b ? "↑" : a < b ? "↓" : "→");
    const change = (a, b) => (b ? ` (${a >= b ? "+" : ""}${Math.round(100 * (a - b) / b)}%)` : "");
    lines.push(`📈 Trend vs the ${days} days before:`);
    for (const c of clubIds) {
      const a = eps.filter(e => e.club === c).length, b = prev.filter(e => e.club === c).length;
      lines.push(`• ${CLUBS[c].name}: ${a} ${arrow(a, b)} from ${b}${change(a, b)}`);
    }
    const perDay = (list, start) => {
      const d = [...Array(days)].map(() => 0);
      for (const e of list) d[Math.min(days - 1, Math.floor((e.opened_ms - start) / DAY))]++;
      return d;
    };
    const labels = [...Array(days)].map((_, i) => local(new Date(since + (i + 1) * DAY - 1)).label);
    charts.push(chartUrl({ type: "line", data: { labels, datasets: [
      { label: `Last ${days} days`, data: perDay(eps, since), borderColor: "#e4572e", backgroundColor: "#e4572e", fill: false },
      { label: `${days} days before (same weekday)`, data: perDay(prev, prevSince), borderColor: "#999", backgroundColor: "#999", borderDash: [6, 4], fill: false },
    ] }, options: { title: { display: true, text: "Cancellations per day: this period vs the one before" }, scales: intY } }));
  }

  // 🏷 Label check: were the 🔥/⏳/🧊 labels right?
  const checks = replayLabels(reopened, since);
  lines.push("");
  if (!checks.length) {
    lines.push(`🏷 Label check: not enough history yet (a label needs ${URGENCY_MIN_SAMPLES} similar past cancellations).`);
  } else {
    const right = checks.filter(x => x.said === x.was).length;
    const parts = [["🔥", "gone within 5 min"], ["⏳", "gone in 5–60 min"], ["🧊", "free for 1 h+"]].map(([icon, what], k) => {
      const said = checks.filter(x => x.said === k);
      return said.length ? `${icon} ${said.filter(x => x.was === k).length}/${said.length} really ${what}` : null;
    }).filter(Boolean);
    lines.push(`🏷 Label check: right ${pct(right, checks.length)}% of the time (${right}/${checks.length} cancellations replayed)`);
    lines.push(`   ${parts.join(" · ")}`);
    const wasNames = ["Really gone ≤5 min", "Really gone 5–60 min", "Really free 1 h+"];
    const wasColors = ["#e4572e", "#f3a712", "#2e86ab"];
    charts.push(chartUrl({ type: "bar", data: { labels: ["Label said: fast", "Label said: ~minutes", "Label said: hours"],
      datasets: wasNames.map((label, w) => ({ label, backgroundColor: wasColors[w],
        data: [0, 1, 2].map(k => checks.filter(x => x.said === k && x.was === w).length) })) },
      options: { title: { display: true, text: "Were the alert labels right?" }, scales: stacked } }));
  }

  // 🆕 New-day release race: how fast freshly bookable evening slots disappear.
  lines.push("", "🆕 New slots at release (when the booking window reaches them):");
  const startTimes = [...new Set(released.map(r => r.time))].sort();
  for (const c of clubIds) {
    const rows = released.filter(r => r.club === c);
    const gone = rows.filter(r => r.outcome === "taken").map(r => r.closed_ms - r.opened_ms);
    if (!rows.length) { lines.push(`• ${CLUBS[c].name}: none seen free at release`); continue; }
    lines.push(`• ${CLUBS[c].name}: ${rows.length} seen free` + (gone.length
      ? ` · gone in typically ${fmtDuration(median(gone))} · ${pct(gone.filter(t => t <= 5 * 60000).length, gone.length)}% within 5 min`
      : "") + (rows.length > gone.length ? ` · ${rows.length - gone.length} not booked` : ""));
  }
  if (released.length) {
    const bestBy = startTimes.map(t => {
      const g = released.filter(r => r.time === t && r.outcome === "taken").map(r => r.closed_ms - r.opened_ms);
      return g.length ? median(g) : null;
    });
    const fastest = startTimes.filter((_, i) => bestBy[i] !== null).sort((a, b) => bestBy[startTimes.indexOf(a)] - bestBy[startTimes.indexOf(b)])[0];
    if (fastest) lines.push(`• Hottest start time: ${fastest} (gone in ~${fmtDuration(bestBy[startTimes.indexOf(fastest)])})`);
    lines.push("   Slots booked within the first minute never show up here, so the real race is even faster.");
    if (startTimes.length >= 2) {
      charts.push(chartUrl({ type: "bar", data: { labels: startTimes, datasets: clubIds.map(c => ({
        label: CLUBS[c].name, backgroundColor: CLUB_COLORS[c] || "#888",
        data: startTimes.map(t => {
          const g = released.filter(r => r.club === c && r.time === t && r.outcome === "taken").map(r => r.closed_ms - r.opened_ms);
          return g.length ? Math.round(median(g) / 6000) / 10 : null;
        }) })) },
        options: { title: { display: true, text: "Release race: minutes until a new slot is gone, by start time" },
                   scales: { yAxes: [{ ticks: { beginAtZero: true }, scaleLabel: { display: true, labelString: "minutes (median)" } }] } } }));
    }
  }

  lines.push("", `🎯 Your window (${windowSummary(s)}): ${inWindow} cancellation${inWindow === 1 ? "" : "s"} · ` +
    `${(runRow && runRow.alerts) || 0} alert${(runRow && runRow.alerts) === 1 ? "" : "s"} sent`);
  if (runRow && runRow.n) {
    lines.push(`🩺 Watcher: ${runRow.n} checks, ${runRow.failed ? `${runRow.failed} failed` : "none failed"}`);
  }
  return { text: lines.join("\n"), charts };
}

async function sendReport(env, s, days = 7, chatId = null) {
  const r = await buildReport(env, s, days);
  if (!r) return "📊 Reports need the padel-history database (see /metrics).";
  chatId = chatId || env.TELEGRAM_CHAT_ID;
  await send(env, r.text, null, { chatId });
  const quiet = isQuietHours() ? { disable_notification: true } : {};
  if (r.charts.length === 1) {
    await telegram(env, "sendPhoto", { chat_id: chatId, photo: r.charts[0], ...quiet });
  } else if (r.charts.length) {
    await telegram(env, "sendMediaGroup", {
      chat_id: chatId,
      media: r.charts.slice(0, 10).map(url => ({ type: "photo", media: url })),
      ...quiet,
    });
  } else {
    await send(env, "Nothing logged in that period yet, so no charts this time.", null, { chatId });
  }
  return null;
}

async function weeklyReport(env, s) {
  if (!env.DB) return;
  const now = local(new Date());
  const wd = new Date(`${now.date}T12:00:00Z`).getUTCDay();
  if (wd !== REPORT_WEEKDAY || now.time < REPORT_AT) return;
  if ((await env.SEEN.get("report_sent")) === now.date) return;
  await env.SEEN.put("report_sent", now.date);
  await sendReport(env, s, 7);
}

function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

async function stats(env, daysBack = 7) {
  const db = env.DB;
  if (!db) return "The cancellation monitor isn't connected yet: add a D1 database binding named DB to the Worker.";
  await ensureSchema(db);
  const nowMs = Date.now();
  const since = nowMs - daysBack * 86400000;

  const firstRow = await db.prepare("SELECT MIN(opened_ms) AS t FROM episodes").first();
  if (!firstRow || firstRow.t === null) return "No data yet. The monitor starts logging on the next check (within a minute).";
  const { results } = await db.prepare(`SELECT club, day, time, court, start_ms, opened_ms, closed_ms, kind, outcome
    FROM episodes WHERE kind != 'initial' AND opened_ms >= ? ORDER BY opened_ms`).bind(since).all();

  // One cancellation often frees several 90-min start times on the same court
  // at once; group those into a single event.
  const events = new Map();
  for (const r of results) {
    const k = `${r.club}|${r.day}|${r.court}|${r.opened_ms}|${r.kind}`;
    if (!events.has(k)) events.set(k, { ...r, times: [], rows: [] });
    const e = events.get(k);
    e.times.push(r.time);
    e.rows.push(r);
    e.start_ms = Math.min(e.start_ms, r.start_ms);
  }
  for (const e of events.values()) {
    const stillOpen = e.rows.some(r => r.closed_ms === null);
    const taken = e.rows.filter(r => r.outcome === "taken");
    e.state = stillOpen ? "free" : taken.length ? "taken" : "unbooked";
    e.takenAfter = e.state === "taken" ? Math.min(...taken.map(r => r.closed_ms)) - e.opened_ms : null;
  }

  const all = [...events.values()];
  const reopen = all.filter(e => e.kind === "reopened");
  const released = results.filter(r => r.kind === "release");     // one row per court + start time
  const since0 = local(new Date(Math.max(firstRow.t, since)));

  const lines = [
    `📊 Evenings ${MONITOR.from}-${MONITOR.to}, ${MONITOR.durations.join("/")} min, Mon-Fri, doubles courts`,
    `Period: since ${since0.label} ${since0.time} (last ${daysBack} days at most)`,
    "",
  ];

  // How fast freshly released slots disappear (the 7/21-days-ahead race).
  lines.push("🆕 Newly released slots:");
  for (const [clubId, club] of Object.entries(CLUBS)) {
    const rows = released.filter(r => r.club === clubId);
    if (!rows.length) { lines.push(`${club.name}: none seen yet`); continue; }
    const taken = rows.filter(r => r.outcome === "taken").map(r => r.closed_ms - r.opened_ms);
    const free = rows.filter(r => r.closed_ms === null).length;
    const q = (lim) => taken.filter(t => t <= lim).length;
    lines.push(`${club.name}: ${rows.length} released, ${taken.length} booked` +
      (taken.length ? `, typically within ${fmtDuration(median(taken))}` : ""));
    if (taken.length) lines.push(`  gone within 1 min: ${q(60000)} · 5 min: ${q(5 * 60000)} · 1 h: ${q(3600000)}`);
    if (free) lines.push(`  still free: ${free}`);
  }
  lines.push("", "🔁 Cancellations (slots that reopened later):");

  for (const [clubId, club] of Object.entries(CLUBS)) {
    const ev = reopen.filter(e => e.club === clubId);
    const taken = ev.filter(e => e.state === "taken").map(e => e.takenAfter);
    const notice = ev.map(e => e.start_ms - e.opened_ms);
    lines.push(`${club.name}: ${ev.length} slot${ev.length === 1 ? "" : "s"} reopened`);
    if (ev.length) {
      if (taken.length) {
        const q = (lim) => taken.filter(t => t <= lim).length;
        lines.push(`  booked again: ${taken.length}, typically after ${fmtDuration(median(taken))}`);
        lines.push(`  within 5 min: ${q(5 * 60000)} · within 1 h: ${q(3600000)} · fastest ${fmtDuration(Math.min(...taken))}`);
      }
      const free = ev.filter(e => e.state === "free").length;
      const unbooked = ev.filter(e => e.state === "unbooked").length;
      if (free) lines.push(`  still free right now: ${free}`);
      if (unbooked) lines.push(`  never re-booked: ${unbooked}`);
      lines.push(`  reopened typically ${fmtDuration(median(notice))} before start`);
    }
    lines.push("");
  }

  const recent = reopen.slice(-8).reverse();
  if (recent.length) {
    lines.push("Latest:");
    for (const e of recent) {
      const o = local(new Date(e.opened_ms));
      const slotDay = local(new Date(e.start_ms)).label;
      const what = e.state === "taken" ? `taken after ${fmtDuration(e.takenAfter)}`
                 : e.state === "free" ? "still free" : "nobody booked it";
      lines.push(`• ${slotDay} ${e.times.sort()[0]} ${e.court} (${CLUBS[e.club].name}): opened ${o.label} ${o.time}, ${what}`);
    }
    lines.push("");
  }
  lines.push("Note: times are accurate to the check interval (1 min by day, 2 min at night).");
  return lines.join("\n");
}

// ---------- Telegram commands ----------
function describe(s, owner = true) {
  const days = s.weekdays.slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
    .map(d => DAY_NAMES[d][0].toUpperCase() + DAY_NAMES[d].slice(1)).join(", ");
  return `Clubs: ${Object.values(CLUBS).map(c => `${c.name} (books ${c.window} days ahead)`).join(", ")}\n` +
         `Days: ${days}\n` +
         `Start time: ${windowSummary(s)}\n` +
         `Length: ${s.durations.join(" or ")} min\n` +
         `Notifications: ${s.paused ? "PAUSED ⏸" : "on ▶️"}\n` +
         (!owner ? "" : `Release heads-up: ${s.remind
           ? `on for ${Object.values(CLUBS).filter(c => c.remind).map(c => c.name).join(", ")}, ${REMIND_MIN_BEFORE} min before the window starts`
           : "off"}\n`) +
         `Quiet hours: ${QUIET_FROM}-${QUIET_TO} (messages arrive without sound)`;
}

function parseDays(text) {
  const out = new Set();
  for (const part of text.toLowerCase().split(/[\s,]+/).filter(Boolean)) {
    if (part === "weekdays") { [1, 2, 3, 4, 5].forEach(d => out.add(d)); continue; }
    if (part === "weekend") { [6, 0].forEach(d => out.add(d)); continue; }
    if (part === "all" || part === "every") { [0, 1, 2, 3, 4, 5, 6].forEach(d => out.add(d)); continue; }
    const [a, b] = part.split("-").map(x => DAY_NAMES.indexOf(x.slice(0, 3)));
    if (a < 0 || (b !== undefined && b < 0)) return null;
    if (b === undefined) { out.add(a); continue; }
    for (let d = a; ; d = (d + 1) % 7) { out.add(d); if (d === b) break; }
  }
  return out.size ? [...out] : null;
}

const HELP =
  "Commands:\n" +
  "/slots - free slots matching your settings right now\n" +
  "/bookings - your upcoming bookings (read from your Playtomic account)\n" +
  "/report - charts: when cancellations happen and how fast they go (/report 30 for 30 days)\n" +
  "/metrics - is the watcher running? checks done in the last hour and 24 h\n" +
  "/stats - how fast released and cancelled slots get taken (/stats 30 for 30 days)\n" +
  "/status - settings and watcher health\n" +
  "/window 17:30 19:00 - start-time window (or /window tue,thu 17:00 20:30 for some days)\n" +
  "/days mon-fri - days (also: mon,wed,fri · weekend · all)\n" +
  "/length 90 - slot length (or several: /length 60 90)\n" +
  "/remind on|off - heads-up before new evening slots are released\n" +
  "/pause - stop notifications\n" +
  "/resume - start them again\n" +
  "/users - who else uses the bot (/approve ID · /remove ID)";

const GUEST_HELP =
  "Commands:\n" +
  "/slots - free slots matching your settings right now\n" +
  "/status - your settings\n" +
  "/window 17:30 19:00 - start-time window (or /window tue,thu 17:00 20:30 for some days)\n" +
  "/days mon-fri - days (also: mon,wed,fri · weekend · all)\n" +
  "/length 90 - slot length (or several: /length 60 90)\n" +
  "/report - charts: when cancellations happen and how fast they go\n" +
  "/pause - stop notifications\n" +
  "/resume - start them again\n\n" +
  "You get a message when a slot that fits your settings frees up. Slots for today are skipped.";
const GUEST_COMMANDS = new Set(["/start", "/help", "/status", "/slots", "/window", "/days", "/length",
  "/report", "/stats", "/pause", "/resume"]);

async function handleCommand(env, text, chatId = env.TELEGRAM_CHAT_ID) {
  const [rawCmd, ...args] = text.trim().split(/\s+/);
  const cmd = rawCmd.toLowerCase().replace(/@.*$/, "");
  const owner = isOwner(env, chatId);
  const s = await userSettings(env, chatId);
  const save = async (changes, msg) => {
    const next = { ...s, ...changes };
    await saveUserSettings(env, chatId, next);
    return `${msg}\n\n${describe(next, owner)}`;
  };
  if (!owner && !GUEST_COMMANDS.has(cmd)) return `That one isn't available.\n\n${GUEST_HELP}`;

  switch (cmd) {
    case "/start":
    case "/help":
      return `${owner ? HELP : GUEST_HELP}\n\nCurrent settings:\n${describe(s, owner)}`;

    case "/users": {
      const users = await getUsers(env);
      const rows = Object.entries(users);
      if (!rows.length) return "Nobody else uses the bot yet. Someone can send /start to your bot to ask for access.";
      return rows.map(([id, u]) => `${u.status === "approved" ? "✅" : u.status === "pending" ? "⏳" : "🚫"} ${userLabel(u)} · ID ${id}`).join("\n") +
        "\n\n/approve ID · /remove ID";
    }

    case "/approve":
    case "/deny":
    case "/remove": {
      const id = (args[0] || "").trim();
      const users = await getUsers(env);
      if (!users[id]) return "Use it like: /approve 123456789 (the ID from the request or /users)";
      if (cmd === "/approve") {
        users[id].status = "approved";
        await putJSON(env, "users", users);
        try {
          await send(env, `✅ You're in! You'll get a message when a padel slot frees up.\n\n${GUEST_HELP}\n\nYour settings:\n${describe(await userSettings(env, id), false)}`,
            null, { chatId: id });
        } catch (e) { return `Approved ${userLabel(users[id])}, but I couldn't message them (${e.message}).`; }
        return `✅ Approved ${userLabel(users[id])}. They got a welcome message and can set their own times.`;
      }
      if (cmd === "/deny") {
        users[id].status = "denied";                 // stays on the list so they can't ask again
        await putJSON(env, "users", users);
        return `🚫 Denied ${userLabel(users[id])}. They won't be able to ask again.`;
      }
      const label = userLabel(users[id]);
      users[id].status = "denied";
      await putJSON(env, "users", users);
      await env.SEEN.delete(`settings:${id}`);
      await env.SEEN.delete(`seen:${id}`);
      await env.SEEN.delete(`alerted:${id}`);
      try { await send(env, "Your access to this padel bot was removed.", null, { chatId: id }); } catch (e) {}
      return `Removed ${label}. They no longer get alerts.`;
    }

    case "/status": {
      if (!owner) return `Your settings:\n${describe(s, false)}`;
      const health = await getJSON(env, "health", { failing: false });
      const h = health.failing
        ? `⚠️ Failing since ${local(new Date(health.since)).time}: ${health.last}`
        : "✅ Working";
      const mon = env.DB ? "on" : "not connected (no DB binding)";
      let acct = "not connected (no PLAYTOMIC_TOKEN secret)";
      if (hasAccount(env)) {
        const b = await getJSON(env, "bookings", null);
        acct = !b ? "connected, not read yet"
          : b.error ? `⚠️ ${b.error}`
          : `connected, ${b.list.filter(x => x.startMs > Date.now()).length} upcoming booking(s) (see /bookings)`;
      }
      return `${describe(s)}\nHealth: ${h}\nCancellation monitor: ${mon}\nPlaytomic account: ${acct}`;
    }

    case "/paytest":
      return payTest(env, (args[0] || "hr").toLowerCase());

    case "/bookings": {
      if ((args[0] || "").toLowerCase() === "raw") return debugBookings(env);
      const { list, error } = await getBookings(env, Date.now(), { force: true });
      if (list === null && !error) {
        return "Your Playtomic account isn't connected yet: add the secret PLAYTOMIC_TOKEN to the Worker.";
      }
      const lines = (list || []).map(bookingLine);
      return (error ? `⚠️ ${error}\n${list && list.length ? "Last known:\n" : ""}` : "") +
        (lines.length ? `Your upcoming bookings:\n\n${lines.join("\n")}` : error ? "" : "No upcoming padel bookings.") +
        `\n\nOn those days you only get alerts for nicer clubs (${Object.values(CLUBS)
          .sort((a, b) => b.rank - a.rank).map(c => c.name).join(" > ")}), and a reminder the day before from ${BOOKING_REMINDER_AT}.`;
    }

    case "/report": {
      const n = Number(args[0]);
      const msg = await sendReport(env, s, Number.isInteger(n) && n > 0 && n <= 60 ? n : 7, chatId);
      return msg || { silent: true };
    }

    case "/metrics":
    case "/uptime":
    case "/health":
      return metrics(env);

    case "/stats": {
      const n = Number(args[0]);
      return stats(env, Number.isInteger(n) && n > 0 && n <= 120 ? n : 7);
    }

    case "/remind": {
      const v = (args[0] || "").toLowerCase();
      if (v !== "on" && v !== "off") {
        const plan = releasePlan(s).map(p => `${p.club.name}: ${p.label}`).join("\n") || "nothing on your days";
        return `Use /remind on or /remind off.\n\nToday's releases in your window:\n${plan}`;
      }
      return save({ remind: v === "on" }, v === "on" ? "⏰ Release heads-up is on." : "Release heads-up is off.");
    }

    case "/slots": {
      const nowMs = Date.now();
      const lines = [];
      const buttons = [];
      for (const club of Object.values(CLUBS)) {
        try {
          const watch = (await scanClub(club, s, nowMs)).slots.filter(x => x.inWatch && fits(s, x));
          lines.push(`${club.name}:\n${watch.length ? watch.map(x => x.line).join("\n") : "nothing free"}`);
          buttons.push(...dateButtons(club, watch));
        } catch (e) {
          lines.push(`${club.name}: couldn't check (${e.message})`);
        }
      }
      return {
        text: `Free slots (${windowSummary(s)}, ${s.durations.join("/")} min):\n\n` + lines.join("\n\n"),
        buttons,
      };
    }

    case "/window": {
      const times = args.slice(-2);
      const ok = (args.length === 2 || args.length === 3) &&
        times.every(a => /^([01]\d|2[0-3]):[0-5]\d$/.test(a)) && times[0] <= times[1];
      const usage = "Use it like: /window 17:30 19:00 (every day) or /window tue,thu 17:00 20:30 (just those days). 24h start times, earliest first.";
      if (!ok) return usage;
      if (args.length === 2) return save({ earliest: times[0], latest: times[1], dayWindows: {} }, "✅ Window updated for all days.");
      const days = parseDays(args[0]);
      if (!days) return usage;
      const dayWindows = { ...(s.dayWindows || {}) };
      for (const d of days) dayWindows[d] = times;
      return save({ dayWindows }, "✅ Window updated for those days.");
    }

    case "/days": {
      const days = parseDays(args.join(" "));
      if (!days) return "Use it like: /days mon-fri  ·  /days mon,wed,fri  ·  /days weekend  ·  /days all";
      return save({ weekdays: days }, "✅ Days updated.");
    }

    case "/length": {
      const lens = args.map(Number);
      if (!lens.length || !lens.every(n => [60, 90, 120].includes(n)))
        return "Use it like: /length 90  (options: 60, 90, 120; several allowed)";
      return save({ durations: [...new Set(lens)] }, "✅ Length updated.");
    }

    case "/pause":
      return save({ paused: true }, owner ? "⏸ Paused. No notifications until you send /resume. (The cancellation monitor keeps logging.)"
        : "⏸ Paused. No notifications until you send /resume.");

    case "/resume":
      return save({ paused: false }, "▶️ Notifications are back on.");

    default:
      return `I don't know that one.\n\n${owner ? HELP : GUEST_HELP}`;
  }
}

async function handleTelegram(request, env, ctx) {
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== await webhookSecret(env)) {
    return new Response("forbidden", { status: 403 });
  }
  const update = await request.json();
  const msg = update.message;
  // Private chats only (no groups), and only text.
  if (!msg || !msg.text || !msg.chat || msg.chat.type !== "private") return new Response("ok");
  const chatId = String(msg.chat.id);
  // Answer Telegram right away and do the work afterwards, so slow
  // commands never time out or get delivered twice.
  ctx.waitUntil((async () => {
    let reply;
    try {
      reply = await routeMessage(env, chatId, msg);
    } catch (e) {
      reply = `Something went wrong: ${e.message}`;
    }
    try {
      if (typeof reply === "string") await send(env, reply, null, { chatId });
      else if (reply && !reply.silent) await send(env, reply.text, reply.buttons, { chatId });
    } catch (e) {
      console.log("Could not send reply:", e.message);
    }
  })());
  return new Response("ok");
}

// You and approved people get the bot; anyone else can only ask for access.
async function routeMessage(env, chatId, msg) {
  const isCmd = (c) => msg.text.trim().toLowerCase().replace(/@\S*/, "").startsWith(c);
  if (isOwner(env, chatId)) {
    await telegram(env, "sendChatAction", { chat_id: chatId, action: "typing" });
    return handleCommand(env, msg.text, chatId);
  }
  const users = await getUsers(env);
  const u = users[chatId];
  if (u && u.status === "approved") {
    await telegram(env, "sendChatAction", { chat_id: chatId, action: "typing" });
    return handleCommand(env, msg.text, chatId);
  }
  if (u && u.status === "denied") return null;                       // ignored
  if (u && u.status === "pending") return "⏳ Your request is waiting for approval.";
  if (!isCmd("/start")) return "Hi! This is a private padel bot. Send /start to ask for access.";
  if (Object.values(users).filter(x => x.status === "pending").length >= MAX_PENDING) {
    return "Sorry, no new requests can be taken right now.";
  }
  const from = msg.from || {};
  users[chatId] = {
    name: [from.first_name, from.last_name].filter(Boolean).join(" ").slice(0, 60) || "Someone",
    username: from.username || "", status: "pending", since: Date.now(),
  };
  await putJSON(env, "users", users);
  await send(env, `👤 ${userLabel(users[chatId])} wants to use your padel bot.\n\n` +
    `Approve: /approve ${chatId}\nDeny: /deny ${chatId}\n\n` +
    "Approved people get their own days, times and pause in their own chat. They can't see your bookings, " +
    "settings or the code, and can't change anything of yours.");
  return "👋 Request sent. You'll get a message here once it's approved.";
}

// ---------- entry points ----------
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(check(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/telegram") {
        return await handleTelegram(request, env, ctx);
      }
      const p = url.searchParams;
      const text = body => new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      if (p.has("setup")) return text(await setup(env, url.origin));
      if (p.has("webhook")) return text(await webhookStatus(env, url.origin));
      if (p.has("stats")) {
        const n = Number(p.get("days"));
        return text(await stats(env, Number.isInteger(n) && n > 0 && n <= 120 ? n : 7));
      }
      if (p.has("day")) {
        const club = CLUBS[p.get("club")] || CLUBS.embassy;
        const day = /^\d{4}-\d{2}-\d{2}$/.test(p.get("day")) ? p.get("day") : local(new Date()).date;
        return text(await wholeDay(club, day));
      }
      if (p.has("test")) {
        const today = local(new Date()).date;
        await send(env, "🎾 Padel watcher connected\n\nTest notification from Cloudflare",
          Object.values(CLUBS).map(c => ({ text: `📱 Open ${c.name} in the app`, url: appLink(c) })));
        return text("Telegram accepted it. Check your phone.");
      }
      const result = await check(env, { force: true });
      return new Response(JSON.stringify(result, null, 2), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    } catch (e) {
      return new Response(`Error: ${e.message}`, { status: 500 });
    }
  },
};
