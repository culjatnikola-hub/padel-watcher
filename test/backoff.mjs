// Scenario: Playtomic starts refusing the bot, keeps refusing for ~2.5 hours,
// then answers again. Prints, per minute, how many requests reached Playtomic
// and any Telegram messages, so the backoff pattern is visible.
import w from "../src/worker.js";
import { makeD1 } from "./d1mock.mjs";

const RD = Date;
let now = RD.parse("2026-11-17T11:20:58Z");            // 12:20:58 Zagreb
globalThis.Date = class extends RD { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } };
Math.random = () => 0.5;                                // no jitter, so the pattern is exact

const BLOCK_FROM = RD.parse("2026-11-17T11:23:00Z");
const BLOCK_TO = BLOCK_FROM + 60000 * Number(process.env.BLOCK_MIN || 147);
const STATUS = Number(process.env.STATUS || 403);
let requests = 0;
const sent = [];
globalThis.fetch = async (url, opt = {}) => {
  if (url.includes("api.telegram.org")) {
    const b = JSON.parse(opt.body);
    if (url.endsWith("sendMessage")) sent.push(b.text.split("\n")[0]);
    return new Response('{"ok":true,"result":true}');
  }
  requests++;
  if (now >= BLOCK_FROM && now < BLOCK_TO) return new Response("Request blocked", { status: STATUS, headers: STATUS === 429 ? { "Retry-After": "600" } : {} });
  return new Response("[]");
};

const store = { settings: JSON.stringify({ remind: false }), report_sent: "2026-11-17" };
const env = {
  TELEGRAM_TOKEN: "tok", TELEGRAM_CHAT_ID: "111", DB: makeD1(),
  SEEN: { get: async k => store[k] ?? null, put: async (k, v) => { store[k] = v; }, delete: async k => { delete store[k]; } },
};
let kvWrites = 0;
const put = env.SEEN.put; env.SEEN.put = async (k, v) => { kvWrites++; return put(k, v); };

const lines = [];
let total = 0, blockedReq = 0;
for (let i = 0; i < Number(process.env.MINUTES || 200); i++) {
  requests = 0;
  let p; await w.scheduled({}, env, { waitUntil: x => { p = x; } }); await p;
  total += requests;
  if (now >= BLOCK_FROM && now < BLOCK_TO) blockedReq += requests;
  const t = new RD(now + 3600000).toISOString().slice(11, 16);
  const msgs = sent.splice(0);
  if ((requests !== 22 && requests !== 0) || msgs.length) lines.push(`${t}  requests ${String(requests).padStart(2)}  ${msgs.map(m => "📨 " + m).join("  ")}`);
  now += 60000;
}
console.log(lines.join("\n"));
const blockedMin = (BLOCK_TO - BLOCK_FROM) / 60000;
console.log(`\nWhile blocked (${blockedMin} min): ${blockedReq} requests (before this change: ~${blockedMin * 44}).`);
console.log(`Minutes not shown made 0 requests while paused, or the normal 22 otherwise. KV writes in ${Number(process.env.MINUTES || 200)} min: ${kvWrites}.`);
