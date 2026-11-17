import w from "../src/worker.js"; import { makeD1 } from "./d1mock.mjs";
const RD = Date; let now = RD.parse("2026-11-09T08:55:00Z");   // Mon 09:55 local
globalThis.Date = class extends RD { constructor(...a){ super(...(a.length?a:[now])); } static now(){ return now; } };
const sent = []; const P6 = "15bff5cd-9af4-47a2-8bc4-9670a1ba4d7b";
// UTC start times (local = UTC+1)
const free = { "2026-11-09": ["17:00:00"], "2026-11-10": ["19:30:00", "16:00:00", "19:45:00"], "2026-11-11": ["18:30:00", "16:00:00"], "2026-11-16": ["19:00:00"] };
globalThis.fetch = async (url, opt = {}) => { if (url.includes("api.telegram.org")) { const b = JSON.parse(opt.body); if (url.endsWith("sendMessage")) sent.push(b.text); return new Response('{"ok":true,"result":true}'); }
  const d = url.match(/date=([\d-]+)/)?.[1]; if (!url.includes("57b9c4ce")) return new Response("[]");
  return new Response(JSON.stringify((free[d] || []).map(t => ({ resource_id: P6, start_date: d, slots: [{ start_time: t, duration: 90, price: "44 EUR" }] })))); };
const store = { settings: JSON.stringify({ remind: false, earliest: "17:30", latest: "19:00" }) };
const env = { TELEGRAM_TOKEN: "tok", TELEGRAM_CHAT_ID: "42", DB: makeD1(), SEEN: { get: async k => store[k] ?? null, put: async (k, v) => { store[k] = v; }, delete: async k => { delete store[k]; } } };
let p; await w.scheduled({}, env, { waitUntil: x => p = x }); await p;
console.log("== ALERT ==\n" + sent.splice(0).join("\n---\n"));
console.log("expect: Tue 10.11 20:30 + 17:00, Wed 11.11 17:00, NOT today 18:00, NOT Tue 20:45, NOT Wed 19:30, NOT Mon 16.11 20:00");
const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("padel-watcher:tok")); const secret = [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
const cmd = async t => { const pend = []; await w.fetch(new Request("https://x.dev/telegram", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": secret }, body: JSON.stringify({ message: { text: t, chat: { id: 42 } } }) }), env, { waitUntil: x => pend.push(x) }); await Promise.all(pend); return sent.splice(0).join("\n---\n"); };
console.log("\n== /status ==\n" + await cmd("/status"));
console.log("\n== /window fri 18:00 18:00 ==\n" + await cmd("/window fri 18:00 18:00"));
console.log("\n== /window bad ==\n" + await cmd("/window xyz 18:00 17:00"));
