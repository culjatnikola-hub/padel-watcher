import w from "../src/worker.js"; import { makeD1 } from "./d1mock.mjs";
const RD = Date; let now;
globalThis.Date = class extends RD { constructor(...a){ super(...(a.length?a:[now])); } static now(){ return now; } };
const sent = []; let free = {};
globalThis.fetch = async (url, opt = {}) => { if (url.includes("api.telegram.org")) { const b = JSON.parse(opt.body); if (url.endsWith("sendMessage")) sent.push(b.text); return new Response('{"ok":true,"result":true}'); }
  const d = url.match(/date=([\d-]+)/)?.[1]; const k = (url.includes("57b9c4ce") ? "hr|" : "emb|") + d;
  return new Response(JSON.stringify(free[k] ? [{ resource_id: "15bff5cd-9af4-47a2-8bc4-9670a1ba4d7b", start_date: d, slots: [{ start_time: free[k], duration: 90, price: "44 EUR" }] }] : [])); };
const store = {}; const env = { TELEGRAM_TOKEN: "tok", TELEGRAM_CHAT_ID: "42", DB: makeD1(), SEEN: { get: async k => store[k] ?? null, put: async (k, v) => { store[k] = v; }, delete: async k => { delete store[k]; } } };
store.settings = JSON.stringify({ remind: false });
const run = async () => { let p; await w.scheduled({}, env, { waitUntil: x => p = x }); await p; const o = sent.splice(0); return o.length ? o.join("\n---\n") : "(no alert)"; };
now = RD.parse("2026-11-06T17:31:00Z"); free = { "hr|2026-11-27": "17:30:00", "hr|2026-11-10": "17:00:00" };
console.log("FRI 18:31 (Fri 27.11 release + Tue 10.11 cancellation):\n" + await run());
now = RD.parse("2026-11-05T17:31:00Z"); free = { "hr|2026-11-26": "17:30:00" }; delete store.seen;
console.log("\nTHU 18:31 (Thu 26.11 release):\n" + await run());
now += 40 * 60000; console.log("\n40 min later, still free:\n" + await run());
