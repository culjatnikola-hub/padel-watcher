import w from "../src/worker.js"; import { makeD1 } from "./d1mock.mjs";
const RD = Date; let now = RD.parse("2026-11-11T15:47:00Z");
globalThis.Date = class extends RD { constructor(...a){ super(...(a.length?a:[now])); } static now(){ return now; } };
const sent = []; const P5 = "d4d4f0af-6464-4b71-a9b5-1dbf64c0be8a"; let free = {};
globalThis.fetch = async (url, opt = {}) => { if (url.includes("api.telegram.org")) { const b = JSON.parse(opt.body); if (url.endsWith("sendMessage")) sent.push(b.text.split("\n")[2]); return new Response('{"ok":true,"result":true}'); }
  const d = url.match(/date=([\d-]+)/)?.[1]; if (!url.includes("57b9c4ce")) return new Response("[]");
  return new Response(JSON.stringify((free[d] || []).map(t => ({ resource_id: P5, start_date: d, slots: [{ start_time: t, duration: 90, price: "44 EUR" }] })))); };
const store = { settings: JSON.stringify({ remind: false }), report_sent: "2026-11-09" };
const env = { TELEGRAM_TOKEN: "tok", TELEGRAM_CHAT_ID: "111", DB: makeD1(), SEEN: { get: async k => store[k] ?? null, put: async (k, v) => { store[k] = v; }, delete: async k => { delete store[k]; } } };
const run = async (utc, f) => { now = RD.parse(`2026-11-${utc}Z`); free = f; let p; await w.scheduled({}, env, { waitUntil: x => p = x }); await p; console.log(utc, "→", sent.splice(0).join(" | ") || "-"); };
const thu = { "2026-11-12": ["17:00:00"] }, none = {};   // Thu 12.11 18:00 local (inside Tue/Thu window)
await run("11T15:47:00", thu); await run("11T15:57:00", none); await run("11T15:58:00", thu); await run("11T16:01:00", none);
await run("11T16:06:00", thu); await run("11T16:33:00", none);
await run("11T20:00:00", thu);   // freed again 4 h later -> real cancellation, alert
