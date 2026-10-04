// In-memory stand-in for the parts of supabase-js the server uses, so the
// tests run without a database. Filters, ordering, counts and writes behave
// like PostgREST for the queries in this repo; nothing else is implemented.
/* eslint-disable @typescript-eslint/no-explicit-any -- rows are untyped, like PostgREST JSON */
type Row = Record<string, any>;
export const db: Record<string, Row[]> = {};
export const writes: { table: string; op: string; row?: Row; filters?: unknown }[] = [];

class Query implements PromiseLike<any> {
  private filters: ((r: Row) => boolean)[] = [];
  private op: "select" | "insert" | "update" | "delete" = "select";
  private payload: Row | null = null;
  private countMode = false;
  private head = false;
  private single = false;
  private orderBy: { col: string; asc: boolean }[] = [];
  private lim: number | null = null;
  constructor(private table: string) {}
  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.op === "select") { this.countMode = !!opts?.count; this.head = !!opts?.head; }
    return this;
  }
  insert(row: Row) { this.op = "insert"; this.payload = row; return this; }
  update(row: Row) { this.op = "update"; this.payload = row; return this; }
  delete() { this.op = "delete"; return this; }
  eq(col: string, val: unknown) { this.filters.push((r) => r[col] === val); return this; }
  in(col: string, vals: unknown[]) { const s = new Set(vals); this.filters.push((r) => s.has(r[col])); return this; }
  gte(col: string, val: string) { this.filters.push((r) => r[col] >= val); return this; }
  lt(col: string, val: string) { this.filters.push((r) => r[col] < val); return this; }
  order(col: string, opts?: { ascending?: boolean }) { this.orderBy.push({ col, asc: opts?.ascending ?? true }); return this; }
  limit(n: number) { this.lim = n; return this; }
  maybeSingle() { this.single = true; return this; }
  private run() {
    const rows = db[this.table] ?? (db[this.table] = []);
    if (this.op === "insert") {
      const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...this.payload };
      rows.push(row); writes.push({ table: this.table, op: "insert", row: this.payload! });
      return { data: null, error: null };
    }
    let out = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "delete") {
      const keep = rows.filter((r) => !this.filters.every((f) => f(r)));
      writes.push({ table: this.table, op: "delete" });
      db[this.table] = keep;
      return { data: null, error: null };
    }
    if (this.op === "update") {
      for (const r of out) Object.assign(r, this.payload);
      writes.push({ table: this.table, op: "update", row: this.payload! });
      return { data: null, error: null };
    }
    for (const { col, asc } of [...this.orderBy].reverse()) {
      out = [...out].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
    }
    if (this.lim !== null) out = out.slice(0, this.lim);
    out = structuredClone(out);
    if (this.countMode) return { data: this.head ? null : out, count: out.length, error: null };
    if (this.single) return { data: out[0] ?? null, error: null };
    return { data: out, error: null };
  }
  then<T1 = any, T2 = never>(ok?: ((v: any) => T1 | PromiseLike<T1>) | null, bad?: ((e: any) => T2 | PromiseLike<T2>) | null) {
    return Promise.resolve().then(() => this.run()).then(ok, bad);
  }
}

export class SupabaseClient { from(table: string) { return new Query(table); } }
export const createClient = (_url: string, _key: string) => new SupabaseClient();
