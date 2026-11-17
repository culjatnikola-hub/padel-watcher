import { DatabaseSync } from "node:sqlite";
export function makeD1() {
  const db = new DatabaseSync(":memory:");
  class Stmt {
    constructor(sql, args = []) { this.sql = sql; this.args = args; }
    bind(...a) { return new Stmt(this.sql, a); }
    exec() { const st = db.prepare(this.sql);
      if (/^\s*(SELECT)/i.test(this.sql)) return { results: st.all(...this.args) };
      st.run(...this.args); return { results: [] }; }
    async all() { return this.exec(); }
    async run() { return this.exec(); }
    async first() { return this.exec().results[0] ?? null; }
  }
  return { prepare: sql => new Stmt(sql), batch: async stmts => { db.exec("BEGIN"); try { const r = stmts.map(s => s.exec()); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } } };
}
